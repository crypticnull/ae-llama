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

AELL_TOOLS.duplicate_comp = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var dup = comp.duplicate();
  if (args.name) dup.name = String(args.name);
  return AELL_okay({ name: dup.name, id: dup.id, duplicatedFrom: comp.name });
};

AELL_TOOLS.organize_project = function (args) {
  var proj = app.project;
  if (!proj) return AELL_err("No project open");
  function ensureFolder(name) {
    var f = AELL_findFolder(name);
    if (!f) f = proj.items.addFolder(name);
    return f;
  }
  // Collect first: reparenting reorders proj.item() indices mid-loop.
  var toMove = [];
  var i, it;
  for (i = 1; i <= proj.numItems; i++) {
    it = proj.item(i);
    if (it instanceof FolderItem) continue;
    if (it.parentFolder !== proj.rootFolder) continue;  // respect existing org
    toMove.push(it);
  }
  var counts = { Comps: 0, Solids: 0, Audio: 0, Images: 0, Footage: 0 };
  for (i = 0; i < toMove.length; i++) {
    it = toMove[i];
    var dest = null;
    if (it instanceof CompItem) {
      dest = "Comps";
    } else if (it instanceof FootageItem) {
      var src = it.mainSource;
      if (src instanceof SolidSource) dest = "Solids";
      else if (it.hasAudio && !it.hasVideo) dest = "Audio";
      else if (src && src.isStill) dest = "Images";
      else dest = "Footage";
    }
    if (dest) {
      it.parentFolder = ensureFolder(dest);
      counts[dest]++;
    }
  }
  return AELL_okay({ organized: counts,
    note: "Only loose items at the project root were filed; existing " +
          "folder structure was left alone" });
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
 * name-based comp reference ambiguous (it silently hits the OLDEST one). */
function AELL_uniqueItemName(base) {
  var taken = {};
  for (var i = 1; i <= app.project.numItems; i++) {
    try { taken[app.project.item(i).name] = true; } catch (e) {}
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
  var rect = layer.sourceRectAtTime(comp.time, false);
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

AELL_TOOLS.set_comp_setting = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (args.duration > 0) comp.duration = args.duration;
  if (args.frameRate > 0) comp.frameRate = args.frameRate;
  if (args.width > 0) comp.width = Math.round(args.width);
  if (args.height > 0) comp.height = Math.round(args.height);
  if (AELLJSON.isArray(args.bgColor) && args.bgColor.length >= 3) {
    comp.bgColor = [args.bgColor[0], args.bgColor[1], args.bgColor[2]];
  }
  return AELL_okay({ name: comp.name, width: comp.width, height: comp.height,
                     duration: comp.duration, frameRate: comp.frameRate });
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
  return AELL_okay({ layer: layer.name, added: item.name,
    matchName: matchName, container: into, params: applied.join(", "),
    note: "Animatable via set_keyframes on 'contents/" +
          (into === "(layer root)" ? "" : into + "/") + item.name +
          "/<param>' paths" });
};

AELL_TOOLS.precompose = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (!args.name) return AELL_err("'name' is required");
  if (!AELLJSON.isArray(args.layers) || args.layers.length === 0) {
    return AELL_err("'layers' (array of names or 1-based indices) is required");
  }
  var indices = [];
  for (var i = 0; i < args.layers.length; i++) {
    indices.push(AELL_resolveLayer(comp, args.layers[i]).index);
  }
  var move = args.moveAttributes !== false;
  var pre = comp.layers.precompose(indices, String(args.name), move);
  return AELL_okay({ precomp: pre.name, id: pre.id,
                     layersMoved: indices.length });
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

AELL_TOOLS.add_marker = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (typeof args.time !== "number") {
    return AELL_err("'time' (seconds) is required");
  }
  var mv = new MarkerValue(typeof args.comment === "string" ? args.comment : "");
  if (args.duration > 0) mv.duration = args.duration;
  var target;
  var where;
  if (args.layer !== null && typeof args.layer !== "undefined" &&
      args.layer !== "") {
    var layer = AELL_resolveLayer(comp, args.layer);
    target = layer.property("ADBE Marker");
    where = "layer " + layer.name;
  } else {
    target = comp.markerProperty;
    where = "comp " + comp.name;
  }
  target.setValueAtTime(args.time, mv);
  return AELL_okay({ marker: where, time: args.time });
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
  var jump = args.keepPosition !== false;   // default: no visual jump
  var done = [], skipped = [];
  for (i = 0; i < targets.length; i++) {
    var L = targets[i];
    if (parent && L === parent) {
      skipped.push(L.name + " (is the parent)");
      continue;
    }
    try {
      if (jump && typeof L.setParentWithJump === "function") {
        L.setParentWithJump(parent);
      } else {
        L.parent = parent;
      }
      done.push(L.name);
    } catch (e) {
      skipped.push(L.name + " (" + (e.message || e) + ")");
    }
  }
  return AELL_okay({ parent: parent ? parent.name : "(none)",
    parented: done.join(", ") || "(none)",
    skipped: skipped.join("; "),
    note: jump ? "Visual positions preserved" : "" });
};

AELL_TOOLS.add_to_render_queue = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var rqItem = app.project.renderQueue.items.add(comp);
  if (typeof args.outputPath === "string" && args.outputPath !== "") {
    rqItem.outputModule(1).file = new File(args.outputPath);
  }
  return AELL_okay({ comp: comp.name,
                     queuePosition: app.project.renderQueue.numItems });
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
    var child = null;
    try { child = node.property(lookup); } catch (e) { child = null; }
    if (!child && lookup !== seg) {
      try { child = node.property(seg); } catch (e2) { child = null; }
    }
    if (!child) {
      var at = walked.length ? "'" + walked.join("/") + "'"
                             : "layer '" + layer.name + "'";
      throw new Error("Path segment '" + seg + "' not found under " + at +
        ". Children here: " +
        (AELL_childNames(node, 30).join(", ") || "(none)") +
        ". Use list_properties to inspect the real tree.");
    }
    node = child;
    walked.push(seg);
  }
  return node;
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

