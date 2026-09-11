# Template App

Scaffold for an Agent Rider **App**. See the platform `plugins/AGENTS.md` for the full spec.

## Quick start

Copy this template's contents into the exact Agent App workspace path
(`AGENT_RIDER_APPS_DIR/<your-slug>/`). Do not copy it into the Agent Rider source
repo.

Then:

1. Edit `<your-slug>/manifest.json` — set a unique kebab-case `id`, a `label`,
   and choose `kind: "static"` or `kind: "dynamic"`.
2. For a static app, build your UI into `<your-slug>/dist/` (entry:
   `dist/index.html`). For a dynamic app, add an app-owned backend that serves
   the UI and API on the loopback port supplied by the Agent App prompt.
   This template includes `server.py`; start it as `PORT=<assigned-port>
   python3 server.py`.
   - **No-build path**: hand-write HTML/CSS/JS directly in `dist/` (like this template).
   - **Framework path**: develop in `app/`, set the framework's base path to `./`,
     and build into `dist/` when the backend serves that directory.
3. Use same-origin requests from browser code. The backend may use database
   drivers and server-only environment variables; never send database credentials
   to the browser or commit them.
4. Do not edit Agent Rider backend endpoints or connect directly to a database
   from browser code.
5. Do not commit Agent Rider. Agent Rider auto-rescans the local app directory
   and the app appears under **[Resource] → [App]** — no rebuild/restart of the
   main app.

This `_template` folder is ignored by the app scanner (leading `_`), so it never
shows up as a launchable app itself.
