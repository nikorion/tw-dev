"use strict";

// Write-back: whatever the browser of the dev wiki saves under wiki/tiddlers/ is folded
// back into the plugin sources, then the saved file is removed so the plugin's own
// shadow tiddler takes over. In such a project the plugin is the content: everything
// created or edited through the web interface is considered part of it.
//
// Enabled per project by "twDev": { "writeBack": "src/<name>" } in package.json
// (see TW-PKM-Theme). dev-hmr.cjs calls onFile() on every real content change under
// wiki/tiddlers/.
//
// Where a saved tiddler goes, by title:
//   • already shipped by the plugin:
//       .tid file     → body replaced, `modified` refreshed, other fields kept
//       .multids line → `key: value` replaced (a multi-line value moves to its own
//                       overrides/<slug>.tid and the line is dropped)
//   • new, under a prefix a .multids of the plugin owns (a new Vanilla setting)
//       → one line appended to that file
//   • new otherwise
//       stylesheet (type text/css or tagged $:/tags/Stylesheet) → styles/<slug>.tid
//       binary (image, font…)                                  → images/<file> + .meta
//       anything else                                          → overrides/<slug>.tid
//
// Never taken: drafts, session/state tiddlers (see TRANSIENT) and the tiddlers that were
// already files of wiki/tiddlers/ when the server started — the wiki's own content
// (Playground, titles, settings of the dev wiki…), whose edits stay in the wiki.
//
// Loop safety: a saved file whose content equals the source writes nothing; it is only
// removed. HMR pushing a source change back to the browser, which re-saves it, ends there.

const fs = require("fs");
const path = require("path");

const norm = (s) => s.replace(/\r\n/g, "\n");

const TRANSIENT = [
  /^Draft of '/,
  /^\$:\/(StoryList|HistoryList|Import|isEncrypted|language|status\/|state\/|temp\/|boot\/|plugins\/nikorion\/)/,
];

function parseFields(block) {
  const fields = {};
  for (const line of block.split("\n")) {
    const m = /^([^:]+):\s?(.*)$/.exec(line);
    if (m) fields[m[1].trim()] = m[2];
  }
  return fields;
}

