# AGENTS.md

Guidance for agents working in this repository.

## Git commits

- Make a git commit after **every** code change. Each change should be committed
  before moving on to the next one — do not batch multiple unrelated changes into
  a single commit.
- Write a clear, concise commit message describing what changed and why.
- Do not automatically reinstall or restart the app.

## Public distribution

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
