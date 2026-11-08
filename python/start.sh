#!/bin/bash
# Start the Betium node in a detached screen session on Linux.
# Usage: ./start.sh
# Requires: screen, python3, and the node files in the current directory.

set -e

# 1. Stop any process still holding port 5000 and clean dead screens
fuser -k 5000/tcp 2>/dev/null || true
screen -wipe >/dev/null 2>&1 || true

# 2. Launch the fresh node daemon in a named, detached screen
#    The public URL is the one provided for this deployment.
screen -S betium -d -m python3 node.py https://crypto.bullettsocial.space

echo "[+] Betium node launched in detached screen session 'betium'"
echo "    Attach with:  screen -r betium"
echo "    Detach again: Ctrl-A then D"
echo "    Stop:         screen -S betium -X quit   (or fuser -k 5000/tcp)"
