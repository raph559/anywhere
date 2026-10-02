#!/bin/sh
# Anywhere agent installer for Linux and WSL. Run the exact command shown in Anywhere:
#   curl -fsSL https://HUB/install/agent.sh | sh -s -- https://HUB CODE
# Options (environment): ANYWHERE_DIR (default ~/.anywhere-agent), ANYWHERE_CLAUDE (path to claude),
# ANYWHERE_NO_AUTOSTART=1 (start once, without installing autostart).
set -eu
HUB=${1:?Usage: agent.sh HUB_URL CODE}; CODE=${2:?Usage: agent.sh HUB_URL CODE}
HUB=${HUB%/}; DIR=${ANYWHERE_DIR:-$HOME/.anywhere-agent}
say() { printf '\033[1;33m›\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required."
PY=$(command -v python3 || true); [ -n "$PY" ] || die "Python 3.10 or newer is required (python3 not found)."
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || die "Python 3.10 or newer is required."
CLAUDE=${ANYWHERE_CLAUDE:-$(command -v claude || true)}
[ -n "$CLAUDE" ] || [ ! -x "$HOME/.local/bin/claude" ] || CLAUDE=$HOME/.local/bin/claude
[ -n "$CLAUDE" ] || die "Claude Code (claude) was not found. Install it and sign in first: https://docs.claude.com/en/docs/claude-code"
CLAUDE=$(readlink -f "$CLAUDE")

say "Installing the agent in $DIR"
mkdir -p "$DIR"; chmod 700 "$DIR"
curl -fsSL "$HUB/install/device_agent.py" -o "$DIR/device_agent.py"

say "Connecting to $HUB"
RESPONSE=$(curl -fsS -X POST -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}" "$HUB/api/agents/enroll") || die "The code was refused. Create a new one in Anywhere (codes expire after 30 minutes and work once)."
RESPONSE=$RESPONSE CLAUDE=$CLAUDE DIR=$DIR "$PY" - <<'PY'
import json, os
r = json.loads(os.environ["RESPONSE"]); home = os.path.expanduser("~")
config = {"deviceId": r["deviceId"], "deviceSecret": r["deviceSecret"], "hubUrl": r["hubUrl"], "label": r["label"],
          "claudePath": os.environ["CLAUDE"], "roots": [{"name": "Home", "path": home}], "defaultPath": home, "stateDir": "state"}
if r.get("updatePublicKey"): config["updatePublicKey"] = r["updatePublicKey"]
if r["hubUrl"].startswith("http://"): config["allowLocalHttp"] = True
path = os.path.join(os.environ["DIR"], "config.json")
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: json.dump(config, f, indent=2)
PY
"$PY" "$DIR/device_agent.py" check --config "$DIR/config.json" >/dev/null || die "The agent check failed; run: $PY $DIR/device_agent.py check --config $DIR/config.json"

RUN="$PY $DIR/device_agent.py run --config $DIR/config.json"
if [ "${ANYWHERE_NO_AUTOSTART:-}" = 1 ]; then
  nohup $RUN >> "$DIR/agent.log" 2>&1 &
  say "Started (no autostart installed)."
elif [ "$(id -u)" = 0 ] && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/anywhere-agent.service <<UNIT
[Unit]
Description=Anywhere agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
Environment=HOME=$HOME
Environment=PATH=$(dirname "$CLAUDE"):/usr/local/bin:/usr/bin:/bin
ExecStart=$RUN
Restart=on-failure
RestartSec=5
KillMode=process
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload && systemctl enable --now anywhere-agent.service >/dev/null
  say "Installed as the system service anywhere-agent."
elif [ -d /run/systemd/system ] && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/anywhere-agent.service" <<UNIT
[Unit]
Description=Anywhere agent

[Service]
WorkingDirectory=$DIR
Environment=PATH=$(dirname "$CLAUDE"):/usr/local/bin:/usr/bin:/bin
ExecStart=$RUN
Restart=on-failure
RestartSec=5
KillMode=process

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload && systemctl --user enable --now anywhere-agent.service >/dev/null
  loginctl enable-linger "$(id -un)" 2>/dev/null || true
  say "Installed as a user service (starts with your session)."
else
  cat > "$DIR/start.sh" <<START
#!/bin/sh
# Started from your shell profile; the agent's lock keeps a single copy running.
nohup $RUN >> "$DIR/agent.log" 2>&1 &
START
  chmod 700 "$DIR/start.sh"
  LINE="[ -x \"$DIR/start.sh\" ] && \"$DIR/start.sh\" >/dev/null 2>&1"
  grep -qsF "$DIR/start.sh" "$HOME/.profile" || printf '\n# Anywhere agent\n%s\n' "$LINE" >> "$HOME/.profile"
  "$DIR/start.sh"
  say "Started; it restarts with each new login shell (added to ~/.profile)."
fi
# WSL only starts when Windows starts something in it: add a Windows logon task that wakes this distro.
if [ "${ANYWHERE_NO_AUTOSTART:-}" != 1 ] && [ -n "${WSL_DISTRO_NAME:-}" ]; then
  curl -fsSL "$HUB/install/wsl-autostart.sh" | ANYWHERE_DIR=$DIR sh || say "Without that Windows task, the agent only starts when WSL itself is opened."
fi
printf '\033[1;32m✓ Done.\033[0m This device appears as online in Anywhere within a few seconds.\n'
