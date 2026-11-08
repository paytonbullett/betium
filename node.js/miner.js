#!/usr/bin/env node
'use strict';
/** Betium miner - mines blocks for a given wallet address. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { blockHash, difficultyBits, dumps, meetsTarget } = require('./consensus');
const { fetchJson, postJson } = require('./lib/http');

const PEER_CACHE_FILE = 'client_peers.json';

function printHelp() {
  console.log(`Betium Miner - usage:
  node miner.js [-h|--help]
  node miner.js <YOUR_WALLET_ADDRESS> [optional_initial_node_url] [-j N]

  YOUR_WALLET_ADDRESS   Address that will receive the block reward (BETM). Either a
                        Betium address or a lowercase 0x MetaMask address.
  optional_initial_node_url
                        Bootstrap node URL (also used to seed the peer cache)
  -j N, --threads N     Worker threads to mine with (default: all CPU cores)

The miner continuously:
  1. Obtains a mining template from a live node
  2. Performs Proof-of-Work
  3. Submits the solved block
  4. Automatically fails over to other known peers on error

client_peers.json only grows: each live node contributes its full peer list,
and older entries are never deleted just because you contacted a different node.

Examples:
  node miner.js a1b2c3d4e5f6...
  node miner.js a1b2c3d4e5f6... http://203.0.113.5:5000
`);
  process.exit(0);
}

function cleanNodeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = /^\s*(https?):\/\/([^/?#\s]+)/i.exec(url);
  return m ? `${m[1].toLowerCase()}://${m[2]}` : null;
}

function loadKnownNodes() {
  try {
    const data = JSON.parse(fs.readFileSync(PEER_CACHE_FILE, 'utf8'));
    const out = [];
    for (const item of Array.isArray(data) ? data : []) {
      const n = cleanNodeUrl(item);
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

function rememberNodes(extra) {
  const merged = [];
  for (const raw of [...loadKnownNodes(), ...(extra || [])]) {
    const n = cleanNodeUrl(raw);
    if (n && !merged.includes(n)) merged.push(n);
  }
  try {
    fs.writeFileSync(`${PEER_CACHE_FILE}.tmp`, JSON.stringify(merged));
    fs.renameSync(`${PEER_CACHE_FILE}.tmp`, PEER_CACHE_FILE);
  } catch {
    // best effort
  }
  return merged;
}

async function getActiveNode(preferred) {
  const candidates = [];
  if (preferred) candidates.push(preferred);
  for (const n of loadKnownNodes()) if (!candidates.includes(n)) candidates.push(n);
  if (!candidates.length) {
    console.log('[-] Error: No known node URLs! Pass a node URL as an argument to bootstrap.');
    return null;
  }
  for (const nodeUrl of candidates) {
    try {
      const res = await fetchJson(`${nodeUrl}/peers`, 3000);
      if (res.status === 200 && res.json) {
        rememberNodes([nodeUrl, ...(res.json.peers || [])]);
        return cleanNodeUrl(nodeUrl) || nodeUrl;
      }
    } catch {
      // try next
    }
  }
  return null;
}

/** Pre-render the canonical JSON around the nonce so each attempt is one hash. */
function jobParts(t, timestamp) {
  const head = `{"difficulty":${t.difficulty},"index":${t.index},"merkle_root":${JSON.stringify(t.merkle_root)},"nonce":`;
  const tail = `,"previous_hash":${JSON.stringify(t.previous_hash)},"protocol_version":${t.protocol_version},"timestamp":${timestamp},"transactions":${dumps(t.transactions)}}`;
  return [head, tail];
}

function parseArgs(argv) {
  let workers = os.cpus().length || 1;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-j' || argv[i] === '--threads') {
      const n = parseInt(argv[i + 1], 10);
      if (!Number.isInteger(n)) {
        console.log('[-] -j needs a number, e.g. -j 4');
        process.exit(1);
      }
      workers = Math.max(1, n);
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return [positional, workers];
}

