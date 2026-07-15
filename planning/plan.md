# Agent Rider Rust Backend Refactor Plan

> Agent Rider planning document.

The safest approach is a staged replacement that preserves the current HTTP,
SSE, WebSocket, and SQLite contracts. The React frontend should continue talking
to the same URLs while Node modules are replaced one subsystem at a time.

The final architecture should support both:

```text
Linux server deployment
  React assets -> Rust HTTP server -> SQLite / filesystem / PTY / Hermes CLI

Windows/macOS/Linux desktop
  Tauri window -> embedded Rust backend -> SQLite / filesystem / PTY / Hermes CLI
```

## 1. Scope of the rewrite

The current backend is spread across more than `server/*.mjs`.

| Current component | Responsibility | Rust destination |
|---|---|---|
| `server/store.mjs` | HTTP API, SQLite, auth, filesystem, apps, terminals | Rust backend modules |
| `server/hermesAcp.mjs` | Hermes process, ACP JSON-RPC, sessions, SSE | Rust Hermes manager |
| `vite.config.ts` | Production proxies, Guacamole authentication | Rust HTTP/proxy modules |
| `scripts/*.sh` | Installation, updates, systemd, release management | Prebuilt binaries, installer/updater |
| Vite preview server | Serves the production React application | Rust static asset server |

The existing React/TypeScript UI remains. Production should no longer require
Node, npm, Vite preview, or `node-pty`.

Some small frontend changes will still be required for cross-platform paths.
For example, `/root/...` defaults cannot be used on Windows or macOS; the Rust
backend should provide the platform's default workspace through a configuration
endpoint.

## 2. Proposed Rust workspace

```text
rust/
|-- Cargo.toml
|-- crates/
|   |-- agent-rider-core/
|   |   |-- config.rs
|   |   |-- error.rs
|   |   |-- paths.rs
|   |   `-- models.rs
|   |-- agent-rider-db/
|   |   |-- migrations/
|   |   |-- actor.rs
|   |   |-- runs.rs
|   |   |-- turns.rs
|   |   |-- apps.rs
|   |   `-- kv.rs
|   |-- agent-rider-server/
|   |   |-- routes/
|   |   |-- auth/
|   |   |-- filesystem/
|   |   |-- apps/
|   |   |-- terminal/
|   |   |-- hermes/
|   |   |-- proxy/
|   |   `-- assets/
|   `-- fake-hermes-acp/
|       `-- test fixture executable
`-- src-tauri/
    |-- Cargo.toml
    `-- tauri.conf.json
```

Recommended roles:

- `agent-rider-core`: types and platform-independent configuration.
- `agent-rider-db`: all SQLite access and migrations.
- `agent-rider-server`: HTTP server and runtime services.
- `fake-hermes-acp`: deterministic test process for ACP/SSE tests.
- `src-tauri`: optional desktop shell, packaging, signing, and updates.

The standalone server and Tauri application should reuse the same Rust library
rather than implement separate backends.

## 3. Core technology choices

### HTTP runtime

Use Tokio and Axum for REST/JSON, SSE, WebSocket terminal connections, graceful
shutdown, and shared application state. Use `tower-http` for request tracing,
body limits, static files during the first migration stages, security headers,
and request IDs.

### SQLite

Use `rusqlite`, preferably with bundled SQLite so users do not need a system
SQLite library.

Do not share a connection directly between async handlers. Use a dedicated
database actor thread receiving commands over channels. This serializes state
saves and avoids blocking Tokio workers.

```text
HTTP handler
    -> request over channel
Database actor thread
    ->
Single SQLite connection
    ->
