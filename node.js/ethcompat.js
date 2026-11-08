'use strict';
/**
 * Betium <-> Ethereum wallet compatibility layer (MetaMask support).
 *
 * Zero dependencies. Provides:
 *   - keccak256, RLP, secp256k1 public-key recovery
 *   - decoding/validation of legacy EIP-155 signed transactions
 *   - the JSON-RPC methods MetaMask needs (served by node.js at POST /rpc)
 *   - ERC-20 style support for custom Betium tokens (balanceOf, name, symbol,
 *     decimals, totalSupply, transfer) so MetaMask can add and use them.
 *
 * Betium keeps its own 8-decimal integer "units". MetaMask insists on 18
 * decimals, so the RPC layer multiplies by WEI_PER_UNIT (10**10) on the way out
 * and divides on the way in.
 */

const {
  ETH_CHAIN_ID, ETH_GAS_PRICE_WEI, ETH_TRANSFER_GAS, NATIVE_TOKEN, PROTOCOL_VERSION,
  TRANSFER_FEE, workOf, WEI_PER_UNIT, parseUnits, dumps,
} = require('./consensus');
const secp = require('./lib/secp');

const CLIENT_VERSION = `Betium/v${PROTOCOL_VERSION}`;
const BLOCK_GAS_LIMIT = 30_000_000;
const ZERO_HASH = '0x' + '0'.repeat(64);
const ZERO_ADDR = '0x' + '0'.repeat(40);
const EMPTY_BLOOM = '0x' + '0'.repeat(512);
const NETWORK_NAME = 'Betium';
const DECIMALS = 18;
const WEI = BigInt(WEI_PER_UNIT);

class EthTxError extends Error {}
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.rpcMessage = message;
  }
}
class ValueError extends Error {}

// ---------------------------------------------------------------- keccak256

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
const M64 = (1n << 64n) - 1n;

function rol(x, n) {
  n %= 64;
  if (!n) return x;
  const bn = BigInt(n);
  return ((x << bn) | (x >> (64n - bn))) & M64;
}

function keccakF(a) {
  for (const rc of RC) {
    const c = [];
    for (let x = 0; x < 5; x++) c.push(a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4]);
    const d = [];
    for (let x = 0; x < 5; x++) d.push(c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x][y] ^= d[x];
    const b = Array.from({ length: 5 }, () => new Array(5).fill(0n));
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y][(2 * x + 3 * y) % 5] = rol(a[x][y], ROT[x][y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]);
      }
    }
    a[0][0] ^= rc;
  }
  return a;
}

function keccak256(data) {
  const rate = 136;
  const input = Buffer.from(data);
  const padded = Math.ceil((input.length + 1) / rate) * rate;
  const msg = Buffer.alloc(padded);
  input.copy(msg);
  msg[input.length] = 0x01;
  msg[padded - 1] |= 0x80;
  const state = Array.from({ length: 5 }, () => new Array(5).fill(0n));
  for (let off = 0; off < padded; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      state[i % 5][Math.floor(i / 5)] ^= msg.readBigUInt64LE(off + 8 * i);
    }
    keccakF(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i % 5][Math.floor(i / 5)], 8 * i);
  return out;
}

// ---------------------------------------------------------------------- RLP

