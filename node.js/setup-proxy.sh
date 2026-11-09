#!/usr/bin/env bash
# Betium reverse proxy + HTTPS setup for Linux servers (nginx or Apache).
#
# Puts a web server in front of your node (port 5000) so it is reachable at
# https://your.domain, with a free Let's Encrypt certificate if you want one.
# run.sh offers to call this for you. You can also run it on its own later:
#
#   sudo bash setup-proxy.sh https://node.example.com
#
# Preview only (changes nothing, writes the configs to ./betium-proxy-preview):
#   BETIUM_DRY_RUN=1 bash setup-proxy.sh https://node.example.com

set -euo pipefail

DRY="${BETIUM_DRY_RUN:-}"
PUBLIC_URL="${1:-}"
PORT="${2:-5000}"
PREVIEW_DIR="./betium-proxy-preview"
SUDO=""

say()  { printf '%s\n' "$*"; }
warn() { printf '[!] %s\n' "$*"; }
die()  { printf '[-] %s\n' "$*" >&2; exit 1; }

REPLY_VALUE=""
ask() {   # ask "Question" ["default"]  -> REPLY_VALUE
  local prompt="$1" def="${2:-}" ans=""
  if [ -n "$def" ]; then
    read -r -p "$prompt [$def]: " ans || die "No input."
    ans="${ans:-$def}"
  else
    read -r -p "$prompt: " ans || die "No input."
  fi
  REPLY_VALUE="$(printf '%s' "$ans" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
}

yesno() { local ans=""; read -r -p "$1 [y/N]: " ans || die "No input."; [[ "$ans" =~ ^[Yy] ]]; }

run() {
  if [ -n "$DRY" ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi
}
sudo_run() { run $SUDO "$@"; }

write_file() {   # write_file /path/to/file   (content on stdin)
  local path="$1"
  if [ -n "$DRY" ]; then
    mkdir -p "$PREVIEW_DIR"
    cat > "$PREVIEW_DIR/$(basename "$path")"
    say "    [dry-run] would write $path  (preview: $PREVIEW_DIR/$(basename "$path"))"
  else
    if [ -f "$path" ]; then $SUDO cp "$path" "$path.bak.$(date +%Y%m%d%H%M%S)"; fi
    $SUDO tee "$path" >/dev/null
  fi
}

# ---- platform checks -----------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || die "Web server setup is only supported on Linux servers."
if [ -z "$DRY" ] && [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "Run this as root (or install sudo)."
  SUDO="sudo"
  say "[*] Administrator rights are needed; you may be asked for your sudo password."
fi

PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
elif command -v yum >/dev/null 2>&1; then PKG="yum"
elif [ -n "$DRY" ]; then PKG="apt"
else die "Unsupported Linux distribution (need apt, dnf or yum). Set up the proxy manually."
fi

# ---- questions -----------------------------------------------------------------
DOMAIN=""
if [ -n "$PUBLIC_URL" ]; then
  DOMAIN="${PUBLIC_URL#*://}"; DOMAIN="${DOMAIN%%/*}"; DOMAIN="${DOMAIN%%:*}"
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
while true; do
  if [ -z "$DOMAIN" ]; then
    ask "Domain name for your node (e.g. node.example.com)"
    DOMAIN="$(printf '%s' "$REPLY_VALUE" | tr '[:upper:]' '[:lower:]')"
  fi
  if [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then break; fi
  warn "'$DOMAIN' is not a valid domain name (certificates cannot be issued for IP addresses)."
  DOMAIN=""
done
say "[*] Domain: $DOMAIN   Node port: $PORT"
say "    The DNS record for $DOMAIN must point to this server."

default_ws=1
if systemctl is-active --quiet apache2 2>/dev/null || systemctl is-active --quiet httpd 2>/dev/null; then
  default_ws=2
elif systemctl is-active --quiet nginx 2>/dev/null; then
  default_ws=1
elif command -v apache2 >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1; then
  default_ws=2
fi
say
say "Which web server should sit in front of your node?"
say "  1) nginx"
say "  2) Apache"
ask "Choose 1 or 2" "$default_ws"
case "$REPLY_VALUE" in
  1|nginx) WS="nginx" ;;
  2|apache|apache2) WS="apache" ;;
  *) die "Please choose 1 or 2." ;;
esac

CF="no"; CF_PROXY="no"
say
if yesno "Does this domain use Cloudflare?"; then
  CF="yes"
  if yesno "Is the orange-cloud proxy turned ON for this domain?"; then CF_PROXY="yes"; fi
fi

