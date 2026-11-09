#!/usr/bin/env bash
# Betium node launcher (Node.js version) - Linux, macOS, Termux; hands over to PowerShell on Windows.
#
# Asks for the public URL of YOUR node, optionally sets up nginx/Apache with a free
# SSL certificate (Linux servers), then starts the node together with the default
# bootstrap peer so it finds the rest of the network automatically.
#
# Usage:   bash run.sh
# Override the bootstrap peer:   BETIUM_BOOTSTRAP=https://other.node bash run.sh

set -euo pipefail
cd "$(dirname "$0")"

BOOTSTRAP="${BETIUM_BOOTSTRAP:-https://crypto.bullettsocial.space}"
URL_FILE=".betium_url"
SESSION="betium"
API_PORT="${PORT:-5000}"

# ---- detect operating system ---------------------------------------------------
case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux*)               OS="linux" ;;
  Darwin*)              OS="mac" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *)                    OS="unknown" ;;
esac
if [ "$OS" = "linux" ] && { [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == *com.termux* ]]; }; then
  OS="termux"
fi

if [ "$OS" = "windows" ]; then
  echo "[*] Windows detected - handing over to run.ps1 (PowerShell)."
  if command -v powershell.exe >/dev/null 2>&1; then
    script="run.ps1"
    if command -v cygpath >/dev/null 2>&1; then script="$(cygpath -w "$PWD/run.ps1")"; fi
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$script"
  fi
  echo "[-] PowerShell was not found. Double-click run.bat instead."
  exit 1
fi
echo "[*] Detected: $OS   (the node listens on port $API_PORT by default)"

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

echo
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

# ---- optional: web server + SSL ---------------------------------------------
PROXY_URL=""
is_domain=0
if [[ "$host" =~ [[:alpha:]] ]] && [[ ! "$host" =~ ^[0-9.]+$ ]] && [ "$host" != "localhost" ]; then is_domain=1; fi
if [ "$is_domain" = "1" ]; then
  if [ "$OS" = "linux" ] && [ -f setup-proxy.sh ]; then
    echo
    echo "A web server (nginx or Apache) with an SSL certificate gives your node a public"
    echo "https:// address, which MetaMask and browsers need. It requires root access and a"
    echo "domain name that already points at this server."
    read -r -p "Set up nginx/Apache + SSL now? [y/N]: " ans || ans=""
    if [[ "$ans" =~ ^[Yy] ]]; then
      rm -f .betium_proxy_url
      if bash setup-proxy.sh "$MY_URL" "$API_PORT"; then
        PROXY_URL="$(cat .betium_proxy_url 2>/dev/null || true)"
        # The web server now answers the public traffic, so keep the node itself local-only.
        export HOST=127.0.0.1
      else
        echo "[!] Web server setup did not finish. Starting the node anyway."
        echo "    You can retry later with: bash setup-proxy.sh $MY_URL"
      fi
    fi
  else
    echo "[*] Automatic web server + SSL setup is available on Linux servers only."
  fi
fi

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
        if [ -n "$PROXY_URL" ]; then
          if curl -fsS -m 8 "$PROXY_URL/chain/status" >/dev/null 2>&1; then
            echo "[+] Public address works: $PROXY_URL"
          else
            echo "[!] $PROXY_URL is not answering yet (DNS or firewall may still be settling)."
          fi
        fi
        exit 0
      fi
    done
    echo "[!] Node is not answering yet. Check it with: screen -r $SESSION"
  fi
else
  echo "[*] 'screen' not found - running in this terminal (Ctrl-C to stop)."
  exec node node.js "${ARGS[@]}"
fi
