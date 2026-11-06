#!/usr/bin/env python3
"""
Betium <-> Ethereum wallet compatibility layer (MetaMask support).

Pure Python, no extra dependencies. Provides:
  * keccak256, RLP, secp256k1 public-key recovery
  * decoding/validation of legacy EIP-155 signed transactions
  * the JSON-RPC methods MetaMask needs (served by node.py at POST /rpc)
  * ERC-20 style support for custom Betium tokens (balanceOf, transfer, name,
    symbol, decimals, totalSupply) so MetaMask can add and use them under the
    Betium chain.

Betium keeps its own 8-decimal integer "units". MetaMask insists on 18
decimals, so the RPC layer multiplies by WEI_PER_UNIT (10**10) on the way out
and divides on the way in. Native BETM uses plain value transfers; custom
tokens are exposed as ERC-20 contracts at deterministic addresses.
"""

import sys

from consensus import (
    ETH_CHAIN_ID,
    ETH_GAS_PRICE_WEI,
    ETH_TRANSFER_GAS,
    NATIVE_TOKEN,
    PROTOCOL_VERSION,
    TRANSFER_FEE,
    work_of,
    WEI_PER_UNIT,
    parse_units,
)

CLIENT_VERSION = f"Betium/v{PROTOCOL_VERSION}"
BLOCK_GAS_LIMIT = 30_000_000
ZERO_HASH = "0x" + "0" * 64
ZERO_ADDR = "0x" + "0" * 40
EMPTY_BLOOM = "0x" + "0" * 512
NETWORK_NAME = "Betium"
DECIMALS = 18


class EthTxError(Exception):
    pass


# ---------------------------------------------------------------- keccak256

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]
_M64 = (1 << 64) - 1


def _rol(x, n):
    n %= 64
    return ((x << n) | (x >> (64 - n))) & _M64 if n else x


