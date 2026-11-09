'use strict';
/**
 * HTTP API for the Betium node (replaces the Flask app in node.py).
 * Same routes, status codes, JSON shapes and size limits. Responses are compact JSON
 * with sorted keys, like Flask's jsonify.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../consensus');
const eth = require('../ethcompat');

const {
  BLOCK_TIME_TARGET, ETH_CHAIN_ID, ETH_GAS_PRICE_WEI, GENESIS_HASH, MAX_SUPPLY, NATIVE_TOKEN,
  PROTOCOL_VERSION, TOKEN_CREATE_FEE_CAP, TRANSFER_FEE, UNITS, dumps, merkleRoot, unitsToStr,
} = C;

const LOGO_FILE = path.join(__dirname, '..', 'betium_logo.png');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function toJson(obj) {
  try {
    return dumps(obj);
  } catch {
    return JSON.stringify(obj);
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        const err = new Error('Payload too large');
        err.tooLarge = true;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!failed) reject(e); });
  });
}

function parseJson(buf) {
  try {
    const text = buf.toString('utf8');
    return text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Transactions and blocks only carry integers; reject floats and numbers that lose precision. */
function hasUnsafeNumber(value) {
  if (typeof value === 'number') return !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(hasUnsafeNumber);
  if (value && typeof value === 'object') return Object.values(value).some(hasUnsafeNumber);
  return false;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createServer(chain) {
  function publicAccount(address, tokenId = NATIVE_TOKEN) {
    let balance;
    let nonce;
    if (tokenId === NATIVE_TOKEN) {
      ({ balance, nonce } = chain.getAccount(address));
    } else {
      balance = chain.getTokenBalance(address, tokenId);
      nonce = chain.getAccount(address).nonce;
    }
    return {
      address, token_id: tokenId, balance: unitsToStr(balance), balance_units: balance, nonce,
    };
  }

  function publicOrigin(req) {
    const fwdHost = req.headers['x-forwarded-host'];
    const fwdProto = req.headers['x-forwarded-proto'];
    const host = req.headers.host || '';
    if (fwdHost) return `${(fwdProto || 'https').split(',')[0].trim()}://${fwdHost.split(',')[0].trim()}`;
    if (/^(localhost|127\.|\[::1\])/.test(host) && chain.myNodeUrl) return chain.myNodeUrl;
    return `http://${host}`;
  }

  // Each route: [methods, regex, handler(ctx) -> Promise<[status, body]> | special]
  const routes = [];
  const add = (methods, re, handler) => routes.push({ methods, re, handler });

  add(['GET'], /^\/chain\/status$/, async () => [200, chain.status()]);

  add(['GET'], /^\/headers$/, async ({ query }) => {
    const raw = query.get('from') === null ? '0' : query.get('from');
    if (!/^\s*[+-]?\d+\s*$/.test(raw)) return [400, { error: 'from must be an integer' }];
    const start = Math.max(0, Number(raw.trim()));
    return [200, { headers: chain.headersFrom(start), genesis: GENESIS_HASH }];
  });

  add(['GET'], /^\/block\/(\d+)$/, async ({ m }) => {
    const block = chain.getBlockByIndex(Number(m[1]));
    return block ? [200, { block }] : [404, { error: 'Unknown block' }];
  });

  add(['GET'], /^\/balance\/([^/]+)$/, async ({ m }) => [200, publicAccount(m[1])]);
  add(['GET'], /^\/balance\/([^/]+)\/([^/]+)$/, async ({ m }) => [200, publicAccount(m[1], m[2])]);

  add(['GET'], /^\/supply$/, async () => {
    const supply = chain.getTotalSupply();
    return [200, {
      total_circulating_supply: unitsToStr(supply),
      total_circulating_supply_units: supply,
      max_supply: unitsToStr(MAX_SUPPLY),
      max_supply_units: MAX_SUPPLY,
    }];
  });

  // Read-only transaction search (newest first). limit: default 50, max 500.
  const parseLimit = (query) => {
    const raw = query.get('limit');
    if (raw === null) return 50;
    if (!/^\s*\d+\s*$/.test(raw) || Number(raw) < 1) return null;
    return Math.min(500, Number(raw));
  };

  add(['GET'], /^\/transactions\/recent$/, async ({ query }) => {
    const limit = parseLimit(query);
    if (limit === null) return [400, { success: false, error: 'limit must be a positive integer' }];
    const transactions = chain.scanTransactions(limit);
    return [200, { success: true, count: transactions.length, transactions }];
  });

  add(['GET'], /^\/address\/([^/]+)\/transactions$/, async ({ m, query }) => {
    const address = m[1].toLowerCase();
    if (!eth.validAccountId(address)) {
      return [400, { success: false, error: 'Address must be a 64-character Betium address or a 0x Ethereum address' }];
    }
    const limit = parseLimit(query);
    if (limit === null) return [400, { success: false, error: 'limit must be a positive integer' }];
    const transactions = chain.scanTransactions(limit, address);
    return [200, { success: true, address, count: transactions.length, transactions }];
  });

  add(['GET'], /^\/tokens$/, async () => [200, { tokens: chain.listTokens() }]);

  add(['GET'], /^\/token\/([^/]+)$/, async ({ m }) => {
    const info = chain.getTokenInfo(m[1]);
    return info ? [200, info] : [404, { error: 'Token not found' }];
  });

  add(['GET'], /^\/fees$/, async () => {
    const fee = chain.tokenCreateFee();
    const minimum = chain.minBalanceToCreate();
    return [200, {
      decimals: 8,
      unit: UNITS,
      native_token: NATIVE_TOKEN,
      transfer_fee: unitsToStr(TRANSFER_FEE),
      transfer_fee_units: TRANSFER_FEE,
      token_create_fee: unitsToStr(fee),
      token_create_fee_units: fee,
      token_create_fee_cap: unitsToStr(TOKEN_CREATE_FEE_CAP),
      min_balance_to_create_token: unitsToStr(minimum),
      min_balance_to_create_token_units: minimum,
      fee_recipient: 'block_miner',
      token_create_fee_rule: '+1 BETM per 10000 accounts, +0.5 BETM per 100 custom tokens, cap 100',
      block_time_target_seconds: BLOCK_TIME_TARGET,
      genesis: GENESIS_HASH,
    }];
  });

  add(['GET'], /^\/peers$/, async () => [200, { peers: chain.knownPeersForClients() }]);

  add(['POST'], /^\/peers\/register$/, async ({ req }) => {
    let buf;
    try {
      buf = await readBody(req, 100_000);
    } catch {
      return [413, { error: 'Payload too large' }];
    }
    const vals = parseJson(buf);
    const body = isObject(vals) ? vals : {};
    if (!('url' in body)) return [400, { error: 'Peer URL required' }];
    if (!chain.registerPeer(body.url, true)) return [400, { error: 'Invalid or restricted peer URL' }];
    return [201, { message: 'Peer registered and announced', peers: chain.knownPeersForClients() }];
  });

  add(['POST'], /^\/transaction\/new$/, async ({ req }) => {
    let buf;
    try {
      buf = await readBody(req, 10240);
    } catch (e) {
      return e.tooLarge ? [413, { error: 'Payload too large' }] : [400, { error: 'Invalid JSON' }];
    }
    const tx = parseJson(buf);
    if (!isObject(tx)) return [400, { error: 'Invalid JSON' }];
    if (hasUnsafeNumber(tx)) return [400, { error: 'Numbers must be integers within 2^53' }];
    if (tx.sender === 'NETWORK' || tx.public_key === 'NETWORK') {
      return [400, { error: 'Network rewards cannot be submitted by clients' }];
    }
    const required = ['sender', 'recipient', 'amount', 'fee', 'nonce'];
    if (tx.eth_raw) required.push('eth_raw');
    else required.push('public_key', 'signature');
    if (!required.every((k) => k in tx)) return [400, { error: 'Missing transaction fields' }];
    const [ok, msg, status] = chain.submitTransaction(tx);
    return [status, ok ? { message: msg } : { error: msg }];
  });

  add(['GET'], /^\/mine\/template$/, async ({ query }) => {
    const miner = query.get('miner');
    if (!miner) return [400, { error: 'Miner address required' }];
    const tip = chain.getLatestBlock();
    const index = tip.index + 1;
    const reward = chain.getBlockReward(index);
    const difficulty = chain.expectedDifficulty(index);
    let pending = [];
    chain.scratch(() => { pending = chain.validPending().good; });
    const rewardTx = {
      sender: 'NETWORK', recipient: miner, amount: reward, fee: 0, nonce: 0,
      token_id: NATIVE_TOKEN, public_key: 'NETWORK', signature: 'REWARD',
    };
    const transactions = [...pending, rewardTx];
    return [200, {
      index,
      previous_hash: tip.hash,
      difficulty,
      protocol_version: PROTOCOL_VERSION,
      merkle_root: merkleRoot(transactions),
      transactions,
    }];
  });

  add(['POST'], /^\/block\/submit$/, async ({ req }) => {
    let buf;
    try {
      buf = await readBody(req, 2_000_000);
    } catch (e) {
      return e.tooLarge ? [413, { error: 'Block payload too large' }] : [400, { error: 'Invalid JSON' }];
    }
    const block = parseJson(buf);
    if (!isObject(block) || hasUnsafeNumber(block)) return [400, { error: 'Invalid JSON' }];
    const [ok, msg, isNew] = chain.addBlock(block, true);
    const code = ok && isNew ? 201 : (ok ? 200 : 400);
    return [code, ok ? { message: msg } : { error: msg }];
  });

  const rpc = async ({ req }) => {
    let buf;
    try {
      buf = await readBody(req, 100_000);
    } catch {
      return [413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }];
    }
    const payload = parseJson(buf);
    if (payload === undefined || payload === null) {
      return [400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }];
    }
    const [body, status] = eth.handleRpcRequest(chain, payload);
    return [status, body];
  };
  add(['POST'], /^\/rpc$/, rpc);
  add(['POST'], /^\/$/, rpc);

  add(['GET'], /^\/network$/, async ({ req }) => {
    const info = eth.networkParams(`${publicOrigin(req).replace(/\/+$/, '')}/rpc`);
    info.decimals_note = 'MetaMask shows 18 decimals; Betium stores 8 (1 unit = 1e10 wei).';
    info.gas = { gas_limit: 21000, gas_price_wei: String(ETH_GAS_PRICE_WEI) };
    return [200, info];
  });

  add(['GET'], /^\/$/, async () => [200, {
    name: 'Betium',
    symbol: NATIVE_TOKEN,
    protocol_version: PROTOCOL_VERSION,
    chain_id: ETH_CHAIN_ID,
    rpc: '/rpc',
    network: '/network',
    status: '/chain/status',
  }]);

  // Extra: the MetaMask network icon referenced by GET /network (iconUrls).
  add(['GET'], /^\/static\/betium_logo\.png$/, async () => {
    try {
      return { raw: fs.readFileSync(LOGO_FILE), type: 'image/png' };
    } catch {
      return [404, { error: 'Not found' }];
    }
  });

  async function handle(req, res) {
    const send = (status, body, rawType) => {
      const payload = rawType ? body : Buffer.from(toJson(body));
      res.writeHead(status, {
        ...CORS,
        'Content-Type': rawType || 'application/json',
        'Content-Length': payload.length,
      });
      res.end(payload);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname;
      try {
        pathname = url.pathname.split('/').map((s) => decodeURIComponent(s)).join('/');
      } catch {
        return send(404, { error: 'Not found' });
      }
      // Keep encoded slashes from creating extra segments
      const encodedAware = url.pathname.split('/').map((s) => decodeURIComponent(s).replace(/\//g, '%2F')).join('/');
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const candidates = routes
        .map((r) => ({ r, m: r.re.exec(encodedAware) }))
        .filter((x) => x.m);
      if (!candidates.length) return send(404, { error: 'Not found' });
      if (method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      const hit = candidates.find((x) => x.r.methods.includes(method));
      if (!hit) return send(405, { error: 'Method not allowed' });
      const out = await hit.r.handler({ req, m: hit.m, query: url.searchParams, pathname });
      if (Array.isArray(out)) return send(out[0], out[1]);
      return send(200, out.raw, out.type);
    } catch (exc) {
      if (process.env.BETIUM_VERBOSE) console.error(exc);
      return send(500, { error: 'Internal server error' });
    }
  }

  const server = http.createServer(handle);
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

module.exports = { createServer };
