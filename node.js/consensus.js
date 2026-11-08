'use strict';
/**
 * Shared Betium consensus rules. Nodes, wallets, and miners must all use this file.
 * Faithful port of consensus.py: block hashes, signatures and canonical JSON are
 * byte-for-byte identical to the Python implementation.
 */

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 5;
const NATIVE_TOKEN = 'BETM';
const UNITS = 100_000_000;
const DECIMAL_PLACES = 8;

const MAX_SUPPLY = 2_000_000 * UNITS;
// 0.0625 BETM x 240 blocks/hour (15 s target) = 15 BETM/hour.
const BLOCK_REWARD = 6_250_000; // 0.0625 BETM
const HALVING_INTERVAL = 1_000_000_000;
// Hard ceiling: coinbase rewards in any rolling 3600 s window cannot exceed this.
const MAX_EMISSION_PER_HOUR = 15 * UNITS; // 15 BETM
const TRANSFER_FEE = 10_000; // 0.00010000 BETM
const TOKEN_CREATE_FEE = 1 * UNITS;
const TOKEN_CREATE_FEE_CAP = 100 * UNITS;
const MIN_BALANCE_TO_CREATE = 10 * UNITS;

// Off-chain reference only; consensus does not embed a price.
const BASELINE_USD_PER_BETM = '0.00005';

// --- Ethereum / MetaMask compatibility -------------------------------------
// MetaMask requires 18 decimals; Betium keeps 8 internally (1 unit = 10**10 wei).
const ETH_CHAIN_ID = 947263;
const WEI_PER_UNIT = 10 ** 10;
const ETH_TRANSFER_GAS = 21_000;
const ETH_GAS_PRICE_WEI = 5_000_000_000; // 5 gwei -> fee 0.000105 BETM

const INITIAL_DIFFICULTY = 3;
const MIN_DIFFICULTY = 2;
const MAX_DIFFICULTY = 32;
const BLOCK_TIME_TARGET = 15;
const RETARGET_WINDOW = 10;

// --- Difficulty rules v2 ------------------------------------------------------
// Below DIFFICULTY_FORK_HEIGHT "difficulty" counts leading zero HEX digits.
// From DIFFICULTY_FORK_HEIGHT on it counts leading zero BITS and is retargeted
// from the work actually done in the last RETARGET_WINDOW blocks.
const DIFFICULTY_FORK_HEIGHT = 41;
const RETARGET_MAX_STEP_BITS = 2; // at most 4x change per block
const MIN_DIFFICULTY_BITS = 8;
const MAX_DIFFICULTY_BITS = 128;

const GENESIS_TIMESTAMP = 1735689600;
const GENESIS_PREV_HASH = '0'.repeat(64);
const GENESIS_NONCE = 141371;
const EMPTY_MERKLE = sha256Hex('');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Canonical JSON == Python json.dumps(obj, sort_keys=True, separators=(",", ":"))
// including ensure_ascii=True escaping. Only integers are allowed as numbers.
// ---------------------------------------------------------------------------

function cmpCodepoints(a, b) {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i);
    const cb = b.codePointAt(j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

function jsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += '\\\\'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0d: out += '\\r'; break;
      case 0x09: out += '\\t'; break;
      case 0x08: out += '\\b'; break;
      case 0x0c: out += '\\f'; break;
      default:
        if (c >= 0x20 && c <= 0x7e) out += s[i];
        else out += '\\u' + c.toString(16).padStart(4, '0');
    }
  }
  return out + '"';
}

function dumps(obj) {
  if (obj === null || obj === undefined) return 'null';
  switch (typeof obj) {
    case 'boolean': return obj ? 'true' : 'false';
    case 'bigint': return obj.toString();
    case 'number':
      if (!Number.isSafeInteger(obj)) throw new TypeError('Only safe integers are allowed in canonical JSON');
      return String(obj);
    case 'string': return jsonString(obj);
    case 'object': {
      if (Array.isArray(obj)) return '[' + obj.map(dumps).join(',') + ']';
      const keys = Object.keys(obj).sort(cmpCodepoints);
      return '{' + keys.map((k) => jsonString(k) + ':' + dumps(obj[k])).join(',') + '}';
    }
    default:
      throw new TypeError('Unsupported value in canonical JSON');
  }
}

function safeNumber(big) {
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);
  return big >= -MAX && big <= MAX ? Number(big) : null;
}

function bitLength(big) {
  return big === 0n ? 0 : big.toString(2).length;
}

function unitsToStr(units) {
  const big = BigInt(units);
  const sign = big < 0n ? '-' : '';
  const abs = big < 0n ? -big : big;
  const whole = abs / BigInt(UNITS);
  const frac = abs % BigInt(UNITS);
  return `${sign}${whole}.${frac.toString().padStart(DECIMAL_PLACES, '0')}`;
}

/** Exact decimal text -> integer count of 1e-8 steps. null if more than 8 places / invalid. */
function decimalScaled(text) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return null;
  const sign = m[1];
  const ip = m[2] || '';
  const fp = m[3] || '';
  const ex = m[4] === undefined ? 0 : Number(m[4]);
  if (ip === '' && fp === '') return null;
  const digits = BigInt(ip + fp);
  if (digits === 0n) return 0;
  const exp10 = ex - fp.length + DECIMAL_PLACES;
  if (Math.abs(exp10) > 60) return null;
  let scaled;
  if (exp10 >= 0) {
    scaled = digits * 10n ** BigInt(exp10);
  } else {
    const d = 10n ** BigInt(-exp10);
    if (digits % d !== 0n) return null;
    scaled = digits / d;
  }
  return safeNumber(sign === '-' ? -scaled : scaled);
}

