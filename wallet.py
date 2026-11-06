#!/usr/bin/env python3
"""Betium wallet. Talks to the heaviest chain it can find, and checks more than one node."""

import hashlib
import json
import os
import sys
from decimal import Decimal
from urllib.parse import urlparse

import requests
from ecdsa import SigningKey, SECP256k1

import ethcompat
from consensus import (
    MIN_BALANCE_TO_CREATE,
    NATIVE_TOKEN,
    TOKEN_CREATE_FEE,
    TRANSFER_FEE,
    UNITS,
    canonical_tx,
    dumps,
    parse_units,
    units_to_str,
)

WALLET_FILE = "wallet.json"
PEER_CACHE_FILE = "client_peers.json"


def print_help():
    print("""Betium Wallet – usage:
  python3 wallet.py [-h|--help]
  python3 wallet.py                         Show address and BETM balance
  python3 wallet.py balance [TOKEN_ID]      Balance of BETM or a custom token
  python3 wallet.py send <TO> <AMOUNT>      Send BETM. Fee is 0.00010000 BETM.
  python3 wallet.py send <TOKEN_ID> <TO> <AMOUNT>
                                            Send a custom token. Fee is paid in BETM.
  python3 wallet.py cancel <NONCE>          Cancel a pending tx by nonce (RBF zero self-send)
  python3 wallet.py link                    Link native + 0x (registers mapping & migrates balance)
  python3 wallet.py create <TOKEN_ID> <NAME> <SYMBOL> <SUPPLY>
                                            Create a token. The fee rises with use.
  python3 wallet.py tokens
  python3 wallet.py token <TOKEN_ID>
  python3 wallet.py fees
  python3 wallet.py eth                     Show the 0x (MetaMask) address for this wallet's key
                                            and its BETM balance (synced with the native address)
  python3 wallet.py eth --export-key        Print the private key to import into MetaMask
                                            (anyone with it controls the funds)

<TO> may be a 64-character Betium address or a 0x MetaMask address (lowercase).
Native and 0x addresses auto-link whenever you check balance (default run, balance,
or eth). A one-time fee is paid only when they are out of sync. After the next
block both sides show the same total. Pending transfers are 0-conf; cancel with
'cancel <nonce>'.

Amounts are decimal with at most 8 places. The wallet asks every known node
for chain status and uses the chain with the most proof-of-work.
Set BETIUM_NODE to the first node you know.
""")
    sys.exit(0)


def parse_betm(text):
    """Parse a human amount in BETM ('1' = 1 BETM, '0.5' = half). Max 8 decimal places."""
    try:
        value = Decimal(str(text).strip())
    except Exception:
        return None
    if not value.is_finite() or value != value.quantize(Decimal("0.00000001")):
        return None
    return int(value * UNITS)


def _clean_node_url(url):
    if not url or not isinstance(url, str):
        return None
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def load_known_nodes():
    if not os.path.exists(PEER_CACHE_FILE):
        return []
    try:
        with open(PEER_CACHE_FILE, "r") as f:
            data = json.load(f)
    except Exception:
        return []
    cleaned, seen = [], set()
    for item in data if isinstance(data, list) else []:
        url = _clean_node_url(item)
        if url and url not in seen:
            seen.add(url)
            cleaned.append(url)
    return cleaned


def remember_nodes(extra):
    merged, seen = [], set()
    for raw in load_known_nodes() + list(extra or []):
        url = _clean_node_url(raw)
        if url and url not in seen:
            seen.add(url)
            merged.append(url)
    tmp = PEER_CACHE_FILE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(merged, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, PEER_CACHE_FILE)
    except Exception:
        pass
    return merged


def candidate_nodes():
    nodes = []
    env_node = os.environ.get("BETIUM_NODE")
    if env_node:
        nodes.append(env_node)
    for node in load_known_nodes():
        if node not in nodes:
            nodes.append(node)
    return nodes


def harvest(node_url):
    try:
        res = requests.get(f"{node_url}/peers", timeout=3)
        if res.status_code != 200:
            return None
        peers = res.json().get("peers", [])
        remember_nodes([node_url] + list(peers))
        status = requests.get(f"{node_url}/chain/status", timeout=3)
        work = 0
        genesis = None
        if status.status_code == 200:
            body = status.json()
            work = int(body.get("work", "0"))
            genesis = body.get("genesis")
        return {"url": _clean_node_url(node_url) or node_url, "work": work, "genesis": genesis}
    except Exception:
        return None


