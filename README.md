# Agent Rider

https://github.com/user-attachments/assets/b9b72d9e-39d7-4f45-8bc3-8cb55706a233

<div align="center">

<h1>🏍️ Agent Rider Solo</h1>

<p><strong>A self-hosted browser workspace for Claude Code, OpenAI Codex CLI, Agy, Devin, and custom AI coding agents on Linux.</strong></p>

<br/>

[![License: Apache 2.0 + Commons Clause](https://img.shields.io/badge/License-Apache%202.0%20%2B%20Commons%20Clause-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Built%20with-Rust-orange.svg)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/Built%20with-React-blue.svg)](https://react.dev/)

</div>

---

## What is Agent Rider?

Agent Rider Solo is a local-first, single-user workspace for developers who run terminal-based AI agents on a Linux workstation, remote development server, or cloud VM. It gives Claude Code, OpenAI Codex CLI, Agy, Devin, and custom commands a visual home in the browser without replacing their native terminal interfaces.

Each conversation runs in an embedded, tmux-backed terminal. You can keep multiple AI coding agents active, assign each one a workspace folder, arrange them in flexible layouts, and return to persistent sessions after reconnecting or refreshing the browser.

The production runtime combines a Rust server, a prebuilt React interface, and local SQLite storage. It does not require Node.js, npm, Docker, or an external database.

## Who is it for?

Agent Rider is designed for:

- Software developers and indie hackers using more than one AI coding agent.
- DevOps and platform engineers managing agent workflows on remote Linux servers or cloud VMs.
- Claude Code, Codex CLI, Agy, and Devin users who want a browser-based terminal workspace.
- Developers looking for a self-hosted, local-first alternative to a hosted AI agent dashboard.
- Power users who want persistent terminal sessions, project organization, and local control of workspace data.

## Current features

- **Multi-agent workspace** — Run Claude Code, OpenAI Codex CLI, Agy, Devin, or a custom shell command in separate conversation cards.
- **Persistent browser terminals** — tmux-backed PTY sessions keep agent processes and terminal history available across browser reconnects.
- **Conversation and project organization** — Group work by category, project, workspace, task, and job while keeping follow-up turns together.
- **Flexible workspace layouts** — Switch between single-column, two-up, three-column, quad, master-and-stack, and configurable grid layouts; drag cards and tools into place.
- **Agent usage checks** — Read supported usage and quota status from active Claude Code, Codex, and Agy sessions.
- **Workspace file browser** — Browse, search, upload, download, delete, and preview files within the configured browse root. Preview Markdown, source code, images, and HTML without leaving the workspace.
- **Built-in work tools** — Open a general-purpose local terminal and a persistent to-do list alongside agent conversations.
- **Local persistence** — Store conversations, layout preferences, app metadata, and to-do items in SQLite on the host you control.
- **Optional password gate** — Protect the web workspace with a local password and authenticated session cookie.
- **Safe upgrades** — Verify release checksums, back up local state, switch releases atomically, run a health check, and roll back automatically if startup fails.

## Linux compatibility

Published releases support `x86_64` and `arm64` Linux systems with systemd user services. This includes typical installations of Ubuntu, Debian, Fedora, Red Hat Enterprise Linux, Rocky Linux, AlmaLinux, and Arch Linux.

Agent Rider is not currently packaged for macOS, Windows, systemd-free distributions, or minimal containers without a working user systemd session. WSL requires systemd to be enabled.

Required host tools:

- `curl`, `tar`, `gzip`, `sha256sum`, `awk`, `sed`, and `systemctl` for installation and service management.
- `tmux` for persistent terminal sessions.
- At least one supported agent CLI, or a custom agent command, installed separately.

Install the common prerequisites if needed:

```bash
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y curl tmux

# Fedora / RHEL / Rocky Linux / AlmaLinux
sudo dnf install -y curl tmux

# Arch Linux
sudo pacman -S --needed curl tmux
```

## Quick start

Install the latest release as your current Linux user:

```bash
curl -fsSL https://github.com/Agent-Navigator/agent-rider-solo/releases/latest/download/install.sh | sh
```

The installer creates a systemd user service for the current account and supports
both regular users and `root`. Regular-user installs use `sudo` only for system
Browser prerequisites, service migration, and systemd lingering; root installs
run those operations directly. Chrome is launched with `--no-sandbox` only when
Agent Rider itself runs as UID 0, because Chrome otherwise refuses to start as
root. Run Agent Rider as a regular user when Chrome sandboxing is required. The
installer does not modify your shell profile.

On the same machine, open:

```text
http://127.0.0.1:5173
```

For Agent Rider running on a remote Linux server or cloud VM, use an SSH tunnel or Tailscale.

### Option 1: SSH tunnel

Create the tunnel from your computer:

```bash
ssh -N -L 5173:127.0.0.1:5173 user@your-server
```

Then open `http://127.0.0.1:5173` in your local browser.

### Option 2: Tailscale with MagicDNS

[Tailscale](https://tailscale.com/) provides a private VPN between your devices. [MagicDNS](https://tailscale.com/docs/features/magicdns) gives each device a stable name, and [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) can securely proxy Agent Rider while the service remains bound to localhost.

1. Install Tailscale on the Linux server and connect it to your tailnet:

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

   Open the authentication URL printed by `tailscale up` and sign in. See the [official Linux installation guide](https://tailscale.com/docs/install/linux) for distribution-specific alternatives.

2. Give the server an easy-to-remember MagicDNS name:

   ```bash
   sudo tailscale set --hostname=agent-rider
   ```

3. Install Tailscale on your computer, sign in to the same tailnet, and confirm that MagicDNS is enabled on the **DNS** page of the Tailscale admin console. MagicDNS is enabled by default for new tailnets.

4. On the server, publish the local Agent Rider port privately to your tailnet:

   ```bash
   sudo tailscale serve --bg 5173
   sudo tailscale serve status
   ```

   The first command may display a browser link asking you to enable HTTPS certificates for the tailnet. After approval, `tailscale serve status` prints an address similar to:

   ```text
   https://agent-rider.your-tailnet.ts.net
   ```

5. Open the printed HTTPS address from any device connected to the same tailnet. Tailnet access-control rules determine which users and devices can reach it.

Use **Tailscale Serve**, not **Tailscale Funnel**: Serve keeps Agent Rider private to your tailnet, while Funnel publishes a service to the public internet. An Agent Rider page password is still recommended when more than one tailnet user can reach the server.

Agent Rider detects supported CLIs from the service `PATH`, including common locations such as `~/.local/bin`, `/usr/local/bin`, and `/usr/bin`. You can add or edit agent commands from Settings.

## Current scope and privacy

Agent Rider is self-hosted and keeps its own state on your machine. The AI agent CLIs remain independent tools: they may send prompts, source code, or other data to their configured providers according to those providers' settings and privacy policies.

Agent Rider does not bundle AI models, provider subscriptions, API credentials, or the agent CLIs themselves. Persistent sessions refer to terminal and workspace continuity; a shared SIRA/MCP long-term memory service is not included in the current release.

## Browser automation interface

Every open Browser panel has a stable window ID shown in its header. Open the
panel's **Prompt Copy** (`✦`) control to put a ready-to-use prompt for that
specific window on the clipboard, then paste it into the agent you want to use.

Agents should use Agent Rider's built-in CLI:

```bash
agrider browser list
agrider browser inspect browser-1234abcd
agrider browser navigate browser-1234abcd https://web.telegram.org/
```

Run `agrider browser --help` for the complete command summary. The CLI selects
the intended panel by `windowId`, connects to the local Agent Rider service, and
handles the optional page-password session. Agents do not need to inspect Chrome
processes, discover ephemeral debugging ports, or reuse the workspace's browser
cookie.

The authenticated `/store/browser/sessions` response still includes `windowId`,
`url`, the loopback-only `debuggerUrl`, and `displayTransport: "WebRTC"` for
advanced CDP clients. The visible display and user input use Selkies WebRTC.

## Browser WebRTC runtime

Browser panels use an isolated Xvfb display, Openbox, and Selkies v1.6.2 on
Linux x86_64. Agent Rider prefers an installed Google Chrome Stable executable,
then its managed user-space Google Chrome Stable runtime; system Chromium is the
final automatic fallback. `AGENT_RIDER_BROWSER_PATH` can explicitly select
another Chrome-compatible executable. Every session receives a separate
temporary browser profile.

If system commands are missing, Agent Rider detects apt-, dnf-, yum-, zypper-,
and pacman-based distributions and displays the matching `sudo` package-install
command. The first Browser launch offers to download the pinned Selkies portable
runtime and Google's Chrome Stable Linux package into the user's managed Browser
directory. Agent Rider extracts Chrome from the package in user space and does
not invoke `sudo`.

WebRTC prefers direct ICE and waits 10 seconds before reporting that TURN is
required. Administrators can set these values in the service environment file:

```text
AGENT_RIDER_WEBRTC_STUN_URLS="stun:stun.l.google.com:19302"
AGENT_RIDER_WEBRTC_TURN_URLS="turn:turn.example.com:3478?transport=udp"
AGENT_RIDER_WEBRTC_TURN_USERNAME="username"
AGENT_RIDER_WEBRTC_TURN_CREDENTIAL="credential"
AGENT_RIDER_WEBRTC_FPS="60"
AGENT_RIDER_WEBRTC_BITRATE_KBPS="12000"
```

Multiple STUN or TURN URLs are comma-separated. Selkies and Chrome sidecar
ports bind only to loopback; the workspace exposes signaling through
authenticated per-window routes.

## Agent App workspace

Each Agent App window pairs a persistent TUI coding agent with a proxied App
View. The Apps button in the left rail opens a phone-style launcher containing
registered apps and a **New App** tile. Creating an app assigns a readable,
collision-free app ID (`app`, `app-2`, and so on), scaffolds its project
under `AGENT_RIDER_APPS_DIR/<app-id>/`, and starts the TUI in that exact folder.
The app icon and absolute project location are registered in Agent Rider's
SQLite database and remain available after the window is closed.

An app can provide its own launcher icon through `manifest.json`. Put the image
under the app's `dist/` directory and set `icon` to its dist-relative path:

```json
{
  "icon": "icon.svg"
}
```

SVG, PNG, WebP, GIF, AVIF, JPEG, and ICO files are supported, including paths
such as `assets/icon.png`. The built-in `app-window` icon remains the fallback.
The App View launch prompt gives coding agents the same convention so they can
configure the launcher icon while building the app.

Agent Rider automatically assigns an available loopback port; the title-bar
prompt button tells the TUI agent to launch the registered app workspace's
development server on that exact port. The App View detects the service and
opens it automatically, so no URL entry or separately exposed development port
is needed. The title bar identifies the window type as **Agent App** in the
center, while the editable app title defaults to **New App** and updates the
launcher label.

Wide windows place the TUI on the left and give the App View two thirds of the
width. Tall windows put the App View above the TUI with the same default share.
The divider is draggable (and keyboard adjustable), and the App name, port, and
split are persisted with the workspace layout.

The server-side proxy preserves native iframe DOM interaction while keeping
HTTP requests, redirects, page resources, and WebSockets under the authenticated
Agent Rider origin. Target cookies are isolated by proxied origin so they cannot
replace Agent Rider's own login cookie. Only run services you trust: their code
runs in a same-origin iframe and can access the Agent Rider UI.

## Service management

```bash
# Restart Agent Rider
systemctl --user restart agrider

# Follow service logs
journalctl --user -u agrider -f
journalctl --user -u agrider-runtime -f

# Check service status
systemctl --user status agrider agrider-runtime agrider-tmux
```

The service listens on `127.0.0.1:5173` by default.

## Upgrading

```bash
agrider upgrade
```

The upgrade command prevents concurrent updates, validates the new release,
backs up persistent data, and restores the previous release if the health check
fails. Persistent TUI and Browser processes live in separate runtime services,
so replacing the web application does not reset agent chats or Browser pages.
The first upgrade from an older single-service installation is staged while
legacy sessions are active and can be activated by rerunning the updater after
those sessions finish.

## Layout on disk

```text
~/.local/bin/agrider                         # CLI symlink
${XDG_DATA_HOME:-~/.local/share}/agrider/
  ├── current                                # Active release symlink
  ├── releases/<version>/                    # Immutable program releases
  └── shared/
      ├── data/                              # SQLite database and persistent state
      ├── plugins/                           # Local Agent Apps
      └── backups/                           # Upgrade and migration backups
${XDG_CONFIG_HOME:-~/.config}/agrider/env   # Service environment configuration
~/.config/systemd/user/agrider.service      # systemd user service
~/.config/systemd/user/agrider-runtime.service # Browser and terminal transport
~/.config/systemd/user/agrider-tmux.service    # Persistent TUI process owner
```

## License and contributions

- **License:** [Apache License 2.0 with Commons Clause License Condition v1.0](LICENSE).
- **Selkies client adaptation:** `src/selkies/client.ts` retains its upstream
  MPL-2.0 and Apache-2.0 notices. Downloaded Selkies/GStreamer runtime
  components remain under their respective upstream licenses.
- **Commercial restriction:** The Commons Clause does not grant the right to Sell the Software, as defined in the license text.
- **Agent contributions:** AI agents contributing to this repository must follow [AGENTS.md](AGENTS.md).
