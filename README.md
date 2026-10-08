# tw-dev

Shared dev server of the nikorion TiddlyWiki plugins: `pnpm dev` of every plugin repository runs this tool instead of carrying its own copy.

## Use it in a plugin

- Clone this repository next to the plugin repositories (`nikorion/tw-dev/`).
- In the plugin's `package.json`: `"dev": "node ../tw-dev/dev.cjs"`, with `nodemon` and `tiddlywiki` in its `devDependencies`.
- In the dev wiki, `$:/config/SyncFilter` must exclude `-[prefix[$:/plugins/nikorion/]]`: pushed tiddlers override shadows in the browser only, and without this filter the browser would save them to disk, masking the plugin's shadows for good. Every nikorion plugin, not just the wiki's own: sibling plugins are pushed too.
- Nothing else: no `scripts/`, no `nodemon.json`, no `$:/dev/hmr` tiddler in the dev wiki.

## What it does

- **Ports**: picks a free TiddlyWiki port and a free HMR port (or `TW_PORT` / `HMR_SSE_PORT`), remembered per project in `.state/<project>/ports.json` (git-ignored), so several dev servers run side by side.
- **Watched sources**: derived, no configuration. Every `src/<name>/` holding a `plugin.info`, plus every plugin of `wiki/tiddlywiki.info` that resolves through `TIDDLYWIKI_PLUGIN_PATH` (the sibling plugins the wiki loads). Extra folders: `"twDev": { "watch": ["../Other/src/x"] }` in `package.json`.
- **Content HMR** (`dev-hmr.cjs`): a changed `.tid`, `.multids` or asset (`.css`, `.svg`, image…) in the watched sources or in `wiki/tiddlers/` is pushed over SSE to the browser, which overrides the shadow tiddler in memory, with no reload.
- **Reboot** (nodemon): a changed `.js` module or `plugin.info` restarts TiddlyWiki, then the browser reloads.
- **Browser half**: `plugin/` is copied to `.state/<project>/plugin/` with the SSE port tiddler, and loaded for the session only with `tiddlywiki ++<folder>`. It is never written to the wiki's `tiddlers/` and never part of `tiddlywiki wiki --build`.

How the HMR works and why: `../guides/hmr-tiddlywiki.md`.
