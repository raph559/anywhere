#!/bin/sh
# Anywhere hub installer. Installs or updates the hub on a Linux server (run as root):
#   curl -fsSL https://github.com/raph559/anywhere/releases/latest/download/install.sh | sudo sh
# Re-running it updates the app and keeps your configuration, devices and sessions.
# How you reach it is chosen on first install (asked if not set):
#   Tailscale (detected automatically)            private HTTPS inside your tailnet
#   ANYWHERE_DOMAIN=anywhere.example.com           automatic HTTPS with Caddy (ports 80/443 free)
#   ANYWHERE_ORIGIN=https://your-address           your own reverse proxy to 127.0.0.1:18250
#   ANYWHERE_LAN=1                                 plain http://<this server's IP>:18250 on your local network
# Other options: ANYWHERE_TARBALL (local release archive), ANYWHERE_NO_SYSTEMD=1 (don't install the service).
set -eu
REPO=raph559/anywhere; APP=/opt/anywhere; ETC=/etc/anywhere; DATA=/var/lib/anywhere; PORT=18250; HTTPS_PORT=8443
say() { printf '\033[1;33m›\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Run as root, for example: curl -fsSL …/install.sh | sudo sh"
for tool in curl tar openssl python3 sha256sum; do command -v $tool >/dev/null || die "$tool is required."; done

# Node.js 22+: use the system one if recent enough, otherwise a private copy in $APP/node.
NODE=$(command -v node || true)
if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) die "Unsupported CPU $(uname -m); install Node.js 22+ yourself.";; esac
  command -v xz >/dev/null || die "xz is required to unpack Node.js (apt install xz-utils)."
  FILE=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk "/linux-$ARCH.tar.xz/ {print \$2}")
  say "Installing Node.js ($FILE)"
  rm -rf "$APP/node"; mkdir -p "$APP/node"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$FILE" | tar -xJ -C "$APP/node" --strip-components=1
  NODE=$APP/node/bin/node
fi

say "Downloading Anywhere"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if [ -n "${ANYWHERE_TARBALL:-}" ]; then tar -xzf "$ANYWHERE_TARBALL" -C "$TMP"
else curl -fsSL "https://github.com/$REPO/releases/latest/download/anywhere.tar.gz" | tar -xz -C "$TMP"; fi
SRC=$(find "$TMP" -maxdepth 3 -name server.mjs -path '*/hub/*' | head -1); SRC=${SRC%/hub/server.mjs}
[ -n "$SRC" ] || die "The download did not contain Anywhere."
mkdir -p "$APP"; rm -rf "$APP/hub" "$APP/public" "$APP/deploy"
cp -r "$SRC/hub" "$SRC/public" "$SRC/deploy" "$APP/"
find "$APP/hub" "$APP/public" -type d -exec chmod 755 {} +; find "$APP/hub" "$APP/public" -type f -exec chmod 644 {} +

id anywhere >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin anywhere
install -d -o anywhere -g anywhere -m 700 "$DATA"; install -d -m 750 "$ETC"; chown root:anywhere "$ETC"

# How the app is reached. Only decided on first install; updates keep the existing choice.
ORIGIN=${ANYWHERE_ORIGIN:-}; DOMAIN=${ANYWHERE_DOMAIN:-}; LAN=${ANYWHERE_LAN:-}; LISTEN=127.0.0.1
setup_tailscale() {
  NAME=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
  ORIGIN=https://$NAME:$HTTPS_PORT
  tailscale serve --bg --https=$HTTPS_PORT http://127.0.0.1:$PORT >/dev/null || die "tailscale serve failed (enable HTTPS certificates for your tailnet in the Tailscale admin console)."
}
setup_domain() {
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '[:.](80|443)$'; then
    command -v caddy >/dev/null && grep -qs "anywhere" /etc/caddy/Caddyfile || die "Ports 80/443 are already used on this server. Point your existing web server to 127.0.0.1:$PORT and re-run with ANYWHERE_ORIGIN=https://$DOMAIN"
  fi
  if ! command -v caddy >/dev/null; then
    command -v apt-get >/dev/null || die "Automatic HTTPS needs Caddy; install it (https://caddyserver.com/docs/install) and re-run."
    say "Installing Caddy for automatic HTTPS"; apt-get install -y -qq caddy >/dev/null
  fi
  if [ -s /etc/caddy/Caddyfile ] && ! grep -qs "The Caddyfile is an easy way" /etc/caddy/Caddyfile && ! grep -qs "anywhere" /etc/caddy/Caddyfile; then
    die "/etc/caddy/Caddyfile already has a configuration. Add this block yourself, then re-run with ANYWHERE_ORIGIN=https://$DOMAIN:
  $DOMAIN { reverse_proxy 127.0.0.1:$PORT }"
  fi
  printf '# Anywhere\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" > /etc/caddy/Caddyfile
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  ORIGIN=https://$DOMAIN
}
setup_lan() {
  IP=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -n "$IP" ] || die "Could not find this server's local IP address."
  ORIGIN=http://$IP:$PORT; LISTEN=0.0.0.0
}
if [ ! -f "$ETC/config.json" ] && [ -z "$ORIGIN" ]; then
  if [ -n "$DOMAIN" ]; then setup_domain
  elif [ "$LAN" = 1 ]; then setup_lan
  elif command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then setup_tailscale
  elif ( : < /dev/tty ) 2>/dev/null; then
    printf '\nHow will you open Anywhere?\n  1) A domain name pointing to this server (automatic HTTPS)\n  2) My own reverse proxy (nginx, Traefik, Cloudflare Tunnel…)\n  3) Only on my local network (http, no HTTPS)\nChoice [1-3]: ' > /dev/tty
    read -r CHOICE < /dev/tty
    case "$CHOICE" in
      1) printf 'Domain name (e.g. anywhere.example.com): ' > /dev/tty; read -r DOMAIN < /dev/tty; [ -n "$DOMAIN" ] || die "No domain given."; setup_domain;;
      2) printf 'Public address of your proxy (https://…): ' > /dev/tty; read -r ORIGIN < /dev/tty; [ -n "$ORIGIN" ] || die "No address given."
         say "Point your proxy to http://127.0.0.1:$PORT";;
      3) setup_lan;;
      *) die "Unknown choice.";;
    esac
  else
    die "Tell the installer how Anywhere will be reached: ANYWHERE_DOMAIN=…, ANYWHERE_ORIGIN=…, or ANYWHERE_LAN=1 (see the README)."
  fi
