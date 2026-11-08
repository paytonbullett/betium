#!/bin/bash
# Start the Betium node in a detached screen session on Linux.
# Usage: ./start.sh [public_url] [bootstrap_peer_url]
# Requires: screen and Node.js >= 22.13 (no npm install needed).

set -e
cd "$(dirname "$0")"

PUBLIC_URL="${1:-https://crypto.bullettsocial.space}"
BOOTSTRAP="${2:-}"
PORT="${PORT:-5000}"

# 1. Stop any process still holding the port and clean dead screens
fuser -k "${PORT}/tcp" 2>/dev/null || true
screen -wipe >/dev/null 2>&1 || true

# 2. Launch the fresh node daemon in a named, detached screen
PORT="$PORT" screen -S betium -d -m node node.js "$PUBLIC_URL" $BOOTSTRAP

echo "[+] Betium node launched in detached screen session 'betium' (port $PORT)"
echo "    Attach with:  screen -r betium"
echo "    Detach again: Ctrl-A then D"
echo "    Stop:         screen -S betium -X quit   (or fuser -k ${PORT}/tcp)"