function intBytes(n) {
  const big = BigInt(n);
  if (big === 0n) return Buffer.alloc(0);
  let hex = big.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

function rlpLen(length, offset) {
  if (length < 56) return Buffer.from([offset + length]);
  const lb = intBytes(length);
  return Buffer.concat([Buffer.from([offset + 55 + lb.length]), lb]);
}

function rlpEncode(item) {
  if (typeof item === 'number' || typeof item === 'bigint') item = intBytes(item);
  if (Buffer.isBuffer(item) || item instanceof Uint8Array) {
    const buf = Buffer.from(item);
    if (buf.length === 1 && buf[0] < 0x80) return buf;
    return Buffer.concat([rlpLen(buf.length, 0x80), buf]);
  }
  const payload = Buffer.concat(item.map(rlpEncode));
  return Buffer.concat([rlpLen(payload.length, 0xc0), payload]);
}

function rlpDecode(data) {
  const [item, end] = rlpItem(data, 0);
  if (end !== data.length) throw new EthTxError('Trailing bytes after RLP payload');
  return item;
}

function readLen(data, start, count) {
  if (start + count > data.length) throw new EthTxError('RLP truncated');
  const n = secp.bufToBig(data.subarray(start, start + count));
  if (n > BigInt(data.length)) throw new EthTxError('Bad RLP length');
  return Number(n);
}

function rlpItem(data, pos) {
  if (pos >= data.length) throw new EthTxError('RLP truncated');
  const b = data[pos];
  if (b < 0x80) return [data.subarray(pos, pos + 1), pos + 1];
  if (b < 0xb8) {
    const n = b - 0x80;
    const s = pos + 1;
    if (s + n > data.length) throw new EthTxError('RLP truncated');
    if (n === 1 && data[s] < 0x80) throw new EthTxError('Non-canonical RLP');
    return [data.subarray(s, s + n), s + n];
  }
  if (b < 0xc0) {
    const ll = b - 0xb7;
    const n = readLen(data, pos + 1, ll);
    const s = pos + 1 + ll;
    if (n < 56 || s + n > data.length) throw new EthTxError('Bad RLP length');
    return [data.subarray(s, s + n), s + n];
  }
  let n;
  let s;
  if (b < 0xf8) {
    n = b - 0xc0;
    s = pos + 1;
  } else {
    const ll = b - 0xf7;
    n = readLen(data, pos + 1, ll);
    s = pos + 1 + ll;
    if (n < 56) throw new EthTxError('Bad RLP length');
  }
  const end = s + n;
  if (end > data.length) throw new EthTxError('RLP truncated');
  const items = [];
  while (s < end) {
    const [it, next] = rlpItem(data, s);
    items.push(it);
    s = next;
  }
  if (s !== end) throw new EthTxError('Bad RLP list');
  return [items, end];
}

// ------------------------------------------------------- addresses / signing

const pubkeyToAddress = (pub64) => '0x' + keccak256(pub64).subarray(12).toString('hex');
const privateToPublic = (priv) => secp.privateToPublic(BigInt(priv));
const ethSign = (privHex, msgHash) => {
  const { r, s, recid } = secp.ethSign(privHex, msgHash);
  return [r, s, recid];
};
const recoverPubkey = (msgHash, r, s, recid) => secp.recoverPubkey(msgHash, BigInt(r), BigInt(s), recid, EthTxError);

function isHexAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
}

function isNativeAddress(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

const validAccountId = (value) => isHexAddress(value) || isNativeAddress(value);

// --------------------------------------------------------- transaction decode

const decodeCache = new Map();
const DECODE_CACHE_MAX = 4000;

function toSafe(big, what) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new EthTxError(`${what} is too large`);
  return Number(big);
}

/**
 * Decode and cryptographically verify a legacy EIP-155 transaction.
 * Returns { sender, to, value_wei, gas, gas_price, nonce, data, hash, v, r, s, pub }
 * (numeric fields are BigInt). Throws EthTxError for anything Betium does not accept.
 */