def _keccak_f(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data)
    msg.append(0x01)
    while len(msg) % rate:
        msg.append(0)
    msg[-1] |= 0x80
    state = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off:off + rate]
        for i in range(rate // 8):
            lane = int.from_bytes(block[8 * i:8 * i + 8], "little")
            state[i % 5][i // 5] ^= lane
        _keccak_f(state)
    out = b""
    for i in range(4):
        out += state[i % 5][i // 5].to_bytes(8, "little")
    return out[:32]


# ---------------------------------------------------------------------- RLP

def _int_bytes(n):
    return b"" if n == 0 else n.to_bytes((n.bit_length() + 7) // 8, "big")


def rlp_encode(item):
    if isinstance(item, int):
        item = _int_bytes(item)
    if isinstance(item, (bytes, bytearray)):
        item = bytes(item)
        if len(item) == 1 and item[0] < 0x80:
            return item
        return _rlp_len(len(item), 0x80) + item
    payload = b"".join(rlp_encode(x) for x in item)
    return _rlp_len(len(payload), 0xC0) + payload


def _rlp_len(length, offset):
    if length < 56:
        return bytes([offset + length])
    lb = _int_bytes(length)
    return bytes([offset + 55 + len(lb)]) + lb


def rlp_decode(data: bytes):
    item, end = _rlp_item(data, 0)
    if end != len(data):
        raise EthTxError("Trailing bytes after RLP payload")
    return item


def _rlp_item(data, pos):
    if pos >= len(data):
        raise EthTxError("RLP truncated")
    b = data[pos]
    if b < 0x80:
        return data[pos:pos + 1], pos + 1
    if b < 0xB8:
        n = b - 0x80
        s = pos + 1
        if s + n > len(data):
            raise EthTxError("RLP truncated")
        if n == 1 and data[s] < 0x80:
            raise EthTxError("Non-canonical RLP")
        return data[s:s + n], s + n
    if b < 0xC0:
        ll = b - 0xB7
        n = int.from_bytes(data[pos + 1:pos + 1 + ll], "big")
        s = pos + 1 + ll
        if n < 56 or s + n > len(data):
            raise EthTxError("Bad RLP length")
        return data[s:s + n], s + n
    if b < 0xF8:
        n = b - 0xC0
        s = pos + 1
    else:
        ll = b - 0xF7
        n = int.from_bytes(data[pos + 1:pos + 1 + ll], "big")
        s = pos + 1 + ll
        if n < 56:
            raise EthTxError("Bad RLP length")
    end = s + n
    if end > len(data):
        raise EthTxError("RLP truncated")
    items = []
    while s < end:
        it, s = _rlp_item(data, s)
        items.append(it)
    if s != end:
        raise EthTxError("Bad RLP list")
    return items, end


# ---------------------------------------------------- secp256k1 (pure python)

_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
_GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
_G = (_GX, _GY)


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2:
        if (y1 + y2) % _P == 0:
            return None
        lam = (3 * x1 * x1) * pow(2 * y1, -1, _P) % _P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, _P) % _P
    x3 = (lam * lam - x1 - x2) % _P
    return x3, (lam * (x1 - x3) - y1) % _P


def _mul(k, point):
    result = None
    addend = point
    while k:
        if k & 1:
            result = _add(result, addend)
        addend = _add(addend, addend)
        k >>= 1
    return result


def private_to_public(priv: int) -> bytes:
    pt = _mul(priv % _N, _G)
    return pt[0].to_bytes(32, "big") + pt[1].to_bytes(32, "big")


def recover_pubkey(msg_hash: bytes, r: int, s: int, recid: int) -> bytes:
    if not (1 <= r < _N and 1 <= s < _N) or recid not in (0, 1):
        raise EthTxError("Invalid signature values")
    x = r
    alpha = (pow(x, 3, _P) + 7) % _P
    beta = pow(alpha, (_P + 1) // 4, _P)
    if beta * beta % _P != alpha:
        raise EthTxError("Signature point is not on the curve")
    y = beta if (beta & 1) == recid else _P - beta
    z = int.from_bytes(msg_hash, "big")
    r_inv = pow(r, -1, _N)
    q = _mul(r_inv, _add(_mul(s, (x, y)), _mul((-z) % _N, _G)))
    if q is None:
        raise EthTxError("Recovered point at infinity")
    return q[0].to_bytes(32, "big") + q[1].to_bytes(32, "big")


def pubkey_to_address(pub64: bytes) -> str:
    return "0x" + keccak256(pub64)[-20:].hex()


def eth_sign(priv_hex: str, msg_hash: bytes):
    """Deterministic-ish signer used only by tests and wallet helpers (low-s, recid)."""
    import hashlib
    import hmac
    priv = int(priv_hex, 16)
    z = int.from_bytes(msg_hash, "big")
    k_seed = hmac.new(priv.to_bytes(32, "big"), msg_hash, hashlib.sha256).digest()
    k = int.from_bytes(k_seed, "big") % (_N - 1) + 1
    while True:
        pt = _mul(k, _G)
        r = pt[0] % _N
        s = pow(k, -1, _N) * (z + r * priv) % _N
        if r and s:
            recid = (pt[1] & 1) | (2 if pt[0] >= _N else 0)
            if s > _N // 2:
                s = _N - s
                recid ^= 1
            return r, s, recid
        k = k % (_N - 1) + 1


# --------------------------------------------------------- transaction decode

def is_hex_address(value):
    return (
        isinstance(value, str) and len(value) == 42 and value.startswith("0x")
        and all(c in "0123456789abcdef" for c in value[2:])
    )


def is_native_address(value):
    return (
        isinstance(value, str) and len(value) == 64
        and all(c in "0123456789abcdef" for c in value)
    )


def valid_account_id(value):
    return is_hex_address(value) or is_native_address(value)


def decode_raw_tx(raw_hex: str):
    """Decode and cryptographically verify a legacy EIP-155 transaction.

    Returns a dict with sender, to, value_wei, gas, gas_price, nonce, hash, v, r, s.
    Raises EthTxError for anything Betium does not accept.
    """
    if not isinstance(raw_hex, str) or not raw_hex.startswith("0x"):
        raise EthTxError("eth_raw must be a 0x-prefixed hex string")
    if len(raw_hex) > 2 + 2 * 4096:
        raise EthTxError("Transaction too large")
    try:
        raw = bytes.fromhex(raw_hex[2:])
    except ValueError:
        raise EthTxError("eth_raw is not valid hex")
    if not raw:
        raise EthTxError("Empty transaction")
    if raw[0] < 0xC0:
        raise EthTxError("Only legacy (type 0) transactions are supported")
    fields = rlp_decode(raw)
    if not isinstance(fields, list) or len(fields) != 9 or any(isinstance(f, list) for f in fields):
        raise EthTxError("Malformed legacy transaction")
    nonce_b, gp_b, gas_b, to_b, value_b, data_b, v_b, r_b, s_b = fields
    for name, b in (("nonce", nonce_b), ("gasPrice", gp_b), ("gas", gas_b), ("value", value_b),
                    ("v", v_b), ("r", r_b), ("s", s_b)):
        if len(b) > 32 or (len(b) > 1 and b[0] == 0) or (len(b) == 1 and b[0] == 0 and False):
            raise EthTxError(f"Bad {name} encoding")
    nonce = int.from_bytes(nonce_b, "big")
    gas_price = int.from_bytes(gp_b, "big")
    gas = int.from_bytes(gas_b, "big")
    value = int.from_bytes(value_b, "big")
    v = int.from_bytes(v_b, "big")
    r = int.from_bytes(r_b, "big")
    s = int.from_bytes(s_b, "big")
    if len(to_b) == 0:
        raise EthTxError("Contract creation is not supported on Betium")
    if len(to_b) != 20:
        raise EthTxError("Bad recipient address")
    if v not in (ETH_CHAIN_ID * 2 + 35, ETH_CHAIN_ID * 2 + 36):
        raise EthTxError(f"Wrong chain id. Betium requires EIP-155 signatures for chain {ETH_CHAIN_ID}")
    if s > _N // 2:
        raise EthTxError("Signature s value too high (EIP-2)")
    recid = v - (ETH_CHAIN_ID * 2 + 35)
    # Signing hash uses the actual data field (empty for plain transfers).
    signing = rlp_encode([nonce, gas_price, gas, to_b, value, data_b, ETH_CHAIN_ID, 0, 0])
    pub = recover_pubkey(keccak256(signing), r, s, recid)
    return {
        "sender": pubkey_to_address(pub),
        "to": "0x" + to_b.hex(),
        "value_wei": value,
        "gas": gas,
        "gas_price": gas_price,
        "nonce": nonce,
        "data": data_b,
        "hash": "0x" + keccak256(raw).hex(),
        "v": v, "r": r, "s": s,
    }


def build_internal_tx(raw_hex: str):
    """Turn a raw Ethereum transaction into the dict that Betium stores in blocks.

    Supports:
      - Plain BETM value transfers (data empty, value > 0)
      - ERC-20 transfer() calls to a custom-token contract address (value == 0,
        data starts with 0xa9059cbb). The token_id is resolved later by the node
        from the contract address; this function returns the contract so the
        node can look it up.
    """
    d = decode_raw_tx(raw_hex)
    data = d.get("data") or b""
    fee_wei = d["gas"] * d["gas_price"]
    if fee_wei % WEI_PER_UNIT:
        raise EthTxError("Gas price must make the fee a multiple of 0.00000001 BETM")
    fee = fee_wei // WEI_PER_UNIT
    if fee < TRANSFER_FEE:
        raise EthTxError(
            f"Fee too low: gas price must be at least "
            f"{(TRANSFER_FEE * WEI_PER_UNIT + d['gas'] - 1) // d['gas']} wei"
        )

    if not data:
        # Native BETM transfer
        if d["gas"] != ETH_TRANSFER_GAS:
            raise EthTxError(f"Gas limit must be exactly {ETH_TRANSFER_GAS} for BETM transfers")
        if d["value_wei"] <= 0 or d["value_wei"] % WEI_PER_UNIT:
            raise EthTxError("Amount must be positive and a multiple of 0.00000001 BETM")
        tx = {
            "sender": d["sender"],
            "recipient": d["to"],
            "amount": d["value_wei"] // WEI_PER_UNIT,
            "fee": fee,
            "nonce": d["nonce"] + 1,
            "eth_raw": raw_hex.lower(),
        }
        return tx, d

    # Custom token: must be an ERC-20 transfer() call, value must be zero
    if d["value_wei"] != 0:
        raise EthTxError("Token transfers must have zero value (ETH amount)")
    if d["gas"] < ETH_TRANSFER_GAS:
        raise EthTxError(f"Gas limit must be at least {ETH_TRANSFER_GAS} for token transfers")
    if len(data) < 4 + 32 + 32 or data[:4] != bytes.fromhex("a9059cbb"):
        raise EthTxError(
            "Only ERC-20 transfer(address,uint256) calls are supported for custom tokens"
        )
    # address is right-aligned in the first 32-byte word after selector
    to_bytes = data[4 + 12 : 4 + 32]
    amount_bytes = data[4 + 32 : 4 + 64]
    recipient = "0x" + to_bytes.hex()
    amount_wei = int.from_bytes(amount_bytes, "big")
    if amount_wei <= 0 or amount_wei % WEI_PER_UNIT:
        raise EthTxError(
            "Token amount must be positive and a multiple of 0.00000001 units"
        )
    amount = amount_wei // WEI_PER_UNIT
    tx = {
        "sender": d["sender"],
        "recipient": recipient,
        "amount": amount,
        "fee": fee,
        "nonce": d["nonce"] + 1,
        "eth_raw": raw_hex.lower(),
        "contract": d["to"].lower(),
        # token_id filled by node after looking up the contract
    }
    return tx, d


# ------------------------------------------------------------- JSON-RPC layer

def _hex(n):
    return hex(int(n))


def _parse_int(value):
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.startswith("0x"):
        return int(value, 16)
    raise ValueError("bad quantity")


def _account_id(value):
    if not isinstance(value, str):
        raise ValueError("Invalid address")
    v = value.lower()
    if is_hex_address(v):
        return v
    if v.startswith("0x") and is_native_address(v[2:]):
        return v[2:]
    if is_native_address(v):
        return v
    raise ValueError("Invalid address")


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def network_params(rpc_url=None):
    """wallet_addEthereumChain parameters / the values to type into MetaMask."""
    # iconUrls: host a 256×256 (or 512×512) PNG of the Betium logo at a public
    # HTTPS URL and list it here. MetaMask caches the first icon it sees.
    # Example after you upload betium_logo.png:
    #   "iconUrls": ["https://crypto.bullettsocial.space/static/betium_logo.png"]
    icon_base = None
    if rpc_url:
        # Derive a sensible default icon path from the RPC origin when possible.
        try:
            from urllib.parse import urlparse
            p = urlparse(rpc_url)
            icon_base = f"{p.scheme}://{p.netloc}/static/betium_logo.png"
        except Exception:
            icon_base = None
    return {
        "chainId": _hex(ETH_CHAIN_ID),
        "chainIdDecimal": ETH_CHAIN_ID,
        "chainName": NETWORK_NAME,
        "nativeCurrency": {"name": "Betium", "symbol": NATIVE_TOKEN, "decimals": DECIMALS},
        "rpcUrls": [rpc_url] if rpc_url else [],
        "blockExplorerUrls": [],
        "iconUrls": [icon_base] if icon_base else [],
    }


def _tx_object(tx, d, block=None, index=None):
    return {
        "hash": d["hash"],
        "nonce": _hex(d["nonce"]),
        "blockHash": ("0x" + block["hash"]) if block else None,
        "blockNumber": _hex(block["index"]) if block else None,
        "transactionIndex": _hex(index) if block else None,
        "from": d["sender"],
        "to": d["to"],
        "value": _hex(d["value_wei"]),
        "gas": _hex(d["gas"]),
        "gasPrice": _hex(d["gas_price"]),
        "input": "0x",
        "v": _hex(d["v"]),
        "r": _hex(d["r"]),
        "s": _hex(d["s"]),
        "type": "0x0",
        "chainId": _hex(ETH_CHAIN_ID),
    }


def _eth_txs_of(block):
    out = []
    for tx in block.get("transactions", []):
        if isinstance(tx, dict) and tx.get("eth_raw"):
            try:
                out.append((tx, decode_raw_tx(tx["eth_raw"])))
            except EthTxError:
                continue
    return out


def _block_object(chain, block, full):
    pairs = _eth_txs_of(block)
    miner = ZERO_ADDR
    for tx in block.get("transactions", []):
        if isinstance(tx, dict) and tx.get("sender") == "NETWORK" and is_hex_address(tx.get("recipient")):
            miner = tx["recipient"]
    if full:
        txs = [_tx_object(t, d, block, i) for i, (t, d) in enumerate(pairs)]
    else:
        txs = [d["hash"] for _, d in pairs]
    parent = block["previous_hash"]
    return {
        "number": _hex(block["index"]),
        "hash": "0x" + block["hash"],
        "parentHash": "0x" + parent,
        "nonce": "0x" + int(block["nonce"]).to_bytes(8, "big").hex(),
        "sha3Uncles": "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
        "logsBloom": EMPTY_BLOOM,
        "transactionsRoot": "0x" + block["merkle_root"],
        "stateRoot": ZERO_HASH,
        "receiptsRoot": ZERO_HASH,
        "miner": miner,
        "difficulty": _hex(work_of(block["difficulty"], block["index"])),
        "totalDifficulty": _hex(chain.chain_work()),
        "extraData": "0x",
        "size": _hex(len(str(block))),
        "gasLimit": _hex(BLOCK_GAS_LIMIT),
        "gasUsed": _hex(ETH_TRANSFER_GAS * len(pairs)),
        "timestamp": _hex(block["timestamp"]),
        "transactions": txs,
        "uncles": [],
    }


def _resolve_block(chain, tag):
    latest = chain.get_latest_block()
    if tag in (None, "latest", "pending", "safe", "finalized"):
        return latest
    if tag == "earliest":
        return chain.get_block_by_index(0)
    return chain.get_block_by_index(_parse_int(tag))


def _abi_encode_uint256(n: int) -> str:
    return "0x" + int(n).to_bytes(32, "big").hex()


def _abi_encode_string(s: str) -> str:
    data = s.encode("utf-8")
    # offset (32) + length + data padded to 32-byte boundary
    pad = (32 - (len(data) % 32)) % 32
    encoded = (
        (32).to_bytes(32, "big")
        + len(data).to_bytes(32, "big")
        + data
        + b"\x00" * pad
    )
    return "0x" + encoded.hex()


# ERC-20 function selectors
_SEL_BALANCE_OF = bytes.fromhex("70a08231")
_SEL_NAME = bytes.fromhex("06fdde03")
_SEL_SYMBOL = bytes.fromhex("95d89b41")
_SEL_DECIMALS = bytes.fromhex("313ce567")
_SEL_TOTAL_SUPPLY = bytes.fromhex("18160ddd")


def _handle_eth_call(chain, params):
    """Minimal ERC-20 eth_call support for custom Betium tokens.

    MetaMask uses these calls when a user adds a custom token by contract address.
    """
    if not params or not isinstance(params[0], dict):
        return "0x"
    call = params[0]
    to = (call.get("to") or "").lower()
    data_hex = call.get("data") or "0x"
    if not to.startswith("0x") or not data_hex.startswith("0x"):
        return "0x"
    try:
        data = bytes.fromhex(data_hex[2:])
    except ValueError:
        return "0x"
    if not hasattr(chain, "get_token_id_by_contract"):
        return "0x"
    tid = chain.get_token_id_by_contract(to)
    if not tid:
        return "0x"
    if not data:
        return "0x"
    sel = data[:4]
    if sel == _SEL_BALANCE_OF and len(data) >= 36:
        # address is the last 20 bytes of the first argument word
        acct = "0x" + data[16:36].hex()
        bal = chain.get_token_balance(acct, tid)
        return _abi_encode_uint256(bal * WEI_PER_UNIT)
    if sel == _SEL_NAME:
        info = chain.get_token_info(tid)
        if not info:
            return "0x"
        return _abi_encode_string(info.get("name") or tid)
    if sel == _SEL_SYMBOL:
        info = chain.get_token_info(tid)
        if not info:
            return "0x"
        return _abi_encode_string(info.get("symbol") or tid)
    if sel == _SEL_DECIMALS:
        return _abi_encode_uint256(18)
    if sel == _SEL_TOTAL_SUPPLY:
        info = chain.get_token_info(tid)
        if not info:
            return "0x"
        supply = int(info.get("total_supply_units") or 0)
        return _abi_encode_uint256(supply * WEI_PER_UNIT)
    return "0x"


def handle_rpc_call(chain, method, params):
    params = params or []
    if method == "web3_clientVersion":
        return CLIENT_VERSION
    if method == "web3_sha3":
        return "0x" + keccak256(bytes.fromhex(params[0][2:])).hex()
    if method == "net_version":
        return str(ETH_CHAIN_ID)
    if method == "net_listening":
        return True
    if method == "net_peerCount":
        return _hex(len(chain.peers))
    if method == "eth_protocolVersion":
        return _hex(PROTOCOL_VERSION)
    if method == "eth_chainId":
        return _hex(ETH_CHAIN_ID)
    if method == "eth_syncing":
        return False
    if method == "eth_mining":
        return False
    if method == "eth_hashrate":
        return "0x0"
    if method == "eth_accounts":
        return []
    if method == "eth_coinbase":
        return ZERO_ADDR
    if method == "eth_blockNumber":
        return _hex(chain.get_latest_block()["index"])
    if method in ("eth_gasPrice",):
        return _hex(ETH_GAS_PRICE_WEI)
    if method == "eth_maxPriorityFeePerGas":
        return "0x0"
    if method == "eth_estimateGas":
        return _hex(ETH_TRANSFER_GAS)
    if method == "eth_getBalance":
        acct = _account_id(params[0])
        tag = params[1] if len(params) > 1 else "latest"
        # 0-conf: when MetaMask (or any client) asks for "pending", apply mempool
        # effects so the UI updates the moment a transfer is submitted.
        if tag == "pending" and hasattr(chain, "get_account_pending"):
            bal = chain.get_account_pending(acct)["balance"]
        else:
            bal = chain.get_account(acct)["balance"]
        return _hex(bal * WEI_PER_UNIT)
    if method == "eth_getTransactionCount":
        acct = _account_id(params[0])
        nonce = chain.get_account(acct)["nonce"]
        if len(params) > 1 and params[1] == "pending":
            nonce += sum(1 for t in chain.pending_transactions if t.get("sender") == acct)
        return _hex(nonce)
    if method == "eth_pendingTransactions":
        # Return mempool txs in a shape MetaMask / explorers can consume.
        out = []
        for tx in list(chain.pending_transactions):
            if tx.get("eth_raw"):
                try:
                    d = decode_raw_tx(tx["eth_raw"])
                    out.append(_tx_object(tx, d))
                except EthTxError:
                    continue
            else:
                try:
                    amount = int(parse_units(tx.get("amount")) or 0)
                    out.append({
                        "hash": None,
                        "nonce": _hex(tx.get("nonce") or 0),
                        "blockHash": None,
                        "blockNumber": None,
                        "transactionIndex": None,
                        "from": tx.get("sender"),
                        "to": tx.get("recipient"),
                        "value": _hex(amount * WEI_PER_UNIT),
                        "gasPrice": _hex(ETH_GAS_PRICE_WEI),
                        "gas": _hex(ETH_TRANSFER_GAS),
                        "input": "0x",
                        "type": "0x0",
                    })
                except Exception:
                    continue
        return out
    if method == "eth_getCode":
        # Return empty code; MetaMask still accepts custom tokens when eth_call works.
        return "0x"
    if method == "eth_getStorageAt":
        return ZERO_HASH
    if method == "eth_call":
        return _handle_eth_call(chain, params)
    if method == "eth_getLogs":
        return []
    if method == "eth_getBlockByNumber":
        block = _resolve_block(chain, params[0])
        return _block_object(chain, block, bool(params[1] if len(params) > 1 else False)) if block else None
    if method == "eth_getBlockByHash":
        h = params[0][2:] if isinstance(params[0], str) and params[0].startswith("0x") else params[0]
        block = chain.get_block_by_hash(h)
        return _block_object(chain, block, bool(params[1] if len(params) > 1 else False)) if block else None
    if method in ("eth_getBlockTransactionCountByNumber", "eth_getBlockTransactionCountByHash"):
        if method.endswith("ByNumber"):
            block = _resolve_block(chain, params[0])
        else:
            block = chain.get_block_by_hash(params[0][2:])
        return _hex(len(_eth_txs_of(block))) if block else None
    if method == "eth_getTransactionByHash":
        found = chain.find_eth_tx(params[0])
        if found:
            tx, d, block, index = found
            return _tx_object(tx, d, block, index)
        for tx in chain.pending_transactions:
            if tx.get("eth_raw"):
                try:
                    d = decode_raw_tx(tx["eth_raw"])
                except EthTxError:
                    continue
                if d["hash"] == params[0].lower():
                    return _tx_object(tx, d)
        return None
    if method == "eth_getTransactionReceipt":
        found = chain.find_eth_tx(params[0])
        if not found:
            return None
        tx, d, block, index = found
        return {
            "transactionHash": d["hash"],
            "transactionIndex": _hex(index),
            "blockHash": "0x" + block["hash"],
            "blockNumber": _hex(block["index"]),
            "from": d["sender"],
            "to": d["to"],
            "cumulativeGasUsed": _hex(ETH_TRANSFER_GAS * (index + 1)),
            "gasUsed": _hex(ETH_TRANSFER_GAS),
            "effectiveGasPrice": _hex(d["gas_price"]),
            "contractAddress": None,
            "logs": [],
            "logsBloom": EMPTY_BLOOM,
            "status": "0x1",
            "type": "0x0",
        }
    if method == "eth_sendRawTransaction":
        try:
            tx, d = build_internal_tx(params[0])
        except EthTxError as exc:
            raise RpcError(-32000, str(exc))
        ok, msg, _status = chain.submit_transaction(tx)
        if not ok:
            raise RpcError(-32000, msg)
        return d["hash"]
    if method == "eth_feeHistory":
        raise RpcError(-32601, "Method not supported: Betium uses legacy gas pricing")
    raise RpcError(-32601, f"Method {method} not found")


def handle_rpc_request(chain, payload):
    """Handle one JSON-RPC object or a batch. Returns (response, http_status)."""
    if isinstance(payload, list):
        if not payload or len(payload) > 50:
            return {"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32600, "message": "Invalid batch"}}, 400
        return [handle_rpc_request(chain, p)[0] for p in payload], 200
    if not isinstance(payload, dict) or "method" not in payload:
        return {"jsonrpc": "2.0", "id": None,
                "error": {"code": -32600, "message": "Invalid request"}}, 400
    rid = payload.get("id")
    try:
        result = handle_rpc_call(chain, payload["method"], payload.get("params"))
        return {"jsonrpc": "2.0", "id": rid, "result": result}, 200
    except RpcError as exc:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": exc.code, "message": exc.message}}, 200
    except (ValueError, IndexError, TypeError, KeyError):
        return {"jsonrpc": "2.0", "id": rid,
                "error": {"code": -32602, "message": "Invalid params"}}, 200
    except Exception as exc:  # never leak a traceback to clients
        return {"jsonrpc": "2.0", "id": rid,
                "error": {"code": -32603, "message": f"Internal error: {type(exc).__name__}"}}, 200


# ------------------------------------------------------------------ CLI / help

def print_help():
    print(f"""Betium Ethereum compatibility – usage:
  python3 ethcompat.py [-h|--help]
  python3 ethcompat.py network [RPC_URL]   Print the MetaMask network settings
  python3 ethcompat.py address <PRIVATE_KEY_HEX>
                                           Show the 0x address MetaMask derives from a key
  python3 ethcompat.py selftest            Run built-in tests (keccak, RLP, signature recovery)

This module is used by node.py, which serves JSON-RPC at POST /rpc.
Native BETM uses plain value transfers. Custom tokens are exposed as ERC-20
contracts so MetaMask can add them (via contract address) and transfer them.
""")
    sys.exit(0)


def selftest():
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    assert pubkey_to_address(private_to_public(1)) == "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    priv = "46" * 32
    to = bytes.fromhex("35" * 20)
    body = [3, ETH_GAS_PRICE_WEI, ETH_TRANSFER_GAS, to, 12345 * WEI_PER_UNIT, b""]
    h = keccak256(rlp_encode(body + [ETH_CHAIN_ID, 0, 0]))
    r, s, rec = eth_sign(priv, h)
    raw = "0x" + rlp_encode(body + [ETH_CHAIN_ID * 2 + 35 + rec, r, s]).hex()
    tx, d = build_internal_tx(raw)
    assert d["sender"] == pubkey_to_address(private_to_public(int(priv, 16)))
    assert tx["amount"] == 12345 and tx["nonce"] == 4 and tx["fee"] == 10500
    print("[+] selftest passed")


def main():
    args = sys.argv[1:]
    if not args or any(a in ("-h", "--help") for a in args):
        print_help()
    if args[0] == "network":
        import json
        print(json.dumps(network_params(args[1] if len(args) > 1 else None), indent=2))
    elif args[0] == "address" and len(args) == 2:
        print(pubkey_to_address(private_to_public(int(args[1], 16))))
    elif args[0] == "selftest":
        selftest()
    else:
        print_help()


if __name__ == "__main__":
    main()