def best_node():
    """Pick the reachable node advertising the most work on this genesis."""
    ranked = []
    genesis = None
    for node in candidate_nodes():
        info = harvest(node)
        if not info:
            continue
        if info["genesis"]:
            if genesis is None:
                genesis = info["genesis"]
            if info["genesis"] != genesis:
                continue
        ranked.append(info)
    if not ranked:
        print("[-] No reachable nodes. Set BETIUM_NODE for the first connection.")
        sys.exit(1)
    ranked.sort(key=lambda item: item["work"], reverse=True)
    return ranked[0]["url"], ranked


def _wallet_data():
    if not os.path.exists(WALLET_FILE):
        return None
    try:
        with open(WALLET_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return None


def _save_wallet_data(data):
    tmp = WALLET_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, WALLET_FILE)


def load_or_create_wallet():
    data = _wallet_data()
    if data and data.get("private_key") and data.get("address"):
        return data["private_key"], data["address"]
    sk = SigningKey.generate(curve=SECP256k1)
    private_key_hex = sk.to_string().hex()
    pub = sk.get_verifying_key().to_string()
    address = hashlib.sha256(pub).hexdigest()
    eth_addr = ethcompat.pubkey_to_address(pub)
    data = {
        "private_key": private_key_hex,
        "address": address,
        "eth_address": eth_addr,
        "auto_linked": False,
    }
    _save_wallet_data(data)
    print(f"[+] Generated new Betium wallet")
    print(f"    Native address : {address}")
    print(f"    MetaMask (0x)  : {eth_addr}")
    print("    Balances will auto-link once you have funds and run any balance command.")
    return private_key_hex, address


def eth_address_for(private_key_hex):
    return ethcompat.pubkey_to_address(
        ethcompat.private_to_public(int(private_key_hex, 16))
    )


def get_balance(address, token_id=NATIVE_TOKEN):
    node, ranked = best_node()
    path = f"/balance/{address}" if token_id == NATIVE_TOKEN else f"/balance/{address}/{token_id}"
    readings = []
    for info in ranked:
        try:
            res = requests.get(f"{info['url']}{path}", timeout=5)
            if res.status_code == 200:
                data = res.json()
                readings.append((info["work"], info["url"], data))
        except Exception:
            continue
    if not readings:
        return None, None, node
    readings.sort(key=lambda item: item[0], reverse=True)
    work, url, data = readings[0]
    units = data.get("balance_units")
    if units is None:
        units = parse_units(data.get("balance"))
    disagree = [item for item in readings if item[2].get("balance_units") != units]
    if disagree:
        print(f"[!] Nodes disagree on this balance. Using the heaviest chain ({work} work) via {url}.")
    return int(units), int(data.get("nonce", 0)), url


def _sign_and_broadcast(private_key_hex, payload):
    sk = SigningKey.from_string(bytes.fromhex(private_key_hex), curve=SECP256k1)
    public_key_hex = sk.get_verifying_key().to_string().hex()
    signature = sk.sign(dumps(canonical_tx({**payload, "public_key": public_key_hex})).encode()).hex()
    full_tx = {**payload, "public_key": public_key_hex, "signature": signature}
    node, ranked = best_node()
    targets = []
    for info in ranked:
        if info["url"] not in targets:
            targets.append(info["url"])
    if node not in targets:
        targets.insert(0, node)
    accepted = 0
    last_error = "no response"
    for url in targets:
        try:
            res = requests.post(f"{url}/transaction/new", json=full_tx, timeout=5)
            if res.status_code in (200, 201):
                accepted += 1
            else:
                last_error = res.json().get("error", res.text)
        except Exception as exc:
            last_error = str(exc)
    if accepted:
        print(f"[+] Transaction accepted by {accepted} node(s).")
        return True
    print(f"[-] Transaction rejected: {last_error}")
    return False


