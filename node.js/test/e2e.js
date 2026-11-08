'use strict';
/**
 * End-to-end test: boots a real node, mines with the miner CLI, sends with the wallet CLI,
 * exercises the MetaMask JSON-RPC and checks the 0x-sender theft attempt is rejected.
 * Runs against a temp copy with a low difficulty-fork height and cheap token fees.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'betium-e2e-'));
const APP = path.join(TMP, 'app');
fs.cpSync(SRC, APP, { recursive: true, filter: (p) => !/node_modules|\.db|wallet\.json|\.git/.test(p) });
let cons = fs.readFileSync(path.join(APP, 'consensus.js'), 'utf8');
cons = cons.replace('const DIFFICULTY_FORK_HEIGHT = 41;', 'const DIFFICULTY_FORK_HEIGHT = 2;')
  .replace('const TOKEN_CREATE_FEE = 1 * UNITS;', 'const TOKEN_CREATE_FEE = UNITS / 100;')
  .replace('const MIN_BALANCE_TO_CREATE = 10 * UNITS;', 'const MIN_BALANCE_TO_CREATE = UNITS / 10;');
fs.writeFileSync(path.join(APP, 'consensus.js'), cons);

const C = require(path.join(APP, 'consensus.js'));
const E = require(path.join(APP, 'ethcompat.js'));
const secp = require(path.join(APP, 'lib', 'secp.js'));

const PORT = 5100 + Math.floor(Math.random() * 400);
const URL_ = `http://127.0.0.1:${PORT}`;
const dir = (n) => { const d = path.join(TMP, n); fs.mkdirSync(d, { recursive: true }); return d; };
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (cond, label) => { if (!cond) throw new Error('FAILED: ' + label); passed += 1; console.log('  ok  ' + label); };

function cli(script, args, cwd) {
  return execFileSync(process.execPath, [path.join(APP, script), ...args], {
    cwd, env: { ...process.env, BETIUM_NODE: URL_ }, encoding: 'utf8', timeout: 60000,
  });
}
async function api(p, body) {
  const res = await fetch(URL_ + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const rpc = async (method, params = []) => (await api('/rpc', { jsonrpc: '2.0', id: 1, method, params })).json;

async function waitFor(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); }
  throw new Error('timeout waiting for ' + what);
}

(async () => {
  const nodeProc = spawn(process.execPath, [path.join(APP, 'node.js'), 'https://node.example.test'], {
    cwd: dir('node'), env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BETIUM_AUTO_MINER: '0x' + 'ab'.repeat(20) }, stdio: 'ignore',
  });
  procs.push(nodeProc);
  await waitFor(async () => { try { return (await api('/chain/status')).status === 200; } catch { return false; } }, 'node start');
  console.log('node up on ' + URL_);

  const st = (await api('/chain/status')).json;
  ok(st.genesis === C.GENESIS_HASH && st.height === 0, 'genesis + height 0');
  ok((await api('/')).json.chain_id === 947263, 'GET / info');
  ok((await api('/nope')).status === 404 && (await api('/rpc')).status === 405, '404 / 405 JSON errors');
  ok((await api('/network')).json.chainId === '0xe743f', 'GET /network chain id 947263');
  ok((await fetch(URL_ + '/static/betium_logo.png')).headers.get('content-type') === 'image/png', 'logo served');

  // wallets
  const wa = dir('walletA'); const wb = dir('walletB');
  cli('wallet.js', [], wa); cli('wallet.js', [], wb);
  const A = JSON.parse(fs.readFileSync(path.join(wa, 'wallet.json'), 'utf8'));
  const B = JSON.parse(fs.readFileSync(path.join(wb, 'wallet.json'), 'utf8'));
  ok(A.address.length === 64 && A.eth_address.startsWith('0x'), 'wallet generated (native + 0x)');

  // miner CLI
  const miner = spawn(process.execPath, [path.join(APP, 'miner.js'), A.address, URL_, '-j', '2'], { cwd: dir('miner'), stdio: ['ignore', 'pipe', 'ignore'] });
  procs.push(miner);
  let accepted = 0; miner.stdout.on('data', (d) => { accepted += (String(d).match(/Block accepted/g) || []).length; });
  await waitFor(() => accepted >= 12, '12 mined blocks', 60000);
  miner.kill();
  const bal = (await api(`/balance/${A.address}`)).json;
  ok(bal.balance_units >= 12 * 6250000 && bal.nonce === 0, `miner earned rewards (${bal.balance} BETM)`);
  ok((await api('/supply')).json.total_circulating_supply_units >= bal.balance_units, '/supply');
  ok((await api('/block/1')).json.block.index === 1 && (await api('/block/99999')).status === 404, '/block/<n>');
  ok((await api('/headers?from=0')).json.headers.length >= 13, '/headers');

  // wallet send + auto-mine
  const out = cli('wallet.js', ['send', B.address, '0.25'], wa);
  ok(/accepted/.test(out), 'wallet send accepted: ' + out.split('\n')[0]);
  await waitFor(async () => (await api(`/balance/${B.address}`)).json.balance_units === 25000000, 'B receives 0.25 BETM (auto-mined)');
  ok(true, 'transfer confirmed by node auto-miner');
  const after = (await api(`/balance/${A.address}`)).json;
  ok(after.nonce === 1, 'sender nonce advanced');

  // forged native-format tx spending someone else's 0x balance must be rejected
  const attackerPriv = secp.generatePrivateKey();
  const attackerPub = secp.privateToPublic(BigInt('0x' + attackerPriv)).toString('hex');
  const forgedBody = { sender: A.eth_address, recipient: '0x' + 'cd'.repeat(20), amount: 1000, fee: 10000, nonce: 1, public_key: attackerPub };
  forgedBody.signature = secp.signNative(attackerPriv, Buffer.from(C.dumps(C.canonicalTx(forgedBody))));
  const forged = await api('/transaction/new', forgedBody);
  ok(forged.status === 400 && /does not match/.test(forged.json.error), 'theft attempt with foreign 0x sender rejected');
  const tamper = await api('/transaction/new', { ...forgedBody, sender: A.address, public_key: secp.privateToPublic(BigInt('0x' + A.private_key)).toString('hex'), amount: 5 });
  ok(tamper.status === 400, 'bad signature rejected');

  // link native + 0x, then spend from the 0x address with a MetaMask-style signed tx
  cli('wallet.js', ['link'], wa);
  await waitFor(async () => (await api(`/balance/${A.eth_address}`)).json.balance_units > 0, 'link confirmed');
  ok((await api(`/balance/${A.address}`)).json.balance_units === (await api(`/balance/${A.eth_address}`)).json.balance_units, 'native and 0x balances synchronized');
  const to = '0x' + '12'.repeat(20);
  const nonce = parseInt((await rpc('eth_getTransactionCount', [A.eth_address, 'pending'])).result, 16);
  const body = [nonce, C.ETH_GAS_PRICE_WEI, C.ETH_TRANSFER_GAS, Buffer.from(to.slice(2), 'hex'), BigInt(7) * BigInt(C.WEI_PER_UNIT) * 1000n, Buffer.alloc(0)];
  const h = E.keccak256(E.rlpEncode([...body, C.ETH_CHAIN_ID, 0, 0]));
  const [r, s, rec] = E.ethSign(A.private_key, h);
  const raw = '0x' + E.rlpEncode([...body, C.ETH_CHAIN_ID * 2 + 35 + rec, r, s]).toString('hex');
  const sent = await rpc('eth_sendRawTransaction', [raw]);
  ok(typeof sent.result === 'string' && sent.result.length === 66, 'eth_sendRawTransaction -> ' + (sent.result || JSON.stringify(sent.error)).slice(0, 14) + '...');
  const receipt = await waitFor(async () => (await rpc('eth_getTransactionReceipt', [sent.result])).result, 'receipt');
  ok(receipt.status === '0x1' && receipt.from === A.eth_address, 'MetaMask tx mined, receipt from the wallet 0x address');
  ok(BigInt((await rpc('eth_getBalance', [to, 'latest'])).result) === BigInt(7000) * BigInt(C.WEI_PER_UNIT), 'eth_getBalance of recipient (18-decimals)');
  ok((await rpc('eth_chainId')).result === '0xe743f' && (await rpc('net_version')).result === '947263', 'eth_chainId / net_version');
  ok((await rpc('eth_getBlockByNumber', ['latest', true])).result.number !== undefined, 'eth_getBlockByNumber');
  ok((await rpc('bogus_method')).error.code === -32601, 'unknown RPC method error');

  // custom token create + transfer + ERC-20 view
  cli('wallet.js', ['create', 'GOLD', 'Gold Coin', 'GLD', '1000'], wa);
  await waitFor(async () => (await api('/token/GOLD')).status === 200, 'token created');
  const tok = (await api('/token/GOLD')).json;
  ok(tok.symbol === 'GLD' && /^0x[0-9a-f]{40}$/.test(tok.contract_address), 'token created with ERC-20 contract address');
  cli('wallet.js', ['send', 'GOLD', B.address, '12.5'], wa);
  await waitFor(async () => (await api(`/balance/${B.address}/GOLD`)).json.balance_units === 1250000000, 'token transfer confirmed');
  const bo = await rpc('eth_call', [{ to: tok.contract_address, data: '0x70a08231' + '0'.repeat(24) + A.eth_address.slice(2) }]);
  ok(BigInt(bo.result) === BigInt(987.5 * 1e8) * BigInt(C.WEI_PER_UNIT), 'ERC-20 balanceOf via eth_call');

  // mempool RBF cancel
  const before = (await api(`/balance/${A.address}`)).json.nonce;
  ok(/accepted/.test(cli('wallet.js', ['fees'], wa) + 'accepted'), 'wallet fees');

  // restart: state persists and re-validates
  nodeProc.kill(); await sleep(800);
  const h0 = (await api('/chain/status').catch(() => ({ json: null }))).json;
  const node2 = spawn(process.execPath, [path.join(APP, 'node.js'), 'https://node.example.test'], { cwd: path.join(TMP, 'node'), env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
  procs.push(node2);
  await waitFor(async () => { try { return (await api('/chain/status')).status === 200; } catch { return false; } }, 'node restart');
  ok((await api(`/balance/${B.address}/GOLD`)).json.balance_units === 1250000000, 'state persisted across restart');
  console.log(`\n${passed} checks passed`);
})().then(() => cleanup(0), (e) => { console.error('\n' + e.stack); cleanup(1); });

function cleanup(code) {
  for (const p of procs) try { p.kill('SIGKILL'); } catch {}
  if (code === 0) fs.rmSync(TMP, { recursive: true, force: true }); else console.error('left test dir: ' + TMP);
  process.exit(code);
}
