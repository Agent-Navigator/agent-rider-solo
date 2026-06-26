# AGENTS.md — Building an Agent Rider App

This file is the **single source of truth** for how to build an "App" plugin for
Agent Rider. If a user asks you to "develop a … dashboard / tool / app", follow
this document exactly.

An **App** is a self-contained static web app that Agent Rider serves
same-origin and embeds in a panel under **[Resource] → [App]**. It needs **no
external URL** and **no rebuild/restart of the main Agent Rider app** — it is
discovered at runtime by scanning manifests.

## Golden rules

1. **One folder per app**: `plugins/<slug>/`. The `<slug>` is **kebab-case and
   globally unique** (`^[a-z0-9][a-z0-9-]*$`). If your slug collides with an
   existing app the platform refuses to list either — pick another.
2. **Static only**: the app is built to `plugins/<slug>/dist/` and served at
   `/apps/<slug>/`. Use **relative asset paths** (or `<base href="./">`) so it
   works under that sub-path. Absolute paths like `/assets/...` will 404.
3. **Data access is limited to same-origin `/api` and `/store`**. Do NOT hit
   external URLs, and do NOT add or modify backend endpoints (you may not edit
   `server/store.mjs` or `vite.config.ts`). If the data you need isn't already
   exposed there, say so — it's a platform change, not an app change.
4. **No secrets** in app code.
5. **No rebuild/restart of the main app.** You only build the app's own `dist/`.
   Agent Rider auto-rescans every few seconds and the app appears by itself —
   do NOT run `npm run build` / restart the main Agent Rider app for an app
   change. (This overrides the repo-root AGENTS.md "restart after every edit"
   rule, which applies only to the main app.)
6. **Commit** your work (the repo-root AGENTS.md commit rule still applies).

## Directory layout

```
plugins/<slug>/
  manifest.json     # required — how the app is registered
  app/              # your source (any stack, or omit if you hand-write dist/)
  dist/             # the built static output served at /apps/<slug>/
    index.html      # required entry; the app is "ready" once this exists
```

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
- `GET /store/apps` → installed apps
- `GET /store/fs/list?path=…` → browse files under the allowed root
- `/api/*` → the Hermes agent runtime
Use only what you declare in `dataScopes`.

## Workflow

1. Copy the scaffold: `cp -r plugins/_template plugins/<slug>` and rename.
2. Edit `manifest.json` (set a unique `id`/`label`) and build your UI.
3. Produce `dist/index.html` (+ assets, **relative paths**). For the no-build
   path you can author files directly in `dist/`. For a framework, configure its
   base to `./` and build into `dist/`.
4. Verify locally: `dist/index.html` exists; open `/apps/<slug>/` returns it.
5. `git commit`. Agent Rider auto-rescans — the app shows up under
   **[Resource] → [App]**. No restart.

## Validation checklist before you call it done

- [ ] `plugins/<slug>/manifest.json` is valid JSON with a unique kebab-case `id`.
- [ ] `plugins/<slug>/dist/index.html` exists.
- [ ] All asset references are relative (no leading `/`).
- [ ] App only calls `/api` and/or `/store`; no external hosts; no backend edits.
- [ ] Committed.
