#!/usr/bin/env python3
"""Sign the device agent so connected agents install it automatically.

  python3 deploy/publish-agent.py --init-key   create the signing key, print the public key
  python3 deploy/publish-agent.py              sign public/install/device_agent.py

Run as root on the hub server after raising VERSION in the agent. Keep the private
key out of the web service's reach; agents only install updates carrying a valid
signature from the public key in their "updatePublicKey" setting.
"""
import hashlib, json, os, re, subprocess, sys, tempfile, base64
from pathlib import Path

APP = Path(os.environ.get("ANYWHERE_APP", "/opt/anywhere"))
KEY = Path(os.environ.get("ANYWHERE_SIGNING_KEY", "/root/.config/anywhere-signing/agent-ed25519.pem"))
if "--init-key" in sys.argv:
    if KEY.exists():
        sys.exit(f"{KEY} already exists; refusing to overwrite it.")
    KEY.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    old = os.umask(0o077)
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(KEY)], check=True)
    os.umask(old)
    der = subprocess.run(["openssl", "pkey", "-in", str(KEY), "-pubout", "-outform", "DER"], check=True, capture_output=True).stdout
    print(f"Created {KEY}. Put this in every agent configuration as \"updatePublicKey\":")
    print(base64.b64encode(der[-32:]).decode())
    sys.exit(0)
agent = APP / "public/install/device_agent.py"
code = agent.read_bytes()
version = int(re.search(rb"^VERSION = (\d+)$", code, re.M).group(1))
manifest_path = APP / "public/install/agent-manifest.json"
if manifest_path.exists():
    previous = json.loads(json.loads(manifest_path.read_text())["payload"])["version"]
    if version <= previous and "--force" not in sys.argv:
        sys.exit(f"VERSION {version} is not above the published version {previous}; raise VERSION first.")
payload = json.dumps({"name": "anywhere-device-agent", "version": version, "sha256": hashlib.sha256(code).hexdigest()}, sort_keys=True, separators=(",", ":"))
with tempfile.TemporaryDirectory() as tmp:
    message, signature = Path(tmp, "m"), Path(tmp, "s")
    message.write_text(payload)
    subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(KEY), "-in", str(message), "-out", str(signature)], check=True)
    sig = signature.read_bytes()
manifest_path.write_text(json.dumps({"payload": payload, "signature": base64.b64encode(sig).decode()}, indent=2) + "\n")
os.chmod(manifest_path, 0o644)
print(f"Published agent version {version} ({hashlib.sha256(code).hexdigest()[:12]}). Agents update within about a minute.")
