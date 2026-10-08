"use strict";

// Source directories of a dev wiki: the sources of the plugins it loads, so a
// change in any of them is hot-swapped (content) or reboots TW (module,
// plugin.info). Derived, so no per-plugin configuration:
//   • every `src/<name>/` of the project holding a plugin.info;
//   • every plugin listed in wiki/tiddlywiki.info that resolves through
//     TIDDLYWIKI_PLUGIN_PATH — i.e. the nikorion symlinks to sibling sources
//     (core plugins live in node_modules and are never watched).
// Optional `"twDev": { "watch": ["../Other/src/x"] }` in package.json adds more.
// Symlinks are resolved (fs.watch would not follow them), duplicates dropped.

const fs = require("fs");
const path = require("path");

function realDir(p) {
  try {
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch (err) {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return null;
  }
}

function sourceDirs(projectDir) {
  const dirs = new Set();

  const src = path.join(projectDir, "src");
  if (fs.existsSync(src)) {
    for (const name of fs.readdirSync(src)) {
      if (fs.existsSync(path.join(src, name, "plugin.info"))) {
        const real = realDir(path.join(src, name));
        if (real) dirs.add(real);
      }
    }
  }

  const info = readJson(path.join(projectDir, "wiki", "tiddlywiki.info")) || {};
  const libraries = (process.env.TIDDLYWIKI_PLUGIN_PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of info.plugins || []) {
    for (const library of libraries) {
      const real = realDir(path.join(library, name));
      if (real && fs.existsSync(path.join(real, "plugin.info"))) {
        dirs.add(real);
        break;
      }
    }
  }

  const pkg = readJson(path.join(projectDir, "package.json")) || {};
  for (const extra of (pkg.twDev && pkg.twDev.watch) || []) {
    const real = realDir(path.resolve(projectDir, extra));
    if (real) dirs.add(real);
    else process.stderr.write(`[dev] twDev.watch: ${extra} not found, skipped\n`);
  }

  return [...dirs];
}

module.exports = { sourceDirs };
