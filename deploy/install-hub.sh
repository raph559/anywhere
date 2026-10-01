#!/bin/sh
# Install the Anywhere hub as a systemd service (run as root).
# Expects the application in /opt/anywhere and its configuration in /etc/anywhere/config.json.
set -eu
APP=/opt/anywhere
test -f $APP/hub/server.mjs
test -f /etc/anywhere/config.json
find $APP/hub $APP/public -type d -exec chmod 755 {} +
find $APP/hub $APP/public -type f -exec chmod 644 {} +
if ! id anywhere >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/anywhere --shell /usr/sbin/nologin anywhere
fi
install -d -o anywhere -g anywhere -m 700 /var/lib/anywhere
chown root:anywhere /etc/anywhere && chmod 750 /etc/anywhere
chown anywhere:anywhere /etc/anywhere/config.json && chmod 600 /etc/anywhere/config.json
node_binary=$(readlink -f "$(command -v node)")
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
Environment=PORT=18250
Environment=LAUNCHER_CONFIG=/etc/anywhere/config.json
Environment=LAUNCHER_STATE=/var/lib/anywhere/state.json
ExecStart=$node_binary $APP/hub/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/anywhere
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now anywhere-hub.service
systemctl is-active anywhere-hub.service
