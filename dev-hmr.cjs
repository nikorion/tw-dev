#!/usr/bin/env node
"use strict";

// Content-HMR for the dev wiki (`pnpm dev`). Pairs with a module-only nodemon
// (nodemon.json, which reboots TW *only* on module/plugin.info changes) to give
// near-instant, state-preserving updates for every tiddler TiddlyWiki does NOT
// register as code — with no server reboot and no full page reload.
//
// ── Why this works ────────────────────────────────────────────────────
// The plugin's tiddlers (readme, playground, language strings, stylesheets,
// icons…) ship as *shadow* tiddlers bundled inside the plugin tiddler, which
// TiddlyWiki never hot-swaps live (it shows a "reload required" banner instead).
// But a *real* tiddler of the same title overrides its shadow and re-renders
// reactively. So on a change we parse the source file into tiddler field objects
// and push them over Server-Sent Events (SSE — native, zero dependency) to a tiny
// browser startup module ($:/dev/hmr), which does $tw.wiki.addTiddler(): the
// override lives in the browser's memory only — nothing is written to disk or to
// the server store, so there is no cleanup and no drift.
//
// ── What can be hot-swapped, and what can't ───────────────────────────
// Anything that is *content* can be pushed live, whatever the file extension:
//   • .tid / .multids                         → parsed from their own header/body
//   • asset files (.css, .svg, .json, images…) → the file body becomes the `text`
//     field; fields come from the sibling `.meta` (TW filesystem convention), or
//     are inferred from the filename/extension when there is no `.meta`
// Only two things genuinely need a full reboot (REBOOT_EXTS): **JS modules** (.js
// — registered in $tw.modules at boot, exports cached; a content push does not
// re-run them; a true module hot-swap was prototyped but not kept, see
// ../guides/hmr-tiddlywiki.md) and **plugin.info** (.info — plugin structure).
// A module/plugin.info change takes the full path: the paired nodemon restarts
// TW, and this script probes the port (down → up) then broadcasts { type:
// "reload" } so the browser reloads once TW is back.

const http = require("http");
const fs = require("fs");
const path = require("path");

// Watch roots: the sources of every plugin the dev wiki loads (shadow content,
// resolved by watch-dirs.cjs and passed by dev.cjs) AND the dev wiki's real
// tiddlers (wiki/tiddlers) — editing a demo/playground tiddler by hand should
// hot-swap exactly like editing plugin content (see ../guides/hmr-tiddlywiki.md
// §6 for the "wiki/tiddlers" addendum).
const WATCH_DIRS = [
  ...(process.env.TW_DEV_SOURCES
    ? JSON.parse(process.env.TW_DEV_SOURCES)
    : require("./watch-dirs.cjs").sourceDirs(process.cwd())),
  path.resolve("wiki/tiddlers"),
];
// Transient/generated wiki tiddlers (see .gitignore): excluded from
// $:/config/SyncFilter so they shouldn't normally reappear on disk, but skip
// them defensively — they carry no content worth pushing.
// Drafts too: the syncer writes the draft being edited to disk about every second,
// and pushing that write back to the tab would only echo the tab's own draft — at
// worst overwriting a field changed in between. Drafts are only ever edited in the
// browser, whose own saves reach the disk through the syncer, not through here.
const IGNORED_BASENAME = /^(\$__(StoryList|HistoryList|Import|config_dev_hmr-port)\b|Draft of ')/;
// Port TW listens on — injected by dev.cjs (the previous run's port or a random
// free one); 8080 is the standalone fallback. Only used by the readiness probe.
const TW_PORT = Number(process.env.TW_PORT) || 8080;
const SSE_PORT = Number(process.env.HMR_SSE_PORT) || 35730;
const POLL_MS = 250;
const DOWN_TIMEOUT_MS = 5000;
const UP_TIMEOUT_MS = 30000;

// The only tiddler natures that must reboot: JS modules and plugin.info.
// Everything else is content and is hot-swapped live.
const REBOOT_EXTS = new Set(["js", "info"]);
// Binary tiddler types are base64-encoded in their `text` field.
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "bmp",
  "woff", "woff2", "ttf", "otf", "eot", "pdf",
]);
// Fallback content-type when an asset file has no `.meta` sidecar.
const TYPE_BY_EXT = {
  css: "text/css",
  svg: "image/svg+xml",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  md: "text/x-markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  webp: "image/webp",
  woff: "application/font-woff",
  woff2: "application/font-woff2",
  ttf: "application/x-font-ttf",
  otf: "application/x-font-otf",
};

