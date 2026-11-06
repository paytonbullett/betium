#!/usr/bin/env python3
"""
Betium miner – mines blocks for a given wallet address.
"""

import hashlib
import json
import time
import os
import sys
from urllib.parse import urlparse
import requests

from consensus import block_hash, difficulty_bits, dumps, meets_target

PEER_CACHE_FILE = "client_peers.json"


def print_help():
    print("""Betium Miner – usage:
  python3 miner.py [-h|--help]
  python3 miner.py <YOUR_WALLET_ADDRESS> [optional_initial_node_url] [-j N]

  YOUR_WALLET_ADDRESS   Address that will receive the block reward (BETM). Either a
                        Betium address or a lowercase 0x MetaMask address.
  optional_initial_node_url
                        Bootstrap node URL (also used to seed the peer cache)
  -j N, --threads N     Worker processes to mine with (default: all CPU cores)

The miner continuously:
  1. Obtains a mining template from a live node
  2. Performs Proof-of-Work
  3. Submits the solved block
  4. Automatically fails over to other known peers on error

client_peers.json only grows: each live node contributes its full peer list,
and older entries are never deleted just because you contacted a different node.

Examples:
  python3 miner.py  a1b2c3d4e5f6...
  python3 miner.py  a1b2c3d4e5f6...  http://203.0.113.5:5000
""")
    sys.exit(0)


def _clean_node_url(url):
    if not url or not isinstance(url, str):
        return None
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def load_known_nodes():
    if os.path.exists(PEER_CACHE_FILE):
        try:
            with open(PEER_CACHE_FILE, 'r') as f:
                data = json.load(f)
                if isinstance(data, list):
                    cleaned = []
                    seen = set()
                    for item in data:
                        n = _clean_node_url(item)
                        if n and n not in seen:
                            seen.add(n)
                            cleaned.append(n)
                    return cleaned
        except Exception:
            pass
    return []


def remember_nodes(extra):
    """Merge new node URLs into the on-disk cache. Never deletes peers already saved."""
    merged = []
    seen = set()
    for raw in load_known_nodes() + list(extra or []):
        n = _clean_node_url(raw)
        if not n or n in seen:
            continue
        seen.add(n)
        merged.append(n)
    tmp = PEER_CACHE_FILE + ".tmp"
    try:
        with open(tmp, 'w') as f:
            json.dump(merged, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, PEER_CACHE_FILE)
    except Exception:
        pass
    return merged


def get_active_node(preferred_url=None):
    known = load_known_nodes()
    candidates = []
    if preferred_url:
        candidates.append(preferred_url)
    for n in known:
        if n not in candidates:
            candidates.append(n)

    if not candidates:
        print("[-] Error: No known node URLs! Pass a node URL as an argument to bootstrap.")
        return None

    for node_url in candidates:
        try:
            res = requests.get(f"{node_url}/peers", timeout=3)
            if res.status_code == 200:
                peers = res.json().get('peers', [])
                remember_nodes([node_url] + list(peers))
                return _clean_node_url(node_url) or node_url
        except Exception:
            continue
    return None


def _search(job):
    """Try nonces start, start+step, ... and return the first that meets the target."""
    head, tail, bits, start, step, count = job
    shift = 256 - bits
    sha256 = hashlib.sha256
    from_bytes = int.from_bytes
    for nonce in range(start, start + step * count, step):
        if from_bytes(sha256(head + str(nonce).encode() + tail).digest(), "big") >> shift == 0:
            return nonce
    return None


def _job_parts(template, timestamp):
    """Pre-render the canonical JSON around the nonce so each attempt is one hash."""
    head = ('{"difficulty":%d,"index":%d,"merkle_root":%s,"nonce":' % (
        template["difficulty"], template["index"], json.dumps(template["merkle_root"]))).encode()
    tail = (',"previous_hash":%s,"protocol_version":%d,"timestamp":%d,"transactions":%s}' % (
        json.dumps(template["previous_hash"]), template["protocol_version"], timestamp,
        dumps(template["transactions"]))).encode()
    return head, tail