function decodeRawTx(rawHex) {
  if (typeof rawHex !== 'string' || !rawHex.startsWith('0x')) {
    throw new EthTxError('eth_raw must be a 0x-prefixed hex string');
  }
  const cached = decodeCache.get(rawHex);
  if (cached) return cached;
  if (rawHex.length > 2 + 2 * 4096) throw new EthTxError('Transaction too large');
  const body = rawHex.slice(2);
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) throw new EthTxError('eth_raw is not valid hex');
  const raw = Buffer.from(body, 'hex');
  if (raw.length === 0) throw new EthTxError('Empty transaction');
  if (raw[0] < 0xc0) throw new EthTxError('Only legacy (type 0) transactions are supported');
  const fields = rlpDecode(raw);
  if (!Array.isArray(fields) || fields.length !== 9 || fields.some((f) => Array.isArray(f))) {
    throw new EthTxError('Malformed legacy transaction');
  }
  const [nonceB, gpB, gasB, toB, valueB, dataB, vB, rB, sB] = fields;
  const named = [['nonce', nonceB], ['gasPrice', gpB], ['gas', gasB], ['value', valueB], ['v', vB], ['r', rB], ['s', sB]];
  for (const [name, b] of named) {
    if (b.length > 32 || (b.length > 1 && b[0] === 0)) throw new EthTxError(`Bad ${name} encoding`);
  }
  const nonce = secp.bufToBig(nonceB);
  const gasPrice = secp.bufToBig(gpB);
  const gas = secp.bufToBig(gasB);
  const value = secp.bufToBig(valueB);
  const v = secp.bufToBig(vB);
  const r = secp.bufToBig(rB);
  const s = secp.bufToBig(sB);
  if (toB.length === 0) throw new EthTxError('Contract creation is not supported on Betium');
  if (toB.length !== 20) throw new EthTxError('Bad recipient address');
  const chain = BigInt(ETH_CHAIN_ID);
  if (v !== chain * 2n + 35n && v !== chain * 2n + 36n) {
    throw new EthTxError(`Wrong chain id. Betium requires EIP-155 signatures for chain ${ETH_CHAIN_ID}`);
  }
  if (s > secp.N / 2n) throw new EthTxError('Signature s value too high (EIP-2)');
  const recid = Number(v - (chain * 2n + 35n));
  // Signing hash uses the actual data field (empty for plain transfers).
  const signing = rlpEncode([nonce, gasPrice, gas, toB, value, dataB, ETH_CHAIN_ID, 0, 0]);
  const pub = recoverPubkey(keccak256(signing), r, s, recid);
  const decoded = {
    sender: pubkeyToAddress(pub),
    to: '0x' + toB.toString('hex'),
    value_wei: value,
    gas,
    gas_price: gasPrice,
    nonce,
    data: Buffer.from(dataB),
    hash: '0x' + keccak256(raw).toString('hex'),
    v, r, s,
    pub,
  };
  if (decodeCache.size >= DECODE_CACHE_MAX) decodeCache.delete(decodeCache.keys().next().value);
  decodeCache.set(rawHex, decoded);
  return decoded;
}

/**
 * Turn a raw Ethereum transaction into the dict Betium stores in blocks.
 * Supports plain BETM value transfers and ERC-20 transfer() calls to custom-token
 * contract addresses (the node resolves the token_id from the returned contract).
 */
function buildInternalTx(rawHex) {
  const d = decodeRawTx(rawHex);
  const data = d.data || Buffer.alloc(0);
  const feeWei = d.gas * d.gas_price;
  if (feeWei % WEI !== 0n) throw new EthTxError('Gas price must make the fee a multiple of 0.00000001 BETM');
  const feeBig = feeWei / WEI;
  if (feeBig < BigInt(TRANSFER_FEE)) {
    const needed = d.gas === 0n
      ? 'unbounded (gas limit is zero)'
      : String((BigInt(TRANSFER_FEE) * WEI + d.gas - 1n) / d.gas);
    throw new EthTxError(`Fee too low: gas price must be at least ${needed} wei`);
  }
  const fee = toSafe(feeBig, 'Fee');
  const nonce = toSafe(d.nonce + 1n, 'Nonce');

  if (data.length === 0) {
    // Native BETM transfer
    if (d.gas !== BigInt(ETH_TRANSFER_GAS)) {
      throw new EthTxError(`Gas limit must be exactly ${ETH_TRANSFER_GAS} for BETM transfers`);
    }
    if (d.value_wei <= 0n || d.value_wei % WEI !== 0n) {
      throw new EthTxError('Amount must be positive and a multiple of 0.00000001 BETM');
    }
    return [{
      sender: d.sender,
      recipient: d.to,
      amount: toSafe(d.value_wei / WEI, 'Amount'),
      fee,
      nonce,
      eth_raw: rawHex.toLowerCase(),
    }, d];
  }

  // Custom token: must be an ERC-20 transfer() call, value must be zero
  if (d.value_wei !== 0n) throw new EthTxError('Token transfers must have zero value (ETH amount)');
  if (d.gas < BigInt(ETH_TRANSFER_GAS)) {
    throw new EthTxError(`Gas limit must be at least ${ETH_TRANSFER_GAS} for token transfers`);
  }
  if (data.length < 4 + 32 + 32 || data.subarray(0, 4).toString('hex') !== 'a9059cbb') {
    throw new EthTxError('Only ERC-20 transfer(address,uint256) calls are supported for custom tokens');
  }
  const toBytes = data.subarray(4 + 12, 4 + 32);
  const amountWei = secp.bufToBig(data.subarray(4 + 32, 4 + 64));
  if (amountWei <= 0n || amountWei % WEI !== 0n) {
    throw new EthTxError('Token amount must be positive and a multiple of 0.00000001 units');
  }
  return [{
    sender: d.sender,
    recipient: '0x' + toBytes.toString('hex'),
    amount: toSafe(amountWei / WEI, 'Amount'),
    fee,
    nonce,
    eth_raw: rawHex.toLowerCase(),
    contract: d.to.toLowerCase(),
  }, d];
}