// ── SSE server ────────────────────────────────────────────────────────
const clients = new Set();

const sse = http.createServer((req, res) => {
  if (req.url.split("?")[0] !== "/hmr") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("retry: 1000\n\n");
  // First message on every connection: which dev wiki this stream belongs to (its TW port),
  // so a browser tab of another wiki that wandered onto this SSE port can ignore it.
  res.write("data: " + JSON.stringify({ type: "hello", port: TW_PORT }) + "\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

sse.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(`[hmr] port ${SSE_PORT} already in use — another pnpm dev running?\n`);
    process.exit(1);
  }
  throw err;
});

sse.listen(SSE_PORT, () =>
  process.stdout.write(`[hmr] SSE server on http://localhost:${SSE_PORT}/hmr\n`)
);

function broadcast(payload) {
  const line = "data: " + JSON.stringify(payload) + "\n\n";
  for (const res of clients) res.write(line);
}

// ── field / .tid / .multids parsing ───────────────────────────────────
function parseFields(block) {
  const fields = {};
  for (const rawLine of block.split("\n")) {
    const m = /^([^:]+):\s?(.*)$/.exec(rawLine);
    if (m) fields[m[1].trim()] = m[2];
  }
  return fields;
}

// Standard .tid: header "key: value" lines, blank line, then the text body.
function parseTid(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const sep = text.indexOf("\n\n");
  const fields = parseFields(sep === -1 ? text : text.slice(0, sep));
  fields.text = sep === -1 ? "" : text.slice(sep + 2);
  return fields.title ? [fields] : [];
}

// .multids: header block (common fields, incl. `title:` = shared prefix), blank
// line, then "Name: value" lines → one tiddler each (title = prefix + Name).
function parseMultids(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const sep = text.indexOf("\n\n");
  if (sep === -1) return [];
  const common = parseFields(text.slice(0, sep));
  const prefix = common.title || "";
  delete common.title;
  const out = [];
  for (const line of text.slice(sep + 2).split("\n")) {
    if (!line.trim()) continue;
    const m = /^([^:]+):\s?(.*)$/.exec(line);
    if (m) out.push(Object.assign({}, common, { title: prefix + m[1].trim(), text: m[2] }));
  }
  return out;
}

// TiddlyWiki filesystem filename convention (inverse of how titles are saved):
// `$__foo_bar` → `$:/foo/bar`. Only a fallback for meta-less asset files.
function deriveTitle(absBase) {
  let name = path.basename(absBase).replace(/\.[^.]+$/, "");
  if (name.indexOf("$__") === 0) name = "$:/" + name.slice(3).replace(/_/g, "/");
  return name;
}

// Asset tiddler (.css, .svg, .json, image…): body = file content (base64 for
// binary types), fields = sibling `.meta` (TW convention) or inferred.
function assetTiddler(absBase) {
  if (!fs.existsSync(absBase)) return [];
  const ext = path.extname(absBase).slice(1).toLowerCase();
  const metaPath = absBase + ".meta";
  let fields = {};
  if (fs.existsSync(metaPath)) {
    fields = parseFields(fs.readFileSync(metaPath, "utf8").replace(/\r\n/g, "\n"));
  }
  fields.text = BINARY_EXTS.has(ext)
    ? fs.readFileSync(absBase).toString("base64")
    : fs.readFileSync(absBase, "utf8").replace(/\r\n/g, "\n");
  if (!fields.type && TYPE_BY_EXT[ext]) fields.type = TYPE_BY_EXT[ext];
  if (!fields.title) fields.title = deriveTitle(absBase);
  return fields.title ? [fields] : [];
}

// ── readiness probe: module reboot → reload once TW is back up ─────────
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: "localhost", port: TW_PORT, path: "/" }, (res) => {
      res.resume();
      resolve(res.statusCode < 500 ? "up" : "down");
    });
    req.on("error", () => resolve("down"));
    req.setTimeout(800, () => {
      req.destroy();
      resolve("down");
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probe()) === state) return true;
    await sleep(POLL_MS);
  }
  return false;
}

