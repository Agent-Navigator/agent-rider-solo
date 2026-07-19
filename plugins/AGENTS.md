# AGENTS.md — Building an Agent Rider App

This file is the **single source of truth** for how to build an "App" for
Agent Rider. If a user asks you to "develop a … dashboard / tool / app", follow
this document exactly.

An **App** is a self-contained static web app that Agent Rider serves
same-origin and embeds in a panel under **[Resource] → [App]**. It needs **no
external URL** and **no rebuild/restart of the main Agent Rider app** — it is
discovered at runtime by scanning manifests.

## Golden rules

1. **Apps are runtime data, not Agent Rider source code.** Build only inside the
   app workspace provided by the user or under `AGENT_RIDER_APPS_DIR/<slug>/`.
   Do **not** create app folders inside the
   Agent Rider source repo.
2. **One folder per app**: `AGENT_RIDER_APPS_DIR/<slug>/`. The `<slug>` is
   **kebab-case and globally unique** (`^[a-z0-9][a-z0-9-]*$`). If your slug
   collides with an existing app the platform refuses to list either — pick
   another.
3. **Static only**: the app is built to `<app-workspace>/dist/` and served at
   `/apps/<slug>/`. Use **relative asset paths** (or `<base href="./">`) so it
   works under that sub-path. Absolute paths like `/assets/...` will 404.
4. **Data access is limited to same-origin `/api` and `/store`**. Do NOT hit
   external URLs, and do NOT add or modify backend endpoints (you may not edit
   `server/store.mjs` or `vite.config.ts`). If the data you need isn't already
   exposed there, say so — it's a platform change, not an app change.
5. **No secrets** in app code.
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
  "kind": "static",               // always "static" for agent-built apps
  // entry is auto-derived as /apps/<id>/ — do NOT set it (a copied value would
  // point at the wrong app). Only set it for an unusual mount.
  "description": "Daily sales overview",
  "dataScopes": ["store"],        // declare which same-origin APIs you use: "api" | "store"
  "version": 1
}
```

## Available data (same-origin)

- `GET /store/state` → `{ runs, turns }` (conversation data)
- `GET /store/apps` → installed apps plus `appsRoot`
- `GET /store/fs/list?path=…` → browse files under the allowed root
Use only what you declare in `dataScopes`.

## Workflow

1. `cd` to the exact app workspace path.
2. Create or update `manifest.json` (set a unique `id`/`label`) and build your UI.
3. Produce `dist/index.html` (+ assets, **relative paths**). For the no-build
   path you can author files directly in `dist/`. For a framework, configure its
   base to `./` and build into `dist/`.
4. Verify locally: `dist/index.html` exists; open `/apps/<slug>/` returns it.
5. Stop. Do not commit Agent Rider; the app is local runtime data and Agent Rider
   auto-rescans it.

## Validation checklist before you call it done

- [ ] `<app-workspace>/manifest.json` is valid JSON with a unique kebab-case `id`.
- [ ] `<app-workspace>/dist/index.html` exists.
- [ ] All asset references are relative (no leading `/`).
- [ ] App only calls `/api` and/or `/store`; no external hosts; no backend edits.
- [ ] No files were staged or committed in the Agent Rider repo.
