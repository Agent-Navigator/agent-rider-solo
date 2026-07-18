# Private Development and Public Release Pipeline

## Goal

Keep the complete Agent Rider source code, including the Rust backend, private
through development and staging. Publish only compiled release bundles and
their installer to the public distribution repository.

## Repository Boundaries

GitHub repository visibility applies to an entire repository, not an individual
branch. A public `release` branch cannot coexist with private `dev` and
`staging` branches in the same GitHub repository.

Use two repositories:

| Repository | Visibility | Branch or purpose | Rust source |
| --- | --- | --- | --- |
| `agent-rider-dev` | Private | `dev` | Present |
| `agent-rider-dev` | Private | `staging` | Absent |
| `agent-rider` | Public | `main` or `release`; GitHub Releases | Absent |

`agent-rider-dev` is currently the private source repository. The
`agent-rider` repository is the distribution repository; before making it
public, audit its history, files, release assets, and Actions logs.

The public repository must never receive a commit, tag, archive, workflow log,
or Docker build context containing `Cargo.toml`, `Cargo.lock`, `src/**/*.rs`,
or any other private source file.

## Branch Model

### `dev`

`dev` is the private default branch. It contains all source code and receives
daily work through pull requests.

Required checks:

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test --locked`
- `npm run build`
- Contract, installer, upgrade, and rollback tests
- Secret scanning

Protect this branch: require pull requests and successful checks, prevent force
pushes, and require explicit review where the GitHub plan supports it.

### `staging`

`staging` is a private, artifact-only branch. It is not merged from `dev`;
merging would preserve the complete source history. The workflow recreates it
as a single orphan commit for every successful `dev` candidate and only the
workflow bot may update it.

It contains prebuilt runtime bundles, deployment metadata, and the frontend
TypeScript/JavaScript source needed for frontend-specific staging work:

```text
Dockerfile
docker-compose.staging.yml
bundles/agrider-linux-x86_64.tar.gz
bundles/agrider-linux-aarch64.tar.gz
candidate.json
checksums.txt
src/**/*.ts
src/**/*.tsx
plugins/
```

The runtime bundles contain only `agrider`, compiled frontend assets, and
release metadata. The staging snapshot must never contain `*.rs`, `Cargo.toml`,
or `Cargo.lock`. `candidate.json` records the source commit, bundle SHA-256,
and candidate creation time.

### Public distribution repository

Keep the public repository source-free. A GitHub Release contains:

```text
agrider-linux-x86_64.tar.gz
agrider-linux-aarch64.tar.gz
checksums.txt
manifest.json
install.sh
```

Each tarball contains only `agrider`, `frontend/`, and `release.json`. The
existing release workflow already produces this bundle structure.

The frontend is compiled JavaScript and is visible to release users. Never put
tokens, secrets, or private endpoints in frontend build-time variables.

## Build and Promotion Flow

```text
Pull request -> dev
  -> deterministic CI
  -> build immutable candidate artifacts
  -> private staging Docker deployment and agent evaluation
  -> manual promotion approval
  -> public GitHub Release with the same tested artifacts
```

1. A pull request is merged into `dev` only after all deterministic checks
   pass.
2. A candidate workflow builds the Rust binaries, frontend, and checksums.
3. The workflow writes `candidate.json` and force-updates the private,
   source-free `staging` branch with the exact runtime bundles and frontend
   TypeScript/JavaScript source.
4. The staging environment builds its Docker runtime from the tested x86_64 or
   arm64 bundle, then runs tests against that image.
5. After explicit approval, the promotion workflow copies the exact tested
   archives to `Agent-Navigator/agent-rider` as a public GitHub Release. It
   must not recompile them.
6. The workflow creates the matching private-source tag `vX.Y.Z` on the `dev`
   commit and includes that commit in the release manifest.

Promotion must validate that the candidate's commit SHA and archive checksums
match its recorded metadata. This guarantees production uses the same bits that
passed staging, rather than a later rebuild.

## Local Staging and Agent Tests

Create a runtime-only Docker image and compose configuration. The runtime image
extracts the prebuilt `agrider` bundle and `frontend/`; it does not contain
Rust, Cargo, Node.js, npm, or the frontend source checkout.

The staging compose service should:

- Bind only to `127.0.0.1:15173` to avoid the development service.
- Use a temporary SQLite database and dedicated test fixture browse root.
- Mount no user home directory, real workspace, or production data.
- Select the tested runtime bundle for the host architecture.
- Use a dedicated test-only agent identity with narrowly scoped access.

Planned commands:

```bash
docker compose -f docker-compose.staging.yml --project-name agent-rider-staging up --build -d
npm run test:smoke:staging
docker compose -f docker-compose.staging.yml --project-name agent-rider-staging down -v
```

Agent evaluation is added after a dedicated test-only agent credential and task
fixtures exist; it must never run against user files or production credentials.

Agent testing has two layers:

1. Deterministic, release-blocking tests: API contracts, file isolation,
   WebSocket/SSE behavior, installation, upgrade, and rollback. Reuse the
   terminal-agent fixture for CI.
2. Agent evaluation: predefined tasks run against isolated fixtures, with
   Playwright/API assertions and an archived report. Start this as a
   non-blocking quality signal; only make it release-blocking after the task
   set and pass threshold are stable.

To automatically run staging tests on a local machine, use a dedicated
self-hosted runner labeled `staging-lab`. It must run only protected staging
workflows, never arbitrary pull requests, and contain no production secrets or
user data.

## GitHub Configuration

- Set `dev` as the default branch in the private source repository.
- The `Build staging candidate` workflow must have `contents: write` only for
  force-updating the private `staging` branch.
- Add branch rules for `dev` and the artifact-only `staging` branch.
- Store a fine-grained, write-only distribution token as
  `DISTRIBUTION_REPO_TOKEN` in the private source repository. Scope it only to
  publishing releases in `Agent-Navigator/agent-rider`.
- Protect the final public-release workflow environment with a reviewer where
  supported by the selected GitHub plan.
- Enable immutable releases in the public distribution repository before the
  first public publication.
- Keep public-release publishing in the private repository workflow. Do not
  run sensitive publishing workflows in the public distribution repository.

## Existing Baseline

`staging.yml` builds static Linux x86_64 and arm64 bundles after every
successful `dev` push, then force-updates the private staging snapshot. The
existing public-release workflow remains a separate future migration: it must
be updated to promote the tested staging bundles only after an explicit user
instruction.

## Reference Documentation

- https://docs.github.com/en/repositories/creating-and-managing-repositories/about-repositories
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- https://docs.github.com/en/actions/reference/runners/self-hosted-runners
- https://docs.github.com/en/actions/reference/security/secure-use
