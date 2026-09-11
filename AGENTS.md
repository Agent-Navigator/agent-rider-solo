# AGENTS.md

Guidance for agents working in this repository.

## Git commits

- Make a git commit after **every** code change. Each change should be committed
  before moving on to the next one — do not batch multiple unrelated changes into
  a single commit.
- Write a clear, concise commit message describing what changed and why.
- Do not automatically reinstall or restart the app.

## Test VM deployment

- Use `ssh agrider-test-env` for isolated live deployment and runtime validation
  of changes from this repository.
- Before each deployment, confirm that the SSH target hostname is
  `agrider-test-env`, then inspect the current release link, user-service state,
  Agent Rider tmux sessions, and listening ports. Do not assume the VM is idle
  merely because it was idle during a previous test.
- Deploying or restarting Agent Rider on this test VM is allowed when required
  for the current validation task. This permission does not apply to the local
  workstation, another host, or either public/private distribution repository.
- Build a source-free runtime bundle from the exact local commit, compile with
  `AGENT_RIDER_SOURCE_COMMIT` set to the full commit SHA, and install it with the
  current rootless `install.sh` flow. Do not use the deprecated private
  two-service deployment scripts for new test installations.
- Preserve active TUI and Browser sessions unless the test explicitly requires
  resetting them. Use the split `agrider`, `agrider-runtime`, and
  `agrider-tmux` service boundaries when validating updates.
- After deployment, separately verify the source commit, installed `current`
  target and binary, running application and runtime executables, user-service
  health, `/store/version`, `/store/state`, runtime `/healthz`, and the
  change-specific UI or end-to-end behavior. Do not treat a successful build,
  copy, installer exit, or service restart alone as proof that the new code is
  running.
- Record the exact deployed commit in the task result and state whether the VM
  matches the final local `HEAD`. Do not push, publish, or promote a test
  deployment unless the user separately requests it.

## Public distribution

- After pushing `dev` to the remote, continuously monitor the GitHub Actions build at
  https://github.com/Agent-Navigator/agent-rider-solo-dev/actions. If it fails, fix
  the error and repeat the push-and-monitor cycle until the build succeeds.
- Do not publish, push, upload, or otherwise release any content to the public
  binary distribution repository `Agent-Navigator/agent-rider-solo` unless the user
  explicitly instructs you to do so.
- The promotion path is:
  `dev` → artifact-only `staging` in `Agent-Navigator/agent-rider-solo-dev` →
  `main` in `Agent-Navigator/agent-rider-solo`.
- Before promoting, fetch and inspect the remote `staging` branch. Proceed only
  after verifying that it is a Rust-source-free artifact snapshot containing no
  Rust source files, `Cargo.toml`, or `Cargo.lock`; abort the promotion if this
  check fails. Frontend source code must remain present and publicly visible in
  the snapshot.
- Publish the generated staging snapshot to the public repository's `main`
  branch. Do not create or update a `staging` branch in the public repository.
