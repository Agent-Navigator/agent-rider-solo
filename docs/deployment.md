# Agent Rider release and deployment

Production consists of one `agrider` executable plus prebuilt frontend assets.
`agrider serve` binds to `127.0.0.1:5173` by default, serves the React SPA, and
owns `/store/*`, `/api/*`, `/apps/*`, SSE, and WebSocket routes. Vite remains a
development server only.

## Repositories

- `ytk77/agent-rider-dev` remains the private source repository.
- `ytk77/agent-rider` is the public distribution repository. It should contain
  only installer documentation and published release assets.

The public repository must have immutable releases enabled in repository
settings. Immutable releases prevent a published tag or asset from being
replaced and enable GitHub's release attestations.

Create a fine-grained token restricted to the public repository with the
minimum release-writing permissions, then store it in the private repository as
the Actions secret `DISTRIBUTION_REPO_TOKEN`. Protect the `public-release`
environment if release approval is required.

## Stable release procedure

Cargo, npm package, and npm lockfile versions must be identical. Create and push
the matching tag:

```bash
version=$(node -p "require('./package.json').version")
git tag "v$version"
git push origin master "v$version"
```

The `Test and publish Agent Rider` workflow then:

1. Verifies the tag and synchronized versions.
2. Runs formatting, Clippy, Rust tests, frontend build, runtime contracts,
   installer/migration tests, upgrade tests, and rollback tests.
3. Builds the frontend once.
4. Builds native musl binaries on `ubuntu-24.04` and `ubuntu-24.04-arm`.
5. Produces `agrider-linux-x86_64.tar.gz` and
   `agrider-linux-aarch64.tar.gz`, each with `agrider`, `frontend/`, and
   `release.json`.
6. Generates `checksums.txt` and `manifest.json` and attaches them with
   `install.sh` to a draft release in `ytk77/agent-rider`.
7. Publishes the draft only after both architecture jobs succeed.

Master and pull-request builds run the acceptance suite but never publish an
upgrade. The release job refuses to mutate an existing public tag.

## Public redirect

DNS alone cannot provide the install URL. Configure the chosen HTTPS domain so
this request:

```text
https://YOUR-DOMAIN/install.sh
```

returns an HTTP redirect to:

```text
https://github.com/ytk77/agent-rider/releases/latest/download/install.sh
```

Use a temporary (`302` or `307`) redirect so `releases/latest` continues to
resolve dynamically. Replace `YOUR-DOMAIN` in the README only after the exact
domain and redirect are live.

## Upgrade transaction

`agrider upgrade` resolves `releases/latest/download/manifest.json`, requires a
stable semver newer than the compiled version, selects the native architecture,
and verifies the archive SHA-256. Download, checksum, extraction, bundle layout,
and release metadata validation all occur before `agrider.service` is stopped.

After validation it:

1. Stops the user service if active.
2. Copies data, plugins, and configuration into
   `shared/backups/<timestamp>/`.
3. Installs `releases/<version>` and atomically replaces `current`.
4. Restarts the service and accepts HTTP `200` or the password gate's `401` at
   `/store/state` as healthy.
5. Restores the previous symlink and restarts the previous service on failure.

Checksum, download, metadata, and extraction failures do not stop the running
service. An update lock prevents concurrent transactions.

## Legacy migration and rollback

Both `install.sh` and a directly invoked new `agrider upgrade` detect the old
`/opt/agent-rider` deployment. The Rust command delegates migration to the same
published installer so there is one migration implementation.

Migration refuses to proceed unless the current login matches the old
`agent-rider-store.service` `User=`. After verifying the new release, it enables
lingering, records the old `current` pointer, environment file, and systemd
units, stops and disables both old services, then copies persistent data and
plugins into the rootless layout. It preserves `WEB_PORT` as
`AGENT_RIDER_PORT`, along with `BROWSE_ROOT` and allowed-host
configuration.

If the new health check fails, the user service is disabled and the old
`agent-rider-store` and `agent-rider-web` services are re-enabled and started.
Packaging does not perform an irreversible SQLite schema migration.

## Deprecated private deployment scripts

The scripts under `scripts/` describe the former private-token, source-checkout,
two-service deployment. They remain only for rollback compatibility with hosts
that have not migrated. New installations and stable upgrades must use
`install.sh` and `agrider upgrade`; they require neither GitHub credentials nor
a private source checkout.
