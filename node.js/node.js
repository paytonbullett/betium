#!/usr/bin/env node
'use strict';
/**
 * Betium full node (Node.js port).
 *
 * Every node checks the same genesis, downloads blocks, and keeps the chain
 * with the most proof-of-work. Balances are computed locally in integer units.
 */

const args = process.argv.slice(2);

function printHelp() {
  console.log(`Betium Node - usage:
  node node.js [-h|--help]
  node node.js <my_public_url> [bootstrap_peer_url]

  my_public_url     Externally reachable URL of this node (http://1.2.3.4:5000)
  bootstrap_peer    Optional existing peer. There is no central tracker.

Environment:
  PORT                  Listen port (default 5000)
  HOST                  Listen address (default 0.0.0.0)
  BETIUM_AUTO_MINER     Address that receives rewards for blocks this node auto-mines
                        (default 0x00000000000000000000000000000000000000b1)
  BETIUM_VERBOSE=1      Extra logging

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
`);
  process.exit(0);
}

if (args.some((a) => a === '-h' || a === '--help')) printHelp();

const { Blockchain } = require('./lib/chain');
const { createServer } = require('./lib/server');
const { PROTOCOL_VERSION, GENESIS_HASH } = require('./consensus');

function main() {
  const myUrl = args[0] || null;
  const bootstrap = args[1] || null;
  const port = Number(process.env.PORT || 5000);
  const host = process.env.HOST || '0.0.0.0';

  let chain;
  try {
    chain = new Blockchain();
  } catch (e) {
    console.error(`[-] ${e.message}`);
    process.exit(1);
  }
  if (myUrl) chain.startNetwork(myUrl, bootstrap);

  const server = createServer(chain);
  server.on('error', (e) => {
    console.error(`[-] Cannot listen on ${host}:${port}: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`[*] Betium node on ${host}:${port}  protocol v${PROTOCOL_VERSION}`);
    console.log(`[*] Genesis ${GENESIS_HASH}`);
    if (myUrl) console.log(`[*] Announced URL: ${myUrl}`);
  });

  const stop = () => {
    server.close();
    chain.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
