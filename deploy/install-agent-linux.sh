#!/bin/sh
# Run the Anywhere agent on a Linux server as a systemd service (run as the user that owns
# the Claude Code login; root shown here). Expects device_agent.py and config.json in $DIR.
set -eu
DIR=${1:-/root/.anywhere-agent}
test -f "$DIR/device_agent.py" && test -f "$DIR/config.json"
chmod 700 "$DIR" && chmod 600 "$DIR/config.json"
python3 "$DIR/device_agent.py" check --config "$DIR/config.json"
cat > /etc/systemd/system/anywhere-agent.service <<UNIT
[Unit]
Description=Anywhere device agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 $DIR/device_agent.py run --config $DIR/config.json
Restart=on-failure
RestartSec=5
# Restarting the agent must not end the Claude sessions it started.
KillMode=process
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now anywhere-agent.service
systemctl is-active anywhere-agent.service