/* Accept friendly specs (position, effect.X.Y) AND '/'-joined paths. */
function AELL_anyProperty(layer, spec) {
  var s = String(spec || "");
  if (s === "") throw new Error("Missing 'property'");
  if (s.indexOf("/") !== -1) {
    return AELL_descendToLeaf(AELL_resolvePropPath(layer, s));
  }
  try {
    return AELL_resolveProperty(layer, s);
  } catch (friendlyErr) {
    try {
      return AELL_descendToLeaf(AELL_resolvePropPath(layer, s));
    } catch (pathErr) {
      throw (s.indexOf(".") !== -1) ? friendlyErr : pathErr;
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

AELL_TOOLS.get_property = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_layerOrSelection(comp, args.layer);
  var prop = AELL_anyProperty(layer, args.property);
  if (!AELL_isLeafProp(prop)) {
    return AELL_err("'" + args.property + "' is a GROUP — use " +
      "list_properties {path: \"" + args.property + "\"} to see inside");
  }
  var data = { layer: layer.name, property: String(args.property),
               matchName: prop.matchName, value: AELL_sampleValue(prop) };
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
  return AELL_okay(data);
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
  if (!AELL_isLeafProp(prop)) {
    return AELL_err("'" + args.property + "' is a GROUP — set one of its " +
      "properties instead (list_properties {path: \"" + args.property +
      "\"} shows them)");
  }
  if (typeof args.value === "undefined") {
    return AELL_err("'value' is required");
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
  return AELL_okay(out);
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
  "add_control", "add_keyframe", "add_marker", "add_mask",
  "add_shape_content", "apply_effect", "apply_expression_preset",
  "center_anchor_point", "delete_layer", "duplicate_layer", "link_property",
  "set_effect_param", "set_expression", "set_layer_3d", "set_layer_parent",
  "set_layer_timing", "set_mask", "set_mask_path", "set_property",
  "set_text_style", "set_track_matte", "set_transform",
  "split_layer_into_chunks"
];
var AELL_PER_LAYER_READ_LIST = ["get_property", "list_properties"];
var AELL_ALREADY_BATCHED_LIST = [
  "apply_keyframe_ease", "distribute_property", "for_each_layer",
  "grid_layout", "precompose", "remove_keyframes", "reorder_layers",
  "set_keyframes", "set_solid_color", "stagger_layers"
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

// Tools that modify the project get wrapped in an undo group.
var AELL_MUTATING = {
  create_comp: true, add_text_layer: true, add_solid: true,
  set_transform: true, add_keyframe: true, set_expression: true,
  apply_effect: true, set_effect_param: true, set_layer_timing: true,
  delete_layer: true, set_comp_setting: true, import_file: true,
  add_to_render_queue: true, add_shape_layer: true, add_mask: true,
  precompose: true, add_camera: true, add_light: true,
  add_marker: true,
  set_layer_3d: true, set_layer_parent: true,
  add_null: true, add_control: true, link_property: true,
  apply_expression_preset: true, set_text_style: true,
  center_anchor_point: true,
  create_folder: true, move_to_folder: true, rename_item: true,
  delete_item: true, duplicate_comp: true, organize_project: true,
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
  set_solid_color: true
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
 */

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
    if (it instanceof CompItem) {
      t += "/" + it.width + "x" + it.height + "/" + it.duration +
           "/" + it.frameRate + "/" + it.numLayers;
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
    var run = function () {
      if (arming) sentinelOk = AELL_sentinel();
      for (var j = 0; j < cmds.length; j++) {
        var c = cmds[j] || {};
        results.push(AELL_runTool(String(c.tool || ""), c.args || {}));
      }
    };
    if (mutates) {
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
