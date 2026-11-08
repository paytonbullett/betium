'use strict';
/** Proof-of-work worker thread for miner.js: tries nonces start, start+step, ... */
const { parentPort } = require('node:worker_threads');
const crypto = require('node:crypto');

function leadingZeroBits(digest, bits) {
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (digest[i] !== 0) return false;
  const rem = bits & 7;
  return rem === 0 || (digest[full] >> (8 - rem)) === 0;
}

parentPort.on('message', ({ id, head, tail, bits, start, step, count }) => {
  const headBuf = Buffer.from(head);
  const tailBuf = Buffer.from(tail);
  const base = crypto.createHash('sha256').update(headBuf);
  let found = null;
  if (bits <= 256) {
    const end = start + step * count;
    for (let nonce = start; nonce < end; nonce += step) {
      const digest = base.copy().update(String(nonce)).update(tailBuf).digest();
      if (leadingZeroBits(digest, bits)) {
        found = nonce;
        break;
      }
    }
  }
  parentPort.postMessage({ id, found });
});