fi
[ -f "$ETC/config.json" ] && LISTEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("listen", "127.0.0.1"))' "$ETC/config.json")

KEY_FILE=/root/.config/anywhere-signing/agent-ed25519.pem
FIRST=0
if [ ! -f "$ETC/config.json" ]; then
  FIRST=1
  ACCESS_KEY=$(openssl rand -base64 36 | tr -d '=+/' | cut -c1-32)
  [ -f "$KEY_FILE" ] || ANYWHERE_SIGNING_KEY=$KEY_FILE python3 "$APP/deploy/publish-agent.py" --init-key >/dev/null
  PUBLIC_KEY=$(openssl pkey -in "$KEY_FILE" -pubout -outform DER | tail -c 32 | base64)
  ORIGIN=$ORIGIN LISTEN=$LISTEN PORT=$PORT HASH=$(printf '%s' "$ACCESS_KEY" | sha256sum | cut -d' ' -f1) PUBLIC_KEY=$PUBLIC_KEY python3 - "$ETC/config.json" <<'PY'
import json, os, sys
config = {"publicOrigin": os.environ["ORIGIN"].rstrip("/"), "listen": os.environ["LISTEN"], "port": int(os.environ["PORT"]), "loginTokenHash": os.environ["HASH"],
          "updatePublicKey": os.environ["PUBLIC_KEY"], "ownerName": "", "devices": []}
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: json.dump(config, f, indent=2)
PY
fi
chown anywhere:anywhere "$ETC/config.json"; chmod 600 "$ETC/config.json"
[ -f "$KEY_FILE" ] && ANYWHERE_APP=$APP ANYWHERE_SIGNING_KEY=$KEY_FILE python3 "$APP/deploy/publish-agent.py" --force >/dev/null

if [ "${ANYWHERE_NO_SYSTEMD:-}" != 1 ]; then
  cat > /etc/systemd/system/anywhere-hub.service <<UNIT
[Unit]
Description=Anywhere hub
After=network-online.target
Wants=network-online.target

[Service]
User=anywhere
Group=anywhere
WorkingDirectory=$APP
Environment=HOST=$LISTEN
Environment=PORT=$PORT
Environment=LAUNCHER_CONFIG=$ETC/config.json
Environment=LAUNCHER_STATE=$DATA/state.json
ExecStart=$NODE $APP/hub/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload; systemctl enable anywhere-hub.service >/dev/null 2>&1; systemctl restart anywhere-hub.service
  sleep 1; systemctl is-active --quiet anywhere-hub.service || die "The hub did not start: journalctl -u anywhere-hub -n 30"
fi

ORIGIN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["publicOrigin"])' "$ETC/config.json")
printf '\n\033[1;32m✓ Anywhere is running.\033[0m\n\n  Open:        %s\n' "$ORIGIN"
if [ "$FIRST" = 1 ]; then printf '  Access key:  %s   (shown once; keep it in your password manager)\n' "$ACCESS_KEY"; fi
case "$ORIGIN" in http://*) printf '\n  Note: plain http works on your local network only, and phones cannot install it as an app.\n';; esac
printf '\n  Next: sign in, then use "+ Add" next to Devices for each computer or server.\n\n'
