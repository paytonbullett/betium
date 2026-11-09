#!/usr/bin/env python3
"""
Betium full node.

Every node checks the same genesis, downloads blocks, and keeps the chain
with the most proof-of-work. Balances are computed locally in integer units.
"""

import sys


def print_help():
    print("""Betium Node – usage:
  python3 node.py [-h|--help]
  python3 node.py <my_public_url> [bootstrap_peer_url]

  my_public_url     Externally reachable URL of this node (http://1.2.3.4:5000)
  bootstrap_peer    Optional existing peer. There is no central tracker.

The node validates every block itself. A private database with a different
genesis is rejected. Delete betium_chain.db if an older protocol file is present.

API:
  GET  /chain/status
  GET  /headers?from=<index>
  GET  /block/<index>
  GET  /balance/<address>
  GET  /balance/<address>/<token_id>
  GET  /supply
  GET  /tokens
  GET  /token/<token_id>
  GET  /fees
  GET  /peers
  POST /peers/register
  POST /transaction/new
  GET  /mine/template?miner=<addr>
  POST /block/submit

MetaMask / Ethereum wallets:
  POST /rpc         Ethereum JSON-RPC (also accepted at POST /)
  GET  /network     MetaMask network settings as JSON

  Native BETM: plain value transfers.
  Custom tokens: exposed as ERC-20 contracts. Use GET /token/<id> to obtain
  the contract address, then add the token in MetaMask (decimals 18).
  MetaMask can then call balanceOf / transfer on that contract address.
""")
    sys.exit(0)


if any(a in ("-h", "--help") for a in sys.argv[1:]):
    print_help()

import hashlib
import json
import os
import sqlite3
import logging
import threading
import time
from urllib.parse import urlparse

import requests
from ecdsa import VerifyingKey, SECP256k1
from flask import Flask, jsonify, request

import ethcompat
from consensus import (
    BLOCK_REWARD,
    BLOCK_TIME_TARGET,
    ETH_CHAIN_ID,
    GENESIS,
    GENESIS_HASH,
    HALVING_INTERVAL,
    INITIAL_DIFFICULTY,
    MAX_DIFFICULTY,
    MAX_EMISSION_PER_HOUR,
    MAX_SUPPLY,
    MIN_BALANCE_TO_CREATE,
    MIN_DIFFICULTY,
    NATIVE_TOKEN,
    PROTOCOL_VERSION,
    RETARGET_WINDOW,
    TOKEN_CREATE_FEE,
    TOKEN_CREATE_FEE_CAP,
    ETH_GAS_PRICE_WEI,
    TRANSFER_FEE,
    UNITS,
    WEI_PER_UNIT,
    block_hash,
    canonical_tx,
    dumps,
    merkle_root,
    parse_units,
    units_to_str,
    work_of,
    difficulty_bits,
    meets_target,
    DIFFICULTY_FORK_HEIGHT,
    MAX_DIFFICULTY_BITS,
    MIN_DIFFICULTY_BITS,
    RETARGET_MAX_STEP_BITS,
)

log = logging.getLogger("werkzeug")
log.setLevel(logging.ERROR)
app = Flask(__name__)

MAX_MEMPOOL_SIZE = 5000
MAX_PEERS = 2000
PEER_CACHE_FILE = "peers.json"
DB_FILE = "betium_chain.db"
MAX_ORPHANS = 50


