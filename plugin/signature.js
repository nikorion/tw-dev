(function () {
"use strict";
exports.name = "dev-signature";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;
exports.startup = function () {
  // Every tiddler created or edited in a dev wiki is signed `nikorion` (creator /
  // modifier) and dated (created / modified), whatever the user name set in the
  // control panel — the dev wikis' content is what the published demos ship.
  // $:/status/UserName cannot carry this: the syncer overwrites it with the
  // server's user name, so the core's creation/modification fields are wrapped.
  var AUTHOR = "nikorion";
  var getCreation = $tw.wiki.getCreationFields;
  var getModification = $tw.wiki.getModificationFields;
  $tw.wiki.getCreationFields = function () {
    var fields = getCreation.apply(this, arguments);
    fields.creator = AUTHOR;
    if (!fields.created) fields.created = new Date();
    return fields;
  };
  $tw.wiki.getModificationFields = function () {
    var fields = getModification.apply(this, arguments);
    fields.modifier = AUTHOR;
    if (!fields.modified) fields.modified = new Date();
    return fields;
  };
};
})();