// ------------------------------------------------------------- JSON-RPC layer

const hex = (n) => '0x' + BigInt(n).toString(16);

function parseInt0x(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return Number(BigInt(value));
  throw new ValueError('bad quantity');
}

function accountId(value) {
  if (typeof value !== 'string') throw new ValueError('Invalid address');
  const v = value.toLowerCase();
  if (isHexAddress(v)) return v;
  if (v.startsWith('0x') && isNativeAddress(v.slice(2))) return v.slice(2);
  if (isNativeAddress(v)) return v;
  throw new ValueError('Invalid address');
}

function networkParams(rpcUrl) {
  // iconUrls: the node serves /static/betium_logo.png itself; MetaMask caches the first icon.
  let iconBase = null;
  if (rpcUrl) {
    try {
      const u = new URL(rpcUrl);
      iconBase = `${u.protocol}//${u.host}/static/betium_logo.png`;
    } catch {
      iconBase = null;
    }
  }
  return {
    chainId: hex(ETH_CHAIN_ID),
    chainIdDecimal: ETH_CHAIN_ID,
    chainName: NETWORK_NAME,
    nativeCurrency: { name: 'Betium', symbol: NATIVE_TOKEN, decimals: DECIMALS },
    rpcUrls: rpcUrl ? [rpcUrl] : [],
    blockExplorerUrls: [],
    iconUrls: iconBase ? [iconBase] : [],
  };
}

function txObject(tx, d, block = null, index = null) {
  return {
    hash: d.hash,
    nonce: hex(d.nonce),
    blockHash: block ? '0x' + block.hash : null,
    blockNumber: block ? hex(block.index) : null,
    transactionIndex: block ? hex(index) : null,
    from: d.sender,
    to: d.to,
    value: hex(d.value_wei),
    gas: hex(d.gas),
    gasPrice: hex(d.gas_price),
    input: '0x',
    v: hex(d.v),
    r: hex(d.r),
    s: hex(d.s),
    type: '0x0',
    chainId: hex(ETH_CHAIN_ID),
  };
}

function ethTxsOf(block) {
  const out = [];
  for (const tx of block.transactions || []) {
    if (tx && typeof tx === 'object' && tx.eth_raw) {
      try {
        out.push([tx, decodeRawTx(tx.eth_raw)]);
      } catch (e) {
        if (!(e instanceof EthTxError)) throw e;
      }
    }
  }
  return out;
}

function blockObject(chain, block, full) {
  const pairs = ethTxsOf(block);
  let miner = ZERO_ADDR;
  for (const tx of block.transactions || []) {
    if (tx && tx.sender === 'NETWORK' && isHexAddress(tx.recipient)) miner = tx.recipient;
  }
  const txs = full
    ? pairs.map(([t, d], i) => txObject(t, d, block, i))
    : pairs.map(([, d]) => d.hash);
  const nonceHex = BigInt(block.nonce).toString(16).padStart(16, '0');
  if (nonceHex.length > 16) throw new ValueError('nonce too large');
  return {
    number: hex(block.index),
    hash: '0x' + block.hash,
    parentHash: '0x' + block.previous_hash,
    nonce: '0x' + nonceHex,
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: EMPTY_BLOOM,
    transactionsRoot: '0x' + block.merkle_root,
    stateRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    miner,
    difficulty: hex(workOf(block.difficulty, block.index)),
    totalDifficulty: hex(chain.chainWork()),
    extraData: '0x',
    size: hex(dumps(block).length),
    gasLimit: hex(BLOCK_GAS_LIMIT),
    gasUsed: hex(ETH_TRANSFER_GAS * pairs.length),
    timestamp: hex(block.timestamp),
    transactions: txs,
    uncles: [],
  };
}

