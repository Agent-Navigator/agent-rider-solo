# Agent Rider

Agent Rider is a local workspace UI with a React frontend and a single Rust
server. Production installations do not need a source checkout, GitHub
credentials, Node.js, npm, or a Rust toolchain.

## Install on Linux

The intended public command is:

```bash
curl -fsSL https://YOUR-DOMAIN/install.sh | sh
```

`YOUR-DOMAIN` must issue an HTTP redirect to:

```text
https://github.com/ytk77/agent-rider/releases/latest/download/install.sh
```

Until that domain is configured, the direct equivalent is:

```bash
curl -fsSL https://github.com/ytk77/agent-rider/releases/latest/download/install.sh | sh
```

The installer supports Linux x86_64 and arm64. It requires systemd user
services, `curl`, `tar`, `gzip`, and `sha256sum`. It verifies the selected
release archive before changing services, installs as the invoking user, and on
a clean install uses `sudo` only to enable systemd lingering. Legacy migration
also needs `sudo` to stop and preserve the former system services. The installer
never edits shell profiles.

If `~/.local/bin` is not in the current `PATH`, installation still succeeds and
prints that a new login shell is required.

## Upgrade

Stable upgrades are one command:

```bash
agrider upgrade
```

The command ignores prereleases, locks out concurrent upgrades, downloads and
verifies the complete release before stopping the service, backs up state,
atomically switches releases, and rolls back if startup or `/store/state`
health validation fails.

## User installation layout

```text
~/.local/bin/agrider                         CLI symlink
${XDG_DATA_HOME:-~/.local/share}/agrider/
  current                                   active release symlink
  releases/<version>/                       immutable program releases
  shared/data/                              SQLite and persistent state
  shared/plugins/                           local Agent Apps
  shared/backups/                           upgrade and migration backups
${XDG_CONFIG_HOME:-~/.config}/agrider/env   service configuration
~/.config/systemd/user/agrider.service      user service
```

The server listens on `127.0.0.1:5173` by default. Configuration values include
`AGENT_RIDER_PORT`, `BROWSE_ROOT`, `HERMES_TARGET`, and
`AGENT_RIDER_APPS_DIR`. After editing the environment file, run:

```bash
systemctl --user restart agrider
```

View status and logs with:

```bash
systemctl --user status agrider
journalctl --user -u agrider -f
```

## Existing `/opt/agent-rider` installations

The installer detects the former two-service deployment. It verifies that the
invoking user matches the old systemd `User=`, preserves ports, browse root,
Hermes target, SQLite data, and local apps, and creates a complete migration
backup before enabling the new user service. A failed health check restores and
starts both former system services.

## Development

Node.js is required only for frontend development:

```bash
npm ci
npm run store
npm run dev
```

Production-like local verification:

```bash
npm run build
cargo run -- serve
```

Run the release acceptance suites with:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
npm run test:contract
npm run test:upgrade
test/install-rootless.test.sh
```

Release and distribution setup is documented in
[`docs/deployment.md`](docs/deployment.md).
