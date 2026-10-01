#!/bin/sh
# Replace the browser access key (run as root on the hub), e.g. if you lost it.
set -eu
CONFIG=${1:-/etc/anywhere/config.json}
KEY=$(openssl rand -base64 36 | tr -d '=+/' | cut -c1-32)
HASH=$(printf '%s' "$KEY" | sha256sum | cut -d' ' -f1) python3 - "$CONFIG" <<'PY'
import json, os, sys
path = sys.argv[1]; config = json.load(open(path)); config["loginTokenHash"] = os.environ["HASH"]
tmp = path + ".tmp"; json.dump(config, open(tmp, "w"), indent=2); os.chmod(tmp, 0o600); os.replace(tmp, path)
PY
chown anywhere:anywhere "$CONFIG" 2>/dev/null || true
systemctl restart anywhere-hub.service 2>/dev/null || true
printf 'New access key: %s\n' "$KEY"
