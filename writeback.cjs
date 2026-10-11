"use strict";

// Write-back: a tiddler of the plugin that the browser of the dev wiki saved under
// wiki/tiddlers/ is copied back into the plugin sources, then the wiki file is removed
// so the shadow tiddler of the plugin takes over again.
//
// Enabled per project by "twDev": { "writeBack": "src/<name>" } in package.json
// (see TW-Theme). dev-hmr.cjs calls onFile() on every real content change under
// wiki/tiddlers/.
//
// Which source file receives an edit is found by title, in the plugin folder:
//   • a .tid file          → body replaced, `modified` refreshed, other fields kept
//   • a .multids file      → the `key: value` line of that tiddler replaced
//   • a title under a prefix that a .multids of the plugin owns (e.g. a new Vanilla
//     setting) → one line appended to that file
// Titles the plugin does not know are left alone (ordinary tiddlers of the wiki).
//
// Loop safety: a wiki file whose content equals the source writes nothing; it is only
// removed. HMR pushing a source change back to the browser, which re-saves it, ends
// there.

const fs = require("fs");
const path = require("path");

const norm = (s) => s.replace(/\r\n/g, "\n");

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
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// title → { kind: "tid"|"multids", file, key? } for every tiddler the plugin ships,
// plus the prefixes owned by its .multids files.
function buildIndex(pluginDir) {
  const titles = new Map();
  const prefixes = []; // { prefix, file }
  for (const file of walk(pluginDir, [])) {
    const rel = path.relative(pluginDir, file);
    if (rel.split(path.sep)[0] === "language") continue;
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

// The tiddler a saved file represents, and the file(s) to delete once applied.
function readSaved(abs) {
  if (abs.endsWith(".tid")) {
    const { head, body } = splitTid(fs.readFileSync(abs, "utf8"));
    const fields = parseFields(head);
    return fields.title ? { fields, text: body, files: [abs] } : null;
  }
  const meta = abs.endsWith(".meta") ? abs : abs + ".meta";
  const base = abs.endsWith(".meta") ? abs.slice(0, -5) : abs;
  if (!fs.existsSync(meta) || !fs.existsSync(base)) return null; // wait for its pair
  const fields = parseFields(norm(fs.readFileSync(meta, "utf8")));
  if (!fields.title) return null;
  return { fields, text: norm(fs.readFileSync(base, "utf8")), files: [base, meta] };
}

function create(projectDir, pluginRel, log) {
  const pluginDir = path.resolve(projectDir, pluginRel);
  const wikiDir = path.resolve(projectDir, "wiki", "tiddlers");
  const inWiki = (abs) => path.resolve(abs).toLowerCase().startsWith(wikiDir.toLowerCase() + path.sep);

  function apply(saved, index) {
    const title = saved.fields.title;
    const hit = index.titles.get(title);
    if (hit && hit.kind === "tid") {
      const { head, body } = splitTid(fs.readFileSync(hit.file, "utf8"));
      if (body.replace(/\n+$/, "") === saved.text.replace(/\n+$/, "")) return "same";
      let lines = head.split("\n");
      const modified = saved.fields.modified;
      if (modified) {
        const i = lines.findIndex((l) => /^modified:/.test(l));
        if (i >= 0) lines[i] = "modified: " + modified;
        else lines.push("modified: " + modified);
      }
      fs.writeFileSync(hit.file, lines.join("\n") + "\n\n" + saved.text.replace(/\n+$/, "") + "\n");
      return path.relative(pluginDir, hit.file);
    }
    const owner = hit && hit.kind === "multids"
      ? { file: hit.file, key: hit.key }
      : (() => {
          const p = index.prefixes
            .filter((x) => title.startsWith(x.prefix))
            .sort((a, b) => b.prefix.length - a.prefix.length)[0];
          return p ? { file: p.file, key: title.slice(p.prefix.length), isNew: true } : null;
        })();
    if (!owner) return null;
    const value = saved.text.replace(/\n+$/, "");
    if (value.includes("\n")) throw new Error("multi-line value cannot go in a .multids file");
    const src = norm(fs.readFileSync(owner.file, "utf8"));
    const lines = src.split("\n");
    const i = lines.findIndex((l) => l.startsWith(owner.key + ":"));
    if (i >= 0) {
      if (lines[i] === `${owner.key}: ${value}`) return "same";
      lines[i] = `${owner.key}: ${value}`;
    } else {
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(`${owner.key}: ${value}`, "");
    }
    fs.writeFileSync(owner.file, lines.join("\n"));
    return path.relative(pluginDir, owner.file);
  }

  return {
    // Returns true when the saved file belonged to the plugin and was folded back.
    onFile(abs) {
      if (!inWiki(abs) || !fs.existsSync(abs)) return false;
      if (!/\.(tid|meta)$/.test(abs) && !fs.existsSync(abs + ".meta")) return false;
      const saved = readSaved(abs);
      if (!saved) return false;
      const index = buildIndex(pluginDir);
      let target;
      try {
        target = apply(saved, index);
      } catch (err) {
        log(`[writeback] ${saved.fields.title}: ${err.message} — kept in the wiki`);
        return false;
      }
      if (target === null) return false;
      for (const f of saved.files) fs.rmSync(f, { force: true });
      if (target !== "same") log(`[writeback] ${saved.fields.title} → ${target}`);
      return true;
    },
  };
}

module.exports = { create };
