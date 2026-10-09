"use strict";

// Builds, for one dev wiki, the folder TIDDLYWIKI_PLUGIN_PATH points to, so
// `pnpm dev` works on a fresh clone: no machine-wide variable, no symlink to
// create by hand, no admin rights.
//
// For every "nikorion/<name>" of wiki/tiddlywiki.info it links, in order:
//   1. src/<name>/ of the project itself;
//   2. ../<repo>/src/<name>/ — a sibling repository cloned next to it (plugins.json
//      maps the short name to the repository), so edits to it are live;
//   3. otherwise a shallow clone of github.com/nikorion/<repo>, cached in
//      .state/repos/ (read-only use: clone the repo next to the project to edit it).
// Links are directory junctions on Windows (no admin rights or developer mode
// needed), symlinks elsewhere. The folder is rebuilt on each run.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPOS = JSON.parse(fs.readFileSync(path.join(__dirname, "plugins.json"), "utf8"));
const CACHE = path.join(__dirname, ".state", "repos");

function hasPlugin(dir) {
  return fs.existsSync(path.join(dir, "plugin.info"));
}

function locate(projectDir, name) {
  const own = path.join(projectDir, "src", name);
  if (hasPlugin(own)) return { dir: own, from: "project" };
  const repo = REPOS[name];
  if (!repo) return null;
  const sibling = path.join(projectDir, "..", repo, "src", name);
  if (hasPlugin(sibling)) return { dir: sibling, from: "sibling" };
  const clone = path.join(CACHE, repo);
  if (!fs.existsSync(clone)) {
    process.stdout.write(`[dev] nikorion/${name}: cloning github.com/nikorion/${repo} (read-only cache)\n`);
    fs.mkdirSync(CACHE, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--quiet", `https://github.com/nikorion/${repo}`, clone], { stdio: "inherit" });
  }
  const cached = path.join(clone, "src", name);
  return hasPlugin(cached) ? { dir: cached, from: "cache" } : null;
}

function buildPluginPath(projectDir, stateDir) {
  const root = path.join(stateDir, "plugins");
  const links = path.join(root, "nikorion");
  // Remove the previous links one by one, never recursively: a recursive delete
  // could follow a junction and wipe the plugin sources it points to.
  if (fs.existsSync(links)) {
    for (const entry of fs.readdirSync(links)) {
      const link = path.join(links, entry);
      if (!fs.lstatSync(link).isSymbolicLink()) throw new Error(`${link} is not a link: refusing to delete it`);
      try { fs.unlinkSync(link); } catch (err) { fs.rmdirSync(link); }
    }
  }
  fs.mkdirSync(links, { recursive: true });
  const info = JSON.parse(fs.readFileSync(path.join(projectDir, "wiki", "tiddlywiki.info"), "utf8"));
  for (const plugin of info.plugins || []) {
    if (!plugin.startsWith("nikorion/")) continue;
    const name = plugin.slice("nikorion/".length);
    const found = locate(projectDir, name);
    if (!found) {
      process.stderr.write(`[dev] nikorion/${name}: not found (not in plugins.json?)\n`);
      continue;
    }
    fs.symlinkSync(found.dir, path.join(root, "nikorion", name), process.platform === "win32" ? "junction" : "dir");
    process.stdout.write(`[dev] nikorion/${name} ← ${found.from}\n`);
  }
  return root;
}

module.exports = { buildPluginPath };