function resolveBlock(chain, tag) {
  const latest = chain.getLatestBlock();
  if (tag === null || tag === undefined || ['latest', 'pending', 'safe', 'finalized'].includes(tag)) return latest;
  if (tag === 'earliest') return chain.getBlockByIndex(0);
  return chain.getBlockByIndex(parseInt0x(tag));
}

const abiUint256 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

function abiString(s) {
  const data = Buffer.from(s, 'utf8');
  const pad = (32 - (data.length % 32)) % 32;
  const head = Buffer.alloc(64);
  head.writeBigUInt64BE(32n, 24);
  head.writeBigUInt64BE(BigInt(data.length), 56);
  return '0x' + Buffer.concat([head, data, Buffer.alloc(pad)]).toString('hex');
}

const SEL_BALANCE_OF = '70a08231';
const SEL_NAME = '06fdde03';
const SEL_SYMBOL = '95d89b41';
const SEL_DECIMALS = '313ce567';
const SEL_TOTAL_SUPPLY = '18160ddd';

/** Minimal ERC-20 eth_call support for custom Betium tokens. */
function handleEthCall(chain, params) {
  if (!params || !params[0] || typeof params[0] !== 'object') return '0x';
  const call = params[0];
  const to = String(call.to || '').toLowerCase();
  const dataHex = call.data || '0x';
  if (!to.startsWith('0x') || typeof dataHex !== 'string' || !dataHex.startsWith('0x')) return '0x';
  if (dataHex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(dataHex.slice(2))) return '0x';
  const data = Buffer.from(dataHex.slice(2), 'hex');
  const tid = chain.getTokenIdByContract(to);
  if (!tid) return '0x';
  if (data.length === 0) return '0x';
  const sel = data.subarray(0, 4).toString('hex');
  if (sel === SEL_BALANCE_OF && data.length >= 36) {
    const acct = '0x' + data.subarray(16, 36).toString('hex');
    return abiUint256(BigInt(chain.getTokenBalance(acct, tid)) * WEI);
  }
  if (sel === SEL_NAME) {
    const info = chain.getTokenInfo(tid);
    return info ? abiString(info.name || tid) : '0x';
  }
  if (sel === SEL_SYMBOL) {
    const info = chain.getTokenInfo(tid);
    return info ? abiString(info.symbol || tid) : '0x';
  }
  if (sel === SEL_DECIMALS) return abiUint256(18);
  if (sel === SEL_TOTAL_SUPPLY) {
    const info = chain.getTokenInfo(tid);
    return info ? abiUint256(BigInt(info.total_supply_units || 0) * WEI) : '0x';
  }
  return '0x';
}

