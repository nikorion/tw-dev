#!/usr/bin/env node
"use strict";

// `pnpm dev` of every nikorion plugin: `"dev": "node ../tw-dev/dev.cjs"`, run
// from the plugin's project folder (process.cwd()).
//
// Resolves both dev ports once — the TiddlyWiki HTTP port and the content-HMR
// SSE port — as random free ports (or the ones asked for through TW_PORT /
// HMR_SSE_PORT, falling back to a random one if taken), so any number of
// nikorion dev servers can run in parallel. Then starts two long-lived children:
//   • nodemon      → reboots TW on module (.js) / plugin.info changes in the
//                    watched sources (see watch-dirs.cjs)
//   • dev-hmr.cjs  → content-HMR SSE server
//
// The browser half of the HMR ($:/dev/hmr) and the SSE port it must connect to
// ship in a session plugin generated under .state/<project>/ and loaded with
// `tiddlywiki ++<folder>`: nothing is written to the wiki's tiddlers/, and the
// production build (`tiddlywiki wiki --build`) never sees it.
//
// Zero added dependency: port resolution uses the native `net` module and the
// children are spawned directly. nodemon and tiddlywiki come from the plugin
// project's own devDependencies.

const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { sourceDirs } = require("./watch-dirs.cjs");
const { buildPluginPath } = require("./plugin-path.cjs");

const PROJECT = process.cwd();
const STATE = path.join(__dirname, ".state", path.basename(PROJECT));
fs.mkdirSync(STATE, { recursive: true });

// No fixed default: both ports are random free ones (so every plugin's dev
// server can run at once, and none squats 8080, which another service uses).
// The ports of the previous run are remembered and tried first, so a plugin
// keeps the same URL from one `pnpm dev` to the next unless something else has
// taken the port meanwhile (then a random one is drawn and saved).
const PORTS_FILE = path.join(STATE, "ports.json");
let savedPorts = {};
try { savedPorts = JSON.parse(fs.readFileSync(PORTS_FILE, "utf8")); } catch (e) { /* first run */ }
const PREFERRED_TW_PORT = Number(process.env.TW_PORT) || Number(savedPorts.tw) || 0;
const PREFERRED_SSE_PORT = Number(process.env.HMR_SSE_PORT) || Number(savedPorts.sse) || 0;

// TiddlyWiki's `--listen` defaults to host 127.0.0.1, so probe that same
// interface. Binding 0.0.0.0 here gave false positives on Windows: it succeeds
// even when another process already holds 127.0.0.1:<port>, so a stale dev
// server was reported "free" and TW then crashed with EADDRINUSE instead of
// moving aside.
const HOST = "127.0.0.1";
// The HMR SSE server (dev-hmr.cjs) listens with no host, i.e. dual-stack `::` — probe it
// the same way (host undefined), otherwise a 127.0.0.1 probe reports a port held on
// `::` as free and a parallel `pnpm dev` loses its HMR.

// Can we bind this port right now? (briefly opens then closes a listener)
function isFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

// Ask the OS for any free ephemeral port (listen on 0 → it assigns one).
function randomFreePort(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function resolvePort(preferred, label, host) {
  if (preferred && (await isFree(preferred, host))) return preferred;
  const port = await randomFreePort(host);
  if (preferred) process.stdout.write(`[dev] ${label} port ${preferred} busy → using free port ${port}\n`);
  return port;
}

// Session plugin = the static files of plugin/ + the SSE port tiddler.
function writeSessionPlugin(ssePort) {
  const dir = path.join(STATE, "plugin");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(__dirname, "plugin"), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hmr-port.tid"), `title: $:/config/dev/hmr-port\n\n${ssePort}\n`);
  return dir;
}

(async () => {
  const twPort = await resolvePort(PREFERRED_TW_PORT, "TiddlyWiki", HOST);
  const ssePort = await resolvePort(PREFERRED_SSE_PORT, "HMR SSE");
  fs.writeFileSync(PORTS_FILE, JSON.stringify({ tw: twPort, sse: ssePort }) + "\n");

  const pluginDir = writeSessionPlugin(ssePort);
  // The nikorion plugins this wiki loads, resolved without any machine setup
  // (plugin-path.cjs); an existing TIDDLYWIKI_PLUGIN_PATH still works, after it.
  process.env.TIDDLYWIKI_PLUGIN_PATH = [buildPluginPath(PROJECT, STATE), process.env.TIDDLYWIKI_PLUGIN_PATH]
    .filter(Boolean)
    .join(path.delimiter);
  const watchDirs = sourceDirs(PROJECT);
  const env = {
    ...process.env,
    TW_PORT: String(twPort),
    HMR_SSE_PORT: String(ssePort),
    TW_DEV_SOURCES: JSON.stringify(watchDirs),
  };
  process.stdout.write(`[dev] TiddlyWiki → http://localhost:${twPort}  (HMR SSE :${ssePort})\n`);

  // Reboot TW on a module or plugin.info change anywhere in the loaded sources.
  const watchArgs = watchDirs.flatMap((dir) => ["--watch", dir]);
  const nodemonBin = require.resolve("nodemon/bin/nodemon.js", { paths: [PROJECT] });
  const nodemon = spawn(
    process.execPath,
    [
      nodemonBin,
      "--config", path.join(__dirname, "nodemon.json"),
      ...watchArgs,
      "--ext", "js,info",
      "--exec", `tiddlywiki "++${pluginDir}" wiki --listen port=${twPort}`,
    ],
    { stdio: "inherit", env }
  );
  // The project path is passed only to show in the process command line, so a
  // leftover dev-hmr (still holding the SSE port) can be found by project name.
  const hmr = spawn(process.execPath, [path.join(__dirname, "dev-hmr.cjs"), PROJECT], {
    stdio: "inherit",
    env,
  });

  // Ctrl+C (or nodemon stopping) tears both down. dev-hmr exiting on its own is
  // NOT fatal: it bails out when the SSE port is already taken (a parallel
  // `pnpm dev` for another plugin), and TW should keep serving.
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of [nodemon, hmr]) {
      if (!child.killed) child.kill();
    }
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  nodemon.on("exit", shutdown);
})();