def send_transaction(private_key_hex, sender, recipient, amount_text, token_id=NATIVE_TOKEN):
    amount = parse_betm(amount_text)
    if amount is None or amount <= 0:
        print("[-] Amount must be positive with at most 8 decimal places.")
        return
    if not ethcompat.valid_account_id(recipient):
        print("[-] Recipient must be a 64-character Betium address or a lowercase 0x address.")
        return
    token_balance, nonce, _node = get_balance(sender, token_id)
    if token_balance is None:
        print("[-] Failed to fetch account state.")
        return
    if token_id == NATIVE_TOKEN:
        if token_balance < amount + TRANSFER_FEE:
            print(f"[-] Need {units_to_str(amount + TRANSFER_FEE)} BETM including the fee. "
                  f"You have {units_to_str(token_balance)}.")
            return
    else:
        if token_balance < amount:
            print(f"[-] Insufficient {token_id}.")
            return
        betm, nonce, _node = get_balance(sender, NATIVE_TOKEN)
        if betm is None or betm < TRANSFER_FEE:
            print(f"[-] Need {units_to_str(TRANSFER_FEE)} BETM for the fee.")
            return
    payload = {
        "sender": sender,
        "recipient": recipient,
        "amount": amount,
        "fee": TRANSFER_FEE,
        "nonce": nonce + 1,
    }
    if token_id != NATIVE_TOKEN:
        payload["token_id"] = token_id
    if _sign_and_broadcast(private_key_hex, payload):
        print(f"[+] Sent {units_to_str(amount)} {token_id} to {recipient}")
        print(f"    Fee: {units_to_str(TRANSFER_FEE)} BETM, paid to the miner")


def cancel_transaction(private_key_hex, sender, nonce_text):
    """Replace a pending tx with a zero-value self-transfer at a higher fee (RBF cancel)."""
    try:
        target_nonce = int(nonce_text)
    except (TypeError, ValueError):
        print("[-] Nonce must be an integer.")
        return
    if target_nonce < 1:
        print("[-] Nonce must be >= 1.")
        return
    betm, current_nonce, _node = get_balance(sender, NATIVE_TOKEN)
    if betm is None:
        print("[-] Failed to fetch account state.")
        return
    # Cancel fee is 2× the normal transfer fee so it reliably replaces the original.
    cancel_fee = TRANSFER_FEE * 2
    if betm < cancel_fee:
        print(f"[-] Need {units_to_str(cancel_fee)} BETM for the cancel fee.")
        return
    payload = {
        "sender": sender,
        "recipient": sender,
        "amount": 0,
        "fee": cancel_fee,
        "nonce": target_nonce,
    }
    if _sign_and_broadcast(private_key_hex, payload):
        print(f"[+] Cancel broadcast for nonce {target_nonce}.")
        print(f"    Fee: {units_to_str(cancel_fee)} BETM (RBF). Pending tx with that nonce is replaced.")


def _balances_need_link(native_bal, eth_bal):
    """True when the two views disagree (mapping not registered yet)."""
    if native_bal is None or eth_bal is None:
        return False
    return native_bal != eth_bal


def ensure_auto_link(private_key_hex, sender, force=False):
    """If native and 0x balances differ, broadcast a one-time link tx so the node
    registers the mapping and migrates funds. Skips if already marked linked in
    wallet.json and balances already match (unless force=True)."""
    eth_addr = eth_address_for(private_key_hex)
    data = _wallet_data() or {}
    native_bal, native_nonce, _ = get_balance(sender, NATIVE_TOKEN)
    eth_bal, eth_nonce, _ = get_balance(eth_addr, NATIVE_TOKEN)

    if native_bal is None and eth_bal is None:
        return False

    already_flagged = bool(data.get("auto_linked"))
    needs = _balances_need_link(native_bal or 0, eth_bal or 0)

    if not force and already_flagged and not needs:
        return False
    if not needs and not force:
        # Mark linked so future runs stay quiet.
        if not already_flagged and native_bal is not None:
            data["auto_linked"] = True
            data["eth_address"] = eth_addr
            _save_wallet_data({**data, "private_key": private_key_hex, "address": sender})
        return False

    # Prefer the side that actually has funds to pay the fee.
    pay_from = sender
    pay_bal = native_bal or 0
    pay_nonce = native_nonce or 0
    if (eth_bal or 0) > pay_bal:
        # Funds only (or mostly) on 0x — still must sign as native sender for
        # the native tx path; if 0x has everything, user must send from MetaMask
        # once or fund native. Try native first.
        pass

    if pay_bal < TRANSFER_FEE:
        # Try eth side only for messaging; native signing path needs native balance.
        if (eth_bal or 0) >= TRANSFER_FEE and needs:
            print("[!] Balances differ but the native address needs "
                  f"{units_to_str(TRANSFER_FEE)} BETM to pay the auto-link fee.")
            print(f"    Native: {units_to_str(native_bal or 0)}  |  0x: {units_to_str(eth_bal or 0)}")
            print("    Send a tiny amount to the native address, or run: python3 wallet.py link")
        return False

    payload = {
        "sender": sender,
        "recipient": sender,
        "amount": 0,
        "fee": TRANSFER_FEE,
        "nonce": pay_nonce + 1,
    }
    print(f"[*] Auto-linking native ↔ MetaMask addresses…")
    print(f"    Native : {sender}")
    print(f"    0x     : {eth_addr}")
    print(f"    Native balance {units_to_str(native_bal or 0)} → will sync after next block")
    if _sign_and_broadcast(private_key_hex, payload):
        data["auto_linked"] = True
        data["eth_address"] = eth_addr
        data["private_key"] = private_key_hex
        data["address"] = sender
        _save_wallet_data(data)
        print(f"[+] Link broadcast (fee {units_to_str(TRANSFER_FEE)} BETM). "
              "Both addresses will match after the next block.")
        return True
    print("[-] Auto-link transaction was not accepted.")
    return False


