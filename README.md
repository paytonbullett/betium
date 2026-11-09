# Betium

Betium is a lightweight proof-of-work blockchain with native MetaMask support and custom tokens.

- Native currency: **BETM** (8 internal decimals, presented as 18 to MetaMask)
- Chain ID: **947263**
- Block time target: ~15 seconds
- Custom tokens are first-class and can be added to MetaMask as ERC-20 style tokens

This repository contains two interchangeable implementations of the same protocol:

| Folder | Version | Needs |
|---|---|---|
| `python/` | Python node, wallet and miner | Python 3.10+ |
| `nodejs/` | Node.js node, wallet and miner | Node.js 22.13+ (no npm install) |

They share the same genesis, block format and database, so nodes of either kind can sync with each other.

---

## Get the code

Pick **one** version. Either command creates a folder named `betium` in your current directory.

**Python version**
```bash
git clone --depth 1 https://github.com/paytonbullett/betium.git betium-tmp
mv betium-tmp/python betium && rm -rf betium-tmp
cd betium
pip install -r requirements.txt
```

**Node.js version**
```bash
git clone --depth 1 https://github.com/paytonbullett/betium.git betium-tmp
mv betium-tmp/nodejs betium && rm -rf betium-tmp
cd betium
node -v    # must print v22.13 or newer
```

---

## Requirements

**Python version**
- Python **3.10+** recommended (3.8+ minimum)
- Linux (recommended) or any OS that can run the Python dependencies
- `screen` (for the recommended start method on Linux)

**Node.js version**
- Node.js **22.13+** (uses the built-in `node:sqlite`, nothing to install)
- `screen` (optional, used by `start.sh` on Linux)

---

## Run it

Start the launcher from inside the `betium` folder. It asks for your node's public URL, then starts your node together with the default bootstrap peer, `https://crypto.bullettsocial.space`.

**Linux / macOS / Termux**
```bash
bash run.sh
```

**Windows**: double-click `run.bat` (or run `run.sh` from Git Bash, which hands over to it automatically).

```
Your node URL: https://mynode.example.com
```

The node listens on **port 5000** by default. It finds every other node on the network, announces itself, and downloads and verifies the whole chain. After the first run it remembers your URL and its peers.

### Optional: web server + SSL (Linux)

If your URL is a domain name, `run.sh` offers to set up **nginx or Apache** in front of your node with HTTPS. This gives you a public `https://` address, which MetaMask and browsers need. It asks:

- which web server to use (nginx or Apache)
- whether the domain uses Cloudflare, and whether the orange-cloud proxy is on
- how to get the certificate: a free Let's Encrypt certificate, a certificate you already have (such as a Cloudflare Origin Certificate), or none
- your email for expiry notices (optional), and whether to open ports 80 and 443 in the firewall

It then installs the packages, writes the config, gets the certificate, and starts the server. Requirements: root or `sudo`, and a domain whose DNS already points at your server. You can skip it now and run it later with `sudo bash setup-proxy.sh https://your.domain`. On Windows, use a Cloudflare Tunnel or run the Linux version in WSL.

### Notes

- Your URL must be public. A `localhost` or `192.168.x.x` address still syncs the chain, but other nodes can't find it.
- On Linux with `screen` installed, the node runs in the background. Attach with `screen -r betium` and stop with `screen -S betium -X quit`.
- To use a different bootstrap peer: `BETIUM_BOOTSTRAP=https://other.node bash run.sh`
- Manual start: `python3 node.py <your_url> <bootstrap_url>` or `node node.js <your_url> <bootstrap_url>`

## Authorship & Project Attribution

- **Project Lead & System Architect:** Payton Bullett
- **Development Method:** Directed AI Code Generation (Vibe Coding)

### Notice on AI Co-Creation & Copyright Waiver

This project was conceptualized, architected, engineered, and directed by **Payton Bullett**. The underlying source code implementation was primarily synthesized using generative AI tools under human prompt control, structural guidance, and iterative debugging.

Pursuant to United States Copyright Office guidance regarding machine-generated works:

- Raw AI-generated code blocks carry no independent human copyright claim and belong to the public domain.
- **Payton Bullett** claims full creative credit as the Project Director, System Architect, and Repository Maintainer for the overall design, selection, arrangement, and orchestration of the Betium blockchain suite.
- Community contributions and refinements to strengthen consensus, performance, and peer-to-peer logic are explicitly encouraged.
