(function () {
"use strict";
exports.name = "dev-hmr";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;
exports.startup = function () {
  // Paired with tw-dev/dev-hmr.cjs. Receives content-tiddler pushes and reload
  // signals over SSE. The port is chosen by tw-dev/dev.cjs and published via
  // $:/config/dev/hmr-port, a tiddler of this same session plugin.
  var port = $tw.wiki.getTiddlerText("$:/config/dev/hmr-port", "35730").trim();
  var source = new EventSource("http://localhost:" + port + "/hmr");
  // Several dev wikis can be open at once: obey a stream only after its hello names this wiki's own
  // server port - never another wiki's pushes (they would be saved to this wiki's disk by the syncer).
  var accepted = false;
  source.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === "hello") {
      accepted = String(msg.port) === String(window.location.port);
      if (!accepted) console.warn("[hmr] ignoring the stream of the dev wiki on port " + msg.port);
      return;
    }
    if (!accepted) return;
    if (msg.type === "reload") {
      window.location.reload();
    } else if (msg.type === "tiddlers" && msg.tiddlers) {
      // A real tiddler of the same title overrides the plugin's shadow and
      // re-renders reactively — in memory only: $:/config/SyncFilter (overridden
      // in this wiki) keeps the plugin prefix out of the tiddlyweb sync, so
      // nothing is persisted to disk or to the server store.
      msg.tiddlers.forEach(function (fields) {
        $tw.wiki.addTiddler(new $tw.Tiddler(fields));
      });
      console.log("[hmr] applied " + msg.tiddlers.length + " tiddler(s)");
    }
  };
};
})();