def link_addresses(private_key_hex, sender):
    """Manual force-link (same as auto-link with force=True)."""
    ensure_auto_link(private_key_hex, sender, force=True)


def live_create_requirements(node):
    fee, minimum = TOKEN_CREATE_FEE, max(MIN_BALANCE_TO_CREATE, TOKEN_CREATE_FEE)
    try:
        res = requests.get(f"{node}/fees", timeout=5)
        if res.status_code == 200:
            data = res.json()
            fee = int(data.get("token_create_fee_units", fee))
            minimum = int(data.get("min_balance_to_create_token_units", minimum))
    except Exception:
        pass
    return fee, max(minimum, fee)


def create_token(private_key_hex, sender, token_id, name, symbol, supply_text):
    supply = parse_betm(supply_text)
    if supply is None or supply <= 0:
        print("[-] Supply must be positive with at most 8 decimal places.")
        return
    betm, nonce, node = get_balance(sender, NATIVE_TOKEN)
    if betm is None:
        print("[-] Failed to fetch account state.")
        return
    fee, minimum = live_create_requirements(node)
    if betm < minimum:
        print(f"[-] You need at least {units_to_str(minimum)} BETM. You have {units_to_str(betm)}.")
        return
    payload = {
        "sender": sender,
        "recipient": sender,
        "amount": 0,
        "fee": fee,
        "nonce": nonce + 1,
        "action": "create_token",
        "token_id": token_id,
        "token_name": name,
        "token_symbol": symbol,
        "initial_supply": supply,
    }
    if _sign_and_broadcast(private_key_hex, payload):
        print("[+] Create-token transaction broadcast.")
        print(f"    token_id: {token_id}  supply: {units_to_str(supply)}")
        print(f"    fee: {units_to_str(fee)} BETM, paid to the miner")


def list_tokens():
    node, _ranked = best_node()
    res = requests.get(f"{node}/tokens", timeout=5)
    tokens = res.json().get("tokens", []) if res.status_code == 200 else []
    if not tokens:
        print("[*] No custom tokens.")
        return
    for token in tokens:
        print(f"{token['token_id']:<20} {token['symbol']:<10} {token['total_supply']:>20}  {token['creator'][:16]}")


def show_token(token_id):
    node, _ranked = best_node()
    res = requests.get(f"{node}/token/{token_id}", timeout=5)
    if res.status_code != 200:
        print(f"[-] Token '{token_id}' not found.")
        return
    print(json.dumps(res.json(), indent=2))


def show_fees():
    node, ranked = best_node()
    print(f"Transfer fee           : {units_to_str(TRANSFER_FEE)} BETM")
    print("Token creation fee     : 1 BETM + 1 per 10,000 accounts + 0.5 per 100 tokens (cap 100)")
    print(f"Heaviest node          : {node}")
    try:
        res = requests.get(f"{node}/fees", timeout=5)
        if res.status_code == 200:
            print(json.dumps(res.json(), indent=2))
    except Exception as exc:
        print(f"(fee endpoint failed: {exc})")
    if len(ranked) > 1:
        print(f"Known reachable nodes  : {len(ranked)}")