say
say "SSL certificate:"
say "  1) Free Let's Encrypt certificate (recommended, renews automatically)"
say "  2) I already have a certificate (for example a Cloudflare Origin Certificate)"
say "  3) No certificate (plain HTTP only)"
ask "Choose 1, 2 or 3" "1"
CERT=""; EMAIL=""; CERT_FILE=""; KEY_FILE=""
case "$REPLY_VALUE" in
  1)
    CERT="le"
    ask "Email for certificate expiry notices (optional, press Enter to skip)" ""
    EMAIL="$REPLY_VALUE"
    say "Let's Encrypt requires you to accept its Terms of Service:"
    say "  https://letsencrypt.org/repository/"
    yesno "Do you accept the Let's Encrypt Terms of Service?" || die "Terms not accepted, cannot issue a certificate."
    if [ "$CF_PROXY" = "yes" ]; then
      say "[*] Cloudflare proxy is on: issuance normally still works. If it fails, switch the DNS"
      say "    record to 'DNS only' (grey cloud) temporarily, run this script again, then switch back."
    fi
    ;;
  2)
    CERT="own"
    ask "Full path to the certificate file (.pem / .crt)"; CERT_FILE="$REPLY_VALUE"
    ask "Full path to the private key file (.key / .pem)"; KEY_FILE="$REPLY_VALUE"
    if [ -z "$DRY" ]; then
      [ -r "$CERT_FILE" ] || die "Cannot read certificate file: $CERT_FILE"
      [ -r "$KEY_FILE" ]  || die "Cannot read key file: $KEY_FILE"
    fi
    ;;
  3)
    CERT="none"
    warn "Without HTTPS, MetaMask and most browsers will refuse to talk to your node."
    if [ "$CF" = "yes" ]; then say "    With Cloudflare you can use SSL mode 'Flexible' for this (less secure)."; fi
    ;;
  *) die "Please choose 1, 2 or 3." ;;
esac

if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  if yesno "The ufw firewall is active. Open ports 80 and 443?"; then
    sudo_run ufw allow 80/tcp
    sudo_run ufw allow 443/tcp
  fi
elif command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  if yesno "firewalld is active. Open HTTP and HTTPS?"; then
    sudo_run firewall-cmd --permanent --add-service=http
    sudo_run firewall-cmd --permanent --add-service=https
    sudo_run firewall-cmd --reload
  fi
fi

conflicts="$(grep -rlsE "(server_name|ServerName|ServerAlias)[[:space:]].*${DOMAIN}" /etc/nginx /etc/apache2 /etc/httpd 2>/dev/null | grep -vE '/betium[^/]*$' || true)"
if [ -n "$conflicts" ]; then
  warn "Another web server config already mentions $DOMAIN:"
  printf '      %s\n' $conflicts
  yesno "Continue anyway? (two configs for one domain can conflict)" || die "Stopped. Nothing was changed."
fi

say
case "$CERT" in le) cert_label="Let's Encrypt" ;; own) cert_label="your certificate" ;; *) cert_label="no SSL" ;; esac
say "Summary: $WS + $cert_label for $DOMAIN -> 127.0.0.1:$PORT"

# ---- install packages ------------------------------------------------------------
say "[*] Installing packages..."
pk=()
if [ "$PKG" = "apt" ]; then
  if [ "$WS" = "nginx" ]; then pk+=(nginx); else pk+=(apache2); fi
  if [ "$CERT" = "le" ]; then pk+=(certbot "python3-certbot-$WS"); fi
  sudo_run apt-get update -qq
  sudo_run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${pk[@]}"
else
  if [ "$WS" = "nginx" ]; then pk+=(nginx); else pk+=(httpd mod_ssl); fi
  if [ "$CERT" = "le" ]; then
    sudo_run "$PKG" install -y epel-release || true
    pk+=(certbot "python3-certbot-$WS")
  fi
  sudo_run "$PKG" install -y "${pk[@]}"
fi
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  sudo_run setsebool -P httpd_can_network_connect 1
fi

# ---- configuration ---------------------------------------------------------------
nginx_proxy_block() {
cat <<EOF
    client_max_body_size 3m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$betium_proto;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_read_timeout 60s;
    }
EOF
}

apache_proxy_block() {
cat <<EOF
    ProxyPreserveHost On
    ProxyRequests Off
    RequestHeader setifempty X-Forwarded-Proto expr=%{REQUEST_SCHEME}
    ProxyPass /.well-known/ !
    ProxyPass / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/
EOF
}