let rebooting = false;
async function handleReboot() {
  if (rebooting) return;
  rebooting = true;
  try {
    await waitFor("down", DOWN_TIMEOUT_MS);
    const ready = await waitFor("up", UP_TIMEOUT_MS);
    process.stdout.write(
      ready
        ? "[hmr] TW rebooted — reloading browser\n"
        : "[hmr] reboot timeout — reloading anyway\n"
    );
    broadcast({ type: "reload" });
  } finally {
    rebooting = false;
  }
}

// ── file watching + classification ────────────────────────────────────
let debounce = null;
const pending = new Set(); // absolute paths, deduped across both watch roots

// ── content filter: react to real content changes only ────────────────
// fs.watch on Windows also fires on metadata-only changes: the last-access time
// NTFS updates when a file is merely *read* (a build, a grep, git computing a diff),
// attributes… A read `.js`/`plugin.info` then passed for a module change: the
// reboot handler waited for a TW restart that never came, then told the browser to
// reload — onto the server's boot-time state, silently dropping every hot push since
// (seen 2026-09-30). Each file's content hash is kept, from a startup scan; an event
// whose file still has the same content is ignored. A deleted file (no content)
// always counts as a change.
const crypto = require("crypto");
const knownHashes = new Map(); // absolute path → sha1 of its content
function hashOf(abs) {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
  } catch (err) {
    return null; // deleted, or a directory
  }
}
function indexDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) indexDir(abs);
    else if (entry.isFile()) knownHashes.set(abs, hashOf(abs));
  }
}
for (const dir of WATCH_DIRS) indexDir(dir);
function contentChanged(abs) {
  const hash = hashOf(abs);
  if (hash === null) {
    if (fs.existsSync(abs)) return false; // a directory event
    return knownHashes.delete(abs) || true; // deleted
  }
  if (knownHashes.get(abs) === hash) return false;
  knownHashes.set(abs, hash);
  return true;
}

for (const dir of WATCH_DIRS) {
  fs.watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (IGNORED_BASENAME.test(path.basename(filename))) return;
    const abs = path.join(dir, filename);
    if (!contentChanged(abs)) return;
    pending.add(abs);
    clearTimeout(debounce);
    debounce = setTimeout(flush, 100);
  });
}

function flush() {
  const files = [...pending];
  pending.clear();
  let needsReboot = false;
  const tiddlers = [];
  const assets = new Set(); // resolved asset paths to (re)build, deduped

  for (const filename of files) {
    let abs = filename;
    let ext = path.extname(abs).slice(1).toLowerCase();
    // A `.meta` change re-pushes its paired base file (or reboots if that base
    // is a module).
    if (ext === "meta") {
      abs = abs.replace(/\.meta$/, "");
      ext = path.extname(abs).slice(1).toLowerCase();
    }
    if (REBOOT_EXTS.has(ext)) {
      needsReboot = true;
      continue;
    }
    if (ext === "tid" || ext === "multids") {
      if (!fs.existsSync(abs)) continue;
      try {
        tiddlers.push(...(ext === "multids" ? parseMultids : parseTid)(
          fs.readFileSync(abs, "utf8")
        ));
      } catch (err) {
        process.stderr.write(`[hmr] parse failed for ${abs}: ${err.message}\n`);
      }
    } else if (ext) {
      assets.add(abs); // .css / .svg / .json / image / …
    }
  }

  for (const abs of assets) {
    try {
      tiddlers.push(...assetTiddler(abs));
    } catch (err) {
      process.stderr.write(`[hmr] asset failed for ${abs}: ${err.message}\n`);
    }
  }

  // A reboot supersedes content pushes: nodemon is restarting TW anyway, and the
  // reload that follows re-syncs everything from the fresh shadows.
  if (needsReboot) {
    handleReboot();
    return;
  }
  if (tiddlers.length) {
    broadcast({ type: "tiddlers", tiddlers });
    process.stdout.write(
      `[hmr] pushed ${tiddlers.length} tiddler(s): ${tiddlers.map((t) => t.title).join(", ")}\n`
    );
  }
}

process.stdout.write(`[hmr] watching ${WATCH_DIRS.join(", ")}\n`);