function handleRpcCall(chain, method, params) {
  params = params || [];
  switch (method) {
    case 'web3_clientVersion': return CLIENT_VERSION;
    case 'web3_sha3': return '0x' + keccak256(Buffer.from(params[0].slice(2), 'hex')).toString('hex');
    case 'net_version': return String(ETH_CHAIN_ID);
    case 'net_listening': return true;
    case 'net_peerCount': return hex(chain.peers.size);
    case 'eth_protocolVersion': return hex(PROTOCOL_VERSION);
    case 'eth_chainId': return hex(ETH_CHAIN_ID);
    case 'eth_syncing': return false;
    case 'eth_mining': return false;
    case 'eth_hashrate': return '0x0';
    case 'eth_accounts': return [];
    case 'eth_coinbase': return ZERO_ADDR;
    case 'eth_blockNumber': return hex(chain.getLatestBlock().index);
    case 'eth_gasPrice': return hex(ETH_GAS_PRICE_WEI);
    case 'eth_maxPriorityFeePerGas': return '0x0';
    case 'eth_estimateGas': return hex(ETH_TRANSFER_GAS);
    case 'eth_getBalance': {
      const acct = accountId(params[0]);
      const tag = params.length > 1 ? params[1] : 'latest';
      // 0-conf: "pending" applies mempool effects so wallets update instantly.
      const bal = tag === 'pending' ? chain.getAccountPending(acct).balance : chain.getAccount(acct).balance;
      return hex(BigInt(bal) * WEI);
    }
    case 'eth_getTransactionCount': {
      const acct = accountId(params[0]);
      let nonce = chain.getAccount(acct).nonce;
      if (params.length > 1 && params[1] === 'pending') {
        nonce += chain.pendingTransactions.filter((t) => t.sender === acct).length;
      }
      return hex(nonce);
    }
    case 'eth_pendingTransactions': {
      const out = [];
      for (const tx of [...chain.pendingTransactions]) {
        if (tx.eth_raw) {
          try {
            out.push(txObject(tx, decodeRawTx(tx.eth_raw)));
          } catch (e) {
            if (!(e instanceof EthTxError)) throw e;
          }
        } else {
          try {
            const amount = Number(parseUnits(tx.amount) || 0);
            out.push({
              hash: null,
              nonce: hex(tx.nonce || 0),
              blockHash: null,
              blockNumber: null,
              transactionIndex: null,
              from: tx.sender,
              to: tx.recipient,
              value: hex(BigInt(amount) * WEI),
              gasPrice: hex(ETH_GAS_PRICE_WEI),
              gas: hex(ETH_TRANSFER_GAS),
              input: '0x',
              type: '0x0',
            });
          } catch {
            // skip malformed entries
          }
        }
      }
      return out;
    }
    case 'eth_getCode': return '0x'; // MetaMask still accepts custom tokens when eth_call works.
    case 'eth_getStorageAt': return ZERO_HASH;
    case 'eth_call': return handleEthCall(chain, params);
    case 'eth_getLogs': return [];
    case 'eth_getBlockByNumber': {
      const block = resolveBlock(chain, params[0]);
      return block ? blockObject(chain, block, Boolean(params.length > 1 ? params[1] : false)) : null;
    }
    case 'eth_getBlockByHash': {
      const h = typeof params[0] === 'string' && params[0].startsWith('0x') ? params[0].slice(2) : params[0];
      const block = chain.getBlockByHash(h);
      return block ? blockObject(chain, block, Boolean(params.length > 1 ? params[1] : false)) : null;
    }
    case 'eth_getBlockTransactionCountByNumber':
    case 'eth_getBlockTransactionCountByHash': {
      const block = method.endsWith('ByNumber')
        ? resolveBlock(chain, params[0])
        : chain.getBlockByHash(params[0].slice(2));
      return block ? hex(ethTxsOf(block).length) : null;
    }
    case 'eth_getTransactionByHash': {
      const found = chain.findEthTx(params[0]);
      if (found) return txObject(found.tx, found.decoded, found.block, found.index);
      for (const tx of chain.pendingTransactions) {
        if (!tx.eth_raw) continue;
        let d;
        try {
          d = decodeRawTx(tx.eth_raw);
        } catch (e) {
          if (e instanceof EthTxError) continue;
          throw e;
        }
        if (d.hash === params[0].toLowerCase()) return txObject(tx, d);
      }
      return null;
    }
    case 'eth_getTransactionReceipt': {
      const found = chain.findEthTx(params[0]);
      if (!found) return null;
      const { decoded: d, block, index } = found;
      return {
        transactionHash: d.hash,
        transactionIndex: hex(index),
        blockHash: '0x' + block.hash,
        blockNumber: hex(block.index),
        from: d.sender,
        to: d.to,
        cumulativeGasUsed: hex(ETH_TRANSFER_GAS * (index + 1)),
        gasUsed: hex(ETH_TRANSFER_GAS),
        effectiveGasPrice: hex(d.gas_price),
        contractAddress: null,
        logs: [],
        logsBloom: EMPTY_BLOOM,
        status: '0x1',
        type: '0x0',
      };
    }
    case 'eth_sendRawTransaction': {
      let built;
      try {
        built = buildInternalTx(params[0]);
      } catch (e) {
        if (e instanceof EthTxError) throw new RpcError(-32000, e.message);
        throw e;
      }
      const [tx, d] = built;
      const [ok, msg] = chain.submitTransaction(tx);
      if (!ok) throw new RpcError(-32000, msg);
      return d.hash;
    }
    case 'eth_feeHistory':
      throw new RpcError(-32601, 'Method not supported: Betium uses legacy gas pricing');
    default:
      throw new RpcError(-32601, `Method ${method} not found`);
  }
}

