#!/usr/bin/env python3
"""Optional fast bootstrap helper.

Uses the same peer discovery model as the full node: peers.json cache and
BETIUM_BOOTSTRAP environment variable (comma-separated). Does not hardcode
any network endpoint.
"""
import os
import sqlite3
import json
import requests
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

DB_FILE = "betium_chain.db"
PEER_CACHE_FILE = "peers.json"
BATCH_WINDOW = 45
MAX_WORKERS = 16


def get_local_height():
    if not os.path.exists(DB_FILE):
        return 0
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("SELECT MAX(idx) FROM blocks")
        row = cursor.fetchone()
        conn.close()
        return row[0] if row and row[0] is not None else 0
    except Exception:
        return 0


def load_peers():
    peers = set()
    if os.path.exists(PEER_CACHE_FILE):
        try:
            with open(PEER_CACHE_FILE, "r") as f:
                data = json.load(f)
                if isinstance(data, list):
                    peers.update(data)
        except Exception:
            pass
    env = os.environ.get("BETIUM_BOOTSTRAP", "")
    for s in env.split(","):
        s = s.strip().rstrip("/")
        if s:
            peers.add(s)
    return sorted(peers)


def fast_bootstrap():
    print("[*] Checking local chain height for fast bootstrap...")
    local_height = get_local_height()
    print(f"[*] Current local height: {local_height}")

    peers = load_peers()
    if not peers:
        print("[!] No peers available. Set BETIUM_BOOTSTRAP or populate peers.json")
        return

    session = requests.Session()
    headers = None
    source = None
    for peer in peers:
        try:
            res = session.get(f"{peer}/headers?from=0", timeout=15)
            if res.status_code != 200:
                continue
            headers = res.json().get("headers", [])
            if headers:
                source = peer
                break
        except Exception as e:
            print(f"[!] Failed to fetch headers from {peer}: {e}")
            continue

    if not headers:
        print("[!] No headers found on any peer.")
        return

    target_headers = [h for h in headers if h.get("index", -1) > local_height]
    if not target_headers:
        print("[*] Node is already up to date with the peer.")
        return

    total = len(target_headers)
    print(f"[*] Bootstrapping {total} missing blocks from {source}...")

    start_time = time.time()
    synced = 0
    pointer = 0

    def fetch_and_submit(idx):
        try:
            r = session.get(f"{source}/block/{idx}", timeout=8)
            if r.status_code == 200:
                bdata = r.json().get("block")
                if bdata:
                    sub = session.post("http://127.0.0.1:5000/block/submit", json=bdata, timeout=10)
                    return sub.status_code in (200, 201) or "Already have" in sub.text
        except Exception:
            pass
        return False

    while pointer < total:
        chunk = target_headers[pointer : pointer + BATCH_WINDOW]
        indices = [h["index"] for h in chunk]

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(fetch_and_submit, idx): idx for idx in indices}
            for fut in as_completed(futures):
                if fut.result():
                    synced += 1

        pointer += len(chunk)
        print(f"[+] Bootstrapped {synced}/{total} blocks...")

    print(f"[*] Fast bootstrap complete in {time.time() - start_time:.2f} seconds!")


if __name__ == "__main__":
    fast_bootstrap()
