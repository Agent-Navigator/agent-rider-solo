# Agent Rider staging runtime

This directory is copied to the artifact-only `staging` branch by the
`Build staging candidate` workflow. That branch includes the prebuilt Rust
runtime bundles and frontend TypeScript/JavaScript source, but never Rust
source or Cargo files.

On an x86_64 Linux host:

```bash
docker compose -f docker-compose.staging.yml --project-name agent-rider-staging up --build -d
npm run test:smoke:staging
docker compose -f docker-compose.staging.yml --project-name agent-rider-staging down
```

Use `AGRIDER_STAGING_BUNDLE=agrider-linux-aarch64.tar.gz` on an arm64 host.