function splitTid(raw) {
  const text = norm(raw);
  const i = text.indexOf("\n\n");
  return i < 0
    ? { head: text, body: "" }
    : { head: text.slice(0, i), body: text.slice(i + 2) };
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// title → { kind: "tid"|"multids", file, key? } for every tiddler the plugin ships,
// plus the prefixes owned by its .multids files.
function buildIndex(pluginDirs) {
  const titles = new Map();
  const prefixes = []; // { prefix, file }
  const files = [];
  for (const d of pluginDirs) {
    for (const file of walk(d, [])) {
      if (path.relative(d, file).split(path.sep)[0] !== "language") files.push(file);
    }
  }
  for (const file of files) {
    if (file.endsWith(".tid")) {
      const { head } = splitTid(fs.readFileSync(file, "utf8"));
      const f = parseFields(head);
      if (f.title) titles.set(f.title, { kind: "tid", file });
    } else if (file.endsWith(".multids")) {
      const { head, body } = splitTid(fs.readFileSync(file, "utf8"));
      const prefix = parseFields(head).title || "";
      if (prefix) prefixes.push({ prefix, file });
      for (const line of body.split("\n")) {
        const m = /^([^:]+):/.exec(line);
        if (m) titles.set(prefix + m[1].trim(), { kind: "multids", file, key: m[1].trim() });
      }
    }
  }
  return { titles, prefixes };
}

// Titles of every tiddler file under dir (.tid, or a .meta sidecar).
function titlesOf(dir) {
  const out = new Set();
  for (const file of walk(dir, [])) {
    if (!/\.(tid|meta)$/.test(file)) continue;
    const { head } = splitTid(fs.readFileSync(file, "utf8"));
    const t = parseFields(head).title;
    if (t) out.add(t);
  }
  return out;
}

// The tiddler a saved file represents, and the file(s) to delete once applied.
function readSaved(abs) {
  if (abs.endsWith(".tid")) {
    const { head, body } = splitTid(fs.readFileSync(abs, "utf8"));
    const fields = parseFields(head);
    return fields.title ? { fields, text: body, files: [abs], binary: null } : null;
  }
  const meta = abs.endsWith(".meta") ? abs : abs + ".meta";
  const base = abs.endsWith(".meta") ? abs.slice(0, -5) : abs;
  if (!fs.existsSync(meta) || !fs.existsSync(base)) return null; // wait for its pair
  const fields = parseFields(norm(fs.readFileSync(meta, "utf8")));
  if (!fields.title) return null;
  const type = fields.type || "";
  const isText = type === "" || /^text\//.test(type) || /(json|xml|javascript)/.test(type);
  return {
    fields,
    text: isText ? norm(fs.readFileSync(base, "utf8")) : null,
    files: [base, meta],
    binary: isText ? null : { base, meta },
  };
}

function slugOf(title) {
  return (
    title
      .replace(/^\$:\//, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "tiddler"
  );
}

function serialise(fields, text) {
  const skip = new Set(["text", "bag", "revision", "_canonical_uri"]);
  const keys = Object.keys(fields).filter((k) => !skip.has(k) && k !== "title");
  const lines = keys.map((k) => `${k}: ${fields[k]}`);
  lines.push(`title: ${fields.title}`);
  return lines.join("\n") + "\n\n" + text.replace(/\n+$/, "") + "\n";
}

// `config` is the "writeBack" value of package.json: a folder, or
// { "dirs": [folders searched for the shipped titles], "default": folder for new ones,
//   "createNew": false to leave titles unknown to those folders in the wiki }.
function create(projectDir, config, log) {
  const cfg = typeof config === "string" ? { dirs: [config], default: config } : config;
  const dirs = cfg.dirs.map((d) => path.resolve(projectDir, d));
  const pluginDir = path.resolve(projectDir, cfg.default || cfg.dirs[0]);
  const wikiDir = path.resolve(projectDir, "wiki", "tiddlers");
  const inWiki = (abs) => path.resolve(abs).toLowerCase().startsWith(wikiDir.toLowerCase() + path.sep);
  // The wiki's own content: files that exist before anything is saved.
  const owned = titlesOf(wikiDir);

  function uniquePath(dir, name, ext) {
    fs.mkdirSync(dir, { recursive: true });
    let p = path.join(dir, name + ext);
    for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${name}-${n}${ext}`);
    return p;
  }

  function createNew(saved, index) {
    const { title } = saved.fields;
    if (saved.binary) {
      const dest = uniquePath(path.join(pluginDir, "images"), path.basename(saved.binary.base), "");
      fs.copyFileSync(saved.binary.base, dest);
      fs.copyFileSync(saved.binary.meta, dest + ".meta");
      return path.relative(pluginDir, dest);
    }
    const value = saved.text.replace(/\n+$/, "");
    const owner = index.prefixes
      .filter((x) => title.startsWith(x.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (owner && !value.includes("\n")) {
      const key = title.slice(owner.prefix.length);
      const lines = norm(fs.readFileSync(owner.file, "utf8")).split("\n");
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(`${key}: ${value}`, "");
      fs.writeFileSync(owner.file, lines.join("\n"));
      return path.relative(pluginDir, owner.file);
    }
    const isStyle =
      saved.fields.type === "text/css" || /(^| )\$:\/tags\/Stylesheet( |$)/.test(saved.fields.tags || "");
    const dir = path.join(pluginDir, isStyle ? "styles" : "overrides");
    const file = uniquePath(dir, slugOf(title), ".tid");
    fs.writeFileSync(file, serialise(saved.fields, saved.text));
    return path.relative(pluginDir, file);
  }

  function apply(saved, index) {
    const { title } = saved.fields;
    if (saved.binary) return index.titles.has(title) ? "same" : createNew(saved, index);
    const hit = index.titles.get(title);
    if (!hit) {
      const owned = index.prefixes.some((x) => title.startsWith(x.prefix));
      if (cfg.createNew === false && !owned) return null; // unknown title: stays in the wiki
      return createNew(saved, index);
    }
    if (hit.kind === "tid") {
      const { head, body } = splitTid(fs.readFileSync(hit.file, "utf8"));
      if (body.replace(/\n+$/, "") === saved.text.replace(/\n+$/, "")) return "same";
      const lines = head.split("\n");
      const modified = saved.fields.modified;
      if (modified) {
        const i = lines.findIndex((l) => /^modified:/.test(l));
        if (i >= 0) lines[i] = "modified: " + modified;
        else lines.push("modified: " + modified);
      }
      fs.writeFileSync(hit.file, lines.join("\n") + "\n\n" + saved.text.replace(/\n+$/, "") + "\n");
      return path.relative(pluginDir, hit.file);
    }
    // a line of a .multids file
    const value = saved.text.replace(/\n+$/, "");
    const lines = norm(fs.readFileSync(hit.file, "utf8")).split("\n");
    const i = lines.findIndex((l) => l.startsWith(hit.key + ":"));
    if (value.includes("\n")) {
      // does not fit on one line: give it its own file and drop the line
      if (i >= 0) lines.splice(i, 1);
      fs.writeFileSync(hit.file, lines.join("\n"));
      const file = uniquePath(path.join(pluginDir, "overrides"), slugOf(title), ".tid");
      fs.writeFileSync(file, serialise(saved.fields, saved.text));
      return path.relative(pluginDir, file);
    }
    if (i >= 0 && lines[i] === `${hit.key}: ${value}`) return "same";
    if (i >= 0) lines[i] = `${hit.key}: ${value}`;
    else {
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(`${hit.key}: ${value}`, "");
    }
    fs.writeFileSync(hit.file, lines.join("\n"));
    return path.relative(pluginDir, hit.file);
  }

  return {
    // Returns true when the saved file was folded back into the plugin.
    onFile(abs) {
      if (!inWiki(abs) || !fs.existsSync(abs)) return false;
      if (!/\.(tid|meta)$/.test(abs) && !fs.existsSync(abs + ".meta")) return false;
      const saved = readSaved(abs);
      if (!saved) return false;
      const { title } = saved.fields;
      if (saved.fields["draft.of"] || TRANSIENT.some((r) => r.test(title))) return false;
      if (owned.has(title)) return false; // the wiki's own content stays in the wiki
      const index = buildIndex(dirs);
      let target;
      try {
        target = apply(saved, index);
      } catch (err) {
        log(`[writeback] ${title}: ${err.message} — kept in the wiki`);
        return false;
      }
      if (target === null) return false; // not ours: the saved file stays in the wiki
      for (const f of saved.files) fs.rmSync(f, { force: true });
      if (target !== "same") log(`[writeback] ${title} → ${target}`);
      return true;
    },
  };
}

module.exports = { create };