/** Handle one JSON-RPC object or a batch. Returns [response, httpStatus]. */
function handleRpcRequest(chain, payload) {
  if (Array.isArray(payload)) {
    if (payload.length === 0 || payload.length > 50) {
      return [{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid batch' } }, 400];
    }
    return [payload.map((p) => handleRpcRequest(chain, p)[0]), 200];
  }
  if (!payload || typeof payload !== 'object' || !('method' in payload)) {
    return [{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400];
  }
  const rid = payload.id === undefined ? null : payload.id;
  try {
    const result = handleRpcCall(chain, payload.method, payload.params);
    return [{ jsonrpc: '2.0', id: rid, result }, 200];
  } catch (e) {
    if (e instanceof RpcError) {
      return [{ jsonrpc: '2.0', id: rid, error: { code: e.code, message: e.rpcMessage } }, 200];
    }
    if (e instanceof ValueError || e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError) {
      return [{ jsonrpc: '2.0', id: rid, error: { code: -32602, message: 'Invalid params' } }, 200];
    }
    // never leak a stack trace to clients
    return [{ jsonrpc: '2.0', id: rid, error: { code: -32603, message: `Internal error: ${e.name}` } }, 200];
  }
}

// ------------------------------------------------------------------ CLI / help

function printHelp() {
  console.log(`Betium Ethereum compatibility - usage:
  node ethcompat.js [-h|--help]
  node ethcompat.js network [RPC_URL]   Print the MetaMask network settings
  node ethcompat.js address <PRIVATE_KEY_HEX>
                                        Show the 0x address MetaMask derives from a key
  node ethcompat.js selftest            Run built-in tests (keccak, RLP, signature recovery)

This module is used by node.js, which serves JSON-RPC at POST /rpc.
Native BETM uses plain value transfers. Custom tokens are exposed as ERC-20
contracts so MetaMask can add them (via contract address) and transfer them.
`);
  process.exit(0);
}

function selftest() {
  const assert = require('node:assert');
  assert.strictEqual(keccak256(Buffer.alloc(0)).toString('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.strictEqual(keccak256(Buffer.from('abc')).toString('hex'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.strictEqual(pubkeyToAddress(privateToPublic(1)), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  const priv = '46'.repeat(32);
  const to = Buffer.from('35'.repeat(20), 'hex');
  const body = [3, ETH_GAS_PRICE_WEI, ETH_TRANSFER_GAS, to, BigInt(12345) * WEI, Buffer.alloc(0)];
  const h = keccak256(rlpEncode([...body, ETH_CHAIN_ID, 0, 0]));
  const [r, s, rec] = ethSign(priv, h);
  const raw = '0x' + rlpEncode([...body, ETH_CHAIN_ID * 2 + 35 + rec, r, s]).toString('hex');
  const [tx, d] = buildInternalTx(raw);
  assert.strictEqual(d.sender, pubkeyToAddress(privateToPublic(BigInt('0x' + priv))));
  assert.strictEqual(tx.amount, 12345);
  assert.strictEqual(tx.nonce, 4);
  assert.strictEqual(tx.fee, 10500);
  console.log('[+] selftest passed');
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.some((a) => a === '-h' || a === '--help')) printHelp();
  if (args[0] === 'network') {
    console.log(JSON.stringify(networkParams(args[1] || null), null, 2));
  } else if (args[0] === 'address' && args.length === 2) {
    console.log(pubkeyToAddress(privateToPublic(BigInt('0x' + args[1]))));
  } else if (args[0] === 'selftest') {
    selftest();
  } else {
    printHelp();
  }
}

module.exports = {
  EthTxError, RpcError, keccak256, rlpEncode, rlpDecode, recoverPubkey, pubkeyToAddress,
  privateToPublic, ethSign, isHexAddress, isNativeAddress, validAccountId, decodeRawTx,
  buildInternalTx, networkParams, ethTxsOf, handleRpcCall, handleRpcRequest, hex,
  CLIENT_VERSION, ZERO_ADDR,
};

if (require.main === module) main();