say "[*] Writing $WS configuration..."
if [ "$WS" = "nginx" ]; then
  CONF="/etc/nginx/conf.d/betium.conf"
  {
    echo "# Betium node reverse proxy (generated by setup-proxy.sh)"
    echo 'map $http_x_forwarded_proto $betium_proto { default $scheme; https https; }'
    echo
    if [ "$CERT" = "own" ]; then
      cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;
    ssl_certificate $CERT_FILE;
    ssl_certificate_key $KEY_FILE;
    ssl_protocols TLSv1.2 TLSv1.3;

EOF
      nginx_proxy_block
      echo "}"
    else
      cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

EOF
      nginx_proxy_block
      echo "}"
    fi
  } | write_file "$CONF"
  sudo_run nginx -t || die "nginx rejected the configuration. A backup of any old file is next to $CONF (*.bak.*)."
  sudo_run systemctl enable --now nginx
  sudo_run systemctl reload nginx
else
  if [ "$PKG" = "apt" ]; then CONF="/etc/apache2/sites-available/betium.conf"; SVC="apache2"; CTL="apache2ctl"
  else CONF="/etc/httpd/conf.d/betium.conf"; SVC="httpd"; CTL="apachectl"; fi
  {
    echo "# Betium node reverse proxy (generated by setup-proxy.sh)"
    if [ "$CERT" = "own" ]; then
      cat <<EOF
<VirtualHost *:80>
    ServerName $DOMAIN
    Redirect permanent / https://$DOMAIN/
</VirtualHost>

<VirtualHost *:443>
    ServerName $DOMAIN
    SSLEngine on
    SSLCertificateFile "$CERT_FILE"
    SSLCertificateKeyFile "$KEY_FILE"
EOF
      apache_proxy_block
      echo "</VirtualHost>"
    else
      echo "<VirtualHost *:80>"
      echo "    ServerName $DOMAIN"
      apache_proxy_block
      echo "</VirtualHost>"
    fi
  } | write_file "$CONF"
  if [ "$PKG" = "apt" ]; then
    sudo_run a2enmod proxy proxy_http headers ssl rewrite
    sudo_run a2ensite betium
  fi
  sudo_run "$CTL" configtest || die "Apache rejected the configuration. A backup of any old file is next to $CONF (*.bak.*)."
  sudo_run systemctl enable --now "$SVC"
  sudo_run systemctl reload "$SVC"
fi

# ---- certificate ---------------------------------------------------------------
FINAL_SCHEME="http"
if [ "$CERT" = "le" ]; then
  say "[*] Requesting a Let's Encrypt certificate for $DOMAIN..."
  cb_args=(--non-interactive --agree-tos --no-eff-email --redirect -d "$DOMAIN")
  if [ -n "$EMAIL" ]; then cb_args+=(--email "$EMAIL"); else cb_args+=(--register-unsafely-without-email); fi
  if ! sudo_run certbot "--$WS" "${cb_args[@]}"; then
    warn "Certificate request failed. Common causes:"
    say "    - the DNS record for $DOMAIN does not point to this server yet"
    say "    - ports 80 and 443 are blocked (cloud firewall / security group / router)"
    say "    - Cloudflare proxy is on: set the record to 'DNS only' (grey cloud), run again, switch back"
    say "    Your HTTP proxy is working; run this script again after fixing the cause."
    exit 1
  fi
  FINAL_SCHEME="https"
elif [ "$CERT" = "own" ]; then
  FINAL_SCHEME="https"
fi

FINAL_URL="$FINAL_SCHEME://$DOMAIN"
if [ -n "$DRY" ]; then mkdir -p "$PREVIEW_DIR"; printf '%s' "$FINAL_URL" > "$PREVIEW_DIR/.betium_proxy_url"
else printf '%s' "$FINAL_URL" > .betium_proxy_url; fi

# ---- finish ----------------------------------------------------------------------
say
say "[+] Done. $WS now forwards $FINAL_URL to your node on 127.0.0.1:$PORT."
if [ -z "$DRY" ] && command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 8 "$FINAL_URL/chain/status" >/dev/null 2>&1; then
    say "[+] $FINAL_URL/chain/status answers - your node is reachable."
  else
    say "[*] $FINAL_URL does not answer yet. Start the node, then test: curl $FINAL_URL/chain/status"
  fi
fi
if [ -n "$PUBLIC_URL" ] && [ "${PUBLIC_URL%%://*}" != "$FINAL_SCHEME" ]; then
  warn "You entered $PUBLIC_URL but the node is served at $FINAL_URL - use $FINAL_URL as your node URL."
fi
say "    MetaMask RPC URL: $FINAL_URL/rpc   (Chain ID 947263, symbol BETM)"
if [ "$CF" = "yes" ]; then
  if [ "$CERT" = "none" ]; then
    say "    Cloudflare: set SSL/TLS mode to 'Flexible'."
  else
    say "    Cloudflare: set SSL/TLS mode to 'Full (strict)'."
  fi
fi