def _parse_args(argv):
    workers = os.cpu_count() or 1
    positional = []
    i = 0
    while i < len(argv):
        if argv[i] in ("-j", "--threads"):
            try:
                workers = max(1, int(argv[i + 1]))
            except (IndexError, ValueError):
                print("[-] -j needs a number, e.g. -j 4")
                sys.exit(1)
            i += 2
            continue
        positional.append(argv[i])
        i += 1
    return positional, workers


def mine():
    if any(a in ('-h', '--help') for a in sys.argv[1:]):
        print_help()

    positional, workers = _parse_args(sys.argv[1:])
    if not positional:
        print_help()

    miner_address = positional[0]
    initial_node = positional[1] if len(positional) > 1 else None
    batch = 100_000        # nonces per worker per round
    refresh_seconds = 15   # fetch a fresh template at least this often

    print(f"[*] Starting Resilient Betium Miner for address: {miner_address} ({workers} worker(s))")

    import multiprocessing
    pool = multiprocessing.Pool(workers)
    try:
        while True:
            active_node = get_active_node(initial_node)
            if not active_node:
                print("[-] All known nodes are offline! Retrying in 5 seconds...")
                time.sleep(5)
                continue

            try:
                res = requests.get(
                    f"{active_node}/mine/template?miner={miner_address}", timeout=5)
                if res.status_code != 200:
                    print(f"[-] Node {active_node} returned error. Rotating node...")
                    initial_node = None
                    time.sleep(2)
                    continue

                template = res.json()
                index = template['index']
                difficulty = template['difficulty']
                bits = difficulty_bits(difficulty, index)
                print(f"[*] Mining block #{index} via {active_node} | difficulty {difficulty} "
                      f"({bits} bits, ~{2 ** bits:,} hashes)")

                fetched = time.time()
                started = fetched
                nonce_base = 0
                solved = None
                while time.time() - fetched < refresh_seconds:
                    timestamp = int(time.time())
                    head, tail = _job_parts(template, timestamp)
                    jobs = [(head, tail, bits, nonce_base + w, workers, batch) for w in range(workers)]
                    found = [n for n in pool.map(_search, jobs) if n is not None]
                    nonce_base += workers * batch
                    if found:
                        solved = (min(found), timestamp)
                        break

                if not solved:
                    continue  # refresh the template and keep going

                nonce, timestamp = solved
                block_data = {
                    "index": index,
                    "timestamp": timestamp,
                    "transactions": template['transactions'],
                    "previous_hash": template['previous_hash'],
                    "nonce": nonce,
                    "difficulty": difficulty,
                    "protocol_version": template['protocol_version'],
                    "merkle_root": template['merkle_root'],
                }
                block_hash_hex = block_hash(block_data)
                if not meets_target(block_hash_hex, difficulty, index):
                    print("[-] Internal hash mismatch, discarding result.")
                    continue
                block_data['hash'] = block_hash_hex
                print(f"[+] BLOCK MINED! Nonce: {nonce} | Hash: {block_hash_hex} | "
                      f"Time: {time.time() - started:.2f}s")

                sub_res = requests.post(
                    f"{active_node}/block/submit", json=block_data, timeout=5)
                if sub_res.status_code == 201:
                    print(f"[+] Block accepted by network via {active_node}!")
                else:
                    print(f"[-] Block rejected: "
                          f"{sub_res.json().get('error', 'Unknown error')}")

            except requests.exceptions.RequestException:
                print(f"[-] Connection lost to node {active_node}. Finding a healthy backup node...")
                initial_node = None
                time.sleep(2)
            except Exception as e:
                print(f"[-] Miner error: {e}")
                time.sleep(2)
    except KeyboardInterrupt:
        print("\n[*] Miner stopped.")
    finally:
        pool.terminate()


if __name__ == '__main__':
    mine()
