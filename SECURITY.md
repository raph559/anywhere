# Security policy

Anywhere can start Claude Code with full permissions on your machines, so security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub instead: [Security → Report a vulnerability](https://github.com/raph559/anywhere/security/advisories/new).

Include what you found, how to reproduce it, and which version you used (the release tag, or `VERSION` in `public/install/device_agent.py` for agents). You'll get an answer within a few days, and credit in the release notes if you'd like.

## Supported versions

Only the [latest release](https://github.com/raph559/anywhere/releases/latest) gets security fixes. To update, run the install command again: settings, devices and sessions are kept, and agents update themselves through signed updates.

## Scope

- The hub (`hub/server.mjs`) and the web app (`public/`)
- The agents (`public/install/device_agent.py`, `agent.sh`, `agent.ps1`) and the installer (`install.sh`)

Claude Code itself, Tailscale, Caddy and other third-party software are out of scope; please report those to their maintainers.

See also the [Security section of the README](README.md#security).
