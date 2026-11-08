#!/usr/bin/env bash
# Betium node launcher (Node.js version)
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
if ! command -v node >/dev/null 2>&1; then
  echo "[-] Node.js is not installed. Install Node.js 22.13 or newer: https://nodejs.org"
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "[-] Node.js $(node -v) is too old. Betium needs v22.13 or newer."
  exit 1
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

echo "[*] Launching: node node.js ${ARGS[*]}"

# ---- launch ------------------------------------------------------------------
if command -v screen >/dev/null 2>&1; then
  screen -S "$SESSION" -X quit >/dev/null 2>&1 || true   # restart if already running
  screen -wipe >/dev/null 2>&1 || true
  screen -S "$SESSION" -d -m node node.js "${ARGS[@]}"
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
  exec node node.js "${ARGS[@]}"
fi
