'use strict';
/** Small JSON-over-HTTP helpers shared by the node, wallet and miner. */

async function fetchJson(url, ms, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const postJson = (url, body, ms) => fetchJson(url, ms, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

module.exports = { fetchJson, postJson };