class Blockchain:
    def __init__(self):
        self.pending_transactions = []
        self.orphans = {}
        self.peers = self.load_peers()
        self.my_node_url = None
        self._peer_lock = threading.Lock()
        self._chain_lock = threading.RLock()
        self.db_file = DB_FILE
        self.init_db()

    def connect(self):
        conn = sqlite3.connect(self.db_file, timeout=30.0)
        conn.execute("PRAGMA journal_mode=WAL;")
        return conn

    def load_peers(self):
        if os.path.exists(PEER_CACHE_FILE):
            try:
                with open(PEER_CACHE_FILE, "r") as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        return set(data)
            except Exception:
                pass
        return set()

    def save_peers(self):
        try:
            tmp = PEER_CACHE_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(sorted(self.peers), f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, PEER_CACHE_FILE)
        except Exception:
            pass

    def init_db(self):
        conn = self.connect()
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS blocks (
                idx INTEGER PRIMARY KEY,
                timestamp INTEGER,
                transactions TEXT,
                previous_hash TEXT,
                nonce INTEGER,
                difficulty INTEGER,
                protocol_version INTEGER,
                merkle_root TEXT,
                hash TEXT UNIQUE
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                address TEXT PRIMARY KEY,
                balance INTEGER,
                nonce INTEGER
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tokens (
                token_id TEXT PRIMARY KEY,
                name TEXT,
                symbol TEXT,
                creator TEXT,
                total_supply INTEGER,
                created_at INTEGER
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS token_balances (
                address TEXT NOT NULL,
                token_id TEXT NOT NULL,
                balance INTEGER NOT NULL,
                PRIMARY KEY (address, token_id)
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS eth_txs (
                hash TEXT PRIMARY KEY,
                block_idx INTEGER NOT NULL,
                tx_idx INTEGER NOT NULL
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS eth_txs_block ON eth_txs (block_idx)")
        # Links a native 64-char Betium address with its 0x MetaMask counterpart
        # derived from the same public key so balances stay synchronized.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS address_map (
                native TEXT PRIMARY KEY,
                eth TEXT NOT NULL UNIQUE
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS address_map_eth ON address_map (eth)")
        # Deterministic contract addresses for custom tokens so MetaMask can
        # treat them as ERC-20. Additive only; never deletes existing tokens.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS token_contracts (
                token_id TEXT PRIMARY KEY,
                contract_address TEXT NOT NULL UNIQUE
            )
        """)
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS token_contracts_addr ON token_contracts (contract_address)"
        )
        conn.commit()
        self._ensure_token_contracts(conn)
        genesis = self.get_block_by_index(0, conn)
        if genesis is None:
            self._insert_block_row(conn, GENESIS)
            conn.commit()
        elif genesis["hash"] != GENESIS_HASH:
            conn.close()
            raise SystemExit(
                "This database is not the Betium chain "
                f"(genesis {genesis['hash']}, expected {GENESIS_HASH}). "
                "Remove betium_chain.db and start again."
            )
        conn.close()

    def _insert_block_row(self, conn, block):
        conn.execute("""
            INSERT INTO blocks (idx, timestamp, transactions, previous_hash, nonce,
                                difficulty, protocol_version, merkle_root, hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            block["index"], int(block["timestamp"]), dumps(block["transactions"]),
            block["previous_hash"], block["nonce"], block["difficulty"],
            block["protocol_version"], block["merkle_root"], block["hash"],
        ))
        position = 0
        for tx in block["transactions"]:
            if isinstance(tx, dict) and tx.get("eth_raw"):
                try:
                    digest = ethcompat.decode_raw_tx(tx["eth_raw"])["hash"]
                except ethcompat.EthTxError:
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO eth_txs (hash, block_idx, tx_idx) VALUES (?, ?, ?)",
                    (digest, block["index"], position),
                )
                position += 1

    def _prune_blocks(self, conn, after_index):
        conn.execute("DELETE FROM blocks WHERE idx > ?", (after_index,))
        conn.execute("DELETE FROM eth_txs WHERE block_idx > ?", (after_index,))

    def find_eth_tx(self, tx_hash):
        """Return (tx, decoded, block, index) for an Ethereum-style tx hash, or None."""
        if not isinstance(tx_hash, str):
            return None
        conn = self.connect()
        row = conn.execute(
            "SELECT block_idx, tx_idx FROM eth_txs WHERE hash = ?", (tx_hash.lower(),)
        ).fetchone()
        conn.close()
        if not row:
            return None
        block = self.get_block_by_index(row[0])
        if not block:
            return None
        pairs = ethcompat._eth_txs_of(block)
        if row[1] >= len(pairs):
            return None
        tx, decoded = pairs[row[1]]
        return tx, decoded, block, row[1]

    def get_block_by_index(self, idx, conn=None):
        own = conn is None
        if own:
            conn = self.connect()
        row = conn.execute(
            "SELECT idx, timestamp, transactions, previous_hash, nonce, difficulty, "
            "protocol_version, merkle_root, hash FROM blocks WHERE idx = ?",
            (idx,),
        ).fetchone()
        if own:
            conn.close()
        if not row:
            return None
        return {
            "index": row[0], "timestamp": row[1], "transactions": json.loads(row[2]),
            "previous_hash": row[3], "nonce": row[4], "difficulty": row[5],
            "protocol_version": row[6], "merkle_root": row[7], "hash": row[8],
        }

    def get_block_by_hash(self, block_hash_hex, conn=None):
        own = conn is None
        if own:
            conn = self.connect()
        row = conn.execute("SELECT idx FROM blocks WHERE hash = ?", (block_hash_hex,)).fetchone()
        if own:
            conn.close()
        if not row:
            return None
        return self.get_block_by_index(row[0])

    def get_latest_block(self, conn=None):
        own = conn is None
        if own:
            conn = self.connect()
        row = conn.execute("SELECT idx FROM blocks ORDER BY idx DESC LIMIT 1").fetchone()
        if own:
            conn.close()
        if not row:
            return None
        return self.get_block_by_index(row[0])

    def get_chain_length(self, conn=None):
        latest = self.get_latest_block(conn)
        return 0 if latest is None else latest["index"] + 1

    def chain_work(self, conn=None):
        own = conn is None
        if own:
            conn = self.connect()
        rows = conn.execute("SELECT idx, difficulty FROM blocks").fetchall()
        if own:
            conn.close()
        return sum(work_of(r[1], r[0]) for r in rows)

    def _resolve_linked_addresses(self, address, conn):
        """Return the set of addresses that share the same key (native + 0x)."""
        addrs = {address}
        row = conn.execute(
            "SELECT native, eth FROM address_map WHERE native = ? OR eth = ?",
            (address, address),
        ).fetchone()
        if row:
            addrs.add(row[0])
            addrs.add(row[1])
        return addrs

    def _register_address_link(self, native, eth, conn):
        """Register native <-> 0x mapping and migrate any existing balances so
        both addresses immediately show the same total."""
        if not native or not eth or native == eth:
            return
        existing = conn.execute(
            "SELECT 1 FROM address_map WHERE native = ? OR eth = ?", (native, eth)
        ).fetchone()
        try:
            conn.execute(
                "INSERT OR IGNORE INTO address_map (native, eth) VALUES (?, ?)",
                (native, eth),
            )
        except Exception:
            return
        # First-time link: consolidate balances/nonces onto the eth address
        # (MetaMask canonical) and zero the native side so get_account (which
        # sums linked addresses) does not double-count.
        if existing:
            return
        rows = conn.execute(
            "SELECT address, balance, nonce FROM accounts WHERE address IN (?, ?)",
            (native, eth),
        ).fetchall()
        total_bal, max_nonce = 0, 0
        for addr, bal, nonce in rows:
            total_bal += int(bal or 0)
            max_nonce = max(max_nonce, int(nonce or 0))
        if total_bal == 0 and max_nonce == 0:
            return
        # Primary = eth (0x); alias = native
        conn.execute(
            "INSERT OR REPLACE INTO accounts (address, balance, nonce) VALUES (?, ?, ?)",
            (eth, total_bal, max_nonce),
        )
        conn.execute(
            "INSERT OR REPLACE INTO accounts (address, balance, nonce) VALUES (?, ?, ?)",
            (native, 0, max_nonce),
        )
        # Also consolidate custom-token balances onto the eth address so both
        # views stay consistent after linking.
        trows = conn.execute(
            "SELECT token_id, address, balance FROM token_balances WHERE address IN (?, ?)",
            (native, eth),
        ).fetchall()
        by_tid = {}
        for tid, addr, bal in trows:
            by_tid.setdefault(tid, 0)
            by_tid[tid] += int(bal or 0)
        for tid, total in by_tid.items():
            conn.execute(
                "INSERT OR REPLACE INTO token_balances (address, token_id, balance) VALUES (?, ?, ?)",
                (eth, tid, total),
            )
            conn.execute(
                "INSERT OR REPLACE INTO token_balances (address, token_id, balance) VALUES (?, ?, ?)",
                (native, tid, 0),
            )

    def get_account(self, address, conn=None):
        """Balance and nonce are synchronized across linked native / 0x addresses."""
        own = conn is None
        if own:
            conn = self.connect()
        linked = self._resolve_linked_addresses(address, conn)
        bal, nonce = 0, 0
        for addr in linked:
            row = conn.execute(
                "SELECT balance, nonce FROM accounts WHERE address = ?", (addr,)
            ).fetchone()
            if row:
                bal += int(row[0])
                nonce = max(nonce, int(row[1]))
        if own:
            conn.close()
        return {"balance": bal, "nonce": nonce}

    def get_pending_balance_delta(self, address):
        """Net BETM change from mempool txs that touch this address (0-conf view).

        Spends (amount + fee) reduce the balance; receives increase it.
        Used by eth_getBalance(..., "pending") and wallet pending views so
        MetaMask and the CLI show virtually instant updates.
        """
        linked = set()
        conn = self.connect()
        try:
            linked = self._resolve_linked_addresses(address, conn)
        finally:
            conn.close()
        delta = 0
        for tx in list(self.pending_transactions):
            sender = tx.get("sender")
            recipient = tx.get("recipient")
            amount = int(parse_units(tx.get("amount")) or 0)
            fee = int(parse_units(tx.get("fee")) or 0)
            if sender in linked:
                # Native BETM (or eth_raw without token_id) debit amount+fee.
                # Custom-token transfers (including eth_raw with token_id) only debit the BETM fee.
                is_native = (
                    tx.get("token_id") in (None, NATIVE_TOKEN)
                    or (tx.get("eth_raw") and not tx.get("token_id"))
                )
                if is_native:
                    delta -= amount + fee
                else:
                    delta -= fee
            if recipient in linked:
                is_native = (
                    tx.get("token_id") in (None, NATIVE_TOKEN)
                    or (tx.get("eth_raw") and not tx.get("token_id"))
                )
                if is_native:
                    delta += amount
        return delta

    def get_account_pending(self, address):
        """Confirmed balance adjusted by mempool effects (0-conf)."""
        acc = self.get_account(address)
        return {
            "balance": max(0, acc["balance"] + self.get_pending_balance_delta(address)),
            "nonce": acc["nonce"],
        }

    def get_token_balance(self, address, token_id, conn=None):
        if token_id == NATIVE_TOKEN:
            return self.get_account(address, conn)["balance"]
        own = conn is None
        if own:
            conn = self.connect()
        # Sum across linked native / 0x addresses so MetaMask and native wallets
        # see the same custom-token balance.
        linked = self._resolve_linked_addresses(address, conn)
        bal = 0
        for addr in linked:
            row = conn.execute(
                "SELECT balance FROM token_balances WHERE address = ? AND token_id = ?",
                (addr, token_id),
            ).fetchone()
            if row:
                bal += int(row[0])
        if own:
            conn.close()
        return bal

    def token_exists(self, token_id, conn=None):
        if token_id == NATIVE_TOKEN:
            return True
        own = conn is None
        if own:
            conn = self.connect()
        row = conn.execute("SELECT 1 FROM tokens WHERE token_id = ?", (token_id,)).fetchone()
        if own:
            conn.close()
        return row is not None

    def _token_contract_address(self, token_id: str) -> str:
        """Deterministic 0x contract address for a custom token (MetaMask ERC-20)."""
        h = ethcompat.keccak256(b"BetiumToken\0" + token_id.encode("utf-8"))
        return "0x" + h.hex()[:40]

    def _ensure_token_contracts(self, conn):
        """Populate token_contracts for any existing tokens that lack a mapping.
        Additive only – never deletes rows or tokens."""
        rows = conn.execute("SELECT token_id FROM tokens").fetchall()
        for (tid,) in rows:
            exists = conn.execute(
                "SELECT 1 FROM token_contracts WHERE token_id = ?", (tid,)
            ).fetchone()
            if exists:
                continue
            addr = self._token_contract_address(tid)
            # Extremely unlikely collision; re-hash with a suffix if needed.
            attempt = 0
            while conn.execute(
                "SELECT 1 FROM token_contracts WHERE contract_address = ?", (addr,)
            ).fetchone():
                attempt += 1
                addr = self._token_contract_address(f"{tid}:{attempt}")
            conn.execute(
                "INSERT INTO token_contracts (token_id, contract_address) VALUES (?, ?)",
                (tid, addr),
            )
        conn.commit()

    def get_token_id_by_contract(self, contract_address, conn=None):
        """Resolve a MetaMask-style contract address back to a token_id."""
        if not contract_address or not isinstance(contract_address, str):
            return None
        addr = contract_address.lower()
        if not addr.startswith("0x"):
            addr = "0x" + addr
        own = conn is None
        if own:
            conn = self.connect()
        row = conn.execute(
            "SELECT token_id FROM token_contracts WHERE contract_address = ?", (addr,)
        ).fetchone()
        if own:
            conn.close()
        return row[0] if row else None

    def _register_token_contract(self, token_id, conn):
        """Ensure a freshly created token has a contract address mapping."""
        exists = conn.execute(
            "SELECT 1 FROM token_contracts WHERE token_id = ?", (token_id,)
        ).fetchone()
        if exists:
            return
        addr = self._token_contract_address(token_id)
        attempt = 0
        while conn.execute(
            "SELECT 1 FROM token_contracts WHERE contract_address = ?", (addr,)
        ).fetchone():
            attempt += 1
            addr = self._token_contract_address(f"{token_id}:{attempt}")
        conn.execute(
            "INSERT INTO token_contracts (token_id, contract_address) VALUES (?, ?)",
            (token_id, addr),
        )

    def count_accounts_and_tokens(self, conn):
        accounts = conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] or 0
        tokens = conn.execute("SELECT COUNT(*) FROM tokens").fetchone()[0] or 0
        return int(accounts), int(tokens)

    def token_create_fee(self, conn=None):
        own = conn is None
        if own:
            conn = self.connect()
        accounts, tokens = self.count_accounts_and_tokens(conn)
        if own:
            conn.close()
        fee = TOKEN_CREATE_FEE + (accounts // 10000) * UNITS + (tokens // 100) * (UNITS // 2)
        return min(fee, TOKEN_CREATE_FEE_CAP)

    def min_balance_to_create(self, conn=None):
        return max(MIN_BALANCE_TO_CREATE, self.token_create_fee(conn))

    def get_total_supply(self, conn=None):
        own = conn is None
        if own:
            conn = self.connect()
        total = conn.execute("SELECT SUM(balance) FROM accounts").fetchone()[0]
        if own:
            conn.close()
        return int(total or 0)

    def get_block_reward(self, height, conn):
        """Return the coinbase for this height, respecting supply cap and the
        hard 15 BETM/hour emission ceiling (MAX_EMISSION_PER_HOUR)."""
        supply = self.get_total_supply(conn)
        if supply >= MAX_SUPPLY:
            return 0
        halvings = height // HALVING_INTERVAL
        reward = BLOCK_REWARD >> halvings if halvings < 63 else 0
        if supply + reward > MAX_SUPPLY:
            reward = MAX_SUPPLY - supply
        if reward <= 0:
            return 0
        # Rolling-hour emission ceiling: sum coinbase amounts from blocks whose
        # timestamps fall inside the last 3600 seconds relative to the tip.
        tip = self.get_latest_block(conn)
        if tip and tip["index"] > 0:
            cutoff = int(tip["timestamp"]) - 3600
            # Sum NETWORK reward amounts in recent blocks.
            rows = conn.execute(
                "SELECT transactions FROM blocks WHERE idx > 0 AND timestamp >= ?",
                (cutoff,),
            ).fetchall()
            emitted = 0
            for (txs_json,) in rows:
                for tx in json.loads(txs_json):
                    if tx.get("sender") == "NETWORK":
                        emitted += int(parse_units(tx.get("amount")) or 0)
            remaining = MAX_EMISSION_PER_HOUR - emitted
            if remaining <= 0:
                return 0
            if reward > remaining:
                reward = remaining
        return reward

    def list_tokens(self):
        conn = self.connect()
        rows = conn.execute(
            "SELECT t.token_id, t.name, t.symbol, t.creator, t.total_supply, t.created_at, "
            "c.contract_address FROM tokens t "
            "LEFT JOIN token_contracts c ON t.token_id = c.token_id "
            "ORDER BY t.created_at"
        ).fetchall()
        conn.close()
        return [
            {
                "token_id": r[0], "name": r[1], "symbol": r[2], "creator": r[3],
                "total_supply": units_to_str(r[4]), "total_supply_units": r[4],
                "created_at": r[5],
                "contract_address": r[6],
            }
            for r in rows
        ]

    def get_token_info(self, token_id):
        conn = self.connect()
        row = conn.execute(
            "SELECT t.token_id, t.name, t.symbol, t.creator, t.total_supply, t.created_at, "
            "c.contract_address FROM tokens t "
            "LEFT JOIN token_contracts c ON t.token_id = c.token_id "
            "WHERE t.token_id = ?",
            (token_id,),
        ).fetchone()
        conn.close()
        if not row:
            return None
        return {
            "token_id": row[0], "name": row[1], "symbol": row[2], "creator": row[3],
            "total_supply": units_to_str(row[4]), "total_supply_units": row[4],
            "created_at": row[5],
            "contract_address": row[6],
        }

    def expected_difficulty(self, height, conn=None):
        if height < DIFFICULTY_FORK_HEIGHT:
            return self._legacy_expected_difficulty(height, conn)
        own = conn is None
        if own:
            conn = self.connect()
        window = min(RETARGET_WINDOW, height)
        first = self.get_block_by_index(height - window, conn)
        last = self.get_block_by_index(height - 1, conn)
        rows = conn.execute(
            "SELECT idx, difficulty FROM blocks WHERE idx > ? AND idx < ?",
            (height - window, height),
        ).fetchall()
        if own:
            conn.close()
        if not first or not last or not rows:
            return INITIAL_DIFFICULTY * 4
        actual = max(1, int(last["timestamp"]) - int(first["timestamp"]))
        work = sum(work_of(r[1], r[0]) for r in rows)
        wanted = max(1, work * BLOCK_TIME_TARGET // actual)
        bits = wanted.bit_length() - 1
        if wanted * wanted >= 1 << (2 * bits + 1):   # round to the nearest power of two
            bits += 1
        prev = difficulty_bits(last["difficulty"], last["index"])
        bits = max(prev - RETARGET_MAX_STEP_BITS, min(prev + RETARGET_MAX_STEP_BITS, bits))
        return max(MIN_DIFFICULTY_BITS, min(MAX_DIFFICULTY_BITS, bits))

    def _legacy_expected_difficulty(self, height, conn=None):
        if height <= 1:
            return INITIAL_DIFFICULTY
        own = conn is None
        if own:
            conn = self.connect()
        window = min(RETARGET_WINDOW, height)
        first = self.get_block_by_index(height - window, conn)
        last = self.get_block_by_index(height - 1, conn)
        if own:
            conn.close()
        if not first or not last:
            return INITIAL_DIFFICULTY
        actual = int(last["timestamp"]) - int(first["timestamp"])
        span = max(1, last["index"] - first["index"])
        if actual <= 0:
            actual = 1
        ratio = (BLOCK_TIME_TARGET * span) / actual
        current = int(last["difficulty"])
        if ratio >= 2:
            step = 1
        elif ratio <= 0.5:
            step = -1
        else:
            step = 0
        return max(MIN_DIFFICULTY, min(MAX_DIFFICULTY, current + step))

    def median_time_past(self, height, conn):
        stamps = []
        for idx in range(max(0, height - 11), height):
            block = self.get_block_by_index(idx, conn)
            if block:
                stamps.append(int(block["timestamp"]))
        if not stamps:
            return 0
        stamps.sort()
        return stamps[len(stamps) // 2]

    def _address_from_pubkey(self, public_key_hex):
        try:
            return hashlib.sha256(bytes.fromhex(public_key_hex)).hexdigest()
        except Exception:
            return None

    def validate_transaction(self, tx, temp_balances, temp_nonces, temp_token_balances, temp_tokens, fee_acc, conn):
        sender = tx.get("sender")
        if sender == "NETWORK":
            return False, "Network rewards cannot be submitted by clients"
        if tx.get("eth_raw") is not None:
            return self._validate_eth_transaction(
                tx, temp_balances, temp_nonces, fee_acc, conn,
                temp_token_balances=temp_token_balances, temp_tokens=temp_tokens,
            )
        amount = parse_units(tx.get("amount"))
        fee = parse_units(tx.get("fee")) if "fee" in tx else None
        if amount is None or amount < 0:
            return False, "Amount must be an integer number of units (8 decimals) and cannot be negative"
        if fee is None or fee < 0:
            return False, "Fee must be an integer number of units"
        action = tx.get("action")
        token_id = tx.get("token_id", NATIVE_TOKEN)
        expected_fee = self.token_create_fee(conn) if action == "create_token" else TRANSFER_FEE
        # Allow fee >= TRANSFER_FEE for normal transfers (RBF / cancel use higher fees).
        # create_token still requires the exact scheduled fee.
        if action == "create_token":
            if fee != expected_fee:
                return False, f"Fee must be exactly {units_to_str(expected_fee)} {NATIVE_TOKEN}"
        else:
            if fee < TRANSFER_FEE:
                return False, f"Fee must be at least {units_to_str(TRANSFER_FEE)} {NATIVE_TOKEN}"

        initial = None
        if action == "create_token":
            initial = parse_units(tx.get("initial_supply"))
            if initial is None or initial <= 0:
                return False, "initial_supply must be a positive integer number of units"

        try:
            pub_key_hex = tx.get("public_key")
            if not pub_key_hex:
                return False, "Missing public_key"
            pub_key = VerifyingKey.from_string(bytes.fromhex(pub_key_hex), curve=SECP256k1)
            derived = self._address_from_pubkey(pub_key_hex)
            if derived != sender and not ethcompat.is_hex_address(sender):
                return False, "Public key does not match sender address"
            # Link native and 0x forms of the same key so balances stay in sync.
            try:
                eth_addr = ethcompat.pubkey_to_address(bytes.fromhex(pub_key_hex))
                if derived:
                    self._register_address_link(derived, eth_addr, conn)
            except Exception:
                pass
            signed = dumps(canonical_tx(tx)).encode()
            if not pub_key.verify(bytes.fromhex(tx.get("signature")), signed):
                return False, "Bad signature"
        except Exception as exc:
            return False, f"Malformed signature: {exc}"

        acc = self.get_account(sender, conn)
        expected_nonce = temp_nonces.get(sender, acc["nonce"]) + 1
        if tx.get("nonce") != expected_nonce:
            return False, f"Bad nonce, expected {expected_nonce}"

        curr = temp_balances.get(sender, acc["balance"])
        if action == "create_token":
            tid = tx.get("token_id")
            name = tx.get("token_name")
            symbol = tx.get("token_symbol")
            if not isinstance(tid, str) or not (3 <= len(tid) <= 32):
                return False, "token_id must be 3-32 characters"
            if not all(c.isalnum() or c in "-_" for c in tid):
                return False, "token_id has illegal characters"
            if tid.upper() == NATIVE_TOKEN:
                return False, "BETM is reserved"
            if self.token_exists(tid, conn) or tid in temp_tokens:
                return False, "Token id already exists"
            if not name or not symbol:
                return False, "Token name and symbol are required"
            needed = max(MIN_BALANCE_TO_CREATE, expected_fee)
            if curr < needed:
                return False, f"Need at least {units_to_str(needed)} BETM before creating a token"
            temp_balances[sender] = curr - fee
            key = (sender, tid)
            temp_token_balances[key] = temp_token_balances.get(key, 0) + initial
            temp_tokens.add(tid)
            temp_nonces[sender] = tx["nonce"]
            fee_acc["total"] = fee_acc.get("total", 0) + fee
            return True, "Valid create_token"

        # Zero-amount self-transfer is allowed as an RBF cancel; any other
        # non-positive amount is rejected.
        is_cancel = amount == 0 and tx.get("recipient") == sender
        if amount < 0 or (amount == 0 and not is_cancel):
            return False, "Transfer amount must be positive (or 0 for a cancel self-transfer)"
        if token_id == NATIVE_TOKEN:
            if curr < amount + fee:
                return False, "Insufficient BETM for amount plus fee"
            temp_balances[sender] = curr - amount - fee
            recipient = tx.get("recipient")
            base = temp_balances.get(recipient, self.get_account(recipient, conn)["balance"])
            temp_balances[recipient] = base + amount
        else:
            if curr < fee:
                return False, "Insufficient BETM to pay the transfer fee"
            temp_balances[sender] = curr - fee
            if not self.token_exists(token_id, conn) and token_id not in temp_tokens:
                return False, "Unknown token"
            recipient = tx.get("recipient")
            key_s = (sender, token_id)
            key_r = (recipient, token_id)
            have = temp_token_balances.get(key_s, self.get_token_balance(sender, token_id, conn))
            if have < amount:
                return False, "Insufficient token balance"
            temp_token_balances[key_s] = have - amount
            temp_token_balances[key_r] = temp_token_balances.get(
                key_r, self.get_token_balance(recipient, token_id, conn)
            ) + amount
        temp_nonces[sender] = tx["nonce"]
        fee_acc["total"] = fee_acc.get("total", 0) + fee
        return True, "Valid"

    ETH_TX_KEYS = {"sender", "recipient", "amount", "fee", "nonce", "eth_raw", "token_id", "contract"}

    def _validate_eth_transaction(self, tx, temp_balances, temp_nonces, fee_acc, conn, temp_token_balances=None, temp_tokens=None):
        """A MetaMask transaction: everything is derived from the signed raw bytes.
        Supports plain BETM value transfers and ERC-20 transfer() to custom-token contracts.
        """
        if not set(tx) <= self.ETH_TX_KEYS:
            return False, "Unexpected fields in Ethereum transaction"
        try:
            expected, decoded = ethcompat.build_internal_tx(tx["eth_raw"])
        except ethcompat.EthTxError as exc:
            return False, str(exc)
        for key in ("sender", "recipient", "amount", "fee", "nonce", "eth_raw"):
            if tx.get(key) != expected[key] or isinstance(tx.get(key), bool):
                return False, f"Field '{key}' does not match the signed transaction"
        sender, recipient = expected["sender"], expected["recipient"]
        amount, fee = expected["amount"], expected["fee"]
        token_id = None
        if "contract" in expected:
            # Custom token transfer via ERC-20 transfer()
            contract = expected["contract"]
            token_id = self.get_token_id_by_contract(contract, conn)
            if not token_id:
                return False, f"Unknown token contract {contract}"
            if tx.get("token_id") is not None and tx.get("token_id") != token_id:
                return False, "token_id does not match the contract in the signed transaction"
            expected["token_id"] = token_id
            # Also accept if the submitted tx already carried token_id
            if "token_id" not in tx:
                tx["token_id"] = token_id
        # Register native <-> 0x link from the recovered public key so balances stay synchronized.
        try:
            d = decoded
            data = d.get("data") or b""
            signing = ethcompat.rlp_encode([
                d["nonce"], d["gas_price"], d["gas"],
                bytes.fromhex(d["to"][2:]), d["value_wei"], data,
                ETH_CHAIN_ID, 0, 0,
            ])
            recid = d["v"] - (ETH_CHAIN_ID * 2 + 35)
            pub = ethcompat.recover_pubkey(ethcompat.keccak256(signing), d["r"], d["s"], recid)
            native = hashlib.sha256(pub).hexdigest()
            self._register_address_link(native, sender, conn)
        except Exception:
            pass
        acc = self.get_account(sender, conn)
        expected_nonce = temp_nonces.get(sender, acc["nonce"]) + 1
        if expected["nonce"] != expected_nonce:
            return False, f"Bad nonce, expected {expected_nonce - 1}"
        curr = temp_balances.get(sender, acc["balance"])
        if token_id is None:
            # Native BETM transfer
            if curr < amount + fee:
                return False, "Insufficient BETM for amount plus fee"
            temp_balances[sender] = curr - amount - fee
            base = temp_balances.get(recipient, self.get_account(recipient, conn)["balance"])
            temp_balances[recipient] = base + amount
        else:
            # Custom token: fee paid in BETM, amount moved in token_balances
            if curr < fee:
                return False, "Insufficient BETM to pay the transfer fee"
            temp_balances[sender] = curr - fee
            if temp_token_balances is None:
                temp_token_balances = {}
            key_s = (sender, token_id)
            key_r = (recipient, token_id)
            have = temp_token_balances.get(key_s, self.get_token_balance(sender, token_id, conn))
            if have < amount:
                return False, f"Insufficient {token_id} balance"
            temp_token_balances[key_s] = have - amount
            temp_token_balances[key_r] = temp_token_balances.get(
                key_r, self.get_token_balance(recipient, token_id, conn)
            ) + amount
        temp_nonces[sender] = expected["nonce"]
        fee_acc["total"] = fee_acc.get("total", 0) + fee
        return True, "Valid"

    def valid_pending(self, conn, only_sender=None):
        """Mempool transactions that still apply in order. Drops stale or conflicting ones."""
        temp_balances, temp_nonces, temp_tb, temp_tokens = {}, {}, {}, set()
        fee_acc = {"total": 0}
        good = []
        for tx in list(self.pending_transactions):
            if only_sender is not None and tx.get("sender") != only_sender:
                continue
            ok, _ = self.validate_transaction(
                tx, temp_balances, temp_nonces, temp_tb, temp_tokens, fee_acc, conn
            )
            if ok:
                good.append(tx)
        return good, (temp_balances, temp_nonces, temp_tb, temp_tokens, fee_acc)

    def _tx_fee(self, tx):
        return int(parse_units(tx.get("fee")) or 0)

    def _tx_nonce(self, tx):
        return int(tx.get("nonce") or 0)

    def submit_transaction(self, tx):
        """Validate a client transaction against the mempool and queue it.

        Supports replace-by-fee (RBF): a new tx from the same sender with the
        same nonce and a strictly higher fee (or a zero-value self-transfer
        used as a cancel) replaces the existing mempool entry.
        Returns (ok, message, http_status).
        """
        if len(self.pending_transactions) >= MAX_MEMPOOL_SIZE:
            return False, "Mempool is full", 503
        recipient = tx.get("recipient")
        if not ethcompat.valid_account_id(recipient):
            return False, "Recipient must be a 64-character Betium address or a 0x Ethereum address (lowercase)", 400
        fingerprint = dumps(canonical_tx(tx))
        if any(dumps(canonical_tx(existing)) == fingerprint for existing in self.pending_transactions):
            return True, "Already in mempool", 200

        sender = tx.get("sender")
        nonce = self._tx_nonce(tx)
        new_fee = self._tx_fee(tx)

        # RBF / cancel: same sender + nonce → replace only if fee is higher
        # (or the new tx is a zero-amount self-transfer, which MetaMask uses to cancel).
        replaced = False
        for i, existing in enumerate(list(self.pending_transactions)):
            if existing.get("sender") != sender:
                continue
            if self._tx_nonce(existing) != nonce:
                continue
            old_fee = self._tx_fee(existing)
            is_cancel = (
                parse_units(tx.get("amount")) == 0
                and tx.get("recipient") == sender
            )
            if new_fee > old_fee or is_cancel:
                self.pending_transactions.pop(i)
                replaced = True
                break
            return False, "Replacement requires a higher fee (RBF) or a cancel self-transfer", 400

        conn = self.connect()
        try:
            # When replacing, exclude the old same-nonce tx from the temp view.
            _good, state = self.valid_pending(conn, only_sender=sender)
            temp_balances, temp_nonces, temp_tb, temp_tokens, _fee = state
            # If we already removed the old tx, temp_nonces may still expect the next
            # nonce; force the expected nonce for this replacement to match.
            if replaced:
                acc = self.get_account(sender, conn)
                # Pending nonces after eviction should allow this nonce again.
                # Rebuild a clean temp state without the replaced entry (already popped).
                temp_balances, temp_nonces, temp_tb, temp_tokens = {}, {}, {}, set()
                for other in self.pending_transactions:
                    if other.get("sender") != sender:
                        continue
                    self.validate_transaction(
                        other, temp_balances, temp_nonces, temp_tb, temp_tokens, {"total": 0}, conn
                    )
            ok, msg = self.validate_transaction(
                tx, temp_balances, temp_nonces, temp_tb, temp_tokens, {"total": 0}, conn
            )
        finally:
            conn.close()
        if not ok:
            return False, msg, 400
        self.pending_transactions.append(tx)
        threading.Thread(target=self.broadcast_tx, args=(tx,), daemon=True).start()
        if replaced:
            return True, "Transaction replaced previous mempool entry (RBF) and relayed", 201
        return True, "Transaction accepted and relayed", 201

    def check_block_header(self, block, conn):
        if block.get("protocol_version") != PROTOCOL_VERSION:
            return False, "Wrong protocol version"
        if not isinstance(block.get("timestamp"), int):
            return False, "Timestamp must be an integer unix time"
        if merkle_root(block.get("transactions", [])) != block.get("merkle_root"):
            return False, "Bad merkle root"
        expected = self.expected_difficulty(block["index"], conn)
        if int(block.get("difficulty", -1)) != expected:
            return False, f"Wrong difficulty, expected {expected}"
        digest = block_hash(block)
        if digest != block.get("hash") or not meets_target(digest, int(block["difficulty"]), block["index"]):
            return False, "Bad proof of work"
        return True, digest

    def check_transactions(self, block, conn):
        reward = self.get_block_reward(block["index"], conn)
        reward_count = 0
        miner = None
        temp_balances = {}
        temp_nonces = {}
        temp_token_balances = {}
        temp_tokens = set()
        fee_acc = {"total": 0}
        created = []
        for tx in block["transactions"]:
            if tx.get("sender") == "NETWORK":
                reward_count += 1
                if reward_count > 1 or parse_units(tx.get("amount")) != reward:
                    return None, "Bad coinbase amount"
                if tx.get("token_id") not in (None, NATIVE_TOKEN):
                    return None, "Coinbase must be BETM"
                miner = tx.get("recipient")
                if not miner:
                    return None, "Coinbase missing recipient"
                base = temp_balances.get(miner, self.get_account(miner, conn)["balance"])
                temp_balances[miner] = base + reward
            else:
                ok, msg = self.validate_transaction(
                    tx, temp_balances, temp_nonces, temp_token_balances, temp_tokens, fee_acc, conn
                )
                if not ok:
                    return None, msg
                if tx.get("action") == "create_token":
                    created.append(tx)
        if block["index"] != 0 and reward_count != 1:
            return None, "Block must contain exactly one coinbase"
        if miner and fee_acc["total"]:
            base = temp_balances.get(miner, self.get_account(miner, conn)["balance"])
            temp_balances[miner] = base + fee_acc["total"]
        return {
            "balances": temp_balances,
            "nonces": temp_nonces,
            "token_balances": temp_token_balances,
            "created": created,
        }, "ok"

    def _write_state(self, conn, state):
        touched = set(state["balances"]) | set(state["nonces"])
        # Expand to every linked native/0x address so both sides stay synchronized.
        expanded = set()
        for addr in touched:
            expanded |= self._resolve_linked_addresses(addr, conn)
        for addr in expanded:
            # Prefer the explicit state value; otherwise fall back to current (already summed).
            bal = state["balances"].get(addr)
            nonce = state["nonces"].get(addr)
            if bal is None or nonce is None:
                # Pull the summed view and write the full amount to every alias
                # so subsequent lookups (which also sum) do not double-count.
                acc = self.get_account(addr, conn)
                if bal is None:
                    bal = acc["balance"]
                if nonce is None:
                    nonce = acc["nonce"]
            # Write the same total to each linked address; get_account will
            # continue to sum, so we store the full amount only on the primary
            # and zero the aliases to avoid double counting on future reads.
            linked = self._resolve_linked_addresses(addr, conn)
            primary = sorted(linked)[0]  # stable primary
            for a in linked:
                store_bal = int(bal) if a == primary else 0
                store_nonce = int(nonce)
                conn.execute(
                    "INSERT OR REPLACE INTO accounts (address, balance, nonce) VALUES (?, ?, ?)",
                    (a, store_bal, store_nonce),
                )
        for tx in state["created"]:
            conn.execute(
                "INSERT INTO tokens (token_id, name, symbol, creator, total_supply, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (tx["token_id"], tx["token_name"], tx["token_symbol"], tx["sender"],
                 parse_units(tx["initial_supply"]), int(time.time())),
            )
            self._register_token_contract(tx["token_id"], conn)
        for (addr, tid), bal in state["token_balances"].items():
            conn.execute(
                "INSERT OR REPLACE INTO token_balances (address, token_id, balance) VALUES (?, ?, ?)",
                (addr, tid, int(bal)),
            )

    def clear_state(self, conn):
        conn.execute("DELETE FROM accounts")
        conn.execute("DELETE FROM tokens")
        conn.execute("DELETE FROM token_balances")
        # Keep token_contracts in sync with tokens (additive table; cleared only on full replay)
        conn.execute("DELETE FROM token_contracts")

    def replay_all(self, conn):
        self.clear_state(conn)
        rows = conn.execute("SELECT idx FROM blocks ORDER BY idx").fetchall()
        for (idx,) in rows:
            if idx == 0:
                continue
            block = self.get_block_by_index(idx, conn)
            state, msg = self.check_transactions(block, conn)
            if state is None:
                raise RuntimeError(msg)
            self._write_state(conn, state)

    def add_block(self, block, relay=True):
        with self._chain_lock:
            conn = self.connect()
            try:
                conn.isolation_level = "EXCLUSIVE"
                if self.get_block_by_hash(block.get("hash"), conn):
                    conn.close()
                    return True, "Already have this block", False
                ok, msg = self.check_block_header(block, conn)
                if not ok:
                    conn.close()
                    return False, msg, False
                parent = self.get_block_by_hash(block.get("previous_hash"), conn)
                if parent is None:
                    if len(self.orphans) < MAX_ORPHANS:
                        self.orphans[block["hash"]] = block
                    conn.close()
                    return False, "Unknown parent; stored as orphan and will sync", False
                tip = self.get_latest_block(conn)
                if parent["hash"] == tip["hash"] and block["index"] == tip["index"] + 1:
                    if block["timestamp"] <= self.median_time_past(block["index"], conn):
                        conn.close()
                        return False, "Timestamp is not after median time past", False
                    if block["timestamp"] > int(time.time()) + 7200:
                        conn.close()
                        return False, "Timestamp too far in the future", False
                    state, msg = self.check_transactions(block, conn)
                    if state is None:
                        conn.close()
                        return False, msg, False
                    self._insert_block_row(conn, block)
                    self._write_state(conn, state)
                    conn.commit()
                    conn.close()
                    self._accept_mempool(block)
                    self._connect_orphans()
                    if relay:
                        threading.Thread(target=self.broadcast_block, args=(block,), daemon=True).start()
                    return True, "Block accepted", True

                # Side branch. Adopt it only when the resulting chain has more work.
                their_work = self._work_until(parent, conn) + work_of(block["difficulty"], block["index"])
                if their_work <= self.chain_work(conn):
                    conn.close()
                    return False, "Side branch has less work than the current chain", False
                conn.close()
                adopted, msg = self._adopt([(block, parent["index"])])
                if adopted and relay:
                    threading.Thread(target=self.broadcast_block, args=(block,), daemon=True).start()
                return adopted, msg, adopted
            except Exception as exc:
                try:
                    conn.rollback()
                    conn.close()
                except Exception:
                    pass
                return False, f"Database error: {exc}", False

    def _work_until(self, block, conn):
        rows = conn.execute(
            "SELECT idx, difficulty FROM blocks WHERE idx <= ?", (block["index"],)
        ).fetchall()
        return sum(work_of(r[1], r[0]) for r in rows)

    def _accept_mempool(self, block):
        included = {dumps(canonical_tx(tx)) for tx in block["transactions"] if tx.get("sender") != "NETWORK"}
        self.pending_transactions = [
            tx for tx in self.pending_transactions
            if dumps(canonical_tx(tx)) not in included
        ]

    def _connect_orphans(self):
        progressed = True
        while progressed:
            progressed = False
            tip = self.get_latest_block()
            for digest, orphan in list(self.orphans.items()):
                if orphan.get("previous_hash") == tip["hash"]:
                    self.orphans.pop(digest, None)
                    ok, _, _ = self.add_block(orphan, relay=True)
                    progressed = progressed or ok
                    break

    def _adopt(self, replacements):
        """Replace the tip with the given blocks if they form more work. replacements are already-checked headers."""
        with self._chain_lock:
            conn = self.connect()
            try:
                conn.isolation_level = "EXCLUSIVE"
                for block, parent_index in replacements:
                    self._prune_blocks(conn, parent_index)
                    self._insert_block_row(conn, block)
                self.replay_all(conn)
                conn.commit()
                conn.close()
                self.pending_transactions = []
                return True, "Reorganized onto the heavier chain"
            except Exception as exc:
                try:
                    conn.rollback()
                    conn.close()
                except Exception:
                    pass
                return False, f"Reorg failed: {exc}"

    def adopt_chain(self, blocks):
        """Replace local blocks after the common ancestor with `blocks` (full block dicts, in order)."""
        if not blocks:
            return False, "Nothing to adopt"
        with self._chain_lock:
            conn = self.connect()
            try:
                conn.isolation_level = "EXCLUSIVE"
                parent = self.get_block_by_hash(blocks[0]["previous_hash"], conn)
                if parent is None and not (blocks[0]["index"] == 0 and blocks[0]["hash"] == GENESIS_HASH):
                    conn.close()
                    return False, "Cannot find the fork parent"
                fork_index = -1 if parent is None else parent["index"]
                self._prune_blocks(conn, fork_index)
                for block in blocks:
                    ok, msg = self.check_block_header(block, conn)
                    if not ok:
                        conn.rollback()
                        conn.close()
                        return False, msg
                    self._insert_block_row(conn, block)
                self.replay_all(conn)
                conn.commit()
                conn.close()
                self.pending_transactions = []
                return True, "Synced heavier chain"
            except Exception as exc:
                try:
                    conn.rollback()
                    conn.close()
                except Exception:
                    pass
                return False, f"Sync apply failed: {exc}"

    def status(self):
        tip = self.get_latest_block()
        return {
            "genesis": GENESIS_HASH,
            "height": tip["index"],
            "tip": tip["hash"],
            "work": str(self.chain_work()),
            "protocol_version": PROTOCOL_VERSION,
        }

    # ---- read-only transaction search -------------------------------------

    @staticmethod
    def _tx_view(tx, block_index, block_hash, timestamp, tx_index):
        """One confirmed transaction as returned by the search endpoints."""
        try:
            if tx.get("eth_raw"):
                tx_hash = ethcompat.decode_raw_tx(tx["eth_raw"])["hash"]
            else:
                # Same SHA-256 of the canonical JSON that the block's merkle tree uses.
                tx_hash = hashlib.sha256(dumps(canonical_tx(tx)).encode()).hexdigest()
        except Exception:
            tx_hash = None
        view = {
            "tx_hash": tx_hash,
            "block_index": block_index,
            "block_hash": block_hash,
            "tx_index": tx_index,
            "timestamp": timestamp,
            "sender": tx.get("sender"),
            "recipient": tx.get("recipient"),
            "amount": parse_units(tx.get("amount")),
            "fee": parse_units(tx.get("fee")) or 0,
            "token_id": tx.get("token_id") or NATIVE_TOKEN,
        }
        if tx.get("action"):
            view["action"] = tx["action"]
        return view

    def scan_transactions(self, limit, address=None):
        """Read-only. Newest-first confirmed transactions, optionally only those where
        `address` (lowercase) is sender or recipient. Walks blocks from the tip down and
        stops as soon as `limit` results are found. Never touches state or the mempool."""
        out = []
        like = '%"' + address + '"%' if address else None  # cheap pre-filter, exact match below
        conn = self.connect()
        try:
            cursor = conn.execute("SELECT MAX(idx) FROM blocks").fetchone()[0]
            while cursor is not None and cursor >= 0 and len(out) < limit:
                if like:
                    rows = conn.execute(
                        "SELECT idx, timestamp, hash, transactions FROM blocks "
                        "WHERE idx <= ? AND transactions LIKE ? ORDER BY idx DESC LIMIT 100",
                        (cursor, like),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT idx, timestamp, hash, transactions FROM blocks "
                        "WHERE idx <= ? ORDER BY idx DESC LIMIT 100",
                        (cursor,),
                    ).fetchall()
                if not rows:
                    break
                for idx, ts, bhash, raw in rows:
                    txs = json.loads(raw)
                    for i in range(len(txs) - 1, -1, -1):
                        if len(out) >= limit:
                            break
                        tx = txs[i]
                        if address and address not in (
                            str(tx.get("sender")).lower(), str(tx.get("recipient")).lower()
                        ):
                            continue
                        out.append(self._tx_view(tx, idx, bhash, ts, i))
                    if len(out) >= limit:
                        break
                cursor = rows[-1][0] - 1
        finally:
            conn.close()
        return out

    def headers_from(self, start):
        conn = self.connect()
        rows = conn.execute(
            "SELECT idx, hash, previous_hash, difficulty, timestamp, merkle_root FROM blocks WHERE idx >= ? ORDER BY idx",
            (start,),
        ).fetchall()
        conn.close()
        return [
            {
                "index": r[0], "hash": r[1], "previous_hash": r[2],
                "difficulty": r[3], "timestamp": r[4], "merkle_root": r[5],
            }
            for r in rows
        ]

    def sync_from_peers(self):
        for peer in list(self.peers):
            if peer == self.my_node_url:
                continue
            try:
                self.sync_from_peer(peer)
            except Exception:
                continue

    def sync_from_peer(self, peer):
        res = requests.get(f"{peer}/chain/status", timeout=4)
        if res.status_code != 200:
            return
        remote = res.json()
        if remote.get("genesis") != GENESIS_HASH:
            return
        if int(remote.get("work", "0")) <= self.chain_work():
            return
        headers = requests.get(f"{peer}/headers?from=0", timeout=10).json().get("headers", [])
        if not headers or headers[0].get("hash") != GENESIS_HASH:
            return
        local_tip_height = self.get_latest_block()["index"]
        common = -1
        for header in headers:
            local = self.get_block_by_index(header["index"])
            if local and local["hash"] == header["hash"]:
                common = header["index"]
            else:
                break
        if common == local_tip_height and common == headers[-1]["index"]:
            return
        blocks = []
        for header in headers:
            if header["index"] <= common:
                continue
            full = requests.get(f"{peer}/block/{header['index']}", timeout=5)
            if full.status_code != 200:
                return
            block = full.json()["block"]
            if block.get("hash") != header["hash"]:
                return
            blocks.append(block)
        if not blocks:
            return
        adopted, msg = self.adopt_chain(blocks)
        if adopted:
            print(f"[*] Adopted heavier chain from {peer}: {msg} (height {blocks[-1]['index']})")

    def broadcast_block(self, block):
        for peer in list(self.peers):
            if peer == self.my_node_url:
                continue
            try:
                requests.post(f"{peer}/block/submit", json=block, timeout=4)
            except Exception:
                pass

    def broadcast_tx(self, tx):
        for peer in list(self.peers):
            if peer == self.my_node_url:
                continue
            try:
                requests.post(f"{peer}/transaction/new", json=tx, timeout=3)
            except Exception:
                pass

    def _clean_peer_url(self, url_str):
        if not url_str or not isinstance(url_str, str):
            return None
        parsed = urlparse(url_str.strip())
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return None
        hostname = parsed.hostname
        if hostname in ("localhost", "127.0.0.1", "0.0.0.0") or (
            hostname and (
                hostname.startswith("10.") or hostname.startswith("192.168.")
                or hostname.startswith("169.254.")
            )
        ):
            return None
        return f"{parsed.scheme}://{parsed.netloc}"

    def register_peer(self, url_str, announce=True):
        clean_url = self._clean_peer_url(url_str)
        if not clean_url:
            return False
        with self._peer_lock:
            if len(self.peers) >= MAX_PEERS and clean_url not in self.peers:
                return False
            is_new = clean_url not in self.peers
            if is_new:
                self.peers.add(clean_url)
                self.save_peers()
        if is_new and announce:
            threading.Thread(target=self._announce_peer, args=(clean_url,), daemon=True).start()
        return True

    def _announce_peer(self, new_url):
        try:
            res = requests.get(f"{new_url}/peers", timeout=3)
            if res.status_code == 200:
                for peer in res.json().get("peers", []):
                    self.register_peer(peer, announce=True)
        except Exception:
            pass
        if self.my_node_url and self.my_node_url != new_url:
            try:
                requests.post(f"{new_url}/peers/register", json={"url": self.my_node_url}, timeout=2)
            except Exception:
                pass
        for peer in list(self.peers):
            if peer in (new_url, self.my_node_url):
                continue
            try:
                requests.post(f"{peer}/peers/register", json={"url": new_url}, timeout=2)
            except Exception:
                pass
        try:
            self.sync_from_peer(new_url)
        except Exception:
            pass

    def known_peers_for_clients(self):
        peers = set(self.peers)
        if self.my_node_url:
            peers.add(self.my_node_url)
        return sorted(peers)

    def start_network(self, my_node_url, bootstrap=None):
        self.my_node_url = self._clean_peer_url(my_node_url) or my_node_url
        if bootstrap:
            self.register_peer(bootstrap, announce=True)
        threading.Thread(target=self._loop, args=(self.my_node_url,), daemon=True).start()
        # Auto-mine pending transfers so users never have to run a miner themselves.
        # With MIN_DIFFICULTY_BITS lowered, a single node can confirm txs in seconds.
        threading.Thread(target=self._auto_mine_loop, daemon=True).start()

    def _auto_mine_loop(self):
        """Background miner: when the mempool is non-empty, solve a block quickly."""
        miner_addr = os.environ.get("BETIUM_AUTO_MINER", "0x00000000000000000000000000000000000000b1")
        while True:
            try:
                time.sleep(3)
                if not self.pending_transactions:
                    continue
                with self._chain_lock:
                    conn = self.connect()
                    tip = self.get_latest_block(conn)
                    index = tip["index"] + 1
                    reward = self.get_block_reward(index, conn)
                    difficulty = self.expected_difficulty(index, conn)
                    pending, _ = self.valid_pending(conn)
                    conn.close()
                if not pending:
                    continue
                reward_tx = {
                    "sender": "NETWORK",
                    "recipient": miner_addr,
                    "amount": reward,
                    "fee": 0,
                    "nonce": 0,
                    "token_id": NATIVE_TOKEN,
                    "public_key": "NETWORK",
                    "signature": "REWARD",
                }
                transactions = pending + [reward_tx]
                template = {
                    "index": index,
                    "previous_hash": tip["hash"],
                    "difficulty": difficulty,
                    "protocol_version": PROTOCOL_VERSION,
                    "merkle_root": merkle_root(transactions),
                    "transactions": transactions,
                }
                # Limited search so the node stays responsive; retarget keeps difficulty low.
                bits = difficulty_bits(difficulty, index)
                max_tries = 1 << min(bits + 4, 20)  # a few multiples of expected work
                head = ('{"difficulty":%d,"index":%d,"merkle_root":%s,"nonce":' % (
                    template["difficulty"], template["index"], json.dumps(template["merkle_root"]))).encode()
                ts = int(time.time())
                tail = (',"previous_hash":%s,"protocol_version":%d,"timestamp":%d,"transactions":%s}' % (
                    json.dumps(template["previous_hash"]), template["protocol_version"], ts,
                    dumps(template["transactions"]))).encode()
                shift = 256 - bits
                found = None
                for nonce in range(max_tries):
                    h = hashlib.sha256(head + str(nonce).encode() + tail).digest()
                    if int.from_bytes(h, "big") >> shift == 0:
                        found = nonce
                        break
                if found is None:
                    continue
                block = dict(template)
                block["timestamp"] = ts
                block["nonce"] = found
                block["hash"] = block_hash(block)
                ok, msg, is_new = self.add_block(block, relay=True)
                if ok and is_new:
                    logging.info("Auto-mined block %s (%d pending txs confirmed)", block["index"], len(pending))
            except Exception as exc:
                logging.debug("Auto-mine tick failed: %s", exc)

    def _loop(self, my_node_url):
        while True:
            self.sync_from_peers()
            for peer in list(self.peers):
                if peer == my_node_url:
                    continue
                try:
                    res = requests.get(f"{peer}/peers", timeout=3)
                    if res.status_code == 200:
                        for item in res.json().get("peers", []):
                            self.register_peer(item, announce=True)
                    requests.post(f"{peer}/peers/register", json={"url": my_node_url}, timeout=2)
                except Exception:
                    pass
            time.sleep(20)


blockchain = Blockchain()


def public_account(address, token_id=NATIVE_TOKEN):
    if token_id == NATIVE_TOKEN:
        acc = blockchain.get_account(address)
        balance = acc["balance"]
        nonce = acc["nonce"]
    else:
        balance = blockchain.get_token_balance(address, token_id)
        nonce = blockchain.get_account(address)["nonce"]
    return {
        "address": address,
        "token_id": token_id,
        "balance": units_to_str(balance),
        "balance_units": balance,
        "nonce": nonce,
    }


@app.route("/chain/status", methods=["GET"])
def chain_status():
    return jsonify(blockchain.status())


@app.route("/headers", methods=["GET"])
def headers():
    start = request.args.get("from", "0")
    try:
        start_i = max(0, int(start))
    except ValueError:
        return jsonify({"error": "from must be an integer"}), 400
    return jsonify({"headers": blockchain.headers_from(start_i), "genesis": GENESIS_HASH})


@app.route("/block/<int:index>", methods=["GET"])
def get_block(index):
    block = blockchain.get_block_by_index(index)
    if not block:
        return jsonify({"error": "Unknown block"}), 404
    return jsonify({"block": block})


@app.route("/balance/<address>", methods=["GET"])
def balance(address):
    return jsonify(public_account(address))


@app.route("/balance/<address>/<token_id>", methods=["GET"])
def token_balance(address, token_id):
    return jsonify(public_account(address, token_id))


@app.route("/supply", methods=["GET"])
def total_supply():
    supply = blockchain.get_total_supply()
    return jsonify({
        "total_circulating_supply": units_to_str(supply),
        "total_circulating_supply_units": supply,
        "max_supply": units_to_str(MAX_SUPPLY),
        "max_supply_units": MAX_SUPPLY,
    })


def _parse_limit():
    """?limit= for the search endpoints: default 50, max 500, None if invalid."""
    raw = request.args.get("limit", "50")
    try:
        limit = int(raw)
    except ValueError:
        return None
    return None if limit < 1 else min(limit, 500)


@app.route("/transactions/recent", methods=["GET"])
def recent_transactions():
    limit = _parse_limit()
    if limit is None:
        return jsonify({"success": False, "error": "limit must be a positive integer"}), 400
    txs = blockchain.scan_transactions(limit)
    return jsonify({"success": True, "count": len(txs), "transactions": txs})


@app.route("/address/<address>/transactions", methods=["GET"])
def address_transactions(address):
    address = address.lower()
    if not ethcompat.valid_account_id(address):
        return jsonify({
            "success": False,
            "error": "Address must be a 64-character Betium address or a 0x Ethereum address",
        }), 400
    limit = _parse_limit()
    if limit is None:
        return jsonify({"success": False, "error": "limit must be a positive integer"}), 400
    txs = blockchain.scan_transactions(limit, address)
    return jsonify({"success": True, "address": address, "count": len(txs), "transactions": txs})


@app.route("/tokens", methods=["GET"])
def tokens_list():
    return jsonify({"tokens": blockchain.list_tokens()})


@app.route("/token/<token_id>", methods=["GET"])
def token_info(token_id):
    info = blockchain.get_token_info(token_id)
    if not info:
        return jsonify({"error": "Token not found"}), 404
    return jsonify(info)


@app.route("/fees", methods=["GET"])
def fee_schedule():
    fee = blockchain.token_create_fee()
    minimum = blockchain.min_balance_to_create()
    return jsonify({
        "decimals": 8,
        "unit": UNITS,
        "native_token": NATIVE_TOKEN,
        "transfer_fee": units_to_str(TRANSFER_FEE),
        "transfer_fee_units": TRANSFER_FEE,
        "token_create_fee": units_to_str(fee),
        "token_create_fee_units": fee,
        "token_create_fee_cap": units_to_str(TOKEN_CREATE_FEE_CAP),
        "min_balance_to_create_token": units_to_str(minimum),
        "min_balance_to_create_token_units": minimum,
        "fee_recipient": "block_miner",
        "token_create_fee_rule": "+1 BETM per 10000 accounts, +0.5 BETM per 100 custom tokens, cap 100",
        "block_time_target_seconds": BLOCK_TIME_TARGET,
        "genesis": GENESIS_HASH,
    })


@app.route("/peers", methods=["GET"])
def get_peers():
    return jsonify({"peers": blockchain.known_peers_for_clients()})


@app.route("/peers/register", methods=["POST"])
def register_peer():
    vals = request.get_json() or {}
    if "url" not in vals:
        return jsonify({"error": "Peer URL required"}), 400
    if not blockchain.register_peer(vals.get("url"), announce=True):
        return jsonify({"error": "Invalid or restricted peer URL"}), 400
    return jsonify({
        "message": "Peer registered and announced",
        "peers": blockchain.known_peers_for_clients(),
    }), 201


@app.route("/transaction/new", methods=["POST"])
def new_transaction():
    if request.content_length and request.content_length > 10240:
        return jsonify({"error": "Payload too large"}), 413
    tx = request.get_json(silent=True)
    if not isinstance(tx, dict):
        return jsonify({"error": "Invalid JSON"}), 400
    if tx.get("sender") == "NETWORK" or tx.get("public_key") == "NETWORK":
        return jsonify({"error": "Network rewards cannot be submitted by clients"}), 400
    required = ["sender", "recipient", "amount", "fee", "nonce"]
    required += ["eth_raw"] if tx.get("eth_raw") else ["public_key", "signature"]
    if not all(k in tx for k in required):
        return jsonify({"error": "Missing transaction fields"}), 400
    ok, msg, status = blockchain.submit_transaction(tx)
    return jsonify({"message": msg} if ok else {"error": msg}), status


@app.route("/mine/template", methods=["GET"])
def mine_template():
    miner = request.args.get("miner")
    if not miner:
        return jsonify({"error": "Miner address required"}), 400
    with blockchain._chain_lock:
        conn = blockchain.connect()
        tip = blockchain.get_latest_block(conn)
        index = tip["index"] + 1
        reward = blockchain.get_block_reward(index, conn)
        difficulty = blockchain.expected_difficulty(index, conn)
        pending, _state = blockchain.valid_pending(conn)
        conn.close()
    reward_tx = {
        "sender": "NETWORK",
        "recipient": miner,
        "amount": reward,
        "fee": 0,
        "nonce": 0,
        "token_id": NATIVE_TOKEN,
        "public_key": "NETWORK",
        "signature": "REWARD",
    }
    transactions = pending + [reward_tx]
    block = {
        "index": index,
        "previous_hash": tip["hash"],
        "difficulty": difficulty,
        "protocol_version": PROTOCOL_VERSION,
        "merkle_root": merkle_root(transactions),
        "transactions": transactions,
    }
    return jsonify(block)


@app.route("/block/submit", methods=["POST"])
def submit_block():
    if request.content_length and request.content_length > 2_000_000:
        return jsonify({"error": "Block payload too large"}), 413
    block = request.get_json()
    if not isinstance(block, dict):
        return jsonify({"error": "Invalid JSON"}), 400
    ok, msg, is_new = blockchain.add_block(block, relay=True)
    code = 201 if ok and is_new else (200 if ok else 400)
    return jsonify({"message": msg} if ok else {"error": msg}), code


@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.route("/rpc", methods=["POST", "OPTIONS"])
@app.route("/", methods=["POST", "OPTIONS"])
def eth_rpc():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.content_length and request.content_length > 100_000:
        return jsonify({"jsonrpc": "2.0", "id": None,
                        "error": {"code": -32600, "message": "Request too large"}}), 413
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({"jsonrpc": "2.0", "id": None,
                        "error": {"code": -32700, "message": "Parse error"}}), 400
    body, status = ethcompat.handle_rpc_request(blockchain, payload)
    return jsonify(body), status


@app.route("/network", methods=["GET"])
def network_info():
    rpc_url = request.url_root.rstrip("/") + "/rpc"
    info = ethcompat.network_params(rpc_url)
    info["decimals_note"] = "MetaMask shows 18 decimals; Betium stores 8 (1 unit = 1e10 wei)."
    info["gas"] = {"gas_limit": 21000, "gas_price_wei": str(ETH_GAS_PRICE_WEI)}
    return jsonify(info)


@app.route("/", methods=["GET"])
def root_info():
    return jsonify({
        "name": "Betium", "symbol": NATIVE_TOKEN, "protocol_version": PROTOCOL_VERSION,
        "chain_id": ETH_CHAIN_ID, "rpc": "/rpc", "network": "/network", "status": "/chain/status",
    })


@app.errorhandler(404)
def json_404(_exc):
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(405)
def json_405(_exc):
    return jsonify({"error": "Method not allowed"}), 405


@app.errorhandler(500)
def json_500(_exc):
    return jsonify({"error": "Internal server error"}), 500


if __name__ == "__main__":
    my_url = sys.argv[1] if len(sys.argv) > 1 else None
    bootstrap = sys.argv[2] if len(sys.argv) > 2 else None
    if my_url:
        blockchain.start_network(my_url, bootstrap)
    print(f"[*] Betium node on 0.0.0.0:5000  protocol v{PROTOCOL_VERSION}")
    print(f"[*] Genesis {GENESIS_HASH}")
    if my_url:
        print(f"[*] Announced URL: {my_url}")
    app.run(host="0.0.0.0", port=5000)
