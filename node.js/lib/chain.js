'use strict';
/**
 * Betium blockchain engine: storage, validation, mempool, fork choice, peer sync.
 * Port of the Blockchain class in node.py. SQLite schema, block/transaction wire
 * formats, hashing and difficulty rules are identical to the Python node, so an
 * existing betium_chain.db / peers.json can be reused unchanged.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const C = require('../consensus');
const eth = require('../ethcompat');
const secp = require('./secp');
const { Db } = require('./db');
const { fetchJson, postJson } = require('./http');

const {
  BLOCK_REWARD, BLOCK_TIME_TARGET, ETH_CHAIN_ID, GENESIS, GENESIS_HASH, HALVING_INTERVAL,
  INITIAL_DIFFICULTY, MAX_DIFFICULTY, MAX_EMISSION_PER_HOUR, MAX_SUPPLY, MIN_BALANCE_TO_CREATE,
  MIN_DIFFICULTY, NATIVE_TOKEN, PROTOCOL_VERSION, RETARGET_WINDOW, TOKEN_CREATE_FEE,
  TOKEN_CREATE_FEE_CAP, TRANSFER_FEE, UNITS, blockHash, canonicalTx, dumps, merkleRoot,
  parseUnits, unitsToStr, workOf, difficultyBits, meetsTarget, bitLength, DIFFICULTY_FORK_HEIGHT,
  MAX_DIFFICULTY_BITS, MIN_DIFFICULTY_BITS, RETARGET_MAX_STEP_BITS,
} = C;

const MAX_MEMPOOL_SIZE = 5000;
const MAX_PEERS = 2000;
const MAX_ORPHANS = 50;
const ETH_TX_KEYS = new Set(['sender', 'recipient', 'amount', 'fee', 'nonce', 'eth_raw', 'token_id', 'contract']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const info = (...args) => { if (process.env.BETIUM_VERBOSE) console.log(...args); };

// ---------------------------------------------------------------- helpers

/** (address, token_id) -> balance map used while validating a batch of transactions. */
class TokenBalances {
  constructor() { this.m = new Map(); }

  static key(addr, tid) { return `${addr}\u0000${tid}`; }

  get(addr, tid) {
    const e = this.m.get(TokenBalances.key(addr, tid));
    return e ? e.bal : undefined;
  }

  set(addr, tid, bal) { this.m.set(TokenBalances.key(addr, tid), { addr, tid, bal }); }

  entries() { return [...this.m.values()]; }
}

function cleanPeerUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const m = /^\s*(https?):\/\/([^/?#\s]+)/i.exec(urlStr);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const netloc = m[2];
  let host = netloc.slice(netloc.lastIndexOf('@') + 1);
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.split(':')[0];
  host = host.toLowerCase();
  const blocked = host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '::'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^(fc|fd|fe80)/.test(host);
  if (blocked) return null;
  return `${scheme}://${netloc}`;
}

function hasLeadingZeroBits(digest, bits) {
  if (bits > 256) return false;
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (digest[i] !== 0) return false;
  const rem = bits & 7;
  return rem === 0 || (digest[full] >> (8 - rem)) === 0;
}

// -------------------------------------------------------------- Blockchain

class Blockchain {
  constructor(opts = {}) {
    this.dbFile = opts.dbFile || 'betium_chain.db';
    this.peerFile = opts.peerFile || 'peers.json';
    this.pendingTransactions = [];
    this.orphans = new Map();
    this.peers = this.loadPeers();
    this.myNodeUrl = null;
    this.syncing = new Set();
    this.inTx = false;
    this.db = new Db(this.dbFile);
    this.initDb();
  }

  // ---- transactions (SQLite) -------------------------------------------

  begin() {
    this.db.exec('BEGIN EXCLUSIVE');
    this.inTx = true;
  }

  commit() {
    this.db.exec('COMMIT');
    this.inTx = false;
  }

  rollback() {
    if (!this.inTx) return;
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // nothing to roll back
    }
    this.inTx = false;
  }

  /** Run fn inside a transaction that is always discarded (validation scratch space). */
  scratch(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN');
    this.inTx = true;
    try {
      return fn();
    } finally {
      this.rollback();
    }
  }

  // ---- peers cache ------------------------------------------------------

  loadPeers() {
    try {
      if (fs.existsSync(this.peerFile)) {
        const data = JSON.parse(fs.readFileSync(this.peerFile, 'utf8'));
        if (Array.isArray(data)) return new Set(data);
      }
    } catch {
      // fall through
    }
    return new Set();
  }

  savePeers() {
    try {
      const tmp = `${this.peerFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.peers].sort()));
      fs.renameSync(tmp, this.peerFile);
    } catch {
      // best effort
    }
  }

  // ---- schema -----------------------------------------------------------

  initDb() {
    const db = this.db;
    db.exec(`CREATE TABLE IF NOT EXISTS blocks (
      idx INTEGER PRIMARY KEY, timestamp INTEGER, transactions TEXT, previous_hash TEXT,
      nonce INTEGER, difficulty INTEGER, protocol_version INTEGER, merkle_root TEXT, hash TEXT UNIQUE)`);
    db.exec('CREATE TABLE IF NOT EXISTS accounts (address TEXT PRIMARY KEY, balance INTEGER, nonce INTEGER)');
    db.exec(`CREATE TABLE IF NOT EXISTS tokens (
      token_id TEXT PRIMARY KEY, name TEXT, symbol TEXT, creator TEXT, total_supply INTEGER, created_at INTEGER)`);
    db.exec(`CREATE TABLE IF NOT EXISTS token_balances (
      address TEXT NOT NULL, token_id TEXT NOT NULL, balance INTEGER NOT NULL, PRIMARY KEY (address, token_id))`);
    db.exec('CREATE TABLE IF NOT EXISTS eth_txs (hash TEXT PRIMARY KEY, block_idx INTEGER NOT NULL, tx_idx INTEGER NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS eth_txs_block ON eth_txs (block_idx)');
    // Links a native 64-char Betium address with its 0x MetaMask counterpart derived from the same key.
    db.exec('CREATE TABLE IF NOT EXISTS address_map (native TEXT PRIMARY KEY, eth TEXT NOT NULL UNIQUE)');
    db.exec('CREATE INDEX IF NOT EXISTS address_map_eth ON address_map (eth)');
    // Deterministic contract addresses for custom tokens so MetaMask can treat them as ERC-20.
    db.exec('CREATE TABLE IF NOT EXISTS token_contracts (token_id TEXT PRIMARY KEY, contract_address TEXT NOT NULL UNIQUE)');
    db.exec('CREATE INDEX IF NOT EXISTS token_contracts_addr ON token_contracts (contract_address)');
    this.begin();
    try {
      this.ensureTokenContracts();
      const genesis = this.getBlockByIndex(0);
      if (genesis === null) {
        this.insertBlockRow(GENESIS);
      } else if (genesis.hash !== GENESIS_HASH) {
        this.rollback();
        throw new Error(
          `This database is not the Betium chain (genesis ${genesis.hash}, expected ${GENESIS_HASH}). `
          + `Remove ${this.dbFile} and start again.`,
        );
      }
      this.commit();
    } catch (e) {
      this.rollback();
      throw e;
    }
  }

  insertBlockRow(block) {
    this.db.run(
      `INSERT INTO blocks (idx, timestamp, transactions, previous_hash, nonce, difficulty,
                           protocol_version, merkle_root, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      block.index, Math.trunc(Number(block.timestamp)), dumps(block.transactions),
      block.previous_hash, block.nonce, block.difficulty, block.protocol_version,
      block.merkle_root, block.hash,
    );
    let position = 0;
    for (const tx of block.transactions) {
      if (tx && typeof tx === 'object' && tx.eth_raw) {
        let digest;
        try {
          digest = eth.decodeRawTx(tx.eth_raw).hash;
        } catch (e) {
          if (e instanceof eth.EthTxError) continue;
          throw e;
        }
        this.db.run('INSERT OR REPLACE INTO eth_txs (hash, block_idx, tx_idx) VALUES (?, ?, ?)', digest, block.index, position);
        position += 1;
      }
    }
  }

  pruneBlocks(afterIndex) {
    this.db.run('DELETE FROM blocks WHERE idx > ?', afterIndex);
    this.db.run('DELETE FROM eth_txs WHERE block_idx > ?', afterIndex);
  }

  findEthTx(txHash) {
    if (typeof txHash !== 'string') return null;
    const row = this.db.get('SELECT block_idx, tx_idx FROM eth_txs WHERE hash = ?', txHash.toLowerCase());
    if (!row) return null;
    const block = this.getBlockByIndex(row.block_idx);
    if (!block) return null;
    const pairs = eth.ethTxsOf(block);
    if (row.tx_idx >= pairs.length) return null;
    const [tx, decoded] = pairs[row.tx_idx];
    return { tx, decoded, block, index: row.tx_idx };
  }

  // ---- block access -----------------------------------------------------

  rowToBlock(row) {
    if (!row) return null;
    return {
      index: row.idx,
      timestamp: row.timestamp,
      transactions: JSON.parse(row.transactions),
      previous_hash: row.previous_hash,
      nonce: row.nonce,
      difficulty: row.difficulty,
      protocol_version: row.protocol_version,
      merkle_root: row.merkle_root,
      hash: row.hash,
    };
  }

  getBlockByIndex(idx) {
    return this.rowToBlock(this.db.get(
      `SELECT idx, timestamp, transactions, previous_hash, nonce, difficulty,
              protocol_version, merkle_root, hash FROM blocks WHERE idx = ?`,
      idx,
    ));
  }

  getBlockByHash(hashHex) {
    const row = this.db.get('SELECT idx FROM blocks WHERE hash = ?', hashHex);
    return row ? this.getBlockByIndex(row.idx) : null;
  }

  getLatestBlock() {
    const row = this.db.get('SELECT idx FROM blocks ORDER BY idx DESC LIMIT 1');
    return row ? this.getBlockByIndex(row.idx) : null;
  }

  getChainLength() {
    const latest = this.getLatestBlock();
    return latest === null ? 0 : latest.index + 1;
  }

  chainWork() {
    let total = 0n;
    for (const r of this.db.all('SELECT idx, difficulty FROM blocks')) total += workOf(r.difficulty, r.idx);
    return total;
  }

  // ---- accounts / linked addresses --------------------------------------

  /** Addresses that share the same key (native + 0x). */
  resolveLinkedAddresses(address) {
    const addrs = new Set([address]);
    const row = this.db.get('SELECT native, eth FROM address_map WHERE native = ? OR eth = ?', address, address);
    if (row) {
      addrs.add(row.native);
      addrs.add(row.eth);
    }
    return addrs;
  }

  /** Register native <-> 0x mapping and migrate existing balances so both show the same total. */
  registerAddressLink(native, ethAddr) {
    if (!native || !ethAddr || native === ethAddr) return;
    const existing = this.db.get('SELECT 1 AS x FROM address_map WHERE native = ? OR eth = ?', native, ethAddr);
    try {
      this.db.run('INSERT OR IGNORE INTO address_map (native, eth) VALUES (?, ?)', native, ethAddr);
    } catch {
      return;
    }
    if (existing) return;
    const rows = this.db.all('SELECT address, balance, nonce FROM accounts WHERE address IN (?, ?)', native, ethAddr);
    let totalBal = 0;
    let maxNonce = 0;
    for (const r of rows) {
      totalBal += Number(r.balance || 0);
      maxNonce = Math.max(maxNonce, Number(r.nonce || 0));
    }
    if (totalBal === 0 && maxNonce === 0) return;
    // Primary = eth (0x); alias = native
    this.db.run('INSERT OR REPLACE INTO accounts (address, balance, nonce) VALUES (?, ?, ?)', ethAddr, totalBal, maxNonce);
    this.db.run('INSERT OR REPLACE INTO accounts (address, balance, nonce) VALUES (?, ?, ?)', native, 0, maxNonce);
    const trows = this.db.all('SELECT token_id, address, balance FROM token_balances WHERE address IN (?, ?)', native, ethAddr);
    const byTid = new Map();
    for (const r of trows) byTid.set(r.token_id, (byTid.get(r.token_id) || 0) + Number(r.balance || 0));
    for (const [tid, total] of byTid) {
      this.db.run('INSERT OR REPLACE INTO token_balances (address, token_id, balance) VALUES (?, ?, ?)', ethAddr, tid, total);
      this.db.run('INSERT OR REPLACE INTO token_balances (address, token_id, balance) VALUES (?, ?, ?)', native, tid, 0);
    }
  }

  /** Balance and nonce are synchronized across linked native / 0x addresses. */
  getAccount(address) {
    let bal = 0;
    let nonce = 0;
    for (const addr of this.resolveLinkedAddresses(address)) {
      const row = this.db.get('SELECT balance, nonce FROM accounts WHERE address = ?', addr);
      if (row) {
        bal += Number(row.balance);
        nonce = Math.max(nonce, Number(row.nonce));
      }
    }
    return { balance: bal, nonce };
  }

  /** Net BETM change from mempool txs that touch this address (0-conf view). */
  getPendingBalanceDelta(address) {
    const linked = this.resolveLinkedAddresses(address);
    let delta = 0;
    for (const tx of [...this.pendingTransactions]) {
      const amount = Number(parseUnits(tx.amount) || 0);
      const fee = Number(parseUnits(tx.fee) || 0);
      const tid = tx.token_id;
      const isNative = tid === undefined || tid === null || tid === NATIVE_TOKEN || (tx.eth_raw && !tid);
      if (linked.has(tx.sender)) delta -= isNative ? amount + fee : fee;
      if (linked.has(tx.recipient) && isNative) delta += amount;
    }
    return delta;
  }

  /** Confirmed balance adjusted by mempool effects (0-conf). */
  getAccountPending(address) {
    const acc = this.getAccount(address);
    return { balance: Math.max(0, acc.balance + this.getPendingBalanceDelta(address)), nonce: acc.nonce };
  }

  getTokenBalance(address, tokenId) {
    if (tokenId === NATIVE_TOKEN) return this.getAccount(address).balance;
    let bal = 0;
    for (const addr of this.resolveLinkedAddresses(address)) {
      const row = this.db.get('SELECT balance FROM token_balances WHERE address = ? AND token_id = ?', addr, tokenId);
      if (row) bal += Number(row.balance);
    }
    return bal;
  }

  tokenExists(tokenId) {
    if (tokenId === NATIVE_TOKEN) return true;
    return this.db.get('SELECT 1 AS x FROM tokens WHERE token_id = ?', tokenId) !== undefined;
  }

  // ---- token contracts (ERC-20 view) ------------------------------------

  tokenContractAddress(tokenId) {
    const h = eth.keccak256(Buffer.concat([Buffer.from('BetiumToken\0'), Buffer.from(tokenId, 'utf8')]));
    return '0x' + h.toString('hex').slice(0, 40);
  }

  registerTokenContract(tokenId) {
    if (this.db.get('SELECT 1 AS x FROM token_contracts WHERE token_id = ?', tokenId)) return;
    let addr = this.tokenContractAddress(tokenId);
    let attempt = 0;
    while (this.db.get('SELECT 1 AS x FROM token_contracts WHERE contract_address = ?', addr)) {
      attempt += 1;
      addr = this.tokenContractAddress(`${tokenId}:${attempt}`);
    }
    this.db.run('INSERT INTO token_contracts (token_id, contract_address) VALUES (?, ?)', tokenId, addr);
  }

  /** Additive only: never deletes rows or tokens. */
  ensureTokenContracts() {
    for (const r of this.db.all('SELECT token_id FROM tokens')) this.registerTokenContract(r.token_id);
  }

  getTokenIdByContract(contractAddress) {
    if (!contractAddress || typeof contractAddress !== 'string') return null;
    let addr = contractAddress.toLowerCase();
    if (!addr.startsWith('0x')) addr = `0x${addr}`;
    const row = this.db.get('SELECT token_id FROM token_contracts WHERE contract_address = ?', addr);
    return row ? row.token_id : null;
  }

  // ---- fees / supply / reward -------------------------------------------

  tokenCreateFee() {
    const accounts = Number(this.db.get('SELECT COUNT(*) AS n FROM accounts').n || 0);
    const tokens = Number(this.db.get('SELECT COUNT(*) AS n FROM tokens').n || 0);
    const fee = TOKEN_CREATE_FEE + Math.floor(accounts / 10000) * UNITS + Math.floor(tokens / 100) * Math.floor(UNITS / 2);
    return Math.min(fee, TOKEN_CREATE_FEE_CAP);
  }

  minBalanceToCreate() {
    return Math.max(MIN_BALANCE_TO_CREATE, this.tokenCreateFee());
  }

  getTotalSupply() {
    const row = this.db.get('SELECT SUM(balance) AS total FROM accounts');
    return Number(row.total || 0);
  }

  /** Coinbase for this height, respecting the supply cap and the 15 BETM/hour emission ceiling. */
  getBlockReward(height) {
    const supply = this.getTotalSupply();
    if (supply >= MAX_SUPPLY) return 0;
    const halvings = Math.floor(height / HALVING_INTERVAL);
    let reward = halvings < 63 ? Number(BigInt(BLOCK_REWARD) >> BigInt(halvings)) : 0;
    if (supply + reward > MAX_SUPPLY) reward = MAX_SUPPLY - supply;
    if (reward <= 0) return 0;
    const tip = this.getLatestBlock();
    if (tip && tip.index > 0) {
      const cutoff = Number(tip.timestamp) - 3600;
      const rows = this.db.all('SELECT transactions FROM blocks WHERE idx > 0 AND timestamp >= ?', cutoff);
      let emitted = 0;
      for (const r of rows) {
        for (const tx of JSON.parse(r.transactions)) {
          if (tx.sender === 'NETWORK') emitted += Number(parseUnits(tx.amount) || 0);
        }
      }
      const remaining = MAX_EMISSION_PER_HOUR - emitted;
      if (remaining <= 0) return 0;
      if (reward > remaining) reward = remaining;
    }
    return reward;
  }

  tokenRow(r) {
    return {
      token_id: r.token_id,
      name: r.name,
      symbol: r.symbol,
      creator: r.creator,
      total_supply: unitsToStr(r.total_supply),
      total_supply_units: r.total_supply,
      created_at: r.created_at,
      contract_address: r.contract_address,
    };
  }

  listTokens() {
    return this.db.all(
      `SELECT t.token_id, t.name, t.symbol, t.creator, t.total_supply, t.created_at, c.contract_address
       FROM tokens t LEFT JOIN token_contracts c ON t.token_id = c.token_id ORDER BY t.created_at`,
    ).map((r) => this.tokenRow(r));
  }

  getTokenInfo(tokenId) {
    const row = this.db.get(
      `SELECT t.token_id, t.name, t.symbol, t.creator, t.total_supply, t.created_at, c.contract_address
       FROM tokens t LEFT JOIN token_contracts c ON t.token_id = c.token_id WHERE t.token_id = ?`,
      tokenId,
    );
    return row ? this.tokenRow(row) : null;
  }

  // ---- difficulty -------------------------------------------------------

  expectedDifficulty(height) {
    if (height < DIFFICULTY_FORK_HEIGHT) return this.legacyExpectedDifficulty(height);
    const window = Math.min(RETARGET_WINDOW, height);
    const first = this.getBlockByIndex(height - window);
    const last = this.getBlockByIndex(height - 1);
    const rows = this.db.all('SELECT idx, difficulty FROM blocks WHERE idx > ? AND idx < ?', height - window, height);
    if (!first || !last || rows.length === 0) return INITIAL_DIFFICULTY * 4;
    const actual = Math.max(1, Number(last.timestamp) - Number(first.timestamp));
    let work = 0n;
    for (const r of rows) work += workOf(r.difficulty, r.idx);
    let wanted = (work * BigInt(BLOCK_TIME_TARGET)) / BigInt(actual);
    if (wanted < 1n) wanted = 1n;
    let bits = bitLength(wanted) - 1;
    if (wanted * wanted >= (1n << BigInt(2 * bits + 1))) bits += 1; // round to nearest power of two
    const prev = difficultyBits(last.difficulty, last.index);
    bits = Math.max(prev - RETARGET_MAX_STEP_BITS, Math.min(prev + RETARGET_MAX_STEP_BITS, bits));
    return Math.max(MIN_DIFFICULTY_BITS, Math.min(MAX_DIFFICULTY_BITS, bits));
  }

  legacyExpectedDifficulty(height) {
    if (height <= 1) return INITIAL_DIFFICULTY;
    const window = Math.min(RETARGET_WINDOW, height);
    const first = this.getBlockByIndex(height - window);
    const last = this.getBlockByIndex(height - 1);
    if (!first || !last) return INITIAL_DIFFICULTY;
    let actual = Number(last.timestamp) - Number(first.timestamp);
    const span = Math.max(1, last.index - first.index);
    if (actual <= 0) actual = 1;
    const ratio = (BLOCK_TIME_TARGET * span) / actual;
    const current = Number(last.difficulty);
    let step = 0;
    if (ratio >= 2) step = 1;
    else if (ratio <= 0.5) step = -1;
    return Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, current + step));
  }

  medianTimePast(height) {
    const stamps = [];
    for (let idx = Math.max(0, height - 11); idx < height; idx++) {
      const block = this.getBlockByIndex(idx);
      if (block) stamps.push(Number(block.timestamp));
    }
    if (stamps.length === 0) return 0;
    stamps.sort((a, b) => a - b);
    return stamps[Math.floor(stamps.length / 2)];
  }

  addressFromPubkey(publicKeyHex) {
    try {
      return crypto.createHash('sha256').update(secp.strictHex(publicKeyHex)).digest('hex');
    } catch {
      return null;
    }
  }

  // ---- transaction validation -------------------------------------------

  /** Returns [ok, message]. Mutates the temp_* maps so a batch is validated in order. */
  validateTransaction(tx, tempBalances, tempNonces, tempTB, tempTokens, feeAcc) {
    const sender = tx.sender;
    if (sender === 'NETWORK') return [false, 'Network rewards cannot be submitted by clients'];
    if (tx.eth_raw !== undefined && tx.eth_raw !== null) {
      return this.validateEthTransaction(tx, tempBalances, tempNonces, feeAcc, tempTB, tempTokens);
    }
    const amount = parseUnits(tx.amount);
    const fee = 'fee' in tx ? parseUnits(tx.fee) : null;
    if (amount === null || amount < 0) {
      return [false, 'Amount must be an integer number of units (8 decimals) and cannot be negative'];
    }
    if (fee === null || fee < 0) return [false, 'Fee must be an integer number of units'];
    const action = tx.action;
    const tokenId = 'token_id' in tx ? tx.token_id : NATIVE_TOKEN;
    const expectedFee = action === 'create_token' ? this.tokenCreateFee() : TRANSFER_FEE;
    // Fee >= TRANSFER_FEE is allowed for normal transfers (RBF / cancel use higher fees).
    if (action === 'create_token') {
      if (fee !== expectedFee) return [false, `Fee must be exactly ${unitsToStr(expectedFee)} ${NATIVE_TOKEN}`];
    } else if (fee < TRANSFER_FEE) {
      return [false, `Fee must be at least ${unitsToStr(TRANSFER_FEE)} ${NATIVE_TOKEN}`];
    }

    let initial = null;
    if (action === 'create_token') {
      initial = parseUnits(tx.initial_supply);
      if (initial === null || initial <= 0) return [false, 'initial_supply must be a positive integer number of units'];
    }

    try {
      const pubKeyHex = tx.public_key;
      if (!pubKeyHex) return [false, 'Missing public_key'];
      secp.strictHex(pubKeyHex, 'public_key');
      const point = secp.parsePublicKey(pubKeyHex); // must be a valid point on secp256k1
      const derived = this.addressFromPubkey(pubKeyHex);
      const ethAddr = eth.pubkeyToAddress(Buffer.concat([secp.bigToBuf32(point.x), secp.bigToBuf32(point.y)]));
      // SECURITY: the sender must be one of the two addresses derived from the signing key.
      // (The Python version let ANY 0x sender through here, which allowed spending other
      // people's 0x balances with a signature from an unrelated key.)
      const senderMatches = eth.isHexAddress(sender) ? sender === ethAddr : sender === derived;
      if (!senderMatches) return [false, 'Public key does not match sender address'];
      // Link native and 0x forms of the same key so balances stay in sync.
      try {
        if (derived && ethAddr) this.registerAddressLink(derived, ethAddr);
      } catch {
        // linking is best effort
      }
      const signed = Buffer.from(dumps(canonicalTx(tx)));
      if (!secp.verifyNative(pubKeyHex, signed, tx.signature)) return [false, 'Bad signature'];
    } catch (exc) {
      return [false, `Malformed signature: ${exc.message}`];
    }

    const acc = this.getAccount(sender);
    const prevNonce = tempNonces.has(sender) ? tempNonces.get(sender) : acc.nonce;
    const expectedNonce = prevNonce + 1;
    if (tx.nonce !== expectedNonce) return [false, `Bad nonce, expected ${expectedNonce}`];

    const curr = tempBalances.has(sender) ? tempBalances.get(sender) : acc.balance;
    if (action === 'create_token') {
      const tid = tx.token_id;
      const name = tx.token_name;
      const symbol = tx.token_symbol;
      if (typeof tid !== 'string' || !([...tid].length >= 3 && [...tid].length <= 32)) return [false, 'token_id must be 3-32 characters'];
      if (!/^[\p{L}\p{N}_-]+$/u.test(tid)) return [false, 'token_id has illegal characters'];
      if (tid.toUpperCase() === NATIVE_TOKEN) return [false, 'BETM is reserved'];
      if (this.tokenExists(tid) || tempTokens.has(tid)) return [false, 'Token id already exists'];
      if (!name || !symbol) return [false, 'Token name and symbol are required'];
      const needed = Math.max(MIN_BALANCE_TO_CREATE, expectedFee);
      if (curr < needed) return [false, `Need at least ${unitsToStr(needed)} BETM before creating a token`];
      tempBalances.set(sender, curr - fee);
      tempTB.set(sender, tid, (tempTB.get(sender, tid) || 0) + initial);
      tempTokens.add(tid);
      tempNonces.set(sender, tx.nonce);
      feeAcc.total = (feeAcc.total || 0) + fee;
      return [true, 'Valid create_token'];
    }

    // A zero-amount self-transfer is allowed as an RBF cancel; any other non-positive amount is rejected.
    const isCancel = amount === 0 && tx.recipient === sender;
    if (amount < 0 || (amount === 0 && !isCancel)) {
      return [false, 'Transfer amount must be positive (or 0 for a cancel self-transfer)'];
    }
    const recipient = tx.recipient;
    if (tokenId === NATIVE_TOKEN) {
      if (curr < amount + fee) return [false, 'Insufficient BETM for amount plus fee'];
      tempBalances.set(sender, curr - amount - fee);
      const base = tempBalances.has(recipient) ? tempBalances.get(recipient) : this.getAccount(recipient).balance;
      tempBalances.set(recipient, base + amount);
    } else {
      if (curr < fee) return [false, 'Insufficient BETM to pay the transfer fee'];
      tempBalances.set(sender, curr - fee);
      if (!this.tokenExists(tokenId) && !tempTokens.has(tokenId)) return [false, 'Unknown token'];
      const have = tempTB.get(sender, tokenId) !== undefined ? tempTB.get(sender, tokenId) : this.getTokenBalance(sender, tokenId);
      if (have < amount) return [false, 'Insufficient token balance'];
      tempTB.set(sender, tokenId, have - amount);
      const rbase = tempTB.get(recipient, tokenId) !== undefined ? tempTB.get(recipient, tokenId) : this.getTokenBalance(recipient, tokenId);
      tempTB.set(recipient, tokenId, rbase + amount);
    }
    tempNonces.set(sender, tx.nonce);
    feeAcc.total = (feeAcc.total || 0) + fee;
    return [true, 'Valid'];
  }

  /**
   * A MetaMask transaction: everything is derived from the signed raw bytes. Supports plain
   * BETM value transfers and ERC-20 transfer() to custom-token contracts.
   */
  validateEthTransaction(tx, tempBalances, tempNonces, feeAcc, tempTB, tempTokens) {
    if (!Object.keys(tx).every((k) => ETH_TX_KEYS.has(k))) return [false, 'Unexpected fields in Ethereum transaction'];
    let expected;
    let decoded;
    try {
      [expected, decoded] = eth.buildInternalTx(tx.eth_raw);
    } catch (exc) {
      if (exc instanceof eth.EthTxError) return [false, exc.message];
      throw exc;
    }
    for (const key of ['sender', 'recipient', 'amount', 'fee', 'nonce', 'eth_raw']) {
      if (tx[key] !== expected[key]) return [false, `Field '${key}' does not match the signed transaction`];
    }
    const { sender, recipient, amount, fee } = expected;
    let tokenId = null;
    if ('contract' in expected) {
      // Custom token transfer via ERC-20 transfer()
      tokenId = this.getTokenIdByContract(expected.contract);
      if (!tokenId) return [false, `Unknown token contract ${expected.contract}`];
      if (tx.token_id !== undefined && tx.token_id !== null && tx.token_id !== tokenId) {
        return [false, 'token_id does not match the contract in the signed transaction'];
      }
      expected.token_id = tokenId;
      if (!('token_id' in tx)) tx.token_id = tokenId;
    }
    // Register native <-> 0x link from the recovered public key so balances stay synchronized.
    try {
      this.registerAddressLink(crypto.createHash('sha256').update(decoded.pub).digest('hex'), sender);
    } catch {
      // linking is best effort
    }
    const acc = this.getAccount(sender);
    const expectedNonce = (tempNonces.has(sender) ? tempNonces.get(sender) : acc.nonce) + 1;
    if (expected.nonce !== expectedNonce) return [false, `Bad nonce, expected ${expectedNonce - 1}`];
    const curr = tempBalances.has(sender) ? tempBalances.get(sender) : acc.balance;
    if (tokenId === null) {
      if (curr < amount + fee) return [false, 'Insufficient BETM for amount plus fee'];
      tempBalances.set(sender, curr - amount - fee);
      const base = tempBalances.has(recipient) ? tempBalances.get(recipient) : this.getAccount(recipient).balance;
      tempBalances.set(recipient, base + amount);
    } else {
      if (curr < fee) return [false, 'Insufficient BETM to pay the transfer fee'];
      tempBalances.set(sender, curr - fee);
      const have = tempTB.get(sender, tokenId) !== undefined ? tempTB.get(sender, tokenId) : this.getTokenBalance(sender, tokenId);
      if (have < amount) return [false, `Insufficient ${tokenId} balance`];
      tempTB.set(sender, tokenId, have - amount);
      const rbase = tempTB.get(recipient, tokenId) !== undefined ? tempTB.get(recipient, tokenId) : this.getTokenBalance(recipient, tokenId);
      tempTB.set(recipient, tokenId, rbase + amount);
    }
    tempNonces.set(sender, expected.nonce);
    feeAcc.total = (feeAcc.total || 0) + fee;
    return [true, 'Valid'];
  }

  newTempState() {
    return {
      balances: new Map(), nonces: new Map(), tb: new TokenBalances(), tokens: new Set(), fee: { total: 0 },
    };
  }

  /** Mempool transactions that still apply in order. Drops stale or conflicting ones. */
  validPending(onlySender = null) {
    const st = this.newTempState();
    const good = [];
    for (const tx of [...this.pendingTransactions]) {
      if (onlySender !== null && tx.sender !== onlySender) continue;
      const [ok] = this.validateTransaction(tx, st.balances, st.nonces, st.tb, st.tokens, st.fee);
      if (ok) good.push(tx);
    }
    return { good, state: st };
  }

  txFee(tx) { return Number(parseUnits(tx.fee) || 0); }

  txNonce(tx) { return Number(tx.nonce || 0); }

  /**
   * Validate a client transaction against the mempool and queue it. Supports replace-by-fee:
   * same sender + nonce with a strictly higher fee (or a zero-value self-transfer cancel).
   * Returns [ok, message, httpStatus].
   */
  submitTransaction(tx) {
    if (this.pendingTransactions.length >= MAX_MEMPOOL_SIZE) return [false, 'Mempool is full', 503];
    const recipient = tx.recipient;
    if (!eth.validAccountId(recipient)) {
      return [false, 'Recipient must be a 64-character Betium address or a 0x Ethereum address (lowercase)', 400];
    }
    let fingerprint;
    try {
      fingerprint = dumps(canonicalTx(tx));
    } catch (e) {
      return [false, `Invalid transaction: ${e.message}`, 400];
    }
    if (this.pendingTransactions.some((existing) => dumps(canonicalTx(existing)) === fingerprint)) {
      return [true, 'Already in mempool', 200];
    }

    const sender = tx.sender;
    const nonce = this.txNonce(tx);
    const newFee = this.txFee(tx);

    let replaced = false;
    for (let i = 0; i < this.pendingTransactions.length; i++) {
      const existing = this.pendingTransactions[i];
      if (existing.sender !== sender) continue;
      if (this.txNonce(existing) !== nonce) continue;
      const oldFee = this.txFee(existing);
      const isCancel = parseUnits(tx.amount) === 0 && tx.recipient === sender;
      if (newFee > oldFee || isCancel) {
        this.pendingTransactions.splice(i, 1);
        replaced = true;
        break;
      }
      return [false, 'Replacement requires a higher fee (RBF) or a cancel self-transfer', 400];
    }

    let ok;
    let msg;
    this.scratch(() => {
      let st;
      if (replaced) {
        // Rebuild a clean temp state without the replaced entry (already removed).
        st = this.newTempState();
        for (const other of this.pendingTransactions) {
          if (other.sender !== sender) continue;
          this.validateTransaction(other, st.balances, st.nonces, st.tb, st.tokens, { total: 0 });
        }
      } else {
        st = this.validPending(sender).state;
      }
      [ok, msg] = this.validateTransaction(tx, st.balances, st.nonces, st.tb, st.tokens, { total: 0 });
    });
    if (!ok) return [false, msg, 400];
    this.pendingTransactions.push(tx);
    this.broadcastTx(tx);
    if (replaced) return [true, 'Transaction replaced previous mempool entry (RBF) and relayed', 201];
    return [true, 'Transaction accepted and relayed', 201];
  }

  // ---- block validation -------------------------------------------------

  checkBlockHeader(block) {
    if (block.protocol_version !== PROTOCOL_VERSION) return [false, 'Wrong protocol version'];
    if (!Number.isInteger(block.timestamp)) return [false, 'Timestamp must be an integer unix time'];
    if (merkleRoot(block.transactions === undefined ? [] : block.transactions) !== block.merkle_root) {
      return [false, 'Bad merkle root'];
    }
    const expected = this.expectedDifficulty(block.index);
    const given = block.difficulty === undefined ? -1 : Number(block.difficulty);
    if (given !== expected) return [false, `Wrong difficulty, expected ${expected}`];
    const digest = blockHash(block);
    if (digest !== block.hash || !meetsTarget(digest, Number(block.difficulty), block.index)) {
      return [false, 'Bad proof of work'];
    }
    return [true, digest];
  }

  /** Returns [state|null, message]. */
  checkTransactions(block) {
    const reward = this.getBlockReward(block.index);
    let rewardCount = 0;
    let miner = null;
    const st = this.newTempState();
    const created = [];
    for (const tx of block.transactions) {
      if (tx.sender === 'NETWORK') {
        rewardCount += 1;
        if (rewardCount > 1 || parseUnits(tx.amount) !== reward) return [null, 'Bad coinbase amount'];
        if (tx.token_id !== undefined && tx.token_id !== null && tx.token_id !== NATIVE_TOKEN) {
          return [null, 'Coinbase must be BETM'];
        }
        miner = tx.recipient;
        if (!miner) return [null, 'Coinbase missing recipient'];
        const base = st.balances.has(miner) ? st.balances.get(miner) : this.getAccount(miner).balance;
        st.balances.set(miner, base + reward);
      } else {
        const [ok, msg] = this.validateTransaction(tx, st.balances, st.nonces, st.tb, st.tokens, st.fee);
        if (!ok) return [null, msg];
        if (tx.action === 'create_token') created.push(tx);
      }
    }
    if (block.index !== 0 && rewardCount !== 1) return [null, 'Block must contain exactly one coinbase'];
    if (miner && st.fee.total) {
      const base = st.balances.has(miner) ? st.balances.get(miner) : this.getAccount(miner).balance;
      st.balances.set(miner, base + st.fee.total);
    }
    return [{ balances: st.balances, nonces: st.nonces, tokenBalances: st.tb, created }, 'ok'];
  }

  writeState(state) {
    const touched = new Set([...state.balances.keys(), ...state.nonces.keys()]);
    // Expand to every linked native/0x address so both sides stay synchronized.
    const expanded = new Set();
    for (const addr of touched) for (const a of this.resolveLinkedAddresses(addr)) expanded.add(a);
    for (const addr of expanded) {
      let bal = state.balances.get(addr);
      let nonce = state.nonces.get(addr);
      if (bal === undefined || nonce === undefined) {
        const acc = this.getAccount(addr);
        if (bal === undefined) bal = acc.balance;
        if (nonce === undefined) nonce = acc.nonce;
      }
      // Store the full amount on one stable primary and zero the aliases: reads sum linked
      // addresses, so this avoids double counting.
      const linked = [...this.resolveLinkedAddresses(addr)];
      const primary = [...linked].sort()[0];
      for (const a of linked) {
        this.db.run(
          'INSERT OR REPLACE INTO accounts (address, balance, nonce) VALUES (?, ?, ?)',
          a, a === primary ? Number(bal) : 0, Number(nonce),
        );
      }
    }
    for (const tx of state.created) {
      this.db.run(
        'INSERT INTO tokens (token_id, name, symbol, creator, total_supply, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        tx.token_id, tx.token_name, tx.token_symbol, tx.sender, parseUnits(tx.initial_supply), Math.floor(Date.now() / 1000),
      );
      this.registerTokenContract(tx.token_id);
    }
    for (const { addr, tid, bal } of state.tokenBalances.entries()) {
      this.db.run('INSERT OR REPLACE INTO token_balances (address, token_id, balance) VALUES (?, ?, ?)', addr, tid, Number(bal));
    }
  }

  clearState() {
    this.db.run('DELETE FROM accounts');
    this.db.run('DELETE FROM tokens');
    this.db.run('DELETE FROM token_balances');
    // Keep token_contracts in sync with tokens (cleared only on full replay).
    this.db.run('DELETE FROM token_contracts');
  }

  replayAll() {
    this.clearState();
    for (const { idx } of this.db.all('SELECT idx FROM blocks ORDER BY idx')) {
      if (idx === 0) continue;
      const block = this.getBlockByIndex(idx);
      const [state, msg] = this.checkTransactions(block);
      if (state === null) throw new Error(msg);
      this.writeState(state);
    }
  }

  /** Returns [ok, message, isNew]. */
  addBlock(block, relay = true) {
    let accepted = false;
    try {
      this.begin();
      if (this.getBlockByHash(block.hash)) {
        this.rollback();
        return [true, 'Already have this block', false];
      }
      const [ok, msg] = this.checkBlockHeader(block);
      if (!ok) {
        this.rollback();
        return [false, msg, false];
      }
      const parent = this.getBlockByHash(block.previous_hash);
      if (parent === null) {
        if (this.orphans.size < MAX_ORPHANS) this.orphans.set(block.hash, block);
        this.rollback();
        return [false, 'Unknown parent; stored as orphan and will sync', false];
      }
      const tip = this.getLatestBlock();
      if (parent.hash === tip.hash && block.index === tip.index + 1) {
        if (block.timestamp <= this.medianTimePast(block.index)) {
          this.rollback();
          return [false, 'Timestamp is not after median time past', false];
        }
        if (block.timestamp > Math.floor(Date.now() / 1000) + 7200) {
          this.rollback();
          return [false, 'Timestamp too far in the future', false];
        }
        const [state, tmsg] = this.checkTransactions(block);
        if (state === null) {
          this.rollback();
          return [false, tmsg, false];
        }
        this.insertBlockRow(block);
        this.writeState(state);
        this.commit();
        accepted = true;
      } else {
        // Side branch. Adopt it only when the resulting chain has more work.
        const theirWork = this.workUntil(parent) + workOf(block.difficulty, block.index);
        if (theirWork <= this.chainWork()) {
          this.rollback();
          return [false, 'Side branch has less work than the current chain', false];
        }
        this.rollback();
        const [adopted, amsg] = this.adopt([[block, parent.index]]);
        if (adopted && relay) this.broadcastBlock(block);
        return [adopted, amsg, adopted];
      }
    } catch (exc) {
      this.rollback();
      return [false, `Database error: ${exc.message}`, false];
    }
    if (accepted) {
      this.acceptMempool(block);
      this.connectOrphans();
      if (relay) this.broadcastBlock(block);
      return [true, 'Block accepted', true];
    }
    return [false, 'Block not accepted', false];
  }

  workUntil(block) {
    let total = 0n;
    for (const r of this.db.all('SELECT idx, difficulty FROM blocks WHERE idx <= ?', block.index)) {
      total += workOf(r.difficulty, r.idx);
    }
    return total;
  }

  acceptMempool(block) {
    const included = new Set(block.transactions.filter((tx) => tx.sender !== 'NETWORK').map((tx) => dumps(canonicalTx(tx))));
    this.pendingTransactions = this.pendingTransactions.filter((tx) => !included.has(dumps(canonicalTx(tx))));
  }

  connectOrphans() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const tip = this.getLatestBlock();
      for (const [digest, orphan] of [...this.orphans]) {
        if (orphan.previous_hash === tip.hash) {
          this.orphans.delete(digest);
          const [ok] = this.addBlock(orphan, true);
          progressed = progressed || ok;
          break;
        }
      }
    }
  }

  /** Replace the tip with the given already-checked side-branch blocks (they carry more work). */
  adopt(replacements) {
    try {
      this.begin();
      for (const [block, parentIndex] of replacements) {
        this.pruneBlocks(parentIndex);
        this.insertBlockRow(block);
      }
      this.replayAll();
      this.commit();
      this.pendingTransactions = [];
      return [true, 'Reorganized onto the heavier chain'];
    } catch (exc) {
      this.rollback();
      return [false, `Reorg failed: ${exc.message}`];
    }
  }

  /** Replace local blocks after the common ancestor with `blocks` (full block objects, in order). */
  adoptChain(blocks) {
    if (!blocks.length) return [false, 'Nothing to adopt'];
    try {
      this.begin();
      const before = this.chainWork();
      const parent = this.getBlockByHash(blocks[0].previous_hash);
      if (parent === null && !(blocks[0].index === 0 && blocks[0].hash === GENESIS_HASH)) {
        this.rollback();
        return [false, 'Cannot find the fork parent'];
      }
      const forkIndex = parent === null ? -1 : parent.index;
      this.pruneBlocks(forkIndex);
      for (const block of blocks) {
        const [ok, msg] = this.checkBlockHeader(block);
        if (!ok) {
          this.rollback();
          return [false, msg];
        }
        this.insertBlockRow(block);
      }
      // SAFETY: never switch to a chain that does not actually carry more proof-of-work.
      if (this.chainWork() <= before) {
        this.rollback();
        return [false, 'Candidate chain does not have more work than the current chain'];
      }
      this.replayAll();
      this.commit();
      this.pendingTransactions = [];
      return [true, 'Synced heavier chain'];
    } catch (exc) {
      this.rollback();
      return [false, `Sync apply failed: ${exc.message}`];
    }
  }

  status() {
    const tip = this.getLatestBlock();
    return {
      genesis: GENESIS_HASH,
      height: tip.index,
      tip: tip.hash,
      work: String(this.chainWork()),
      protocol_version: PROTOCOL_VERSION,
    };
  }

  headersFrom(start) {
    return this.db.all(
      'SELECT idx, hash, previous_hash, difficulty, timestamp, merkle_root FROM blocks WHERE idx >= ? ORDER BY idx',
      start,
    ).map((r) => ({
      index: r.idx, hash: r.hash, previous_hash: r.previous_hash,
      difficulty: r.difficulty, timestamp: r.timestamp, merkle_root: r.merkle_root,
    }));
  }

  // ---- read-only transaction search -------------------------------------

  /**
   * One confirmed transaction as returned by the search endpoints.
   * Emits both NETWORK coinbase rewards and every user-to-user (P2P)
   * transfer / create_token / eth_raw transaction included in the block.
   */
  txView(tx, row, index) {
    let txHash = null;
    try {
      // MetaMask transactions have a real Ethereum hash; native ones use the same
      // SHA-256 of the canonical JSON that the block's merkle tree is built from.
      txHash = tx.eth_raw
        ? eth.decodeRawTx(tx.eth_raw).hash
        : crypto.createHash('sha256').update(dumps(canonicalTx(tx))).digest('hex');
    } catch {
      txHash = null;
    }
    const sender = tx.sender;
    const action = tx.action;
    let txType;
    if (sender === 'NETWORK') txType = 'reward';
    else if (action === 'create_token') txType = 'token_create';
    else if (action) txType = action;
    else txType = 'transfer';
    const view = {
      tx_hash: txHash,
      block_index: row.idx,
      block_hash: row.hash,
      tx_index: index,
      timestamp: row.timestamp,
      sender,
      recipient: tx.recipient,
      amount: parseUnits(tx.amount),
      fee: parseUnits(tx.fee) || 0,
      token_id: tx.token_id || NATIVE_TOKEN,
      tx_type: txType,
    };
    if (action) view.action = action;
    return view;
  }

  /**
   * Read-only. Newest-first confirmed transactions, optionally filtered by
   * `address` (lowercase sender/recipient) and/or `tokenId`. Walks blocks from
   * the tip down and stops as soon as `limit` results are found. Never touches
   * state, the mempool or consensus. Flattens every transaction in each block.
   */
  scanTransactions(limit, address = null, tokenId = null) {
    const out = [];
    const like = address ? `%"${address}"%` : null; // cheap pre-filter, exact match below
    const wantToken = tokenId ? String(tokenId).toUpperCase() : null;
    let cursor = this.getLatestBlock().index;
    while (cursor >= 0 && out.length < limit) {
      const rows = like
        ? this.db.all(
          'SELECT idx, timestamp, hash, transactions FROM blocks WHERE idx <= ? AND transactions LIKE ? ORDER BY idx DESC LIMIT 100',
          cursor, like,
        )
        : this.db.all(
          'SELECT idx, timestamp, hash, transactions FROM blocks WHERE idx <= ? ORDER BY idx DESC LIMIT 100',
          cursor,
        );
      if (!rows.length) break;
      for (const row of rows) {
        let txs;
        try {
          txs = JSON.parse(row.transactions);
        } catch {
          continue;
        }
        if (!Array.isArray(txs)) continue;
        // Newest-first inside the block so P2P transfers that sit before the
        // coinbase reward still appear in chronological order.
        for (let i = txs.length - 1; i >= 0 && out.length < limit; i--) {
          const tx = txs[i];
          if (!tx || typeof tx !== 'object') continue;
          if (address && String(tx.sender).toLowerCase() !== address && String(tx.recipient).toLowerCase() !== address) continue;
          if (wantToken !== null) {
            const tid = String(tx.token_id || NATIVE_TOKEN).toUpperCase();
            if (tid !== wantToken) continue;
          }
          out.push(this.txView(tx, row, i));
        }
        if (out.length >= limit) break;
      }
      cursor = rows[rows.length - 1].idx - 1;
    }
    return out;
  }

  // ---- networking -------------------------------------------------------

  async syncFromPeers() {
    for (const peer of [...this.peers]) {
      if (peer === this.myNodeUrl) continue;
      try {
        await this.syncFromPeer(peer);
      } catch {
        // peer unreachable or misbehaving
      }
    }
  }

  async syncFromPeer(peer) {
    if (this.syncing.has(peer)) return;
    this.syncing.add(peer);
    try {
      const res = await fetchJson(`${peer}/chain/status`, 4000);
      if (res.status !== 200 || !res.json) return;
      const remote = res.json;
      if (remote.genesis !== GENESIS_HASH) return;
      if (BigInt(remote.work || '0') <= this.chainWork()) return;
      const hres = await fetchJson(`${peer}/headers?from=0`, 10000);
      const headers = (hres.json && hres.json.headers) || [];
      if (!headers.length || headers[0].hash !== GENESIS_HASH) return;
      const localTipHeight = this.getLatestBlock().index;
      let common = -1;
      for (const header of headers) {
        const local = this.getBlockByIndex(header.index);
        if (local && local.hash === header.hash) common = header.index;
        else break;
      }
      if (common === localTipHeight && common === headers[headers.length - 1].index) return;
      const blocks = [];
      for (const header of headers) {
        if (header.index <= common) continue;
        const full = await fetchJson(`${peer}/block/${header.index}`, 5000);
        if (full.status !== 200 || !full.json || !full.json.block) return;
        const block = full.json.block;
        if (block.hash !== header.hash) return;
        blocks.push(block);
      }
      if (!blocks.length) return;
      const [adopted, msg] = this.adoptChain(blocks);
      if (adopted) console.log(`[*] Adopted heavier chain from ${peer}: ${msg} (height ${blocks[blocks.length - 1].index})`);
    } finally {
      this.syncing.delete(peer);
    }
  }

  broadcastBlock(block) {
    for (const peer of [...this.peers]) {
      if (peer === this.myNodeUrl) continue;
      postJson(`${peer}/block/submit`, block, 4000).catch(() => {});
    }
  }

  broadcastTx(tx) {
    for (const peer of [...this.peers]) {
      if (peer === this.myNodeUrl) continue;
      postJson(`${peer}/transaction/new`, tx, 3000).catch(() => {});
    }
  }

  cleanPeerUrl(url) { return cleanPeerUrl(url); }

  registerPeer(urlStr, announce = true) {
    const clean = cleanPeerUrl(urlStr);
    if (!clean) return false;
    if (this.peers.size >= MAX_PEERS && !this.peers.has(clean)) return false;
    const isNew = !this.peers.has(clean);
    if (isNew) {
      this.peers.add(clean);
      this.savePeers();
    }
    if (isNew && announce) this.announcePeer(clean).catch(() => {});
    return true;
  }

  async announcePeer(newUrl) {
    try {
      const res = await fetchJson(`${newUrl}/peers`, 3000);
      if (res.status === 200 && res.json) for (const p of res.json.peers || []) this.registerPeer(p, true);
    } catch {
      // ignore
    }
    if (this.myNodeUrl && this.myNodeUrl !== newUrl) {
      try {
        await postJson(`${newUrl}/peers/register`, { url: this.myNodeUrl }, 2000);
      } catch {
        // ignore
      }
    }
    for (const peer of [...this.peers]) {
      if (peer === newUrl || peer === this.myNodeUrl) continue;
      try {
        await postJson(`${peer}/peers/register`, { url: newUrl }, 2000);
      } catch {
        // ignore
      }
    }
    try {
      await this.syncFromPeer(newUrl);
    } catch {
      // ignore
    }
  }

  knownPeersForClients() {
    const peers = new Set(this.peers);
    if (this.myNodeUrl) peers.add(this.myNodeUrl);
    return [...peers].sort();
  }

  startNetwork(myNodeUrl, bootstrap = null) {
    this.myNodeUrl = cleanPeerUrl(myNodeUrl) || myNodeUrl;
    if (bootstrap) this.registerPeer(bootstrap, true);
    this.networkLoop(this.myNodeUrl).catch(() => {});
    // Auto-mine pending transfers so users never have to run a miner themselves.
    this.autoMineLoop().catch(() => {});
  }

  async autoMineLoop() {
    const minerAddr = process.env.BETIUM_AUTO_MINER || '0x00000000000000000000000000000000000000b1';
    for (;;) {
      try {
        await sleep(3000);
        if (!this.pendingTransactions.length) continue;
        const tip = this.getLatestBlock();
        const index = tip.index + 1;
        const reward = this.getBlockReward(index);
        const difficulty = this.expectedDifficulty(index);
        let pending = [];
        this.scratch(() => { pending = this.validPending().good; });
        if (!pending.length) continue;
        const rewardTx = {
          sender: 'NETWORK', recipient: minerAddr, amount: reward, fee: 0, nonce: 0,
          token_id: NATIVE_TOKEN, public_key: 'NETWORK', signature: 'REWARD',
        };
        const transactions = [...pending, rewardTx];
        const template = {
          index,
          previous_hash: tip.hash,
          difficulty,
          protocol_version: PROTOCOL_VERSION,
          merkle_root: merkleRoot(transactions),
          transactions,
        };
        // Limited search so the node stays responsive; retarget keeps difficulty low.
        const bits = difficultyBits(difficulty, index);
        const maxTries = 2 ** Math.min(bits + 4, 20);
        const ts = Math.floor(Date.now() / 1000);
        const head = Buffer.from(`{"difficulty":${difficulty},"index":${index},"merkle_root":${JSON.stringify(template.merkle_root)},"nonce":`);
        const tail = Buffer.from(`,"previous_hash":${JSON.stringify(tip.hash)},"protocol_version":${PROTOCOL_VERSION},"timestamp":${ts},"transactions":${dumps(transactions)}}`);
        const base = crypto.createHash('sha256').update(head);
        let found = null;
        for (let nonce = 0; nonce < maxTries && found === null; nonce++) {
          const digest = base.copy().update(String(nonce)).update(tail).digest();
          if (hasLeadingZeroBits(digest, bits)) found = nonce;
          if ((nonce & 0x3fff) === 0x3fff) await new Promise((resolve) => setImmediate(resolve));
        }
        if (found === null) continue;
        const latest = this.getLatestBlock();
        if (latest.hash !== tip.hash) continue; // chain moved while we were hashing
        const block = { ...template, timestamp: ts, nonce: found };
        block.hash = blockHash(block);
        const [ok, , isNew] = this.addBlock(block, true);
        if (ok && isNew) info(`[*] Auto-mined block ${block.index} (${pending.length} pending txs confirmed)`);
      } catch (exc) {
        info(`[-] Auto-mine tick failed: ${exc.message}`);
      }
    }
  }

  async networkLoop(myNodeUrl) {
    for (;;) {
      try {
        await this.syncFromPeers();
        for (const peer of [...this.peers]) {
          if (peer === myNodeUrl) continue;
          try {
            const res = await fetchJson(`${peer}/peers`, 3000);
            if (res.status === 200 && res.json) for (const item of res.json.peers || []) this.registerPeer(item, true);
            await postJson(`${peer}/peers/register`, { url: myNodeUrl }, 2000);
          } catch {
            // ignore unreachable peers
          }
        }
      } catch {
        // keep looping
      }
      await sleep(20000);
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { Blockchain, cleanPeerUrl, fetchJson, postJson, hasLeadingZeroBits, TokenBalances };
