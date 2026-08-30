/*
 * hostscript.jsx — AE Llama's ExtendScript side.
 *
 * The panel calls exactly one entry point:
 *     AELL_call("<toolName>", "<json args string>")
 * which dispatches into the allowlisted TOOLS table below and returns a JSON
 * string: {"ok":true,"data":...} or {"ok":false,"error":"..."}.
 *
 * Everything here is ES3 (ExtendScript). No JSON object exists in AE's
 * engine, so a small serializer/parser is included.
 */

// ---------------------------------------------------------------- JSON (ES3)

var AELLJSON = (function () {

  function isArray(v) {
    return v !== null && typeof v === "object" &&
           typeof v.length === "number" &&
           typeof v.join === "function";
  }

  function escapeString(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === "\\") out += "\\\\";
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (code < 32) {
        var hex = code.toString(16);
        while (hex.length < 4) hex = "0" + hex;
        out += "\\u" + hex;
      } else out += c;
    }
    return '"' + out + '"';
  }

  function stringify(v) {
    var t = typeof v;
    if (v === null || t === "undefined") return "null";
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return escapeString(v);
    if (isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(stringify(v[i]));
      return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
      var kv = [];
      for (var k in v) {
        if (v.hasOwnProperty(k) && typeof v[k] !== "function") {
          kv.push(escapeString(k) + ":" + stringify(v[k]));
        }
      }
      return "{" + kv.join(",") + "}";
    }
    return "null";
  }

  // Crockford-style validation (pure ES3) so eval can only ever see JSON —
  // AELL_call is on $.global and reachable from other extensions, so the
  // input cannot be assumed to be our panel's well-formed encoding.
  function parse(s) {
    if (!s) return {};
    var probe = String(s)
      .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
      .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
      .replace(/(?:^|:|,)(?:\s*\[)+/g, "");
    if (!/^[\],:{}\s]*$/.test(probe)) {
      throw new Error("Arguments are not valid JSON");
    }
    return eval("(" + s + ")");
  }

  return { stringify: stringify, parse: parse, isArray: isArray };
})();

// ------------------------------------------------------------------- helpers

function AELL_err(msg) { return { ok: false, error: String(msg) }; }
function AELL_okay(data) { return { ok: true, data: data }; }

/* A failure that ALREADY CHANGED THINGS before giving up. The batch
 * tools (for_each_layer and friends) can get halfway through 200 layers
 * and stop; to the round rollback that counts as both a success and a
 * failure, so such a round is undone even when this is the only command
 * in it. Plain AELL_err would leave the half-applied work behind. */
function AELL_errPartial(msg) {
  return { ok: false, error: String(msg), mutated: true };
}

function AELL_resolveComp(name) {
  var proj = app.project;
  if (!proj) throw new Error("No project open");
  // Digit-only comp names ("1080") may arrive as JSON numbers.
  if (name !== null && typeof name !== "undefined" && name !== "") {
    name = String(name);
  }
  if (!name) {
    var item = proj.activeItem;
    if (item && item instanceof CompItem) return item;
    throw new Error("No active comp — open one or pass {comp: \"name\"}");
  }
  // The model batches its commands BEFORE seeing results, so when
  // create_comp auto-renamed ("X" existed -> made "X 2"), the rest of the
  // batch still says "X" — and would land in the OLD comp. Aliases are
  // scoped to the USER REQUEST, not a timer: the panel clears them when
  // the next chat message starts (AELL_newRequest), so they survive
  // arbitrarily slow batches and never leak into a later request.
  var aliases = $.global.AELL_compAliases;
  var wanted = (aliases && aliases[name]) ? aliases[name] : name;
  var i, it;
  for (i = 1; i <= proj.numItems; i++) {
    it = proj.item(i);
    if (it instanceof CompItem && it.name === wanted) return it;
  }
  if (wanted !== name) {
    // Aliased target gone (deleted/renamed) — fall back to the literal.
    for (i = 1; i <= proj.numItems; i++) {
      it = proj.item(i);
      if (it instanceof CompItem && it.name === name) return it;
    }
  }
  // Grounded: the user may have renamed comps since the chat referenced
  // them — list what actually exists so the retry uses a real name.
  var compNames = [];
  for (i = 1; i <= proj.numItems && compNames.length < 15; i++) {
    it = proj.item(i);
    if (it instanceof CompItem) compNames.push(it.name);
  }
  throw new Error("Comp not found: " + name + ". Comps in this project: " +
                  (compNames.join(", ") || "(none)"));
}

function AELL_resolveLayer(comp, ref) {
  if (ref === null || typeof ref === "undefined" || ref === "") {
    throw new Error("Missing 'layer' (name or 1-based index)");
  }
  var layer = null;
  try { layer = comp.layer(ref); } catch (e) { layer = null; }
  if (!layer) {
    // Ground the retry in reality: list what actually exists.
    var names = [];
    for (var i = 1; i <= comp.numLayers && i <= 20; i++) {
      var L = comp.layer(i);
      names.push(L.name + (L.selected ? " (SELECTED)" : ""));
    }
    throw new Error("Layer not found in '" + comp.name + "': " + ref +
      ". Actual layers: " + (names.join(", ") || "(none)") +
      ". For the user's selection, OMIT the 'layer' argument on tools " +
      "that support it.");
  }
  return layer;
}

/*
 * Resolve a layer arg that may be omitted to mean "the user's selection".
 * Exactly one selected layer is required when omitted.
 */
function AELL_layerOrSelection(comp, ref) {
  if (ref !== null && typeof ref !== "undefined" && ref !== "") {
    return AELL_resolveLayer(comp, ref);
  }
  var sel = comp.selectedLayers;
  if (sel.length === 1) return sel[0];
  if (sel.length === 0) {
    // A one-layer comp is unambiguous — use that layer.
    if (comp.numLayers === 1) return comp.layer(1);
    throw new Error("No layer selected in '" + comp.name + "' — select " +
                    "one in AE or pass {layer: name|index}");
  }
  var names = [];
  for (var i = 0; i < sel.length; i++) names.push(sel[i].name);
  throw new Error(sel.length + " layers selected (" + names.join(", ") +
                  ") — pass {layer: name} to pick one");
}

/*
 * Resolve a MULTI-layer target: explicit layers[], else a single layer,
 * else the whole selection (any count), else the comp's only layer.
 * Used by batch tools so ONE call can touch hundreds of layers.
 */
function AELL_layersOrSelection(comp, args) {
  var out = [];
  var i;
  if (AELLJSON.isArray(args.layers) && args.layers.length > 0) {
    for (i = 0; i < args.layers.length; i++) {
      out.push(AELL_resolveLayer(comp, args.layers[i]));
    }
    return out;
  }
  if (args.layer !== null && typeof args.layer !== "undefined" &&
      args.layer !== "") {
    out.push(AELL_resolveLayer(comp, args.layer));
    return out;
  }
  var sel = comp.selectedLayers;
  for (i = 0; i < sel.length; i++) out.push(sel[i]);
  if (out.length === 0 && comp.numLayers === 1) out.push(comp.layer(1));
  if (out.length === 0) {
    throw new Error("No target layers in '" + comp.name + "' — select " +
                    "layers in AE or pass {layer} / {layers: […]}");
  }
  // A selection that is ONLY control nulls is almost never the intended
  // animation target (the user was probably just inspecting sliders) —
  // refuse rather than silently keyframing the rig. Explicit layer args
  // above bypass this.
  var allNulls = true;
  for (i = 0; i < out.length; i++) {
    var isN = false;
    try { isN = !!out[i].nullLayer; } catch (eN) {}
    if (!isN) { allNulls = false; break; }
  }
  if (allNulls) {
    var nn = [];
    for (i = 0; i < out.length; i++) nn.push(out[i].name);
    throw new Error("Only control null(s) selected (" + nn.join(", ") +
      ") — pass {layers: [...]} with the CONTENT layers you mean, or " +
      "{layer: \"" + nn[0] + "\"} explicitly if the null really is the " +
      "target");
  }
  return out;
}

var AELL_TRANSFORM_MAP = {
  position:    "ADBE Position",
  scale:       "ADBE Scale",
  rotation:    "ADBE Rotate Z",
  opacity:     "ADBE Opacity",
  anchorPoint: "ADBE Anchor Point"
};

/* Resolve "position" | "scale" | ... | "effect.<Effect>.<Param>" */
function AELL_resolveProperty(layer, spec) {
  if (!spec) throw new Error("Missing 'property'");
  spec = String(spec);
  if (AELL_TRANSFORM_MAP[spec]) {
    var grp = layer.property("ADBE Transform Group");
    var p = grp ? grp.property(AELL_TRANSFORM_MAP[spec]) : null;
    if (!p) throw new Error("Transform property unavailable: " + spec);
    return p;
  }
  var parts = spec.split(".");
  if (parts.length >= 3 && parts[0] === "effect") {
    var effects = layer.property("ADBE Effect Parade");
    if (!effects) throw new Error("Layer has no effects group");
    // Effect display names can themselves contain dots ("Glow v2.5"), so
    // try the longest effect-name split first and work backwards.
    for (var cut = parts.length - 1; cut >= 2; cut--) {
      var effectName = parts.slice(1, cut).join(".");
      var fx = effects.property(effectName);
      if (fx) {
        var paramName = parts.slice(cut).join(".");
        var param = fx.property(paramName);
        if (!param) {
          throw new Error("Effect parameter not found: " + paramName +
                          " (on effect " + effectName + ")");
        }
        return param;
      }
    }
    throw new Error("Effect not found on layer: " + parts[1]);
  }
  throw new Error(
    "Unknown property '" + spec + "'. Use position/scale/rotation/opacity/" +
    "anchorPoint or effect.<EffectName>.<ParamName>");
}

function AELL_layerType(layer) {
  if (layer instanceof TextLayer) return "text";
  if (layer instanceof ShapeLayer) return "shape";
  if (layer instanceof CameraLayer) return "camera";
  if (layer instanceof LightLayer) return "light";
  if (layer instanceof AVLayer) {
    var src = layer.source;
    if (src instanceof CompItem) return "precomp";
    if (src && src.mainSource && src.mainSource instanceof SolidSource) {
      return "solid";
    }
    return "footage";
  }
  return "layer";
}

function AELL_effectNames(layer) {
  var names = [];
  var effects = null;
  try { effects = layer.property("ADBE Effect Parade"); } catch (e) {}
  if (effects) {
    for (var i = 1; i <= effects.numProperties; i++) {
      names.push(effects.property(i).name);
    }
  }
  return names;
}

// --------------------------------------------------------------------- tools

var AELL_TOOLS = {};

/*
 * Model-facing list caps.
 *
 * These two tools feed the panel's SYSTEM PROMPT, whose whole budget is
 * ~6 KB. Measured in AE 2026 on a 200-layer comp in a 206-item project:
 * get_project_info was 27 KB and get_comp_details 30 KB, so the combined
 * state was 49 KB and the panel's byte-slice kept only the head of the
 * project's item list — the model saw ZERO layers and never learned which
 * layer the user had SELECTED, in a prompt that tells it to look for
 * exactly that. An uncapped list did not degrade gracefully; it pushed the
 * comp out of the prompt entirely.
 *
 * So the lists are bounded HERE, where the omission can be described
 * honestly, instead of being cut mid-object downstream. limit: 0 (used by
 * panel-internal callers like the timeline visualizer) still returns
 * everything.
 */
var AELL_LIST_LIMIT = 40;

/* -1 = "no limit"; anything else is a positive row count. */
function AELL_listLimit(raw) {
  if (typeof raw === "undefined" || raw === null || raw === "") {
    return AELL_LIST_LIMIT;
  }
  if (raw === "all" || raw === 0 || raw === "0") return -1;
  var n = Math.round(Number(raw));
  if (!(n > 0)) return AELL_LIST_LIMIT;
  return n;
}

AELL_TOOLS.get_project_info = function (args) {
  var proj = app.project;
  if (!proj) return AELL_err("No project open");
  var engine = "";
  try { engine = String(proj.expressionEngine || ""); } catch (eE) {}
  var limit = AELL_listLimit(args.limit);
  var items = [];
  var footageDropped = 0;
  var namedDropped = 0;
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    var entry = { name: it.name, id: it.id };
    if (it.parentFolder && it.parentFolder !== proj.rootFolder) {
      entry.folder = it.parentFolder.name;
    }
    if (it instanceof FolderItem) {
      entry.path = AELL_folderPath(it);
    }
    if (it instanceof CompItem) {
      entry.type = "comp";
      entry.width = it.width;
      entry.height = it.height;
      entry.duration = it.duration;
      entry.frameRate = it.frameRate;
      entry.numLayers = it.numLayers;
    } else if (it instanceof FolderItem) {
      entry.type = "folder";
    } else {
      entry.type = "footage";
    }
    items.push(entry);
  }
  var active = null;
  if (proj.activeItem && proj.activeItem instanceof CompItem) {
    active = proj.activeItem.name;
  }

  // Clip to the cap. Comps and folders are what the model must be able to
  // NAME (every comp/folder argument is a name), so footage is dropped
  // first — a project full of solids must never hide the comps.
  var total = items.length;
  if (limit >= 0 && total > limit) {
    var kept = [];
    var j;
    // The ACTIVE comp goes in first, whatever else is competing for the
    // slots: it is the one name the model needs in every single request.
    for (j = 0; j < items.length; j++) {
      if (active !== null && items[j].type === "comp" &&
          items[j].name === active) { kept.push(items[j]); break; }
    }
    for (j = 0; j < items.length && kept.length < limit; j++) {
      if (items[j].type !== "footage" && items[j].name !== active) {
        kept.push(items[j]);
      }
    }
    for (j = 0; j < items.length && kept.length < limit; j++) {
      if (items[j].type === "footage") kept.push(items[j]);
    }
    // Back into project order, so indexes still read as a project panel.
    var order = {};
    for (j = 0; j < items.length; j++) order[items[j].id] = j;
    kept.sort(function (a, b) { return order[a.id] - order[b.id]; });
    for (j = 0; j < items.length; j++) {
      var still = false;
      for (var k = 0; k < kept.length; k++) {
        if (kept[k] === items[j]) { still = true; break; }
      }
      if (still) continue;
      if (items[j].type === "footage") footageDropped++;
      else namedDropped++;
    }
    items = kept;
  }

  var out = {
    projectFile: proj.file ? proj.file.fsName : null,
    expressionEngine: engine,
    numItems: proj.numItems,
    itemsShown: items.length,
    items: items,
    activeComp: active
  };
  if (footageDropped || namedDropped) {
    out.note = "Showing " + items.length + " of " + total + " items " +
      "(comps and folders first). " +
      (footageDropped ? footageDropped + " footage item" +
        (footageDropped === 1 ? "" : "s") : "") +
      (footageDropped && namedDropped ? " and " : "") +
      (namedDropped ? namedDropped + " comp/folder item" +
        (namedDropped === 1 ? "" : "s") : "") +
      " not listed — ask again with limit:0 for the whole project.";
  }
  return AELL_okay(out);
};

// -------------------------------------------------- project panel management

function AELL_findFolder(name) {
  var proj = app.project;
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (it instanceof FolderItem && it.name === String(name)) return it;
  }
  return null;
}

/*
 * Find any project item by id (number from get_project_info), by path
 * ("A/B" for a folder, "A/B/Item" for an item inside a folder — required
 * to disambiguate same-named items), or by bare name (first match).
 */
function AELL_findItem(ref) {
  var proj = app.project;
  var i, it;
  if (typeof ref === "number") {
    for (i = 1; i <= proj.numItems; i++) {
      it = proj.item(i);
      if (it.id === ref) return it;
    }
    return null;
  }
  var s = String(ref);
  if (s.indexOf("/") !== -1) {
    var asFolder = AELL_resolveFolderRef(s);
    if (asFolder) return asFolder;
    var cut = s.lastIndexOf("/");
    var parent = AELL_resolveFolderRef(s.substring(0, cut));
    var childName = s.substring(cut + 1);
    if (parent) {
      for (i = 1; i <= parent.numItems; i++) {
        it = parent.item(i);
        if (it.name === childName) return it;
      }
    }
    return null;
  }
  for (i = 1; i <= proj.numItems; i++) {
    it = proj.item(i);
    if (it.name === s) return it;
  }
  return null;
}

/* Full path of a folder from the project root, e.g. "_COMPS/Promo". */
function AELL_folderPath(folder) {
  var parts = [];
  var f = folder;
  var proj = app.project;
  while (f && f !== proj.rootFolder) {
    parts.unshift(f.name);
    f = f.parentFolder;
  }
  return parts.join("/");
}

/* Existing folder paths, for grounding failed-lookup errors. */
function AELL_listFolderPaths(cap) {
  var proj = app.project;
  var out = [];
  for (var i = 1; i <= proj.numItems && out.length < cap; i++) {
    var it = proj.item(i);
    if (it instanceof FolderItem) out.push(AELL_folderPath(it));
  }
  return out.length > 0 ? out.join(", ") : "(none yet)";
}

/* Ways the model plausibly says "the project root". */
function AELL_isRootRef(ref) {
  if (ref === null || typeof ref === "undefined") return true;
  var s = String(ref).toLowerCase();
  return s === "" || s === "root" || s === "(root)" || s === "/" ||
         s === "project" || s === "project root";
}

/*
 * Resolve a folder reference: numeric id, a path like "A/B" (walked from
 * the root, so same-named folders in different parents disambiguate), or a
 * bare name (first match anywhere).
 */
function AELL_resolveFolderRef(ref) {
  var proj = app.project;
  if (typeof ref === "number") {
    var byId = AELL_findItem(ref);
    return (byId && byId instanceof FolderItem) ? byId : null;
  }
  var s = String(ref);
  if (s.indexOf("/") !== -1) {
    var parts = s.split("/");
    var cur = proj.rootFolder;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "") continue;
      var next = null;
      for (var j = 1; j <= cur.numItems; j++) {
        var it = cur.item(j);
        if (it instanceof FolderItem && it.name === parts[i]) {
          next = it;
          break;
        }
      }
      if (!next) return null;
      cur = next;
    }
    return cur === proj.rootFolder ? null : cur;
  }
  return AELL_findFolder(s);
}

AELL_TOOLS.create_folder = function (args) {
  if (!args.name) return AELL_err("'name' is required");
  var proj = app.project;

  // Fan-out form: ONE call creates `name` inside EVERY direct subfolder
  // of the named folder. The host walks the real subfolders itself, so
  // the model cannot act from a trimmed project summary — measured in
  // the field (2026-08-26): asked for _ARCHIVE in each of 10 subfolders,
  // the model saw only the summary, hit 2 wrong-ish targets and claimed
  // the whole job done. This form makes that claim true by construction
  // or impossible to make.
  if (typeof args.eachChildOf !== "undefined" && args.eachChildOf !== null) {
    var box = AELL_isRootRef(args.eachChildOf)
      ? proj.rootFolder : AELL_resolveFolderRef(args.eachChildOf);
    if (!box) {
      return AELL_err("Folder not found: " + args.eachChildOf +
        ". Existing folders: " + AELL_listFolderPaths(20) +
        ". Use one of those (or a path/id), or 'root' for the project root.");
    }
    var kids = [];
    var c, kid;
    for (c = 1; c <= box.numItems; c++) {
      kid = box.item(c);
      if (kid instanceof FolderItem) kids.push(kid);
    }
    if (kids.length === 0) {
      var names = [];
      for (c = 1; c <= box.numItems && names.length < 10; c++) {
        names.push(box.item(c).name);
      }
      return AELL_err("'" + (AELL_folderPath(box) || box.name) +
        "' has no subfolders to create '" + String(args.name) +
        "' in. It holds: " +
        (names.length ? names.join(", ") : "(nothing)") +
        (box.numItems > 10 ? ", +" + (box.numItems - 10) + " more" : ""));
    }
    // "except for X": the exclusion is a PROMISE, so an except name that
    // matches no real subfolder refuses outright — silently creating in
    // a folder the user asked to spare (because the model guessed
    // "North" for "_North") would betray exactly the request the flag
    // exists to honor.
    var skipped = [];
    if (typeof args.except !== "undefined" && args.except !== null) {
      var exc = AELLJSON.isArray(args.except) ? args.except : [args.except];
      // A bare name and a full path are both reasonable spellings —
      // measured in the field (2026-08-26): the model wrote
      // "_COMPS/_ARCHIVE" where "_ARCHIVE" was wanted and burned a
      // correction round on it. Both match now; a spelling that matches
      // NEITHER still refuses, because guessing would betray exactly
      // the folder the user asked to spare.
      function excMatches(entry, k) {
        var s2 = String(entry);
        return k.name === s2 || AELL_folderPath(k) === s2;
      }
      var kidNames = [];
      for (c = 0; c < kids.length; c++) kidNames.push(kids[c].name);
      var misses = [];
      for (c = 0; c < exc.length; c++) {
        var found = false;
        for (var e2 = 0; e2 < kids.length; e2++) {
          if (excMatches(exc[c], kids[e2])) { found = true; break; }
        }
        if (!found) misses.push(String(exc[c]));
      }
      if (misses.length) {
        return AELL_err("'except' name(s) not among the subfolders of '" +
          (AELL_folderPath(box) || box.name) + "': " + misses.join(", ") +
          ". Its subfolders: " + kidNames.join(", ") +
          ". Fix the except list and re-call — nothing was created.");
      }
      var keep = [];
      for (c = 0; c < kids.length; c++) {
        var out = false;
        for (var e3 = 0; e3 < exc.length; e3++) {
          if (excMatches(exc[e3], kids[c])) { out = true; break; }
        }
        if (out) skipped.push(kids[c].name);
        else keep.push(kids[c]);
      }
      kids = keep;
      if (kids.length === 0) {
        return AELL_err("every subfolder of '" +
          (AELL_folderPath(box) || box.name) + "' is in the except " +
          "list (" + skipped.join(", ") + ") — nothing to create.");
      }
    }
    var made = [], had = [];
    for (c = 0; c < kids.length; c++) {
      var ch = kids[c];
      var hit = null;
      for (var m = 1; m <= ch.numItems; m++) {
        var g = ch.item(m);
        if (g instanceof FolderItem && g.name === String(args.name)) {
          hit = g;
          break;
        }
      }
      if (hit) {
        had.push(AELL_folderPath(hit));
        continue;
      }
      var nf = proj.items.addFolder(String(args.name));
      nf.parentFolder = ch;
      made.push(AELL_folderPath(nf));
    }
    // Whole paths are the receipts, but they must FIT the panel's
    // per-result cap — cap the lists, never the counts.
    var res = { name: String(args.name),
                parent: AELL_folderPath(box) || "(root)",
                subfolders: kids.length,
                createdCount: made.length,
                created: made.slice(0, 15) };
    if (made.length > 15) res.createdMore = made.length - 15;
    // The exclusion receipt rides BEFORE the existed list: the panel
    // caps each result's display, and the user's "did it skip _North?"
    // must survive the cut (measured: it was the field's first casualty).
    if (skipped.length) res.skippedAsExcepted = skipped;
    if (had.length) {
      res.alreadyExistedCount = had.length;
      res.alreadyExisted = had.slice(0, 15);
    }
    return AELL_okay(res);
  }

  var parent = proj.rootFolder;
  if (!AELL_isRootRef(args.parent)) {
    var p = AELL_resolveFolderRef(args.parent);
    if (!p) {
      return AELL_err("Parent folder not found: " + args.parent +
        ". Existing folders: " + AELL_listFolderPaths(20) +
        ". Use one of those (or a path/id), or 'root' for the project root.");
    }
    parent = p;
  }
  // Existence is checked INSIDE the target parent only — same-named
  // folders under different parents are normal AE practice.
  for (var i = 1; i <= parent.numItems; i++) {
    var it = parent.item(i);
    if (it instanceof FolderItem && it.name === String(args.name)) {
      return AELL_okay({ name: it.name, id: it.id,
                         path: AELL_folderPath(it),
                         note: "Folder already existed in this parent" });
    }
  }
  var folder = proj.items.addFolder(String(args.name));
  if (parent !== proj.rootFolder) folder.parentFolder = parent;
  return AELL_okay({ name: folder.name, id: folder.id,
                     path: AELL_folderPath(folder) });
};

AELL_TOOLS.move_to_folder = function (args) {
  if (!args.folder && args.folder !== 0) {
    return AELL_err("'folder' is required (a folder name, or 'root')");
  }
  var proj = app.project;
  var folder;
  if (AELL_isRootRef(args.folder)) {
    folder = proj.rootFolder;
  } else {
    folder = AELL_resolveFolderRef(args.folder);
  }
  if (!folder) {
    return AELL_err("Folder not found: " + args.folder +
                    ". Existing folders: " + AELL_listFolderPaths(20) +
                    ". Use one of those, or create_folder first.");
  }
  var refs = AELLJSON.isArray(args.items) ? args.items : [args.items];
  var moved = [];
  var missing = [];
  // Resolve everything BEFORE moving — reparenting reorders the project
  // item collection under the iteration otherwise.
  var found = [];
  var i;
  for (i = 0; i < refs.length; i++) {
    var it = AELL_findItem(refs[i]);
    if (!it) missing.push(refs[i]);
    else if (it !== folder) found.push(it);
  }
  for (i = 0; i < found.length; i++) {
    found[i].parentFolder = folder;
    moved.push(found[i].name);
  }
  var data = { folder: folder === proj.rootFolder ? "(root)" : folder.name,
               moved: moved };
  if (missing.length > 0) data.notFound = missing;
  if (moved.length === 0) {
    return AELL_err("Nothing was moved" +
      (missing.length ? " — items not found: " + missing.join(", ") : ""));
  }
  return AELL_okay(data);
};

AELL_TOOLS.rename_item = function (args) {
  if (typeof args.item === "undefined" || args.item === null ||
      args.item === "") {
    return AELL_err("'item' is required (name or id from get_project_info)");
  }
  if (!args.name) return AELL_err("'name' is required");
  var it = AELL_findItem(args.item);
  if (!it) return AELL_err("Project item not found: " + args.item);
  var old = it.name;
  it.name = String(args.name);
  return AELL_okay({ oldName: old, name: it.name });
};

// ------------------------------------------- comp rename audit + renamer
/*
 * Bringing a project's comp names onto a naming convention is a job the
 * panel could not do safely, because renaming a comp can BREAK it.
 *
 * Measured in AE 2026 before this was written (WORKPLAN-LOG 2026-08-25):
 *
 *  - AE does NOT rewrite comp("Old Name") strings when a comp is
 *    renamed. The expression breaks and AE DISABLES it.
 *  - The trap: after the break, prop.value still returns the same
 *    number. Only prop.expressionError reveals it. Anything checking
 *    values would report a clean rename over a broken project.
 *  - Renaming BACK re-resolves it, so the damage is recoverable — but
 *    only if somebody notices, which is the whole problem.
 *  - item.usedIn lists DIRECT parents only (not transitive), collapses
 *    a comp used twice in one parent to one entry, and still counts a
 *    DISABLED layer.
 *  - A comp used as a LAYER is an object reference: it survives a
 *    rename untouched. Only the string forms are at risk.
 *  - Cost: the expression walk is the expensive half — ~133 ms for 100
 *    layers, ~1.28 s for 1000, linear. usedIn over 1173 items: 3 ms.
 */

/* Every property carrying an expression, project-wide. One walk, reused
 * by both tools, because it is the part that costs. */
function AELL_walkExpressions(group, hits, compName, layerName) {
  for (var i = 1; i <= group.numProperties; i++) {
    var p = group.property(i);
    var expr = "";
    try { if (p.canSetExpression) expr = p.expression; } catch (eE) {}
    if (expr) {
      hits.push({ comp: compName, layer: layerName, property: p.name,
                  expression: String(expr) });
    }
    var deeper = 0;
    try { deeper = p.numProperties || 0; } catch (eG) {}
    if (deeper > 0) {
      try { AELL_walkExpressions(p, hits, compName, layerName); }
      catch (eR) {}
    }
  }
}

function AELL_expressionIndex() {
  var proj = app.project, hits = [], i, j;
  for (i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (!(it instanceof CompItem)) continue;
    for (j = 1; j <= it.numLayers; j++) {
      var L = it.layer(j);
      try { AELL_walkExpressions(L, hits, it.name, L.name); } catch (eL) {}
    }
  }
  return hits;
}

/* Which comps a single expression string names.
 *
 * Two kinds, and the difference matters to the human reading a preview:
 *   "comp()"  — comp("Name"), the form measured to break on rename.
 *   "quoted"  — the name appears as some other quoted string, e.g.
 *               var n = "Name"; comp(n). Also breaks, just less legibly.
 * Matching only QUOTED occurrences is what keeps a comp called "BG" from
 * matching the word "background" in an unrelated expression. */
function AELL_expressionNames(expr, name) {
  var out = null;
  var q = ['"', "'"];
  var i, needle, at;
  for (i = 0; i < q.length; i++) {
    needle = "comp(" + q[i] + name + q[i] + ")";
    if (String(expr).indexOf(needle) !== -1) return "comp()";
  }
  for (i = 0; i < q.length; i++) {
    needle = q[i] + name + q[i];
    at = String(expr).indexOf(needle);
    if (at !== -1) out = "quoted";
  }
  return out;
}

var AELL_RENAME_EXCERPT = 90;

/* Facts about every comp, with no judgment attached. */
AELL_TOOLS.audit_comp_usage = function (args) {
  var proj = app.project;
  if (!proj) return AELL_err("No project open");
  var only = "";
  if (typeof args.comp !== "undefined" && args.comp !== null &&
      args.comp !== "") {
    // Resolve through the same path every other tool uses: aliases are
    // honoured, and a bad name throws the grounded "comps in this
    // project are …" error rather than a silent empty list.
    only = AELL_resolveComp(args.comp).name;
  }
  var t0 = 0;
  try { t0 = $.hiresTimer; } catch (eT) {}

  var exprs = AELL_expressionIndex();

  // Render-queue membership, by identity — a queue item follows its comp
  // through a rename, so the name is never the thing to compare.
  var queued = [], qi;
  try {
    for (qi = 1; qi <= proj.renderQueue.numItems; qi++) {
      queued.push(proj.renderQueue.item(qi).comp);
    }
  } catch (eQ) {}
  function inQueue(c) {
    for (var k = 0; k < queued.length; k++) if (queued[k] === c) return true;
    return false;
  }

  var comps = [], i, j;
  for (i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (!(it instanceof CompItem)) continue;
    if (only && it.name !== only) continue;

    var uses = [];
    try {
      var u = it.usedIn;
      for (j = 0; j < u.length; j++) uses.push(u[j].name);
    } catch (eU) {}

    var refs = [], refCount = 0;
    for (j = 0; j < exprs.length; j++) {
      var kind = AELL_expressionNames(exprs[j].expression, it.name);
      if (!kind) continue;
      refCount++;
      if (refs.length < 5) {
        refs.push({ kind: kind, inComp: exprs[j].comp,
                    layer: exprs[j].layer, property: exprs[j].property,
                    excerpt: exprs[j].expression.slice(0,
                              AELL_RENAME_EXCERPT) });
      }
    }

    var rq = inQueue(it);
    comps.push({ name: it.name, id: it.id, numLayers: it.numLayers,
      usedIn: uses, usedInCount: uses.length, inRenderQueue: rq,
      expressionRefs: refs, expressionRefCount: refCount,
      // A comp that lives inside others and is never rendered on its own
      // LOOKS like a utility. That is a fact about its position, not a
      // verdict — the human decides.
      looksLikeUtility: (uses.length > 0 && !rq) });
  }

  var ms = 0;
  try { ms = Math.round($.hiresTimer / 1000); } catch (eT2) {}
  var out = { comps: comps, compsFound: comps.length,
    scanned: { expressionsFound: exprs.length, scanMs: ms } };
  if (!only && comps.length > AELL_LIST_LIMIT) {
    out.comps = comps.slice(0, AELL_LIST_LIMIT);
    out.note = "Showing " + AELL_LIST_LIMIT + " of " + comps.length +
      " comps. rename_comps sees them ALL — this cap is only on what is " +
      "printed back to you.";
  }
  return AELL_okay(out);
};

/* The owner-confirmed convention, applied deterministically.
 *
 * Year detection is CONSERVATIVE on purpose: 4-digit 19xx/20xx only, and
 * never when digits touch it on either side. "v26" is a version, and
 * "20190412" is a datestamp, not the year 2019 — neither becomes a
 * prefix. Returns {prefix} or {flag} for a name no rule can decide. */
function AELL_revPrefix(name) {
  var s = String(name);
  if (/^REV\d\d_/.test(s) || s.indexOf("REV_NO-YEAR_") === 0) {
    return { already: true };
  }
  var years = [], i, ch, before, after;
  for (i = 0; i + 4 <= s.length; i++) {
    var four = s.substring(i, i + 4);
    if (!/^(19|20)\d\d$/.test(four)) continue;
    before = i > 0 ? s.charAt(i - 1) : "";
    after = (i + 4) < s.length ? s.charAt(i + 4) : "";
    if (/[0-9]/.test(before) || /[0-9]/.test(after)) continue;
    var seen = false;
    for (var k = 0; k < years.length; k++) if (years[k] === four) seen = true;
    if (!seen) years.push(four);
  }
  if (years.length > 1) {
    return { flag: "Two different years in the name (" +
      years.join(", ") + ") — no guess made, rename this one by hand" };
  }
  if (years.length === 1) {
    return { prefix: "REV" + years[0].substring(2, 4) + "_" };
  }
  return { prefix: "REV_NO-YEAR_" };
}

AELL_TOOLS.rename_comps = function (args) {
  var proj = app.project;
  if (!proj) return AELL_err("No project open");
  var rule = String(args.rule || "rev-prefix");
  if (rule !== "rev-prefix" && rule !== "map") {
    return AELL_err("'rule' must be 'rev-prefix' (derive names from the " +
      "convention) or 'map' (you supply every new name in 'renames')");
  }
  var map = args.renames || null;
  if (rule === "map" && (!map || typeof map !== "object")) {
    return AELL_err("rule 'map' needs 'renames': {\"Old Name\": " +
                    "\"New Name\", ...}");
  }
  // dryRun DEFAULTS TO TRUE. Renaming is the one thing here that can
  // break a project, so it never happens without being asked for twice.
  var dryRun = (args.dryRun === false) ? false : true;
  var includeUtility = (args.includeUtility === true);

  var wanted = null, i, j;
  if (AELLJSON.isArray(args.comps) && args.comps.length) {
    wanted = {};
    for (i = 0; i < args.comps.length; i++) wanted[String(args.comps[i])] = true;
  }

  var audit = AELL_TOOLS.audit_comp_usage({});
  if (!audit.ok) return audit;
  // audit_comp_usage caps what it PRINTS; re-run the scan unbounded here.
  var exprs = AELL_expressionIndex();

  var all = [], taken = {};
  for (i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    taken[it.name] = true;
    if (it instanceof CompItem) all.push(it);
  }

  var plan = [], willRename = 0;
  for (i = 0; i < all.length; i++) {
    var c = all[i];
    if (wanted && !wanted[c.name]) continue;

    var row = { comp: c.name, newName: null, action: "skip", reason: "" };

    // 1. expression references — the HARD skip, measured to break.
    var refs = [], refKind = "";
    for (j = 0; j < exprs.length; j++) {
      var kind = AELL_expressionNames(exprs[j].expression, c.name);
      if (!kind) continue;
      if (!refKind) refKind = kind;
      if (refs.length < 3) {
        refs.push(exprs[j].comp + " / " + exprs[j].layer + " / " +
                  exprs[j].property);
      }
    }
    if (refs.length) {
      row.reason = "An expression names this comp as a string (" + refKind +
        ") in " + refs.join(", ") + ". AE does NOT rewrite those on " +
        "rename — the expression breaks and is disabled, and the layer's " +
        "value keeps reading normally, so nobody notices. Rename it by " +
        "hand and fix the expression in the same pass.";
      row.expressionRefs = refs;
      plan.push(row);
      continue;
    }

    // 2. what the convention says this comp should be called
    var newName;
    if (rule === "map") {
      if (!Object.prototype.hasOwnProperty.call(map, c.name)) continue;
      newName = String(map[c.name]);
      if (!newName) {
        row.reason = "Empty new name in 'renames'";
        plan.push(row);
        continue;
      }
    } else {
      var verdict = AELL_revPrefix(c.name);
      if (verdict.already) {
        row.reason = "Already carries the prefix — nothing to do";
        plan.push(row);
        continue;
      }
      if (verdict.flag) {
        row.reason = verdict.flag;
        plan.push(row);
        continue;
      }
      newName = verdict.prefix + c.name;
    }
    row.newName = newName;

    if (newName === c.name) {
      row.reason = "New name is the same as the old one";
      plan.push(row);
      continue;
    }

    // 3. utility comps: skipped by default, the human can say otherwise
    var uses = [];
    try {
      var u = c.usedIn;
      for (j = 0; j < u.length; j++) uses.push(u[j].name);
    } catch (eU2) {}
    var rq = false;
    try {
      for (j = 1; j <= proj.renderQueue.numItems; j++) {
        if (proj.renderQueue.item(j).comp === c) { rq = true; break; }
      }
    } catch (eQ2) {}
    if (uses.length && !rq && !includeUtility) {
      row.reason = "Looks like a utility comp — it is nested in " +
        uses.join(", ") + " and is not in the render queue. Skipped by " +
        "default; pass includeUtility:true to rename it anyway.";
      row.usedIn = uses;
      plan.push(row);
      continue;
    }

    // 4. name collisions
    if (taken[newName]) {
      row.reason = "A project item is already called '" + newName + "'";
      plan.push(row);
      continue;
    }

    row.action = "rename";
    row.reason = uses.length
      ? "Nested in " + uses.join(", ") + ", and renaming it is safe: a " +
        "comp used as a LAYER is an object reference, not a name."
      : "Not referenced by any expression";
    taken[newName] = true;
    willRename++;
    plan.push(row);
  }

  var out = { dryRun: dryRun, rule: rule, plan: plan,
    compsConsidered: plan.length, willRename: willRename,
    skipped: plan.length - willRename };

  if (dryRun) {
    out.note = "PREVIEW ONLY — nothing was renamed. Show this table to " +
      "the user and let them confirm, then call again with " +
      "dryRun:false to apply exactly this plan.";
    return AELL_okay(out);
  }

  var renamed = [], failed = [];
  for (i = 0; i < plan.length; i++) {
    if (plan[i].action !== "rename") continue;
    var target = null;
    for (j = 1; j <= proj.numItems; j++) {
      var cand = proj.item(j);
      if ((cand instanceof CompItem) && cand.name === plan[i].comp) {
        target = cand;
        break;
      }
    }
    if (!target) {
      failed.push(plan[i].comp + ": vanished between preview and apply");
      continue;
    }
    try {
      target.name = plan[i].newName;
      renamed.push(plan[i].comp + " -> " + plan[i].newName);
    } catch (eR2) {
      failed.push(plan[i].comp + ": " + eR2.message);
    }
  }
  out.renamed = renamed;
  out.renamedCount = renamed.length;
  if (failed.length) out.failed = failed;
  out.note = renamed.length + " comp(s) renamed in ONE undo group — a " +
    "single Ctrl+Z puts every one of them back.";
  return AELL_okay(out);
};

AELL_TOOLS.delete_item = function (args) {
  var it = AELL_findItem(args.item);
  if (!it) return AELL_err("Project item not found: " + args.item);
  var name = it.name;
  var note = "";
  if (it instanceof FolderItem && it.numItems > 0) {
    note = "Folder contained " + it.numItems +
           " item(s), removed with it (Ctrl+Z undoes)";
  }
  it.remove();
  var data = { removed: name };
  if (note) data.note = note;
  return AELL_okay(data);
};

/* Sources a duplicate SHARES with its original. AE copies the layers,
 * never what they point at, so a precomp/solid/footage item is the SAME
 * project item in both comps — editing "the copy" edits the original.
 * Precomps and solids lead the list because the panel has tools that
 * change exactly those (set_solid_color, anything inside a precomp). */
function AELL_dupSharedSources(dup, src) {
  var mine = {}, i, j, out = [];
  for (i = 1; i <= src.numLayers; i++) {
    var s = null;
    try { s = src.layer(i).source; } catch (eS) {}
    if (s) mine["id" + s.id] = true;
  }
  var seen = {};
  for (j = 1; j <= dup.numLayers; j++) {
    var d = null;
    try { d = dup.layer(j).source; } catch (eD) {}
    if (!d || !mine["id" + d.id] || seen["id" + d.id]) continue;
    seen["id" + d.id] = true;
    var kind = (d instanceof CompItem) ? "precomp" : "footage";
    if (!(d instanceof CompItem)) {
      var ms = null;
      try { ms = d.mainSource; } catch (eM) {}
      if (ms instanceof SolidSource) kind = "solid";
    }
    out.push(d.name + " (" + kind + ")");
  }
  return out;
}

/*
 * duplicate_comp. AE does the copying itself and does it well: measured
 * in AE 2026 (probe 2026-08-29, see WORKPLAN-LOG) the copy is named
 * "<name> 2" by AE, lands in the SOURCE'S OWN FOLDER directly after it,
 * carries every comp setting (bgColor, resolution, work area, motion
 * blur, comment, markers), keeps relative expressions and parenting
 * pointing INSIDE the copy, and leaves the project-panel selection
 * alone — so there is nothing to fix there and no selection to restore.
 *
 * What it does SILENTLY, and what this tool says out loud instead:
 *  - A requested `name` that another project item already holds is
 *    ACCEPTED. A by-name walk then finds the OLDER item (measured), so
 *    the copy would be unreachable by the very name the model just
 *    asked for. Auto-numbered and redirected exactly as create_comp and
 *    precompose do.
 *  - An EMPTY name is accepted too and leaves a comp with no name at
 *    all. Refused.
 *  - Layer SOURCES are shared, not copied (AELL_dupSharedSources).
 *  - AE rewrites nothing: an absolute comp("Source") reference in the
 *    copy still drives off the SOURCE comp, and expressionError stays
 *    EMPTY, so nothing else would ever mention it.
 */
AELL_TOOLS.duplicate_comp = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var srcName = comp.name;
  var wanted = null;
  if (typeof args.name !== "undefined" && args.name !== null) {
    wanted = String(args.name);
    if (/^\s*$/.test(wanted)) {
      return AELL_err("'name' was blank. AE accepts a blank comp name and " +
        "the copy then has none, which nothing can look up. Leave 'name' " +
        "out to take AE's own '" + srcName + " 2', or pass a real name.");
    }
  }
  var dup = comp.duplicate();
  if (wanted) {
    var unique = AELL_uniqueItemName(wanted, dup);
    dup.name = unique;
    if (!$.global.AELL_compAliases) $.global.AELL_compAliases = {};
    if (unique !== wanted) {
      // Redirect this request's later commands at the comp that exists
      // (see AELL_resolveComp) — the batch was written before this ran.
      // NOT when the name asked for is the SOURCE'S OWN: "duplicate Main
      // and call it Main" still leaves "Main" meaning the original, and
      // an alias there would silently point the rest of the request at
      // the copy instead.
      if (wanted !== srcName) $.global.AELL_compAliases[wanted] = unique;
    } else {
      delete $.global.AELL_compAliases[wanted];
    }
  }
  var out = { name: dup.name, id: dup.id, duplicatedFrom: srcName,
              folder: dup.parentFolder.name };
  if (wanted && dup.name !== wanted) {
    out.nameTaken = "'" + wanted + "' was already another project item's " +
      "name — a second one is unreachable by name, so the copy is '" +
      dup.name + "'. Use THIS name in every following command" +
      (wanted === srcName
        ? "; '" + srcName + "' still means the comp it was copied FROM."
        : ".");
  }
  var shared = AELL_dupSharedSources(dup, comp);
  if (shared.length) {
    AELL_hygCap(shared, out, "sharedSources");
    out.sharedNote = "AE copied the LAYERS, not what they point at: " +
      "these items are the same in both comps, so changing one there " +
      "changes '" + srcName + "' too.";
  }
  // Expressions in the copy that name the SOURCE comp as a string: AE
  // leaves them driving the original and flags nothing.
  var hits = [], k;
  for (k = 1; k <= dup.numLayers; k++) {
    try { AELL_walkExpressions(dup.layer(k), hits, dup.name, dup.layer(k).name); }
    catch (eW) {}
  }
  var back = [];
  for (k = 0; k < hits.length; k++) {
    if (AELL_expressionNames(hits[k].expression, srcName)) {
      back.push(hits[k].layer + " > " + hits[k].property);
    }
  }
  if (back.length) {
    AELL_hygCap(back, out, "stillDrivenBySource");
    out.expressionNote = "These expressions in the copy name '" + srcName +
      "' as a string, so they still read the ORIGINAL comp. AE does not " +
      "rewrite them and expressionError stays empty. Point them at " +
      "thisComp (or at '" + dup.name + "') if the copy should stand alone.";
  }
  return AELL_okay(out);
};

// ------------------------------------------------ organize_project
//
// Filing the project panel is a project-WIDE move, so it takes
// clean_project's shape: dryRun DEFAULTS TO TRUE and the preview NAMES
// each move (item -> folder) instead of counting it. The list helpers it
// borrows (AELL_hygLabel/Kind/Cap) live in the hygiene section below.
//
// Measured in AE 2026 (26.3x87), probe 2026-08-28:
//  - a comp created by script lands at the ROOT, so every new comp is
//    "loose" until this runs;
//  - AE parks a solid's SOURCE in its own "Solids" folder the moment the
//    solid is created, so solids are almost never loose and a Solids
//    count of 0 is the normal answer, not a miss;
//  - a SolidSource reports isStill TRUE, so the solid test must come
//    first or every solid files as an image;
//  - a still is hasVideo/isStill true, an audio-only file is hasAudio
//    true + hasVideo false, a movie is both with isStill false;
//  - and the bug this pass found: looking the destination up by name
//    ANYWHERE in the tree filed two root comps into "PR Archive/Comps",
//    a folder the user had made for something else. Destinations are
//    now looked for at the ROOT only, and a same-named folder deeper in
//    the tree is NAMED in the result rather than silently used.

var AELL_ORG_DESTS = ["Comps", "Solids", "Audio", "Images", "Footage"];

function AELL_orgDest(it) {
  if (it instanceof CompItem) return "Comps";
  if (it instanceof FootageItem) {
    var src = null;
    try { src = it.mainSource; } catch (eS) {}
    if (src instanceof SolidSource) return "Solids";     // isStill lies here
    if (it.hasAudio && !it.hasVideo) return "Audio";
    if (src && src.isStill) return "Images";
    return "Footage";
  }
  return null;
}

/* The destination folder AT THE ROOT. A folder of the same name nested
 * somewhere else is somebody else's filing, not ours. */
function AELL_orgRootFolder(name) {
  var proj = app.project;
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (it instanceof FolderItem && it.name === String(name) &&
        it.parentFolder === proj.rootFolder) return it;
  }
  return null;
}

/* Same name, deeper in the tree: reported so the user knows why a second
 * folder of that name is about to appear at the root. */
function AELL_orgHomonyms(name) {
  var proj = app.project, out = [];
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (it instanceof FolderItem && it.name === String(name) &&
        it.parentFolder !== proj.rootFolder) out.push(AELL_folderPath(it));
  }
  return out;
}

AELL_TOOLS.organize_project = function (args) {
  var proj = app.project;
  if (!proj) return AELL_err("No project open");
  args = args || {};
  var dryRun = (args.dryRun === false) ? false : true;

  // Collect first: reparenting reorders proj.item() indices mid-loop.
  var i, it, dest;
  var plan = [], moves = [], skipped = [], counts = {};
  var alreadyFiled = 0, rootFolders = 0;
  for (i = 1; i <= proj.numItems; i++) {
    it = proj.item(i);
    if (it instanceof FolderItem) {
      if (it.parentFolder === proj.rootFolder) rootFolders++;
      continue;                                  // folders are never moved
    }
    if (it.parentFolder !== proj.rootFolder) {   // respect existing org
      alreadyFiled++;
      continue;
    }
    dest = AELL_orgDest(it);
    if (!dest) {
      skipped.push(AELL_hygLabel(it) + " (nothing files a " +
                   AELL_hygKind(it) + ")");
      continue;
    }
    plan.push({ item: it, dest: dest });
    moves.push(it.name + " -> " + dest);
    counts[dest] = (counts[dest] || 0) + 1;
  }

  var out = { dryRun: dryRun, willMove: plan.length };
  var toCreate = [], elsewhere = [], d, h, nested;
  for (d = 0; d < AELL_ORG_DESTS.length; d++) {
    if (!counts[AELL_ORG_DESTS[d]]) continue;
    if (!AELL_orgRootFolder(AELL_ORG_DESTS[d])) toCreate.push(AELL_ORG_DESTS[d]);
    nested = AELL_orgHomonyms(AELL_ORG_DESTS[d]);
    for (h = 0; h < nested.length; h++) elsewhere.push(nested[h]);
  }

  out.byFolder = counts;
  out.alreadyFiled = alreadyFiled;
  out.rootFolders = rootFolders;
  if (skipped.length) AELL_hygCap(skipped, out, "skipped");
  if (dryRun) {
    AELL_hygCap(moves, out, "moves");
    if (toCreate.length) {
      out.foldersToCreate = toCreate;
      out.foldersNote = "These folders do not exist at the project root " +
        "yet and would be created there.";
    }
  }
  if (elsewhere.length) {
    AELL_hygCap(elsewhere, out, "sameNameElsewhere");
    out.sameNameNote = "A folder with that name already exists deeper in " +
      "the project. It is NOT used (filing root items into someone's " +
      "nested folder is not organizing), so the project would end up " +
      "with two folders of that name — say so before running this.";
  }

  if (dryRun) {
    out.note = plan.length === 0
      ? "PREVIEW ONLY — nothing to do: no loose items at the project root."
      : "PREVIEW ONLY — nothing was moved. Show the user the moves above " +
        "(and any folder that would be created), then call again with " +
        "dryRun:false to do it.";
    return AELL_okay(out);
  }

  var created = [], done = [], notMoved = [], cache = {}, folder;
  for (i = 0; i < plan.length; i++) {
    dest = plan[i].dest;
    if (cache[dest]) {
      folder = cache[dest];
    } else {
      folder = AELL_orgRootFolder(dest);
      if (!folder) { folder = proj.items.addFolder(dest); created.push(dest); }
      cache[dest] = folder;
    }
    try { plan[i].item.parentFolder = folder; } catch (eM) {}
    // Verify rather than assume: the promise above was made before AE
    // was asked, the same way clean_project diffs its own preview.
    if (plan[i].item.parentFolder === folder) {
      done.push(plan[i].item.name + " -> " + dest);
    } else {
      notMoved.push(plan[i].item.name + " (still in " +
        (plan[i].item.parentFolder === proj.rootFolder ? "the project root" :
         AELL_folderPath(plan[i].item.parentFolder)) + ")");
    }
  }

  out.moved = done.length;
  AELL_hygCap(done, out, "moves");
  out.byFolder = counts;
  if (created.length) out.foldersCreated = created;
  if (notMoved.length) AELL_hygCap(notMoved, out, "notMoved");
  out.note = done.length + " item(s) filed in ONE undo group — a single " +
    "Ctrl+Z puts them back where they were. Folders already in the " +
    "project were left exactly as they are.";
  return AELL_okay(out);
};

// ------------------------------------------------- project hygiene (5.6)
//
// AE's three cleanup calls all delete, all report only a NUMBER, and two
// of them take things nobody asked about. Measured in AE 2026 (26.3x87),
// each fact below cost a probe:
//
//  - removeUnusedFootage() also deletes EMPTY FOLDERS, recursively, and
//    counts them in its return value. A project with three empty folders
//    and no footage answers "3".
//  - it KEEPS footage that is used only by a comp that is itself unused.
//  - consolidateFootage() merges footage items pointing at the same file
//    and repoints the layers using them; nothing in a comp changes.
//  - reduceProject(comps) deletes every item not reachable from the comps
//    you name -- including a comp that is referenced ONLY by an
//    expression, whose expressionError stays EMPTY afterwards, and
//    including render-queue items for the comps it removes.
//  - reduceProject accepts a FOOTAGE item in the keep array and then
//    deletes every comp in the project. It is refused here.
//  - reduceProject([]) throws "Array is empty"; with no argument at all
//    it throws "requires 1 parameter".
//  - all three are ordinary undoable edits: one Ctrl+Z put a 10-item
//    project back after a reduceProject, and the next undo group opened
//    and closed cleanly (unlike render_comp, which cannot be grouped).
//
// So the tool previews FIRST (dryRun defaults to true), names what would
// go rather than counting it, and on execute compares what AE actually
// removed against what the preview promised.

var AELL_HYG_LIST = 40;

var AELL_HYG_ACTIONS = [
  "remove_unused_footage — deletes footage no comp uses, plus every " +
    "folder that ends up empty",
  "consolidate_footage — merges footage items that point at the same " +
    "file, repointing the layers that use them",
  "reduce_project — deletes EVERYTHING not needed by the comps you name " +
    "in keepComps (comps, footage, folders and their render-queue items)"
];

function AELL_hygKind(it) {
  if (it instanceof CompItem) return "comp";
  if (it instanceof FolderItem) return "folder";
  return "footage";
}

/* "Solids/red" — enough for a human to find the item in the panel. */
function AELL_hygLabel(it) {
  var path = "";
  try {
    if (it.parentFolder && it.parentFolder !== app.project.rootFolder) {
      path = AELL_folderPath(it.parentFolder) + "/";
    }
  } catch (eP) {}
  return path + it.name;
}

/* Every item alive right now, keyed by id, so an execute can diff. */
function AELL_hygSnapshot() {
  var proj = app.project, map = {};
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    map[it.id] = { label: AELL_hygLabel(it), kind: AELL_hygKind(it) };
  }
  return map;
}

/* Cap a name list the way the rest of the panel does: head, plus a count
 * of what is not shown. Never a silent truncation. */
function AELL_hygCap(list, out, key) {
  if (list.length <= AELL_HYG_LIST) { out[key] = list; return; }
  out[key] = list.slice(0, AELL_HYG_LIST);
  out[key + "NotShown"] = list.length - AELL_HYG_LIST;
}

/* Grow a doomed set by every folder whose whole content is doomed --
 * iterated, because emptying a child empties its parent (measured: an
 * empty folder inside an empty folder took both). */
function AELL_hygSweepFolders(doomed) {
  var proj = app.project, changed = true, folders = [];
  var i, j;
  for (i = 1; i <= proj.numItems; i++) {
    if (proj.item(i) instanceof FolderItem) folders.push(proj.item(i));
  }
  while (changed) {
    changed = false;
    for (i = 0; i < folders.length; i++) {
      var f = folders[i];
      if (doomed[f.id]) continue;
      var allGone = true;
      for (j = 1; j <= f.numItems; j++) {
        if (!doomed[f.item(j).id]) { allGone = false; break; }
      }
      if (allGone) { doomed[f.id] = true; changed = true; }
    }
  }
  return doomed;
}

/* What removeUnusedFootage() would take. */
function AELL_hygUnusedPlan() {
  var proj = app.project, doomed = {}, i;
  for (i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (!(it instanceof FootageItem)) continue;
    var used = 1;
    try { used = it.usedIn.length; } catch (eU) { used = 1; }
    if (used === 0) doomed[it.id] = true;
  }
  return AELL_hygSweepFolders(doomed);
}

/* What consolidateFootage() would merge: footage items sharing a file
 * path. AE keeps one per group; the rest go. */
function AELL_hygDuplicatePlan() {
  var proj = app.project, byFile = {}, order = [], i;
  for (i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (!(it instanceof FootageItem)) continue;
    var f = null;
    try { f = it.mainSource.file; } catch (eF) {}
    if (!f) continue;                       // solids and placeholders
    var key = String(f.fsName);
    if (!byFile[key]) { byFile[key] = []; order.push(key); }
    byFile[key].push(it);
  }
  var doomed = {}, groups = [];
  for (i = 0; i < order.length; i++) {
    var g = byFile[order[i]];
    if (g.length < 2) continue;
    var labels = [];
    for (var j = 0; j < g.length; j++) {
      labels.push(AELL_hygLabel(g[j]));
      if (j > 0) doomed[g[j].id] = true;    // AE keeps one of them
    }
    groups.push({ file: order[i], copies: g.length, items: labels });
  }
  return { doomed: doomed, groups: groups };
}

/* What reduceProject(keep) would leave alone: the comps named, whatever
 * their layers pull in (transitively), and the folders those live in.
 * Verified against AE on a two-level nesting rig. */
function AELL_hygReducePlan(keepComps) {
  var proj = app.project, keep = {}, stack = [], i, j;
  for (i = 0; i < keepComps.length; i++) stack.push(keepComps[i]);
  while (stack.length) {
    var it = stack.pop();
    if (!it || keep[it.id]) continue;
    keep[it.id] = true;
    if (it instanceof CompItem) {
      for (j = 1; j <= it.numLayers; j++) {
        var src = null;
        try { src = it.layer(j).source; } catch (eS) {}
        if (src && !keep[src.id]) stack.push(src);
      }
    }
  }
  // Folders survive when something inside them survives.
  var kept = [];
  for (i = 1; i <= proj.numItems; i++) {
    if (keep[proj.item(i).id]) kept.push(proj.item(i));
  }
  for (i = 0; i < kept.length; i++) {
    var f = kept[i].parentFolder;
    while (f && f !== proj.rootFolder) { keep[f.id] = true; f = f.parentFolder; }
  }
  var doomed = {};
  for (i = 1; i <= proj.numItems; i++) {
    var item = proj.item(i);
    if (!keep[item.id]) doomed[item.id] = true;
  }
  return doomed;
}

/* Render-queue items pointing at a comp that is about to go. AE drops
 * them with no dialog and no mention (measured), so they are named. */
function AELL_hygQueueLosses(doomed) {
  var lost = [];
  try {
    var rq = app.project.renderQueue;
    for (var i = 1; i <= rq.numItems; i++) {
      var c = null;
      try { c = rq.item(i).comp; } catch (eC) { continue; }
      if (c && doomed[c.id]) lost.push(c.name);
    }
  } catch (eQ) {}
  return lost;
}

/* Doomed comps whose NAME appears in an expression that SURVIVES. AE
 * leaves such an expression in place with an EMPTY expressionError -- the
 * silent break this project refuses to ship. */
function AELL_hygExpressionRefs(doomed) {
  var proj = app.project, warn = [], i, j;
  var names = [];
  for (i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (doomed[it.id] && (it instanceof CompItem)) names.push(it);
  }
  if (!names.length) return warn;
  var exprs = AELL_expressionIndex();
  for (i = 0; i < names.length; i++) {
    for (j = 0; j < exprs.length; j++) {
      var host = exprs[j];
      var kind = AELL_expressionNames(host.expression, names[i].name);
      if (!kind) continue;
      warn.push(names[i].name + " is named (" + kind + ") by an " +
        "expression on " + host.comp + " / " + host.layer + " / " +
        host.property);
      break;
    }
  }
  return warn;
}

function AELL_hygNames(doomed, kinds) {
  var proj = app.project, out = [];
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (!doomed[it.id]) continue;
    if (kinds && !kinds[AELL_hygKind(it)]) continue;
    out.push(AELL_hygLabel(it));
  }
  return out;
}

/*
 * clean_project {action, keepComps?, dryRun?}
 *
 * dryRun DEFAULTS TO TRUE: every action here deletes project items, and
 * two of them take things the user never mentioned (empty folders,
 * render-queue entries), so nothing happens until it has been shown once.
 */
AELL_TOOLS.clean_project = function (args) {
  var proj = app.project;
  if (!proj) return AELL_err("No project open");
  args = args || {};

  var raw = String(args.action || "").toLowerCase();
  raw = raw.replace(/[\s\-]+/g, "_");
  var alias = {
    remove_unused_footage: "remove_unused_footage",
    removeunusedfootage: "remove_unused_footage",
    remove_unused: "remove_unused_footage",
    unused: "remove_unused_footage",
    unused_footage: "remove_unused_footage",
    consolidate_footage: "consolidate_footage",
    consolidatefootage: "consolidate_footage",
    consolidate: "consolidate_footage",
    duplicates: "consolidate_footage",
    reduce_project: "reduce_project",
    reduceproject: "reduce_project",
    reduce: "reduce_project"
  };
  var action = alias[raw] || "";
  if (!action) {
    return AELL_err((raw ? "Unknown action '" + args.action + "'. " :
      "clean_project needs an 'action'. ") +
      "Pick exactly one, and say which one you are about to run before " +
      "you run it: " + AELL_HYG_ACTIONS.join(" | "));
  }

  var dryRun = (args.dryRun === false) ? false : true;
  var doomed = {}, out = { action: action, dryRun: dryRun }, i;
  var dupPlan = null, keepComps = [];

  if (action === "reduce_project") {
    var want = args.keepComps;
    if (!AELLJSON.isArray(want)) {
      if (typeof want === "string" && want) want = [want];
      else if (AELLJSON.isArray(args.comps)) want = args.comps;
      else if (typeof args.comp === "string" && args.comp) want = [args.comp];
      else want = null;
    }
    if (!want || !want.length) {
      var have = [], shown = 0;
      for (i = 1; i <= proj.numItems && shown < 20; i++) {
        if (proj.item(i) instanceof CompItem) { have.push(proj.item(i).name); shown++; }
      }
      return AELL_err("reduce_project deletes every comp, footage item " +
        "and folder that the comps you keep do not need, so it will not " +
        "guess which ones matter. Name them in keepComps. Comps in this " +
        "project: " + (have.join(", ") || "(none)"));
    }
    for (i = 0; i < want.length; i++) {
      var nm = String(want[i]);
      var found = null;
      try { found = AELL_resolveComp(nm); }
      catch (eC) {
        var other = AELL_findItem(nm);
        if (other) {
          return AELL_err("'" + nm + "' is a " + AELL_hygKind(other) +
            ", not a comp. AE accepts a non-comp here and then deletes " +
            "EVERY comp in the project, so it is refused. Name comps only.");
        }
        return AELL_err(eC.message ? eC.message : String(eC));
      }
      keepComps.push(found);
    }
    doomed = AELL_hygReducePlan(keepComps);
    var keepNames = [];
    for (i = 0; i < keepComps.length; i++) keepNames.push(keepComps[i].name);
    out.keepComps = keepNames;
  } else if (action === "remove_unused_footage") {
    doomed = AELL_hygUnusedPlan();
  } else {
    dupPlan = AELL_hygDuplicatePlan();
    doomed = dupPlan.doomed;
    if (dupPlan.groups.length) AELL_hygCap(dupPlan.groups, out, "duplicateGroups");
  }

  var doomedList = AELL_hygNames(doomed, null);
  var folders = AELL_hygNames(doomed, { folder: true });
  var comps = AELL_hygNames(doomed, { comp: true });
  out.willRemove = doomedList.length;
  AELL_hygCap(doomedList, out, "items");
  if (folders.length) {
    out.foldersIncluded = folders.length;
    out.foldersNote = "Folders left empty by this go too, and AE counts " +
      "them in its own total: " + folders.slice(0, 10).join(", ") +
      (folders.length > 10 ? ", ..." : "");
  }
  if (comps.length) out.compsRemoved = comps.length;

  var queueLoss = AELL_hygQueueLosses(doomed);
  if (queueLoss.length) {
    out.renderQueueLost = queueLoss;
    out.renderQueueNote = "Their render-queue items disappear with them, " +
      "with no dialog and no warning from AE.";
  }
  var exprWarn = AELL_hygExpressionRefs(doomed);
  if (exprWarn.length) {
    AELL_hygCap(exprWarn, out, "expressionBreaks");
    out.expressionNote = "AE does NOT report these: the expression stays " +
      "on the layer and expressionError reads empty, so the break is " +
      "silent. Fix or keep those comps first.";
  }

  if (dryRun) {
    out.note = out.willRemove === 0
      ? "PREVIEW ONLY — nothing to do: this action would remove nothing."
      : "PREVIEW ONLY — nothing was deleted. Show the user what would go " +
        "(especially anything above they did not ask about), then call " +
        "again with dryRun:false to do it.";
    return AELL_okay(out);
  }

  var before = AELL_hygSnapshot();
  var removed = 0;
  try {
    if (action === "remove_unused_footage") removed = proj.removeUnusedFootage();
    else if (action === "consolidate_footage") removed = proj.consolidateFootage();
    else removed = proj.reduceProject(keepComps);
  } catch (eX) {
    return AELL_err("AE refused " + action + ": " +
                    (eX.message ? eX.message : String(eX)));
  }

  // What AE ACTUALLY took, by id, versus what the preview promised. A
  // difference is not an error -- it is the part worth reporting.
  var after = AELL_hygSnapshot(), gone = [], id;
  for (id in before) {
    if (!before.hasOwnProperty(id)) continue;
    if (!after[id]) gone.push({ id: id, label: before[id].label });
  }
  var unexpected = [], survived = [];
  for (i = 0; i < gone.length; i++) {
    if (!doomed[gone[i].id]) unexpected.push(gone[i].label);
  }
  for (id in before) {
    if (!before.hasOwnProperty(id)) continue;
    if (doomed[id] && after[id]) survived.push(before[id].label);
  }
  var goneLabels = [];
  for (i = 0; i < gone.length; i++) goneLabels.push(gone[i].label);

  out.removedCount = removed;
  out.itemsRemoved = gone.length;
  AELL_hygCap(goneLabels, out, "removed");
  if (unexpected.length) AELL_hygCap(unexpected, out, "removedUnexpectedly");
  if (survived.length) AELL_hygCap(survived, out, "predictedButKept");
  out.itemsLeft = proj.numItems;
  out.note = gone.length + " item(s) deleted in ONE undo group — a single " +
    "Ctrl+Z puts them all back (verified in AE).";
  return AELL_okay(out);
};

AELL_TOOLS.get_comp_details = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var total = comp.numLayers;
  var limit = AELL_listLimit(args.limit);
  var start = args.start > 0 ? Math.round(args.start) : 1;
  if (start > total) start = total > 0 ? total : 1;
  var last = limit < 0 ? total : Math.min(total, start + limit - 1);

  // Two passes so the SELECTED layers always survive the cap even when
  // they sit outside the window: the system prompt tells the model to read
  // `selected: true` to resolve "these layers", so a cap that hides the
  // selection is worse than no answer at all.
  var i, layer, sel;
  var wanted = {};      // index -> true
  var kept = 0;
  var selectedTotal = 0;
  for (i = 1; i <= total; i++) {
    sel = false;
    try { sel = !!comp.layer(i).selected; } catch (eS) {}
    if (!sel) continue;
    selectedTotal++;
    if (limit < 0 || kept < limit) { wanted[i] = true; kept++; }
  }
  for (i = start; i <= last; i++) {
    if (wanted[i]) continue;
    if (limit >= 0 && kept >= limit) break;
    wanted[i] = true;
    kept++;
  }

  var layers = [];
  var selectedOutside = 0;
  for (i = 1; i <= total; i++) {
    if (!wanted[i]) continue;
    layer = comp.layer(i);
    var entry = {
      index: i,
      name: layer.name,
      type: AELL_layerType(layer),
      enabled: layer.enabled,
      inPoint: layer.inPoint,
      outPoint: layer.outPoint,
      startTime: layer.startTime,
      effects: AELL_effectNames(layer)
    };
    if (layer.selected) {
      entry.selected = true;
      if (i < start || i > last) selectedOutside++;
    }
    layers.push(entry);
  }

  var out = {
    name: comp.name,
    width: comp.width,
    height: comp.height,
    duration: comp.duration,
    frameRate: comp.frameRate,
    // A setting set_comp_setting can WRITE has to be readable, or the
    // model cannot tell a narrowed work area from a short comp — and AE
    // only renders, previews and converts audio inside the work area.
    workArea: AELL_secs(comp.workAreaStart) + "-" +
              AELL_secs(Number(comp.workAreaStart) +
                        Number(comp.workAreaDuration)),
    resolution: AELL_resolutionLabel(comp.resolutionFactor),
    numLayers: total,
    layersShown: layers.length,
    layers: layers
  };
  if (layers.length < total) {
    var next = last + 1;
    out.note = "Showing " + layers.length + " of " + total +
      " layers (indexes " + start + "-" + last + ")" +
      (selectedOutside ? ", plus " + selectedOutside +
        " selected layer" + (selectedOutside === 1 ? "" : "s") +
        " from outside that range" : "") + ". " +
      (selectedTotal ? selectedTotal + " layer" +
        (selectedTotal === 1 ? " is" : "s are") + " selected. " : "") +
      (next <= total
        ? "Ask again with start:" + next + " for the next " +
          (limit < 0 ? "layers" : "" + limit) + ", or limit:0 for all."
        : "Ask again with limit:0 for all.");
  }
  return AELL_okay(out);
};

/* First free project-item name — duplicate comp names make every later
 * name-based comp reference ambiguous (it silently hits the OLDEST one).
 * `except` is an item allowed to keep the name it already has: renaming
 * an item to its own current name must be a no-op, not a bump to " 2". */
function AELL_uniqueItemName(base, except) {
  var taken = {};
  for (var i = 1; i <= app.project.numItems; i++) {
    try {
      var it = app.project.item(i);
      if (except && it === except) continue;
      taken[it.name] = true;
    } catch (e) {}
  }
  if (!taken[base]) return base;
  var k = 2;
  while (taken[base + " " + k]) k++;
  return base + " " + k;
}

AELL_TOOLS.create_comp = function (args) {
  if (!args.name) return AELL_err("'name' is required");
  var w = Math.max(4, Math.min(30000, Math.round(args.width || 1920)));
  var h = Math.max(4, Math.min(30000, Math.round(args.height || 1080)));
  var dur = args.duration > 0 ? args.duration : 10;
  var fps = args.frameRate > 0 ? args.frameRate : 30;
  var name = AELL_uniqueItemName(String(args.name));
  if (!$.global.AELL_compAliases) $.global.AELL_compAliases = {};
  if (name !== String(args.name)) {
    // Redirect this request's same-name references to the renamed comp
    // (see AELL_resolveComp). One entry per requested name — several
    // comps created in one batch each get their own redirect.
    $.global.AELL_compAliases[String(args.name)] = name;
  } else {
    delete $.global.AELL_compAliases[String(args.name)];
  }
  var comp = app.project.items.addComp(name, w, h, 1, dur, fps);
  if (AELLJSON.isArray(args.bgColor) && args.bgColor.length >= 3) {
    comp.bgColor = [args.bgColor[0], args.bgColor[1], args.bgColor[2]];
  }
  comp.openInViewer();
  return AELL_okay({ name: comp.name, id: comp.id, width: w, height: h,
    duration: dur, frameRate: fps,
    note: name !== String(args.name)
      ? "A comp named '" + args.name + "' already existed — this one is '" +
        name + "'. Use THIS name in every following command."
      : "" });
};

/*
 * Apply style fields from args onto a text layer's TextDocument.
 * Handles: text, fontSize, font, fillColor, tracking, leading (switches
 * autoLeading off), justification. Returns a summary of the result.
 */
/*
 * Fonts are addressed by PostScript name, and AE will happily accept one
 * that is not installed: the TextDocument stores the bogus name verbatim
 * and the layer renders in a substituted face, so the tool would report a
 * success that never happened. The ONLY reliable tell is isSubstitute on
 * the FontObject — getFontsByPostScriptName echoes whatever name it was
 * given, so comparing names proves nothing. Verified in AE 2026.
 *
 * Returns null when the font is real, or a grounded error string listing
 * what IS installed, so the model can correct itself.
 */
function AELL_fontProblem(want) {
  var fonts = null;
  try { fonts = app.fonts; } catch (e0) { return null; }
  if (!fonts || typeof fonts.getFontsByPostScriptName !== "function") {
    return null;   // older AE: no way to check, so do not block the write
  }
  var fo = null;
  try {
    var found = fonts.getFontsByPostScriptName(want);
    if (found && found.length) { fo = found[0]; }
  } catch (e1) {}
  if (fo) {
    try {
      if (fo.isSubstitute === false) { return null; }
    } catch (e2) {}
  }

  // Grounded: name what actually exists, preferring near matches.
  var all = null;
  try { all = fonts.allFonts; } catch (e3) {}
  var near = [], sample = [], total = 0, i, ps;
  var low = String(want).toLowerCase();
  if (all) {
    for (i = 0; i < all.length; i++) {
      ps = null;
      // allFonts is an array of ARRAYS; the FontObject is one level in.
      try { ps = String(all[i][0].postScriptName); } catch (e4) {}
      if (!ps) { continue; }
      total++;
      if (near.length < 12 && ps.toLowerCase().indexOf(low) !== -1) {
        near.push(ps);
      }
      if (sample.length < 8) { sample.push(ps); }
    }
  }
  var msg = "Font '" + want + "' is not installed — AE would silently " +
            "substitute it and report success. Fonts are addressed by " +
            "PostScript name (Arial is 'ArialMT').";
  if (near.length) {
    msg += " Installed and matching: " + near.join(", ") + ".";
  } else if (sample.length) {
    msg += " Nothing installed matches that. " + total +
           " fonts available, for example: " + sample.join(", ") + ".";
  }
  return msg;
}

// A layer made by comp.layers.addText() inherits AE's CHARACTER PANEL
// state -- whatever the user last typed with, which scripting can neither
// read as "the default" nor reset. Measured in real AE 2026: asking for a
// plain text layer produced PowerCentra-Book at 66px, tracking 251,
// autoLeading off at 92, and superscript ON (the glyphs really do render
// at ~58% and raised). So add_text_layer starts every NEW layer from a
// known baseline and lets the args override it; set_text_style edits a
// layer the user already owns and must never normalize.
var AELL_TEXT_BASELINE = [
  ["tracking", 0], ["fauxBold", false], ["fauxItalic", false],
  ["baselineShift", 0], ["tsume", 0],
  ["horizontalScale", 1], ["verticalScale", 1],
  ["applyStroke", false], ["applyFill", true]
];
// AE 2026 makes these READ-ONLY on a TextDocument ("Unable to set ... It
// is a readOnly attribute"), so an inherited one cannot be cleared from
// script at all. Reported instead of silently shipped.
var AELL_TEXT_STUCK = ["allCaps", "smallCaps", "superscript", "subscript"];
// Verified installed before use: getFontsByPostScriptName ECHOES whatever
// it is handed, so only isSubstitute===false proves a font is real.
var AELL_TEXT_FONTS = ["ArialMT", "SegoeUI", "Verdana",
                       "TimesNewRomanPSMT", "CourierNewPSMT"];
var AELL_TEXT_SIZE = 72;
var AELL_TEXT_FONT_CACHE;   // undefined = not looked up yet, null = none

function AELL_defaultFont() {
  if (AELL_TEXT_FONT_CACHE !== undefined) { return AELL_TEXT_FONT_CACHE; }
  AELL_TEXT_FONT_CACHE = null;
  for (var i = 0; i < AELL_TEXT_FONTS.length; i++) {
    if (!AELL_fontProblem(AELL_TEXT_FONTS[i])) {
      AELL_TEXT_FONT_CACHE = AELL_TEXT_FONTS[i];
      break;
    }
  }
  return AELL_TEXT_FONT_CACHE;
}

// Mutates doc in place; fills out.stuck (inherited and unclearable) and
// out.skipped (a baseline field this AE would not take).
function AELL_normalizeTextDoc(doc, out) {
  var i, k, v;
  out.stuck = [];
  out.skipped = [];
  for (i = 0; i < AELL_TEXT_BASELINE.length; i++) {
    k = AELL_TEXT_BASELINE[i][0];
    v = AELL_TEXT_BASELINE[i][1];
    try {
      if (doc[k] !== v) { doc[k] = v; }
    } catch (e1) { out.skipped.push(k); }
  }
  try { doc.autoLeading = true; } catch (e2) { out.skipped.push("leading"); }
  try { doc.fillColor = [1, 1, 1]; } catch (e3) { out.skipped.push("fillColor"); }
  try { doc.fontSize = AELL_TEXT_SIZE; } catch (e4) { out.skipped.push("fontSize"); }
  try {
    doc.justification = ParagraphJustification.LEFT_JUSTIFY;
  } catch (e5) { out.skipped.push("justification"); }
  var font = AELL_defaultFont();
  if (font) {
    try { doc.font = font; } catch (e6) { out.skipped.push("font"); }
  }
  for (i = 0; i < AELL_TEXT_STUCK.length; i++) {
    k = AELL_TEXT_STUCK[i];
    try { if (doc[k] === true) { out.stuck.push(k); } } catch (e7) {}
  }
  return out;
}

function AELL_stuckStyleWarning(stuck) {
  if (!stuck || !stuck.length) { return null; }
  return "This layer inherited " + stuck.join(" + ") + " from After " +
         "Effects' Character panel, and AE makes " + stuck.join("/") +
         " read-only to scripting — the tool cannot clear it. The text " +
         "will keep rendering that way until it is switched off in the " +
         "Character panel by hand.";
}

function AELL_applyTextStyle(layer, args, reset) {
  var textProp = layer.property("ADBE Text Properties")
                      .property("ADBE Text Document");
  var doc = textProp.value;
  // Baseline FIRST, args second, one setValue for both: the args are the
  // caller's explicit wishes and must win over the inherited defaults.
  if (reset) { AELL_normalizeTextDoc(doc, reset); }
  if (typeof args.text === "string" && args.text !== "") doc.text = args.text;
  if (args.fontSize > 0) doc.fontSize = args.fontSize;
  if (typeof args.font === "string" && args.font !== "") {
    var fontErr = AELL_fontProblem(args.font);
    if (fontErr) throw new Error(fontErr);
    doc.font = args.font;
  }
  if (AELLJSON.isArray(args.fillColor) && args.fillColor.length >= 3) {
    doc.fillColor = [args.fillColor[0], args.fillColor[1], args.fillColor[2]];
    doc.applyFill = true;
  }
  if (typeof args.tracking === "number") doc.tracking = args.tracking;
  // Without an "auto" spelling there is no way BACK to auto leading once a
  // number has been set: AE clamps leading 0 to ~0.01 and leaves
  // autoLeading false, so the line spacing collapses instead of resetting.
  if (args.leading === "auto") {
    doc.autoLeading = true;
  } else if (typeof args.leading === "number") {
    doc.autoLeading = false;
    doc.leading = args.leading;
  }
  if (typeof args.justification === "string" && args.justification !== "") {
    var j = String(args.justification).toLowerCase();
    if (j === "left") doc.justification = ParagraphJustification.LEFT_JUSTIFY;
    else if (j === "center") doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    else if (j === "right") doc.justification = ParagraphJustification.RIGHT_JUSTIFY;
    else throw new Error("'justification' must be left, center or right");
  }
  textProp.setValue(doc);

  var out = textProp.value;
  var summary = { fontSize: out.fontSize, font: out.font };
  try { summary.tracking = out.tracking; } catch (e1) {}
  try {
    if (out.applyFill) {
      summary.fillColor = [AELL_r3(out.fillColor[0]), AELL_r3(out.fillColor[1]),
                           AELL_r3(out.fillColor[2])];
    }
  } catch (e3) {}
  try {
    summary.leading = out.autoLeading ? "auto" : out.leading;
  } catch (e2) {}
  return summary;
}

AELL_TOOLS.add_text_layer = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (typeof args.text !== "string" || args.text === "") {
    return AELL_err("'text' is required");
  }
  var layer = AELL_keepSelection(comp, function () {
    return comp.layers.addText(args.text);
  });
  // inheritStyle is the way back to AE's own behaviour for a user who
  // has set the Character panel up deliberately.
  var reset = args.inheritStyle ? null : {};
  var style = AELL_applyTextStyle(layer, {
    fontSize: args.fontSize,
    font: args.font,
    fillColor: args.fillColor,
    tracking: args.tracking,
    leading: args.leading,
    justification: args.justification
  }, reset);
  if (AELLJSON.isArray(args.position) && args.position.length >= 2) {
    layer.property("ADBE Transform Group").property("ADBE Position")
         .setValue(args.position);
  }
  var result = { index: layer.index, name: layer.name, style: style };
  if (reset) {
    result.styleReset = true;
    var stuckWarn = AELL_stuckStyleWarning(reset.stuck);
    if (stuckWarn) { result.warning = stuckWarn; }
    if (reset.skipped && reset.skipped.length) {
      result.notReset = reset.skipped;
    }
  } else {
    result.inheritedStyle = true;
  }
  return AELL_okay(result);
};

AELL_TOOLS.set_text_style = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  if (!(layer instanceof TextLayer)) {
    return AELL_err("Not a text layer: " + layer.name);
  }
  var style = AELL_applyTextStyle(layer, args);
  return AELL_okay({ layer: layer.name, style: style });
};

/*
 * TEXT ANIMATORS
 *
 * Measured in AE 2026 (probe, 2026-08-28) — the tree is not what the
 * scripting guide suggests:
 *
 *  - An animator's "Properties" group is NOT empty. It ships with all
 *    103 possible animator properties already present (the whole 3D-text
 *    Front/Bevel/Side/Back material set and eight nameless variable-font
 *    axes among them). addProperty does not CREATE one, it un-hides it.
 *  - enabled, elided and active read true/false/true for every one of
 *    the 103 whether or not it was ever added, so none of them tells an
 *    active property from a dormant one. `canSetExpression` DOES: false
 *    while dormant, true once added. That is the only flag that knows.
 *  - Writing to a dormant one throws AE's raw "the property or a parent
 *    property is hidden", which is why the deep search now refuses those
 *    by name and says which tool activates them.
 *  - Adding a SIBLING animator invalidates every reference already held
 *    into earlier animators (a1.name then throws "Object is invalid").
 *    Adding a selector or a property does not. So this tool re-fetches
 *    by index rather than holding what it made.
 *  - AE lets two animators share a name and returns the FIRST for a name
 *    lookup, so the later one is unreachable — same trap precompose had.
 *  - Per-character 3D is a LAYER switch (threeDPerChar), and turning it
 *    on also turns the layer 3D; turning it off again leaves the layer
 *    3D. X/Y Rotation and a Z in Position/Anchor Point need it.
 *  - "ADBE Text Rotation" IS the Z rotation; "ADBE Text Rotation Z" does
 *    not exist in either mode. Percent Start/End/Offset run -100..100,
 *    not 0..100.
 */
var AELL_ANIM_PROPS = [
  { arg: "anchorPoint", m: "ADBE Text Anchor Point 3D", dims: 3, perChar: "z" },
  { arg: "position", m: "ADBE Text Position 3D", dims: 3, perChar: "z" },
  { arg: "scale", m: "ADBE Text Scale 3D", dims: 3, perChar: "z100" },
  { arg: "skew", m: "ADBE Text Skew" },
  { arg: "skewAxis", m: "ADBE Text Skew Axis" },
  { arg: "rotation", m: "ADBE Text Rotation" },
  { arg: "xRotation", m: "ADBE Text Rotation X", perChar: "always" },
  { arg: "yRotation", m: "ADBE Text Rotation Y", perChar: "always" },
  { arg: "opacity", m: "ADBE Text Opacity" },
  { arg: "fillColor", m: "ADBE Text Fill Color", color: true },
  { arg: "fillOpacity", m: "ADBE Text Fill Opacity" },
  { arg: "fillHue", m: "ADBE Text Fill Hue" },
  { arg: "fillSaturation", m: "ADBE Text Fill Saturation" },
  { arg: "fillBrightness", m: "ADBE Text Fill Brightness" },
  { arg: "strokeColor", m: "ADBE Text Stroke Color", color: true },
  { arg: "strokeOpacity", m: "ADBE Text Stroke Opacity" },
  { arg: "strokeWidth", m: "ADBE Text Stroke Width" },
  { arg: "strokeHue", m: "ADBE Text Stroke Hue" },
  { arg: "strokeSaturation", m: "ADBE Text Stroke Saturation" },
  { arg: "strokeBrightness", m: "ADBE Text Stroke Brightness" },
  { arg: "tracking", m: "ADBE Text Tracking Amount" },
  { arg: "trackingType", m: "ADBE Text Track Type" },
  { arg: "lineAnchor", m: "ADBE Text Line Anchor" },
  { arg: "lineSpacing", m: "ADBE Text Line Spacing", dims: 2 },
  { arg: "characterOffset", m: "ADBE Text Character Offset" },
  { arg: "characterValue", m: "ADBE Text Character Replace" },
  { arg: "characterRange", m: "ADBE Text Character Range" },
  { arg: "characterAlignment", m: "ADBE Text Character Change Type" },
  { arg: "blur", m: "ADBE Text Blur", dims: 2 }
];

var AELL_ANIM_SEL_ENUMS = {
  units:      { m: "ADBE Text Range Units",     of: ["percent", "index"] },
  basedOn:    { m: "ADBE Text Range Type2",
                of: ["characters", "charactersExcludingSpaces", "words", "lines"] },
  mode:       { m: "ADBE Text Selector Mode",
                of: ["add", "subtract", "intersect", "min", "max", "difference"] },
  shape:      { m: "ADBE Text Range Shape",
                of: ["square", "rampUp", "rampDown", "triangle", "round", "smooth"] }
};
/* Plain numeric selector settings: arg -> matchName. */
var AELL_ANIM_SEL_NUMS = {
  smoothness:     "ADBE Text Selector Smoothness",
  easeHigh:       "ADBE Text Levels Max Ease",
  easeLow:        "ADBE Text Levels Min Ease",
  amount:         "ADBE Text Selector Max Amount",
  randomizeOrder: "ADBE Text Randomize Order",
  randomSeed:     "ADBE Text Random Seed"
};
var AELL_ANIM_WIGGLY_NUMS = {
  maxAmount:         "ADBE Text Wiggly Max Amount",
  minAmount:         "ADBE Text Wiggly Min Amount",
  wigglesPerSecond:  "ADBE Text Temporal Freq",
  correlation:       "ADBE Text Character Correlation",
  temporalPhase:     "ADBE Text Temporal Phase",
  spatialPhase:      "ADBE Text Spatial Phase",
  lockDimensions:    "ADBE Text Wiggly Lock Dim",
  randomSeed:        "ADBE Text Wiggly Random Seed"
};

function AELL_animPropFor(name) {
  var want = String(name).toLowerCase().replace(/[\s_-]/g, "");
  for (var i = 0; i < AELL_ANIM_PROPS.length; i++) {
    var p = AELL_ANIM_PROPS[i];
    if (p.arg.toLowerCase() === want) return p;
    if (p.m.toLowerCase() === String(name).toLowerCase()) return p;
  }
  return null;
}

function AELL_animPropNames() {
  var out = [];
  for (var i = 0; i < AELL_ANIM_PROPS.length; i++) out.push(AELL_ANIM_PROPS[i].arg);
  return out.join(", ");
}

/* An animator property AE has not been asked to add yet. The only honest
   test measured in the field: canSetExpression is false while hidden. */
function AELL_animDormant(prop) {
  try { return prop.canSetExpression === false; } catch (e) { return false; }
}

/* The same question asked of a property reached by an explicit path,
   where nothing has told us we are inside an animator. canSetExpression
   is false on plenty of ordinary read-only properties (a selector's
   Units, for one), so the parent group has to agree. */
function AELL_animPropDormant(prop) {
  if (!AELL_animDormant(prop)) return false;
  var g = null;
  try { g = prop.propertyGroup(1); } catch (e) { return false; }
  try { return !!g && String(g.matchName) === "ADBE Text Animator Properties"; }
  catch (e2) { return false; }
}

/* One sentence, used by every tool that lands on a dormant slot. */
function AELL_animDormantMsg(layer, spec, verb) {
  return "'" + spec + "' is a text-animator property that has not been " +
    "added to its animator, so AE keeps it hidden and " + verb +
    " it does nothing. add_text_animator {layer: \"" + layer.name +
    "\", properties: {…}} adds and sets one in a single call.";
}

/* AE happily gives two animators the same name and then answers a name
   lookup with the first one, stranding the second — so number it. */
function AELL_uniqueAnimatorName(anims, base) {
  var taken = {};
  for (var i = 1; i <= anims.numProperties; i++) {
    try { taken[anims.property(i).name] = true; } catch (e) {}
  }
  if (!taken[base]) return base;
  var k = 2;
  while (taken[base + " " + k]) k++;
  return base + " " + k;
}

function AELL_animEnumValue(key, given) {
  var spec = AELL_ANIM_SEL_ENUMS[key];
  var want = String(given).toLowerCase().replace(/[\s_-]/g, "");
  for (var i = 0; i < spec.of.length; i++) {
    if (spec.of[i].toLowerCase() === want) return i + 1;
  }
  var n = AELL_numArg(given);
  if (n !== null && n >= 1 && n <= spec.of.length) return Math.round(n);
  return null;
}

/* Which per-character-3D-only properties a request touches. Measured:
   X/Y Rotation always need it; a Z in Position/Anchor Point and a Scale
   Z other than 100 do too. Anything else animates flat characters. */
function AELL_animNeeds3D(spec, value) {
  if (spec.perChar === "always") return true;
  if (!AELLJSON.isArray(value) || value.length < 3) return false;
  var z = AELL_numArg(value[2]);
  if (z === null) return false;
  if (spec.perChar === "z") return z !== 0;
  if (spec.perChar === "z100") return z !== 100;
  return false;
}

function AELL_animSetValue(prop, spec, value, label, problems) {
  var v = value;
  if (spec.color) {
    if (!AELLJSON.isArray(v) || v.length < 3) {
      problems.push("'" + label + "' must be [r, g, b] floats 0..1");
      return null;
    }
    v = [AELL_clamp01(v[0]), AELL_clamp01(v[1]), AELL_clamp01(v[2]),
         v.length > 3 ? AELL_clamp01(v[3]) : 1];
  } else if (spec.dims) {
    if (!AELLJSON.isArray(v)) {
      var one = AELL_numArg(v);
      if (one === null) {
        problems.push("'" + label + "' must be an array of " + spec.dims +
                      " numbers");
        return null;
      }
      v = spec.dims === 2 ? [one, one] : [one, one, one];
    }
  } else {
    var n = AELL_numArg(v);
    if (n === null) {
      problems.push("'" + label + "' must be a number (got " +
                    AELLJSON.stringify(v) + ")");
      return null;
    }
    v = n;
  }
  try {
    prop.setValue(v);
  } catch (e) {
    var range = "";
    try {
      if (prop.hasMin || prop.hasMax) {
        range = " Range: " + (prop.hasMin ? prop.minValue : "-inf") + " to " +
                (prop.hasMax ? prop.maxValue : "+inf") + ".";
      }
    } catch (e2) {}
    problems.push("AE rejected '" + label + "': " + (e.message || e) + range);
    return null;
  }
  var read;
  try { read = prop.value; } catch (e3) { read = v; }
  return AELL_sampleRaw(read);
}

AELL_TOOLS.add_text_animator = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var i, key;

  if (!(layer instanceof TextLayer)) {
    var texts = [];
    for (i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i) instanceof TextLayer) texts.push(comp.layer(i).name);
    }
    return AELL_err("'" + layer.name + "' is a " + AELL_layerType(layer) +
      " layer — text animators only exist on TEXT layers." +
      (texts.length ? " Text layers here: " + texts.join(", ") + "."
                    : " This comp has no text layers (add_text_layer)."));
  }

  var props = args.properties;
  if (props && AELLJSON.isArray(props)) {
    return AELL_err("'properties' is an object of name: value, not a list " +
      "— e.g. {opacity: 0, position: [0, -80]}. Available: " +
      AELL_animPropNames() + ".");
  }
  if (!props || typeof props !== "object") {
    return AELL_err("'properties' is required: an object of what the " +
      "animator animates, e.g. {opacity: 0} or {position: [0, -80], " +
      "rotation: 20}. Available: " + AELL_animPropNames() + ".");
  }
  /* Validate the whole request before touching the layer — a refusal
     must not leave a half-built animator behind. */
  var wanted = [], unknown = [], needs3D = [];
  for (key in props) {
    if (!props.hasOwnProperty(key)) continue;
    var spec = AELL_animPropFor(key);
    if (!spec) { unknown.push(key); continue; }
    wanted.push({ spec: spec, arg: key, value: props[key] });
    if (AELL_animNeeds3D(spec, props[key])) needs3D.push(key);
  }
  if (unknown.length) {
    return AELL_err("No animator property named " + unknown.join(", ") +
      ". AE's animator properties: " + AELL_animPropNames() +
      ". (Rotation IS the Z rotation; xRotation/yRotation need " +
      "per-character 3D, which this tool turns on for you.)");
  }
  if (!wanted.length) {
    return AELL_err("'properties' was empty. Name at least one: " +
      AELL_animPropNames() + ".");
  }

  var sel = args.selector;
  if (sel === null || typeof sel === "undefined") sel = {};
  if (typeof sel !== "object" || AELLJSON.isArray(sel)) {
    return AELL_err("'selector' must be an object, e.g. " +
      "{start: 0, end: 50} or {type: \"wiggly\"} or {type: \"none\"}.");
  }
  var selType = sel.type ? String(sel.type).toLowerCase() : "range";
  var SEL_KINDS = { range: "ADBE Text Selector",
                    wiggly: "ADBE Text Wiggly Selector",
                    expression: "ADBE Text Expressible Selector" };
  if (selType !== "none" && !SEL_KINDS.hasOwnProperty(selType)) {
    return AELL_err("No selector type '" + sel.type + "'. AE has: range " +
      "(the usual one), wiggly, expression — or \"none\" to leave the " +
      "animator applying to every character.");
  }
  var enums = {};
  for (key in AELL_ANIM_SEL_ENUMS) {
    if (!AELL_ANIM_SEL_ENUMS.hasOwnProperty(key)) continue;
    if (typeof sel[key] === "undefined" || sel[key] === null) continue;
    var ev = AELL_animEnumValue(key, sel[key]);
    if (ev === null) {
      return AELL_err("No " + key + " '" + sel[key] + "' — AE has: " +
        AELL_ANIM_SEL_ENUMS[key].of.join(", ") + ".");
    }
    enums[key] = ev;
  }
  var indexUnits = enums.units === 2;
  /* Percent Start/End/Offset are -100..100 in AE (measured; 101 throws).
     Catch it here, before an animator exists to be cleaned up. */
  var ENDS = ["start", "end", "offset"];
  for (i = 0; i < ENDS.length; i++) {
    key = ENDS[i];
    if (typeof sel[key] === "undefined" || sel[key] === null) continue;
    var endNum = AELL_numArg(sel[key]);
    if (endNum === null) {
      return AELL_err("selector '" + key + "' must be a number (got " +
        AELLJSON.stringify(sel[key]) + ").");
    }
    if (!indexUnits && (endNum < -100 || endNum > 100)) {
      return AELL_err("selector '" + key + "' is a PERCENT here (" +
        endNum + " is outside -100..100). For a character count pass " +
        "units: \"index\" too.");
    }
    if (selType !== "range") {
      return AELL_err("'" + key + "' belongs to a RANGE selector; a " +
        selType + " selector has no start/end/offset. Drop type, or " +
        "drop '" + key + "'.");
    }
  }

  var made = AELL_keepSelection(comp, function () {
    var anims = layer.property("ADBE Text Properties")
                     .property("ADBE Text Animators");
    var wantName = (typeof args.name === "string" && args.name !== "")
      ? args.name : "Animator " + (anims.numProperties + 1);
    var finalName = AELL_uniqueAnimatorName(anims, wantName);
    anims.addProperty("ADBE Text Animator");
    /* Adding an animator invalidates every reference held into the
       earlier ones, so everything below re-reaches through the index. */
    var idx = anims.numProperties;
    anims.property(idx).name = finalName;
    return { index: idx, name: finalName,
             renamed: finalName !== wantName ? wantName : null };
  });

  var anims = layer.property("ADBE Text Properties")
                   .property("ADBE Text Animators");
  var animPath = "Text/Animators/" + made.name;
  var out = { layer: layer.name, animator: made.name, path: animPath };
  if (made.renamed) {
    out.nameTaken = "'" + made.renamed + "' was already an animator on " +
      "this layer, so AE would have answered a lookup with the OTHER one";
  }

  /* Per-character 3D first: it is a LAYER switch, and X/Y Rotation is
     dormant-but-addable without it, so the write would land somewhere
     the render never reads. */
  if (needs3D.length && layer.threeDPerChar !== true) {
    var was3D = layer.threeDLayer;
    layer.threeDPerChar = true;
    out.perCharacter3D = "per-character 3D turned ON — " +
      needs3D.join(", ") + " only affects characters with it" +
      (was3D ? "" : "; AE made '" + layer.name + "' a 3D layer to do it, " +
       "and turning per-character 3D off again does not undo that");
  }

  var problems = [];
  var applied = [];
  var pg = anims.property(made.index).property("ADBE Text Animator Properties");
  for (i = 0; i < wanted.length; i++) {
    var w = wanted[i];
    var prop;
    try { prop = pg.property(w.spec.m); } catch (eP) { prop = null; }
    if (!prop) { problems.push("AE has no '" + w.arg + "' on this animator"); continue; }
    if (AELL_animDormant(prop)) pg.addProperty(w.spec.m);
    prop = pg.property(w.spec.m);
    var got = AELL_animSetValue(prop, w.spec, w.value, w.arg, problems);
    if (got === null) continue;
    applied.push({ property: prop.name, value: got,
                   path: animPath + "/Properties/" + prop.name });
  }
  out.properties = applied;

  if (selType !== "none") {
    var sels = anims.property(made.index).property("ADBE Text Selectors");
    sels.addProperty(SEL_KINDS[selType]);
    var s = sels.property(sels.numProperties);
    var selPath = animPath + "/Selectors/" + s.name;
    var settings = {};
    if (selType === "range") {
      var adv = s.property("ADBE Text Range Advanced");
      /* Units must go in FIRST: it decides whether Start/End/Offset mean
         the percent triple or the index one, and AE keeps both. */
      if (typeof enums.units !== "undefined") {
        adv.property("ADBE Text Range Units").setValue(enums.units);
        settings.units = indexUnits ? "index" : "percent";
      }
      for (key in AELL_ANIM_SEL_ENUMS) {
        if (!AELL_ANIM_SEL_ENUMS.hasOwnProperty(key) || key === "units") continue;
        if (typeof enums[key] === "undefined") continue;
        adv.property(AELL_ANIM_SEL_ENUMS[key].m).setValue(enums[key]);
        settings[key] = AELL_ANIM_SEL_ENUMS[key].of[enums[key] - 1];
      }
      var ends = { start: ["ADBE Text Percent Start", "ADBE Text Index Start"],
                   end: ["ADBE Text Percent End", "ADBE Text Index End"],
                   offset: ["ADBE Text Percent Offset", "ADBE Text Index Offset"] };
      for (key in ends) {
        if (!ends.hasOwnProperty(key)) continue;
        if (typeof sel[key] === "undefined" || sel[key] === null) continue;
        var num = AELL_numArg(sel[key]);
        if (num === null) {
          problems.push("selector '" + key + "' must be a number");
          continue;
        }
        var target = s.property(ends[key][indexUnits ? 1 : 0]);
        try {
          target.setValue(num);
          settings[key] = num;
        } catch (eS) {
          problems.push("AE rejected selector '" + key + "': " +
            (eS.message || eS) + (indexUnits ? "" :
            " Percent selectors run -100 to 100."));
        }
      }
      for (key in AELL_ANIM_SEL_NUMS) {
        if (!AELL_ANIM_SEL_NUMS.hasOwnProperty(key)) continue;
        if (typeof sel[key] === "undefined" || sel[key] === null) continue;
        var nv = AELL_numArg(sel[key]);
        if (nv === null) { problems.push("selector '" + key + "' must be a number"); continue; }
        try { adv.property(AELL_ANIM_SEL_NUMS[key]).setValue(nv); settings[key] = nv; }
        catch (eN2) { problems.push("AE rejected selector '" + key + "': " + (eN2.message || eN2)); }
      }
    } else if (selType === "wiggly") {
      for (key in AELL_ANIM_WIGGLY_NUMS) {
        if (!AELL_ANIM_WIGGLY_NUMS.hasOwnProperty(key)) continue;
        if (typeof sel[key] === "undefined" || sel[key] === null) continue;
        var wv = AELL_numArg(sel[key]);
        if (wv === null) { problems.push("selector '" + key + "' must be a number"); continue; }
        try { s.property(AELL_ANIM_WIGGLY_NUMS[key]).setValue(wv); settings[key] = wv; }
        catch (eW) { problems.push("AE rejected selector '" + key + "': " + (eW.message || eW)); }
      }
      if (typeof enums.mode !== "undefined") {
        s.property("ADBE Text Selector Mode").setValue(enums.mode);
        settings.mode = AELL_ANIM_SEL_ENUMS.mode.of[enums.mode - 1];
      }
      if (typeof enums.basedOn !== "undefined") {
        s.property("ADBE Text Range Type2").setValue(enums.basedOn);
        settings.basedOn = AELL_ANIM_SEL_ENUMS.basedOn.of[enums.basedOn - 1];
      }
    }
    out.selector = { name: s.name, type: selType, path: selPath };
    out.selector.settings = settings;
    if (selType === "range") {
      out.animateHint = "set_keyframes {layer: \"" + layer.name +
        "\", property: \"" + selPath + "/Offset\", keys: [...]} slides the " +
        "selection across the text";
    }
  } else {
    out.selector = "none — the animator applies to every character";
  }

  if (problems.length) out.problems = problems;
  return AELL_okay(out);
};

AELL_TOOLS.add_solid = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (!args.name) return AELL_err("'name' is required");
  var color = (AELLJSON.isArray(args.color) && args.color.length >= 3)
    ? [args.color[0], args.color[1], args.color[2]] : [0.5, 0.5, 0.5];
  var w = args.width > 0 ? Math.round(args.width) : comp.width;
  var h = args.height > 0 ? Math.round(args.height) : comp.height;
  var layer = AELL_keepSelection(comp, function () {
    return comp.layers.addSolid(color, args.name, w, h, 1, comp.duration);
  });
  return AELL_okay({ index: layer.index, name: layer.name });
};

/*
 * Change a SOLID's colour.
 *
 * The colour does not live on the layer — it lives on the solid SOURCE,
 * and duplicate_layer and split_layer_into_chunks both hand out layers
 * that SHARE one source. Measured in AE 2026: duplicate a solid twice
 * and all three layers report the same source id; one write to
 * mainSource.color turns all three. So the shared case is this panel's
 * normal case, not an edge, and a tool that just wrote the colour would
 * recolour layers nobody mentioned and report success.
 *
 * Hence: work out who else shares the source, and never surprise the
 * caller. If every sharer was asked for, write once and say so. If only
 * some were, refuse and name the collateral — unless the caller has said
 * which way they want it (makeUnique true to isolate, false to accept
 * the spread).
 *
 * Isolating is possible but not obvious: app.project.items.addSolid does
 * NOT exist. The only way to mint a SolidSource from script is to add a
 * throwaway solid LAYER, take its .source, and remove the layer — the
 * source survives. replaceSource(fresh, false) then keeps keyframes,
 * effects, masks, transform, the layer's hand-set NAME and its in/out
 * points; all measured, none of it assumed.
 */
function AELL_clamp01(v) {
  var n = Number(v);
  if (!(n >= 0)) return 0;
  return n > 1 ? 1 : n;
}

function AELL_solidSourceOf(layer) {
  try {
    if (layer.source && layer.source.mainSource &&
        (layer.source.mainSource instanceof SolidSource)) {
      return layer.source;
    }
  } catch (e) {}
  return null;
}

/* Every layer in the comp whose source is this one. */
function AELL_sharersOf(comp, source) {
  var out = [], i;
  for (i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    if (AELL_solidSourceOf(L) === source) out.push(L);
  }
  return out;
}

/* Mint a solid source nothing else uses, matching an existing one. */
function AELL_freshSolidSource(comp, like, color) {
  var name = AELL_uniqueItemName(like.name);
  var tmp = comp.layers.addSolid(color, name, like.width, like.height,
                                 like.pixelAspect, comp.duration);
  var source = tmp.source;
  tmp.remove();
  return source;
}

AELL_TOOLS.set_solid_color = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (!AELLJSON.isArray(args.color) || args.color.length < 3) {
    return AELL_err("'color' is required: [r, g, b] floats 0..1");
  }
  var color = [AELL_clamp01(args.color[0]), AELL_clamp01(args.color[1]),
               AELL_clamp01(args.color[2])];

  var targets;
  try { targets = AELL_layersOrSelection(comp, args); }
  catch (eL) { return AELL_err(eL.message); }

  // Every target must actually BE a solid, and say what it is if not.
  var notSolid = [], i, j;
  for (i = 0; i < targets.length; i++) {
    if (!AELL_solidSourceOf(targets[i])) {
      notSolid.push(targets[i].name + " (" + AELL_layerType(targets[i]) + ")");
    }
  }
  if (notSolid.length) {
    return AELL_err("set_solid_color only works on SOLID layers. Not " +
      "solids: " + notSolid.join(", ") + ". A shape layer's colour is in " +
      "its contents (use set_property), and a text layer's is fillColor " +
      "(use set_text_style).");
  }

  // Group the targets by the source they share.
  var sources = [], groups = [];
  for (i = 0; i < targets.length; i++) {
    var src = AELL_solidSourceOf(targets[i]);
    var at = -1;
    for (j = 0; j < sources.length; j++) if (sources[j] === src) at = j;
    if (at < 0) { sources.push(src); groups.push([targets[i]]); }
    else { groups[at].push(targets[i]); }
  }

  // Who would change WITHOUT being asked for?
  var collateral = [];
  for (i = 0; i < sources.length; i++) {
    var sharers = AELL_sharersOf(comp, sources[i]);
    for (j = 0; j < sharers.length; j++) {
      var wanted = false, k;
      for (k = 0; k < targets.length; k++) {
        if (targets[k] === sharers[j]) wanted = true;
      }
      if (!wanted) collateral.push(sharers[j].name);
    }
  }

  var makeUnique = args.makeUnique === true;
  if (collateral.length && typeof args.makeUnique === "undefined") {
    return AELL_err("That solid is SHARED. Recolouring it would also " +
      "change " + collateral.length + " layer(s) nobody asked about: " +
      collateral.join(", ") + " (duplicate_layer and " +
      "split_layer_into_chunks share one solid between the layers they " +
      "make). Say which you want: makeUnique:true gives the layer(s) " +
      "you named their OWN solid and leaves the others alone, " +
      "makeUnique:false recolours all of them on purpose.");
  }

  var changed = [], madeUnique = [];
  for (i = 0; i < groups.length; i++) {
    if (makeUnique) {
      for (j = 0; j < groups[i].length; j++) {
        var layer = groups[i][j];
        // Measured in AE 2026, the hard way: a layer that was never
        // renamed BY HAND displays its source's name, so replaceSource
        // silently renames it — the self-test ended up with two layers
        // both called "ST SC Square 2". A layer with a hand-set name
        // keeps it. Write the old name back either way, so recolouring
        // never renames anything.
        var keptName = layer.name;
        var fresh = AELL_freshSolidSource(comp, sources[i], color);
        layer.replaceSource(fresh, false);
        if (layer.name !== keptName) layer.name = keptName;
        madeUnique.push(keptName + " -> " + fresh.name);
        changed.push(keptName);
      }
    } else {
      sources[i].mainSource.color = color;
      for (j = 0; j < groups[i].length; j++) changed.push(groups[i][j].name);
    }
  }

  var data = { comp: comp.name, layers: changed, color: color,
               solidsTouched: makeUnique ? madeUnique.length : sources.length };
  if (makeUnique) {
    data.madeUnique = madeUnique;
    data.note = "Each layer got its OWN solid, so nothing else changed. " +
      "That adds " + madeUnique.length + " item(s) to the project panel.";
  } else if (collateral.length) {
    data.alsoChanged = collateral;
    data.note = "These layers share the solid, so they changed too: " +
      collateral.join(", ") + ".";
  } else {
    data.note = "Nothing else uses " +
      (sources.length === 1 ? "that solid" : "those solids") + ".";
  }
  return AELL_okay(data);
};

AELL_TOOLS.set_transform = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var propName = args.property;
  if (!AELL_TRANSFORM_MAP[propName]) {
    return AELL_err("'property' must be one of: position, scale, rotation, " +
                    "opacity, anchorPoint");
  }
  var prop = AELL_resolveProperty(layer, propName);
  var value = args.value;
  var i;

  if (args.relative) {
    // Apply value relative to the current state:
    //   scale/opacity: multiply by value/100  (relative 200 = double)
    //   position/anchorPoint: add the offset
    //   rotation: add degrees
    var cur = prop.value;
    if (propName === "scale" || propName === "opacity") {
      if (AELLJSON.isArray(cur)) {
        var factors = AELLJSON.isArray(value) ? value : null;
        var out = [];
        for (i = 0; i < cur.length; i++) {
          var f = factors ? factors[Math.min(i, factors.length - 1)] : value;
          out.push(cur[i] * (Number(f) / 100));
        }
        value = out;
      } else {
        value = cur * (Number(value) / 100);
      }
    } else if (propName === "rotation") {
      value = cur + Number(value);
    } else { // position / anchorPoint: element-wise offset
      if (!AELLJSON.isArray(value)) {
        return AELL_err("relative " + propName + " needs an offset array " +
                        "like [dx, dy]");
      }
      var moved = [];
      for (i = 0; i < cur.length; i++) {
        moved.push(cur[i] + (Number(value[i]) || 0));
      }
      value = moved;
    }
  }

  var drivenWarn;
  try {
    drivenWarn = AELL_writeValue(prop, value, propName);
  } catch (eW) {
    return AELL_err(eW.message);
  }

  var result = { layer: layer.name, property: propName, value: value };
  if (drivenWarn) { result.applied = false; result.warning = drivenWarn; }

  // Unit sanity: AE scale is PERCENT. A model that thinks in fractions
  // sends 2 meaning "200%" and shrinks the layer to 2%. Warn loudly in the
  // result so the next round can correct it.
  if (propName === "scale" && !args.relative) {
    var vals = AELLJSON.isArray(value) ? value : [value];
    var allTiny = true;
    for (i = 0; i < vals.length; i++) {
      if (Math.abs(Number(vals[i])) > 5) { allTiny = false; break; }
    }
    if (allTiny) {
      result.warning = "Scale is in PERCENT (100 = normal size). You just " +
        "set " + AELLJSON.stringify(value) + " percent, which is nearly " +
        "invisible. If you meant a multiplier, resend with the value * 100 " +
        "(e.g. 200 for double size).";
    }
  }
  return AELL_okay(result);
};

/* True when a property's value varies over time (keyframes or a rig). */
function AELL_isAnimated(prop) {
  try {
    if (prop.numKeys > 0) return true;
  } catch (eK) {}
  try {
    if (prop.expressionEnabled) return true;
  } catch (eE) {}
  return false;
}

/*
 * The Position offset that cancels an anchor shift of [dax, day] at time
 * t: the shift happens in LAYER space, so it reaches Position through
 * this layer's own Scale and Rotation at that moment. Both are read with
 * valueAtTime(t, false) so keyframed and expression-driven rigs give the
 * value AE actually renders.
 */
function AELL_anchorDelta(sclProp, rotProp, dax, day, t) {
  var s = sclProp.valueAtTime(t, false);
  var r = rotProp.valueAtTime(t, false);
  var dx = dax * (s[0] / 100);
  var dy = day * (s[1] / 100);
  var rad = r * Math.PI / 180;
  return [dx * Math.cos(rad) - dy * Math.sin(rad),
          dx * Math.sin(rad) + dy * Math.cos(rad)];
}

AELL_TOOLS.center_anchor_point = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  if (typeof layer.sourceRectAtTime !== "function") {
    return AELL_err("Layer type has no measurable content bounds: " +
                    layer.name);
  }
  // sourceRectAtTime wants the layer's own SOURCE time, not comp time —
  // see AELL_sourceTime. A slid or stretched layer used to be measured at
  // the wrong frame here, which centred the anchor on content the viewer
  // was not showing.
  var rect = layer.sourceRectAtTime(AELL_sourceTime(layer, comp.time),
                                    false);
  var transform = layer.property("ADBE Transform Group");
  var apProp = transform.property("ADBE Anchor Point");
  var posProp = transform.property("ADBE Position");
  var oldAp = apProp.value;
  var newAp = [rect.left + rect.width / 2, rect.top + rect.height / 2];
  // NB: the scripting API pads 2D values to 3 components, so this fires
  // for 2D layers too and simply carries the existing 0 through — which
  // is what setValue wants back. It is NOT a 3D test.
  if (oldAp.length > 2) newAp.push(oldAp[2]);

  // An animated anchor cannot be "centered" — there is no single value to
  // write, and setValue would throw AE's raw error. Say so instead.
  if (apProp.numKeys > 0) {
    return AELL_err("Anchor Point is animated on " + layer.name + " (" +
      apProp.numKeys + " keyframes), so there is no single anchor to " +
      "center. Delete the Anchor Point keyframes first (select the " +
      "property, press Delete), then run this again.");
  }

  var preserve = args.preservePosition !== false;   // default true
  var note = "";

  if (preserve && !layer.threeDLayer) {
    // Shifting the anchor moves the layer by the same amount in layer
    // space; offset position by that delta run through scale+rotation so
    // the layer stays visually in place. Parenting needs no special case:
    // Position is already expressed in the parent's space, and the delta
    // is carried there by this layer's own scale and rotation.
    //
    // Scale and Rotation can THEMSELVES be animated, which makes the
    // delta time-dependent — verified in real AE: one delta taken at the
    // current time and applied to every Position key left the layer
    // drifting up to 37px at the other keys. So it is recomputed at each
    // key's own time.
    var sclProp = transform.property("ADBE Scale");
    var rotProp = transform.property("ADBE Rotate Z");
    var dax = newAp[0] - oldAp[0];
    var day = newAp[1] - oldAp[1];
    var movingRig = AELL_isAnimated(sclProp) || AELL_isAnimated(rotProp);
    apProp.setValue(newAp);

    if (posProp.numKeys > 0) {
      // Animated position: setValue would throw. Offset EVERY key so the
      // whole animation shifts with the anchor rather than the layer
      // jumping at one time and not the others.
      for (var k = 1; k <= posProp.numKeys; k++) {
        var kv = posProp.keyValue(k);
        var dk = AELL_anchorDelta(sclProp, rotProp, dax, day,
                                  posProp.keyTime(k));
        var nk = [kv[0] + dk[0], kv[1] + dk[1]];
        for (var d = 2; d < kv.length; d++) nk.push(kv[d]);
        posProp.setValueAtKey(k, nk);
      }
      note = "anchor centered on content; all " + posProp.numKeys +
             " Position keyframes offset so the layer did not move";
      if (movingRig) {
        note += " (NOTE: Scale/Rotation are animated too, so the offset " +
                "is exact at the Position keyframes and approximate " +
                "between them — add Position keys where Scale/Rotation " +
                "have theirs if the in-between drift matters)";
      }
    } else {
      var dp = AELL_anchorDelta(sclProp, rotProp, dax, day, comp.time);
      var pos = posProp.value;
      var newPos = [pos[0] + dp[0], pos[1] + dp[1]];
      if (pos.length > 2) newPos.push(pos[2]);
      posProp.setValue(newPos);
      note = "anchor centered on content; position compensated so the " +
             "layer did not move";
      if (movingRig) {
        note += " (WARNING: Scale/Rotation are animated but Position is " +
                "not, so a single Position value cannot hold the layer " +
                "still — it is correct at " + comp.time + "s and drifts " +
                "elsewhere)";
      }
    }

    // A driven Position accepts the write but never shows it — report
    // that rather than claiming a compensation the viewer cannot see.
    var driven = false;
    try { driven = !!posProp.expressionEnabled; } catch (eX) {}
    if (driven) {
      note += " (WARNING: Position has an expression, which overrides the " +
              "compensation — the layer WILL appear to jump)";
    }
  } else {
    apProp.setValue(newAp);
    note = layer.threeDLayer
      ? "anchor centered; 3D layer, position NOT compensated"
      : "anchor centered; position not compensated (preservePosition=false)";
  }
  return AELL_okay({ layer: layer.name, oldAnchor: oldAp, newAnchor: newAp,
                     note: note });
};

/*
 * The time to hand sourceRectAtTime for a given COMP time.
 *
 * MEASURED in AE 2026 (WORKPLAN-LOG 2026-08-29): a property's own times
 * — keyTime, valueAtTime, setValueAtTime — are COMP times and slide with
 * the layer (a key at 2s reports 3s once startTime is 1, and 4s once the
 * layer is stretched to 200%). sourceRectAtTime's argument does NOT: it
 * is the layer's own SOURCE time, unshifted by startTime and unscaled by
 * stretch. Handing it comp.time therefore measures the wrong frame of an
 * animated text or shape on any layer that has been slid or stretched —
 * which is exactly what center_anchor_point used to do.
 */
function AELL_sourceTime(layer, compTime) {
  var st = 0, stretch = 100;
  try { st = Number(layer.startTime) || 0; } catch (eS) {}
  try { stretch = Number(layer.stretch); } catch (eT) {}
  if (!stretch || isNaN(stretch)) stretch = 100;
  return (compTime - st) / (stretch / 100);
}

/*
 * Apply ONE layer's own transform to a point that is already expressed
 * relative to that layer's anchor point, at comp time t. Returns the
 * point in the layer's PARENT space (comp space when unparented) —
 * itself relative to the parent's anchor, which is why the recursion in
 * AELL_compPoint never subtracts an anchor twice. Scale runs before
 * rotation; verified against AE's own sourcePointToComp on a parented,
 * scaled and rotated rig.
 */
function AELL_xform2d(layer, pt, t) {
  var tr = layer.property("ADBE Transform Group");
  var s = tr.property("ADBE Scale").valueAtTime(t, false);
  var r = tr.property("ADBE Rotate Z").valueAtTime(t, false);
  var p = tr.property("ADBE Position").valueAtTime(t, false);
  var x = pt[0] * (s[0] / 100);
  var y = pt[1] * (s[1] / 100);
  var rad = Number(r) * Math.PI / 180;
  return [x * Math.cos(rad) - y * Math.sin(rad) + Number(p[0]),
          x * Math.sin(rad) + y * Math.cos(rad) + Number(p[1])];
}

/*
 * A point in the layer's SOURCE space mapped to comp space at comp time
 * t, through the whole parent chain. 2D only — the caller must have
 * ruled out 3D first (AELL_threeDInChain); AE's own sourcePointToComp is
 * no help there and is measured lying about it, see get_bounds.
 */
function AELL_compPoint(layer, srcPt, t) {
  var anchor = layer.property("ADBE Transform Group")
                    .property("ADBE Anchor Point").valueAtTime(t, false);
  var pt = AELL_xform2d(layer, [srcPt[0] - Number(anchor[0]),
                                srcPt[1] - Number(anchor[1])], t);
  var up = null;
  try { up = layer.parent; } catch (eP) { up = null; }
  var guard = 0;
  while (up && guard++ < 64) {
    pt = AELL_xform2d(up, pt, t);
    try { up = up.parent; } catch (eP2) { up = null; }
  }
  return pt;
}

/* Every 3D layer in this layer's chain, nearest first (empty = all 2D). */
function AELL_threeDInChain(layer) {
  var hits = [];
  var l = layer, guard = 0;
  while (l && guard++ < 64) {
    var is3d = false;
    try { is3d = !!l.threeDLayer; } catch (eD) {}
    if (is3d) hits.push(l.name);
    try { l = l.parent; } catch (eU) { l = null; }
  }
  return hits;
}

AELL_TOOLS.get_bounds = function (args) {
  if (AELLJSON.isArray(args.layers)) {
    return AELL_err("get_bounds reads ONE layer. Call it once per " +
      "layer — for_each_layer reports only counts, so it would throw " +
      "every measurement away.");
  }
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var kind = AELL_layerType(layer);
  if (typeof layer.sourceRectAtTime !== "function") {
    return AELL_err("A " + kind + " layer ('" + layer.name + "') renders " +
      "no pixels, so it has no bounds — AE gives sourceRectAtTime only to " +
      "layers with content (text, shape, solid, footage, precomp, null). " +
      "For a camera or light read its Position with get_property instead.");
  }
  var t = AELL_numArg(args.time);
  if (t === null) {
    if (typeof args.time !== "undefined" && args.time !== null) {
      return AELL_err("'time' must be a number of seconds; got " +
        AELLJSON.stringify(args.time));
    }
    t = comp.time;
  }
  var extents = !!args.extents;
  var srcT = AELL_sourceTime(layer, t);
  var rect;
  try {
    rect = layer.sourceRectAtTime(srcT, extents);
  } catch (eR) {
    return AELL_err("AE could not measure '" + layer.name + "' at " +
      AELL_secs(t) + ": " + (eR.message || eR));
  }
  var w = AELL_r3(rect.width), h = AELL_r3(rect.height);
  var out = {
    layer: layer.name, layerType: kind, time: AELL_r3(t),
    extents: extents,
    source: { left: AELL_r3(rect.left), top: AELL_r3(rect.top),
              right: AELL_r3(rect.left + rect.width),
              bottom: AELL_r3(rect.top + rect.height),
              width: w, height: h,
              centerX: AELL_r3(rect.left + rect.width / 2),
              centerY: AELL_r3(rect.top + rect.height / 2) },
    compSize: [comp.width, comp.height]
  };
  if (AELL_r3(srcT) !== AELL_r3(t)) {
    out.sourceTime = AELL_r3(srcT);
    out.timeNote = "measured at source time " + AELL_secs(srcT) +
      ", which is comp time " + AELL_secs(t) + " for this layer (it " +
      "starts at " + AELL_secs(layer.startTime) + " and is stretched to " +
      layer.stretch + "%)";
  }
  if (w === 0 && h === 0) {
    out.empty = "this layer renders nothing at " + AELL_secs(t) +
      (kind === "shape" ? " — the shape layer has no drawn content yet " +
        "(add_shape_content adds some)"
       : kind === "text" ? " — the text is empty at this time"
       : " — check that the layer is on at this time");
  }

  // Comp space. AE's own sourcePointToComp is NOT usable here: measured
  // 2026-08-29, it ignores a 3D layer's Z entirely, ignores the camera,
  // and ignores a 3D PARENT's rotation, so for any 3D chain it answers
  // with confident numbers that are not where the pixels land. The 2D
  // math below was checked against it on 2D rigs and agrees exactly.
  var threeD = AELL_threeDInChain(layer);
  if (threeD.length) {
    out.comp = null;
    out.compBoxUnavailable = "'" + threeD[0] + "' is a 3D layer" +
      (threeD.length > 1 ? " (as are " + threeD.slice(1).join(", ") + ")" :
       "") + ", so where these pixels land in the frame depends on the " +
      "camera. AE's own sourcePointToComp ignores Z, the camera and a 3D " +
      "parent's rotation (measured), so no honest comp-space box can be " +
      "reported. The source rect above is still exact.";
    return AELL_okay(out);
  }

  var corners = [[rect.left, rect.top],
                 [rect.left + rect.width, rect.top],
                 [rect.left + rect.width, rect.top + rect.height],
                 [rect.left, rect.top + rect.height]];
  var mapped = [], i;
  for (i = 0; i < corners.length; i++) {
    mapped.push(AELL_compPoint(layer, corners[i], t));
  }
  var minX = mapped[0][0], maxX = mapped[0][0];
  var minY = mapped[0][1], maxY = mapped[0][1];
  for (i = 1; i < mapped.length; i++) {
    if (mapped[i][0] < minX) minX = mapped[i][0];
    if (mapped[i][0] > maxX) maxX = mapped[i][0];
    if (mapped[i][1] < minY) minY = mapped[i][1];
    if (mapped[i][1] > maxY) maxY = mapped[i][1];
  }
  out.comp = { left: AELL_r3(minX), top: AELL_r3(minY),
               right: AELL_r3(maxX), bottom: AELL_r3(maxY),
               width: AELL_r3(maxX - minX), height: AELL_r3(maxY - minY),
               centerX: AELL_r3((minX + maxX) / 2),
               centerY: AELL_r3((minY + maxY) / 2) };
  var round = [];
  for (i = 0; i < mapped.length; i++) {
    round.push([AELL_r3(mapped[i][0]), AELL_r3(mapped[i][1])]);
  }
  out.corners = round;
  // A rotated layer's axis-aligned box is bigger than its content; say so
  // rather than letting a caller read comp.width as the layer's width.
  var rotProp = layer.property("ADBE Transform Group")
                     .property("ADBE Rotate Z");
  var rot = Number(rotProp.valueAtTime(t, false)) % 360;
  if (rot !== 0) {
    out.rotated = rot;
    out.rotatedNote = "the layer is rotated " + AELL_r3(rot) + " degrees, " +
      "so comp.width/height describe the axis-aligned box AROUND it, not " +
      "the layer's own size (source.width/height is that)";
  }

  var over = {};
  if (minX < 0) over.left = AELL_r3(-minX);
  if (minY < 0) over.top = AELL_r3(-minY);
  if (maxX > comp.width) over.right = AELL_r3(maxX - comp.width);
  if (maxY > comp.height) over.bottom = AELL_r3(maxY - comp.height);
  var anyOver = false;
  for (var side in over) { if (over.hasOwnProperty(side)) anyOver = true; }
  if (!anyOver) {
    out.inFrame = "fully";
  } else if (maxX <= 0 || maxY <= 0 || minX >= comp.width ||
             minY >= comp.height) {
    out.inFrame = "outside";
    out.outsideBy = over;
  } else {
    out.inFrame = "partly";
    out.outsideBy = over;
  }
  return AELL_okay(out);
};

AELL_TOOLS.add_keyframe = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var prop = AELL_anyProperty(layer, args.property);
  if (typeof args.time !== "number") return AELL_err("'time' (seconds) required");
  prop.setValueAtTime(args.time, args.value);
  return AELL_okay({ layer: layer.name, property: args.property,
                     time: args.time, numKeys: prop.numKeys });
};

/* Escape a layer/effect name for embedding in generated expression code. */
function AELL_escapeExprName(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/*
 * Assign an expression and surface AE's own validation verdict. Returns
 * null on success, or the AE error text (with the expression cleared so a
 * broken one never lingers) on failure — the model sees the real reason
 * and can correct itself instead of guessing.
 */
function AELL_setExpr(prop, expr) {
  try {
    prop.expression = expr;
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
  var err = "";
  try { err = String(prop.expressionError || ""); } catch (e2) {}
  if (err !== "") {
    try { prop.expression = ""; } catch (e3) {}
    return err;
  }
  return null;
}

AELL_TOOLS.set_expression = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var prop = AELL_anyProperty(layer, args.property);
  if (!prop.canSetExpression) {
    return AELL_err("Property cannot take an expression: " + args.property);
  }
  var expr = typeof args.expression === "string" ? args.expression : "";
  if (expr === "") {
    prop.expression = "";
    return AELL_okay({ layer: layer.name, property: args.property,
                       expression: "cleared" });
  }
  var err = AELL_setExpr(prop, expr);
  if (err) {
    return AELL_err("After Effects rejected the expression (" + err +
      "). Do not invent syntax — prefer link_property or " +
      "apply_expression_preset, or fix the reported problem and retry.");
  }
  return AELL_okay({ layer: layer.name, property: args.property,
                     expressionEnabled: prop.expressionEnabled });
};

// ------------------------------------------------------- rigging (controls)

var AELL_CONTROL_TYPES = {
  slider:   { match: "ADBE Slider Control",   dims: 1 },
  angle:    { match: "ADBE Angle Control",    dims: 1 },
  checkbox: { match: "ADBE Checkbox Control", dims: 1 },
  color:    { match: "ADBE Color Control",    dims: 4 },
  point:    { match: "ADBE Point Control",    dims: 2 }
};

/*
 * Adding a layer selects it and deselects everything else — silently
 * destroying the user's selection between two commands in a round. Run a
 * creation fn, then restore the selection that existed before (the new
 * layer ends up unselected).
 */
function AELL_keepSelection(comp, fn) {
  var prev = [];
  var i;
  try {
    var sel = comp.selectedLayers;
    for (i = 0; i < sel.length; i++) prev.push(sel[i]);
  } catch (e) {}
  var out = fn();
  try {
    for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
    for (i = 0; i < prev.length; i++) prev[i].selected = true;
  } catch (e2) {}
  return out;
}

AELL_TOOLS.add_null = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_keepSelection(comp, function () {
    return comp.layers.addNull(comp.duration);
  });
  if (args.name) layer.name = String(args.name);
  if (AELLJSON.isArray(args.position) && args.position.length >= 2) {
    layer.property("ADBE Transform Group").property("ADBE Position")
         .setValue(args.position);
  }
  return AELL_okay({ index: layer.index, name: layer.name });
};

AELL_TOOLS.add_control = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var type = String(args.type || "slider").toLowerCase();
  var t = AELL_CONTROL_TYPES[type];
  if (!t) {
    return AELL_err("'type' must be slider, angle, checkbox, color or point");
  }
  if (!args.name) return AELL_err("'name' is required (e.g. 'Speed')");
  var effects = layer.property("ADBE Effect Parade");
  if (!effects) return AELL_err("This layer type cannot take effects");
  var fx = effects.addProperty(t.match);
  fx.name = String(args.name);
  if (typeof args.value !== "undefined" && args.value !== null) {
    try {
      fx.property(1).setValue(args.value);
    } catch (e) {
      return AELL_err("Control '" + fx.name + "' added, but the initial " +
                      "value was rejected: " + e.message);
    }
  }
  return AELL_okay({ layer: layer.name, control: fx.name, type: type,
                     hint: "Link with link_property {controlLayer: \"" +
                           layer.name + "\", controlEffect: \"" + fx.name +
                           "\"}" });
};

AELL_TOOLS.link_property = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var prop = AELL_anyProperty(layer, args.property);
  if (!prop.canSetExpression) {
    return AELL_err("Property cannot take an expression: " + args.property);
  }
  var ctrlLayer = AELL_resolveLayer(comp, args.controlLayer);
  var effects = ctrlLayer.property("ADBE Effect Parade");
  var fx = effects && args.controlEffect
    ? effects.property(args.controlEffect) : null;
  if (!fx) {
    return AELL_err("Control effect not found on '" + ctrlLayer.name +
                    "': " + args.controlEffect + ". Create it with " +
                    "add_control first.");
  }

  var ctrlDims = 1;
  if (fx.matchName === "ADBE Point Control") ctrlDims = 2;
  else if (fx.matchName === "ADBE Color Control") ctrlDims = 4;
  var v = prop.value;
  var targetDims = AELLJSON.isArray(v) ? v.length : 1;
  // Spatial/scale values are PADDED to 3 components by the scripting API
  // on 2D layers, but their EXPRESSION dimension is 2 — a 3-element
  // result there is rejected ("must be of dimension 2").
  try {
    if (targetDims > 2 && !layer.threeDLayer &&
        (prop.matchName === "ADBE Position" ||
         prop.matchName === "ADBE Anchor Point" ||
         prop.matchName === "ADBE Scale")) {
      targetDims = 2;
    }
  } catch (eDim) {}

  var scale = typeof args.scale === "number" ? args.scale : 1;
  var offset = typeof args.offset === "number" ? args.offset : 0;
  var src = 'thisComp.layer("' + AELL_escapeExprName(ctrlLayer.name) +
            '").effect("' + AELL_escapeExprName(fx.name) + '")(1)';
  var arith = "";
  if (scale !== 1) arith += " * " + scale;
  if (offset !== 0) arith += " + " + offset;

  // Var-free inline references only — the classic chained form is the
  // one shape that evaluates identically in both expression engines.
  var expr;
  if (ctrlDims === 1 && targetDims === 1) {
    expr = src + arith + ";";
  } else if (ctrlDims === 1 && targetDims > 1) {
    // Broadcast a scalar control across every target component.
    var comps = [];
    for (var i = 0; i < targetDims; i++) comps.push(src + arith);
    expr = "[" + comps.join(", ") + "]";
  } else if (ctrlDims === targetDims) {
    if (arith === "") {
      expr = src + ";";
    } else {
      var parts = [];
      for (var j = 0; j < targetDims; j++) {
        parts.push(src + "[" + j + "]" + arith);
      }
      expr = "[" + parts.join(", ") + "]";
    }
  } else {
    return AELL_err("Dimension mismatch: control '" + fx.name + "' has " +
      ctrlDims + " dimension(s) but " + args.property + " has " +
      targetDims + ". Use a slider for scalar targets, a point control " +
      "for 2D targets.");
  }

  var err = AELL_setExpr(prop, expr);
  if (err) return AELL_err("Link failed — AE rejected the expression: " + err);
  return AELL_okay({ layer: layer.name, property: args.property,
                     linkedTo: ctrlLayer.name + " > " + fx.name,
                     expression: expr });
};

/*
 * Convert Audio to Keyframes (menu command 4218, measured in AE 2026 —
 * the exact string "Convert Audio to Keyframes" resolves, any other
 * casing or an ellipsis returns 0).
 *
 * Everything this tool does around that one call comes from what the
 * command does NOT do, all measured in the field:
 *  - it reads the ACTIVE comp, not a comp we hand it, so the target has
 *    to be in the viewer first;
 *  - it reads the whole comp MIX and ignores the selection entirely, so
 *    isolating one layer means temporarily muting the other audible
 *    ones (a muted layer contributes an all-zero curve, measured);
 *  - it is bounded by the WORK AREA, so a trimmed work area silently
 *    yields keyframes for that slice only;
 *  - with no audible audio it does nothing at all: no layer, no error,
 *    no dialog — which is why this refuses BEFORE calling it;
 *  - it never uniques the null's name: run it twice and the comp has
 *    two layers called "Audio Amplitude", and every name-based
 *    reference after that is ambiguous.
 */
var AELL_A2K_CMD = "Convert Audio to Keyframes";
var AELL_A2K_MAIN = "Both Channels";

/* AVLayer-only switches: cameras and lights answer 'undefined'. */
function AELL_hasAudio(layer) {
  try { return layer.hasAudio === true; } catch (e) { return false; }
}
function AELL_audioOn(layer) {
  // audioEnabled is the MUTE switch and is time-independent. audioActive
  // is NOT usable here: it also asks whether the layer is audible at the
  // CURRENT time, so a music layer starting at 2s reads false while the
  // playhead sits at 0 and this would refuse a perfectly good comp.
  try { return layer.audioEnabled === true && layer.enabled !== false; }
  catch (e) { return false; }
}

function AELL_a2kAudioLayers(comp) {
  var out = [];
  for (var i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    if (AELL_hasAudio(L)) out.push(L);
  }
  return out;
}

/* AELL_uniqueLayerName with one layer held out of the "taken" set — the
 * layer AE has just created is already IN the comp when we go to name
 * it, so counting it would rename every single null "Audio Amplitude 2".
 */
function AELL_uniqueLayerNameExcept(comp, base, skip) {
  var taken = {};
  for (var i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    if (L === skip || AELL_sameLayer(L, skip)) continue;
    taken[L.name] = true;
  }
  if (!taken[base]) return base;
  var k = 2;
  while (taken[base + " " + k]) k++;
  return base + " " + k;
}

function AELL_sameLayer(a, b) {
  try {
    if (typeof a.id === "number" && typeof b.id === "number") {
      return a.id === b.id;
    }
  } catch (e) {}
  return false;
}

function AELL_layerIdSet(comp) {
  var ids = {};
  for (var i = 1; i <= comp.numLayers; i++) {
    try { ids[comp.layer(i).id] = true; } catch (e) {}
  }
  return ids;
}

AELL_TOOLS.audio_to_keyframes = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var i;

  // A bad ARGUMENT is checked before the comp's STATE, so a typo in
  // 'range' is refused as a typo rather than as "this comp has no audio".
  var range = String(args.range || "comp").toLowerCase();
  if (range !== "comp" && range !== "workarea") {
    return AELL_err("'range' must be 'comp' (whole comp, the default) or " +
                    "'workArea' (AE's own behaviour — work area only).");
  }

  var audio = AELL_a2kAudioLayers(comp);
  if (audio.length === 0) {
    var names = [];
    for (i = 1; i <= comp.numLayers && names.length < 15; i++) {
      names.push(comp.layer(i).name);
    }
    return AELL_err("No layer in '" + comp.name + "' has audio, and AE's " +
      "converter would silently do nothing. Layers here: " +
      (names.join(", ") || "(none)") + ". Import an audio or video file " +
      "with import_file and add it to the comp first.");
  }

  // Which layer's audio are we measuring?
  var only = null;
  if (args.layer !== null && typeof args.layer !== "undefined" &&
      args.layer !== "") {
    only = AELL_resolveLayer(comp, args.layer);
    if (!AELL_hasAudio(only)) {
      return AELL_err("'" + only.name + "' has no audio track. Layers with " +
        "audio in '" + comp.name + "': " +
        AELL_layerNamesOf(audio) +
        ". Omit 'layer' to measure the whole comp mix.");
    }
    if (!AELL_audioOn(only)) {
      return AELL_err("'" + only.name + "' has audio but it is muted (the " +
        "speaker switch is off" + (only.enabled === false ?
        " and the layer is disabled" : "") + "), so every keyframe would " +
        "be zero. Un-mute it in AE, or pick another layer.");
    }
  }

  var audible = [], mutedByUser = [];
  for (i = 0; i < audio.length; i++) {
    if (AELL_audioOn(audio[i])) audible.push(audio[i]);
    else mutedByUser.push(audio[i]);
  }
  if (audible.length === 0) {
    return AELL_err("Every audio layer in '" + comp.name + "' is muted (" +
      AELL_layerNamesOf(mutedByUser) + ") — the converter would " +
      "write a flat zero curve. Un-mute one first.");
  }

  // Silence everything we are not measuring, and remember exactly what we
  // changed so a throw cannot leave the user's comp muted.
  var silenced = [];
  if (only) {
    for (i = 0; i < audible.length; i++) {
      if (audible[i] === only) continue;
      silenced.push(audible[i]);
    }
  }
  var wasStart = comp.workAreaStart, wasDur = comp.workAreaDuration;
  var partial = wasStart > 0.0000001 || wasDur < comp.duration - 0.0000001;
  var widened = false;
  var created = null, before = null;
  var failure = "";
  try {
    for (i = 0; i < silenced.length; i++) silenced[i].audioEnabled = false;
    if (range === "comp" && partial) {
      AELL_setWorkArea(comp, 0, comp.duration);
      widened = true;
    }
    before = AELL_layerIdSet(comp);
    AELL_keepSelection(comp, function () {
      // The command drops the new null next to whatever is selected;
      // with nothing selected it always lands at the top. keepSelection
      // hands the user's selection back afterwards.
      for (var k = 1; k <= comp.numLayers; k++) comp.layer(k).selected = false;
      comp.openInViewer();
      app.executeCommand(app.findMenuCommandId(AELL_A2K_CMD));
    });
    for (i = 1; i <= comp.numLayers; i++) {
      var L = comp.layer(i);
      var id = null;
      try { id = L.id; } catch (eI) { id = null; }
      if (id !== null && !before[id]) { created = L; break; }
    }
  } catch (eRun) {
    failure = eRun.toString();
  }
  // Put the comp back, whatever happened above.
  for (i = 0; i < silenced.length; i++) {
    try { silenced[i].audioEnabled = true; } catch (eR) {}
  }
  if (widened) {
    // The naive order (duration, then start) moved the user's work area
    // one frame every time the start landed on its own old end - see
    // AELL_setWorkArea, and the self-test step that caught it.
    try { AELL_setWorkArea(comp, wasStart, wasDur); } catch (eW) {}
  }
  if (failure) {
    return AELL_err("AE refused the audio conversion in '" + comp.name +
                    "': " + failure);
  }
  if (!created) {
    return AELL_err("AE's converter ran but created nothing in '" +
      comp.name + "' — it does that silently when the audible layers " +
      "carry no audio inside the range. Check that " +
      (only ? "'" + only.name + "'" : "the audio") + " actually plays.");
  }

  var wanted = args.name ? String(args.name) : created.name;
  var finalName = AELL_uniqueLayerNameExcept(comp, wanted, created);
  // AE reuses "Audio Amplitude" verbatim however many already exist, so
  // this rename is not cosmetic: two same-named layers make every later
  // link_property or expression reference resolve to whichever is higher.
  if (finalName !== created.name) created.name = finalName;

  var effects = [], keyCount = 0, peak = 0, firstT = null, lastT = null;
  var parade = created.property("ADBE Effect Parade");
  for (i = 1; i <= parade.numProperties; i++) {
    var fx = parade.property(i);
    effects.push(fx.name);
    if (fx.name !== AELL_A2K_MAIN) continue;
    var sl = fx.property(1);
    keyCount = sl.numKeys;
    for (var k = 1; k <= sl.numKeys; k++) {
      var v = sl.keyValue(k);
      if (v > peak) peak = v;
      if (firstT === null) firstT = sl.keyTime(k);
      lastT = sl.keyTime(k);
    }
  }

  var out = {
    layer: created.name, index: created.index,
    controlLayer: created.name,
    controlEffects: effects,
    keyframes: keyCount,
    rangeStart: firstT === null ? 0 : firstT,
    rangeEnd: lastT === null ? 0 : lastT,
    peak: Math.round(peak * 100) / 100,
    measured: only ? only.name : "whole comp mix",
    next: "Drive anything with link_property {layer: <target>, property: " +
          "<prop>, controlLayer: '" + created.name + "', controlEffect: '" +
          AELL_A2K_MAIN + "', scale: <n>}."
  };
  if (finalName !== wanted) {
    out.nameTaken = "'" + wanted + "' was already a layer in this comp — " +
      "this one is '" + finalName + "'. Use THIS name from here on.";
  }
  if (silenced.length > 0) {
    out.isolated = "AE's converter always reads the whole comp mix, so " +
      AELL_layerNamesOf(silenced) + " " +
      (silenced.length === 1 ? "was" : "were") + " muted for the " +
      "conversion and un-muted again.";
  }
  if (mutedByUser.length > 0) {
    out.mutedLayersIgnored = AELL_layerNamesOf(mutedByUser) +
      " " + (mutedByUser.length === 1 ? "is" : "are") + " muted and " +
      "contributed nothing.";
  }
  if (widened) {
    out.workArea = "The work area covered " + wasStart.toFixed(3) + "s-" +
      (wasStart + wasDur).toFixed(3) + "s and AE only converts inside it, " +
      "so it was widened to the whole comp and put back. Pass " +
      "range: 'workArea' to keep AE's own behaviour.";
  } else if (range === "workarea" && partial) {
    out.workArea = "Keyframes cover the WORK AREA only (" +
      wasStart.toFixed(3) + "s-" + (wasStart + wasDur).toFixed(3) +
      "s), as asked.";
  }
  if (peak === 0) {
    out.note = "Every keyframe is zero — the audible layers are silent " +
      "over this range.";
  }
  return AELL_okay(out);
};

AELL_TOOLS.grid_layout = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layers = [];
  var i;

  // Explicit layer list wins; else the user's live selection; else ALL
  // content layers in the comp ("arrange all layers in a grid") — nulls,
  // cameras and lights are riggers, not grid content, so they're skipped.
  if (AELLJSON.isArray(args.layers) && args.layers.length > 0) {
    for (i = 0; i < args.layers.length; i++) {
      layers.push(AELL_resolveLayer(comp, args.layers[i]));
    }
  } else {
    var sel = comp.selectedLayers;
    for (i = 0; i < sel.length; i++) layers.push(sel[i]);
    if (layers.length === 0) {
      for (i = 1; i <= comp.numLayers; i++) {
        var cand = comp.layer(i);
        var isNull = false;
        try { isNull = !!cand.nullLayer; } catch (eN) {}
        if (isNull) continue;
        if ((typeof CameraLayer === "function" &&
             cand instanceof CameraLayer) ||
            (typeof LightLayer === "function" &&
             cand instanceof LightLayer)) continue;
        layers.push(cand);
      }
      if (layers.length === 0) {
        return AELL_err("No layers to grid in '" + comp.name + "' — the " +
                        "comp has no content layers.");
      }
    }
  }

  var ctrlName = args.controlLayer ? String(args.controlLayer) : "GRID CTRL";

  // Never grid the control null itself, and keep a stable top-to-bottom
  // order regardless of selection order.
  var filtered = [];
  for (i = 0; i < layers.length; i++) {
    if (layers[i].name !== ctrlName) filtered.push(layers[i]);
  }
  layers = filtered;
  layers.sort(function (a, b) { return a.index - b.index; });

  var n = layers.length;
  if (n < 2) return AELL_err("Need at least 2 layers for a grid (got " + n + ")");
  var cols = args.columns > 0 ? Math.round(args.columns) : Math.ceil(Math.sqrt(n));
  if (cols > n) cols = n;
  var rows = Math.ceil(n / cols);

  // Control null: the grid centers on its position; two sliders drive
  // spacing. Reused when it already exists so re-running re-flows layers
  // into the same rig.
  var ctrl = null;
  try { ctrl = comp.layer(ctrlName); } catch (e) { ctrl = null; }
  if (!ctrl) {
    ctrl = AELL_keepSelection(comp, function () {
      return comp.layers.addNull(comp.duration);
    });
    ctrl.name = ctrlName;
    ctrl.property("ADBE Transform Group").property("ADBE Position")
        .setValue([comp.width / 2, comp.height / 2]);
  }
  var effects = ctrl.property("ADBE Effect Parade");
  function ensureSlider(name, value, forceSet) {
    var fx = effects.property(name);
    if (!fx) {
      fx = effects.addProperty("ADBE Slider Control");
      fx.name = name;
      fx.property(1).setValue(value);
    } else if (forceSet) {
      fx.property(1).setValue(value);
    }
    return fx;
  }
  var defX = args.spacingX > 0 ? args.spacingX
    : Math.round(comp.width / (cols + 1));
  var defY = args.spacingY > 0 ? args.spacingY
    : Math.round(comp.height / (rows + 1));
  ensureSlider("Grid X Spacing", defX, args.spacingX > 0);
  ensureSlider("Grid Y Spacing", defY, args.spacingY > 0);
  ensureSlider("Grid Columns", cols, args.columns > 0);

  var escCtrl = AELL_escapeExprName(ctrl.name);
  var placed = [];
  for (i = 0; i < n; i++) {
    var layer = layers[i];
    var col = i % cols;
    var row = Math.floor(i / cols);
    var posProp = layer.property("ADBE Transform Group")
                       .property("ADBE Position");
    // 3D-ness comes from the layer SWITCH — the scripting API pads a 2D
    // layer's position to [x, y, 0], but the EXPRESSION value is 2D
    // there, so value[2] would be an out-of-range subscript (the bug
    // that killed every grid rig in the field).
    var is3d = false;
    try { is3d = !!layer.threeDLayer; } catch (e3d) {}
    // The layer computes its own row/col from the "Grid Columns" slider,
    // so dragging it re-flows the whole grid live. Vars hold plain
    // NUMBERS only; every layer/effect lookup stays inline-chained (the
    // pickwhip-classic form that evaluates in both expression engines).
    var ref = 'thisComp.layer("' + escCtrl + '")';
    var expr =
      'var cols = Math.max(1, Math.min(' + n + ', Math.round(' + ref +
        '.effect("Grid Columns")(1))));\n' +
      'var col = ' + i + ' % cols;\n' +
      'var row = Math.floor(' + i + ' / cols);\n' +
      'var rows = Math.ceil(' + n + ' / cols);\n' +
      '[' + ref + '.transform.position[0] + (col - (cols - 1) / 2) * ' +
      ref + '.effect("Grid X Spacing")(1), ' +
      ref + '.transform.position[1] + (row - (rows - 1) / 2) * ' +
      ref + '.effect("Grid Y Spacing")(1)' +
      (is3d ? ', value[2]' : '') + ']';
    var err = AELL_setExpr(posProp, expr);
    if (err) {
      // Full diagnostics — if AE still rejects this, the error must show
      // exactly what was evaluated and under which engine.
      var engine = "";
      try { engine = String(app.project.expressionEngine || ""); }
      catch (eE) {}
      return AELL_err("Grid expression rejected on '" + layer.name +
        "': " + err + (engine ? " [engine: " + engine + "]" : "") +
        " [expression was: " + expr + "]");
    }
    placed.push({ layer: layer.name, row: row, col: col });
  }
  return AELL_okay({
    control: ctrl.name, columns: cols, rows: rows,
    sliders: ["Grid X Spacing", "Grid Y Spacing", "Grid Columns"],
    initialSpacing: [defX, defY], placed: placed,
    note: "Move '" + ctrl.name + "' to move the whole grid; its sliders " +
          "control X/Y spacing AND column count live"
  });
};

AELL_TOOLS.apply_expression_preset = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var prop = AELL_resolveProperty(layer, args.property);
  if (!prop.canSetExpression) {
    return AELL_err("Property cannot take an expression: " + args.property);
  }

  // Resolve an optional {layer, effect} control reference to a scalar
  // expression source, so sliders can drive preset parameters.
  function ctrlRef(c) {
    var l = AELL_resolveLayer(comp, c.layer);
    var effects = l.property("ADBE Effect Parade");
    var fx = effects && c.effect ? effects.property(c.effect) : null;
    if (!fx) {
      throw new Error("Control not found: '" + c.effect + "' on layer '" +
                      String(c.layer) + "'. Use add_control first.");
    }
    return 'thisComp.layer("' + AELL_escapeExprName(l.name) +
           '").effect("' + AELL_escapeExprName(fx.name) + '")(1)';
  }

  var preset = String(args.preset || "").toLowerCase();
  var expr = null;
  var isArrayTarget = AELLJSON.isArray(prop.value);

  if (preset === "wiggle") {
    var f = args.freqControl ? ctrlRef(args.freqControl)
      : (typeof args.frequency === "number" ? args.frequency : 2);
    var a = args.ampControl ? ctrlRef(args.ampControl)
      : (typeof args.amplitude === "number" ? args.amplitude : 20);
    expr = "wiggle(" + f + ", " + a + ");";
  } else if (preset === "loop_cycle") {
    expr = 'loopOut("cycle");';
  } else if (preset === "loop_pingpong") {
    expr = 'loopOut("pingpong");';
  } else if (preset === "loop_offset") {
    expr = 'loopOut("offset");';
  } else if (preset === "time_linear") {
    if (isArrayTarget) {
      return AELL_err("time_linear works on scalar properties (rotation, " +
                      "opacity, slider). For position drift, keyframe it " +
                      "or rig a slider with link_property.");
    }
    var r = args.rateControl ? ctrlRef(args.rateControl)
      : (typeof args.rate === "number" ? args.rate : 100);
    expr = "value + time * (" + r + ");";
  } else {
    return AELL_err("Unknown preset '" + args.preset + "'. Available: " +
      "wiggle, loop_cycle, loop_pingpong, loop_offset, time_linear");
  }

  var err = AELL_setExpr(prop, expr);
  if (err) {
    return AELL_err("AE rejected the '" + preset + "' expression: " + err);
  }
  return AELL_okay({ layer: layer.name, property: args.property,
                     preset: preset, expression: expr });
};

AELL_TOOLS.apply_effect = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  if (!args.effect) return AELL_err("'effect' is required");
  var effects = layer.property("ADBE Effect Parade");
  if (!effects) return AELL_err("This layer type cannot take effects");
  if (!effects.canAddProperty(args.effect)) {
    return AELL_err("Effect not available: " + args.effect);
  }
  var fx = effects.addProperty(args.effect);
  var params = [];
  for (var i = 1; i <= fx.numProperties; i++) {
    var p = fx.property(i);
    if (p && p.name) params.push(p.name);
  }
  return AELL_okay({ layer: layer.name, effect: fx.name,
                     matchName: fx.matchName, params: params });
};

AELL_TOOLS.set_effect_param = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  if (!args.effect || !args.param) {
    return AELL_err("'effect' and 'param' are required");
  }
  var effects = layer.property("ADBE Effect Parade");
  if (!effects) return AELL_err("This layer type cannot take effects");
  var fx = effects.property(args.effect);
  if (!fx) return AELL_err("Effect not found on layer: " + args.effect);
  var p = fx.property(args.param);
  if (!p) return AELL_err("Parameter not found: " + args.param);
  var warn;
  try {
    warn = AELL_writeValue(p, args.value, args.effect + "/" + p.name);
  } catch (eP) {
    return AELL_err(eP.message);
  }
  var out = { layer: layer.name, effect: fx.name, param: p.name,
              value: args.value };
  if (warn) { out.applied = false; out.warning = warn; }
  return AELL_okay(out);
};

/* First free name of the form "base", "base 2", "base 3", … in a comp. */
function AELL_uniqueLayerName(comp, base) {
  var taken = {};
  for (var i = 1; i <= comp.numLayers; i++) taken[comp.layer(i).name] = true;
  if (!taken[base]) return base;
  var k = 2;
  while (taken[base + " " + k]) k++;
  return base + " " + k;
}

AELL_TOOLS.duplicate_layer = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var count = args.count > 0 ? Math.round(Number(args.count)) : 1;
  if (count > 100) return AELL_err("'count' is capped at 100 copies");
  var base = args.name ? String(args.name) : layer.name;
  var names = [];
  var autoNumbered = false;
  var made = [];
  for (var i = 0; i < count; i++) {
    var dup = layer.duplicate();
    // Never leave two layers with the same name — duplicate names break
    // every name-based reference (expressions, later tool calls).
    var nm = AELL_uniqueLayerName(comp, base);
    if (nm !== base) autoNumbered = true;
    dup.name = nm;
    names.push(nm);
    made.push(dup);
  }
  // AE inserts duplicates ABOVE the original, stranding it at the bottom
  // of the pile — keep the ORIGINAL on top with copies in order below.
  if (typeof layer.moveAfter === "function") {
    var prev = layer;
    for (var m = 0; m < made.length; m++) {
      made[m].moveAfter(prev);
      prev = made[m];
    }
  }
  return AELL_okay({ created: count, duplicatedFrom: layer.name,
    names: (names.length > 12 ? names.slice(0, 12) : names).join(", ") +
           (names.length > 12 ? ", …" : ""),
    totalLayersInComp: comp.numLayers,
    note: autoNumbered
      ? "Copies auto-numbered to keep layer names unique"
      : "" });
};

/*
 * Cut a layer into fixed-length chunks, each on its own layer trimmed to
 * its own time window — the "split into staggered pieces" edit, done with
 * host-side math in a single call. Chunk i keeps the original startTime, so
 * pieces play back seamlessly end-to-end without overlap; offsetPerChunk
 * additionally slides chunk i by i*offset seconds for spaced staggering.
 * Cuts land on whole COMP frames: AE accepts a sub-frame in/out pair and
 * then renders no frames at all for it, so unsnapped boundaries produce
 * pieces of arbitrary frame lengths and, when short enough, invisible ones.
 */
AELL_TOOLS.split_layer_into_chunks = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var inP = layer.inPoint;
  var outP = layer.outPoint;
  var span = outP - inP;
  if (span <= 0) {
    return AELL_err("Layer '" + layer.name + "' has no duration — " +
                    "nothing to split");
  }
  // A cut is only real if the piece it makes contains a frame. AE accepts
  // sub-frame inPoint/outPoint without complaint (measured: an in/out pair
  // between two frames renders NOTHING), so the frame grid is the unit
  // this tool has to work in.
  var fd = (comp.frameDuration > 0) ? Number(comp.frameDuration) : 0;
  var fps = fd ? Math.round(1 / fd * 100) / 100 : 0;
  var n, chunk;
  if (args.chunks > 0) {
    // Exact piece count: the host does the division, not the model.
    n = Math.round(Number(args.chunks));
    if (n < 2) return AELL_err("'chunks' must be at least 2");
    if (n > 60) {
      return AELL_err("'chunks' is capped at 60 (asked for " + n + ")");
    }
    chunk = span / n;
    if (fd && chunk < fd) {
      return AELL_err("Comp '" + comp.name + "' runs at " + fps + " fps (" +
        (Math.round(fd * 10000) / 10000) + "s per frame), so " + n +
        " chunks of a " + (Math.round(span * 100) / 100) + "s span would be " +
        (Math.round(chunk * 10000) / 10000) + "s each — shorter than one " +
        "frame, and a piece that holds no frame renders nothing at all. At " +
        "most " + Math.floor(span / fd) + " chunks fit; ask for that many " +
        "or fewer.");
    }
  } else {
    chunk = args.chunkSeconds > 0 ? Number(args.chunkSeconds) : 5;
    if (span <= chunk) {
      return AELL_err("Layer '" + layer.name + "' is only " +
        (Math.round(span * 100) / 100) + "s from inPoint to outPoint — " +
        "nothing to split at " + chunk + "s chunks");
    }
    if (fd && chunk < fd) {
      return AELL_err("chunkSeconds " + chunk + " is shorter than one frame " +
        "of comp '" + comp.name + "' (" + (Math.round(fd * 10000) / 10000) +
        "s at " + fps + " fps) — a piece that holds no frame renders nothing " +
        "at all. Use at least " + (Math.round(fd * 10000) / 10000) + ".");
    }
    n = Math.ceil(span / chunk - 0.000001);
    if (n > 60) {
      return AELL_err("Would create " + n + " chunks (cap 60) — use a " +
        "larger chunkSeconds, or pass {chunks: N} for exactly N pieces");
    }
  }
  var offset = typeof args.offsetPerChunk === "number"
    ? args.offsetPerChunk : 0;

  // Cut ON frames. Unsnapped boundaries still tile without gaps, but they
  // land mid-frame, so the pieces come out arbitrary lengths in frames and
  // the edit cannot be reproduced or nudged by hand. The layer's own first
  // in and last out are kept verbatim — those are the user's, not ours.
  var i, bounds = [inP];
  for (i = 1; i < n; i++) {
    var b = inP + i * chunk;
    bounds.push(fd ? Math.round(b / fd) * fd : b);
  }
  bounds.push(outP);
  if (fd) {
    // Snapping (and a short final remainder) can still collapse a piece to
    // less than a frame. Drop those cut points instead of shipping layers
    // that render nothing.
    var kept = [bounds[0]];
    for (i = 1; i < bounds.length - 1; i++) {
      if (bounds[i] - kept[kept.length - 1] >= fd - 1e-9) kept.push(bounds[i]);
    }
    while (kept.length > 1 && outP - kept[kept.length - 1] < fd - 1e-9) {
      kept.pop();
    }
    kept.push(outP);
    bounds = kept;
  }
  var dropped = n - (bounds.length - 1);
  n = bounds.length - 1;
  if (n < 2) {
    return AELL_err("Layer '" + layer.name + "' is only " +
      Math.round(span / fd) + " frame(s) long at " + fps + " fps — there is " +
      "no place to cut it that leaves two pieces with frames in them");
  }

  // Duplicate FIRST (each copy inherits the full span), then trim each
  // copy to its own window. The original becomes chunk 1.
  var pieces = [layer];
  for (i = 1; i < n; i++) pieces.push(layer.duplicate());

  var baseName = layer.name;
  for (i = 0; i < n; i++) {
    var piece = pieces[i];
    piece.inPoint = bounds[i];
    piece.outPoint = bounds[i + 1];
    if (offset !== 0) piece.startTime = piece.startTime + offset * i;
    piece.name = baseName + " chunk " + (i + 1);
  }

  // Stack the chunks deliberately — duplicates are born ABOVE the
  // original, which would otherwise strand chunk 1 at the bottom.
  // Ascending (default): later chunks sit HIGHER in the stack (chunk 1 at
  // the bottom). Descending: chunk 1 on top.
  var descending = /^desc/i.test(String(args.order || ""));
  if (pieces[0].moveAfter && pieces[0].moveBefore) {
    for (i = 1; i < n; i++) {
      if (descending) pieces[i].moveAfter(pieces[i - 1]);
      else pieces[i].moveBefore(pieces[i - 1]);
    }
  }

  // Leave exactly the chunks selected, so a follow-up command ("stagger
  // them") targets the batch without the user re-selecting anything.
  for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
  for (i = 0; i < n; i++) pieces[i].selected = true;

  // Report only a sample of a big batch — a huge JSON result would eat
  // the model's context window.
  var made = [];
  for (i = 0; i < n && (n <= 8 || i < 3); i++) {
    made.push({ layer: pieces[i].name, index: pieces[i].index,
                inPoint: Math.round(pieces[i].inPoint * 10000) / 10000,
                outPoint: Math.round(pieces[i].outPoint * 10000) / 10000 });
  }
  var note = offset === 0
    ? "Chunks play seamlessly end-to-end on separate layers (no overlap)"
    : "Each chunk additionally slid by " + offset + "s per index";
  note += "; stacked " + (descending ? "descending" : "ascending") +
          " and now SELECTED";
  if (fd) note += "; cut on whole frames at " + fps + " fps";
  if (dropped > 0) {
    note += "; " + dropped + " cut point(s) dropped because the piece would " +
            "have held no frame";
  }
  if (n > 8) {
    note += "; listing 3 of " + n + " pieces (all named '" + baseName +
            " chunk <i>')";
  }
  return AELL_okay({ chunks: n,
                     chunkSeconds: Math.round(chunk * 1000) / 1000,
                     pieces: made, note: note });
};

// ---------------------------------------------------------- curve tools

/*
 * Y value of a CSS-style cubic bezier (0,0)-(x1,y1)-(x2,y2)-(1,1) at
 * horizontal position x, via bisection on the curve parameter (x1/x2 are
 * clamped to [0,1] by the callers' UI, so X(u) is monotonic).
 */
function AELL_bezierY(x1, y1, x2, y2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  function X(u) {
    var v = 1 - u;
    return 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u;
  }
  var lo = 0;
  var hi = 1;
  var u = x;
  for (var i = 0; i < 40; i++) {
    var cx = X(u);
    if (Math.abs(cx - x) < 0.00001) break;
    if (cx < x) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  var w = 1 - u;
  return 3 * w * w * u * y1 + 3 * w * u * u * y2 + u * u * u;
}

/* Round to 3 decimals -- seconds reported to the model stay readable. */
function AELL_r3(v) { return Math.round(v * 1000) / 1000; }

/*
 * A number from an arg that may arrive quoted. Small models write
 * {"step": "0.5"} often enough that a strict typeof check dropped the
 * argument silently, which is the one failure mode this codebase refuses
 * to have. Returns null when there is no usable number.
 */
function AELL_numArg(v) {
  if (typeof v === "number") return isNaN(v) ? null : v;
  if (typeof v === "string" && v !== "" && !isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}

function AELL_bezierArgs(args) {
  var b = args.bezier;
  if (b === null || typeof b === "undefined") return [0, 0, 1, 1]; // linear
  if (!AELLJSON.isArray(b) || b.length < 4) {
    throw new Error("'bezier' must be [x1, y1, x2, y2] (CSS cubic-bezier)");
  }
  return [Math.max(0, Math.min(1, Number(b[0]))), Number(b[1]),
          Math.max(0, Math.min(1, Number(b[2]))), Number(b[3])];
}

/*
 * ExtendScript's Array.sort is NOT stable, so equal keys come back in an
 * arbitrary order that is not even repeatable between calls (measured in
 * AE 2026: five layers all at inPoint 0 sorted to P2,P3,P4,P5,P1 on one
 * call and P4,P3,P2,P1,P5 on the next). Decorate with the original slot
 * so ties keep the order they arrived in.
 */
function AELL_stableSort(arr, cmp) {
  var deco = [];
  var i;
  for (i = 0; i < arr.length; i++) deco.push({ v: arr[i], i: i });
  deco.sort(function (a, b) {
    var c = cmp(a.v, b.v);
    return c !== 0 ? c : (a.i - b.i);
  });
  for (i = 0; i < deco.length; i++) arr[i] = deco[i].v;
  return arr;
}

/*
 * Compare layer names the way a human reads them: digit runs count as
 * numbers, everything else as text. AE layer names are numbered far more
 * often than they are alphabetic -- split_layer_into_chunks alone emits
 * "X 1".."X 30" -- and a plain string compare buries 10..30 between 1
 * and 2.
 */
function AELL_nameCompare(sa, sb) {
  var ra = String(sa).toLowerCase().match(/[0-9]+|[^0-9]+/g) || [];
  var rb = String(sb).toLowerCase().match(/[0-9]+|[^0-9]+/g) || [];
  var n = Math.min(ra.length, rb.length);
  for (var i = 0; i < n; i++) {
    var x = ra[i], y = rb[i];
    if (/^[0-9]/.test(x) && /^[0-9]/.test(y)) {
      var dx = parseFloat(x), dy = parseFloat(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (ra.length !== rb.length) return ra.length < rb.length ? -1 : 1;
  // Case-insensitive tie: fall back to the raw strings so the order is
  // total and repeatable rather than left to the sort.
  var a0 = String(sa), b0 = String(sb);
  return a0 < b0 ? -1 : (a0 > b0 ? 1 : 0);
}

/* Resolve target layers: explicit list, else the user's selection. */
function AELL_targetLayers(comp, args) {
  var layers = [];
  var i;
  var explicit = AELLJSON.isArray(args.layers) && args.layers.length > 0;
  if (explicit) {
    for (i = 0; i < args.layers.length; i++) {
      layers.push(AELL_resolveLayer(comp, args.layers[i]));
    }
  } else {
    var sel = comp.selectedLayers;
    for (i = 0; i < sel.length; i++) layers.push(sel[i]);
  }
  if (layers.length < 2) {
    throw new Error("Need at least 2 layers (got " + layers.length +
                    ") — select them in AE or pass {layers: [...]}");
  }
  // An EXPLICIT list is ALREADY an order: the caller named the layers in
  // the sequence they want the values handed out in. Re-sorting it
  // silently reassigns them, and when the sort key ties — every layer
  // at inPoint 0, which is the normal state of a grid — the result is
  // arbitrary. Sort a named list only when 'order' asks for it.
  var wanted = (typeof args.order === "string" && args.order !== "")
    ? args.order : (explicit ? "" : "in");
  if (wanted === "") return layers;
  var order = String(wanted);
  // User-facing aliases: 'ascending' assigns the earliest slot to the
  // BOTTOM layer (bars staircase upward); 'descending' to the top layer.
  if (/^asc/i.test(order)) order = "reverse";
  else if (/^desc/i.test(order)) order = "stack";
  if (order === "stack") {
    AELL_stableSort(layers, function (a, b) { return a.index - b.index; });
  } else if (order === "reverse") {
    AELL_stableSort(layers, function (a, b) { return b.index - a.index; });
  } else {   // "in": by current inPoint — natural for chunked sequences
    AELL_stableSort(layers, function (a, b) { return a.inPoint - b.inPoint; });
  }
  return layers;
}

/*
 * Restack layers WITHOUT touching their timing. Ascending (default):
 * later start times sit higher in the stack, so the timeline bars build
 * a staircase going UP; descending: earliest on top, staircase going
 * down. Targets the explicit list, else the selection, else every layer
 * in the comp.
 */
AELL_TOOLS.reorder_layers = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layers = [];
  var i;
  if (AELLJSON.isArray(args.layers) && args.layers.length > 0) {
    for (i = 0; i < args.layers.length; i++) {
      layers.push(AELL_resolveLayer(comp, args.layers[i]));
    }
  } else {
    var sel = comp.selectedLayers;
    for (i = 0; i < sel.length; i++) layers.push(sel[i]);
    if (layers.length === 0) {
      for (i = 1; i <= comp.numLayers; i++) layers.push(comp.layer(i));
    }
  }
  if (layers.length < 2) {
    return AELL_err("Need at least 2 layers to reorder (got " +
                    layers.length + ")");
  }
  var by = String(args.by || "startTime");
  function keyOf(L) {
    if (by === "inPoint") return L.inPoint;
    return L.startTime;
  }
  var descending = /^desc/i.test(String(args.order || ""));
  var sorted = layers.slice(0);
  AELL_stableSort(sorted, function (a, b) {
    var c;
    if (by === "name") {
      c = AELL_nameCompare(a.name, b.name);
    } else {
      var ka = keyOf(a), kb = keyOf(b);
      c = ka < kb ? -1 : (ka > kb ? 1 : 0);
    }
    if (c !== 0) return c;
    // Equal keys must not shuffle the stack. 'sorted' is bottom-first for
    // ascending (it gets reversed below) and top-first for descending, so
    // the tie-break flips with it to leave tied layers exactly where they
    // already sit instead of at the sort's whim.
    return descending ? (a.index - b.index) : (b.index - a.index);
  });
  // Top-first sequence: ascending puts the LATEST key on top.
  var topFirst = descending ? sorted : sorted.slice(0).reverse();
  // Snapshot every slot first: pulling a SUBSET together shoves whatever
  // sat between its members out of the way, and a caller who only named
  // three layers deserves to be told the other two moved.
  var all = [], wasAt = [];
  for (i = 1; i <= comp.numLayers; i++) {
    all.push(comp.layer(i));
    wasAt.push(i);
  }
  // Anchor the cluster where its topmost member currently sits.
  var top = layers[0];
  for (i = 1; i < layers.length; i++) {
    if (layers[i].index < top.index) top = layers[i];
  }
  if (topFirst[0] !== top) topFirst[0].moveBefore(top);
  for (i = 1; i < topFirst.length; i++) {
    topFirst[i].moveAfter(topFirst[i - 1]);
  }
  var stacked = [];
  for (i = 0; i < topFirst.length && i < 12; i++) stacked.push(topFirst[i].name);
  // Read the landing slots back from AE instead of trusting the moves.
  var firstIdx = topFirst[0].index;
  var lastIdx = topFirst[topFirst.length - 1].index;
  var displaced = 0, m, isTarget;
  for (i = 0; i < all.length; i++) {
    if (all[i].index === wasAt[i]) continue;
    isTarget = false;
    for (m = 0; m < layers.length; m++) {
      if (layers[m] === all[i]) { isTarget = true; break; }
    }
    if (!isTarget) displaced++;
  }
  var res = { layers: layers.length, by: by,
    order: descending ? "descending" : "ascending",
    topToBottom: stacked.join(" | ") + (topFirst.length > 12 ? " | …" : ""),
    slots: firstIdx + ".." + lastIdx,
    note: "Stacking changed only — start times untouched" };
  if (lastIdx - firstIdx + 1 !== topFirst.length) {
    res.warning = "Reordered layers did NOT land in one contiguous block " +
      "(slots " + firstIdx + ".." + lastIdx + " for " + topFirst.length +
      " layers) — read the comp back with get_comp_details";
  }
  if (displaced > 0) {
    res.displaced = displaced;
    res.note = "Stacking changed only — start times untouched; " +
      displaced + " layer(s) nobody asked about were pushed aside to make " +
      "the reordered ones contiguous";
  }
  return AELL_okay(res);
};

AELL_TOOLS.stagger_layers = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var bez = AELL_bezierArgs(args);
  var layers = AELL_targetLayers(comp, args);
  var n = layers.length;
  var fd = 0;
  try { fd = Number(comp.frameDuration) || 0; } catch (eFD) { fd = 0; }

  // TWO units, because the field proved one was not enough. 'spread' is
  // the TOTAL span of the stagger; 'step'/'stepFrames' is the gap BETWEEN
  // consecutive layers. Measured through the chat probe: "stagger them 4
  // frames apart" arrived as spread 0.133 on nine layers -- 0.0166s each,
  // half a frame, every layer effectively on the same frame -- and this
  // tool reported nine cheerful placements. Designers speak in gaps, so
  // the gap is now sayable, the two units are mutually exclusive, and a
  // spread that works out to under a frame per layer says so out loud.
  var spread = AELL_numArg(args.spread);
  if (spread !== null && !(spread > 0)) spread = null;
  var step = AELL_numArg(args.step);
  var stepFrames = AELL_numArg(args.stepFrames);
  var notes = [];

  if (step !== null && stepFrames !== null) {
    return AELL_err("Pass 'step' (seconds between consecutive layers) or " +
      "'stepFrames' (frames between consecutive layers), not both");
  }
  if (stepFrames !== null) {
    if (!fd) {
      return AELL_err("'stepFrames' needs the comp's frame duration, and " +
        "'" + comp.name + "' did not report one -- pass 'step' in seconds");
    }
    step = stepFrames * fd;
  }
  if (step !== null && spread !== null) {
    return AELL_err("'spread' is the TOTAL span and 'step' is the gap " +
      "BETWEEN consecutive layers -- pass one, not both. For these " + n +
      " layers, spread " + AELL_r3(step * (n - 1)) + " == step " +
      AELL_r3(step) + ".");
  }
  var stepMode = (step !== null);

  // No unit at all -> fill the comp's WORK AREA (fall back to the full
  // comp duration), so bare requests need no numbers.
  var usedWorkArea = false;
  if (!stepMode && spread === null) {
    if (comp.workAreaDuration > 0) {
      spread = Number(comp.workAreaDuration);
      usedWorkArea = true;
    } else if (comp.duration > 0) {
      spread = Number(comp.duration);
    } else {
      return AELL_err("'spread' (TOTAL seconds) or 'step' (seconds " +
        "between consecutive layers) is required");
    }
  }

  var startAt = AELL_numArg(args.startAt);
  var base;
  if (startAt !== null) {
    base = startAt;
  } else if (usedWorkArea) {
    base = Number(comp.workAreaStart) || 0;
  } else {
    base = layers[0].startTime;
    for (var j = 1; j < layers.length; j++) {
      if (layers[j].startTime < base) base = layers[j].startTime;
    }
  }

  var placed = [];
  for (var i = 0; i < n; i++) {
    var t;
    if (stepMode) {
      t = base + i * step;
    } else {
      var y = AELL_bezierY(bez[0], bez[1], bez[2], bez[3], i / (n - 1));
      t = base + y * spread;
    }
    layers[i].startTime = t;
    placed.push({ layer: layers[i].name,
                  startTime: AELL_r3(layers[i].startTime) });
  }

  var total = stepMode ? step * (n - 1) : spread;
  var gap = total / (n - 1);
  var res = { layers: n, spread: AELL_r3(total), startAt: AELL_r3(base),
              bezier: bez, placed: placed };
  if (stepMode) {
    res.step = AELL_r3(step);
    if (fd) res.stepFrames = Math.round((step / fd) * 100) / 100;
    var custom = AELLJSON.isArray(args.bezier) &&
      !(bez[0] === 0 && bez[1] === 0 && bez[2] === 1 && bez[3] === 1);
    if (custom) {
      notes.push("'step' spaces the layers EVENLY, so the bezier was not " +
        "used -- pass 'spread' instead to stagger along a curve");
    }
    if (step === 0) {
      notes.push("step 0 -- every layer starts at " + AELL_r3(base) + "s");
    } else if (fd && Math.abs(step) < fd) {
      notes.push("step " + AELL_r3(step) + "s is under ONE frame (" +
        AELL_r3(fd) + "s at " + comp.frameRate + " fps), so the layers " +
        "all land on the same frame");
    }
  } else {
    res.perLayer = AELL_r3(gap);
    if (fd) res.perLayerFrames = Math.round((gap / fd) * 100) / 100;
    if (fd && Math.abs(gap) < fd) {
      notes.push("'spread' is the TOTAL span, so " + n + " layers across " +
        AELL_r3(total) + "s land " + AELL_r3(gap / fd) +
        " frame(s) apart -- under one frame, i.e. all on the same frame. " +
        "If you meant " + AELL_r3(total) + "s BETWEEN layers, pass step: " +
        AELL_r3(total) + " (or stepFrames: " +
        (Math.round((total / fd) * 100) / 100) + ") instead of spread.");
    }
  }
  if (usedWorkArea) res.usedWorkArea = true;
  if (notes.length) res.note = notes.join(". ");
  return AELL_okay(res);
};

var AELL_DIST_PROPS = {
  opacity:    { path: "opacity",  kind: "scalar" },
  rotation:   { path: "rotation", kind: "scalar" },
  scale:      { path: "scale",    kind: "uniform" },   // [v, v]
  position_x: { path: "position", kind: "component", axis: 0 },
  position_y: { path: "position", kind: "component", axis: 1 }
};

AELL_TOOLS.distribute_property = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var bez = AELL_bezierArgs(args);
  var layers = AELL_targetLayers(comp, args);
  var spec = AELL_DIST_PROPS[String(args.property || "")];
  if (!spec) {
    return AELL_err("'property' must be one of: opacity, rotation, scale, " +
                    "position_x, position_y");
  }
  // Two modes: from/to sweep along the bezier, or fixed 'step' between
  // consecutive layers (equidistant — no curve involved).
  var useStep = typeof args.step === "number";
  if (!useStep &&
      (typeof args.from !== "number" || typeof args.to !== "number")) {
    return AELL_err("Pass 'from' and 'to' (curve sweep), or 'step' for " +
                    "equidistant spacing (numbers; scale/opacity in " +
                    "percent, position in pixels)");
  }
  var stepStart = null;
  if (useStep) {
    if (typeof args.from === "number") {
      stepStart = args.from;
    } else {
      // Anchor at the first layer's current value on that property/axis.
      var p0 = AELL_resolveProperty(layers[0], spec.path);
      var v0 = p0.value;
      stepStart = spec.kind === "scalar" ? v0
        : (spec.kind === "uniform" ? v0[0] : v0[spec.axis]);
    }
  }
  var n = layers.length;
  var applied = [], skipped = [], overridden = [], overriddenWhy = "";
  var cleared = [];
  for (var i = 0; i < n; i++) {
    var v;
    if (useStep) {
      v = stepStart + i * Number(args.step);
    } else {
      var y = AELL_bezierY(bez[0], bez[1], bez[2], bez[3], i / (n - 1));
      v = args.from + y * (args.to - args.from);
    }
    var prop = AELL_resolveProperty(layers[i], spec.path);
    var target;
    if (spec.kind === "scalar") {
      target = v;
    } else if (spec.kind === "uniform") {
      var cur = prop.value;
      target = [v, v];
      if (cur.length > 2) target.push(cur[2]);
    } else {   // component
      var pos = prop.value;
      target = [];
      for (var d = 0; d < pos.length; d++) target.push(pos[d]);
      target[spec.axis] = v;
    }
    // One bad layer must not abort the rest: a keyframed or driven
    // property is reported and skipped, so the caller learns WHICH
    // layers were left out rather than getting a partial spread that
    // claims to have covered everything.
    //
    // A layer whose write was swallowed by an expression is NOT applied,
    // however happily AE accepted the setValue. Measured in the field: a
    // 3x3 grid_layout rig drives Position, this tool then reported nine
    // `applied` rows of x values the comp never showed, and the honest
    // half of the answer sat in a `warnings` array long enough to be cut
    // by the panel's per-result cap. Names only here — nine full
    // sentences is exactly what got truncated.
    try {
      var w = AELL_writeValue(prop, target, layers[i].name + "/" +
                              String(args.property));
      // The sanctioned override: the user explicitly asked for these
      // values, so a rig that swallows them loses. Surgical on purpose —
      // only an expression that DEMONSTRABLY ate the write is removed
      // (a pass-through like `value + wiggle(2,30)` never trips `w`, so
      // it survives). Without the flag the layer is reported, not moved:
      // the escalation is a deliberate re-call, never temperature.
      if (w && args.clearExpressions === true) {
        prop.expression = "";
        prop.setValue(target);
        cleared.push(layers[i].name);
        w = "";
      }
      if (w) {
        overridden.push(layers[i].name);
        if (!overriddenWhy) overriddenWhy = w;
      } else {
        applied.push({ layer: layers[i].name,
                       value: Math.round(v * 100) / 100 });
      }
    } catch (eD) {
      skipped.push(layers[i].name + ": " +
        (eD && eD.message ? eD.message : String(eD)));
    }
  }
  var res = { property: args.property, layers: n, applied: applied };
  var notes = [];
  if (skipped.length) {
    res.skipped = skipped;
    notes.push(skipped.length + " of " + n + " layer(s) were NOT changed");
  }
  if (overridden.length) {
    res.overriddenByExpression = overridden;
    notes.push(overridden.length + " of " + n + " layer(s) did NOT move " +
      "because an expression drives " + String(args.property) + " on them: " +
      overriddenWhy + " If the user explicitly asked for these values, " +
      "re-call with clearExpressions: true AND the SAME " + n +
      " layer(s) as this call — from/to is divided across the layers you " +
      "send, so re-calling with only the " + overridden.length +
      " listed here re-spaces those and strands the rest");
  }
  if (cleared.length) {
    res.expressionsCleared = cleared;
    notes.push("clearExpressions removed the expression driving " +
      String(args.property) + " on " + cleared.length +
      " layer(s) so the values could land — tell the user their rig on " +
      "those layers is gone");
  }
  if (notes.length) res.note = notes.join(". ");
  return AELL_okay(res);
};

/* Ease every requested key pair on one property. Returns pair count. */
function AELL_easeProp(prop, bez, keyIndex, allPairs) {
  if (prop.numKeys < 2) {
    throw new Error("has " + prop.numKeys + " keyframe(s) — need at " +
                    "least 2 to ease between");
  }
  var pairs = [];
  if (allPairs || typeof keyIndex !== "number") {
    for (var p = 1; p < prop.numKeys; p++) pairs.push(p);
  } else {
    if (keyIndex < 1 || keyIndex >= prop.numKeys + 0) {
      throw new Error("'keyIndex' must be 1.." + (prop.numKeys - 1));
    }
    pairs.push(Math.round(keyIndex));
  }

  // Temporal-ease dimensionality: spatial props take 1 ease, everything
  // else one per SCRIPTING value component — the PADDED count. AE demands
  // 3 ease elements for Scale even on 2D layers; expressions are 2D
  // there, eases are not. Two different dimension rules.
  var isSpatial = false;
  try {
    var mn = prop.matchName;
    isSpatial = (mn === "ADBE Position" || mn === "ADBE Anchor Point");
  } catch (e) {}
  var sample = prop.value;
  var dims = AELLJSON.isArray(sample) ? (isSpatial ? 1 : sample.length) : 1;

  function clampInf(v) { return Math.max(0.1, Math.min(100, v)); }

  for (var q = 0; q < pairs.length; q++) {
    var k = pairs[q];
    var t1 = prop.keyTime(k);
    var t2 = prop.keyTime(k + 1);
    var v1 = prop.keyValue(k);
    var v2 = prop.keyValue(k + 1);
    var dt = Math.max(0.0001, t2 - t1);

    var outEase = [];
    var inEase = [];
    for (var d = 0; d < dims; d++) {
      var a = AELLJSON.isArray(v1) ? v1[d] : v1;
      var b = AELLJSON.isArray(v2) ? v2[d] : v2;
      if (isSpatial) {
        // spatial speed uses the full positional delta
        var dd = 0;
        for (var s = 0; s < v1.length; s++) {
          dd += (v2[s] - v1[s]) * (v2[s] - v1[s]);
        }
        a = 0; b = Math.sqrt(dd);
      }
      var avg = Math.abs(b - a) / dt;
      var outSpeed = bez[0] === 0 ? 0 : (bez[1] / bez[0]) * avg;
      var inSpeed = bez[2] === 1 ? 0 : ((1 - bez[3]) / (1 - bez[2])) * avg;
      outEase.push(new KeyframeEase(outSpeed, clampInf(bez[0] * 100)));
      inEase.push(new KeyframeEase(inSpeed, clampInf((1 - bez[2]) * 100)));
    }

    prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER,
                                   KeyframeInterpolationType.BEZIER);
    prop.setInterpolationTypeAtKey(k + 1, KeyframeInterpolationType.BEZIER,
                                   KeyframeInterpolationType.BEZIER);
    // Replace only the facing sides of the pair; keep the far sides.
    prop.setTemporalEaseAtKey(k, prop.keyInTemporalEase(k), outEase);
    prop.setTemporalEaseAtKey(k + 1, inEase, prop.keyOutTemporalEase(k + 1));
  }
  return pairs.length;
}

AELL_TOOLS.apply_keyframe_ease = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layers;
  try { layers = AELL_layersOrSelection(comp, args); }
  catch (eL) { return AELL_err(eL.message); }
  var bez = AELL_bezierArgs(args);
  var totalPairs = 0;
  for (var i = 0; i < layers.length; i++) {
    var prop;
    try { prop = AELL_anyProperty(layers[i], args.property); }
    catch (eP) {
      return AELL_err("On '" + layers[i].name + "': " + eP.message);
    }
    try {
      totalPairs += AELL_easeProp(prop, bez, args.keyIndex, args.allPairs);
    } catch (e) {
      return AELL_err("On '" + layers[i].name + "', " + args.property +
        " " + (e.message || e) +
        (totalPairs ? " — " + totalPairs + " pair(s) eased before this"
                    : ""));
    }
  }
  return AELL_okay({ layers: layers.length, property: args.property,
                     easedPairs: totalPairs, bezier: bez });
};

AELL_TOOLS.set_layer_timing = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  if (typeof args.startTime === "number") layer.startTime = args.startTime;
  if (typeof args.inPoint === "number") layer.inPoint = args.inPoint;
  if (typeof args.outPoint === "number") layer.outPoint = args.outPoint;
  return AELL_okay({ layer: layer.name, inPoint: layer.inPoint,
                     outPoint: layer.outPoint, startTime: layer.startTime });
};

AELL_TOOLS.delete_layer = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var name = layer.name;
  layer.remove();
  return AELL_okay({ removed: name });
};

/*
 * Named comp resolutions. AE stores resolution as an [x, y] pair of
 * integer DOWNSAMPLE factors; measured in AE 2026: both elements are
 * required, each must be a whole number 1..99, and a non-uniform pair
 * ([1, 3]) is legal. A bare number, a one-element array, a fraction, 0
 * and -1 each throw a different raw AE message, so the tool checks
 * before it writes and says what IS accepted.
 */
var AELL_RESOLUTIONS = { full: 1, half: 2, third: 3, quarter: 4 };

function AELL_resolutionNames() {
  var k, out = [];
  for (k in AELL_RESOLUTIONS) {
    if (AELL_RESOLUTIONS.hasOwnProperty(k)) {
      out.push("'" + k + "' (" + AELL_RESOLUTIONS[k] + ")");
    }
  }
  return out.join(", ");
}

/* "half [2, 2]" — the name when there is one, the pair always. */
function AELL_resolutionLabel(rf) {
  var k, name = "custom";
  for (k in AELL_RESOLUTIONS) {
    if (AELL_RESOLUTIONS.hasOwnProperty(k) && rf[0] === rf[1] &&
        AELL_RESOLUTIONS[k] === rf[0]) { name = k; break; }
  }
  return name + " [" + rf[0] + ", " + rf[1] + "]";
}

/* What the model sent -> AE's [x, y] pair. Returns null and fills
 * bad.why with a grounded refusal when it cannot. */
function AELL_resolutionPair(v, bad) {
  var pair = null, i, n, name;
  if (AELLJSON.isArray(v)) {
    if (v.length !== 2) {
      bad.why = "'resolution' as an array needs exactly two values, " +
        "[horizontal, vertical] — got " + v.length + ". Named " +
        "resolutions: " + AELL_resolutionNames() + ".";
      return null;
    }
    pair = [AELL_numArg(v[0]), AELL_numArg(v[1])];
  } else {
    n = AELL_numArg(v);
    if (n !== null) {
      pair = [n, n];
    } else {
      name = (typeof v === "string") ? String(v).toLowerCase() : "";
      if (AELL_RESOLUTIONS.hasOwnProperty(name)) {
        pair = [AELL_RESOLUTIONS[name], AELL_RESOLUTIONS[name]];
      } else {
        bad.why = "Unknown resolution '" + v + "'. Named resolutions: " +
          AELL_resolutionNames() + " — or pass a whole-number downsample " +
          "factor, or a [horizontal, vertical] pair.";
        return null;
      }
    }
  }
  for (i = 0; i < 2; i++) {
    if (pair[i] === null || !(pair[i] >= 1) || !(pair[i] <= 99) ||
        Math.floor(pair[i]) !== pair[i]) {
      bad.why = "A resolution factor is a whole number from 1 (full, " +
        "every pixel) to 99 — got " + AELL_showValue(v) + ". Named " +
        "resolutions: " + AELL_resolutionNames() + ".";
      return null;
    }
  }
  return pair;
}

/* AE snaps a work-area write to the comp's frame grid, silently
 * (measured on a 24 fps comp: 0.333s reads back as exactly 8 frames,
 * 1.7s as 41). Rounding here is what lets the tool REPORT the snap. */
function AELL_snapFrames(t, fd) {
  if (!(fd > 0)) return Number(t);
  return Math.round(Number(t) / fd) * fd;
}

function AELL_secs(t) { return (Math.round(Number(t) * 1000) / 1000) + "s"; }

/*
 * Land an EXACT work area, because the obvious two writes do not.
 * Measured in AE 2026 (a 3s/24fps comp, work area frames [0..24]):
 * writing workAreaStart = 1s — the frame the CURRENT work area ends on —
 * gives [23..48], one frame early and one frame long, silently. From any
 * other state the same write is exact ([0..24] -> start 0.5 -> [12..36]).
 * A start write otherwise keeps the DURATION and only shortens it when
 * that would run past the end of the comp.
 *
 * So: widen to the whole comp FIRST (from there no requested start can
 * collide with the end), then the start, then the duration. Measured
 * exact from every rig tried, including the collision above. This is not
 * only set_comp_setting's problem: audio_to_keyframes restored the
 * user's work area with the naive order and moved it a frame every time.
 */
function AELL_setWorkArea(comp, start, dur) {
  comp.workAreaStart = 0;
  comp.workAreaDuration = comp.duration;
  if (start > 0) comp.workAreaStart = start;
  comp.workAreaDuration = dur;
}

AELL_TOOLS.set_comp_setting = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var notes = [], changed = [];
  var wasDur = Number(comp.duration);
  var wasWaStart = Number(comp.workAreaStart);
  var wasWaDur = Number(comp.workAreaDuration);
  var bad, pair, rf;

  if (args.duration > 0) { comp.duration = args.duration; changed.push("duration"); }
  if (args.frameRate > 0) { comp.frameRate = args.frameRate; changed.push("frameRate"); }
  if (args.width > 0) { comp.width = Math.round(args.width); changed.push("width"); }
  if (args.height > 0) { comp.height = Math.round(args.height); changed.push("height"); }
  if (AELLJSON.isArray(args.bgColor) && args.bgColor.length >= 3) {
    comp.bgColor = [args.bgColor[0], args.bgColor[1], args.bgColor[2]];
    changed.push("bgColor");
  }
  if ((args.width > 0 || args.height > 0) && comp.numLayers > 0) {
    notes.push("Width/height moved the CANVAS only — the " + comp.numLayers +
      " layer(s) stayed where they were. scale_comp resizes a comp AND " +
      "its content.");
  }

  var fd = Number(comp.frameDuration) || 0;
  var fps = fd ? (Math.round(1 / fd * 100) / 100) : 0;
  var compDur = Number(comp.duration);

  // Shortening a comp drags the work area in with it and says nothing
  // (measured: a work area of 0-4s on a comp cut to 2s came back 0-2s).
  if (Math.abs(compDur - wasDur) > 0.0001 &&
      (Math.abs(Number(comp.workAreaStart) - wasWaStart) > 0.0001 ||
       Math.abs(Number(comp.workAreaDuration) - wasWaDur) > 0.0001)) {
    notes.push("Re-timing the comp pulled the work area in with it: " +
      AELL_secs(wasWaStart) + "-" + AELL_secs(wasWaStart + wasWaDur) +
      " is now " + AELL_secs(comp.workAreaStart) + "-" +
      AELL_secs(Number(comp.workAreaStart) +
                Number(comp.workAreaDuration)) + ".");
  }

  var aStart = AELL_numArg(args.workAreaStart);
  var aDur = AELL_numArg(args.workAreaDuration);
  var aEnd = AELL_numArg(args.workAreaEnd);
  var wantWa = args.workArea !== null && typeof args.workArea !== "undefined";
  if (wantWa || aStart !== null || aDur !== null || aEnd !== null) {
    var curStart = Number(comp.workAreaStart);
    var curDur = Number(comp.workAreaDuration);
    var start, dur, word;
    if (wantWa) {
      word = String(args.workArea).toLowerCase();
      if (word !== "comp" && word !== "whole" && word !== "all" &&
          word !== "full") {
        return AELL_err("'workArea' takes 'comp' — reset the work area to " +
          "the whole comp. Got '" + args.workArea + "'. For a sub-range " +
          "pass workAreaStart with workAreaDuration or workAreaEnd, in " +
          "seconds.");
      }
      start = 0;
      dur = compDur;
    } else {
      if (aDur !== null && aEnd !== null) {
        return AELL_err("Pass workAreaDuration OR workAreaEnd, not both — " +
          "they say the same thing two ways (from " +
          AELL_secs(aStart === null ? curStart : aStart) + ", a duration " +
          "of " + aDur + "s ends at " +
          AELL_secs((aStart === null ? curStart : aStart) + aDur) + ", " +
          "not " + AELL_secs(aEnd) + ").");
      }
      start = (aStart === null) ? curStart : aStart;
      if (aEnd !== null) dur = aEnd - start;
      else if (aDur !== null) dur = aDur;
      else dur = curDur;
    }

    var rawStart = start, rawDur = dur;
    start = AELL_snapFrames(start, fd);
    dur = AELL_snapFrames(dur, fd);
    // Moving only the start onto a late frame is AE's own quiet
    // shortening; keep the behaviour, but say it out loud.
    var trimmed = 0;
    if (aDur === null && aEnd === null && !wantWa && start + dur > compDur) {
      trimmed = dur;
      dur = AELL_snapFrames(compDur - start, fd);
    }
    if (start < 0) {
      return AELL_err("A work area cannot start before 0 — got " +
        AELL_secs(rawStart) + ".");
    }
    if (fd > 0 && start > compDur - fd + 0.0001) {
      return AELL_err("Comp '" + comp.name + "' is " + AELL_secs(compDur) +
        " long at " + fps + " fps, so its last frame starts at " +
        AELL_secs(compDur - fd) + " — a work area cannot start at " +
        AELL_secs(rawStart) + ".");
    }
    if (dur <= 0 || (fd > 0 && dur < fd - 0.0001)) {
      return AELL_err("A work area of " + AELL_secs(rawDur) + " holds no " +
        "frame — at " + fps + " fps the shortest one is " + AELL_secs(fd) +
        " (one frame). AE refuses a zero-length work area outright.");
    }
    if (start + dur > compDur + 0.0001) {
      return AELL_err("A work area of " + AELL_secs(rawDur) + " starting " +
        "at " + AELL_secs(start) + " would end at " +
        AELL_secs(start + dur) + ", past the end of comp '" + comp.name +
        "' (" + AELL_secs(compDur) + "). The longest that fits from there " +
        "is " + AELL_secs(compDur - start) + ".");
    }
    AELL_setWorkArea(comp, start, dur);
    changed.push("workArea");
    if (fd > 0 && Math.abs(start - rawStart) > 0.000001) {
      notes.push("The work area start snapped to the frame grid: " +
        AELL_secs(rawStart) + " -> " + AELL_secs(start) + " (frame " +
        Math.round(start / fd) + " at " + fps + " fps).");
    }
    if (fd > 0 && !trimmed && Math.abs(dur - rawDur) > 0.000001) {
      notes.push("The work area duration snapped to the frame grid: " +
        AELL_secs(rawDur) + " -> " + AELL_secs(dur) + ".");
    }
    if (trimmed) {
      notes.push("Moving the start to " + AELL_secs(start) + " left only " +
        AELL_secs(dur) + " before the comp ends, so the work area is " +
        "shorter than the " + AELL_secs(trimmed) + " it was.");
    }
  }

  if (args.resolution !== null && typeof args.resolution !== "undefined") {
    bad = {};
    pair = AELL_resolutionPair(args.resolution, bad);
    if (!pair) return AELL_err(bad.why);
    comp.resolutionFactor = pair;
    changed.push("resolution");
  }

  if (!changed.length) {
    return AELL_err("set_comp_setting was given nothing to change. It " +
      "sets: duration (seconds), frameRate, width, height, bgColor " +
      "[r, g, b] 0..1, workAreaStart with workAreaDuration or " +
      "workAreaEnd (seconds, or workArea: 'comp' for the whole comp), " +
      "and resolution (" + AELL_resolutionNames() + ", or a " +
      "[horizontal, vertical] pair).");
  }

  rf = comp.resolutionFactor;
  var out = { name: comp.name, width: comp.width, height: comp.height,
              duration: comp.duration, frameRate: comp.frameRate,
              bgColor: [comp.bgColor[0], comp.bgColor[1], comp.bgColor[2]],
              workAreaStart: Number(comp.workAreaStart),
              workAreaDuration: Number(comp.workAreaDuration),
              workArea: AELL_secs(comp.workAreaStart) + "-" +
                        AELL_secs(Number(comp.workAreaStart) +
                                  Number(comp.workAreaDuration)),
              resolution: AELL_resolutionLabel(rf),
              changed: changed.join(", ") };
  if (notes.length) out.note = notes.join(" ");
  return AELL_okay(out);
};

/* Compare a written value with what AE read back. Tolerant of the
 * scripting API's padding: writing [x, y] to a 2D Position reads back as
 * [x, y, 0], which is the SAME value, not a failed write. */
function AELL_sameValue(a, b) {
  var TOL = 0.01;
  var i;
  if (AELLJSON.isArray(a) || AELLJSON.isArray(b)) {
    if (!AELLJSON.isArray(a) || !AELLJSON.isArray(b)) return false;
    var n = Math.min(a.length, b.length);
    if (!n) return a.length === b.length;
    for (i = 0; i < n; i++) {
      if (Math.abs(Number(a[i]) - Number(b[i])) > TOL) return false;
    }
    return true;
  }
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= TOL;
  }
  return String(a) === String(b);
}

/* A property value the model can read back to us as an argument. */
function AELL_showValue(v) {
  var i, parts;
  if (AELLJSON.isArray(v)) {
    parts = [];
    for (i = 0; i < v.length; i++) {
      parts.push(Math.round(Number(v[i]) * 100) / 100);
    }
    return "[" + parts.join(", ") + "]";
  }
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  return String(v);
}

/*
 * Write a plain value to a property, turning AE's two silent refusals
 * into something the model can act on:
 *   - a KEYFRAMED property rejects setValue outright (raw AE throw),
 *   - an EXPRESSION-DRIVEN one accepts it and then ignores it, which is
 *     worse, because the tool reports success and nothing moves.
 * Returns a warning string (or "") so callers can surface the second case.
 *
 * "Driven" is NOT the same as "overridden", which is why this reads the
 * property back instead of trusting expressionEnabled: an expression can
 * CONSUME the written value (`value + wiggle(2, 30)` moves when you write
 * to it) or IGNORE it (a rig that computes the property from scratch, the
 * shape grid_layout builds). Only AE knows which, and on a driven property
 * `.value` is the EVALUATED result — so ask it, and quote the answer.
 */
function AELL_writeValue(prop, value, label) {
  var keys = 0;
  try { keys = prop.numKeys; } catch (eK) {}
  if (keys > 0) {
    throw new Error("'" + label + "' is animated (" + keys +
      " keyframes), so a single value cannot be written to it. Pass " +
      "{atTime: <seconds>} to set a keyframe at a time instead, or " +
      "delete the existing keyframes first.");
  }
  prop.setValue(value);
  return AELL_overrideWarning(prop, value, label);
}

/* Did a write that AE ACCEPTED actually change what the comp shows?
 * Returns "" when it did (including when there is no expression at all),
 * else a warning naming the value that is really there. */
function AELL_overrideWarning(prop, value, label) {
  var driven = false;
  try { driven = !!prop.expressionEnabled; } catch (eE) {}
  if (!driven) return "";
  var actual = null, read = false;
  try { actual = prop.value; read = true; } catch (eV) {}
  if (read && AELL_sameValue(actual, value)) return "";   // passed through
  return "'" + label + "' is driven by an expression that ignores written " +
    "values" +
    (read ? " — the comp still shows " + AELL_showValue(actual) + ", not " +
            AELL_showValue(value) : "") +
    ". Clear it first (set_expression with expression: \"\").";
}

/* Apply fn to a property's value — at every keyframe when it has keys. */
function AELL_mapPropValues(prop, fn) {
  if (prop.numKeys > 0) {
    for (var k = 1; k <= prop.numKeys; k++) {
      prop.setValueAtKey(k, fn(prop.keyValue(k)));
    }
  } else {
    prop.setValue(fn(prop.value));
  }
}

/*
 * Scale a keyframed property's INTERPOLATION by the same factor as its
 * values. setValueAtKey moves the keys and leaves two things behind, both
 * still measured in the OLD comp's units:
 *   - spatial tangents, the pixel handles of the motion path, so a curved
 *     path keeps full-size handles and bulges off course between keys;
 *   - temporal ease SPEED, which is units/second, so eases overshoot.
 * Measured in real AE 2026 on an 800x600 comp halved: a 3-key curved path
 * was 37px off course mid-key and a 600px/s ease 33px off, while every
 * key value was exactly right — the failure is invisible if you only
 * check keyValue().
 */
function AELL_scaleKeyInterp(prop, s, label, problems) {
  var n = 0;
  try { n = prop.numKeys; } catch (eN) { return; }
  if (!n) return;
  var spatial = false;
  try { spatial = !!prop.isSpatial; } catch (eS) {}
  var touched = false;

  function scaleVec(v) {
    var out = [];
    for (var d = 0; d < v.length; d++) out.push(v[d] * s);
    return out;
  }
  function scaleEase(arr) {
    var out = [];
    for (var d = 0; d < arr.length; d++) {
      // A zero-speed side has nothing to scale — and AE REFUSES to
      // rebuild it: the untouched side of a key reads back influence 0,
      // while the KeyframeEase constructor rejects anything under 0.1
      // ("Value 0 out of range 0.1 to 100"). Hand the original object
      // straight back instead. This is why easing applied by
      // apply_keyframe_ease (which only writes the FACING sides of a
      // pair) used to survive a resize unscaled: the very first ease
      // rebuilt threw, and the whole key was abandoned.
      if (!arr[d].speed) { out.push(arr[d]); continue; }
      out.push(new KeyframeEase(arr[d].speed * s,
        Math.max(0.1, Math.min(100, arr[d].influence))));
      touched = true;
    }
    return out;
  }

  for (var k = 1; k <= n; k++) {
    // AUTO-bezier handles are recomputed by AE from the (already scaled)
    // neighbouring values, so they are correct for free — and writing
    // them would only switch auto off. Only user-shaped handles go stale.
    if (spatial) {
      var auto = true;
      try { auto = !!prop.keySpatialAutoBezier(k); } catch (eA) {}
      if (!auto) {
        try {
          prop.setSpatialTangentsAtKey(k,
            scaleVec(prop.keyInSpatialTangent(k)),
            scaleVec(prop.keyOutSpatialTangent(k)));
        } catch (eT) {}
      }
    }
    // Ease only matters on a bezier side, and writing it can flip a
    // LINEAR or HOLD side to bezier — so capture the types and put them
    // back. The ease ARRAY LENGTH is whatever AE handed us, which is the
    // padded scripting dimensionality it demands back (3 for Scale on a
    // 2D layer, 1 for a spatial property).
    try {
      var ti = prop.keyInInterpolationType(k);
      var to = prop.keyOutInterpolationType(k);
      if (ti === KeyframeInterpolationType.BEZIER ||
          to === KeyframeInterpolationType.BEZIER) {
        touched = false;
        var newIn = scaleEase(prop.keyInTemporalEase(k));
        var newOut = scaleEase(prop.keyOutTemporalEase(k));
        // Nothing to change means nothing to write — and writing would
        // flip the key's interpolation types for no reason.
        if (touched) {
          prop.setTemporalEaseAtKey(k, newIn, newOut);
          if (prop.keyInInterpolationType(k) !== ti ||
              prop.keyOutInterpolationType(k) !== to) {
            prop.setInterpolationTypeAtKey(k, ti, to);
          }
        }
      }
    } catch (eE) {
      // Do NOT swallow this. An ease left at the old comp's speed still
      // renders — wrongly — so a silent catch reports a clean resize
      // over motion that now overshoots. That silence is exactly what
      // hid the constructor refusal above.
      if (problems) {
        problems.push((label || "a property") + " key " + k + ": " +
          (eE && eE.message ? eE.message : String(eE)));
      }
    }
  }
}

/* Map a property's values AND rescale the interpolation that carries
 * them — the pair scale_comp always wants together. */
function AELL_scalePropValues(prop, fn, s, label, problems) {
  AELL_mapPropValues(prop, fn);
  AELL_scaleKeyInterp(prop, s, label, problems);
}

/*
 * Resize a comp AND scale its content to match, centered — the behavior
 * of the native "Scale Composition" script. Uniform factor so nothing
 * distorts; when the target aspect differs, 'fit' letterboxes and 'fill'
 * crops. Only unparented layers are touched: children inherit the change
 * through their parent chain.
 */
AELL_TOOLS.scale_comp = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var ow = comp.width, oh = comp.height;
  var nw, nh, s;
  if (args.factor > 0) {
    s = Number(args.factor);
    nw = Math.round(ow * s);
    nh = Math.round(oh * s);
  } else if (args.width > 0 || args.height > 0) {
    nw = args.width > 0 ? Math.round(Number(args.width)) : 0;
    nh = args.height > 0 ? Math.round(Number(args.height)) : 0;
    if (!nw) nw = Math.round(nh * ow / oh);
    if (!nh) nh = Math.round(nw * oh / ow);
    var rw = nw / ow;
    var rh = nh / oh;
    s = String(args.mode || "fit") === "fill"
      ? Math.max(rw, rh) : Math.min(rw, rh);
  } else {
    return AELL_err("Pass width/height (pixels) or factor (e.g. 0.5)");
  }
  comp.width = nw;
  comp.height = nh;

  function AELL_recentre(v) {
    var out = [(v[0] - ow / 2) * s + nw / 2,
               (v[1] - oh / 2) * s + nh / 2];
    if (v.length > 2) out.push(v[2] * s);
    return out;
  }
  function AELL_driven(prop) {
    try { return !!prop.expressionEnabled; } catch (eD) { return false; }
  }

  function AELL_scaleZoom(z) { return z * s; }
  /* Zoom lives in Camera Options, not the Transform group, so NOTHING
   * about it is inherited through a parent — a camera parented to a null
   * (the standard rig) kept its old pixel zoom and silently re-framed the
   * shot. Verified in real AE 2026: zoom stayed 1000 in a halved comp. */
  function AELL_rezoom(L) {
    var z = null;
    try { z = L.zoom; } catch (eZ) { z = null; }
    if (!z) return false;
    AELL_scalePropValues(z, AELL_scaleZoom, s,
                         L.name + " Zoom", easeProblems);
    return true;
  }

  /* A light's pixel-valued options (Radius, Falloff Distance, Shadow
   * Diffusion) are the same trap as camera Zoom, one layer type over:
   * outside the Transform group, so a parent never passes the resize
   * down, and left alone a halved comp keeps a 300px falloff radius
   * lighting a 500px comp. AE's own Scale Composition script leaves them
   * behind; this one scales them and says which. Only the options the
   * light's TYPE and FALLOFF actually put in play are touched — writing
   * a hidden one throws. A zero (Shadow Diffusion's default) scales to
   * zero, so it is left alone rather than reported as work done.
   */
  function AELL_relight(L) {
    var kind = AELL_lightKindOf(L);
    if (!kind) return null;
    var opts = null;
    try { opts = L.property("ADBE Light Options Group"); } catch (eG) {}
    if (!opts) return null;
    var falloffs = AELL_lightFalloffs(opts);
    var done = [], i, o, prop, n;
    for (i = 0; i < AELL_LIGHT_PIXEL_OPTS.length; i++) {
      o = AELL_LIGHT_PIXEL_OPTS[i];
      if (!AELL_lightAccepts(o.on, kind)) continue;
      if (o.falloff && !AELL_falloffInPlay(o.falloff, falloffs)) continue;
      prop = null;
      try { prop = opts.property(o.mn); } catch (eO) {}
      if (!prop) continue;
      if (AELL_driven(prop)) {
        // An expression on a light option swallows the write exactly as
        // one on Position does, but it is not a transform and saying
        // "this layer will not move" about it would be wrong.
        lightProblems.push(L.name + " " + o.label + " (" + kind +
          " light): expression-driven, so the resize cannot change it");
        continue;
      }
      try {
        n = prop.numKeys;
        if (!n && !prop.value) continue;
      } catch (eN) { continue; }
      try {
        AELL_scalePropValues(prop, function (v) { return v * s; }, s,
                             L.name + " " + o.label, easeProblems);
        done.push(o.label);
      } catch (eW) {
        // The table said this one is in play, so a refusal is news — an
        // unscaled pixel option re-lights the shot silently. The one way
        // it happens: Falloff Type is itself KEYFRAMED, and AE hides
        // Radius / Falloff Distance whenever the falloff UNDER THE
        // PLAYHEAD is one that does not use them (measured: keys saying
        // smooth later do not open the gate now).
        lightProblems.push(L.name + " " + o.label + " (" + kind +
          " light): " + (eW && eW.message ? eW.message : String(eW)) +
          (falloffs.keyed
            ? " Falloff is keyframed and the one under the playhead hides" +
              " this option; move the playhead to a time that uses it and" +
              " re-run."
            : ""));
      }
    }
    return { kind: kind, scaled: done };
  }

  var scaled = 0, inherited = 0, i;
  var skipped = [], drivenBy = [], rezoomed = [], easeProblems = [];
  var relit = [], nothingToScale = [], lightProblems = [];

  /* One place to run AELL_relight and record what it touched, so the
   * parented and unparented paths cannot drift apart — light options are
   * NOT inherited, so both paths owe a light the same write. */
  function AELL_noteRelit(L) {
    var r = AELL_relight(L);
    if (r && r.scaled.length) {
      relit.push(L.name + " (" + r.scaled.join(", ") + ")");
    }
  }
  for (i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    if (L.parent) {
      inherited++;
      try {
        if (AELL_rezoom(L)) rezoomed.push(L.name);
        AELL_noteRelit(L);
      } catch (eP) {
        skipped.push(L.name + " (zoom/light options): " +
          (eP && eP.message ? eP.message : String(eP)));
      }
      continue;
    }
    try {
      // An ambient or environment light has no position, no aim and no
      // pixel option — AE hides all of it. Writing Position anyway threw
      // "the property or a parent property is hidden", and the layer was
      // then reported as one that could NOT be scaled, which reads as a
      // failure over a light where there was never anything to do.
      var lightKind = AELL_lightKindOf(L);
      if (lightKind && !AELL_lightHasGeometry(lightKind)) {
        nothingToScale.push(L.name + " (" + lightKind + " light)");
        continue;
      }
      var posProp = AELL_resolveProperty(L, "position");
      if (AELL_driven(posProp)) drivenBy.push(L.name);
      AELL_scalePropValues(posProp, AELL_recentre, s,
                           L.name + " Position", easeProblems);

      // Cameras and lights AIM rather than scale. AE still RESOLVES a
      // hidden Scale on them, and writing it throws ("the property or a
      // parent property is hidden") — which used to abort this layer
      // AFTER Position had already been written, leaving the comp half
      // scaled and the camera's zoom and aim untouched. Resolvability is
      // not settability, and the property flags lie about it: a hidden
      // Scale still reports elided=false and enabled=true, so the layer
      // type is the only reliable test. Verified in real AE 2026.
      var aimed = false;
      try {
        aimed = (typeof CameraLayer !== "undefined" && L instanceof CameraLayer) ||
                (typeof LightLayer !== "undefined" && L instanceof LightLayer);
      } catch (eA) {}

      var sc = null;
      if (!aimed) {
        try { sc = AELL_resolveProperty(L, "scale"); } catch (e1) {}
      }
      if (sc) {
        if (AELL_driven(sc)) drivenBy.push(L.name);
        AELL_scalePropValues(sc, function (v) {
          var out = [];
          for (var d = 0; d < v.length; d++) out.push(v[d] * s);
          return out;
        }, s, L.name + " Scale", easeProblems);
      }

      // Cameras and lights AIM at a Point of Interest held in comp space
      // (matchName "ADBE Anchor Point" on those layer types). Left alone
      // it keeps pointing where things used to be, so the shot re-frames
      // itself the moment the comp is resized. Re-centre it like Position.
      if (aimed) {
        // The Point of Interest is only writable when the layer actually
        // aims at it. On a one-node (NO_AUTO_ORIENT) camera it is hidden
        // and setValue throws, so test the orientation — the property
        // reports enabled=true either way. A one-node camera has no aim
        // point to re-centre, so skipping it is correct, not a failure.
        var aims = false;
        try {
          aims = typeof AutoOrientType !== "undefined" &&
                 L.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
        } catch (eO) {}
        // autoOrient lies on a LIGHT: measured in real AE 2026, a point,
        // ambient or environment light reports 4214
        // (CAMERA_OR_POINT_OF_INTEREST) exactly like a two-node spot, and
        // then refuses the Point of Interest write because AE hides it.
        // Only parallel and spot lights actually aim. Unguarded, an
        // unparented point light threw here AFTER its Position had been
        // written and was reported as a layer that could not be scaled.
        if (aims && lightKind &&
            !AELL_lightAccepts(AELL_LIGHT_XFORM.pointOfInterest.on, lightKind)) {
          aims = false;
        }
        if (aims) {
          var poi = L.property("ADBE Transform Group")
                     .property("ADBE Anchor Point");
          if (poi) {
            AELL_scalePropValues(poi, AELL_recentre, s,
                                 L.name + " Point of Interest",
                                 easeProblems);
          }
        }
      }

      // Zoom is in pixels, so it has to track the resize or the framing
      // changes. Reading it is guarded (non-cameras have none); the WRITE
      // is not — this call sits inside the layer's try, so a real failure
      // lands in layersSkipped instead of vanishing and reporting a
      // success that did not happen.
      AELL_rezoom(L);
      AELL_noteRelit(L);
      scaled++;
    } catch (e3) {
      // Do NOT fold failures into the inherited count — a locked layer or
      // a refused write would read as "handled by its parent" and the
      // result would claim a success that never happened.
      skipped.push(L.name + ": " +
        (e3 && e3.message ? e3.message : String(e3)));
    }
  }

  var out = { comp: comp.name, width: nw, height: nh,
    scaleFactor: Math.round(s * 10000) / 10000,
    layersScaled: scaled, layersInherited: inherited,
    note: "Content scaled uniformly and re-centered " +
          "(like the native Scale Composition script)" };
  if (easeProblems.length) {
    // Values scaled, easing did not: the motion renders wrong even
    // though every keyframe sits in the right place. Say so.
    out.keyframeEasingNotScaled = easeProblems;
    out.note += ". WARNING: keyframe easing could not be rescaled on " +
      easeProblems.length + " property/properties, so their motion will " +
      "over- or undershoot: " + easeProblems.join("; ");
  }
  if (relit.length) {
    // Reported on their own: a light's Transform may well have been
    // inherited or absent, and only its pixel options needed a write.
    out.lightOptionsRescaled = relit;
    out.note += ". Pixel-valued light options rescaled on " +
      relit.join(", ") + " (nothing in Light Options is inherited from " +
      "a parent, and AE's own Scale Composition script leaves them behind)";
  }
  if (lightProblems.length) {
    // A pixel option AE refused to rescale keeps the OLD comp's
    // distance, so the light renders differently at the new size.
    out.lightOptionsNotScaled = lightProblems;
    out.note += ". WARNING: " + lightProblems.length + " light option(s) " +
      "kept the old comp's pixel value: " + lightProblems.join("; ");
  }
  if (nothingToScale.length) {
    // NOT a failure and NOT a success: AE hides everything scalable on
    // these, so naming them stops the count from looking short.
    out.layersWithNothingToScale = nothingToScale;
    out.note += ". Nothing to scale on " + nothingToScale.join(", ") +
      " (AE hides position, aim and every pixel option on these types)";
  }
  if (rezoomed.length) {
    // Reported separately: their TRANSFORM really was inherited, only the
    // zoom needed a write, and claiming they were "scaled" would be a lie.
    out.parentedCamerasRezoomed = rezoomed;
    out.note += ". Zoom rescaled on parented camera(s) " +
      rezoomed.join(", ") + " (zoom is not inherited from a parent)";
  }
  if (skipped.length) {
    out.layersSkipped = skipped;
    out.note += ". " + skipped.length + " layer(s) could NOT be scaled";
  }
  if (drivenBy.length) {
    out.expressionDriven = drivenBy;
    out.note += ". WARNING: expression-driven transforms on " +
      drivenBy.join(", ") + " override these writes — those layers will " +
      "not move, so re-check any rig (grid_layout etc.) after resizing";
  }
  return AELL_okay(out);
};

AELL_TOOLS.import_file = function (args) {
  if (!args.path) return AELL_err("'path' is required");
  var f = new File(args.path);
  if (!f.exists) return AELL_err("File not found: " + args.path);
  var item = app.project.importFile(new ImportOptions(f));
  return AELL_okay({ name: item.name, id: item.id });
};

AELL_TOOLS.add_shape_layer = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_keepSelection(comp, function () {
    return comp.layers.addShape();
  });
  if (args.name) layer.name = String(args.name);
  var group = layer.property("ADBE Root Vectors Group")
                   .addProperty("ADBE Vector Group");
  var vectors = group.property("ADBE Vectors Group");
  var size = (AELLJSON.isArray(args.size) && args.size.length >= 2)
    ? [args.size[0], args.size[1]] : [200, 200];
  var kind = args.shape ? String(args.shape) : "rectangle";
  var shp;
  if (kind === "ellipse") {
    shp = vectors.addProperty("ADBE Vector Shape - Ellipse");
    shp.property("ADBE Vector Ellipse Size").setValue(size);
  } else if (kind === "polygon" || kind === "star") {
    shp = vectors.addProperty("ADBE Vector Shape - Star");
    shp.property("ADBE Vector Star Type").setValue(kind === "polygon" ? 2 : 1);
    if (args.points > 2) {
      shp.property("ADBE Vector Star Points").setValue(Math.round(args.points));
    }
    var outer = Math.max(size[0], size[1]) / 2;
    shp.property("ADBE Vector Star Outer Radius").setValue(outer);
    if (kind === "star") {
      shp.property("ADBE Vector Star Inner Radius").setValue(outer / 2);
    }
  } else {
    shp = vectors.addProperty("ADBE Vector Shape - Rect");
    shp.property("ADBE Vector Rect Size").setValue(size);
    if (args.roundness > 0) {
      shp.property("ADBE Vector Rect Roundness").setValue(args.roundness);
    }
  }
  if (AELLJSON.isArray(args.fillColor) && args.fillColor.length >= 3) {
    var fill = vectors.addProperty("ADBE Vector Graphic - Fill");
    fill.property("ADBE Vector Fill Color").setValue(
      [args.fillColor[0], args.fillColor[1], args.fillColor[2], 1]);
  }
  if (AELLJSON.isArray(args.strokeColor) && args.strokeColor.length >= 3) {
    var stroke = vectors.addProperty("ADBE Vector Graphic - Stroke");
    stroke.property("ADBE Vector Stroke Color").setValue(
      [args.strokeColor[0], args.strokeColor[1], args.strokeColor[2], 1]);
    if (args.strokeWidth > 0) {
      stroke.property("ADBE Vector Stroke Width").setValue(args.strokeWidth);
    }
  }
  if (AELLJSON.isArray(args.position) && args.position.length >= 2) {
    layer.property("ADBE Transform Group").property("ADBE Position")
         .setValue(args.position);
  }
  return AELL_okay({ index: layer.index, name: layer.name, shape: kind });
};

var AELL_MASK_MODES = null;
function AELL_maskMode(name) {
  if (!AELL_MASK_MODES) {
    AELL_MASK_MODES = {
      none: MaskMode.NONE, add: MaskMode.ADD, subtract: MaskMode.SUBTRACT,
      intersect: MaskMode.INTERSECT, lighten: MaskMode.LIGHTEN,
      darken: MaskMode.DARKEN, difference: MaskMode.DIFFERENCE
    };
  }
  return AELL_MASK_MODES[String(name).toLowerCase()];
}

AELL_TOOLS.add_mask = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var masks = layer.property("ADBE Mask Parade");
  if (!masks) return AELL_err("This layer type cannot take masks");
  var shape = new Shape();
  shape.closed = true;
  var kind = args.shape ? String(args.shape) : "rectangle";
  if (kind === "custom") {
    if (!AELLJSON.isArray(args.vertices) || args.vertices.length < 3) {
      return AELL_err("'vertices' ([[x,y],...] in LAYER space, >= 3 points) " +
                      "is required for a custom mask");
    }
    shape.vertices = args.vertices;
  } else {
    var b = (AELLJSON.isArray(args.bounds) && args.bounds.length >= 4)
      ? args.bounds
      : [0, 0, layer.width || comp.width, layer.height || comp.height];
    var x = b[0], y = b[1], w = b[2], h = b[3];
    if (kind === "ellipse") {
      var cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
      var kx = rx * 0.5523, ky = ry * 0.5523;
      shape.vertices = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
      shape.inTangents  = [[-kx, 0], [0, -ky], [kx, 0], [0, ky]];
      shape.outTangents = [[kx, 0], [0, ky], [-kx, 0], [0, -ky]];
    } else {
      shape.vertices = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    }
  }
  var mask = masks.addProperty("ADBE Mask Atom");
  if (args.name) mask.name = String(args.name);
  mask.property("ADBE Mask Shape").setValue(shape);
  if (args.mode) {
    var mode = AELL_maskMode(args.mode);
    if (typeof mode === "undefined") {
      return AELL_err("Unknown mask mode: " + args.mode +
                      " (use add/subtract/intersect/lighten/darken/difference/none)");
    }
    mask.maskMode = mode;
  }
  if (args.inverted) mask.inverted = true;
  if (args.feather > 0) {
    mask.property("ADBE Mask Feather").setValue([args.feather, args.feather]);
  }
  return AELL_okay({ layer: layer.name, mask: mask.name, shape: kind });
};

/*
 * Resolve a mask by name or 1-based index. With one mask on the layer and
 * no ref, that mask wins. Failures list the real masks — grounded.
 */
function AELL_findMask(layer, ref) {
  var masks = layer.property("ADBE Mask Parade");
  if (!masks) throw new Error("Layer '" + layer.name + "' cannot have masks");
  var n = 0;
  try { n = masks.numProperties || 0; } catch (e) {}
  var i;
  if (typeof ref === "number") {
    var byIdx = null;
    try { byIdx = masks.property(Math.round(ref)); } catch (e2) {}
    if (byIdx) return byIdx;
  } else if (ref !== null && typeof ref !== "undefined" && ref !== "") {
    for (i = 1; i <= n; i++) {
      var m = masks.property(i);
      if (m && (m.name === String(ref))) return m;
    }
  } else if (n === 1) {
    return masks.property(1);
  }
  var names = [];
  for (i = 1; i <= n; i++) {
    try { names.push(masks.property(i).name); } catch (e3) {}
  }
  throw new Error("Mask not found on '" + layer.name + "'" +
    (ref ? ": " + ref : " (several masks — pass {mask: name|index})") +
    ". Masks here: " + (names.join(", ") || "(none — add_mask creates one)"));
}

AELL_TOOLS.set_mask = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var mask;
  try { mask = AELL_findMask(layer, args.mask); }
  catch (e) { return AELL_err(e.message); }
  var changed = [];
  if (args.mode) {
    var mode = AELL_maskMode(args.mode);
    if (typeof mode === "undefined") {
      return AELL_err("Unknown mask mode: " + args.mode +
        " (use add/subtract/intersect/lighten/darken/difference/none)");
    }
    mask.maskMode = mode;
    changed.push("mode=" + args.mode);
  }
  if (typeof args.inverted === "boolean") {
    mask.inverted = args.inverted;
    changed.push("inverted=" + args.inverted);
  }
  if (typeof args.feather === "number" || AELLJSON.isArray(args.feather)) {
    var f = AELLJSON.isArray(args.feather)
      ? [Number(args.feather[0]), Number(args.feather[1])]
      : [Number(args.feather), Number(args.feather)];
    mask.property("ADBE Mask Feather").setValue(f);
    changed.push("feather=" + f.join("/"));
  }
  if (typeof args.expansion === "number") {
    mask.property("ADBE Mask Offset").setValue(args.expansion);
    changed.push("expansion=" + args.expansion);
  }
  if (typeof args.opacity === "number") {
    mask.property("ADBE Mask Opacity").setValue(args.opacity);
    changed.push("opacity=" + args.opacity);
  }
  if (args.name) {
    mask.name = String(args.name);
    changed.push("name=" + args.name);
  }
  if (changed.length === 0) {
    return AELL_err("Nothing to change — pass mode, feather, expansion, " +
                    "opacity, inverted and/or name");
  }
  return AELL_okay({ layer: layer.name, mask: mask.name,
                     changed: changed.join(", ") });
};

/*
 * How many points the mask path is ALREADY animated with, or 0 when it
 * has no keyframes. Every key on one path has to agree -- see
 * AELL_maskPointMix for why that is not pedantry.
 */
function AELL_maskKeyPoints(pathProp) {
  var n = 0;
  try { n = pathProp.numKeys || 0; } catch (e) { return 0; }
  if (n < 1) return 0;
  try { return pathProp.keyValue(1).vertices.length; } catch (e2) { return 0; }
}

/*
 * The grounded refusal for keys that disagree on point count. Measured in
 * AE 2026, setValueAtTime with a different vertex count on an ALREADY
 * KEYED mask path does two bad things at once:
 * (1) "Preserve Constant Vertex and Feather Count" (General preferences,
 *     ON by default) forces the new count onto every existing key, so the
 *     path stops interpolating -- it holds key 1 and then POPS. numKeys
 *     still read 2 and the tool still reported "Mask path animated".
 * (2) AE queues a modal warning that appears AFTER the script returns and
 *     DISABLES AE's main window, so every later tool call is swallowed
 *     while AE still reports as healthy. A chat panel cannot click that
 *     dialog, so one bad mask call ends the session.
 * Refusing costs the caller nothing: a repeated vertex pads a simpler
 * path invisibly.
 */
function AELL_maskPointMix(maskName, where, got, want, wantFrom) {
  return "Mask path keys must all have the same number of points: " +
    where + " has " + got + " but " + wantFrom +
    (wantFrom === "the existing keys" ? " have " : " has ") + want + ". " +
    "After Effects cannot interpolate between paths with different point " +
    "counts -- with 'Preserve Constant Vertex and Feather Count' on (the " +
    "default) it forces one count onto every key, so mask '" + maskName +
    "' would POP instead of animating, and AE raises a modal warning that " +
    "blocks the whole application until someone clicks it. Give every key " +
    want + " points (repeat a vertex to pad a simpler shape -- a doubled " +
    "point is legal and invisible)" +
    (wantFrom === "the existing keys"
      ? ", or clear the existing keys first with remove_keyframes."
      : ".");
}

AELL_TOOLS.set_mask_path = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var mask;
  try { mask = AELL_findMask(layer, args.mask); }
  catch (e) { return AELL_err(e.message); }
  var pathProp = mask.property("ADBE Mask Shape");
  function buildShape(spec, closedDefault, where) {
    if (!AELLJSON.isArray(spec.vertices) || spec.vertices.length < 3) {
      throw new Error(where + "'vertices' ([[x,y],…] in LAYER space, " +
                      ">= 3 points) is required");
    }
    var n = spec.vertices.length, s = new Shape();
    s.closed = typeof spec.closed === "boolean" ? spec.closed : closedDefault;
    s.vertices = spec.vertices;
    // AE wants one tangent per point; a short list corrupts the path
    // quietly, so name the side that is wrong instead of passing it on.
    if (AELLJSON.isArray(spec.inTangents)) {
      if (spec.inTangents.length !== n) {
        throw new Error(where + "'inTangents' has " + spec.inTangents.length +
          " entries but 'vertices' has " + n + " -- AE needs exactly one " +
          "tangent per point");
      }
      s.inTangents = spec.inTangents;
    }
    if (AELLJSON.isArray(spec.outTangents)) {
      if (spec.outTangents.length !== n) {
        throw new Error(where + "'outTangents' has " +
          spec.outTangents.length + " entries but 'vertices' has " + n +
          " -- AE needs exactly one tangent per point");
      }
      s.outTangents = spec.outTangents;
    }
    return s;
  }
  // Keyframe times belong ON the frame grid. AE stores whatever fraction
  // it is handed -- measured, 0.34s in a 30fps comp lands on frame 10.2 --
  // and then no rendered frame ever shows the shape that was asked for:
  // frame 21 of a 0.71s key came back 197.3 wide instead of 200.
  var fd = 0;
  try { fd = Number(comp.frameDuration) || 0; } catch (eF) { fd = 0; }
  var fps = fd ? Math.round(1 / fd * 100) / 100 : 0;
  function snap(t) { return fd ? Math.round(t / fd) * fd : t; }
  function r4(v) { return Math.round(v * 10000) / 10000; }
  var animatedWith = AELL_maskKeyPoints(pathProp);
  var closedDefault = args.closed !== false;
  try {
    if (AELLJSON.isArray(args.keys) && args.keys.length > 0) {
      if (args.keys.length > 50) return AELL_err("'keys' capped at 50");
      // Build and check EVERY key before writing ANY of them. A path left
      // half-written is worse than one refused: the caller cannot tell
      // which keys landed, and the partial state is what pops.
      var shapes = [], times = [], snapped = 0, i, j, k;
      for (i = 0; i < args.keys.length; i++) {
        k = args.keys[i] || {};
        if (typeof k.time !== "number") {
          return AELL_err("keys[" + i + "] needs {time (seconds), vertices}");
        }
        try { shapes.push(buildShape(k, closedDefault, "keys[" + i + "]: ")); }
        catch (eB) { return AELL_err(eB.message); }
        var st = snap(Number(k.time));
        if (Math.abs(st - Number(k.time)) > 1e-9) snapped++;
        times.push(st);
      }
      var want = animatedWith || shapes[0].vertices.length;
      var wantFrom = animatedWith ? "the existing keys" : "keys[0]";
      for (i = 0; i < shapes.length; i++) {
        if (shapes[i].vertices.length !== want) {
          return AELL_err(AELL_maskPointMix(mask.name, "keys[" + i + "]",
            shapes[i].vertices.length, want, wantFrom));
        }
      }
      // Snapping can drop two nearby requests onto the same frame, where
      // the second silently overwrites the first: keysSet said 3, numKeys
      // said 2, and nothing named the key that vanished.
      var tol = fd ? fd * 0.5 : 1e-9;
      for (i = 0; i < times.length; i++) {
        for (j = i + 1; j < times.length; j++) {
          if (Math.abs(times[i] - times[j]) < tol) {
            return AELL_err("keys[" + i + "] (" + args.keys[i].time +
              "s) and keys[" + j + "] (" + args.keys[j].time + "s) both " +
              "land on the same frame of comp '" + comp.name + "'" +
              (fd ? " (frame " + Math.round(times[i] / fd) + " at " + fps +
                    " fps, one frame is " + r4(fd) + "s)" : "") +
              " -- the later one would silently overwrite the earlier. " +
              "Put them on different frames.");
          }
        }
      }
      var frames = [], keyTimes = [];
      for (i = 0; i < shapes.length; i++) {
        pathProp.setValueAtTime(times[i], shapes[i]);
        frames.push(fd ? Math.round(times[i] / fd) : r4(times[i]));
        keyTimes.push(r4(times[i]));
      }
      var res = { layer: layer.name, mask: mask.name,
        keysSet: shapes.length, numKeys: pathProp.numKeys, points: want,
        keyTimes: keyTimes, note: "Mask path animated" };
      if (fd) res.keyFrames = frames;
      if (snapped) {
        res.snappedToFrames = snapped;
        res.note = "Mask path animated; " + snapped + " key time(s) moved " +
          "to the nearest frame of a " + fps + " fps comp";
      }
      // Keys that all hold the same shape are legal, and they read as an
      // animation in every count this tool reports. Say so instead.
      var moves = false;
      for (i = 1; i < shapes.length && !moves; i++) {
        for (j = 0; j < want; j++) {
          if (shapes[i].vertices[j][0] !== shapes[0].vertices[j][0] ||
              shapes[i].vertices[j][1] !== shapes[0].vertices[j][1]) {
            moves = true;
            break;
          }
        }
      }
      if (!moves) {
        res.stillFrame = true;
        res.note = "Keys written, but every key holds the SAME points -- " +
          "the mask will not move. Give the keys different vertices.";
      }
      return AELL_okay(res);
    }
    var shape;
    try { shape = buildShape(args, closedDefault, ""); }
    catch (eS) { return AELL_err(eS.message); }
    if (typeof args.atTime === "number") {
      if (animatedWith && shape.vertices.length !== animatedWith) {
        return AELL_err(AELL_maskPointMix(mask.name, "this shape",
          shape.vertices.length, animatedWith, "the existing keys"));
      }
      var at = snap(Number(args.atTime));
      pathProp.setValueAtTime(at, shape);
      var one = { layer: layer.name, mask: mask.name, keyframed: true,
        time: r4(at), numKeys: pathProp.numKeys,
        points: shape.vertices.length };
      if (fd) one.frame = Math.round(at / fd);
      if (Math.abs(at - Number(args.atTime)) > 1e-9) {
        one.note = "atTime " + args.atTime + " moved to the nearest frame " +
          "of a " + fps + " fps comp";
      }
      return AELL_okay(one);
    }
    // A static setValue on top of keyframes is refused by AE with a
    // message that never mentions the mask; name the real situation.
    if (animatedWith) {
      return AELL_err("Mask '" + mask.name + "' on '" + layer.name +
        "' is already animated (" + pathProp.numKeys + " keyframes) -- a " +
        "static path cannot replace them. Pass 'atTime' to add one " +
        "keyframe, 'keys' to rewrite the animation, or clear it first " +
        "with remove_keyframes.");
    }
    pathProp.setValue(shape);
    return AELL_okay({ layer: layer.name, mask: mask.name,
                       points: args.vertices.length });
  } catch (e2) {
    return AELL_err(e2.message || String(e2));
  }
};

// -------------------------------------------------- shape layer contents

var AELL_SHAPE_KINDS = {
  group:            "ADBE Vector Group",
  rectangle:        "ADBE Vector Shape - Rect",
  ellipse:          "ADBE Vector Shape - Ellipse",
  star:             "ADBE Vector Shape - Star",
  polygon:          "ADBE Vector Shape - Star",
  path:             "ADBE Vector Shape - Group",
  fill:             "ADBE Vector Graphic - Fill",
  stroke:           "ADBE Vector Graphic - Stroke",
  gradient_fill:    "ADBE Vector Graphic - G-Fill",
  gradient_stroke:  "ADBE Vector Graphic - G-Stroke",
  repeater:         "ADBE Vector Filter - Repeater",
  trim_paths:       "ADBE Vector Filter - Trim",
  merge_paths:      "ADBE Vector Filter - Merge",
  offset_paths:     "ADBE Vector Filter - Offset",
  rounded_corners:  "ADBE Vector Filter - RC",
  pucker_bloat:     "ADBE Vector Filter - PB",
  twist:            "ADBE Vector Filter - Twist",
  zigzag:           "ADBE Vector Filter - Zigzag"
};

/*
 * The shape-content kinds that CHANGE other content instead of drawing.
 * Measured in AE 2026 (probe in WORKPLAN-LOG 2026-08-28): one of these
 * acts on the items ABOVE it in its group's list, and addProperty always
 * appends BELOW — so a repeater added after the rectangle repeats it
 * (bounds 100 -> 500 px with 3 copies at +200), and the same repeater
 * moved to index 1 renders a single copy. A filter with no geometry
 * above it is a silent no-op, and adding the shape afterwards does not
 * rescue it, because that shape lands below the filter too.
 */
var AELL_SHAPE_FILTERS = {
  repeater: 1, trim_paths: 1, merge_paths: 1, offset_paths: 1,
  rounded_corners: 1, pucker_bloat: 1, twist: 1, zigzag: 1
};

/* Does this content item put geometry on the canvas? A fill or a stroke
   colours a path; on its own it draws nothing, so it does not count. */
function AELL_makesGeometry(mn) {
  var s = String(mn || "");
  return s === "ADBE Vector Group" || s.indexOf("ADBE Vector Shape - ") === 0;
}

/* Find a shape group by name anywhere in the contents tree. */
function AELL_findShapeGroup(node, name, depth) {
  var n = 0;
  try { n = node.numProperties || 0; } catch (e) { return null; }
  for (var i = 1; i <= n; i++) {
    var c = null;
    try { c = node.property(i); } catch (e2) { continue; }
    if (!c || c.matchName !== "ADBE Vector Group") continue;
    if (c.name === name) return c;
    if (depth > 1) {
      var inner = c.property("ADBE Vectors Group");
      var hit = inner ? AELL_findShapeGroup(inner, name, depth - 1) : null;
      if (hit) return hit;
    }
  }
  return null;
}

function AELL_listShapeGroups(node, out, depth) {
  var n = 0;
  try { n = node.numProperties || 0; } catch (e) { return; }
  for (var i = 1; i <= n; i++) {
    var c = null;
    try { c = node.property(i); } catch (e2) { continue; }
    if (!c || c.matchName !== "ADBE Vector Group") continue;
    out.push(c.name);
    if (depth > 1) {
      var inner = c.property("ADBE Vectors Group");
      if (inner) AELL_listShapeGroups(inner, out, depth - 1);
    }
  }
}

/* Depth-limited search for a descendant LEAF property by name/matchName. */
function AELL_findDescendantProp(node, name, depth) {
  var n = 0;
  try { n = node.numProperties || 0; } catch (e) { return null; }
  var i, c;
  for (i = 1; i <= n; i++) {
    try { c = node.property(i); } catch (e2) { continue; }
    if (c && (c.name === name || c.matchName === name) &&
        AELL_isLeafProp(c)) return c;
  }
  if (depth > 1) {
    for (i = 1; i <= n; i++) {
      try { c = node.property(i); } catch (e3) { continue; }
      if (c && !AELL_isLeafProp(c)) {
        var hit = AELL_findDescendantProp(c, name, depth - 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function AELL_leafNames(node, out, depth) {
  var n = 0;
  try { n = node.numProperties || 0; } catch (e) { return; }
  for (var i = 1; i <= n && out.length < 20; i++) {
    var c = null;
    try { c = node.property(i); } catch (e2) { continue; }
    if (!c) continue;
    if (AELL_isLeafProp(c)) out.push(c.name);
    else if (depth > 1) AELL_leafNames(c, out, depth - 1);
  }
}

AELL_TOOLS.add_shape_content = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var root = layer.property("ADBE Root Vectors Group");
  if (!root) {
    return AELL_err("Layer '" + layer.name + "' is not a SHAPE layer — " +
                    "create one with add_shape_layer first");
  }
  var kindKey = String(args.kind || "");
  var matchName = AELL_SHAPE_KINDS[kindKey] ||
    (kindKey.indexOf("ADBE ") === 0 ? kindKey : null);
  if (!matchName) {
    var kinds = [];
    for (var kk in AELL_SHAPE_KINDS) {
      if (AELL_SHAPE_KINDS.hasOwnProperty(kk)) kinds.push(kk);
    }
    return AELL_err("Unknown kind '" + args.kind + "'. Kinds: " +
                    kinds.join(", ") + " (or a raw ADBE match name)");
  }
  var container = root;
  var into = "(layer root)";
  if (args.group) {
    var grp = AELL_findShapeGroup(root, String(args.group), 3);
    if (!grp) {
      var gnames = [];
      AELL_listShapeGroups(root, gnames, 3);
      return AELL_err("Group not found: " + args.group + ". Groups here: " +
        (gnames.join(", ") || "(none — add one with kind: 'group')"));
    }
    container = grp.property("ADBE Vectors Group") || grp;
    into = grp.name;
  }
  var can = true;
  try {
    if (typeof container.canAddProperty === "function") {
      can = container.canAddProperty(matchName);
    }
  } catch (eC) {}
  if (!can) {
    return AELL_err("'" + kindKey + "' cannot be added into " + into);
  }
  var item;
  try {
    item = container.addProperty(matchName);
  } catch (e) {
    return AELL_err("AE refused to add '" + kindKey + "': " +
                    (e.message || e));
  }
  if (args.name) item.name = String(args.name);
  if (kindKey === "polygon") {
    var typeProp = AELL_findDescendantProp(item, "ADBE Vector Star Type", 2);
    if (typeProp) typeProp.setValue(2);
  }
  var applied = [];
  if (args.params && typeof args.params === "object") {
    for (var key in args.params) {
      if (!args.params.hasOwnProperty(key)) continue;
      var prop = AELL_findDescendantProp(item, key, 3);
      if (!prop) {
        var leaves = [];
        AELL_leafNames(item, leaves, 3);
        return AELL_err("Param '" + key + "' not found on the new " +
          kindKey + " ('" + item.name + "' WAS added). Its params: " +
          (leaves.join(", ") || "(none)"));
      }
      try {
        prop.setValue(args.params[key]);
      } catch (e2) {
        return AELL_err("AE rejected param '" + key + "': " +
                        (e2.message || e2));
      }
      applied.push(key);
    }
  }
  var base = "contents/" +
    (into === "(layer root)" ? "" : into + "/") + item.name + "/";
  var out = { layer: layer.name, added: item.name,
    matchName: matchName, container: into, params: applied.join(", "),
    note: "Animatable via set_keyframes on '" + base + "<param>' paths" +
      (kindKey === "repeater"
        ? " — the offsets are one level down, e.g. '" + base +
          "Transform/Position'"
        : "") };
  if (AELL_SHAPE_FILTERS[kindKey] === 1) {
    var above = 0, myIdx = 0;
    try { myIdx = item.propertyIndex; } catch (eI) { myIdx = 0; }
    for (var si = 1; si < myIdx; si++) {
      var sib = null;
      try { sib = container.property(si); } catch (eS2) { continue; }
      if (sib && AELL_makesGeometry(sib.matchName)) above++;
    }
    if (above === 0) {
      out.warning = "'" + item.name + "' WAS added to " + into + ", but " +
        "nothing above it there draws a shape, so it changes nothing. A " +
        kindKey + " acts on the content ABOVE it in the list, and new " +
        "content is always appended BELOW — so adding the rectangle now " +
        "will NOT fix this. Put the shape in first, then the " + kindKey +
        ", or target a group that already has one.";
    }
  }
  return AELL_okay(out);
};

function AELL_layerNamesOf(layers) {
  var n = [], i;
  for (i = 0; i < layers.length; i++) {
    try { n.push(layers[i].name); } catch (e) {}
  }
  return n.join(", ");
}

/* A layer's identity across a precompose. Layer.id is stable and unique
 * project-wide; object identity is the fallback for a build that does not
 * publish it. Never the INDEX: precompose renumbers the stack. */
function AELL_layerKey(layer) {
  try { if (typeof layer.id === "number") return "id" + layer.id; }
  catch (e) {}
  return null;
}

/* Which of `names` a single expression string quotes. AE addresses a
 * layer by a quoted name (layer("X"), thisComp.layer('X')), so a quoted
 * occurrence is the signal — matching bare text would flag a comment. */
function AELL_exprNamesLayer(expr, names) {
  var s = String(expr), q = ['"', "'"], i, j;
  for (i = 0; i < names.length; i++) {
    for (j = 0; j < q.length; j++) {
      if (s.indexOf(q[j] + names[i] + q[j]) !== -1) return names[i];
    }
  }
  return null;
}

/*
 * precompose. Four things AE does QUIETLY here, all measured in AE 2026
 * (probe in WORKPLAN-LOG 2026-08-28) and all reported rather than fixed
 * behind the user's back:
 *
 *  - A moved layer whose PARENT stayed behind loses the parent outright.
 *    (The reverse — a layer left behind whose parent moved in — is
 *    re-pointed by AE at the new precomp, and a parent/child pair moved
 *    together keeps its link, so only this one direction loses anything.)
 *  - With moveAttributes TRUE, an expression on a layer left behind that
 *    names a moved layer is NOT rewritten and NOT flagged: expressionError
 *    stays empty while the reference dangles. With moveAttributes FALSE
 *    AE does rewrite it (to the new precomp layer), so the scan only runs
 *    for the true case.
 *  - AE lets a SECOND item take the requested name. Two comps with one
 *    name make the later one unreachable by name, so this auto-numbers
 *    and redirects the rest of the request exactly as create_comp does.
 *  - Precomposing selects the new layer and drops the user's selection.
 */
AELL_TOOLS.precompose = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (!args.name) return AELL_err("'name' is required");
  if (!AELLJSON.isArray(args.layers) || args.layers.length === 0) {
    return AELL_err("'layers' (array of names or 1-based indices) is required");
  }
  var i, j;
  var layers = [], indices = [], seen = {}, dupes = [];
  for (i = 0; i < args.layers.length; i++) {
    var L = AELL_resolveLayer(comp, args.layers[i]);
    // A repeated reference used to inflate layersMoved: AE tolerates
    // [2, 2] and moves ONE layer, and the tool reported two.
    if (seen[L.index]) {
      if (!seen["dupe" + L.index]) { seen["dupe" + L.index] = true;
                                     dupes.push(L.name); }
      continue;
    }
    seen[L.index] = true;
    layers.push(L);
    indices.push(L.index);
  }
  var move = args.moveAttributes !== false;
  if (!move && indices.length > 1) {
    return AELL_err("moveAttributes:false only works on ONE layer — AE " +
      "refuses it for " + indices.length + " (" + AELL_layerNamesOf(layers) +
      "). Leaving attributes behind means the new comp takes that single " +
      "layer's own size, which is undefined for several. Drop " +
      "moveAttributes to move them all in together.");
  }

  // Everything worth reporting has to be read BEFORE the move: afterwards
  // the moved layers belong to another comp and the survivors have
  // already been rewired.
  var movedNames = [], movedKeys = {}, parentsLost = [];
  for (i = 0; i < layers.length; i++) {
    movedNames.push(layers[i].name);
    var k = AELL_layerKey(layers[i]);
    if (k) movedKeys[k] = true;
  }
  for (i = 0; i < layers.length; i++) {
    var par = null;
    try { par = layers[i].parent; } catch (eP) {}
    if (!par) continue;
    var parIn = false;
    for (j = 0; j < layers.length; j++) {
      if (layers[j] === par) { parIn = true; break; }
    }
    if (!parIn) {
      parentsLost.push(layers[i].name + " (was parented to " + par.name + ")");
    }
  }
  // Keys and NAMES only, never the layer objects: precompose DESTROYS the
  // layers it moves (AE builds fresh ones inside the precomp), so a
  // reference held across the call throws "Object is invalid" the moment
  // it is read — which is what the first cut of this restore did whenever
  // the whole selection went in.
  var prevKeys = [], prevNames = [], haveKeys = false;
  try {
    var sel = comp.selectedLayers;
    for (i = 0; i < sel.length; i++) {
      var sk = AELL_layerKey(sel[i]);
      if (sk) haveKeys = true;
      prevKeys.push(sk);
      prevNames.push(sel[i].name);
    }
  } catch (eS) {}

  var name = AELL_uniqueItemName(String(args.name));
  if (!$.global.AELL_compAliases) $.global.AELL_compAliases = {};
  if (name !== String(args.name)) {
    $.global.AELL_compAliases[String(args.name)] = name;
  } else {
    delete $.global.AELL_compAliases[String(args.name)];
  }
  var pre = comp.layers.precompose(indices, name, move);

  // Put the user's selection back, minus whatever went into the precomp
  // (those objects are valid but now live in ANOTHER comp — selecting
  // them there is worse than not restoring at all).
  var restored = [];
  for (j = 1; j <= comp.numLayers; j++) {
    var cand = comp.layer(j);
    var ck = AELL_layerKey(cand);
    for (i = 0; i < prevKeys.length; i++) {
      // Names are the fallback for a build with no Layer.id, and only
      // then: two layers may share a name, ids never do.
      var same = haveKeys ? (ck && ck === prevKeys[i])
                          : (cand.name === prevNames[i]);
      if (same) { restored.push(cand); break; }
    }
  }
  if (restored.length) {
    try {
      for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
      for (i = 0; i < restored.length; i++) restored[i].selected = true;
    } catch (eR) {}
  }

  // Expressions left behind that still name a layer that moved.
  var atRisk = [];
  if (move) {
    for (i = 1; i <= comp.numLayers && atRisk.length < 8; i++) {
      var survivor = comp.layer(i);
      var hits = [];
      try { AELL_walkExpressions(survivor, hits, comp.name, survivor.name); }
      catch (eW) {}
      for (j = 0; j < hits.length && atRisk.length < 8; j++) {
        var named = AELL_exprNamesLayer(hits[j].expression, movedNames);
        if (named) {
          atRisk.push(survivor.name + " > " + hits[j].property +
                      " names '" + named + "'");
        }
      }
    }
  }

  var out = { precomp: pre.name, id: pre.id, layersMoved: indices.length,
              layers: movedNames.join(", "),
              selectionKept: restored.length
                ? AELL_layerNamesOf(restored)
                : "(none survived — AE's new '" + pre.name +
                  "' layer is selected)" };
  if (dupes.length) {
    out.duplicatesIgnored = dupes.join(", ") +
      " — named more than once; each layer moves once.";
  }
  if (parentsLost.length) {
    out.parentsBroken = parentsLost.join("; ") +
      ". AE drops a parent that stayed behind; re-parent inside '" +
      pre.name + "' or precompose the parent too.";
  }
  if (atRisk.length) {
    out.expressionsAtRisk = atRisk.join("; ") +
      ". Those layers are no longer in '" + comp.name +
      "' and AE does NOT report the broken reference.";
  }
  if (!move) {
    out.note = "moveAttributes:false — '" + pre.name + "' is the SIZE OF " +
      "THE LAYER (" + pre.width + "x" + pre.height + "), not of '" +
      comp.name + "', and the transform stayed outside.";
  } else if (name !== String(args.name)) {
    out.note = "An item named '" + args.name + "' already existed — this " +
      "precomp is '" + name + "'. Use THIS name in every following command.";
  }
  return AELL_okay(out);
};

AELL_TOOLS.add_camera = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var center = [comp.width / 2, comp.height / 2];
  var cam = AELL_keepSelection(comp, function () {
    return comp.layers.addCamera(args.name ? String(args.name) : "Camera",
                                 center);
  });
  var xform = cam.property("ADBE Transform Group");
  if (AELLJSON.isArray(args.position) && args.position.length >= 3) {
    xform.property("ADBE Position").setValue(args.position);
  }
  var wantsPoi = AELLJSON.isArray(args.pointOfInterest) &&
                 args.pointOfInterest.length >= 3;
  if (args.oneNode === true) {
    if (wantsPoi) {
      return AELL_err("A one-node camera has no Point of Interest to aim " +
        "at. Drop 'pointOfInterest', or drop 'oneNode' for a two-node " +
        "camera that aims at one.");
    }
    // Must happen BEFORE any Point of Interest write: a one-node camera
    // HIDES that property, and writing a hidden property throws.
    cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
  } else if (wantsPoi) {
    xform.property("ADBE Anchor Point").setValue(args.pointOfInterest);
  }
  if (args.zoom > 0) {
    cam.property("ADBE Camera Options Group")
       .property("ADBE Camera Zoom").setValue(args.zoom);
  }
  return AELL_okay({ index: cam.index, name: cam.name,
                     note: "Layers must be 3D (set_layer_3d) to be seen by a camera" });
};

/*
 * Lights. Every rule below was MEASURED against AE 2026 (probe,
 * WORKPLAN-LOG 2026-08-26), because a light lies about itself:
 *
 *  - `canSetValue` is FALSE for every Light Options property and every
 *    light transform property, INCLUDING the ones that write fine, and
 *    `elided` is false everywhere. Neither can gate anything. The
 *    per-type table below is the only truth.
 *  - The Light Options group carries all 14 properties on EVERY type —
 *    it never shrinks — so walking it tells you nothing about what the
 *    type actually accepts.
 *  - Writing one the type hides throws AE's "property or a parent
 *    property is hidden", the same wall the cameras hit.
 *  - AE 2026 has FIVE types: ENVIRONMENT (4416) joined the four from
 *    training, hence the typeof guard on older builds.
 *  - `addLight` requires BOTH arguments; a one-arg call throws.
 *  - A new light defaults to SPOT, and its Falloff defaults to none.
 */
var AELL_LIGHT_KINDS = ["parallel", "spot", "point", "ambient", "environment"];

var AELL_FALLOFF = { none: 1, smooth: 2, inversesquareclamped: 3 };
/* Echo the spelling the tool DOCS use, not the lowercased key — the
 * model copies whatever a refusal shows it back into the next call. */
var AELL_FALLOFF_NAME = { none: "none", smooth: "smooth",
                          inversesquareclamped: "inverseSquareClamped" };

/* arg -> the types that ACCEPT it. Order is the WRITE order: Falloff
 * must land before Radius/Falloff Distance, which it gates. */
var AELL_LIGHT_OPTS = [
  { arg: "intensity",       mn: "ADBE Light Intensity",
    on: "parallel spot point ambient environment", kind: "number" },
  { arg: "color",           mn: "ADBE Light Color",
    on: "parallel spot point ambient environment", kind: "color" },
  { arg: "coneAngle",       mn: "ADBE Light Cone Angle",
    on: "spot", kind: "number" },
  { arg: "coneFeather",     mn: "ADBE Light Cone Feather 2",
    on: "spot", kind: "number" },
  { arg: "falloff",         mn: "ADBE Light Falloff Type",
    on: "parallel spot point", kind: "falloff" },
  { arg: "radius",          mn: "ADBE Light Falloff Start",
    on: "parallel spot point", kind: "number",
    needsFalloff: "smooth inverseSquareClamped" },
  { arg: "falloffDistance", mn: "ADBE Light Falloff Distance",
    on: "parallel spot point", kind: "number",
    needsFalloff: "smooth" },
  { arg: "castsShadows",    mn: "ADBE Casts Shadows",
    on: "parallel spot point", kind: "bool" },
  { arg: "shadowDarkness",  mn: "ADBE Light Shadow Darkness",
    on: "parallel spot point", kind: "number" },
  { arg: "shadowDiffusion", mn: "ADBE Light Shadow Diffusion",
    on: "spot point", kind: "number" }
];

/* Transform properties a light type will let you write (measured).
 * ambient and environment accept NONE of them — not even Position. */
var AELL_LIGHT_XFORM = {
  position:        { mn: "ADBE Position",     on: "parallel spot point" },
  pointOfInterest: { mn: "ADBE Anchor Point", on: "parallel spot" }
};

/* The Light Options that are measured in PIXELS, and the gate each one
 * sits behind. They are what a comp resize owes a light, and they live
 * OUTSIDE the Transform group — so, exactly like camera Zoom, no parent
 * ever passes a resize down to them.
 *
 * Measured in real AE 2026 (probes 5-7, WORKPLAN-LOG 2026-08-28):
 *   Radius            parallel/spot/point, while Falloff is smooth or
 *                     inverseSquareClamped
 *   Falloff Distance  parallel/spot/point, while Falloff is smooth ONLY
 *   Shadow Diffusion  spot/point, any falloff, shadows on or off
 * Writing one AE currently hides throws "the property or a parent
 * property is hidden", and the flags lie about it — a hidden Radius
 * still reports elided=false and enabled=true — so the light TYPE plus
 * the falloff VALUE is the only reliable test, the same lesson cameras
 * taught about their hidden Scale.
 *
 * Everything else in the group is a percentage, an angle or a colour,
 * and a resize must NOT touch those. Falloff is stored as a number:
 * 1 none, 2 smooth, 3 inverseSquareClamped. */
var AELL_LIGHT_PIXEL_OPTS = [
  { mn: "ADBE Light Falloff Start",    label: "Radius",
    on: "parallel spot point", falloff: "2 3" },
  { mn: "ADBE Light Falloff Distance", label: "Falloff Distance",
    on: "parallel spot point", falloff: "2" },
  { mn: "ADBE Light Shadow Diffusion", label: "Shadow Diffusion",
    on: "spot point",          falloff: "" }
];

/* The kind name this file speaks, read back off a real layer. */
function AELL_lightKindOf(L) {
  var t;
  if (typeof LightType === "undefined") return "";
  try { t = L.lightType; } catch (eT) { return ""; }
  if (t === LightType.PARALLEL) return "parallel";
  if (t === LightType.SPOT) return "spot";
  if (t === LightType.POINT) return "point";
  if (t === LightType.AMBIENT) return "ambient";
  if (typeof LightType.ENVIRONMENT !== "undefined" &&
      t === LightType.ENVIRONMENT) return "environment";
  return "";
}

/* Ambient and environment lights light the whole scene from nowhere: AE
 * hides their Position, their aim and every pixel option, so a resize has
 * literally nothing to scale on them. Writing anyway is what used to make
 * scale_comp report an ambient light as a FAILURE. */
function AELL_lightHasGeometry(kind) {
  return AELL_lightAccepts(AELL_LIGHT_XFORM.position.on, kind);
}

/* Every falloff value IN PLAY on this light. Falloff Type is itself
 * keyframeable (measured), so a light can be smooth for part of its life;
 * when it is keyed, the keys are the answer, not the value under the
 * playhead. */
function AELL_lightFalloffs(opts) {
  var out = { values: [], keyed: false }, p = null, n = 0, k;
  try { p = opts.property("ADBE Light Falloff Type"); } catch (eP) { return out; }
  if (!p) return out;
  try { n = p.numKeys; } catch (eN) { n = 0; }
  if (n) {
    out.keyed = true;
    for (k = 1; k <= n; k++) {
      try { out.values.push(String(p.keyValue(k))); } catch (eK) {}
    }
    return out;
  }
  try { out.values.push(String(p.value)); } catch (eV) {}
  return out;
}

/* Does any falloff this light actually uses open the gate? */
function AELL_falloffInPlay(gate, falloffs) {
  for (var i = 0; i < falloffs.values.length; i++) {
    if (AELL_lightAccepts(gate, falloffs.values[i])) return true;
  }
  return false;
}

/* "a spot" but "an ambient" — these strings are what the model reads. */
function AELL_lightArticle(kind) {
  return (kind === "ambient" || kind === "environment") ? "An " : "A ";
}

/* Space-separated membership, so "point" never matches "pointOfInterest". */
function AELL_lightAccepts(list, kind) {
  return (" " + list + " ").indexOf(" " + kind + " ") >= 0;
}

/* Which types DO take this arg — so a refusal names the way forward. */
function AELL_lightTypesFor(list) {
  return list.split(" ").join(", ");
}

/* What THIS type accepts, for the same reason. */
function AELL_lightArgsFor(kind) {
  var out = [], i, k;
  for (i = 0; i < AELL_LIGHT_OPTS.length; i++) {
    if (AELL_lightAccepts(AELL_LIGHT_OPTS[i].on, kind)) {
      out.push(AELL_LIGHT_OPTS[i].arg);
    }
  }
  for (k in AELL_LIGHT_XFORM) {
    if (AELL_LIGHT_XFORM.hasOwnProperty(k) &&
        AELL_lightAccepts(AELL_LIGHT_XFORM[k].on, kind)) out.push(k);
  }
  return out.join(", ") || "(nothing but name)";
}

function AELL_lightGiven(args, name) {
  return args[name] !== null && typeof args[name] !== "undefined" &&
         args[name] !== "";
}

AELL_TOOLS.add_light = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var i, o, xk;

  var kind = AELL_lightGiven(args, "type")
    ? String(args.type).toLowerCase() : "spot";
  if (!AELL_lightAccepts(AELL_LIGHT_KINDS.join(" "), kind)) {
    return AELL_err("No light type '" + args.type + "'. AE has: " +
      AELL_LIGHT_KINDS.join(", ") + ".");
  }
  if (kind === "environment" &&
      (typeof LightType === "undefined" ||
       typeof LightType.ENVIRONMENT === "undefined")) {
    return AELL_err("This After Effects (" + app.version + ") has no " +
      "environment light. Available: parallel, spot, point, ambient.");
  }

  /* Validate EVERYTHING before creating the layer — a refusal must not
   * leave a half-configured light behind for the user to clean up. */
  var falloff = AELL_lightGiven(args, "falloff")
    ? String(args.falloff).toLowerCase() : "none";
  if (AELL_lightGiven(args, "falloff") &&
      !AELL_FALLOFF.hasOwnProperty(falloff)) {
    return AELL_err("No falloff '" + args.falloff + "'. AE has: none, " +
      "smooth, inverseSquareClamped.");
  }
  for (i = 0; i < AELL_LIGHT_OPTS.length; i++) {
    o = AELL_LIGHT_OPTS[i];
    if (!AELL_lightGiven(args, o.arg)) continue;
    if (!AELL_lightAccepts(o.on, kind)) {
      return AELL_err(AELL_lightArticle(kind) + kind + " light has no " + o.arg + " — AE " +
        "hides it. Types that take it: " + AELL_lightTypesFor(o.on) +
        ". This light accepts: " + AELL_lightArgsFor(kind) + ".");
    }
    if (o.needsFalloff &&
        !AELL_lightAccepts(o.needsFalloff.toLowerCase(), falloff)) {
      return AELL_err("'" + o.arg + "' only exists while Falloff is " +
        AELL_lightTypesFor(o.needsFalloff) + "; this light's falloff is '" +
        AELL_FALLOFF_NAME[falloff] + "'. Pass falloff: \"" +
        o.needsFalloff.split(" ")[0] + "\" too.");
    }
  }
  for (xk in AELL_LIGHT_XFORM) {
    if (!AELL_LIGHT_XFORM.hasOwnProperty(xk)) continue;
    if (!AELL_lightGiven(args, xk)) continue;
    if (!AELL_lightAccepts(AELL_LIGHT_XFORM[xk].on, kind)) {
      return AELL_err(AELL_lightArticle(kind) + kind + " light has no " + xk + " — AE hides " +
        "it (it lights the whole scene from nowhere). Types that take it: " +
        AELL_lightTypesFor(AELL_LIGHT_XFORM[xk].on) + ".");
    }
    if (!AELLJSON.isArray(args[xk]) || args[xk].length < 3) {
      return AELL_err("'" + xk + "' must be [x, y, z] — lights are 3D.");
    }
  }
  if (args.oneNode === true && AELL_lightGiven(args, "pointOfInterest")) {
    return AELL_err("A one-node light has no Point of Interest to aim " +
      "at. Drop 'pointOfInterest', or drop 'oneNode' to aim it.");
  }

  var center = (AELLJSON.isArray(args.position) && args.position.length >= 2)
    ? [args.position[0], args.position[1]]
    : [comp.width / 2, comp.height / 2];
  var lit = AELL_keepSelection(comp, function () {
    // addLight REQUIRES both arguments; a one-arg call throws.
    return comp.layers.addLight(args.name ? String(args.name) : "Light",
                                center);
  });
  lit.lightType = LightType[kind.toUpperCase()];

  // Before any Point of Interest write: NO_AUTO_ORIENT hides the POI on
  // a light exactly as it does on a camera, and the write would throw.
  if (args.oneNode === true) lit.autoOrient = AutoOrientType.NO_AUTO_ORIENT;

  var xform = lit.property("ADBE Transform Group");
  var applied = [], refused = [];
  if (AELL_lightGiven(args, "position")) {
    xform.property("ADBE Position").setValue(
      [args.position[0], args.position[1], args.position[2]]);
    applied.push("position");
  }
  if (AELL_lightGiven(args, "pointOfInterest")) {
    xform.property("ADBE Anchor Point").setValue(
      [args.pointOfInterest[0], args.pointOfInterest[1],
       args.pointOfInterest[2]]);
    applied.push("pointOfInterest");
  }

  var opts = lit.property("ADBE Light Options Group");
  for (i = 0; i < AELL_LIGHT_OPTS.length; i++) {
    o = AELL_LIGHT_OPTS[i];
    if (!AELL_lightGiven(args, o.arg)) continue;
    var v = args[o.arg];
    if (o.kind === "bool") v = v ? 1 : 0;
    else if (o.kind === "falloff") v = AELL_FALLOFF[falloff];
    else if (o.kind === "color") {
      if (!AELLJSON.isArray(v) || v.length < 3) {
        refused.push(o.arg + " (needs [r, g, b], each 0-1)");
        continue;
      }
      v = [v[0], v[1], v[2]];
    }
    try {
      opts.property(o.mn).setValue(v);
      applied.push(o.arg);
    } catch (e) {
      // The table said this type takes it, so a throw here is news.
      refused.push(o.arg + " (" + (e.message || e) + ")");
    }
  }

  return AELL_okay({ index: lit.index, name: lit.name, type: kind,
    applied: applied.join(", ") || "(defaults only)",
    refused: refused.join("; "),
    note: "Only 3D layers (set_layer_3d) with Material Options > " +
          "Accepts Lights are lit by this" });
};

/*
 * add_marker. Measured in AE 2026 (probe in WORKPLAN-LOG 2026-08-28):
 *
 *  - A marker written at a time that already HAS one REPLACES it, comment
 *    and duration and all, and setValueAtTime reports nothing. That is a
 *    silent loss, so the old comment comes back in `replaced`.
 *  - Marker times are COMPOSITION time on a layer too: a marker keeps its
 *    place in the comp view, and moving the layer's startTime carries it
 *    (keyTime read 3, then 5 after startTime went to 2). No conversion.
 *  - AE accepts a marker anywhere on the number line — negative, or past
 *    the end of the comp — where the user can never see it. Allowed, but
 *    named.
 *  - Times are NOT snapped to frames: 1.2345 stored as 1.23449707, and a
 *    marker 0.0001s from another is a SECOND marker on the same frame.
 */
AELL_TOOLS.add_marker = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var time = AELL_numArg(args.time);
  if (time === null) {
    return AELL_err("'time' (seconds, composition time) is required" +
      (typeof args.time === "undefined" ? "" :
       " — got " + AELL_showValue(args.time)));
  }
  var dur = 0;
  if (args.duration !== null && typeof args.duration !== "undefined" &&
      args.duration !== "") {
    dur = AELL_numArg(args.duration);
    if (dur === null || dur < 0) {
      return AELL_err("'duration' must be a number of seconds >= 0 — got " +
        AELL_showValue(args.duration) + ". Omit it for a plain marker.");
    }
  }
  var mv = new MarkerValue(typeof args.comment === "string" ? args.comment : "");
  if (dur > 0) mv.duration = dur;
  var target, where, layer = null;
  if (args.layer !== null && typeof args.layer !== "undefined" &&
      args.layer !== "") {
    layer = AELL_resolveLayer(comp, args.layer);
    target = layer.property("ADBE Marker");
    where = "layer " + layer.name;
  } else {
    target = comp.markerProperty;
    where = "comp " + comp.name;
  }

  // What is about to be overwritten. AE matches on an EXACT time, so the
  // window is far tighter than a frame (0.0001s apart made two markers).
  var i, before = target.numKeys, doomed = null;
  for (i = 1; i <= before; i++) {
    if (Math.abs(target.keyTime(i) - time) < 1e-6) {
      try { doomed = target.keyValue(i); } catch (eK) {}
      break;
    }
  }
  target.setValueAtTime(time, mv);

  var out = { marker: where, time: time,
              comment: mv.comment, duration: dur,
              markers: target.numKeys };
  if (doomed && target.numKeys === before) {
    out.replaced = "A marker already at " + time + "s was overwritten: " +
      (doomed.comment ? "'" + doomed.comment + "'" : "(no comment)") +
      (doomed.duration > 0 ? ", duration " + doomed.duration + "s" : "") +
      ". AE keeps one marker per exact time.";
  }
  if (time < 0 || time > comp.duration) {
    out.note = "Outside '" + comp.name + "' (0 to " + comp.duration +
      "s) — the marker exists but is off the visible timeline.";
  } else if (layer && (time < layer.inPoint || time > layer.outPoint)) {
    out.note = "Outside " + layer.name + "'s own span (" + layer.inPoint +
      " to " + layer.outPoint + "s) — the marker rides the layer and is " +
      "not visible where the layer is not.";
  }
  return AELL_okay(out);
};

/* What a 3D -> 2D switch throws away. Measured in AE 2026 (probe in
 * WORKPLAN-LOG 2026-08-28): Position Z and Anchor Point Z are zeroed,
 * Scale Z snaps back to 100, and Orientation / X Rotation / Y Rotation
 * are cleared. Z Rotation survives (it is just renamed back to
 * "Rotation"). Keyframes survive too, but their doomed components are
 * flattened with them, and turning 3D back ON does NOT restore any of
 * it. Rows are [matchName, label, zOnly, valueAEKeeps]; zOnly true means
 * only the third component dies, false means the whole value does. */
var AELL_3D_ONLY = [
  ["ADBE Position",     "Position",     true,    0],
  ["ADBE Anchor Point", "Anchor Point", true,    0],
  ["ADBE Scale",        "Scale",        true,  100],
  ["ADBE Orientation",  "Orientation",  false,   0],
  ["ADBE Rotate X",     "X Rotation",   false,   0],
  ["ADBE Rotate Y",     "Y Rotation",   false,   0]
];

/* One property's share of that loss, described, or "" when it has
 * nothing to lose. Keyframed properties are inspected key by key: a
 * layer whose Z is 0 at the current time but 500 at the next keyframe
 * loses just as much, and reading only the static value would miss it. */
function AELL_3dLossFor(prop, label, zOnly, keep) {
  function doomed(val) {
    var arr = (typeof val === "number") ? [val] : val;
    var hit = [], i;
    if (zOnly) {
      if (arr.length > 2 && arr[2] !== keep) {
        hit.push(Math.round(arr[2] * 100) / 100);
      }
    } else {
      for (i = 0; i < arr.length; i++) {
        if (arr[i] !== keep) hit.push(Math.round(arr[i] * 100) / 100);
      }
    }
    return hit;
  }
  var name = label + (zOnly ? " Z" : "");
  var hit, i, j;
  // Keyframes come FIRST even when an expression is also on the property.
  // The expression only decides what renders; the keyframe values are the
  // stored data AE flattens, and they are the concrete thing to name. Read
  // the other way round, a wiggle on Position reports its own noise as the
  // loss and never mentions the 500 sitting on the next key.
  if (prop.numKeys > 0) {
    var keys = 0, worst = null;
    for (i = 1; i <= prop.numKeys; i++) {
      hit = doomed(prop.keyValue(i));
      if (!hit.length) continue;
      keys++;
      for (j = 0; j < hit.length; j++) {
        if (worst === null || Math.abs(hit[j]) > Math.abs(worst)) {
          worst = hit[j];
        }
      }
    }
    if (!keys) return "";
    return name + " on " + keys + " of " + prop.numKeys +
           " keyframes (largest " + worst + ")";
  }
  if (prop.expressionEnabled) {
    // The expression itself survives the switch; the third dimension it
    // was writing into does not, so what it evaluates to today is the
    // only honest number available for the loss.
    hit = doomed(prop.value);
    if (!hit.length) return "";
    return name + " (expression-driven, currently " + hit.join(",") + ")";
  }
  hit = doomed(prop.value);
  if (!hit.length) return "";
  return name + " " + hit.join(",");
}

function AELL_3dOnlyLoss(layer) {
  var lost = [], i, row, prop, desc, group;
  try { group = layer.property("ADBE Transform Group"); } catch (eG) { return lost; }
  if (!group) return lost;
  for (i = 0; i < AELL_3D_ONLY.length; i++) {
    row = AELL_3D_ONLY[i];
    prop = null;
    try { prop = group.property(row[0]); } catch (eP) { prop = null; }
    if (!prop) continue;
    desc = "";
    try { desc = AELL_3dLossFor(prop, row[1], row[2], row[3]); }
    catch (eD) { desc = ""; }
    if (desc) lost.push(desc);
  }
  return lost;
}

AELL_TOOLS.set_layer_3d = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var want = !!args.enabled;
  // Read BEFORE the write: afterwards the values are already gone, and
  // AE reports nothing about having taken them. The user asked for 2D,
  // so this neither refuses nor restores -- it only refuses to let the
  // loss happen in silence.
  var lost = (layer.threeDLayer && !want) ? AELL_3dOnlyLoss(layer) : [];
  layer.threeDLayer = want;
  var out = { layer: layer.name, threeD: layer.threeDLayer };
  if (lost.length) {
    out.discarded = lost;
    out.note = "Going 2D cleared these 3D-only values and turning 3D " +
      "back on does NOT restore them: " + lost.join("; ");
  }
  return AELL_okay(out);
};

/* MEASURED in AE 2026 (26.3x87) -- the two ways to set a parent do the
 * OPPOSITE of what the names suggest, and this tool had them the wrong
 * way round from the day it shipped:
 *
 *  - `L.parent = p` is the pick-whip. AE REWRITES the child's transform
 *    so nothing moves on screen: a child at [400,300] under a parent
 *    whose layer origin sits at [50,50] reads back [350,250]. Scale and
 *    Rotation are compensated too (a 200%/45deg parent left the child
 *    50%/-45), Z included, and EVERY keyframe is rewritten, not just the
 *    current value.
 *  - `L.setParentWithJump(p)` leaves every value alone, so the layer
 *    JUMPS by the parent's transform.
 *
 * Unparenting obeys the same rule: `.parent = null` restores comp-space
 * values, `setParentWithJump(null)` leaves the child where the parent
 * had been putting it.
 *
 * So keepPosition (the default) is `.parent =`, NOT setParentWithJump.
 * The old code chose setParentWithJump for keepPosition and then
 * reported "Visual positions preserved" over the top of the jump. */

/* How many keyframes AE is about to rewrite on this layer. Only the
 * properties parenting compensates are counted; a layer with none gets
 * no note. Failures here are never fatal -- this is reporting. */
/* The transform properties AE's parent compensation writes, with the
 * names a user would recognise. */
var AELL_XFORM_PROPS = [
  ["ADBE Anchor Point", "Anchor Point"], ["ADBE Position", "Position"],
  ["ADBE Scale", "Scale"], ["ADBE Rotate Z", "Rotation"],
  ["ADBE Rotate X", "X Rotation"], ["ADBE Rotate Y", "Y Rotation"],
  ["ADBE Orientation", "Orientation"]
];

/* Which of a layer's transform properties MOVE over time. Keyframes and
 * expressions both count: probe F used an expression with zero keys and
 * the parent travelled 400 px anyway, which the old key-count accounting
 * could never have seen. */
function AELL_animatedXform(layer) {
  var out = [], i, p, grp;
  try { grp = layer.property("ADBE Transform Group"); } catch (eG) { return out; }
  if (!grp) return out;
  for (i = 0; i < AELL_XFORM_PROPS.length; i++) {
    try {
      p = grp.property(AELL_XFORM_PROPS[i][0]);
      if (!p) continue;
      if (p.numKeys > 0) {
        out.push(AELL_XFORM_PROPS[i][1] + " (" + p.numKeys + " keys)");
      } else if (p.expressionEnabled && p.expression) {
        out.push(AELL_XFORM_PROPS[i][1] + " (expression)");
      }
    } catch (eP) {}
  }
  return out;
}

/* ...and the same question for a layer AND everything it hangs from: a
 * still parent bolted to a moving grandparent moves in comp space, so
 * the compensation is just as time-local. Depth-capped; AE forbids
 * cycles, but an unattended walk should not depend on that. */
function AELL_movingChain(layer) {
  var out = [], L = layer, hops = 0, a, nx;
  while (L && hops < 30) {
    a = AELL_animatedXform(L);
    if (a.length) out.push(L.name + ": " + a.join(", "));
    nx = null;
    try { nx = L.parent; } catch (eN) { nx = null; }
    L = nx;
    hops++;
  }
  return out;
}

function AELL_parentKeyCount(layer) {
  var names = ["ADBE Position", "ADBE Scale", "ADBE Rotate Z",
               "ADBE Rotate X", "ADBE Rotate Y", "ADBE Orientation"];
  var n = 0, i, p;
  try {
    var grp = layer.property("ADBE Transform Group");
    if (!grp) return 0;
    for (i = 0; i < names.length; i++) {
      try {
        p = grp.property(names[i]);
        if (p && p.numKeys) n += p.numKeys;
      } catch (eP) {}
    }
  } catch (eG) { return 0; }
  return n;
}

AELL_TOOLS.set_layer_parent = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var targets = [];
  var i;
  if (AELLJSON.isArray(args.layers) && args.layers.length > 0) {
    for (i = 0; i < args.layers.length; i++) {
      targets.push(AELL_resolveLayer(comp, args.layers[i]));
    }
  } else if (args.layer !== null && typeof args.layer !== "undefined" &&
             args.layer !== "") {
    targets.push(AELL_resolveLayer(comp, args.layer));
  } else {
    var sel = comp.selectedLayers;
    for (i = 0; i < sel.length; i++) targets.push(sel[i]);
  }
  if (targets.length === 0) {
    return AELL_err("No target layers — select some in AE or pass " +
                    "{layer} / {layers: [...]}");
  }
  var clearing = args.parent === null || typeof args.parent === "undefined" ||
                 args.parent === "" ||
                 String(args.parent).toLowerCase() === "none";
  var parent = clearing ? null : AELL_resolveLayer(comp, args.parent);
  var keep = args.keepPosition !== false;   // default: no visual jump

  /* AE computes the compensation ONCE, from the parent's transform at
   * the PLAYHEAD (probe G, 2026-08-29: the same rig parented at t=1
   * instead of t=0 came out with different numbers and a different frame
   * left standing still). The playhead is wherever the user left it, so
   * the caller gets to pin the frame that must not move. */
  var atTime = null, n;
  if (args.atFrame !== null && typeof args.atFrame !== "undefined" &&
      args.atFrame !== "") {
    n = Number(args.atFrame);
    if (isNaN(n)) {
      return AELL_err("atFrame must be a frame number; got " +
                      AELL_showValue(args.atFrame));
    }
    atTime = n / (comp.frameRate || 1);
  } else if (args.atTime !== null && typeof args.atTime !== "undefined" &&
             args.atTime !== "") {
    n = Number(args.atTime);
    if (isNaN(n)) {
      return AELL_err("atTime must be a number of seconds; got " +
                      AELL_showValue(args.atTime));
    }
    atTime = n;
  }
  if (atTime !== null && !keep) {
    return AELL_err("atTime/atFrame only means something when the layer " +
      "is being kept still. keepPosition:false leaves every value alone, " +
      "so there is no frame to compensate at -- drop one of the two.");
  }
  if (atTime !== null && (atTime < 0 || atTime > comp.duration)) {
    return AELL_err("atTime " + atTime + "s is outside \"" + comp.name +
      "\", which runs 0 to " + comp.duration + "s at " + comp.frameRate +
      " fps");
  }

  var done = [], skipped = [], rekeyed = [], keysTotal = 0;
  var movers = [], m;
  /* Whose motion makes the compensation time-local: the parent being
   * joined, or -- when unparenting -- the parent being left. */
  function noteMover(who) {
    var lines = who ? AELL_movingChain(who) : [], q, r, seen;
    for (q = 0; q < lines.length; q++) {
      seen = false;
      for (r = 0; r < movers.length; r++) {
        if (movers[r] === lines[q]) { seen = true; break; }
      }
      if (!seen) movers.push(lines[q]);
    }
  }

  var prevTime = comp.time;
  if (atTime !== null) comp.time = atTime;
  var usedTime = comp.time;   // AE snaps to a frame; report what it took

  for (i = 0; i < targets.length; i++) {
    var L = targets[i];
    if (parent && L === parent) {
      skipped.push(L.name + " (is the parent)");
      continue;
    }
    try {
      var nk = keep ? AELL_parentKeyCount(L) : 0;
      if (keep) {
        if (clearing) noteMover(L.parent);   // read it BEFORE it is gone
        L.parent = parent;              // AE compensates; nothing moves
      } else if (typeof L.setParentWithJump === "function") {
        L.setParentWithJump(parent);    // values kept; the layer jumps
      } else {
        skipped.push(L.name + " (this After Effects build has no " +
                     "setParentWithJump, so keepPosition:false cannot " +
                     "be honoured -- omit it to keep the layer still)");
        continue;
      }
      done.push(L.name);
      if (nk > 0) {
        rekeyed.push(L.name + " (" + nk + ")");
        keysTotal += nk;
      }
    } catch (e) {
      skipped.push(L.name + " (" + (e.message || e) + ")");
    }
  }
  if (keep && !clearing && done.length) noteMover(parent);
  comp.time = prevTime;

  var out = { parent: parent ? parent.name : "(none)",
    parented: done.join(", ") || "(none)",
    skipped: skipped.join("; "),
    keepPosition: keep,
    note: keep
      ? (clearing
          ? "Unparented with no visual jump: AE rewrote each layer's " +
            "Position/Scale/Rotation back into comp space, so the " +
            "numbers changed and the picture did not."
          : "No visual jump: AE rewrote each layer's Position/Scale/" +
            "Rotation into the parent's space, so those values now read " +
            "differently from before. Read them back rather than " +
            "assuming the old ones.")
      : (clearing
          ? "keepPosition:false -- values were left alone, so each layer " +
            "JUMPED to wherever its raw transform puts it in comp space."
          : "keepPosition:false -- values were left alone, so each layer " +
            "JUMPED by the parent's transform.") };
  if (rekeyed.length) {
    out.keyframesRewritten = rekeyed.join("; ");
    out.keyframesNote = "AE rewrote all " + keysTotal + " transform " +
      "keyframe(s) on these layers, not just the current value; the old " +
      "numbers are gone.";
  }
  if (keep) {
    out.compensatedAt = AELL_r3(usedTime) + "s (frame " +
      Math.round(usedTime * (comp.frameRate || 1)) + ")" +
      (atTime === null ? ", the playhead where it stood" : ", as asked");
  }
  if (movers.length) {
    /* Measured 2026-08-29 (probe D/E/F): a still layer parented to a
     * 2-key parent stayed put at the compensation frame and was 400 px
     * away two seconds later, and a keyframed child came out travelling
     * at twice its old speed. "Nothing moved" is true at ONE frame. */
    out.parentAnimated = movers.join("; ");
    out.parentAnimatedNote = (clearing
      ? "The parent it left MOVES over time. AE compensates once, at " +
        out.compensatedAt.split(",")[0] + ", so the layer keeps the " +
        "position it had THERE and loses the motion the parent was " +
        "giving it at every other frame."
      : "That parent MOVES over time. AE compensates once, at " +
        out.compensatedAt.split(",")[0] + ", so the layer sits exactly " +
        "where it was at that frame and travels with the parent " +
        "everywhere else -- this is NOT a jump-free link across the " +
        "whole timeline.") +
      " Pass atTime/atFrame to choose the frame that must not move" +
      (clearing ? "." : ", or keepPosition:false to leave the numbers " +
        "alone and let the layer ride the parent.");
    if (rekeyed.length) {
      out.parentAnimatedNote += " These layers have keyframes of their " +
        "own, which now play inside that moving space, so their MOTION " +
        "changed, not just their numbers.";
    }
  }
  return AELL_okay(out);
};

/* ---------------------------------------------------- render queue
 *
 * Measured in AE 2026 (26.3x87) before any of this was written, because
 * every line below turns on one of these:
 *
 *  - renderQueue.render() DOES run headless from a `-r` session: a
 *    one-frame Lossless AVI came back in 181 ms with status DONE. So
 *    aerender.exe is not needed and is in fact the WRONG tool here --
 *    it launches a second AE against a SAVED .aep, and this panel drives
 *    the user's live, usually-unsaved project.
 *  - render() renders the WHOLE QUEUE, not the item you just added. Two
 *    fresh items, one call, both DONE. So everything already queued is
 *    quarantined with `render = false` and put back afterwards; a
 *    quarantined item stays QUEUED (3015) and writes nothing.
 *  - An output path that ALREADY EXISTS raises a MODAL. Unattended that
 *    is fatal: it wedged AE for this pass and swallowed every later -r
 *    script while the process still looked healthy.
 *    app.beginSuppressDialogs() suppresses it and genuinely OVERWRITES
 *    (64840 -> 698880 bytes when the second render was 12 frames, so it
 *    is not a silent skip). Suppression is therefore only ever entered
 *    with the overwrite already decided ABOVE it, never as a way to find
 *    out what AE would have asked.
 *  - A missing output DIRECTORY throws instead ("Directory does not
 *    exist: ..."), so it is pre-checked rather than caught.
 *  - The output module ALWAYS forces its own file extension, and it does
 *    it on the `file` SETTER rather than at render time: a path ending
 *    .mp4 set under "Lossless" reads straight back as .avi, an .avi set
 *    under H.264 reads back as .mp4, and a path with no extension is
 *    given one. So the template is applied FIRST, the file set after,
 *    and the path REPORTED is the one AE settled on -- never the one
 *    that was asked for.
 *  - A fresh output module inherits the LAST RENDER'S settings AND
 *    FOLDER. On this machine an untouched item pointed at
 *    Documents\ComfyUI\output\video\... -- nothing to do with the
 *    project. An outputPath-less queue add is therefore not neutral, and
 *    add_to_render_queue now says where AE would put it.
 *  - status is readOnly; a DONE item cannot be re-queued.
 *  - A bogus template name throws a message that does NOT list the valid
 *    ones, hence the grounded errors below.
 */

var AELL_RQ_STATUS = {
  3012: "WILL_CONTINUE", 3013: "NEEDS_OUTPUT", 3014: "UNQUEUED",
  3015: "QUEUED", 3016: "RENDERING", 3017: "USER_STOPPED",
  3018: "ERR_STOPPED", 3019: "DONE"
};

/* The extension of a path, or "" when it has none. A path with no dot at
 * all must not read as "the whole path is the extension", or a perfectly
 * good "render to X" reports that AE changed its mind about it. */
function AELL_extOf(p) {
  var s = String(p);
  var slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  var dot = s.lastIndexOf(".");
  if (dot <= slash + 1) return "";
  return s.slice(dot + 1).toLowerCase();
}

function AELL_rqStatusName(code) {
  var n = AELL_RQ_STATUS[code];
  return n ? n : ("status " + code);
}

/* AE only exposes template lists through a LIVE queue item, so reading
 * them costs an add + remove. Net-zero on the queue, but cached for the
 * session anyway -- the lists cannot change while AE runs. */
var AELL_rqTemplateCache = null;

function AELL_rqTemplates() {
  if (AELL_rqTemplateCache) return AELL_rqTemplateCache;
  var proj = app.project;
  if (!proj) throw new Error("No project open");
  var comp = null, i;
  for (i = 1; i <= proj.numItems; i++) {
    if (proj.item(i) instanceof CompItem) { comp = proj.item(i); break; }
  }
  if (!comp) {
    throw new Error("The project has no comp, and AE only lists render " +
      "templates through a render-queue item. Create a comp first.");
  }
  var item = proj.renderQueue.items.add(comp);
  var out = { renderSettings: [], outputModules: [] };
  try {
    out.renderSettings = item.templates.slice(0);
    out.outputModules = item.outputModule(1).templates.slice(0);
  } finally {
    try { item.remove(); } catch (eR) {}
  }
  AELL_rqTemplateCache = out;
  return out;
}

/* Case-insensitive exact match, so the model's "lossless" finds
 * "Lossless" instead of taking AE's unhelpful throw. */
function AELL_rqPickTemplate(list, want, label) {
  var i, w = String(want);
  for (i = 0; i < list.length; i++) {
    if (list[i] === w) return list[i];
  }
  var lw = w.toLowerCase();
  for (i = 0; i < list.length; i++) {
    if (String(list[i]).toLowerCase() === lw) return list[i];
  }
  throw new Error("No " + label + " template named '" + w +
    "'. Installed: " + list.join(", ") + ".");
}

/* Render Settings "Resolution" -- the one lever that makes AE render
 * FEWER PIXELS rather than the same pixels scaled afterwards.
 *
 * Measured in AE 2026, and every line of this helper is one of those
 * measurements:
 *   - the setting is written by NAME ("Half"), never by number: AE
 *     answers anything else with 'Must have form: "x,y"'.
 *   - getSetting("Resolution") reads back the JSON-ish string
 *     ({"x":2,"y":2}), while getSettings()["Resolution"] reads back the
 *     NAME. The name is what a human asked for, so the name is reported.
 *   - the rendered frame is ceil(dim / factor) on each axis, NOT floor:
 *     a 641x361 comp at Half writes 321x181, and 640x360 at Third writes
 *     214x120.
 *   - applyTemplate RESETS Resolution to Full, so this is applied AFTER
 *     both templates or the argument is silently dropped.
 */
var AELL_RQ_RESOLUTIONS = [
  { name: "Full", factor: 1 },
  { name: "Half", factor: 2 },
  { name: "Third", factor: 3 },
  { name: "Quarter", factor: 4 }
];

function AELL_rqResolution(raw) {
  var want = AELL_trim(String(raw)).toLowerCase(), i, r;
  // "1/2" and a bare 2 both mean Half to a user; AE means Half by "Half"
  // and by nothing else.
  var m = /^1\s*\/\s*([1-4])$/.exec(want);
  if (m) want = m[1];
  for (i = 0; i < AELL_RQ_RESOLUTIONS.length; i++) {
    r = AELL_RQ_RESOLUTIONS[i];
    if (want === r.name.toLowerCase() || want === String(r.factor)) return r;
  }
  var names = [];
  for (i = 0; i < AELL_RQ_RESOLUTIONS.length; i++) {
    names.push(AELL_RQ_RESOLUTIONS[i].name + " (1/" +
               AELL_RQ_RESOLUTIONS[i].factor + ")");
  }
  throw new Error("'resolution' must be one of: " + names.join(", ") +
    " - got \"" + String(raw) + "\". AE's Render Settings only offer " +
    "these four; there is no arbitrary percentage.");
}

/* The name AE reports back after the write, and the factor that goes
 * with it. Read from getSettings() rather than trusted from the
 * argument: a setting that did not take is exactly the failure this
 * reports instead of hiding. */
function AELL_rqResolutionOf(item, fallback) {
  var name = "";
  try { name = String(item.getSettings()["Resolution"]); } catch (e) { name = ""; }
  if (!name) return fallback || { name: "(unread)", factor: 0 };
  for (var i = 0; i < AELL_RQ_RESOLUTIONS.length; i++) {
    if (AELL_RQ_RESOLUTIONS[i].name === name) return AELL_RQ_RESOLUTIONS[i];
  }
  return { name: name, factor: 0 };
}

AELL_TOOLS.list_render_templates = function (args) {
  var t = AELL_rqTemplates();
  // render_comp demands an absolute path in a folder that exists, and
  // "somewhere to put it" is otherwise a thing the model can only guess
  // at -- so hand it one real writable folder rather than let it invent
  // C:\output and take the refusal.
  var temp = "";
  try { temp = Folder.temp.fsName; } catch (eT) {}
  return AELL_okay({
    renderSettings: t.renderSettings,
    outputModules: t.outputModules,
    tempFolder: temp,
    note: "Pass one of outputModules as {template} and one of " +
      "renderSettings as {renderSettings} to render_comp. Names " +
      "starting with '_HIDDEN' are AE internals -- do not offer them. " +
      "render_comp needs an ABSOLUTE output path; ask the user where " +
      "the file should go, and use tempFolder only for throwaways."
  });
};

/* The output path is the one argument a render cannot guess, and every
 * way it can be wrong ends in either a wedged AE or bytes in a folder
 * nobody meant. So it is checked to destruction before anything is
 * queued. */
function AELL_rqCheckOutput(raw, overwrite, argName, existsWhy) {
  var arg = argName || "output";
  if (raw === null || typeof raw === "undefined" || raw === "") {
    throw new Error("'" + arg + "' is required - an ABSOLUTE file path to " +
      "write to, e.g. \"C:/renders/shot.avi\".");
  }
  var path = String(raw);
  if (!/^[a-zA-Z]:[\\\/]/.test(path) && path.indexOf("\\\\") !== 0) {
    throw new Error("'" + arg + "' must be an ABSOLUTE path (got \"" + path +
      "\"). AE resolves a relative path against its own working " +
      "directory, not the project.");
  }
  var file = new File(path);
  var dir = file.parent;
  if (!dir || !dir.exists) {
    // Name the deepest folder that DOES exist: "create the missing one"
    // is only actionable if you know which one is missing.
    var probe = dir, missing = dir ? dir.fsName : "(none)", nearest = "";
    var guard = 0;
    while (probe && guard < 40) {
      if (probe.exists) { nearest = probe.fsName; break; }
      probe = probe.parent;
      guard++;
    }
    throw new Error("Output folder does not exist: " + missing +
      ". Deepest folder that does exist: " +
      (nearest || "(none - check the drive letter)") +
      ". Create the folder, or render somewhere that exists.");
  }
  if (file.exists && !overwrite) {
    throw new Error("Output file already exists: " + file.fsName + " (" +
      file.length + " bytes). Pass {overwrite: true} to replace it, or " +
      "choose another path. " + (existsWhy ||
      "(Rendering onto an existing file without this raises a modal " +
      "dialog that blocks After Effects.)"));
  }
  return file;
}

/* A render is only believable if the bytes are there afterwards, and AE
 * does not make that easy: a file it has just written reports
 * exists === false to a brand-new File object for a moment (measured on
 * saveFrameToPng, ~300 ms). Polling rather than one look is the
 * difference between reporting a good render and calling it a failure. */
function AELL_rqSettle(file, tries) {
  var n = tries > 0 ? tries : 10;
  for (var i = 0; i < n; i++) {
    var f = new File(file.fsName);
    if (f.exists) return f.length;
    $.sleep(100);
  }
  return -1;
}

AELL_TOOLS.render_comp = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var proj = app.project;
  var overwrite = args.overwrite === true || args.overwrite === "true";
  var file = AELL_rqCheckOutput(args.output, overwrite);

  var tmpl = AELL_rqTemplates();
  var wantOM = null, wantRS = null;
  if (args.template) {
    wantOM = AELL_rqPickTemplate(tmpl.outputModules, args.template,
                                 "output-module");
  }
  if (args.renderSettings) {
    wantRS = AELL_rqPickTemplate(tmpl.renderSettings, args.renderSettings,
                                 "render-settings");
  }
  // Parsed BEFORE the queue item exists, so a bad value costs nothing.
  var wantRes = null;
  if (typeof args.resolution !== "undefined" && args.resolution !== null &&
      args.resolution !== "") {
    wantRes = AELL_rqResolution(args.resolution);
  }

  // Hold back everything the USER already queued. render() takes the
  // whole queue, so without this a "render this comp" turns into
  // "render everything in the project".
  var held = [], i, it;
  for (i = 1; i <= proj.renderQueue.numItems; i++) {
    it = proj.renderQueue.item(i);
    if (it.status === RQItemStatus.QUEUED) {
      held.push(it);
      it.render = false;
    }
  }

  var mine = proj.renderQueue.items.add(comp);
  var result = null, thrown = null, started = new Date().getTime();
  try {
    if (wantRS) mine.applyTemplate(wantRS);
    // Template BEFORE file: applyTemplate rewrites the extension.
    if (wantOM) mine.outputModule(1).applyTemplate(wantOM);
    // Resolution AFTER both templates: applyTemplate resets it to Full
    // (measured), so setting it any earlier is setting it to nothing.
    if (wantRes) mine.setSetting("Resolution", wantRes.name);
    mine.outputModule(1).file = file;

    if (typeof args.startTime !== "undefined" && args.startTime !== null &&
        args.startTime !== "") {
      mine.timeSpanStart = Number(args.startTime);
    }
    if (typeof args.durationSeconds !== "undefined" &&
        args.durationSeconds !== null && args.durationSeconds !== "") {
      mine.timeSpanDuration = Number(args.durationSeconds);
    } else if (typeof args.frames !== "undefined" && args.frames !== null &&
               args.frames !== "") {
      mine.timeSpanDuration = Number(args.frames) / comp.frameRate;
    }

    var spanStart = mine.timeSpanStart, spanDur = mine.timeSpanDuration;
    var finalPath = mine.outputModule(1).file.fsName;
    var omName = mine.outputModule(1).name;
    var gotRes = AELL_rqResolutionOf(mine, wantRes);

    // Suppression is entered ONLY here, with overwrite already decided
    // above. Its single job is to stop the overwrite modal from wedging
    // AE -- never to make AE silently answer a question we did not ask.
    app.beginSuppressDialogs();
    try {
      proj.renderQueue.render();
    } finally {
      app.endSuppressDialogs(false);
    }

    var status = mine.status;
    var bytes = (status === RQItemStatus.DONE)
      ? AELL_rqSettle(new File(finalPath), 10) : -1;

    result = {
      comp: comp.name,
      output: finalPath,
      status: AELL_rqStatusName(status),
      bytes: bytes,
      seconds: Math.round((new Date().getTime() - started) / 100) / 10,
      outputModule: omName,
      renderSettings: wantRS || "(AE default)",
      resolution: gotRes.name,
      timeSpan: "start " + spanStart + "s, " +
        Math.round(spanDur * comp.frameRate) + " frame(s) at " +
        comp.frameRate + " fps"
    };
    // The frame AE actually wrote. A reduced render is the one case where
    // the file's size is NOT the comp's size, and a caller that scales
    // afterwards has to be told which number it is scaling from.
    if (gotRes.factor > 0) {
      var rw = Math.ceil(comp.width / gotRes.factor);
      var rh = Math.ceil(comp.height / gotRes.factor);
      result.renderedSize = rw + "x" + rh;
      if (gotRes.factor > 1) {
        result.renderedSize += " (comp is " + comp.width + "x" +
          comp.height + ", rendered at " + gotRes.name + ")";
      }
    }
    if (wantRes && gotRes.name !== wantRes.name) {
      result.resolutionWarning = "Asked AE for " + wantRes.name +
        " resolution; it reports " + gotRes.name + ". The file is what " +
        "AE reports, not what was asked for.";
    }
    if (status !== RQItemStatus.DONE) {
      result.warning = "AE finished with " + AELL_rqStatusName(status) +
        " - nothing was written. Check the output path and the comp.";
    } else if (bytes === 0) {
      result.warning = "The render reported DONE but the file is empty.";
    } else if (bytes < 0) {
      result.warning = "The render reported DONE but no file appeared at " +
        finalPath + ".";
    }
    // An extension AE did not honour is how a "why is my mp4 an avi"
    // support question starts; say it now rather than let the user find
    // a file that will not open.
    var askedExt = AELL_extOf(String(args.output));
    var gotExt = AELL_extOf(finalPath);
    if (askedExt && askedExt !== gotExt) {
      result.note = "The '" + omName + "' output module writes ." + gotExt +
        ", so the file is \"" + finalPath + "\", not ." + askedExt + ".";
    }
    if (held.length) {
      result.heldBack = held.length + " render-queue item(s) the user had " +
        "already queued were held back and left QUEUED.";
    }
  } catch (e) {
    thrown = e;
  }

  // Put the queue back the way it was, whatever happened. Our own item
  // is litter: its status is readOnly, so a DONE one cannot even be
  // re-run from the UI.
  try { mine.remove(); } catch (eM) {}
  for (i = 0; i < held.length; i++) {
    try { held[i].render = true; } catch (eH) {}
  }
  if (thrown) {
    return AELL_err("Render failed: " + (thrown.message || thrown));
  }
  return AELL_okay(result);
};

/*
 * CAPTIONS (WORKPLAN 6.1 Pass C) — the AE half of speech-to-captions.
 *
 * The panel side (extension/js/whisper.js + the transcribe_to_captions
 * panel tool) renders the comp's audio with render_comp_audio below,
 * hands the file to whisper.cpp, and brings the segments back here.
 * Everything AE-shaped lives in these two tools so the self-test can
 * exercise it without a speech model installed.
 *
 * Measured in AE 2026 (probe, 2026-08-29). Five facts, and four of them
 * are silent losses:
 *
 *  - A comp with NO audio layer still renders a full, valid, audio-only
 *    AIFF: status DONE, 772 674 bytes of digital silence, no warning.
 *    Two seconds of silence transcribes as the word "You" (WORKPLAN 6.1
 *    Pass B), so the honest-looking end of that pipeline is a caption
 *    layer reading "You" over a comp nobody spoke in. The refusal has to
 *    happen HERE, before the render, because nothing downstream can tell
 *    that file apart from a real one.
 *  - `layer.inPoint` is a SLIDE, not a trim: it drags outPoint with it
 *    and preserves the duration. A fresh text layer in a 5 s comp reads
 *    in=0 out=5; setting inPoint=2 reads back in=2 **out=7**. So in is
 *    always set BEFORE out — the obvious other order leaves every
 *    caption the wrong length, and AE says nothing.
 *  - An INVERTED span is accepted in silence. in=2 then out=1 reads back
 *    in=2 out=1: a layer of negative duration that never appears on the
 *    timeline. Same for a zero-length span (in=1, out=1).
 *  - inPoint/outPoint QUANTIZE to AE's internal time base, not to the
 *    frame grid: 0.3333 reads back 0.33329264322917, 1.7777 reads back
 *    1.7777099609375. Anything comparing these needs a tolerance.
 *  - addText names the layer after its own text, so a transcript makes
 *    layers called "this is quite a long caption line that goes on".
 *    Captions are named and numbered instead.
 */

/* Which of this machine's output-module templates writes AUDIO ONLY?
 * The names differ per install (this machine ships exactly one, "AIFF
 * 48kHz"), so it is matched by format rather than hard-coded, lossless
 * first. whisper.cpp decodes AIFF as happily as WAV — measured, it goes
 * through miniaudio, so no conversion step is needed. */
function AELL_audioTemplate(list) {
  var wants = [/(^|[^a-z])wav([^a-z]|$)/i, /(^|[^a-z])aiff?([^a-z]|$)/i,
               /(^|[^a-z])mp3([^a-z]|$)/i, /audio[- ]?only/i];
  var i, j;
  for (i = 0; i < wants.length; i++) {
    for (j = 0; j < list.length; j++) {
      if (/^_HIDDEN/.test(list[j])) continue;
      if (wants[i].test(String(list[j]))) return list[j];
    }
  }
  return "";
}

AELL_TOOLS.render_comp_audio = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var i;

  // The comp's STATE is checked before anything is queued, because a
  // silent render succeeds and there is no way to tell it apart later.
  var audio = AELL_a2kAudioLayers(comp);
  if (audio.length === 0) {
    var names = [];
    for (i = 1; i <= comp.numLayers && names.length < 15; i++) {
      names.push(comp.layer(i).name);
    }
    return AELL_err("No layer in '" + comp.name + "' has audio. AE would " +
      "still render a full file of SILENCE and report DONE, and a " +
      "transcriber hears the word \"You\" in silence — so this refuses " +
      "rather than hand back something that looks like a result. Layers " +
      "here: " + (names.join(", ") || "(none)") + ". Import an audio or " +
      "video file with import_file and add it to the comp first.");
  }
  var audible = [], muted = [];
  for (i = 0; i < audio.length; i++) {
    if (AELL_audioOn(audio[i])) audible.push(audio[i]);
    else muted.push(audio[i]);
  }
  if (audible.length === 0) {
    return AELL_err("Every audio layer in '" + comp.name + "' is muted (" +
      AELL_layerNamesOf(muted) + "), so the render would be silence. " +
      "Un-mute one first.");
  }

  var tmpl = AELL_rqTemplates();
  var picked = "";
  if (args.template) {
    picked = AELL_rqPickTemplate(tmpl.outputModules, args.template,
                                 "output-module");
  } else {
    picked = AELL_audioTemplate(tmpl.outputModules);
    if (!picked) {
      var offer = [];
      for (i = 0; i < tmpl.outputModules.length; i++) {
        if (!/^_HIDDEN/.test(tmpl.outputModules[i])) {
          offer.push(tmpl.outputModules[i]);
        }
      }
      return AELL_err("No audio-only output-module template is installed, " +
        "so AE has nothing to render the sound to on its own. Installed: " +
        offer.join(", ") + ". Pass one of those as {template} if you know " +
        "it writes audio, or add an AIFF/WAV output module in AE's " +
        "Output Module Template editor.");
    }
  }

  // render_comp already owns everything else a render needs -- holding
  // back the user's queued items, the overwrite refusal that otherwise
  // wedges AE on a modal, the extension AE forces on the path, and
  // polling for the bytes. Calling it is the point: a second copy of
  // that would be a second thing to get wrong.
  var r = AELL_TOOLS.render_comp({
    comp: args.comp, output: args.output, template: picked,
    overwrite: args.overwrite, startTime: args.startTime,
    durationSeconds: args.durationSeconds, frames: args.frames
  });
  if (!r.ok) return r;
  r.data.audioLayers = AELL_layerNamesOf(audible);
  if (muted.length) {
    r.data.mutedLayers = AELL_layerNamesOf(muted) +
      " (muted, so not in the mix)";
  }
  return r;
};

/* One caption's worth of validated numbers, or a thrown grounded error.
 * Every segment is checked BEFORE any layer is made: half a transcript
 * on the timeline plus an error is worse than an error. */
function AELL_capSegment(raw, n, compDur) {
  var where = "segment " + n;
  if (!raw || typeof raw !== "object") {
    throw new Error(where + " is not an object — each entry of " +
      "'segments' must be {start: seconds, end: seconds, text: \"...\"}. " +
      "Got " + AELL_showValue(raw) + ".");
  }
  var start = AELL_numArg(raw.start);
  var end = AELL_numArg(raw.end);
  if (start === null) {
    throw new Error(where + ": 'start' must be a number of seconds — got " +
      AELL_showValue(raw.start) + ".");
  }
  if (end === null) {
    throw new Error(where + ": 'end' must be a number of seconds — got " +
      AELL_showValue(raw.end) + ".");
  }
  if (start < 0) {
    throw new Error(where + ": 'start' is " + start + "s. A caption before " +
      "the start of the comp is never visible.");
  }
  if (end <= start) {
    throw new Error(where + ": end (" + end + "s) is not after start (" +
      start + "s). AE accepts that silently — the layer exists with zero " +
      "or negative duration and never appears on the timeline — so it is " +
      "refused here instead.");
  }
  var text = raw.text;
  if (typeof text !== "string" || !AELL_trim(text)) {
    throw new Error(where + ": 'text' must be a non-empty string — got " +
      AELL_showValue(raw.text) + ".");
  }
  return { start: start, end: end, text: AELL_trim(text),
           past: end > compDur + 0.0001 };
}

function AELL_trim(s) {
  return String(s).replace(/^\s+/, "").replace(/\s+$/, "");
}

AELL_TOOLS.add_captions = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var i;

  var as = String(args.as || "text").toLowerCase();
  if (as !== "text" && as !== "markers") {
    return AELL_err("'as' must be 'text' (a text layer per caption, the " +
      "default) or 'markers' (one comp/layer marker per caption) — got " +
      AELL_showValue(args.as) + ".");
  }
  // 'layer' names where MARKERS go and means nothing to a text caption.
  // Refusing it is what stops for_each_layer {tool: "add_captions"} from
  // silently building one whole transcript per selected layer.
  if (as === "text" && args.layer !== null &&
      typeof args.layer !== "undefined" && args.layer !== "") {
    return AELL_err("'layer' only applies to {as: 'markers'} — it is the " +
      "layer the markers land on. Text captions are new layers of their " +
      "own, so there is nothing for it to mean here. Drop it, or pass " +
      "{as: 'markers'}.");
  }
  var segsIn = args.segments;
  if (!AELLJSON.isArray(segsIn) || segsIn.length === 0) {
    return AELL_err("'segments' is required: an array of {start, end, " +
      "text} in seconds, e.g. [{\"start\":0,\"end\":1.5,\"text\":\"hello\"}]" +
      ". Got " + AELL_showValue(args.segments) + ".");
  }
  var segs = [];
  try {
    for (i = 0; i < segsIn.length; i++) {
      segs.push(AELL_capSegment(segsIn[i], i + 1, comp.duration));
    }
  } catch (eV) {
    return AELL_err(eV.message || String(eV));
  }

  var pastEnd = 0;
  for (i = 0; i < segs.length; i++) if (segs[i].past) pastEnd++;

  if (as === "markers") {
    var layer = null, target, where;
    if (args.layer !== null && typeof args.layer !== "undefined" &&
        args.layer !== "") {
      layer = AELL_resolveLayer(comp, args.layer);
      target = layer.property("ADBE Marker");
      where = "layer " + layer.name;
    } else {
      target = comp.markerProperty;
      where = "comp " + comp.name;
    }
    // AE keeps ONE marker per exact time, so two segments starting at the
    // same instant silently become one. Counted rather than hidden.
    var before = target.numKeys;
    for (i = 0; i < segs.length; i++) {
      var mv = new MarkerValue(segs[i].text);
      mv.duration = segs[i].end - segs[i].start;
      target.setValueAtTime(segs[i].start, mv);
    }
    var addedM = target.numKeys - before;
    var outM = { comp: comp.name, as: "markers", target: where,
                 captions: segs.length, markersAdded: addedM,
                 markers: target.numKeys };
    if (addedM < segs.length) {
      outM.collapsed = (segs.length - addedM) + " caption(s) landed on a " +
        "time that already had a marker and REPLACED it — AE keeps one " +
        "marker per exact time.";
    }
    if (pastEnd) {
      outM.note = pastEnd + " caption(s) end past '" + comp.name + "' (" +
        comp.duration + "s) — they exist but run off the timeline.";
    }
    return AELL_okay(outM);
  }

  var base = (typeof args.name === "string" && AELL_trim(args.name))
    ? AELL_trim(args.name) : "Caption";
  // Captions want the lower third and a centred anchor. AE's own default
  // is the middle of the comp, left-justified, which is never what a
  // caption wants -- so this is the default and 'position' overrides it.
  var pos = null;
  if (AELLJSON.isArray(args.position) && args.position.length >= 2) {
    pos = [Number(args.position[0]), Number(args.position[1])];
  } else {
    pos = [comp.width / 2, Math.round(comp.height * 0.85)];
  }
  var just = (typeof args.justification === "string" && args.justification)
    ? args.justification : "center";

  var made = [], stuck = null, notReset = null;
  AELL_keepSelection(comp, function () {
    for (var k = 0; k < segs.length; k++) {
      var t = comp.layers.addText(segs[k].text);
      t.name = AELL_uniqueLayerName(comp, base + " " + (k + 1));
      var reset = args.inheritStyle ? null : {};
      var style = AELL_applyTextStyle(t, {
        fontSize: args.fontSize, font: args.font,
        fillColor: args.fillColor, tracking: args.tracking,
        leading: args.leading, justification: just
      }, reset);
      if (reset && reset.stuck && !stuck) stuck = reset.stuck;
      if (reset && reset.skipped && reset.skipped.length && !notReset) {
        notReset = reset.skipped;
      }
      t.property("ADBE Transform Group").property("ADBE Position")
       .setValue(pos);
      // IN BEFORE OUT, always: inPoint drags outPoint with it.
      t.inPoint = segs[k].start;
      t.outPoint = segs[k].end;
      made.push({ name: t.name, index: t.index, start: segs[k].start,
                  end: segs[k].end, style: style });
    }
  });

  var names = [];
  for (i = 0; i < made.length && i < 12; i++) names.push(made[i].name);
  var out = { comp: comp.name, as: "text", captions: made.length,
              layers: names, position: pos, justification: just };
  if (made.length > names.length) {
    out.layers.push("… and " + (made.length - names.length) + " more");
  }
  if (pastEnd) {
    out.note = pastEnd + " caption(s) end past '" + comp.name + "' (" +
      comp.duration + "s) — they exist but run off the timeline. " +
      "set_comp_setting {duration} if the comp should be longer.";
  }
  var stuckWarn = AELL_stuckStyleWarning(stuck);
  if (stuckWarn) out.warning = stuckWarn;
  if (notReset) out.notReset = notReset;
  return AELL_okay(out);
};

AELL_TOOLS.add_to_render_queue = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var proj = app.project;
  // A comp can sit in the queue twice; AE says nothing. Worth a word,
  // because the duplicate renders too.
  var already = 0, i;
  for (i = 1; i <= proj.renderQueue.numItems; i++) {
    if (proj.renderQueue.item(i).comp === comp) already++;
  }
  var wantPath = (typeof args.outputPath === "string" &&
                  args.outputPath !== "") ? String(args.outputPath) : "";
  if (wantPath) {
    // Same pre-check as render_comp, minus the overwrite rule: nothing
    // renders yet, so an existing file is not a modal risk here.
    var f = new File(wantPath);
    var dir = f.parent;
    if (!dir || !dir.exists) {
      return AELL_err("Output folder does not exist: " +
        (dir ? dir.fsName : wantPath) + ". Create it, or queue without " +
        "an outputPath and set the destination in AE.");
    }
  }
  var rqItem = proj.renderQueue.items.add(comp);
  if (wantPath) rqItem.outputModule(1).file = new File(wantPath);

  var out = { comp: comp.name,
              queuePosition: proj.renderQueue.numItems,
              status: AELL_rqStatusName(rqItem.status) };
  var landing = "";
  try { landing = rqItem.outputModule(1).file.fsName; } catch (eF) {}
  out.output = landing;
  if (wantPath) {
    // The output module forces its own extension on the setter, so the
    // path handed in is not necessarily the path AE kept. Saying so here
    // costs a line; not saying it costs the user a hunt for a file that
    // is not where they asked for it.
    var askedExt = AELL_extOf(wantPath);
    var gotExt = AELL_extOf(landing);
    if (askedExt && askedExt !== gotExt) {
      out.note = "The current output module writes ." + gotExt +
        ", so AE changed the destination to \"" + landing + "\". Use " +
        "list_render_templates and render_comp {template} to pick a " +
        "format on purpose.";
    }
  }
  if (!wantPath) {
    // Measured: a fresh output module inherits the LAST RENDER'S folder,
    // which on a real machine is somewhere else entirely. Silence here
    // is how bytes end up in a stranger's folder.
    out.note = "No outputPath given, so AE reused the last render's " +
      "settings and folder - this will write to \"" + landing +
      "\". Pass {outputPath} to choose.";
  }
  if (already) {
    out.warning = comp.name + " was already in the render queue " +
      already + " time(s); this adds another, and both would render.";
  }
  return AELL_okay(out);
};

// ------------------------------------------------ frame round-trip (5.8)
//
// comp -> PNG -> layer. This is the bridge every image/video generator
// stands on: something has to get a frame OUT of a comp and a file back
// IN as a layer, and until now the panel could do neither (import_file
// stops at the project panel). Both halves are built on measurements
// from three probe rounds against real AE 2026 (WORKPLAN-LOG
// 2026-08-28/29), and almost every line below is one of AE's silent
// answers turned into a spoken one.

/* What is ACTUALLY in the file AE just wrote. The dimensions of a
 * snapshot are the one thing the caller cannot infer: a comp sitting at
 * Half resolution writes a half-size frame and AE says nothing at all.
 * PNG carries them in its first 24 bytes (8-byte signature, then the
 * IHDR chunk), so this reads them rather than repeating the arithmetic
 * and hoping. Returns null for anything that is not a PNG. */
function AELL_pngInfo(file) {
  var f = new File(file.fsName), head = null;
  try {
    f.encoding = "BINARY";
    if (!f.open("r")) return null;
    head = f.read(24);
    f.close();
  } catch (e) {
    try { f.close(); } catch (eC) {}
    return null;
  }
  if (!head || head.length < 24) return null;
  if (head.charCodeAt(1) !== 80 || head.charCodeAt(2) !== 78 ||
      head.charCodeAt(3) !== 71) return null;        // not a PNG signature
  // Big-endian, by multiplication: ExtendScript's << is signed 32-bit.
  var w = (head.charCodeAt(16) * 16777216) + (head.charCodeAt(17) * 65536) +
          (head.charCodeAt(18) * 256) + head.charCodeAt(19);
  var h = (head.charCodeAt(20) * 16777216) + (head.charCodeAt(21) * 65536) +
          (head.charCodeAt(22) * 256) + head.charCodeAt(23);
  return { width: w, height: h };
}

AELL_TOOLS.snapshot_frame = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var overwrite = args.overwrite === true || args.overwrite === "true";

  var wanted = (args.path === null || typeof args.path === "undefined" ||
                args.path === "") ? args.output : args.path;
  if (wanted === null || typeof wanted === "undefined" || wanted === "") {
    return AELL_err("'path' is required - an ABSOLUTE .png path to write " +
      "the frame to, e.g. \"C:/frames/shot.png\". list_render_templates " +
      "reports a writable folder if this is a throwaway.");
  }

  // AE writes PNG BYTES into whatever name it is handed and never
  // mentions it - measured: a frame saved as "wrongext.jpg" is a PNG
  // called .jpg, and no .png appears beside it. Correct the extension
  // BEFORE the exists check, so the check is about the file that will
  // really be written.
  var askedExt = AELL_extOf(wanted);
  var pngPath = String(wanted), extNote = "";
  if (askedExt !== "png") {
    pngPath = askedExt
      ? pngPath.slice(0, pngPath.length - askedExt.length - 1) + ".png"
      : pngPath + ".png";
    extNote = "AE writes PNG bytes whatever the file is called, so the " +
      "path was corrected to \"" + pngPath + "\" - a frame saved as ." +
      askedExt + " would be a PNG that no ." + askedExt + " reader opens.";
  }

  // Same absolute-path and missing-folder checks as a render (a missing
  // folder is a SILENT no-op here: saveFrameToPng returns normally and
  // writes nothing). The overwrite rule is the tool's own: unlike a
  // render, saveFrameToPng overwrites without a dialog, so the hazard
  // is a quietly destroyed file rather than a wedged AE.
  var file = AELL_rqCheckOutput(pngPath, overwrite, "path",
    "(saveFrameToPng overwrites silently - no dialog, and no undo.)");

  var t = AELL_numArg(args.time);
  if (t === null && args.time !== null && typeof args.time !== "undefined" &&
      args.time !== "") {
    return AELL_err("'time' must be a number of seconds (got \"" +
      args.time + "\").");
  }
  var atCompTime = false;
  if (t === null) { t = comp.time; atCompTime = true; }
  // AE CLAMPS an out-of-range time and writes a BLANK frame rather than
  // complaining - measured: time 99 and time -5 on the same 4s comp both
  // produced 378-byte frames while the real one was 644. A blank PNG
  // nobody is told about is exactly the silent loss this panel exists
  // to stop.
  if (t < 0 || t > comp.duration) {
    return AELL_err("'time' " + t + "s is outside '" + comp.name +
      "' (0 to " + comp.duration + "s). AE does not refuse this - it " +
      "CLAMPS to the nearest end and writes a BLANK frame, so it is " +
      "refused here instead.");
  }
  var frame = Math.round(t * comp.frameRate);
  var lastFrame = Math.round(comp.duration * comp.frameRate) - 1;
  if (frame > lastFrame) frame = lastFrame;          // duration is exclusive
  if (frame < 0) frame = 0;
  t = frame / comp.frameRate;

  var res = args.resolution ? String(args.resolution).toLowerCase() : "full";
  if (res !== "full" && res !== "comp") {
    return AELL_err("'resolution' must be 'full' (default - the comp's " +
      "real pixel size) or 'comp' (whatever downsample the comp is set " +
      "to). Got: " + args.resolution);
  }
  // A comp left at Half/Third resolution writes a frame that size and
  // says nothing (measured: a 320x240 comp at factor [2,2] wrote a
  // 160x120 PNG). Someone asking for a snapshot means the picture, not
  // the preview quality, so the default overrides the downsample and
  // SAYS it did. The restore runs whatever happens - a throw must not
  // hand the user a comp switched to Full behind their back.
  var priorFactor = null;
  try {
    var rf = comp.resolutionFactor;
    if (res === "full" && rf && (rf[0] !== 1 || rf[1] !== 1)) {
      priorFactor = [rf[0], rf[1]];
      comp.resolutionFactor = [1, 1];
    }
  } catch (eRf) { priorFactor = null; }

  var thrown = null;
  try {
    // A String path THROWS ("is not a File or Folder object"), so this
    // is always a File.
    comp.saveFrameToPng(t, file);
  } catch (eS) {
    thrown = eS;
  }
  if (priorFactor) {
    try { comp.resolutionFactor = priorFactor; } catch (eBack) {}
  }
  if (thrown) {
    return AELL_err("Could not write the frame: " +
      (thrown.message || thrown));
  }

  // AE hides a file it has just written for ~300 ms, so one look would
  // report a good snapshot as a failure (the same fact render_comp
  // polls for).
  var bytes = AELL_rqSettle(file, 10);
  if (bytes < 0) {
    return AELL_err("After Effects reported no error but no file appeared " +
      "at " + file.fsName + ". Check that the folder is writable.");
  }

  var info = AELL_pngInfo(file);
  var out = {
    comp: comp.name,
    path: file.fsName,
    time: t,
    frame: frame,
    bytes: bytes,
    width: info ? info.width : comp.width,
    height: info ? info.height : comp.height,
    compSize: comp.width + "x" + comp.height,
    next: "import_as_layer {path: \"" + file.fsName.replace(/\\/g, "/") +
          "\"} places this PNG back into a comp as a layer."
  };
  if (extNote) out.pathNote = extNote;
  if (atCompTime) {
    out.timeNote = "No 'time' given, so the comp's current time (" + t +
      "s, frame " + frame + ") was used.";
  }
  if (priorFactor) {
    out.resolutionNote = "'" + comp.name + "' was set to resolution 1/" +
      priorFactor[0] + " - it was snapshotted at FULL size and put back " +
      "the way it was. Pass {resolution: \"comp\"} to keep the downsample.";
  }
  if (info && (info.width !== comp.width || info.height !== comp.height)) {
    out.warning = "The PNG is " + info.width + "x" + info.height +
      ", not the comp's " + comp.width + "x" + comp.height +
      " - the comp is downsampled and {resolution: \"comp\"} kept it.";
  }
  // Guide layers are NOT rendered into a snapshot (measured: identical
  // byte counts with and without a full-frame guide layer on top).
  return AELL_okay(out);
};

AELL_TOOLS.import_as_layer = function (args) {
  var raw = (args.path === null || typeof args.path === "undefined" ||
             args.path === "") ? args.file : args.path;
  if (raw === null || typeof raw === "undefined" || raw === "") {
    return AELL_err("'path' is required - the ABSOLUTE path of an image, " +
      "video or audio file to place in a comp.");
  }
  var p = String(raw);
  if (!/^[a-zA-Z]:[\\\/]/.test(p) && p.indexOf("\\\\") !== 0) {
    return AELL_err("'path' must be ABSOLUTE (got \"" + p + "\"). AE " +
      "resolves a relative path against its own working directory, not " +
      "the project folder.");
  }
  var file = new File(p);
  if (!file.exists) {
    return AELL_err("File not found: " + file.fsName +
      ". Check the path - nothing was imported.");
  }
  var comp = AELL_resolveComp(args.comp);
  var fit = args.fit ? String(args.fit).toLowerCase() : "fit";
  if (fit === "center") fit = "none";
  if (fit !== "fit" && fit !== "fill" && fit !== "stretch" &&
      fit !== "width" && fit !== "height" && fit !== "none") {
    return AELL_err("'fit' must be one of: fit (contain, default), fill " +
      "(cover, crops), stretch (fills exactly, distorts - what AE's own " +
      "\"Fit to Comp\" does), width, height, none (100%; 'center' means " +
      "the same). Got: " + args.fit);
  }

  // AE imports the same file again as a SECOND project item and says
  // nothing (measured: one path, two ids), so a loop that regenerates
  // frames fills the project with duplicates and every later name
  // lookup becomes a coin toss. Reuse what is already there.
  var proj = app.project, i, it, src, fsName;
  var existing = null, duplicates = 0;
  for (i = 1; i <= proj.numItems; i++) {
    it = proj.item(i);
    src = null;
    try { src = it.mainSource; } catch (eM) { src = null; }
    // Comps answer `undefined` and solids hold a SolidSource: neither
    // has a file, and asking one for a file throws.
    if (!src || !(src instanceof FileSource)) continue;
    fsName = null;
    try { fsName = src.file.fsName; } catch (eF) { fsName = null; }
    if (fsName && fsName.toLowerCase() === file.fsName.toLowerCase()) {
      if (existing) duplicates++; else existing = it;
    }
  }

  var item = existing, reused = false, reloaded = false;
  if (item) {
    reused = true;
    // The bytes on disk can be NEWER than the frames AE cached - a
    // generator writing the same path over and over is the whole point
    // of this tool. reload() re-reads the file and keeps the item id
    // (measured), so every layer already using it picks the new picture
    // up.
    try { item.mainSource.reload(); reloaded = true; } catch (eRl) {}
  } else {
    try {
      item = proj.importFile(new ImportOptions(file));
    } catch (eI) {
      // canImportAs() is no help here: it answered TRUE for a .txt file
      // that importFile then refused outright (measured), so the throw
      // is the only honest signal.
      return AELL_err("After Effects could not import " + file.fsName +
        ": " + (eI.message || eI) + ". It reads images (png, jpg, tif, " +
        "exr, psd), video (mov, mp4, avi) and audio (wav, mp3, aif); a " +
        "file with the right extension can still be refused if its " +
        "contents are something else.");
    }
  }

  var layer = AELL_keepSelection(comp, function () {
    return comp.layers.add(item);
  });
  if (args.name) layer.name = String(args.name);

  var srcW = item.width, srcH = item.height;
  var hasPixels = srcW > 0 && srcH > 0;
  var transform = layer.property("ADBE Transform Group");
  var out = {
    comp: comp.name,
    layer: layer.name,
    index: layer.index,
    source: item.name,
    sourceSize: hasPixels ? (srcW + "x" + srcH) : "(no picture)",
    compSize: comp.width + "x" + comp.height,
    fit: fit,
    inPoint: layer.inPoint,
    outPoint: layer.outPoint
  };

  if (hasPixels && fit !== "none") {
    var srcPar = item.pixelAspect > 0 ? item.pixelAspect : 1;
    var compPar = comp.pixelAspect > 0 ? comp.pixelAspect : 1;
    // This arithmetic is AE's, not ours: it reproduces every value the
    // "Fit to Comp" family of menu commands produced in the probe,
    // INCLUDING the pixel-aspect correction on X (a 320x240 par-1
    // source in a 720x480 par-1.2121 comp fits at 272.727 x 200, not
    // 225 x 200). The menu commands themselves are unusable here: with
    // no comp viewer open they silently do NOTHING - scale stayed
    // 100,100 - so an unattended panel must do the maths itself.
    var rx = 100 * (comp.width * compPar) / (srcW * srcPar);
    var ry = 100 * comp.height / srcH;
    var sx, sy;
    if (fit === "stretch") { sx = rx; sy = ry; }
    else if (fit === "width") { sx = rx; sy = rx; }
    else if (fit === "height") { sx = ry; sy = ry; }
    else if (fit === "fill") { sx = Math.max(rx, ry); sy = sx; }
    else { sx = Math.min(rx, ry); sy = sx; }        // "fit": contain
    var scaleProp = transform.property("ADBE Scale");
    var cur = scaleProp.value;
    // The scripting API pads a 2D layer's Scale to three components;
    // hand back whatever shape it gave us.
    scaleProp.setValue((AELLJSON.isArray(cur) && cur.length > 2)
      ? [sx, sy, cur[2]] : [sx, sy]);
    out.scale = [Math.round(sx * 1000) / 1000, Math.round(sy * 1000) / 1000];
    if (srcPar !== compPar) {
      out.pixelAspectNote = "The comp's pixel aspect (" + compPar +
        ") differs from the footage's (" + srcPar + "), so the X scale " +
        "is corrected for it - the same as AE's own Fit to Comp.";
    }
  } else if (!hasPixels) {
    out.note = "'" + item.name + "' has no picture (audio only), so there " +
      "was nothing to fit; it was placed as-is.";
  }

  if (AELLJSON.isArray(args.position) && args.position.length >= 2) {
    var posProp = transform.property("ADBE Position");
    var curPos = posProp.value;
    posProp.setValue((AELLJSON.isArray(curPos) && curPos.length > 2)
      ? [args.position[0], args.position[1], curPos[2]]
      : [args.position[0], args.position[1]]);
  }

  if (reused) {
    out.reusedExisting = true;
    out.reuseNote = "'" + item.name + "' was already in the project for " +
      "that file, so it was reused" +
      (reloaded ? " and RELOADED from disk (any layer already using it " +
                  "now shows the current file)" : "") +
      " instead of imported a second time.";
  }
  if (duplicates) {
    out.warning = "The project already holds " + (duplicates + 1) +
      " items for this file; the first was used. clean_project or " +
      "delete_item can clear the rest.";
  }
  if (item.duration === 0) {
    out.stillNote = "A still spans the whole comp (" + layer.inPoint +
      "s to " + layer.outPoint + "s). set_layer_timing changes that.";
  }
  return AELL_okay(out);
};

// ------------------------------------------- universal property access
// The introspection backbone (docs/NATIVE_COVERAGE_PLAN.md): the model
// DISCOVERS real property paths instead of guessing names, then reads and
// writes them generically. Convenience tools stay; these reach everything.

var AELL_ROOT_ALIASES = {
  transform: "ADBE Transform Group",
  effects:   "ADBE Effect Parade",
  masks:     "ADBE Mask Parade",
  text:      "ADBE Text Properties",
  contents:  "ADBE Root Vectors Group",
  styles:    "ADBE Layer Styles",
  camera:    "ADBE Camera Options Group",
  light:     "ADBE Light Options Group",
  material:  "ADBE Material Options Group",
  audio:     "ADBE Audio Group",
  timeRemap: "ADBE Time Remapping"
};

/* Leaf properties can setValue; groups cannot. */
function AELL_isLeafProp(node) {
  return !!node && typeof node.setValue === "function";
}

function AELL_childNames(node, cap) {
  var names = [];
  var n = 0;
  try { n = node.numProperties || 0; } catch (e) { n = 0; }
  for (var i = 1; i <= n && names.length < cap; i++) {
    try { names.push(node.property(i).name); } catch (e2) {}
  }
  return names;
}

/*
 * The hop AE's timeline does not draw.
 *
 * A shape GROUP ("ADBE Vector Group") does not hold its rectangle, fill
 * and repeater directly: they live in a nested group AE calls "Contents"
 * (matchName "ADBE Vectors Group"). The timeline never shows that row —
 * expanding "G1" lists the items themselves — so the path anybody writes
 * from what they SEE, contents/G1/Repeater 1/Copies, resolved to nothing.
 * Measured in AE 2026: layer.property("Contents").property("G1")
 * .property("Repeater 1") is null, and the real path carries a SECOND
 * "Contents" segment. This project's own docs, its system prompt's
 * trim-paths recipe and add_shape_content's returned note all told the
 * model the short form, so every "animate the repeater / wipe the stroke
 * on" request failed on a path the panel itself had handed over.
 *
 * The hop only fires after a direct lookup misses, and only on a shape
 * group, so a real child named "Transform" still wins over the one inside.
 */
function AELL_shapeInner(node) {
  var mn = "";
  try { mn = String(node.matchName || ""); } catch (e) { return null; }
  if (mn !== "ADBE Vector Group") return null;
  var inner = null;
  try { inner = node.property("ADBE Vectors Group"); } catch (e2) { return null; }
  return (inner && inner !== node) ? inner : null;
}

/* One child lookup by display name or matchName, hop included. Returns
   null when there is no such child; `hopped` says the Contents step was
   taken, so error paths and reported paths stay literally true. */
var AELL_childHopped = false;
function AELL_childProp(node, lookup, seg) {
  AELL_childHopped = false;
  var child = null;
  try { child = node.property(lookup); } catch (e) { child = null; }
  if (!child && seg && seg !== lookup) {
    try { child = node.property(seg); } catch (e2) { child = null; }
  }
  if (child) return child;
  var inner = AELL_shapeInner(node);
  if (!inner) return null;
  try { child = inner.property(lookup); } catch (e3) { child = null; }
  if (!child && seg && seg !== lookup) {
    try { child = inner.property(seg); } catch (e4) { child = null; }
  }
  if (child) AELL_childHopped = true;
  return child || null;
}

/*
 * Walk a '/'-separated path of display or match names from a layer down
 * to any property or group. A failed segment throws a grounded error
 * listing the real children at that level.
 */
function AELL_resolvePropPath(layer, pathStr) {
  var segs = String(pathStr).split("/");
  var node = layer;
  var walked = [];
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i].replace(/^\s+|\s+$/g, "");
    if (seg === "") continue;
    var lookup = (walked.length === 0 && AELL_ROOT_ALIASES[seg])
      ? AELL_ROOT_ALIASES[seg] : seg;
    var child = AELL_childProp(node, lookup, seg);
    if (!child) {
      var at = walked.length ? "'" + walked.join("/") + "'"
                             : "layer '" + layer.name + "'";
      throw new Error("Path segment '" + seg + "' not found under " + at +
        ". Children here: " + AELL_childList(node) +
        ". Use list_properties to inspect the real tree.");
    }
    if (AELL_childHopped) walked.push("Contents");
    node = child;
    walked.push(seg);
  }
  return node;
}

/* Children for a grounded error. A shape group's own four rows are not
   what the user is looking at, so the items inside Contents are listed
   too — those are the names the timeline shows. */
function AELL_childList(node) {
  var names = AELL_childNames(node, 30);
  var inner = AELL_shapeInner(node);
  if (inner) {
    var kids = AELL_childNames(inner, 20);
    if (kids.length) {
      return (names.join(", ") || "(none)") + " — and inside Contents: " +
             kids.join(", ");
    }
  }
  return names.join(", ") || "(none)";
}

/*
 * When a path lands on a GROUP holding exactly one value property — a
 * Slider/Point/Checkbox/Color control effect referenced by its display
 * name ("Effects/Grid X Spacing") — descend to that value. Multi-param
 * groups stay groups.
 */
function AELL_descendToLeaf(prop) {
  if (AELL_isLeafProp(prop)) return prop;
  var n = 0;
  try { n = prop.numProperties || 0; } catch (e) { return prop; }
  var leaf = null;
  var leaves = 0;
  for (var i = 1; i <= n; i++) {
    var c = null;
    try { c = prop.property(i); } catch (e2) { continue; }
    if (c && AELL_isLeafProp(c)) {
      leaves++;
      leaf = c;
    }
  }
  return leaves === 1 ? leaf : prop;
}

/*
 * Bare-name deep search - the last resort before "not found".
 *
 * AE's layer-level name shortcut reaches SOME nested streams and not
 * others, and nothing in the API says which. Measured in AE 2026: a light
 * answers layer.property("Intensity") and returns NULL for "Radius" and
 * "Falloff Distance"; a camera answers "Zoom" and "Focus Distance"; a
 * solid returns NULL for its own effect's "Blurriness"; a shape layer
 * returns NULL for "Size". The model cannot know which side of that line
 * a name falls on, so a bare name AE refuses is searched down the real
 * tree here instead of coming back as an error.
 *
 * Two measured facts shape the search:
 *
 *  - EVERY layer carries all eleven Layer Styles whether or not one has
 *    been applied, and every style reports enabled=false, active=false,
 *    elided=false either way - there is no flag separating a style the
 *    user added from one they did not. A shallowest-wins search for
 *    "Size" or "Color" therefore lands in a style nobody asked for (ten
 *    "Opacity" matches live under Layer Styles on a plain solid). So the
 *    roots are RANKED, and Layer Styles is searched LAST.
 *  - A depth-5 walk of the heaviest layer measured 219 nodes in 6-11 ms,
 *    so running the search on every miss costs nothing worth guarding.
 */
var AELL_SEARCH_ROOT_RANK = {
  "ADBE Transform Group":        1,
  "ADBE Light Options Group":    2,
  "ADBE Camera Options Group":   2,
  "ADBE Material Options Group": 3,
  "ADBE Extrsn Options Group":   3,
  "ADBE Text Properties":        4,
  "ADBE Effect Parade":          5,
  "ADBE Root Vectors Group":     6,
  "ADBE Mask Parade":            7,
  "ADBE Audio Group":            8,
  "ADBE Time Remapping":         8,
  "ADBE Layer Styles":          99
};
var AELL_SEARCH_OTHER_RANK = 50;
var AELL_SEARCH_MAX_DEPTH = 5;
var AELL_SEARCH_MAX_NODES = 1500;

/* Where the last AELL_anyProperty call actually landed, when it took the
   deep search to get there: {path, alsoAt}. Null when the spec resolved
   the ordinary way, so a tool only ever reports a path it had to hunt. */
var AELL_lastResolve = null;

function AELL_propName(node) {
  var nm = "";
  try { nm = String(node.name || ""); } catch (e) {}
  return nm;
}

function AELL_nearList(list) {
  var out = [];
  for (var i = 0; i < list.length && i < 5; i++) out.push(list[i]);
  return out.join(", ");
}

function AELL_deepFindProp(layer, target) {
  var lc = String(target).toLowerCase();
  var matches = [];
  var near = [];
  var visited = 0;

  function scan(node, path, depth, rank, inAnim) {
    var nm = AELL_propName(node);
    var mn = "";
    try { mn = String(node.matchName || ""); } catch (e) {}
    if (nm.toLowerCase() === lc || mn.toLowerCase() === lc) {
      matches.push({ prop: node, path: path, rank: rank, depth: depth,
                     dormant: inAnim && AELL_animDormant(node) });
    } else if (near.length < 8 && nm !== "" &&
               nm.toLowerCase().indexOf(lc) !== -1) {
      near.push(path);
    }
    if (depth >= AELL_SEARCH_MAX_DEPTH) return;
    var n = 0;
    try { n = node.numProperties || 0; } catch (e2) { return; }
    // Every text animator carries all 103 possible animator properties,
    // dormant until added, so a name found in here may be one nobody
    // asked for (see AELL_TOOLS.add_text_animator).
    var deeper = inAnim || mn === "ADBE Text Animator Properties";
    for (var i = 1; i <= n; i++) {
      if (visited >= AELL_SEARCH_MAX_NODES) return;
      visited++;
      var c = null;
      try { c = node.property(i); } catch (e3) { continue; }
      if (!c) continue;
      scan(c, path + "/" + AELL_propName(c), depth + 1, rank, deeper);
    }
  }

  var nRoots = 0;
  try { nRoots = layer.numProperties || 0; } catch (e) { nRoots = 0; }
  for (var r = 1; r <= nRoots; r++) {
    var root = null;
    try { root = layer.property(r); } catch (e4) { continue; }
    if (!root) continue;
    var rank = AELL_SEARCH_OTHER_RANK;
    try {
      var known = AELL_SEARCH_ROOT_RANK[String(root.matchName)];
      if (typeof known === "number") rank = known;
    } catch (e5) {}
    visited++;
    scan(root, AELL_propName(root), 1, rank, false);
  }
  matches.sort(function (a, b) {
    if (!a.dormant !== !b.dormant) return a.dormant ? 1 : -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.depth - b.depth;
  });
  return { matches: matches, near: near };
}

/*
 * Resolve a bare name by deep search. Returns null when nothing matched
 * and no original error was supplied; with one, that grounded error grows
 * a line saying the whole tree was searched too. Two matches of EQUAL
 * standing are never guessed between - that is a refusal with both real
 * paths in it.
 */
function AELL_deepResolve(layer, spec, orig) {
  var found = AELL_deepFindProp(layer, spec);
  var m = found.matches;
  var i;
  if (m.length === 0) {
    if (!orig) return null;
    var tail = " No property named '" + spec + "' exists anywhere on '" +
      layer.name + "' either (searched the whole tree to depth " +
      AELL_SEARCH_MAX_DEPTH + ").";
    var nearTxt = AELL_nearList(found.near);
    if (nearTxt !== "") tail += " Names containing it: " + nearTxt + ".";
    throw new Error(orig.message + tail);
  }
  /* Only dormant animator slots answered to the name. Writing to one
     throws AE's raw "the property or a parent property is hidden" and
     READING one hands back a value the render never uses, so neither is
     a real answer — say which tool makes it real instead. */
  if (m[0].dormant) {
    var slots = [];
    for (i = 0; i < m.length && slots.length < 3; i++) slots.push(m[i].path);
    throw new Error("'" + spec + "' on '" + layer.name + "' exists only as " +
      "an INACTIVE text-animator property (" + slots.join(", ") +
      "). AE hides those until an animator is asked for them, and a value " +
      "written there is ignored. add_text_animator {layer: \"" + layer.name +
      "\", properties: {" + spec.toLowerCase() + ": …}} activates it; " +
      "set_property then reaches it by its full path.");
  }
  if (m.length > 1 && m[1].rank === m[0].rank && m[1].depth === m[0].depth &&
      !m[1].dormant) {
    var paths = [];
    for (i = 0; i < m.length && i < 6; i++) paths.push(m[i].path);
    throw new Error("'" + spec + "' is ambiguous on '" + layer.name +
      "': " + m.length + " properties share that name - " +
      paths.join(", ") + (m.length > 6 ? ", ..." : "") +
      ". Pass the full path (list_properties shows the tree).");
  }
  var also = [];
  for (i = 1; i < m.length && also.length < 3; i++) also.push(m[i].path);
  AELL_lastResolve = { path: m[0].path, alsoAt: also };
  return m[0].prop;
}

/*
 * A '/'-path whose FIRST segment AE cannot see from the layer - the same
 * blind spot one level up: "Gaussian Blur/Blurriness" or
 * "Rectangle Path 1/Size". Deep-find the head, then walk the rest from
 * each candidate and take the first that completes.
 */
function AELL_deepPath(layer, spec) {
  var raw = String(spec).split("/");
  var segs = [];
  var i;
  for (i = 0; i < raw.length; i++) {
    var t = raw[i].replace(/^\s+|\s+$/g, "");
    if (t !== "") segs.push(t);
  }
  if (segs.length < 2) return null;
  var head = AELL_deepFindProp(layer, segs[0]).matches;
  for (var h = 0; h < head.length && h < 8; h++) {
    var node = head[h].prop;
    var path = head[h].path;
    var ok = true;
    for (var k = 1; k < segs.length; k++) {
      var c = AELL_childProp(node, segs[k], segs[k]);
      if (!c) { ok = false; break; }
      if (AELL_childHopped) path = path + "/Contents";
      node = c;
      path = path + "/" + AELL_propName(c);
    }
    if (ok) {
      AELL_lastResolve = { path: path, alsoAt: [] };
      return node;
    }
  }
  return null;
}

/* descendToLeaf, but the hunted path grows the leaf it descended to: a
   bare "My Slider" names the control GROUP, and the value the caller gets
   back lives one step below it. Reporting the group would hand the model
   a path that reads back as a GROUP refusal. */
function AELL_descendReported(prop) {
  var leaf = AELL_descendToLeaf(prop);
  if (AELL_lastResolve && leaf !== prop) {
    AELL_lastResolve.path = AELL_lastResolve.path + "/" + AELL_propName(leaf);
  }
  return leaf;
}

/* Accept friendly specs (position, effect.X.Y) AND '/'-joined paths. */
function AELL_anyProperty(layer, spec) {
  AELL_lastResolve = null;
  var s = String(spec || "");
  if (s === "") throw new Error("Missing 'property'");
  if (s.indexOf("/") !== -1) {
    try {
      return AELL_descendToLeaf(AELL_resolvePropPath(layer, s));
    } catch (slashErr) {
      var deep = AELL_deepPath(layer, s);
      if (deep) return AELL_descendReported(deep);
      throw slashErr;
    }
  }
  try {
    return AELL_resolveProperty(layer, s);
  } catch (friendlyErr) {
    try {
      return AELL_descendToLeaf(AELL_resolvePropPath(layer, s));
    } catch (pathErr) {
      var orig = (s.indexOf(".") !== -1) ? friendlyErr : pathErr;
      return AELL_descendReported(AELL_deepResolve(layer, s, orig));
    }
  }
}

/* Compact, context-safe rendering of any property value. */
function AELL_sampleRaw(v) {
  if (v === null || typeof v === "undefined") return null;
  if (typeof v === "number") return Math.round(v * 1000) / 1000;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    return v.length > 60 ? v.slice(0, 60) + "…" : v;
  }
  if (AELLJSON.isArray(v)) {
    if (v.length > 4) return "[array of " + v.length + "]";
    var out = [];
    for (var i = 0; i < v.length; i++) {
      out.push(typeof v[i] === "number"
        ? Math.round(v[i] * 1000) / 1000 : v[i]);
    }
    return out;
  }
  return "[" + (typeof v) + "]";   // Shape, TextDocument, marker, …
}

function AELL_sampleValue(prop) {
  var v;
  try { v = prop.value; } catch (e) { return null; }
  return AELL_sampleRaw(v);
}

AELL_TOOLS.list_properties = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var root = args.path ? AELL_resolvePropPath(layer, String(args.path))
                       : layer;
  if (args.path && AELL_isLeafProp(root)) {
    return AELL_err("'" + args.path + "' is a PROPERTY, not a group — " +
                    "use get_property for its value");
  }
  var depth = args.depth > 0 ? Math.min(Math.round(args.depth), 3) : 2;
  var CAP = 60;
  var entries = [];
  var truncated = false;
  function walk(node, prefix, d) {
    var n = 0;
    try { n = node.numProperties || 0; } catch (e) { n = 0; }
    for (var i = 1; i <= n; i++) {
      if (entries.length >= CAP) { truncated = true; return; }
      var child = null;
      try { child = node.property(i); } catch (e2) { continue; }
      if (!child) continue;
      var p = prefix ? prefix + "/" + child.name : child.name;
      var leaf = AELL_isLeafProp(child);
      var entry = { path: p, matchName: child.matchName,
                    kind: leaf ? "prop" : "group" };
      if (leaf) {
        var sv = AELL_sampleValue(child);
        if (sv !== null) entry.value = sv;
        try {
          if (child.numKeys > 0) entry.numKeys = child.numKeys;
        } catch (e3) {}
        try { if (child.expression) entry.hasExpression = true; } catch (e4) {}
        // A text animator ships with all 103 possible properties present
        // but hidden. Their values read back fine and are never applied,
        // so an unmarked row here would be a lie.
        if (AELL_animPropDormant(child)) entry.inactive = true;
      }
      entries.push(entry);
      if (!leaf && d > 1) walk(child, p, d - 1);
    }
  }
  walk(root, args.path ? String(args.path) : "", depth);
  return AELL_okay({ layer: layer.name, root: args.path || "(layer)",
    count: entries.length, properties: entries,
    note: truncated
      ? "Capped at " + CAP + " entries — narrow with {path: \"…\"}"
      : "" });
};

/* Name the path a deep search had to hunt for, plus anything else that
   answered to the same name, so the model can address it directly next
   time instead of relying on the search again. */
function AELL_noteResolved(out) {
  if (!AELL_lastResolve) return out;
  out.resolvedPath = AELL_lastResolve.path;
  if (AELL_lastResolve.alsoAt.length > 0) {
    out.alsoMatched = AELL_lastResolve.alsoAt;
  }
  return out;
}

AELL_TOOLS.get_property = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var prop = AELL_anyProperty(layer, args.property);
  var resolved = AELL_lastResolve;
  if (!AELL_isLeafProp(prop)) {
    return AELL_err("'" + args.property + "' is a GROUP — use " +
      "list_properties {path: \"" + args.property + "\"} to see inside");
  }
  var data = { layer: layer.name, property: String(args.property),
               matchName: prop.matchName, value: AELL_sampleValue(prop) };
  if (AELL_animPropDormant(prop)) {
    data.inactive = "this animator property has not been added, so AE " +
      "keeps it hidden and the value below is never applied — " +
      "add_text_animator {layer: \"" + layer.name + "\", properties: {…}} " +
      "activates it";
  }
  var nk = 0;
  try { nk = prop.numKeys || 0; } catch (e) {}
  data.numKeys = nk;
  if (nk > 0) {
    var keys = [];
    for (var k = 1; k <= nk && k <= 10; k++) {
      keys.push({ time: Math.round(prop.keyTime(k) * 1000) / 1000,
                  value: AELL_sampleRaw(prop.keyValue(k)) });
    }
    data.keys = keys;
    if (nk > 10) data.moreKeys = nk - 10;
  }
  try {
    if (prop.expression) {
      data.expression = String(prop.expression).slice(0, 200);
    }
  } catch (e2) {}
  AELL_lastResolve = resolved;
  return AELL_okay(AELL_noteResolved(data));
};

AELL_TOOLS.set_property = function (args) {
  // The model reaches for {layers: [...]} here when it wants a batch —
  // observed twice in one probe run. Redirect it to the tool that does
  // that, instead of silently setting ONE layer and reporting success.
  if (AELLJSON.isArray(args.layers)) {
    return AELL_err("set_property works on ONE layer. For many, wrap it: " +
      "for_each_layer {layers: [...], tool: 'set_property', args: " +
      "{property: '" + String(args.property || "...") + "', value: ...}}");
  }
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var prop = AELL_anyProperty(layer, args.property);
  var resolved = AELL_lastResolve;
  if (!AELL_isLeafProp(prop)) {
    return AELL_err("'" + args.property + "' is a GROUP — set one of its " +
      "properties instead (list_properties {path: \"" + args.property +
      "\"} shows them)");
  }
  if (typeof args.value === "undefined") {
    return AELL_err("'value' is required");
  }
  if (AELL_animPropDormant(prop)) {
    return AELL_err(AELL_animDormantMsg(layer, String(args.property), "writing to"));
  }
  try {
    if (typeof args.atTime === "number") {
      prop.setValueAtTime(args.atTime, args.value);
    } else {
      prop.setValue(args.value);
    }
  } catch (e) {
    var nkey = 0;
    try { nkey = prop.numKeys || 0; } catch (eN) {}
    if (nkey > 0 && typeof args.atTime !== "number") {
      return AELL_err("'" + args.property + "' is animated (" + nkey +
        " keyframes), so a single value cannot be written to it. Pass " +
        "{atTime: <seconds>} to set a keyframe instead, or delete the " +
        "keyframes first.");
    }
    return AELL_err("AE rejected the value for '" + args.property + "': " +
      (e.message || e) + ". Current value: " +
      AELLJSON.stringify(AELL_sampleValue(prop)));
  }
  var nk = 0;
  try { nk = prop.numKeys || 0; } catch (e2) {}
  var out = { layer: layer.name, property: String(args.property),
    value: AELL_sampleRaw(args.value),
    keyframed: typeof args.atTime === "number", numKeys: nk };
  // AE accepts a write to an expression-driven property and then shows
  // the expression's answer instead. Reporting that as a plain success is
  // the same lie the other setters used to tell.
  if (typeof args.atTime !== "number") {
    var warn = AELL_overrideWarning(prop, args.value, String(args.property));
    if (warn) { out.applied = false; out.warning = warn; }
  }
  AELL_lastResolve = resolved;
  return AELL_okay(AELL_noteResolved(out));
};

AELL_TOOLS.set_keyframes = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layers;
  try { layers = AELL_layersOrSelection(comp, args); }
  catch (eL) { return AELL_err(eL.message); }
  if (!AELLJSON.isArray(args.keys) || args.keys.length === 0) {
    return AELL_err("'keys' must be [{time: s, value: …}, …]");
  }
  if (args.keys.length > 100) {
    return AELL_err("'keys' is capped at 100 per call");
  }
  for (var v = 0; v < args.keys.length; v++) {
    var kv = args.keys[v] || {};
    if (typeof kv.time !== "number" || typeof kv.value === "undefined") {
      return AELL_err("keys[" + v + "] needs {time (seconds), value}");
    }
  }
  // relativeTo 'inPoint' shifts every key by each layer's own start, so
  // one call animates a STAGGERED batch and the offsets ride along.
  var rel = String(args.relativeTo || "");
  var relative = rel === "inPoint" || rel === "layerStart";
  var total = 0;
  for (var L = 0; L < layers.length; L++) {
    var layer = layers[L];
    var prop;
    try { prop = AELL_anyProperty(layer, args.property); }
    catch (eP) { return AELL_err("On '" + layer.name + "': " + eP.message); }
    if (!AELL_isLeafProp(prop)) {
      return AELL_err("'" + args.property + "' is a GROUP — keyframes go " +
                      "on a property inside it");
    }
    if (AELL_animPropDormant(prop)) {
      return AELL_err(AELL_animDormantMsg(layer, String(args.property),
                                          "keyframing"));
    }
    var base = relative ? layer.inPoint : 0;
    for (var i = 0; i < args.keys.length; i++) {
      var k = args.keys[i];
      try {
        prop.setValueAtTime(base + k.time, k.value);
        total++;
      } catch (e) {
        return AELL_err("AE rejected keys[" + i + "] on '" + layer.name +
          "' (" + (e.message || e) + ") — " + total +
          " key(s) were applied before this");
      }
    }
  }
  var res = { layers: layers.length,
    property: String(args.property), keysSet: total,
    note: relative
      ? "Key times offset by each layer's inPoint — staggered starts kept"
      : "",
    hint: "apply_keyframe_ease (same layers arg) adds easing" };
  if (layers.length === 1) {
    try { res.numKeys = prop.numKeys; } catch (eN) {}
  }
  return AELL_okay(res);
};

AELL_TOOLS.remove_keyframes = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layers;
  try { layers = AELL_layersOrSelection(comp, args); }
  catch (eL) { return AELL_err(eL.message); }
  var removed = 0;
  for (var L = 0; L < layers.length; L++) {
    var prop;
    try { prop = AELL_anyProperty(layers[L], args.property); }
    catch (eP) { return AELL_err("On '" + layers[L].name + "': " + eP.message); }
    if (!AELL_isLeafProp(prop)) {
      return AELL_err("'" + args.property + "' is a GROUP");
    }
    var nk = 0;
    try { nk = prop.numKeys || 0; } catch (e) {}
    if (nk === 0) continue;
    if (AELLJSON.isArray(args.times) && args.times.length > 0) {
      for (var i = 0; i < args.times.length; i++) {
        var t = Number(args.times[i]);
        var best = 0, bestD = 1e9;
        for (var k = prop.numKeys; k >= 1; k--) {
          var d = Math.abs(prop.keyTime(k) - t);
          if (d < bestD) { bestD = d; best = k; }
        }
        if (best > 0 && bestD < 0.05) { prop.removeKey(best); removed++; }
      }
    } else {
      while (prop.numKeys > 0) { prop.removeKey(1); removed++; }
    }
  }
  var res = { layers: layers.length,
              property: String(args.property), removed: removed };
  if (layers.length === 1) {
    try { res.remaining = prop.numKeys; } catch (eR) {}
  }
  return AELL_okay(res);
};

/*
 * Which tools for_each_layer is allowed to drive, and why the list is
 * explicit rather than "anything in AELL_TOOLS".
 *
 * A tool qualifies only if it takes a SINGULAR {layer} target. Measured in
 * AE 2026: for_each_layer {tool: "add_solid"} over two layers reported
 * {ok: true, succeeded: 2} and made two identically named solids, and
 * {tool: "create_comp"} over two layers reported success and left two junk
 * comps in the project — the injected {layer} was simply ignored, so the
 * call became "run this comp-level tool N times" while claiming to have
 * done per-layer work. A small model that reads "run ANY layer tool" WILL
 * pick one of these.
 *
 * The already-batched list is the mirror image: those tools take their own
 * {layers} array, so driving them one layer at a time both discards the
 * batch (grid_layout of a single layer, N times) and hides the real call.
 *
 * READ tools are refused for a different reason: for_each_layer reports
 * counts, never per-layer values, so get_property over 60 layers would
 * answer "succeeded: 60" and throw every value away.
 *
 * tests/test-for-each-layer.js re-derives all three lists from this file's
 * source and fails if a tool is added without being classified here.
 */
var AELL_PER_LAYER_LIST = [
  "add_captions", "add_control", "add_keyframe", "add_marker", "add_mask",
  "add_shape_content", "add_text_animator", "apply_effect",
  "apply_expression_preset", "audio_to_keyframes",
  "center_anchor_point", "delete_layer", "duplicate_layer", "link_property",
  "set_effect_param", "set_expression", "set_layer_3d", "set_layer_parent",
  "set_layer_timing", "set_mask", "set_mask_path", "set_property",
  "set_text_style", "set_track_matte", "set_transform",
  "split_layer_into_chunks"
];
var AELL_PER_LAYER_READ_LIST = ["get_bounds", "get_property",
                                "list_properties"];
var AELL_ALREADY_BATCHED_LIST = [
  "apply_keyframe_ease", "apply_preset", "distribute_property",
  "for_each_layer", "grid_layout", "precompose", "remove_keyframes",
  "reorder_layers", "set_keyframes", "set_solid_color", "stagger_layers"
];

function AELL_nameSet(list) {
  var m = {};
  for (var i = 0; i < list.length; i++) m[list[i]] = true;
  return m;
}
var AELL_PER_LAYER = AELL_nameSet(AELL_PER_LAYER_LIST);
var AELL_PER_LAYER_READ = AELL_nameSet(AELL_PER_LAYER_READ_LIST);
var AELL_ALREADY_BATCHED = AELL_nameSet(AELL_ALREADY_BATCHED_LIST);

/*
 * Reject a tool name for for_each_layer, in the tool's own words, or
 * return "" when it is drivable. Every refusal names what IS drivable —
 * the small model's only way back to a working call.
 */
function AELL_whyNotPerLayer(toolName) {
  if (AELL_PER_LAYER[toolName]) return "";
  var drivable = "Drivable tools: " + AELL_PER_LAYER_LIST.join(", ") + ".";
  if (AELL_ALREADY_BATCHED[toolName]) {
    return "'" + toolName + "' already takes its own {layers} list — call " +
      "it ONCE with every layer instead of once per layer. " + drivable;
  }
  if (AELL_PER_LAYER_READ[toolName]) {
    return "'" + toolName + "' READS a value, and for_each_layer reports " +
      "only counts — every value it returned would be discarded. Call it " +
      "once per layer, or use get_comp_details / list_properties for an " +
      "overview. " + drivable;
  }
  if (AELL_TOOLS[toolName]) {
    return "'" + toolName + "' has no per-layer target, so running it once " +
      "per layer would just repeat the same comp- or project-level action " +
      "N times and report it as success. " + drivable;
  }
  return "Unknown tool: '" + toolName + "'. " + drivable;
}

/*
 * Run ANY layer tool once per target layer, host-side — the "script"
 * for batch requests: one model call, hundreds of layers, no per-layer
 * inference. The layer is injected by INDEX (names can repeat).
 */
AELL_TOOLS.for_each_layer = function (args) {
  // Validate the TOOL before the layers: a bad tool name is the mistake
  // worth reporting, and resolving 200 layers first would bury it under a
  // layer-not-found error about an unrelated argument.
  var toolName = String(args.tool || "");
  var why = AELL_whyNotPerLayer(toolName);
  if (why) return AELL_err(why);
  var tool = AELL_TOOLS[toolName];
  var comp = AELL_resolveComp(args.comp);
  var layers;
  try { layers = AELL_layersOrSelection(comp, args); }
  catch (eL) { return AELL_err(eL.message); }
  if (layers.length > 200) {
    return AELL_err("Capped at 200 layers per call (got " + layers.length +
                    ")");
  }
  var failures = [];
  var okCount = 0;
  for (var i = 0; i < layers.length; i++) {
    var sub = {};
    var src = args.args || {};
    for (var key in src) {
      if (Object.prototype.hasOwnProperty.call(src, key)) sub[key] = src[key];
    }
    sub.comp = args.comp;
    sub.layer = layers[i].index;
    delete sub.layers;
    var r = tool(sub);
    if (r && r.ok) {
      okCount++;
    } else {
      failures.push(layers[i].name + ": " + (r ? r.error : "unknown error"));
      if (failures.length >= 5) {
        // Partial, not plain, failure: okCount layers were already
        // changed. If the round is rollback-armed those go with it; if
        // it is not, they stay. Either way the caller is told which.
        return AELL_errPartial("Stopped after 5 failures (" + okCount +
          " layers were already changed before that). Failures: " +
          failures.join(" | "));
      }
    }
  }
  return AELL_okay({ tool: toolName, layers: layers.length,
    succeeded: okCount,
    failures: failures.length ? failures.join(" | ") : "" });
};

AELL_TOOLS.set_track_matte = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var mode = String(args.mode || "alpha").toLowerCase();
  if (mode === "none" || mode === "off" || mode === "remove") {
    try {
      if (typeof layer.removeTrackMatte === "function") {
        layer.removeTrackMatte();
      } else {
        layer.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
      }
    } catch (e) {
      return AELL_err("Could not remove the matte: " + (e.message || e));
    }
    return AELL_okay({ layer: layer.name, matte: "removed" });
  }
  var MAP = { alpha: "ALPHA", alpha_inverted: "ALPHA_INVERTED",
              luma: "LUMA", luma_inverted: "LUMA_INVERTED" };
  if (!MAP[mode]) {
    return AELL_err("'mode' must be alpha, alpha_inverted, luma, " +
                    "luma_inverted or none");
  }
  if (args.matteLayer === null || typeof args.matteLayer === "undefined" ||
      args.matteLayer === "") {
    return AELL_err("'matteLayer' is required — the layer whose alpha/" +
                    "luma cuts this one");
  }
  var matte = AELL_resolveLayer(comp, args.matteLayer);
  if (matte === layer) return AELL_err("A layer cannot matte itself");
  var tmt = TrackMatteType[MAP[mode]];
  try {
    if (typeof layer.setTrackMatte === "function") {
      // AE 23+: any layer can be the matte, no stacking requirement.
      layer.setTrackMatte(matte, tmt);
    } else {
      // Legacy AE: matte must sit directly above the layer.
      if (matte.index !== layer.index - 1) matte.moveBefore(layer);
      layer.trackMatteType = tmt;
    }
  } catch (e) {
    return AELL_err("AE rejected the matte: " + (e.message || e));
  }
  return AELL_okay({ layer: layer.name, matte: matte.name, mode: mode });
};

AELL_TOOLS.list_effects = function (args) {
  var all = null;
  try { all = app.effects; } catch (e) { all = null; }
  if (!all || !all.length) {
    return AELL_err("Installed-effect catalog unavailable in this host");
  }
  var filter = args.filter ? String(args.filter).toLowerCase() : "";
  var offset = args.offset > 0 ? Math.round(args.offset) : 0;
  var LIMIT = 40;
  var hits = [];
  var total = 0;
  for (var i = 0; i < all.length; i++) {
    var e2 = all[i];
    var dn = String(e2.displayName || "");
    if (dn === "") continue;
    var cat = String(e2.category || "");
    if (filter && dn.toLowerCase().indexOf(filter) === -1 &&
        cat.toLowerCase().indexOf(filter) === -1) continue;
    total++;
    if (total > offset && hits.length < LIMIT) {
      hits.push({ name: dn, matchName: e2.matchName, category: cat });
    }
  }
  return AELL_okay({ total: total, offset: offset, listed: hits.length,
    effects: hits,
    note: total > offset + hits.length
      ? "More matches — pass {offset: " + (offset + hits.length) +
        "} or a narrower {filter}"
      : "" });
};

/* ------------------------------------------------------- animation presets
 *
 * AE ships 679 .ffx files (measured, AE 2026) — behaviors, text animations,
 * effect stacks, backgrounds. `layer.applyPreset(File)` reaches all of them,
 * but only if it is called the way AE means it, and every one of the rules
 * below was measured in the field because the API documents none of them:
 *
 * - applyPreset applies to the comp's SELECTION, not to the receiver. With
 *   two layers selected, ONE call put the preset on BOTH. So the tool
 *   selects exactly its target and restores the user's selection after.
 * - With NOTHING selected it does not apply to the receiver either: AE
 *   invents a comp-sized solid ("Solid 6"), applies the preset THERE and
 *   leaves the layer alone. A naive call is therefore not a no-op — it is
 *   litter.
 * - Whether the comp is open in a viewer makes no difference (measured
 *   both ways, identical), and comp.time is untouched.
 * - A preset built for another layer type is a SILENT no-op: a Text preset
 *   on a solid added no effect, no keyframe, no expression and threw
 *   nothing. Only a before/after census can tell that apart from success,
 *   which is why one runs here.
 * - A bad path DOES throw ("Path is not valid"), so file errors are real.
 * - One preset can add many effects (Backgrounds/Anime Radial: 10) and a
 *   text preset can add ZERO effects and only keyframes — so "did it
 *   work" counts effects AND expressions AND keys.
 * - A locked layer still takes a preset (AE does not refuse), so the
 *   result says so rather than pretending the lock held.
 * - Cameras have no Effect Parade and took nothing at all.
 * - File.name is URI-ENCODED ("Bungee%20In.ffx"); displayName is not.
 * - The user's presets live under a "User Presets" folder inside any
 *   Documents/Adobe/"After Effects…" folder, and Documents may itself be
 *   redirected (it is OneDrive on the machine this was measured on),
 *   so the path comes from Folder.myDocuments, never from a built string.
 */

var AELL_PRESET_CACHE = null;

function AELL_presetRoots() {
  var roots = [];
  var i;
  try {
    var appRoot = new Folder(Folder.startup.fsName + "/Presets");
    if (appRoot.exists) roots.push({ source: "app", folder: appRoot });
  } catch (e1) {}
  try {
    var adobe = new Folder(Folder.myDocuments.fsName + "/Adobe");
    if (adobe.exists) {
      var kids = adobe.getFiles();
      for (i = 0; i < kids.length; i++) {
        if (!(kids[i] instanceof Folder)) continue;
        if (!/^After Effects/i.test(String(kids[i].displayName))) continue;
        var up = new Folder(kids[i].fsName + "/User Presets");
        if (up.exists) roots.push({ source: "user", folder: up });
      }
    }
  } catch (e2) {}
  return roots;
}

/* 679 files walked in 117 ms (measured), but the model asks repeatedly —
 * so it is walked once per session unless {refresh: true}. */
function AELL_presetIndex(refresh) {
  if (AELL_PRESET_CACHE && !refresh) return AELL_PRESET_CACHE;
  var list = [];
  var roots = AELL_presetRoots();

  function walk(folder, source, category, depth) {
    if (depth > 10 || list.length > 5000) return;
    var kids;
    try { kids = folder.getFiles(); } catch (eW) { return; }
    if (!kids) return;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var dn = String(k.displayName);
      if (k instanceof Folder) {
        walk(k, source, category ? category + "/" + dn : dn, depth + 1);
      } else if (/\.ffx$/i.test(dn)) {
        list.push({
          name: dn.replace(/\.ffx$/i, ""),
          category: category,
          source: source,
          file: k
        });
      }
    }
  }
  for (var r = 0; r < roots.length; r++) {
    walk(roots[r].folder, roots[r].source, "", 0);
  }
  AELL_PRESET_CACHE = list;
  return list;
}

function AELL_presetCategories(list) {
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i].category || "(root)";
    var top = c.split("/")[0];
    if (!seen[top]) { seen[top] = true; out.push(top); }
  }
  return out;
}

function AELL_presetPath(p) {
  return (p.category ? p.category + "/" : "") + p.name;
}

/* Match a model-supplied name against the index. Returns
 * {hit} | {choices} (ambiguous) | {near} (nothing matched). */
function AELL_presetMatch(list, want) {
  var raw = String(want == null ? "" : want);
  var norm = raw.replace(/\\/g, "/").replace(/\.ffx$/i, "");
  norm = norm.replace(/^\s+|\s+$/g, "").toLowerCase();
  if (norm === "") return { near: [] };

  var i, p, full, nm;
  var fullExact = [], nameExact = [], fullSub = [], nameSub = [];
  for (i = 0; i < list.length; i++) {
    p = list[i];
    full = AELL_presetPath(p).toLowerCase();
    nm = p.name.toLowerCase();
    if (full === norm) fullExact.push(p);
    else if (nm === norm) nameExact.push(p);
    else if (full.indexOf(norm) !== -1) fullSub.push(p);
    else if (nm.indexOf(norm) !== -1) nameSub.push(p);
  }
  var tiers = [fullExact, nameExact, fullSub, nameSub];
  for (i = 0; i < tiers.length; i++) {
    if (tiers[i].length === 1) return { hit: tiers[i][0] };
    if (tiers[i].length > 1) return { choices: tiers[i] };
  }
  // Nothing contained the whole string — offer whatever shares a word.
  var words = norm.split(/[^a-z0-9]+/), near = [], seen = {};
  for (i = 0; i < list.length && near.length < 10; i++) {
    full = AELL_presetPath(list[i]).toLowerCase();
    for (var w = 0; w < words.length; w++) {
      if (words[w].length < 3) continue;
      if (full.indexOf(words[w]) !== -1 && !seen[full]) {
        seen[full] = true;
        near.push(AELL_presetPath(list[i]));
        break;
      }
    }
  }
  return { near: near };
}

AELL_TOOLS.list_presets = function (args) {
  var list = AELL_presetIndex(!!args.refresh);
  if (!list.length) {
    return AELL_err("No .ffx presets found. Looked in AE's own " +
      "Presets folder (" + Folder.startup.fsName + "\\Presets) and " +
      "Documents\\Adobe\\After Effects*\\User Presets.");
  }
  var cats = AELL_presetCategories(list);
  var filter = args.filter ? String(args.filter).toLowerCase() : "";
  var wantCat = args.category
    ? String(args.category).replace(/\\/g, "/").toLowerCase() : "";
  var wantSrc = args.source ? String(args.source).toLowerCase() : "";
  var offset = args.offset > 0 ? Math.round(args.offset) : 0;
  var limit = AELL_listLimit(args.limit);
  if (limit < 0) limit = list.length;

  var hits = [], total = 0;
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    var full = AELL_presetPath(p);
    if (wantSrc && p.source !== wantSrc) continue;
    if (wantCat && (p.category || "").toLowerCase().indexOf(wantCat) !== 0) {
      continue;
    }
    if (filter && full.toLowerCase().indexOf(filter) === -1) continue;
    total++;
    if (total > offset && hits.length < limit) {
      hits.push({ name: p.name, category: p.category, source: p.source });
    }
  }
  if (total === 0) {
    return AELL_err("No preset matches " +
      (filter ? "'" + args.filter + "'" : "that") +
      (wantCat ? " in category '" + args.category + "'" : "") +
      ". " + list.length + " presets are installed. Categories: " +
      cats.join(", ") + ".");
  }
  return AELL_okay({
    total: total, offset: offset, listed: hits.length,
    installed: list.length,
    categories: cats,
    presets: hits,
    note: total > offset + hits.length
      ? "More matches — pass {offset: " + (offset + hits.length) +
        "} or a narrower {filter}"
      : "Apply one with apply_preset {layer, preset: \"" +
        (hits.length ? AELL_presetPath(
          { category: hits[0].category, name: hits[0].name }) : "") + "\"}"
  });
};

/* Every expression and keyframe on a layer, counted. The only way to tell
 * a preset that did nothing from one that worked (AE reports neither). */
function AELL_presetCensus(layer) {
  var n = 0;
  function rec(group, depth) {
    if (depth > 6) return;
    var count = 0;
    try { count = group.numProperties; } catch (e0) { return; }
    for (var i = 1; i <= count; i++) {
      var p = null;
      try { p = group.property(i); } catch (e1) { continue; }
      if (!p) continue;
      try {
        if (p.propertyType === PropertyType.PROPERTY) {
          if (p.expression) n++;
          n += p.numKeys;
        } else {
          rec(p, depth + 1);
        }
      } catch (e2) {}
    }
  }
  rec(layer, 0);
  return n;
}

AELL_TOOLS.apply_preset = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (args.preset === null || typeof args.preset === "undefined" ||
      args.preset === "") {
    return AELL_err("'preset' is required — a preset name or " +
                    "\"Category/Name\". Use list_presets to find one.");
  }
  var list = AELL_presetIndex(false);
  if (!list.length) {
    return AELL_err("No .ffx presets are installed on this machine.");
  }
  var m = AELL_presetMatch(list, args.preset);
  if (m.choices) {
    var names = [];
    for (var c = 0; c < m.choices.length && c < 12; c++) {
      names.push(AELL_presetPath(m.choices[c]));
    }
    return AELL_err("'" + args.preset + "' matches " + m.choices.length +
      " presets — pass one of these exactly: " + names.join(", ") +
      (m.choices.length > 12 ? ", …" : ""));
  }
  if (!m.hit) {
    var cats = AELL_presetCategories(list);
    return AELL_err("No preset named '" + args.preset + "'. " +
      (m.near && m.near.length
        ? "Closest installed: " + m.near.join(", ") + "."
        : list.length + " presets are installed; categories: " +
          cats.join(", ") + ".") +
      " Use list_presets {filter} to search.");
  }
  var chosen = m.hit;
  if (!chosen.file.exists) {
    return AELL_err("Preset file has gone missing since it was indexed: " +
      chosen.file.fsName + ". Call list_presets {refresh: true}.");
  }

  var layers = AELL_layersOrSelection(comp, args);
  var results = [], skipped = [], locked = [], i, j;
  var layersBefore = comp.numLayers;

  for (i = 0; i < layers.length; i++) {
    var layer = layers[i];
    var fxBefore = AELL_effectNames(layer);
    var censusBefore = AELL_presetCensus(layer);
    var isLocked = false;
    try { isLocked = !!layer.locked; } catch (eL) {}

    try {
      AELL_keepSelection(comp, function () {
        for (var k = 1; k <= comp.numLayers; k++) {
          comp.layer(k).selected = false;
        }
        layer.selected = true;
        layer.applyPreset(chosen.file);
        return null;
      });
    } catch (eA) {
      return AELL_err("AE refused the preset file '" +
        AELL_presetPath(chosen) + "': " +
        (eA && eA.message ? eA.message : String(eA)));
    }

    var fxAfter = AELL_effectNames(layer);
    var censusAfter = AELL_presetCensus(layer);
    var added = [];
    var had = {};
    for (j = 0; j < fxBefore.length; j++) had[fxBefore[j]] = true;
    for (j = 0; j < fxAfter.length; j++) {
      if (!had[fxAfter[j]] && added.length < 12) added.push(fxAfter[j]);
    }
    var animAdded = censusAfter - censusBefore;
    var changed = added.length > 0 || animAdded !== 0 ||
                  fxAfter.length !== fxBefore.length;
    if (changed) {
      var row = { layer: layer.name, type: AELL_layerType(layer) };
      if (added.length) row.effectsAdded = added;
      if (animAdded > 0) row.keysAndExpressionsAdded = animAdded;
      results.push(row);
      if (isLocked) locked.push(layer.name);
    } else {
      skipped.push({ layer: layer.name, type: AELL_layerType(layer),
                     reason: "AE applied nothing" });
    }
  }

  if (results.length === 0) {
    var types = [];
    var seenT = {};
    for (i = 0; i < skipped.length; i++) {
      if (!seenT[skipped[i].type]) {
        seenT[skipped[i].type] = true;
        types.push(skipped[i].type);
      }
    }
    return AELL_err("Preset '" + AELL_presetPath(chosen) + "' changed " +
      "nothing on " + (skipped.length === 1
        ? "layer '" + skipped[0].layer + "' (" + types.join(", ") + ")"
        : skipped.length + " layers (" + types.join(", ") + ")") +
      ". AE applies a preset built for another layer type as a SILENT " +
      "no-op — a Text preset needs a TEXT layer, and cameras/lights take " +
      "no effects at all. Pick a preset from a category that fits, or a " +
      "different layer.");
  }

  var out = { preset: chosen.name, category: chosen.category,
              source: chosen.source, applied: results };
  // A Text preset on a non-text layer is not simply refused-or-applied.
  // Measured in AE 2026: "Alternating Characters In" on a SOLID installs
  // its six expression-control sliders and two keyframes and stops there
  // (census 2), where the same preset on a TEXT layer builds the whole
  // animator (census 15) — while "Center Spiral In", which carries no
  // controls, does nothing at all. So a partial landing is real, and
  // reporting it as a plain success would be the quiet lie this project
  // does not ship.
  if (/^Text($|\/)/i.test(String(chosen.category || ""))) {
    var nonText = [];
    for (i = 0; i < results.length; i++) {
      if (results[i].type !== "text") nonText.push(results[i].layer);
    }
    if (nonText.length) {
      out.partialOnNonText = nonText;
      out.partialNote = "This is a Text preset. On a non-text layer only " +
        "its expression CONTROLS can land — the animation itself lives in " +
        "text animators, which only a TEXT layer has. Apply it to a text " +
        "layer for the effect the preset is named after.";
    }
  }
  if (skipped.length) {
    out.skipped = skipped;
    out.note = skipped.length + " layer(s) got nothing — the preset does " +
      "not fit that layer type.";
  }
  if (locked.length) {
    out.lockedButApplied = locked;
    out.lockNote = "AE does NOT block a preset on a locked layer " +
      "(measured) — those layers were changed.";
  }
  if (comp.numLayers !== layersBefore) {
    out.layersAdded = comp.numLayers - layersBefore;
  }
  return AELL_okay(out);
};

// Tools that modify the project get wrapped in an undo group.
var AELL_MUTATING = {
  create_comp: true, add_text_layer: true, add_solid: true,
  add_text_animator: true,
  set_transform: true, add_keyframe: true, set_expression: true,
  apply_effect: true, set_effect_param: true, set_layer_timing: true,
  delete_layer: true, set_comp_setting: true, import_file: true,
  add_to_render_queue: true, add_shape_layer: true, add_mask: true,
  // import_as_layer imports and adds a layer: ordinary edits, one
  // Ctrl+Z. snapshot_frame is absent for render_comp's second reason
  // (see below): it changes NOTHING that survives the call, so counting
  // it as a mutation would let a successful snapshot arm a rollback and
  // spend the round's one Ctrl+Z on somebody else's edit.
  import_as_layer: true,
  // render_comp and list_render_templates are deliberately ABSENT, and
  // render_comp's absence is load-bearing rather than tidy.
  //
  // This map opens an undo group around the tool, and AE CANNOT RENDER
  // INSIDE ONE. Measured the hard way: with render_comp registered here
  // the suite rendered fine and then AE put up "After Effects warning:
  // Undo group mismatch" -- a modal, which wedges an unattended AE and
  // swallows every -r script after it while the process still reports as
  // healthy. AE's renderer closes the script's group out from under it,
  // so the count goes wrong and the warning surfaces later, at some
  // innocent endUndoGroup further down the run. Nothing here needs
  // undoing anyway: render_comp removes its own queue item and restores
  // every flag it touched, and the FILE it writes is not undoable.
  //
  // Dry-run protection is NOT lost by this: that comes from
  // `mutating: true` on the tools.js TOOL_DEFS entry, which is a
  // separate map, so a dry run still refuses to burn a real render.
  //
  // list_render_templates is absent for its own reason: it is a READ the
  // model needs during a dry run, and listing it here would also let a
  // successful read arm AELL_maybeRollback.
  precompose: true, add_camera: true, add_light: true,
  add_marker: true,
  set_layer_3d: true, set_layer_parent: true,
  add_null: true, add_control: true, link_property: true,
  // Unlike render_comp, AE's "Convert Audio to Keyframes" menu command
  // nests happily inside a script's undo group -- measured across six
  // calls in one group with no "Undo group mismatch" warning.
  audio_to_keyframes: true,
  apply_expression_preset: true, set_text_style: true,
  center_anchor_point: true,
  create_folder: true, move_to_folder: true, rename_item: true,
  delete_item: true, duplicate_comp: true, organize_project: true,
  // clean_project's dry run (the default) changes nothing, and an empty
  // undo group registers no step -- same reasoning as rename_comps.
  // Measured: reduceProject inside a group closes cleanly and ONE Ctrl+Z
  // restores the whole project, so unlike render_comp it belongs here.
  clean_project: true,
  grid_layout: true, duplicate_layer: true, split_layer_into_chunks: true,
  stagger_layers: true, distribute_property: true, apply_keyframe_ease: true,
  scale_comp: true, reorder_layers: true,
  set_property: true, set_keyframes: true, remove_keyframes: true,
  set_track_matte: true,
  set_mask: true, set_mask_path: true, add_shape_content: true,
  for_each_layer: true,
  // audit_comp_usage is READ-only and deliberately absent. rename_comps
  // is here even though its DEFAULT dry run changes nothing: the group it
  // opens is then empty, and an empty group registers no undo step at all
  // (measured), so a preview still costs the user nothing.
  rename_comps: true,
  set_solid_color: true,
  apply_preset: true,
  // add_captions makes N ordinary text layers (or writes N markers) and
  // nothing else -- one Ctrl+Z, like add_text_layer. render_comp_audio is
  // deliberately ABSENT for render_comp's reason: it IS a render.
  add_captions: true
};

/* Tools that must NOT run inside an undo group, whatever else is in the
 * round with them. Keeping render_comp out of AELL_MUTATING is only half
 * the job: a BATCH opens one group if ANY command in it mutates, so
 * "add a solid and render it" would put the render straight back inside
 * one and earn the modal again. The batch runner steps out of the group
 * for these and steps back in, so the caller's endUndoGroup still
 * balances. */
var AELL_NO_UNDO_GROUP = {
  render_comp: true,
  // render_comp_audio delegates straight to render_comp, so it inherits
  // the "Undo group mismatch" modal along with the rest of the render.
  render_comp_audio: true,
  // snapshot_frame is here for the SECOND half of that reasoning rather
  // than the first. It is safe inside a group -- saveFrameToPng was
  // measured inside three nested undo groups, followed by three more
  // group cycles, with no "Undo group mismatch" -- but the file it
  // writes cannot be undone by anything, so a round containing one is
  // not honestly "one Ctrl+Z" either way, and its success must not arm
  // AELL_maybeRollback.
  snapshot_frame: true
};

// --------------------------------------------------------------- entry point

/* Run one tool with NO undo group of its own. The caller owns the group,
 * which is what lets a batch put many tools inside a single Ctrl+Z.
 * Never throws: a tool that blows up comes back as a normal error result. */
function AELL_runTool(toolName, args) {
  try {
    var tool = AELL_TOOLS[toolName];
    if (!tool) return AELL_err("Unknown tool: " + toolName);
    return tool(args);
  } catch (e) {
    return AELL_err(e && e.message ? e.message : String(e));
  }
}

function AELL_call(toolName, argsJson) {
  var result;
  try {
    if (!AELL_TOOLS[toolName]) {
      result = AELL_err("Unknown tool: " + toolName);
    } else {
      var args = AELLJSON.parse(argsJson);
      if (AELL_MUTATING[toolName]) {
        app.beginUndoGroup("AE Llama: " + toolName);
        try {
          result = AELL_runTool(toolName, args);
        } finally {
          app.endUndoGroup();
        }
      } else {
        result = AELL_runTool(toolName, args);
      }
    }
  } catch (e) {
    result = AELL_err(e && e.message ? e.message : String(e));
  }
  try {
    return AELLJSON.stringify(result);
  } catch (e2) {
    return '{"ok":false,"error":"Failed to serialize result"}';
  }
}

$.global.AELL_call = AELL_call;

// ------------------------------------------------------- round rollback
/*
 * A round that fails PART WAY used to leave its successes behind. The
 * model, seeing a failed round, would redo the whole thing -- which is
 * how "make nine squares" ended up making ten: duplicate_layer errored
 * before add_solid had a layer to copy, add_solid succeeded anyway, and
 * the retry built nine more on top of the orphan.
 *
 * Now that a round is ONE undo group (AELL_callBatch), the fix is one
 * Undo. The whole safety argument rests on issuing it HERE, inside the
 * same script execution that made the changes: AE blocks its UI for the
 * duration, so nothing of the user's can land on top of the undo stack
 * between endUndoGroup() and the Undo. Exactly one Undo is ever issued.
 *
 * Measured in AE 2026 before any of this was written:
 *  - an EMPTY undo group registers NOTHING, and one Undo then reaches
 *    straight past it into the user's own last edit. That is why the
 *    sentinel below is load-bearing rather than belt-and-braces.
 *  - a net-zero comment write DOES register a group (so does an
 *    addFolder+remove), leaving the project byte-identical.
 *  - import_file, add_to_render_queue and delete_item all reverse
 *    cleanly with a single Undo, so none of them need excluding.
 *  - undoing a create_comp while that comp is frontmost opens no
 *    dialog, leaves activeItem null rather than dangling, and leaves
 *    the viewer alive.
 *  - two full 200-layer fingerprints cost 37 ms, so the verification
 *    below can afford full fidelity over the whole project.
 *
 * Measured again on 2026-08-29, when "does rollback reach PROJECT ITEMS"
 * was finally answered (it does -- addComp, duplicate, addFolder,
 * item.remove, move_to_folder and rename all revert on the one Undo, and
 * the shipped AELL_callBatch path was driven through each). The real
 * finding was the other half: of 25 dimensions a mutating tool can
 * write, AE's Undo reverted ALL 25 and the fingerprint could see only 4.
 * The blind 21 are recorded below now. Nothing about the rollback
 * changed; what changed is that its self-check can now fail honestly.
 */

/* One switch or scalar, read defensively.
 *
 * A build that does not have this property, or an object that refuses it
 * (a camera has no adjustmentLayer, a folder has no bgColor), must
 * produce a STABLE absence -- the same string every time -- or the
 * fingerprint stops being deterministic and every rollback reports
 * itself as an overshoot. */
function AELL_sigOf(obj, key) {
  try {
    var v = obj[key];
    if (v === true) return "1";
    if (v === false) return "0";
    if (v === undefined || v === null) return "-";
    return String(v);
  } catch (e) { return "?"; }
}

/* Markers, cheaply.
 *
 * The count alone is not enough: add_marker was measured REPLACING a
 * marker already at that time (item 5.4), so a rollback that failed to
 * restore the old one would leave the count identical. The key TIMES go
 * in too, capped so that a comp somebody has marked up heavily cannot
 * turn the verification into the expensive half of the round. */
function AELL_markerSig(mp) {
  if (!mp) return "-";
  var n;
  try { n = mp.numKeys; } catch (e) { return "?"; }
  var t = String(n), lim = (n < 50) ? n : 50, i;
  for (i = 1; i <= lim; i++) {
    try { t += ":" + mp.keyTime(i); } catch (e2) { t += ":?"; }
  }
  return t;
}

/* One layer's contribution to the fingerprint. Everything is wrapped:
 * cameras, lights and shape layers each lack some of these, and a
 * missing property must produce a STABLE absence, not an exception. */
function AELL_layerSig(L, idx) {
  var t = idx + "|" + L.name + "|" + (L.enabled ? 1 : 0);
  try {
    var tr = L.property("ADBE Transform Group");
    t += "|p" + tr.property("ADBE Position").value.join(",");
    t += "|s" + tr.property("ADBE Scale").value.join(",");
    t += "|r" + tr.property("ADBE Rotate Z").value;
    t += "|o" + tr.property("ADBE Opacity").value;
    t += "|k" + tr.property("ADBE Opacity").numKeys;
  } catch (e1) {}
  try { t += "|e" + L.property("ADBE Effect Parade").numProperties; }
  catch (e2) {}
  try { t += "|m" + L.property("ADBE Mask Parade").numProperties; }
  catch (e3) {}
  try { t += "|f" + (L.parent ? L.parent.index : "-"); } catch (e4) {}
  try { t += "|t" + L.trackMatteType; } catch (e5) {}
  try { t += "|i" + L.inPoint + "," + L.outPoint + "," + L.startTime; }
  catch (e6) {}
  try {
    if (L instanceof TextLayer) {
      t += "|x" + L.property("Source Text").value.text;
    }
  } catch (e7) {}
  // The switches and 3D-only values. Every one of these is written by a
  // tool in AELL_MUTATING (set_layer_3d, add_marker, set_text_style,
  // apply_preset, for_each_layer), and probe 3 on 2026-08-29 measured
  // all of them changing WITHOUT moving the fingerprint by a byte -- 21
  // of 25 dimensions were blind. That did not make the rollback wrong
  // (AE's single Undo reverted every one), it made the VERIFICATION
  // blind: an undo that failed in one of these would have been reported
  // as a clean rollback, and an undo that overshot into the user's own
  // last edit -- the hazard the whole design exists for -- would have
  // been invisible whenever that edit was a switch.
  t += "|3" + AELL_sigOf(L, "threeDLayer") +
       AELL_sigOf(L, "shy") + AELL_sigOf(L, "locked") +
       AELL_sigOf(L, "motionBlur") + AELL_sigOf(L, "adjustmentLayer") +
       AELL_sigOf(L, "audioEnabled") + AELL_sigOf(L, "collapseTransformation") +
       "|b" + AELL_sigOf(L, "blendingMode");
  try { t += "|M" + AELL_markerSig(L.property("ADBE Marker")); }
  catch (e8) { t += "|M?"; }
  try {
    var tr3 = L.property("ADBE Transform Group");
    // 3D-only, and set_layer_3d's own documented loss. On a 2D layer AE
    // still answers these, so they read as a stable 0 rather than as an
    // absence -- which is the point: turning 3D off zeroes them.
    t += "|R" + tr3.property("ADBE Rotate X").value +
         "," + tr3.property("ADBE Rotate Y").value +
         "," + tr3.property("ADBE Orientation").value.join(",");
  } catch (e9) {}
  try {
    if (L instanceof TextLayer) {
      var td = L.property("Source Text").value;
      // set_text_style writes these and never touches .text, so the
      // "|x" above cannot see any of its work.
      t += "|X" + td.fontSize + "," + td.font + "," + td.tracking +
           "," + td.justification;
    }
  } catch (e10) {}
  return t;
}

/* A compact string that changes whenever anything a tool could have
 * touched changes. Used ONLY to verify that a rollback landed exactly
 * where it started -- never to decide WHAT to undo. It has to be
 * deterministic or every rollback would report itself as overshooting;
 * measured byte-stable across back-to-back runs on 200 layers. */
var AELL_SIG_LAYER_BUDGET = 4000;

function AELL_fingerprint() {
  var p = app.project;
  if (!p) return "no project";
  var parts = ["n" + p.numItems];
  try { parts.push("rq" + p.renderQueue.numItems); } catch (eQ) {}
  var budget = AELL_SIG_LAYER_BUDGET;
  for (var i = 1; i <= p.numItems; i++) {
    var it = p.item(i);
    var kind = (it instanceof CompItem) ? "c"
             : ((it instanceof FolderItem) ? "f" : "x");
    var t = i + ":" + it.name + ":" + kind;
    try { t += "/" + it.comment; } catch (e0) {}
    try {
      if (it.parentFolder) t += "/in:" + it.parentFolder.name;
    } catch (e1) {}
    // A solid's colour lives on the project ITEM, not on the layer --
    // which is why set_solid_color changes every layer sharing the
    // source, and why a fingerprint that only walked layers could not
    // see the change at all.
    try {
      if (it.mainSource instanceof SolidSource) {
        t += "/solid" + it.mainSource.color.join(",") +
             "@" + it.width + "x" + it.height;
      }
    } catch (eS) {}
    if (it instanceof CompItem) {
      t += "/" + it.width + "x" + it.height + "/" + it.duration +
           "/" + it.frameRate + "/" + it.numLayers;
      // Everything set_comp_setting can write, plus the switches beside
      // them in AE's own Composition Settings dialog. All measured blind
      // before this (probe 3, 2026-08-29): a rolled-back work area,
      // background colour or preview resolution left the fingerprint
      // byte-identical, so the verification had nothing to verify.
      t += "/s" + AELL_sigOf(it, "pixelAspect") +
           "," + AELL_sigOf(it, "displayStartTime") +
           "," + AELL_sigOf(it, "workAreaStart") +
           "," + AELL_sigOf(it, "workAreaDuration") +
           "," + AELL_sigOf(it, "motionBlur") +
           "," + AELL_sigOf(it, "shutterAngle") +
           "," + AELL_sigOf(it, "shutterPhase") +
           "," + AELL_sigOf(it, "frameBlending") +
           "," + AELL_sigOf(it, "hideShyLayers") +
           "," + AELL_sigOf(it, "preserveNestedFrameRate") +
           "," + AELL_sigOf(it, "preserveNestedResolution");
      try { t += "/bg" + it.bgColor.join(","); } catch (eB) {}
      try { t += "/rf" + it.resolutionFactor.join(","); } catch (eR) {}
      try { t += "/cm" + AELL_markerSig(it.markerProperty); } catch (eM) {}
      for (var j = 1; j <= it.numLayers; j++) {
        if (budget <= 0) { t += "\n (truncated)"; break; }
        budget--;
        try { t += "\n " + AELL_layerSig(it.layer(j), j); }
        catch (e2) { t += "\n " + j + "|(unreadable)"; }
      }
    }
    parts.push(t);
  }
  return parts.join("\n");
}

/* Make the undo group non-empty on purpose.
 *
 * Without this, a batch whose mutating tools all happened to change
 * nothing (a for_each_layer matching zero layers, a set_transform to the
 * value already there) would close an EMPTY group -- and the one Undo
 * would eat the user's previous edit instead. Net-zero by construction:
 * the comment is written and put straight back.
 *
 * Returns true only if a sentinel op actually happened. False disarms
 * the rollback entirely; nothing is ever undone on a guess. */
function AELL_sentinel() {
  var p = app.project;
  var i, it, old;
  for (i = 1; i <= p.numItems; i++) {
    it = p.item(i);
    if (!(it instanceof CompItem)) continue;
    try {
      old = it.comment;
      it.comment = old + " ";
      it.comment = old;
      return true;
    } catch (e) {}
  }
  // No comp to write to (so create_comp is the only mutation possible);
  // an item added and removed inside the group registers just as well.
  try {
    var f = p.items.addFolder("AE Llama rollback marker");
    f.remove();
    return true;
  } catch (e2) {}
  return false;
}

/*
 * Did this batch leave debris, and if so, undo it.
 *
 * Trigger: at least one MUTATING command succeeded AND at least one
 * failed -- in any order. Order does not matter because the debris is
 * whatever survives a round the model considers failed, and its
 * instinct is to redo the round whole. A failing READ-ONLY tool does
 * not trigger it: a bad lookup leaves nothing behind, and throwing away
 * real work over it would be worse than the disease.
 *
 * Returns null when there is nothing to decide, else a summary. On a
 * rollback the per-command results are rewritten in place, because a
 * result that says "ok" for something that no longer exists is the one
 * thing guaranteed to send the model down the wrong path.
 */
function AELL_maybeRollback(cmds, results, armed, before, aliasesBefore) {
  var okMut = 0, badMut = 0, firstError = "", i, name, r;
  for (i = 0; i < cmds.length; i++) {
    name = String((cmds[i] || {}).tool || "");
    if (!AELL_MUTATING[name]) continue;
    r = results[i] || {};
    if (r.ok) { okMut++; continue; }
    badMut++;
    if (!firstError) firstError = name + ": " + (r.error || "failed");
    // A tool that failed AFTER changing things (for_each_layer giving up
    // partway) is both halves of the trigger by itself.
    if (r.mutated) okMut++;
  }
  if (!okMut || !badMut) return null;

  if (!armed) {
    return { rolledBack: false, failed: firstError,
      why: "This round could not be rolled back safely, so the changes " +
           "that DID succeed are still there." };
  }

  app.executeCommand(16);            // Edit > Undo -- exactly once, ever
  var after = AELL_fingerprint();
  if (after !== before) {
    // We did not land where we started. Put it back and say so; a second
    // Undo is exactly the overshoot this design exists to prevent.
    app.executeCommand(17);          // Edit > Redo
    return { rolledBack: false, failed: firstError,
      why: "Rollback was attempted and abandoned -- the undo did not " +
           "land on the pre-round state, so it was redone. The changes " +
           "that succeeded are still there." };
  }

  // Undoing a create_comp leaves its rename alias pointing at a comp
  // that no longer exists; put the alias table back too.
  $.global.AELL_compAliases = aliasesBefore || {};

  // Wording measured against the model, not guessed. The first version
  // said "nothing was applied — re-plan from the current state", and the
  // model answered a rolled-back round with "Created the 'Beta' solid
  // layer successfully" and stopped: it reported work that had just been
  // undone, and never redid the half that COULD have succeeded. So the
  // note now says the two things it has to do, in the order it has to do
  // them, and forbids the claim outright.
  var note = "ROLLED BACK: a command in this round failed (" + firstError +
    ") after others had already changed the project, so the WHOLE round " +
    "was undone. Nothing from it exists — not even the commands that " +
    "reported ok. NEXT TURN, DO BOTH: (1) send the commands that CAN " +
    "succeed again, leaving out the one that failed; (2) in your reply, " +
    "tell the user plainly what you could NOT do and why. NEVER say " +
    "anything from this round was created, added or applied — it was " +
    "undone. If the failure is something only the user can fix, still " +
    "redo the rest first.";

  // The full explanation goes on the FIRST result only. Repeating 300
  // characters twenty times would eat the panel's whole tool-result
  // budget (compactToolResults caps the lot at 6000) and push the very
  // sentence the model needs out of its context.
  var brief = "Rolled back with the rest of this round — not applied.";
  var told = false;
  for (i = 0; i < results.length; i++) {
    r = results[i] || {};
    name = String((cmds[i] || {}).tool || "");
    var say = told ? brief : note;
    if (AELL_MUTATING[name]) {
      results[i] = { ok: false, rolledBack: true,
        error: (r.ok ? "" : String(r.error || "") + " — ") + say };
      told = true;
    } else {
      // A read still happened, and the state it described is the state
      // we just returned to, so its data survives with a warning on it.
      r.rolledBack = true;
      r.note = say;
      results[i] = r;
      told = true;
    }
  }
  return { rolledBack: true, failed: firstError, commands: cmds.length };
}

/* Run several tools inside ONE undo group, so a chat command that takes
 * five tool calls costs the user ONE Ctrl+Z instead of five.
 *
 * This has to be one call because an undo group does NOT survive the end
 * of the script execution that opened it (measured in AE 2026: open a
 * group in one evalScript, change something in the next, and the first
 * change is already in its own step). Bracketing the round with separate
 * begin/end calls therefore cannot work -- the tools must run together.
 * The same fact is what makes the rollback above safe.
 *
 * Takes '[{tool, args}, ...]' and an optional '{"rollback": true}',
 * returns '{ok, results: [...]}' with one result per command, in order,
 * whatever each one's outcome was, plus 'rollback' when a partial round
 * was undone. */
function AELL_callBatch(commandsJson, optsJson) {
  var out;
  try {
    var cmds = AELLJSON.parse(commandsJson);
    // A JSON string has a .length too, so ask what it really is.
    if (Object.prototype.toString.call(cmds) !== "[object Array]") {
      return '{"ok":false,"error":"AELL_callBatch wants [{tool, args}, ' +
             '...]"}';
    }
    var opts = {};
    if (typeof optsJson === "string" && optsJson !== "") {
      try { opts = AELLJSON.parse(optsJson) || {}; } catch (eO) { opts = {}; }
    }
    var results = [];
    var mutates = false;
    var first = "";
    for (var i = 0; i < cmds.length; i++) {
      var n = String((cmds[i] || {}).tool || "");
      if (!first && n) first = n;
      if (AELL_MUTATING[n]) mutates = true;
    }
    // Nothing that mutates means nothing to roll back, and the
    // fingerprint is pure cost — do not pay it.
    var arming = !!opts.rollback && mutates;
    var before = arming ? AELL_fingerprint() : "";
    var aliasesBefore = null;
    if (arming) {
      aliasesBefore = {};
      var al = $.global.AELL_compAliases || {};
      for (var key in al) {
        if (Object.prototype.hasOwnProperty.call(al, key)) {
          aliasesBefore[key] = al[key];
        }
      }
    }
    var sentinelOk = false;
    // AE cannot render inside an undo group: its renderer closes the
    // script's group out from under it and AE raises a modal "Undo group
    // mismatch" at some later endUndoGroup, which wedges an unattended
    // run. Closing the group around just the render and reopening it was
    // tried first and AE rejected that too -- so a round containing one
    // of these simply does not open a group at all. The cost is that the
    // OTHER mutations in such a round are not folded into one Ctrl+Z;
    // the alternative is a modal, so it is not a close call.
    var noGroup = false;
    for (var g = 0; g < cmds.length; g++) {
      if (AELL_NO_UNDO_GROUP[String((cmds[g] || {}).tool || "")]) {
        noGroup = true;
        break;
      }
    }
    var run = function () {
      if (arming) sentinelOk = AELL_sentinel();
      for (var j = 0; j < cmds.length; j++) {
        var c = cmds[j] || {};
        results.push(AELL_runTool(String(c.tool || ""), c.args || {}));
      }
    };
    if (mutates && !noGroup) {
      var label = "AE Llama: " + (first || "batch");
      if (cmds.length > 1) label += " +" + (cmds.length - 1) + " more";
      app.beginUndoGroup(label);
      try { run(); } finally { app.endUndoGroup(); }
    } else {
      run();
    }
    var data = { results: results };
    if (arming) {
      var verdict = AELL_maybeRollback(cmds, results, sentinelOk, before,
                                       aliasesBefore);
      if (verdict) data.rollback = verdict;
    }
    out = AELL_okay(data);
  } catch (e) {
    out = AELL_err(e && e.message ? e.message : String(e));
  }
  try {
    return AELLJSON.stringify(out);
  } catch (e2) {
    return '{"ok":false,"error":"Failed to serialize batch result"}';
  }
}

$.global.AELL_callBatch = AELL_callBatch;

/* Called by the panel when a NEW user request starts — comp-name aliases
 * are scoped to one request, deterministically, with no timers. */
$.global.AELL_newRequest = function () {
  $.global.AELL_compAliases = {};
};

/* AELLJSON is a top-level `var` of THIS file, and ExtendScript keeps such
 * a var in the scope the file was evaluated in — NOT on $.global. So a
 * later `-r` script that finds $.global.AELL_call already defined (this
 * file was loaded once, by the panel or by an earlier script) and skips
 * re-loading it can still call the tools, and yet a bare `AELLJSON` in
 * that script is a ReferenceError — which AE raises as a modal dialog
 * that blocks every following script. Measured 2026-08-26; it is what
 * silently broke chat-probe's verdict reads. $.global IS the contract for
 * external callers, so publish the serializer on it too. */
$.global.AELLJSON = AELLJSON;
