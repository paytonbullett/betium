#!/usr/bin/env python3
import os
import sqlite3
import requests
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

DB_FILE = "betium_chain.db"
PEER_NODE = "https://crypto.bullettsocial.space"
BATCH_WINDOW = 45
MAX_WORKERS = 16

def get_local_height():
    if not os.path.exists(DB_FILE):
        return 0
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("SELECT MAX(index) FROM blocks")
        row = cursor.fetchone()
        conn.close()
        return row[0] if row and row[0] is not None else 0
    except Exception:
        return 0

def fast_bootstrap():
    print("[*] Checking local chain height for fast bootstrap...")
    local_height = get_local_height()
    print(f"[*] Current local height: {local_height}")

    session = requests.Session()
    
    # 1. Fetch headers from source node
    try:
        res = session.get(f"{PEER_NODE}/headers?from=0", timeout=15)
        headers = res.json().get("headers", [])
    except Exception as e:
        print(f"[!] Failed to fetch headers from peer: {e}")
        return

    if not headers:
        print("[!] No headers found on peer node.")
        return

    target_headers = [h for h in headers if h["index"] > local_height]
    if not target_headers:
        print("[*] Node is already up to date with the peer.")
        return

    total = len(target_headers)
    print(f"[*] Bootstrapping {total} missing blocks from peer...")

    start_time = time.time()
    synced = 0
    pointer = 0

    def fetch_and_submit(idx):
        try:
            r = session.get(f"{PEER_NODE}/block/{idx}", timeout=8)
            if r.status_code == 200:
                bdata = r.json().get("block")
                if bdata:
                    # Direct insert or submit locally depending on your app design
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
