# Betium

Betium is a lightweight proof-of-work blockchain with native MetaMask support and custom tokens.

- Native currency: **BETM** (8 internal decimals, presented as 18 to MetaMask)
- Chain ID: **947263**
- Block time target: ~15 seconds
- Custom tokens are first-class and can be added to MetaMask as ERC-20 style tokens

## Requirements

- Python 3.8+
- Linux (recommended) or any OS that can run the Python dependencies
- `screen` (for the recommended start method on Linux)

```bash
pip install -r requirements.txt
```

## Quick Start (Node)

```bash
# Install dependencies
pip install -r requirements.txt

# Start the node in a detached screen session (recommended)
./start.sh

# Or manually:
screen -S betium -d -m python3 node.py https://your-public-url.example
```

The node listens on `0.0.0.0:5000`.

**Important:** Do not delete `betium_chain.db` if you already have a running chain. The node will refuse to start if the genesis does not match.

### Useful screen commands

```bash
screen -r betium          # attach to the running node
# Ctrl-A then D           # detach again
screen -S betium -X quit  # stop the node
fuser -k 5000/tcp         # force kill anything on port 5000
```

## Wallet

```bash
python3 wallet.py                     # show address + BETM balance
python3 wallet.py balance             # same
python3 wallet.py balance GAY         # balance of a custom token
python3 wallet.py send <TO> <AMOUNT>  # send BETM
python3 wallet.py send GAY <TO> <AMOUNT>
python3 wallet.py create <TOKEN_ID> <NAME> <SYMBOL> <SUPPLY>
python3 wallet.py tokens
python3 wallet.py token GAY
python3 wallet.py eth                 # show the 0x address for MetaMask
python3 wallet.py eth --export-key    # export private key (dangerous)
python3 wallet.py link                # link native + 0x address
```

## MetaMask Setup

1. Add the network manually:

| Field            | Value                                      |
|------------------|--------------------------------------------|
| Network Name     | Betium                                     |
| RPC URL          | `https://your-node-url/rpc`                |
| Chain ID         | `947263`                                   |
| Currency Symbol  | `BETM`                                     |
| Block Explorer   | `https://your-node-url` (optional)         |

2. To add a custom token:
   - Get the contract address from the API:
     ```bash
     curl -s https://your-node-url/token/GAY
     ```
   - In MetaMask → Import tokens → Custom token → paste the `contract_address`
   - Decimals = **18**

Native BETM transfers work directly. Custom tokens use standard ERC-20 `transfer()` under the hood.

## API Overview

| Endpoint                          | Description                          |
|-----------------------------------|--------------------------------------|
| `GET  /chain/status`              | Chain height, difficulty, etc.       |
| `GET  /headers?from=<index>`      | Block headers                        |
| `GET  /block/<index>`             | Full block                           |
| `GET  /balance/<address>`         | BETM balance                         |
| `GET  /balance/<address>/<token>` | Custom token balance                 |
| `GET  /supply`                    | Circulating + max supply             |
| `GET  /tokens`                    | List all custom tokens + contracts   |
| `GET  /token/<token_id>`          | Single token info + contract address |
| `GET  /fees`                      | Current fee schedule                 |
| `GET  /peers`                     | Known peers                          |
| `POST /transaction/new`           | Submit a native transaction          |
| `GET  /mine/template?miner=<addr>`| Mining template                      |
| `POST /block/submit`              | Submit a mined block                 |
| `POST /rpc`                       | Ethereum JSON-RPC (MetaMask)         |
| `GET  /network`                   | MetaMask network parameters          |

## Mining

```bash
python3 miner.py <your-address> [node-url]
```

## Project Structure

```
.
├── node.py              # Full node + HTTP API + JSON-RPC
├── ethcompat.py         # MetaMask / Ethereum compatibility layer
├── wallet.py            # Command-line wallet
├── miner.py             # Simple miner
├── consensus.py         # Shared consensus rules & constants
├── start.sh             # Linux helper to launch node in screen
├── requirements.txt
├── constants/
│   └── additionalChainRegistry/
│       └── chainid-947263.js   # Chainlist-style registry entry
└── betium_logo.png
```

## Notes

- The database file is `betium_chain.db`. Never delete it on a live chain.
- Custom token contract addresses are deterministic and stored in the `token_contracts` table.
- All fees for custom token transfers are paid in BETM.
- The node validates every block itself. There is no central authority.

## License

This project is released as open source. Choose a license (MIT, Apache-2.0, etc.) when you publish the repository.
