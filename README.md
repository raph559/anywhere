# Anywhere

Start, open and stop [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions on your own machines, from your phone or any browser.

Pick a machine, browse to a folder, tap **Start**: Anywhere launches `claude remote-control` there and hands you the link to continue in the official Claude app or website. Running sessions can be watched, stopped, restarted, renamed and pinned from the same place.

> Anywhere is an independent open-source project. It is not affiliated with, endorsed by or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## Features

- **Every machine in one place**: Linux servers, WSL and native Windows, each with its own agent. Sessions are grouped by device; devices can be reordered by drag and drop and hidden.
- **Folder browser** with project detection, hidden-folder toggle, filter, and a marker on folders where Claude already runs.
- **Permission mode per session**: *Ask*, *Accept edits* or *Full auto* (`bypassPermissions`).
- **Live launch timeline**: reach the device → start Claude → get the link. Claude's own confirmation questions (folder trust, enabling Remote Control) are answered from the app, and a banner tells you when one is waiting.
- **Stop, start again, rename, pin, remove with undo.**
- **Installable web app** (PWA) with a phone-first interface, light and dark themes, and motion that respects *Reduce motion*.
- **Signed agent self-update**: publish a new agent once on the hub; every agent verifies the Ed25519 signature before installing it.
- **No dependencies**: the hub is a single Node.js file, the agent a single Python file (plus `pywinpty` on native Windows).

## How it works

```
 phone / browser ──HTTPS──▶ hub (Node.js, on a server)
                              ▲  outbound long-poll, per-device secret
             ┌────────────────┼────────────────┐
         agent (Linux)    agent (WSL)    agent (Windows)
             │                │                │
     claude remote-control   ...              ...
```

- The **hub** serves the web app and relays commands. It never sees Claude credentials.
- Each **agent** connects *out* to the hub (no inbound ports on your computers), lists folders inside the roots you allow, and starts Claude Code's Remote Control in the chosen folder. Claude stays logged in with each machine's own account.
- Conversations happen in Claude itself; Anywhere only manages the sessions.

## Security model — read before installing

Anywhere can start a Claude Code agent with full permissions on your machines from a web page. Treat it like remote access:

- **Keep the hub private.** The recommended setup is [Tailscale Serve](https://tailscale.com/kb/1312/serve) (HTTPS inside your tailnet only). Do not expose it to the public internet.
- The browser signs in with an **access key**; each device has its own **secret**. The hub stores only SHA-256 hashes of both. Sessions use `HttpOnly`, `SameSite=Strict` cookies and a CSRF token; the page ships a strict Content Security Policy.
- Agents only browse and launch inside their configured **roots**, and only stop processes they started themselves (verified by PID, start time and executable).
- **Full auto** means Claude will read, edit and run anything on that machine without asking. Claude Code refuses it when running as root.
- **Self-update** runs signed code on every agent. Keep the signing key root-only on the hub, away from the web service, or omit `updatePublicKey` / set `"autoUpdate": false` to disable it.

## Requirements

- Hub: Linux server with Node.js 22+ and systemd, behind private HTTPS (Tailscale Serve, or a reverse proxy on a private network).
- Agents: Python 3.10+ and a logged-in native Claude Code (`claude`) with Remote Control available. Native Windows also needs `pip install pywinpty`.

## Setup

### 1. Hub

```sh
sudo mkdir -p /opt/anywhere /etc/anywhere
sudo cp -r hub public deploy package.json /opt/anywhere/
sh deploy/new-secret.sh            # browser access key: keep the secret, put the hash in the config
sudo cp examples/hub-config.json /etc/anywhere/config.json   # then edit it
sudo sh /opt/anywhere/deploy/install-hub.sh
tailscale serve --bg --https=8443 http://127.0.0.1:18250
```

Set `publicOrigin` to the HTTPS address you open in the browser. Add one entry per device (`id`, `name`, `os` = `linux` | `wsl` | `windows`, browsing `roots`, `defaultPath`, `tokenHash`). `ownerName` is optional and only used for the greeting.

### 2. Signing key for agent updates (optional, recommended)

```sh
sudo python3 /opt/anywhere/deploy/publish-agent.py --init-key   # prints the public key
sudo python3 /opt/anywhere/deploy/publish-agent.py              # signs the current agent
```

Put the printed public key in every agent configuration as `updatePublicKey`. Later, raise `VERSION` in `public/install/device_agent.py`, copy it to `/opt/anywhere/public/install/` and run the publish command again: online agents update themselves within about a minute.

### 3. Agents

For each device, create a secret (`deploy/new-secret.sh`), put its hash in the hub's device entry, and copy `public/install/device_agent.py` with a configuration based on `examples/agent-config.json` (`deviceId` must match the hub, `claudePath` must be the absolute path of the native `claude` executable).

```sh
python3 device_agent.py check --config config.json   # validates the configuration
```

- **Linux server**: `sudo sh deploy/install-agent-linux.sh /path/to/agent-folder` installs a systemd service. `KillMode=process` keeps running sessions alive when the agent restarts.
- **WSL / desktop Linux**: run `python3 device_agent.py run --config config.json` from a login script or a user service.
- **Windows**: `py -m pip install pywinpty`, then `py device_agent.py run --config config.json` (for example from Task Scheduler at logon). `claudePath` must point to `claude.exe`.

A WSL distribution and its Windows host are separate devices with separate agents.

### 4. Phone

Open the hub address (connected to the same tailnet), sign in with the access key, then *Share → Add to Home Screen*.

## Configuration reference

Hub (`/etc/anywhere/config.json`): `publicOrigin`, `port`, `loginTokenHash`, `ownerName`, `devices[]` (`id`, `name`, `os`, `roots`, `defaultPath`, `tokenHash`, optional `description`).

Agent (`config.json`): `deviceId`, `deviceSecret`, `hubUrl`, `label`, `claudePath`, `roots`, `defaultPath`, `stateDir`, optional `updatePublicKey`, `autoUpdate`, `supportsNoChrome`, and `allowLocalHttp` (local testing only).

Device order, hidden devices, session names and pins are stored by the hub in its state file, so every browser shows the same organisation.

## Troubleshooting

| Symptom | Check |
|---|---|
| The page does not open | Tailscale is connected on the phone; `tailscale serve status`; `systemctl status anywhere-hub` |
| A device is offline | Its agent is running and `check` passes; the device secret matches the hub's hash |
| "Taking longer" while starting | Claude Code on that machine may need a login or a setup prompt; see the agent's `state/brokers/*/claude.log` |
| Stop is disabled | The agent is too old; update it once by hand, then self-update takes over |

## License

[MIT](LICENSE). The bundled Source Serif 4 font is licensed under the SIL Open Font License 1.1 ([public/fonts/OFL.txt](public/fonts/OFL.txt)).
