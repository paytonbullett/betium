"""Shared Betium consensus rules. Nodes, wallets, and miners must all use this file."""

import hashlib
import json
from decimal import Decimal

PROTOCOL_VERSION = 5
NATIVE_TOKEN = "BETM"
UNITS = 100_000_000
DECIMAL_PLACES = 8
ONE = Decimal("0.00000001")

MAX_SUPPLY = 2_000_000 * UNITS
# 0.0625 BETM × 240 blocks/hour (15 s target) = 15 BETM/hour.
BLOCK_REWARD = 6_250_000           # 0.0625 BETM
HALVING_INTERVAL = 100_000
# Hard ceiling: coinbase rewards in any rolling 3600 s window cannot exceed this,
# even if blocks arrive faster than the 15 s target.
MAX_EMISSION_PER_HOUR = 15 * UNITS  # 15 BETM
TRANSFER_FEE = 10_000              # 0.00010000 BETM
TOKEN_CREATE_FEE = 1 * UNITS
TOKEN_CREATE_FEE_CAP = 100 * UNITS
MIN_BALANCE_TO_CREATE = 10 * UNITS

# --- Token economics (off-chain reference / baseline) -----------------------
# Baseline valuation target: $0.00005 USD per 1 BETM (fully diluted ~$100 at max supply).
# Viable as a micro-cap launch price; actual market price is discovered off-chain.
BASELINE_USD_PER_BETM = Decimal("0.00005")
# Price growth is demand-driven under fixed emission + halvings. Optional on-chain
# signals (active accounts, circulating supply) can feed an external oracle or
# bonding-curve UI; consensus itself does not embed a price.
# The Graph / subgraph indexing is supported via the Ethereum JSON-RPC surface
# (eth_blockNumber, eth_getBalance, eth_getTransactionReceipt, etc.). Build a
# subgraph against the /rpc endpoint once explorers emit standard logs.
# Emission is hard-capped at MAX_EMISSION_PER_HOUR regardless of hashrate spikes.

# --- Ethereum / MetaMask compatibility -------------------------------------
# MetaMask requires 18 decimals; Betium keeps 8 internally (1 unit = 10**10 wei).
ETH_CHAIN_ID = 947263              # change only before launch; check chainlist.org for clashes
WEI_PER_UNIT = 10 ** 10
ETH_TRANSFER_GAS = 21_000          # the only gas limit accepted for BETM transfers
ETH_GAS_PRICE_WEI = 5_000_000_000  # 5 gwei -> fee 0.000105 BETM (>= TRANSFER_FEE)

INITIAL_DIFFICULTY = 3
MIN_DIFFICULTY = 2
MAX_DIFFICULTY = 32
BLOCK_TIME_TARGET = 15             # faster confirmations; transfers no longer need hours
RETARGET_WINDOW = 10

# --- Difficulty rules v2 ------------------------------------------------------
# Blocks below DIFFICULTY_FORK_HEIGHT keep the original rule: "difficulty" is a
# count of leading zero HEX digits (each step is 16x harder).
# From DIFFICULTY_FORK_HEIGHT on, "difficulty" is a count of leading zero BITS
# (each step is 2x harder) and is retargeted from the work actually done in the
# last RETARGET_WINDOW blocks, so it follows the real hash rate.
DIFFICULTY_FORK_HEIGHT = 41
RETARGET_MAX_STEP_BITS = 2         # at most 4x change per block
MIN_DIFFICULTY_BITS = 8            # ~256 hashes average; nodes can auto-mine pending txs
MAX_DIFFICULTY_BITS = 128

GENESIS_TIMESTAMP = 1735689600
GENESIS_PREV_HASH = "0" * 64
GENESIS_NONCE = 141371
EMPTY_MERKLE = hashlib.sha256(b"").hexdigest()


def dumps(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def units_to_str(units):
    sign = "-" if int(units) < 0 else ""
    units = abs(int(units))
    whole, frac = divmod(units, UNITS)
    return f"{sign}{whole}.{frac:08d}"


def parse_units(value):
    """Accept an integer number of units, or a decimal string with at most 8 places."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return None
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("+"):
            text = text[1:]
        if text.lstrip("-").isdigit():
            return int(text)
        try:
            raw = Decimal(text)
        except Exception:
            return None
        if not raw.is_finite():
            return None
        quantized = raw.quantize(ONE)
        if quantized != raw:
            return None
        return int(quantized * UNITS)
    return None


def merkle_root(transactions):
    if not transactions:
        return EMPTY_MERKLE
    layer = [hashlib.sha256(dumps(canonical_tx(tx)).encode()).hexdigest() for tx in transactions]
    while len(layer) > 1:
        if len(layer) % 2 == 1:
            layer.append(layer[-1])
        layer = [
            hashlib.sha256((layer[i] + layer[i + 1]).encode()).hexdigest()
            for i in range(0, len(layer), 2)
        ]
    return layer[0]


def canonical_tx(tx):
    """Fields covered by the signature. Amounts are integer units."""
    if tx.get("eth_raw"):
        # MetaMask transactions are fully described by the signed raw transaction.
        return {"eth_raw": tx["eth_raw"]}
    amount = parse_units(tx.get("amount"))
    fee = parse_units(tx.get("fee")) if "fee" in tx else 0
    body = {
        "sender": tx.get("sender"),
        "recipient": tx.get("recipient"),
        "amount": amount,
        "fee": fee,
        "nonce": tx.get("nonce"),
    }
    if tx.get("action"):
        body["action"] = tx.get("action")
    token_id = tx.get("token_id")
    if token_id and token_id != NATIVE_TOKEN:
        body["token_id"] = token_id
    if tx.get("action") == "create_token":
        body["token_id"] = tx.get("token_id")
        body["token_name"] = tx.get("token_name")
        body["token_symbol"] = tx.get("token_symbol")
        body["initial_supply"] = parse_units(tx.get("initial_supply"))
    return body


def block_header(block):
    return {
        "index": block["index"],
        "timestamp": block["timestamp"],
        "transactions": block["transactions"],
        "previous_hash": block["previous_hash"],
        "nonce": block["nonce"],
        "difficulty": block["difficulty"],
        "protocol_version": block["protocol_version"],
        "merkle_root": block["merkle_root"],
    }


def block_hash(block):
    return hashlib.sha256(dumps(block_header(block)).encode()).hexdigest()


def difficulty_bits(difficulty, index):
    """Leading zero bits required, under the rule that applies at this height."""
    difficulty = int(difficulty)
    return difficulty * 4 if index < DIFFICULTY_FORK_HEIGHT else difficulty


def work_of(difficulty, index):
    return 1 << difficulty_bits(difficulty, index)


def meets_target(hash_hex, difficulty, index):
    bits = difficulty_bits(difficulty, index)
    if bits < 0 or bits > 256:
        return False
    return int(hash_hex, 16) >> (256 - bits) == 0


def genesis_block():
    # Genesis difficulty is frozen at the historical value (4) so the precomputed
    # GENESIS_NONCE and GENESIS_HASH remain valid across difficulty-parameter updates.
    block = {
        "index": 0,
        "timestamp": GENESIS_TIMESTAMP,
        "transactions": [],
        "previous_hash": GENESIS_PREV_HASH,
        "nonce": GENESIS_NONCE,
        "difficulty": 4,
        "protocol_version": 4,  # frozen; later blocks use PROTOCOL_VERSION
        "merkle_root": EMPTY_MERKLE,
    }
    block["hash"] = block_hash(block)
    return block


GENESIS = genesis_block()
GENESIS_HASH = GENESIS["hash"]
