#!/usr/bin/env bash
# Betium node launcher (Python version)
#
# Asks for the public URL of YOUR node, then starts it together with the default
# bootstrap peer so it finds the rest of the network automatically.
#
# Usage:   ./run.sh
# Override the bootstrap peer:   BETIUM_BOOTSTRAP=https://other.node ./run.sh

set -euo pipefail
cd "$(dirname "$0")"

BOOTSTRAP="${BETIUM_BOOTSTRAP:-https://crypto.bullettsocial.space}"
URL_FILE=".betium_url"
SESSION="betium"
API_PORT="${PORT:-5000}"

# ---- prerequisites -----------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
  echo "[-] Python 3 is not installed. Install Python 3.8 or newer."
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
  echo "[-] Python $(python3 --version 2>&1 | cut -d' ' -f2) is too old. Betium needs 3.8 or newer."
  exit 1
fi

have_deps() { "$1" -c 'import flask, requests, ecdsa' >/dev/null 2>&1; }

PY=python3
if [ -x .venv/bin/python ] && have_deps .venv/bin/python; then
  PY=.venv/bin/python
elif ! have_deps python3; then
  echo "[*] Installing dependencies (flask, requests, ecdsa) into ./.venv ..."
  if ! python3 -m venv .venv; then
    echo "[-] Could not create a virtualenv. On Debian/Ubuntu run: sudo apt install python3-venv"
    exit 1
  fi
  if ! .venv/bin/pip install --quiet flask requests ecdsa; then
    echo "[-] Could not install the dependencies. Check your internet connection, or run:"
    echo "    python3 -m pip install flask requests ecdsa"
    exit 1
  fi
  PY=.venv/bin/python
fi

# ---- ask for this node's public URL ----------------------------------------
saved=""
if [ -f "$URL_FILE" ]; then saved="$(head -n 1 "$URL_FILE" | tr -d '[:space:]')"; fi

echo "Betium node launcher"
echo "Enter the public URL where other nodes can reach THIS node, for example"
echo "  https://mynode.example.com   or   http://203.0.113.5:5000"
echo

while true; do
  if [ -n "$saved" ]; then
    read -r -p "Your node URL [$saved]: " MY_URL || { echo; echo "[-] No input, exiting."; exit 1; }
    MY_URL="${MY_URL:-$saved}"
  else
    read -r -p "Your node URL: " MY_URL || { echo; echo "[-] No input, exiting."; exit 1; }
  fi
  MY_URL="$(printf '%s' "$MY_URL" | tr -d '[:space:]')"
  MY_URL="${MY_URL%/}"
  if [[ "$MY_URL" =~ ^https?://[^/]+$ ]]; then break; fi
  echo "[-] Not a valid URL. It must start with http:// or https:// and have no path."
done

# Warn about addresses that other nodes can never reach.
host="${MY_URL#*://}"; host="${host##*@}"; host="${host%%:*}"; host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
case "$host" in
  localhost|0.0.0.0|127.*|10.*|192.168.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
    echo "[!] $host is a local/private address. Your node will still download and verify"
    echo "    the whole chain, but other nodes cannot find or reach it." ;;
esac

printf '%s\n' "$MY_URL" > "$URL_FILE"

# A node cannot use itself as its own bootstrap peer.
bootstrap_norm="$(printf '%s' "${BOOTSTRAP%/}" | tr '[:upper:]' '[:lower:]')"
url_norm="$(printf '%s' "$MY_URL" | tr '[:upper:]' '[:lower:]')"
if [ "$url_norm" = "$bootstrap_norm" ]; then
  ARGS=("$MY_URL")
  echo "[*] This is the bootstrap node itself - starting without a bootstrap peer."
else
  ARGS=("$MY_URL" "$BOOTSTRAP")
fi

echo "[*] Launching: python3 node.py ${ARGS[*]}"

# ---- launch ------------------------------------------------------------------
if command -v screen >/dev/null 2>&1; then
  screen -S "$SESSION" -X quit >/dev/null 2>&1 || true   # restart if already running
  screen -wipe >/dev/null 2>&1 || true
  screen -S "$SESSION" -d -m "$PY" node.py "${ARGS[@]}"
  echo "[+] Betium node launched in detached screen session '$SESSION'"
  echo "    Attach with:  screen -r $SESSION      (detach again: Ctrl-A then D)"
  echo "    Stop:         screen -S $SESSION -X quit"
  if command -v curl >/dev/null 2>&1; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 1
      if status="$(curl -fsS -m 2 "http://127.0.0.1:${API_PORT}/chain/status" 2>/dev/null)"; then
        echo "[+] Node is up: $status"
        echo "    It is now downloading and verifying the chain from the network."
        exit 0
      fi
    done
    echo "[!] Node is not answering yet. Check it with: screen -r $SESSION"
  fi
else
  echo "[*] 'screen' not found - running in this terminal (Ctrl-C to stop)."
  exec "$PY" node.py "${ARGS[@]}"
fi
