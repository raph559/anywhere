#!/bin/sh
# Anywhere hub installer. Installs or updates the hub on a Linux server (run as root):
#   curl -fsSL https://github.com/raph559/anywhere/releases/latest/download/install.sh | sudo sh
# Re-running it updates the app and keeps your configuration, devices and sessions.
# Options (environment): ANYWHERE_ORIGIN (HTTPS address, if you don't use Tailscale Serve),
# ANYWHERE_TARBALL (local release archive), ANYWHERE_NO_SYSTEMD=1 (don't install the service).
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

# Private HTTPS address: Tailscale Serve when available.
ORIGIN=${ANYWHERE_ORIGIN:-}
if [ -z "$ORIGIN" ] && command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  NAME=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
  ORIGIN=https://$NAME:$HTTPS_PORT
  tailscale serve --bg --https=$HTTPS_PORT http://127.0.0.1:$PORT >/dev/null || die "tailscale serve failed (enable HTTPS certificates for your tailnet in the Tailscale admin console)."
fi

KEY_FILE=/root/.config/anywhere-signing/agent-ed25519.pem
FIRST=0
if [ ! -f "$ETC/config.json" ]; then
  [ -n "$ORIGIN" ] || die "No Tailscale found. Re-run with ANYWHERE_ORIGIN=https://your-private-address (served by your reverse proxy to 127.0.0.1:$PORT)."
  FIRST=1
  ACCESS_KEY=$(openssl rand -base64 36 | tr -d '=+/' | cut -c1-32)
  [ -f "$KEY_FILE" ] || ANYWHERE_SIGNING_KEY=$KEY_FILE python3 "$APP/deploy/publish-agent.py" --init-key >/dev/null
  PUBLIC_KEY=$(openssl pkey -in "$KEY_FILE" -pubout -outform DER | tail -c 32 | base64)
  ORIGIN=$ORIGIN PORT=$PORT HASH=$(printf '%s' "$ACCESS_KEY" | sha256sum | cut -d' ' -f1) PUBLIC_KEY=$PUBLIC_KEY python3 - "$ETC/config.json" <<'PY'
import json, os, sys
config = {"publicOrigin": os.environ["ORIGIN"], "port": int(os.environ["PORT"]), "loginTokenHash": os.environ["HASH"],
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
Environment=HOST=127.0.0.1
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
printf '\n  Next: sign in, then use "Add a device" in the sidebar for each computer or server.\n\n'