def show_eth(export_key, private_key_hex):
    eth_addr = eth_address_for(private_key_hex)
    _, native_addr = load_or_create_wallet()
    # Auto-link whenever balances are checked and they are out of sync.
    ensure_auto_link(private_key_hex, native_addr)
    print(f"MetaMask (0x) address : {eth_addr}")
    eth_bal, eth_nonce, node = get_balance(eth_addr)
    nat_bal, nat_nonce, _ = get_balance(native_addr)
    if eth_bal is None:
        print("Live Balance (0x)     : unable to reach a node.")
    else:
        print(f"Live Balance (0x)     : {units_to_str(eth_bal)} BETM (nonce {eth_nonce}) via {node}")
    if nat_bal is not None:
        print(f"Live Balance (native) : {units_to_str(nat_bal)} BETM (nonce {nat_nonce})")
        if eth_bal is not None and eth_bal == nat_bal:
            print("[+] Native and 0x balances are synchronized.")
        elif eth_bal is not None:
            print("[*] Link was broadcast; balances will match after the next block.")
    if export_key:
        print("\n!! PRIVATE KEY (MetaMask > Add account > Import account). Never share it:")
        print(private_key_hex)
    else:
        print("Run 'python3 wallet.py eth --export-key' to print the key for importing.")


def main():
    if any(arg in ("-h", "--help") for arg in sys.argv[1:]):
        print_help()
    private_key, address = load_or_create_wallet()
    eth_addr = eth_address_for(private_key)

    if len(sys.argv) == 1:
        # Default: show both addresses, auto-link if needed, then balances.
        ensure_auto_link(private_key, address)
        print(f"Wallet Address (native) : {address}")
        print(f"MetaMask (0x) address   : {eth_addr}")
        balance, nonce, node = get_balance(address)
        eth_bal, eth_nonce, _ = get_balance(eth_addr)
        if balance is None:
            print("Live Balance (native)  : unable to reach a node.")
        else:
            print(f"Live Balance (native)  : {units_to_str(balance)} BETM (nonce {nonce}) via {node}")
        if eth_bal is not None:
            print(f"Live Balance (0x)      : {units_to_str(eth_bal)} BETM (nonce {eth_nonce})")
            if balance is not None and balance == eth_bal:
                print("[+] Native and 0x balances are synchronized.")
            elif balance is not None:
                print("[*] Link pending — balances will match after the next block.")
        return

    cmd = sys.argv[1]
    if cmd == "balance":
        ensure_auto_link(private_key, address)
        token_id = sys.argv[2] if len(sys.argv) >= 3 else NATIVE_TOKEN
        balance, nonce, node = get_balance(address, token_id)
        print(f"Address (native) : {address}")
        print(f"MetaMask (0x)    : {eth_addr}")
        print(f"Token            : {token_id}")
        print(f"Balance (native) : {units_to_str(balance) if balance is not None else 'unknown'}")
        if token_id == NATIVE_TOKEN:
            eth_bal, eth_nonce, _ = get_balance(eth_addr)
            if eth_bal is not None:
                print(f"Balance (0x)     : {units_to_str(eth_bal)} BETM (nonce {eth_nonce})")
        print(f"Nonce            : {nonce}")
        print(f"Node             : {node}")
    elif cmd == "send" and len(sys.argv) == 4:
        send_transaction(private_key, address, sys.argv[2], sys.argv[3], NATIVE_TOKEN)
    elif cmd == "send" and len(sys.argv) == 5:
        send_transaction(private_key, address, sys.argv[3], sys.argv[4], sys.argv[2])
    elif cmd == "cancel" and len(sys.argv) == 3:
        cancel_transaction(private_key, address, sys.argv[2])
    elif cmd == "link":
        link_addresses(private_key, address)
    elif cmd == "create" and len(sys.argv) == 6:
        create_token(private_key, address, sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
    elif cmd == "eth" and len(sys.argv) in (2, 3) and (len(sys.argv) == 2 or sys.argv[2] == "--export-key"):
        show_eth(len(sys.argv) == 3, private_key)
    elif cmd == "tokens":
        list_tokens()
    elif cmd == "token" and len(sys.argv) == 3:
        show_token(sys.argv[2])
    elif cmd == "fees":
        show_fees()
    else:
        print_help()


if __name__ == "__main__":
    main()
