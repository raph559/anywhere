# Installing Anywhere

You need a Linux server (any small VPS or home server) for the hub, and [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in on each machine you want to use.

## 1. Install the hub on your server

```sh
curl -fsSL https://github.com/raph559/anywhere/releases/latest/download/install.sh | sudo sh
```

The installer sets everything up (Node.js included if needed) and asks how you'll open the app:

| Option | Address you get | Non-interactive form |
|---|---|---|
| Tailscale (picked automatically if installed) | `https://server.your-tailnet.ts.net:8443` | nothing to set |
| A domain name, HTTPS set up for you (Caddy) | `https://anywhere.example.com` | `sudo ANYWHERE_DOMAIN=anywhere.example.com sh` |
| Your own reverse proxy to `127.0.0.1:18250` | the address you use | `sudo ANYWHERE_ORIGIN=https://my-address sh` |
| Local network only, plain http | `http://192.168.1.20:18250` | `sudo ANYWHERE_LAN=1 sh` |

It ends by printing the address and your access key. The key is shown once; keep it in your password manager.

## 2. Add your machines

Open the address, sign in with the access key, then click **+ Add** next to *Devices*. Name the machine, pick its system, and paste the command shown:

- **Linux / WSL:** in a terminal
- **Windows:** in PowerShell

The machine appears online a few seconds later and its agent starts automatically from then on. On WSL, the installer also adds a Windows task that wakes WSL when you sign in.

## 3. On your phone

Open the same address, sign in, then **Share → Add to Home Screen** (needs an HTTPS address).

## Updating

Run the install command again. Settings, devices and sessions are kept, and every machine updates its agent by itself through signed updates.

## Uninstalling

On the server:

```sh
sudo systemctl disable --now anywhere-hub
sudo rm -rf /opt/anywhere /etc/anywhere /var/lib/anywhere /etc/systemd/system/anywhere-hub.service
sudo rm -rf /root/.config/anywhere-signing   # the key that signs agent updates
sudo userdel anywhere
```

If you chose the domain option, also remove the Anywhere block from `/etc/caddy/Caddyfile`. With Tailscale, run `sudo tailscale serve --https=8443 off`.

On each machine, stop the agent (`anywhere-agent` service on Linux, the *Anywhere agent* scheduled task on Windows) and delete its folder (`~/.anywhere-agent` by default).

## Troubleshooting

See the [FAQ in the README](../README.md#faq). To get a new access key: `sudo sh /opt/anywhere/deploy/reset-access-key.sh`.
