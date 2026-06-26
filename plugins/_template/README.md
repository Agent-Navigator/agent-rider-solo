# Template App

Scaffold for an Agent Rider **App** plugin. See `../AGENTS.md` for the full spec.

## Quick start

```sh
cp -r plugins/_template plugins/<your-slug>
```

Then:

1. Edit `<your-slug>/manifest.json` — set a unique kebab-case `id` and a `label`.
2. Build your UI into `<your-slug>/dist/` (entry: `dist/index.html`).
   - **No-build path**: hand-write HTML/CSS/JS directly in `dist/` (like this template).
   - **Framework path**: develop in `app/`, set the framework's base path to `./`,
     and build into `dist/`.
3. Use **relative** asset paths so it works when served at `/apps/<your-slug>/`.
4. Data only from same-origin `/store` and `/api`. No external hosts, no backend edits.
5. `git commit`. Agent Rider auto-rescans and the app appears under
   **[Resource] → [App]** — no rebuild/restart of the main app.

This `_template` folder is ignored by the app scanner (leading `_`), so it never
shows up as a launchable app itself.
