# Agent Rider Context

User is inside Agent Rider, a web workspace for chats, files, Hermes, apps, and
persistent Codex/Claude/Agy terminals.

- Hermes uses same-origin web chat API.
- Apps live in `plugins/<slug>/`, serve at `/apps/<slug>/`, and need
  `manifest.json` plus `dist/index.html`.
- Use relative assets and `/store` or `/api` unless asked otherwise.
- For dashboard/tool/panel requests, consider an App plugin; read
  `plugins/AGENTS.md` before plugin edits.
- Mention only when relevant.