/** Accept an integer number of units, or a decimal string with at most 8 places. */
function parseUnits(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'bigint') return safeNumber(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string') {
    let text = value.trim();
    if (text.startsWith('+')) text = text.slice(1);
    if (/^-?\d+$/.test(text)) return safeNumber(BigInt(text));
    return decimalScaled(text);
  }
  return null;
}

function canonicalTx(tx) {
  if (tx.eth_raw) {
    // MetaMask transactions are fully described by the signed raw transaction.
    return { eth_raw: tx.eth_raw };
  }
  const nn = (v) => (v === undefined ? null : v);
  const amount = parseUnits(tx.amount);
  const fee = 'fee' in tx ? parseUnits(tx.fee) : 0;
  const body = {
    sender: nn(tx.sender),
    recipient: nn(tx.recipient),
    amount,
    fee,
    nonce: nn(tx.nonce),
  };
  if (tx.action) body.action = tx.action;
  const tokenId = tx.token_id;
  if (tokenId && tokenId !== NATIVE_TOKEN) body.token_id = tokenId;
  if (tx.action === 'create_token') {
    body.token_id = nn(tx.token_id);
    body.token_name = nn(tx.token_name);
    body.token_symbol = nn(tx.token_symbol);
    body.initial_supply = parseUnits(tx.initial_supply);
  }
  return body;
}

function merkleRoot(transactions) {
  if (!transactions || transactions.length === 0) return EMPTY_MERKLE;
  let layer = transactions.map((tx) => sha256Hex(dumps(canonicalTx(tx))));
  while (layer.length > 1) {
    if (layer.length % 2 === 1) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256Hex(layer[i] + layer[i + 1]));
    layer = next;
  }
  return layer[0];
}

const HEADER_KEYS = [
  'index', 'timestamp', 'transactions', 'previous_hash',
  'nonce', 'difficulty', 'protocol_version', 'merkle_root',
];

function blockHeader(block) {
  const header = {};
  for (const k of HEADER_KEYS) {
    if (!(k in block)) throw new Error(`'${k}'`); // mirrors Python KeyError
    header[k] = block[k];
  }
  return header;
}

function blockHash(block) {
  return sha256Hex(dumps(blockHeader(block)));
}

/** Leading zero bits required, under the rule that applies at this height. */
function difficultyBits(difficulty, index) {
  const d = Number(difficulty);
  if (!Number.isInteger(d)) throw new TypeError('difficulty must be an integer');
  return index < DIFFICULTY_FORK_HEIGHT ? d * 4 : d;
}

/** Work for one block as a BigInt (2^bits). */
function workOf(difficulty, index) {
  return 1n << BigInt(difficultyBits(difficulty, index));
}

function meetsTarget(hashHex, difficulty, index) {
  const bits = difficultyBits(difficulty, index);
  if (bits < 0 || bits > 256) return false;
  if (!/^[0-9a-fA-F]+$/.test(hashHex)) throw new Error('invalid hex');
  return (BigInt('0x' + hashHex) >> BigInt(256 - bits)) === 0n;
}

function genesisBlock() {
  // Genesis difficulty is frozen at the historical value (4) so the precomputed
  // GENESIS_NONCE and GENESIS_HASH remain valid across difficulty-parameter updates.
  const block = {
    index: 0,
    timestamp: GENESIS_TIMESTAMP,
    transactions: [],
    previous_hash: GENESIS_PREV_HASH,
    nonce: GENESIS_NONCE,
    difficulty: 4,
    protocol_version: 4, // frozen; later blocks use PROTOCOL_VERSION
    merkle_root: EMPTY_MERKLE,
  };
  block.hash = blockHash(block);
  return block;
}

const GENESIS = genesisBlock();
const GENESIS_HASH = GENESIS.hash;

module.exports = {
  PROTOCOL_VERSION, NATIVE_TOKEN, UNITS, DECIMAL_PLACES, MAX_SUPPLY, BLOCK_REWARD,
  HALVING_INTERVAL, MAX_EMISSION_PER_HOUR, TRANSFER_FEE, TOKEN_CREATE_FEE,
  TOKEN_CREATE_FEE_CAP, MIN_BALANCE_TO_CREATE, BASELINE_USD_PER_BETM,
  ETH_CHAIN_ID, WEI_PER_UNIT, ETH_TRANSFER_GAS, ETH_GAS_PRICE_WEI,
  INITIAL_DIFFICULTY, MIN_DIFFICULTY, MAX_DIFFICULTY, BLOCK_TIME_TARGET, RETARGET_WINDOW,
  DIFFICULTY_FORK_HEIGHT, RETARGET_MAX_STEP_BITS, MIN_DIFFICULTY_BITS, MAX_DIFFICULTY_BITS,
  GENESIS_TIMESTAMP, GENESIS_PREV_HASH, GENESIS_NONCE, EMPTY_MERKLE, GENESIS, GENESIS_HASH,
  dumps, unitsToStr, parseUnits, decimalScaled, canonicalTx, merkleRoot, blockHeader,
  blockHash, difficultyBits, workOf, meetsTarget, genesisBlock, bitLength, sha256Hex,
};
