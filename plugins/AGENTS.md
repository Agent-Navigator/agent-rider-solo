# AGENTS.md — Building an Agent Rider App

This file is the **single source of truth** for how to build an "App" for
Agent Rider. If a user asks you to "develop a … dashboard / tool / app", follow
this document exactly.

An **App** is a self-contained web app that Agent Rider serves same-origin and
embeds in a panel under **[Resource] → [App]**. Apps may be **static** (only a
built `dist/`) or **dynamic** (a frontend plus an app-owned backend process).
They need **no external URL** and **no rebuild/restart of the main Agent Rider
app** — they are discovered at runtime by scanning manifests.

## Golden rules

1. **Apps are runtime data, not Agent Rider source code.** Build only inside the
   app workspace provided by the user or under `AGENT_RIDER_APPS_DIR/<slug>/`.
   Do **not** create app folders inside the
   Agent Rider source repo.
2. **One folder per app**: `AGENT_RIDER_APPS_DIR/<slug>/`. The `<slug>` is
   **kebab-case and globally unique** (`^[a-z0-9][a-z0-9-]*$`). If your slug
   collides with an existing app the platform refuses to list either — pick
   another.
3. **Choose the app kind**:
   - `static` apps are built to `<app-workspace>/dist/` and served at
     `/apps/<slug>/`. Use relative asset paths (or `<base href="./">`) so they
     work under that sub-path. Absolute paths like `/assets/...` will 404.
   - `dynamic` apps own a backend process in the app workspace. Agent Rider
     gives the paired TUI agent an authenticated same-origin App View proxy and
     an assigned loopback port; the backend must bind that exact port on
     `127.0.0.1` (or `0.0.0.0` when required). The backend may serve the
     frontend and its own `/api/*` routes.
4. **Browser requests remain same-origin**. Static apps may use the platform's
   `/api` and `/store` endpoints. Dynamic apps use their own backend API through
   the App View proxy; inside that view, same-origin `/api` and `/store` paths
   are forwarded to the app backend. The browser must never connect directly to
   a database or an external host. Do not edit Agent
   Rider's backend endpoints (`src/backend/`, `server/store.mjs`, or
   `vite.config.ts`) to implement app features; a dynamic app's backend is
   app-owned code in its own workspace.
5. **Secrets stay server-side**. A dynamic backend may connect to ClickHouse or
   another database using credentials supplied through its server process
   environment or a local secret manager. Never put credentials in `dist/`,
   browser JavaScript, `manifest.json`, URLs, committed `.env` files, or logs.
6. **No Agent Rider git commit for app work.** The repo-root AGENTS.md commit
   rule applies to Agent Rider code changes only. Agent App work is
   independent local development. If the app itself needs version control, run
   `git init` inside that app workspace only; never stage or commit it in the
   Agent Rider repo.
7. **No rebuild/restart of the main app.** You only build the app's own `dist/`.
   Agent Rider auto-rescans every few seconds and the app appears by itself —
   do NOT run `npm run build` / restart the main Agent Rider app for an app
   change. (This overrides the repo-root AGENTS.md "restart after every edit"
   rule, which applies only to the main app.)

## Directory layout

```
AGENT_RIDER_APPS_DIR/<slug>/
  manifest.json     # required — how the app is registered
  app/              # your source (any stack, or omit if you hand-write dist/)
  dist/             # the built static output served at /apps/<slug>/
    index.html      # required entry; the app is "ready" once this exists
```

When an exact app workspace path is provided, that path is already the
`AGENT_RIDER_APPS_DIR/<slug>/` folder. Put `manifest.json` and `dist/` directly
there; do not create another nested `plugins/<slug>/` folder.

## manifest.json

```jsonc
{
  "id": "sales-dashboard",        // slug, globally unique, == folder name
  "label": "Sales Dashboard",     // shown in the [Resource] → [App] list
  "group": "App",                 // sidebar heading; default "App"
  "kind": "dynamic",              // "static" or "dynamic"
  // entry is auto-derived as /apps/<id>/ — do NOT set it (a copied value would
  // point at the wrong app). Only set it for an unusual mount.
  "description": "Daily sales overview",
  "dataScopes": ["api", "store"], // browser-facing APIs; backend DB access is server-side
  "version": 1
}
```

## Static platform data (same-origin)

- `GET /store/state` → `{ runs, turns }` (conversation data)
- `GET /store/apps` → installed apps plus `appsRoot`
- `GET /store/fs/list?path=…` → browse files under the allowed root
Use only what you declare in `dataScopes` for browser calls. A dynamic
backend's database connections are not browser data scopes and must stay on the
server side.

## Dynamic App backend contract

When a dynamic Agent App is opened, its title-bar prompt provides the exact
loopback port. Start the app backend from the paired TUI agent in the app
workspace, reusing an already-running server and binding the assigned port.
Agent Rider proxies the App View and rewrites same-origin app requests, so the
frontend can use normal `/api/...` or `/store/...` requests without exposing the
backend port. The backend can use its normal database driver, for example a
ClickHouse client, because it runs outside the browser.

Keep database configuration in server-only environment variables such as
`CLICKHOUSE_HOST`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD`; use placeholder
names in documentation and never commit real values. The frontend should
receive only the minimum data needed for display.

## Workflow

1. `cd` to the exact app workspace path.
2. Create or update `manifest.json` (set a unique `id`/`label` and choose
   `kind: "static"` or `kind: "dynamic"`).
3. For a static app, produce `dist/index.html` and relative assets. For a
   dynamic app, implement the app-owned backend and make it serve the frontend
   and API on the assigned port.
4. Verify locally: static apps respond at `/apps/<slug>/`; dynamic apps respond
   in the Agent App View after their backend is started on the assigned port.
5. Stop. Do not commit Agent Rider; the app is local runtime data and Agent Rider
   auto-rescans it.

## Validation checklist before you call it done

- [ ] `<app-workspace>/manifest.json` is valid JSON with a unique kebab-case `id`.
- [ ] Static apps have `dist/index.html`; dynamic apps have a backend that binds
      the assigned loopback port.
- [ ] All browser asset/API requests are same-origin; no direct database or
      external-host connections from frontend code.
- [ ] Database credentials, if needed, are available only to the backend
      process and are not committed or sent to the browser.
- [ ] No files were staged or committed in the Agent Rider repo.