class Pool {
  constructor(n) {
    this.workers = Array.from({ length: n }, () => new Worker(path.join(__dirname, 'miner-worker.js')));
    this.seq = 0;
  }

  run(jobs) {
    return Promise.all(jobs.map((job, i) => new Promise((resolve, reject) => {
      const w = this.workers[i];
      const id = ++this.seq;
      const onMsg = (m) => {
        if (m.id !== id) return;
        w.off('message', onMsg);
        w.off('error', reject);
        resolve(m.found);
      };
      w.on('message', onMsg);
      w.once('error', reject);
      w.postMessage({ id, ...job });
    })));
  }

  close() {
    for (const w of this.workers) w.terminate();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mine() {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a === '-h' || a === '--help')) printHelp();
  const [positional, workers] = parseArgs(argv);
  if (!positional.length) printHelp();

  const minerAddress = positional[0];
  let initialNode = positional[1] || null;
  const batch = 100_000; // nonces per worker per round
  const refreshMs = 15_000; // fetch a fresh template at least this often

  console.log(`[*] Starting Resilient Betium Miner for address: ${minerAddress} (${workers} worker(s))`);
  const pool = new Pool(workers);
  process.on('SIGINT', () => {
    console.log('\n[*] Miner stopped.');
    pool.close();
    process.exit(0);
  });

  for (;;) {
    const activeNode = await getActiveNode(initialNode);
    if (!activeNode) {
      console.log('[-] All known nodes are offline! Retrying in 5 seconds...');
      await sleep(5000);
      continue;
    }
    try {
      const res = await fetchJson(`${activeNode}/mine/template?miner=${encodeURIComponent(minerAddress)}`, 5000);
      if (res.status !== 200 || !res.json) {
        console.log(`[-] Node ${activeNode} returned error. Rotating node...`);
        initialNode = null;
        await sleep(2000);
        continue;
      }
      const template = res.json;
      const { index, difficulty } = template;
      const bits = difficultyBits(difficulty, index);
      console.log(`[*] Mining block #${index} via ${activeNode} | difficulty ${difficulty} (${bits} bits, ~${(2 ** bits).toLocaleString('en-US')} hashes)`);

      const fetched = Date.now();
      let nonceBase = 0;
      let solved = null;
      while (Date.now() - fetched < refreshMs) {
        const timestamp = Math.floor(Date.now() / 1000);
        const [head, tail] = jobParts(template, timestamp);
        const jobs = [];
        for (let w = 0; w < workers; w++) jobs.push({ head, tail, bits, start: nonceBase + w, step: workers, count: batch });
        const found = (await pool.run(jobs)).filter((n) => n !== null);
        nonceBase += workers * batch;
        if (found.length) {
          solved = [Math.min(...found), timestamp];
          break;
        }
      }
      if (!solved) continue; // refresh the template and keep going

      const [nonce, timestamp] = solved;
      const block = {
        index,
        timestamp,
        transactions: template.transactions,
        previous_hash: template.previous_hash,
        nonce,
        difficulty,
        protocol_version: template.protocol_version,
        merkle_root: template.merkle_root,
      };
      const digest = blockHash(block);
      if (!meetsTarget(digest, difficulty, index)) {
        console.log('[-] Internal hash mismatch, discarding result.');
        continue;
      }
      block.hash = digest;
      console.log(`[+] BLOCK MINED! Nonce: ${nonce} | Hash: ${digest} | Time: ${((Date.now() - fetched) / 1000).toFixed(2)}s`);
      const sub = await postJson(`${activeNode}/block/submit`, block, 5000);
      if (sub.status === 201) console.log(`[+] Block accepted by network via ${activeNode}!`);
      else console.log(`[-] Block rejected: ${(sub.json && sub.json.error) || 'Unknown error'}`);
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'TypeError' || e.cause)) {
        console.log(`[-] Connection lost to node ${activeNode}. Finding a healthy backup node...`);
        initialNode = null;
      } else {
        console.log(`[-] Miner error: ${e.message}`);
      }
      await sleep(2000);
    }
  }
}

mine();
