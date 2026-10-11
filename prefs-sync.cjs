#!/usr/bin/env node
"use strict";

// Shared interface preferences for every nikorion dev wiki.
//
// A preference (palette, layout, sizes…) set through the UI of one dev wiki is
// written by TW's filesystem adapter to that wiki's wiki/tiddlers/system/. This
// module copies it, byte for byte, to the same file of every other dev wiki of the
// workspace, so all wikis (and their published demos) share one setting.
//
// Which tiddlers count as preferences: prefs.json (exact titles + title prefixes).
//
//   • live    — dev-hmr.cjs calls onChange() on each real content change of a file
//               under its own wiki/tiddlers/system/. The other wikis' running
//               dev servers then see the file change and push it to their browsers.
//               Termination: a copy that is already identical writes nothing, so the
//               echo events of the receiving wikis stop there.
//   • one-shot — `node prefs-sync.cjs` converges all wikis on the most recently
//               modified version of each preference; `--check` only reports.
//
// Deleting a preference file in one wiki deletes it in the others (back to the TW
// default everywhere).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "prefs.json"), "utf8"));
const SYSTEM = path.join("wiki", "tiddlers", "system");

function wikis() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !CONFIG.exclude.includes(e.name))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(ROOT, name, SYSTEM)));
}

// Title and `modified` of a .tid file (header only), or null.
function header(abs) {
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    return null;
  }
  const head = raw.replace(/\r\n/g, "\n").split("\n\n")[0];
  const fields = {};
  for (const line of head.split("\n")) {
    const m = /^([^:]+):\s?(.*)$/.exec(line);
    if (m) fields[m[1].trim()] = m[2];
  }
  return fields.title ? { title: fields.title, modified: fields.modified || "" } : null;
}

function isPrefTitle(title) {
  return CONFIG.titles.includes(title) || CONFIG.prefixes.some((p) => title.startsWith(p));
}

// Windows paths: drive-letter and name case may differ between the two sources.
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function sameBytes(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch (err) {
    return false;
  }
}

function copyToOthers(srcAbs, log) {
  const src = path.resolve(srcAbs);
  const base = path.basename(src);
  const own = path.resolve(src, "..", "..", "..", "..");
  let copied = 0;
  for (const name of wikis()) {
    const dir = path.join(ROOT, name);
    if (samePath(dir, own)) continue;
    const dest = path.join(dir, SYSTEM, base);
    if (sameBytes(src, dest)) continue;
    fs.copyFileSync(src, dest);
    copied++;
    log(`[prefs] ${base} -> ${name}`);
  }
  return copied;
}

// Text of a .tid (headers ignored: timestamps alone are not a difference).
function bodyOf(abs) {
  const raw = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
  const i = raw.indexOf("\n\n");
  return i < 0 ? "" : raw.slice(i + 2);
}

// Files known to be preferences (basename set), to propagate their deletion.
const known = new Set();
function scan(wikiDir) {
  const dir = path.join(wikiDir, SYSTEM);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".tid") || /_d+.tid$/.test(f)) continue;
    const h = header(path.join(dir, f));
    if (h && isPrefTitle(h.title)) known.add(f);
  }
}

// Called with the absolute path of a file whose content really changed (or that
// was deleted) under <wikiDir>/wiki/tiddlers/system/.
function onChange(abs, log) {
  // A wiki listed in `exclude` neither gives nor receives preferences.
  if (CONFIG.exclude.includes(path.basename(path.resolve(abs, "..", "..", "..", "..")))) return;
  const base = path.basename(abs);
  if (!base.endsWith(".tid")) return;
  if (!fs.existsSync(abs)) {
    if (!known.delete(base)) return;
    const own = path.resolve(abs, "..", "..", "..", "..");
    for (const name of wikis()) {
      const dest = path.join(ROOT, name, SYSTEM, base);
      if (samePath(path.join(ROOT, name), own) || !fs.existsSync(dest)) continue;
      fs.unlinkSync(dest);
      log(`[prefs] ${base} deleted in ${name}`);
    }
    return;
  }
  const h = header(abs);
  if (!h || !isPrefTitle(h.title)) return;
  // A running dev server that did not know this file (we had just created it)
  // saves the preference again under a `_N` name — the adapter's title→file
  // collision. Fold it back onto the real file; the rename is a second change
  // event, which propagates it.
  const dup = /^(.*)_\d+\.tid$/.exec(base);
  if (dup && !known.has(base)) {
    const real = path.join(path.dirname(abs), dup[1] + ".tid");
    const hr = header(real);
    if (!hr || hr.title === h.title) {
      fs.renameSync(abs, real);
      log(`[prefs] ${base} folded onto ${dup[1]}.tid`);
      return;
    }
  }
  known.add(base);
  copyToOthers(abs, log);
}

function init(wikiDir) {
  scan(wikiDir);
}

module.exports = { onChange, init };

// ── one-shot CLI ───────────────────────────────────────────────────────
if (require.main === module) {
  const checkOnly = process.argv.includes("--check");
  const all = wikis();
  const byFile = new Map(); // basename → [{wiki, abs, modified, bytes}]
  for (const name of all) {
    const dir = path.join(ROOT, name, SYSTEM);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".tid")) continue;
      const abs = path.join(dir, f);
      const h = header(abs);
      if (!h || !isPrefTitle(h.title)) continue;
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push({ wiki: name, abs, modified: h.modified, body: bodyOf(abs) });
    }
  }
  let todo = 0;
  for (const [f, copies] of [...byFile].sort()) {
    const newest = copies.slice().sort((a, b) => b.modified.localeCompare(a.modified))[0];
    const missing = all.filter((n) => !copies.some((c) => c.wiki === n));
    const differing = copies.filter((c) => c.body !== newest.body);
    if (!missing.length && !differing.length) continue;
    todo++;
    console.log(`${checkOnly ? "differs" : "sync   "} ${f} (from ${newest.wiki}) -> ${[...missing, ...differing.map((c) => c.wiki)].join(", ")}`);
    if (!checkOnly) {
      for (const n of missing) fs.copyFileSync(newest.abs, path.join(ROOT, n, SYSTEM, f));
      for (const c of differing) fs.copyFileSync(newest.abs, c.abs);
    }
  }
  console.log(todo ? `${todo} preference file(s) ${checkOnly ? "to sync" : "synced"}` : "all wikis agree");
}