agent-rider.db
```

### Terminal

Use `portable-pty` behind a custom `TerminalBackend` trait.

Platform shell selection:

- Windows: PowerShell or `cmd.exe`
- macOS: user shell, typically zsh
- Linux: user shell, typically bash

PTY reads are blocking, so each PTY needs a dedicated blocking reader task or
thread that sends output into async channels.

### Desktop packaging and updates

Use Tauri 2 after the standalone Rust server is stable. Tauri packages the UI,
Rust runtime, platform installers, signing configuration, and update client.

## 4. Compatibility rules

During migration, these are fixed contracts:

1. Existing endpoint paths remain unchanged.
2. Existing JSON field names remain unchanged.
3. Existing status codes and important headers remain unchanged.
4. Existing WebSocket messages remain unchanged.
5. Existing SSE event names and payloads remain unchanged.
6. Existing `agent-rider.db` files open without export/import.
7. Rust must not perform an irreversible schema migration until rollback has
   been tested.
8. The Node and Rust backends must not write the database simultaneously.

The frontend-facing contract includes:

- `/store/password/*`
- `/store/state`
- `/store/save`
- `/store/fs/*`
- `/store/apps*`
- `/store/agents`
- `/store/terminal/run`
- `/store/terminal/usage`
- `/store/terminal/ws`
- `/apps/<slug>/*`
- `/api/session/new`
- `/api/sessions`
- `/api/chat/start`
- `/api/chat/stream`
- `/api/chat/stream/status`
- `/api/chat/cancel`
- `/api/models`
- `/api/reasoning`

## 5. Phase 0 - Capture current behavior

Before writing Rust implementation code:

- Create endpoint contract tests against the Node backend.
- Record response bodies, status codes, and headers.
- Create a sample database containing runs, turns, layout state, app ordering,
  labels, password records, and the Hermes model catalog.
- Create filesystem fixtures for Unicode names, large files, symlinks, invalid
  traversal paths, and Agent App manifests/assets.
- Create a fake Hermes ACP executable with deterministic JSON-RPC responses.
- Record terminal WebSocket input/output message shapes.
- Record SSE sequences for successful responses, tool events, plan events,
  cancellation, replay, Hermes crashes, and timeouts.

Acceptance criterion: the current Node backend passes the new contract suite
before Rust work starts.

Estimated effort: 3-5 engineering days.

## 6. Phase 1 - Rust server skeleton

Implement:

- configuration loading
- environment variable compatibility
- structured logging
- error types
- graceful termination
- loopback binding by default
- `/health` and `/version`
- configuration validation
- temporary data and app directories for testing

Preserve current environment variables initially:

```text
STORE_PORT
BROWSE_ROOT
AGENT_RIDER_APPS_DIR
AGENT_RIDER_PLUGINS_DIR
APP_DIR
HOME
HERMES_TARGET
HERMES_UI_TARGET
GUACAMOLE_TARGET
```

The Rust backend should initially run beside Node on a different port.

Acceptance criteria:

- Starts without Node.
- Binds to `127.0.0.1`.
- Cleanly terminates child tasks.
- Returns structured startup errors.
- Passes configuration tests on Linux, macOS, and Windows CI.

Estimated effort: 2-3 days.

## 7. Phase 2 - SQLite and state APIs

Implement the database actor and migrate:

- schema creation
- column migrations
- prepared statements
- `app_order`
- `app_label`
- `app_kv`
- `runs`
- `turns`
- transactional `/store/save`
- deletion reconciliation
- `/store/state`

Migration strategy:

1. Open the existing DB.
2. Enable WAL as the current server does.
3. Inspect tables and columns.
4. Apply only missing migrations.
5. Introduce `PRAGMA user_version` for future Rust migrations.
6. Back up before the first Rust migration.
7. Preserve all existing table and column names.

Use SQLite's online backup API rather than copying only the main file while WAL
is active.

Acceptance criteria:

- A DB created by Node can be read and updated by Rust.
- Rust can create a fresh DB.
- Node can still read a Rust-updated DB during the rollback window.
- State JSON matches the Node response snapshots.
- Failed saves roll back completely.
- Concurrent requests do not produce `database is locked`.

Estimated effort: 4-6 days.

## 8. Phase 3 - Authentication

Port the existing page-password behavior exactly:

- PBKDF2-HMAC-SHA256
- 210,000 iterations
- 32-byte derived key
- base64url encoding
- random salt
- session secret
- signed cookie
- constant-time comparison
- 30-day session
- login, logout, password set, and status routes
- WebSocket authentication

Add tests proving that:

- Rust accepts a password record created by Node.
- Node accepts a record created by Rust.
- Expired or modified cookies fail.
- Changing the password invalidates previous cookies.
- Unauthorized REST, SSE, and WebSocket access fails.

After compatibility is proven, add optional hardening:

- `Secure` cookies when behind HTTPS
- WebSocket Origin checks
- CSRF protection on state-changing requests
- proxy-aware HTTPS detection

Estimated effort: 2-4 days.

## 9. Phase 4 - Filesystem service

Port:

- browse-root resolution
- directory listing
- recursive search
- text preview
- inline file viewing
- downloads
- uploads
- directory creation
- moves
- deletion
- MIME detection
- size and result limits

Improve implementation while preserving responses:

- Stream uploads to a temporary file instead of buffering 100 MB in memory.
- Atomically rename completed uploads.
- Canonicalize existing paths.
- Validate the nearest existing parent for new paths.
- Reject symlink escapes from `BROWSE_ROOT`.
- Handle Windows drive prefixes and UNC paths explicitly.
- Never rely on string prefix comparison for containment.

Acceptance criteria:

- All filesystem contract tests match.
- `..`, encoded traversal, and symlink escapes fail.
- Unicode paths work on all platforms.
- Cancellation removes partial upload files.
- The browse root itself cannot be moved or deleted.

Estimated effort: 4-7 days.

## 10. Phase 5 - Agent Apps

Port:

- manifest parsing
- app scanning
- warning generation
- app ordering
- custom labels
- app hash
- `/apps/<slug>/` static serving
- SPA fallback to an app's `index.html`
- runtime `AGENT_RIDER_APPS_DIR`

Security requirements:

- validate slug syntax
- prevent app-to-app path traversal
- do not serve source files outside `dist/`
- set predictable content types
- prevent accidental directory listings

Acceptance criterion: existing installed Agent Apps continue loading without
rebuild or relocation.

Estimated effort: 2-3 days.

## 11. Phase 6 - Noninteractive commands and terminal WebSocket

First port `/store/terminal/run`:

- shell selection per platform
- working-directory validation
- combined stdout/stderr
- 120-second timeout
- output limit
- exit status
- next-working-directory detection

The current Bash marker mechanism will not work on PowerShell. Introduce a
platform abstraction:

```rust
trait CommandShell {
    fn build_command(&self, input: &str) -> CommandSpec;
    fn parse_result(&self, output: &[u8]) -> CommandResult;
}
```

Then port `/store/terminal/ws`:

- PTY create/read/write/resize
- authenticated upgrade
- terminal dimensions
- working directory
- environment
- built-in agent selection
- custom agent commands
- disconnect cleanup
- delayed context injection
- reset behavior

Keep the existing WebSocket protocol:

```json
{"type":"input","data":"..."}
{"type":"resize","cols":120,"rows":40}
```

Server output remains terminal text frames so xterm.js does not change.

Estimated effort: 7-12 days.

## 12. Phase 7 - Replace tmux semantics

This is the biggest cross-platform design decision. Current tmux sessions
survive closing a card, browser reload, WebSocket disconnect, and store process
restart. Windows does not provide tmux.

### Recommended first release

Implement a Rust `TerminalSessionManager` that:

- owns PTYs in memory
- keys sessions by conversation, agent, and working directory
- keeps PTYs alive after WebSocket disconnect
- allows later WebSocket reattachment
- terminates sessions on explicit reset
- survives UI/window closure while the backend remains running
- documents that sessions do not survive a backend crash or update

This removes tmux as an installation dependency on every platform.

### Exact current durability

Create a separate `agent-rider-sessiond` binary that owns PTYs independently of
the HTTP backend. The main backend reconnects over a local socket after
restarting.

That provides closer tmux parity but adds another binary, a local IPC protocol,
version compatibility, supervisor lifecycle, and updater coordination.

Recommendation: deliver the in-process session manager first and treat
crash-surviving PTY sessions as a later feature.

The agent quota scraping logic must also be ported as explicit adapters for
Claude, Codex, and other TUIs. These tests need recorded terminal screens because
they depend on screen text and keyboard navigation.

Estimated effort:

- In-process manager: 4-7 days, included around the terminal phase.
- Separate session daemon: an additional 7-12 days.

## 13. Phase 8 - Hermes ACP and SSE

Implement a `HermesManager` with:

```text
HermesManager
|-- Child supervisor
|-- stdin JSON-RPC writer
|-- stdout line reader
|-- stderr logger
|-- pending RPC map
|-- session registry
|-- model catalog
`-- stream registry
```

Required behavior:

- lazily start `hermes acp`
- send initialize handshake
- assign RPC IDs
- map responses to pending requests
- enforce timeouts
- auto-handle permission requests
- detect child exit
- reject pending requests on crash
- mark sessions unloaded
- restart Hermes on demand
- call `session/load` after restart
- support model selection
- persist model catalog in `app_kv`

The stream registry must preserve current behavior:

- one active stream per session
- maximum buffered events
- 30-minute retention
- full replay on SSE reconnect
- 15-second keepalive
- cancellation grace period
- terminal `stream_end`, `cancel`, `apperror`, and `error` events
- tool output and image path detection

Use a bounded event buffer plus broadcast channels:

```text
ACP update
  -> convert to Agent Rider event
  -> append to bounded replay buffer
  -> broadcast to connected SSE clients
```

Test every event type with the fake ACP executable. Do not initially test against
a live AI service; deterministic protocol tests are more valuable here.

Acceptance criteria:

- `src/hermesBridge.ts` requires no behavior changes.
- Disconnect/reconnect produces no missing or duplicated visible text.
- Hermes crashes do not crash the Rust server.
- Cancellation always reaches a terminal stream state.
- Multiple sessions remain isolated.

Estimated effort: 7-11 days.

## 14. Phase 9 - Static frontend and proxy behavior

Move production responsibilities out of Vite:

- serve the React `dist/`
- SPA fallback to `index.html`
- serve Agent Apps
- route `/store/*` internally
- route embedded `/api/*` to `HermesManager`
- optionally proxy `/api/*` to `HERMES_TARGET`
- proxy `/hermes-ui/*`
- proxy `/guacamole/*`
- implement `/guacamole-auth/start`
- strip iframe-blocking headers where currently required

The Guacamole authentication code must preserve:

- AES-128-CBC
- HMAC-SHA256 signature
- payload shape
- connection identifier encoding
- TTL configuration
- secret-file handling

Guacamole remains a Linux/server feature. It should be disabled cleanly on
desktop platforms where the associated VNC/X11 scripts do not exist.

During development, Vite can continue proxying to the Rust backend. In
production, Vite preview is removed.

Estimated effort: 5-8 days.

## 15. Phase 10 - Frontend compatibility adjustments

Expected frontend changes should remain small:

- obtain default workspace and app paths from the backend
- remove hardcoded `/root` defaults
- make path display platform-neutral
- update Vite dev proxy to target Rust
- keep same-origin REST/SSE/WebSocket URLs
- expose backend version and capability flags
- hide unavailable Linux-only features
- display missing CLI installation/login guidance

A proposed endpoint:

```http
GET /store/capabilities
```

Example:

```json
{
  "platform": "windows",
  "defaultWorkspace": "C:\\Users\\yen",
  "appsRoot": "C:\\Users\\yen\\.agent-rider\\apps",
  "terminalPersistence": "process",
  "guacamole": false,
  "agents": {
    "hermes": true,
    "codex": false,
    "claude": true
  }
}
```

Estimated frontend change: approximately 100-300 lines, excluding any new
onboarding UI.

## 16. Phase 11 - Parallel verification and cutover

Do not run both backends against the same writable DB.

Use this verification process:

1. Stop Node writes.
2. Create a SQLite online backup.
3. Start Rust against the copied DB and copied runtime directories.
4. Run the contract suite.
5. Exercise the UI manually.
6. Run a controlled Rust-only production canary.
7. Compare logs and visible behavior.
8. Keep the old Node release and DB backup available.
9. Switch the `current` symlink only after the health check succeeds.
10. Roll back both binary and database if migration validation fails.

For one release cycle, retain a switch such as:

```text
AGENT_RIDER_BACKEND=node
AGENT_RIDER_BACKEND=rust
```

Remove Node only after the Rust backend has passed real usage and rollback
drills.

## 17. Phase 12 - Packaging and dependency-free installation

### Server release

CI should produce prebuilt artifacts for each supported target:

```text
agent-rider-linux-x86_64
agent-rider-linux-aarch64
agent-rider-windows-x86_64.exe
agent-rider-macos-aarch64
agent-rider-macos-x86_64
```

The React build should be embedded or bundled as application resources. Runtime
installation must not execute:

```text
npm install
npm ci
cargo build
apt install build-essential
```

The machine will still need external agent programs such as Hermes, Codex, or
Claude unless distribution rights allow bundling them. Agent Rider should detect
them and offer UI-based setup guidance.

### Desktop release

Build:

- Windows MSI/NSIS installer
- signed and notarized macOS application/DMG
- Linux AppImage and optionally deb/rpm
- signed update manifests
- rollback-aware updates

Each platform needs its own compiled artifact; Rust does not produce one binary
that runs unchanged on all three operating systems.

Estimated effort: 8-15 days, including CI, signing, and update testing.

## 18. Testing matrix

### Unit tests

- path containment
- manifest validation
- cookie signing
- password hashing
- ACP message conversion
- terminal parameter bounds
- model catalog conversion
- migration planning

### Contract tests

Run identical requests against Node and Rust and compare status, content type,
relevant headers, normalized JSON, SSE event sequence, and WebSocket behavior.

### Integration tests

- real SQLite file
- temporary filesystem
- fake Hermes process
- real shell/PTY
- child crash and restart
- interrupted uploads
- graceful shutdown

### Platform CI

At minimum:

- Ubuntu x86_64
- Windows x86_64
- macOS ARM64
- macOS x86_64 where available

PTY tests must run natively on each OS; cross-compilation alone cannot verify
shell and ConPTY behavior.

## 19. Estimated size and schedule

| Area | Estimated Rust LOC |
|---|---:|
| Core/config/errors | 500-800 |
| Database and migrations | 900-1,400 |
| REST/auth/files/apps | 1,800-2,800 |
| Terminal and session management | 1,500-2,500 |
| Hermes ACP/SSE | 1,200-2,000 |
| Proxies/static assets/Guacamole | 700-1,200 |
| Packaging/updater integration | 400-800 |
| Tests and fixtures | 4,000-7,000 |

Expected production Rust code: approximately 7,000-11,000 lines, plus tests.

Schedule for one experienced Rust engineer:

- Linux feature parity: approximately 6-9 weeks.
- Full Windows/macOS/Linux support: approximately 10-15 weeks.
- Crash-surviving cross-platform terminal daemon: add approximately 2 weeks.

The PTY/session and Hermes ACP sections carry most of the uncertainty.

## 20. Recommended commit sequence

Implementation must follow the repository's `AGENTS.md` workflow: after every
code edit, restart the app so the change is loaded and verified, then commit that
change before moving to the next one.

Example commits:

```text
test: capture current store state API contract
build: add Rust workspace and server skeleton
feat(db): open existing Agent Rider SQLite database
feat(db): port state load and save transactions
feat(auth): port password and cookie compatibility
feat(fs): port sandboxed directory listing
feat(fs): port uploads and downloads
feat(apps): port Agent App discovery and static serving
feat(terminal): add portable PTY WebSocket backend
feat(hermes): add ACP child-process supervisor
feat(hermes): add replayable SSE streams
feat(server): serve production React assets
feat(desktop): add Tauri packaging and updater
chore: remove Node backend runtime
```

The key architectural decision is to preserve the existing network API while
replacing its implementation. That makes the rewrite reversible, keeps the React
frontend stable, and lets each Rust subsystem reach production independently.
