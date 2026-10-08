#!/usr/bin/env node
"use strict";

// CI only (GitHub Actions): builds the TIDDLYWIKI_PLUGIN_PATH that the local
// machine gets from its folder of symlinks, so `tiddlywiki <edition> --build`
// resolves every "nikorion/<name>" entry off-machine.
//
//   node ci-plugins.cjs <edition dir>...   plugins listed by these tiddlywiki.info
//   node ci-plugins.cjs --all              every plugin of plugins.json (library)
//
// A plugin whose sources are in the checked-out repository (src/<name>/) is
// linked from there; any other is cloned (shallow, default branch) from
// github.com/nikorion/<repo> (plugins.json maps the short name to the repo).
// The resulting path is appended to $GITHUB_ENV for the following steps.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPOS = JSON.parse(fs.readFileSync(path.join(__dirname, "plugins.json"), "utf8"));
const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();
const TEMP = process.env.RUNNER_TEMP || require("os").tmpdir();
const LIBRARY = path.join(TEMP, "tw-plugins");
const CLONES = path.join(TEMP, "tw-repos");

function wanted(args) {
  if (args[0] === "--all") return Object.keys(REPOS);
  const names = new Set();
  for (const edition of args) {
    const info = JSON.parse(fs.readFileSync(path.join(edition, "tiddlywiki.info"), "utf8"));
    for (const plugin of info.plugins || []) {
      if (plugin.startsWith("nikorion/")) names.add(plugin.slice("nikorion/".length));
    }
  }
  return [...names];
}

function sourceOf(name) {
  const local = path.join(WORKSPACE, "src", name);
  if (fs.existsSync(path.join(local, "plugin.info"))) return local;
  const repo = REPOS[name];
  if (!repo) throw new Error(`nikorion/${name}: not in plugins.json`);
  const clone = path.join(CLONES, repo);
  if (!fs.existsSync(clone)) {
    execFileSync("git", ["clone", "--depth", "1", "--quiet", `https://github.com/nikorion/${repo}`, clone], { stdio: "inherit" });
  }
  return path.join(clone, "src", name);
}

fs.mkdirSync(path.join(LIBRARY, "nikorion"), { recursive: true });
for (const name of wanted(process.argv.slice(2))) {
  const target = path.join(LIBRARY, "nikorion", name);
  if (!fs.existsSync(target)) fs.symlinkSync(sourceOf(name), target, "dir");
  process.stdout.write(`nikorion/${name} → ${fs.realpathSync(target)}\n`);
}
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `TIDDLYWIKI_PLUGIN_PATH=${LIBRARY}\n`);
