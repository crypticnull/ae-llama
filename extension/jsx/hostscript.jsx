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
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    if (it instanceof CompItem && it.name === name) return it;
  }
  throw new Error("Comp not found: " + name);
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
    throw new Error("No layer selected in '" + comp.name + "' — select " +
                    "one in AE or pass {layer: name|index}");
  }
  var names = [];
  for (var i = 0; i < sel.length; i++) names.push(sel[i].name);
  throw new Error(sel.length + " layers selected (" + names.join(", ") +
                  ") — pass {layer: name} to pick one");
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

AELL_TOOLS.get_project_info = function (args) {
  var proj = app.project;
  if (!proj) return AELL_err("No project open");
  var items = [];
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
  return AELL_okay({
    projectFile: proj.file ? proj.file.fsName : null,
    numItems: proj.numItems,
    items: items,
    activeComp: active
  });
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
  var layers = [];
  for (var i = 1; i <= comp.numLayers; i++) {
    var layer = comp.layer(i);
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
    if (layer.selected) entry.selected = true;
    layers.push(entry);
  }
  return AELL_okay({
    name: comp.name,
    width: comp.width,
    height: comp.height,
    duration: comp.duration,
    frameRate: comp.frameRate,
    numLayers: comp.numLayers,
    layers: layers
  });
};

AELL_TOOLS.create_comp = function (args) {
  if (!args.name) return AELL_err("'name' is required");
  var w = Math.max(4, Math.min(30000, Math.round(args.width || 1920)));
  var h = Math.max(4, Math.min(30000, Math.round(args.height || 1080)));
  var dur = args.duration > 0 ? args.duration : 10;
  var fps = args.frameRate > 0 ? args.frameRate : 30;
  var comp = app.project.items.addComp(args.name, w, h, 1, dur, fps);
  if (AELLJSON.isArray(args.bgColor) && args.bgColor.length >= 3) {
    comp.bgColor = [args.bgColor[0], args.bgColor[1], args.bgColor[2]];
  }
  comp.openInViewer();
  return AELL_okay({ name: comp.name, id: comp.id, width: w, height: h,
                     duration: dur, frameRate: fps });
};

/*
 * Apply style fields from args onto a text layer's TextDocument.
 * Handles: text, fontSize, font, fillColor, tracking, leading (switches
 * autoLeading off), justification. Returns a summary of the result.
 */
function AELL_applyTextStyle(layer, args) {
  var textProp = layer.property("ADBE Text Properties")
                      .property("ADBE Text Document");
  var doc = textProp.value;
  if (typeof args.text === "string" && args.text !== "") doc.text = args.text;
  if (args.fontSize > 0) doc.fontSize = args.fontSize;
  if (typeof args.font === "string" && args.font !== "") doc.font = args.font;
  if (AELLJSON.isArray(args.fillColor) && args.fillColor.length >= 3) {
    doc.fillColor = [args.fillColor[0], args.fillColor[1], args.fillColor[2]];
    doc.applyFill = true;
  }
  if (typeof args.tracking === "number") doc.tracking = args.tracking;
  if (typeof args.leading === "number") {
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
    summary.leading = out.autoLeading ? "auto" : out.leading;
  } catch (e2) {}
  return summary;
}

AELL_TOOLS.add_text_layer = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (typeof args.text !== "string" || args.text === "") {
    return AELL_err("'text' is required");
  }
  var layer = comp.layers.addText(args.text);
  var style = AELL_applyTextStyle(layer, {
    fontSize: args.fontSize,
    font: args.font,
    fillColor: args.fillColor,
    tracking: args.tracking,
    leading: args.leading,
    justification: args.justification
  });
  if (AELLJSON.isArray(args.position) && args.position.length >= 2) {
    layer.property("ADBE Transform Group").property("ADBE Position")
         .setValue(args.position);
  }
  return AELL_okay({ index: layer.index, name: layer.name, style: style });
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
  var layer = comp.layers.addSolid(color, args.name, w, h, 1, comp.duration);
  return AELL_okay({ index: layer.index, name: layer.name });
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

  prop.setValue(value);

  var result = { layer: layer.name, property: propName, value: value };

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
  if (oldAp.length > 2) newAp.push(oldAp[2]);   // keep z on 3D layers

  var preserve = args.preservePosition !== false;   // default true
  var note = "";

  if (preserve && !layer.threeDLayer) {
    // Shifting the anchor moves the layer by the same amount in layer
    // space; offset position by that delta run through scale+rotation so
    // the layer stays visually in place.
    var scl = transform.property("ADBE Scale").value;
    var rot = transform.property("ADBE Rotate Z").value;
    var dx = (newAp[0] - oldAp[0]) * (scl[0] / 100);
    var dy = (newAp[1] - oldAp[1]) * (scl[1] / 100);
    var rad = rot * Math.PI / 180;
    var dpx = dx * Math.cos(rad) - dy * Math.sin(rad);
    var dpy = dx * Math.sin(rad) + dy * Math.cos(rad);
    var pos = posProp.value;
    var newPos = [pos[0] + dpx, pos[1] + dpy];
    if (pos.length > 2) newPos.push(pos[2]);
    apProp.setValue(newAp);
    posProp.setValue(newPos);
    note = "anchor centered on content; position compensated so the " +
           "layer did not move";
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
  var prop = AELL_resolveProperty(layer, args.property);
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
  var prop = AELL_resolveProperty(layer, args.property);
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

AELL_TOOLS.add_null = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = comp.layers.addNull(comp.duration);
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
  var prop = AELL_resolveProperty(layer, args.property);
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

  var scale = typeof args.scale === "number" ? args.scale : 1;
  var offset = typeof args.offset === "number" ? args.offset : 0;
  var src = 'thisComp.layer("' + AELL_escapeExprName(ctrlLayer.name) +
            '").effect("' + AELL_escapeExprName(fx.name) + '")(1)';
  var arith = "";
  if (scale !== 1) arith += " * " + scale;
  if (offset !== 0) arith += " + " + offset;

  // .value everywhere a control reference is stored or embedded: the JS
  // expression engine does not auto-resolve Property objects inside vars
  // or array literals (subscripts/elements come back undefined).
  var expr;
  if (ctrlDims === 1 && targetDims === 1) {
    expr = src + ".value" + arith + ";";
  } else if (ctrlDims === 1 && targetDims > 1) {
    // Broadcast a scalar control across every target component.
    var comps = [];
    for (var i = 0; i < targetDims; i++) comps.push("c");
    expr = "var c = " + src + ".value" + arith + ";\n[" +
           comps.join(", ") + "];";
  } else if (ctrlDims === targetDims) {
    if (arith === "") {
      expr = src + ".value;";
    } else {
      var parts = [];
      for (var j = 0; j < targetDims; j++) {
        parts.push("c[" + j + "]" + arith);
      }
      expr = "var c = " + src + ".value;\n[" + parts.join(", ") + "];";
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

  // Explicit layer list wins; otherwise the user's live selection in AE.
  if (AELLJSON.isArray(args.layers) && args.layers.length > 0) {
    for (i = 0; i < args.layers.length; i++) {
      layers.push(AELL_resolveLayer(comp, args.layers[i]));
    }
  } else {
    var sel = comp.selectedLayers;
    for (i = 0; i < sel.length; i++) layers.push(sel[i]);
    if (layers.length === 0) {
      return AELL_err("No layers selected in '" + comp.name + "'. Select " +
                      "the layers in AE first, or pass {layers: [...]}.");
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
    ctrl = comp.layers.addNull(comp.duration);
    ctrl.name = ctrlName;
    ctrl.property("ADBE Transform Group").property("ADBE Position")
        .setValue([comp.width / 2, comp.height / 2]);
  }
  var effects = ctrl.property("ADBE Effect Parade");
  function ensureSlider(name, value) {
    var fx = effects.property(name);
    if (!fx) {
      fx = effects.addProperty("ADBE Slider Control");
      fx.name = name;
      fx.property(1).setValue(value);
    }
    return fx;
  }
  var defX = args.spacingX > 0 ? args.spacingX
    : Math.round(comp.width / (cols + 1));
  var defY = args.spacingY > 0 ? args.spacingY
    : Math.round(comp.height / (rows + 1));
  ensureSlider("Grid X Spacing", defX);
  ensureSlider("Grid Y Spacing", defY);

  var escCtrl = AELL_escapeExprName(ctrl.name);
  var placed = [];
  for (i = 0; i < n; i++) {
    var layer = layers[i];
    var col = i % cols;
    var row = Math.floor(i / cols);
    // Offsets are centered so the grid stays symmetric around the null.
    var cOff = col - (cols - 1) / 2;
    var rOff = row - (rows - 1) / 2;
    var posProp = layer.property("ADBE Transform Group")
                       .property("ADBE Position");
    var is3d = AELLJSON.isArray(posProp.value) && posProp.value.length > 2;
    // .value on every stored reference: AE's JavaScript expression engine
    // returns Property objects from transform/effect lookups, and
    // subscripting one (o[0]) yields undefined ("out of range array
    // subscript"). .value resolves them in both engines.
    var expr =
      'var c = thisComp.layer("' + escCtrl + '");\n' +
      'var o = c.transform.position.value;\n' +
      'var sx = c.effect("Grid X Spacing")(1).value;\n' +
      'var sy = c.effect("Grid Y Spacing")(1).value;\n' +
      '[o[0] + (' + cOff + ') * sx, o[1] + (' + rOff + ') * sy' +
      (is3d ? ', value[2]' : '') + '];';
    var err = AELL_setExpr(posProp, expr);
    if (err) {
      return AELL_err("Grid expression rejected on '" + layer.name +
                      "': " + err);
    }
    placed.push({ layer: layer.name, row: row, col: col });
  }
  return AELL_okay({
    control: ctrl.name, columns: cols, rows: rows,
    sliders: ["Grid X Spacing", "Grid Y Spacing"],
    initialSpacing: [defX, defY], placed: placed,
    note: "Move '" + ctrl.name + "' to move the whole grid; its sliders " +
          "control X/Y spacing live"
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
    // .value so the reference resolves inside function arguments too
    // (the JS expression engine does not coerce Property objects there).
    return 'thisComp.layer("' + AELL_escapeExprName(l.name) +
           '").effect("' + AELL_escapeExprName(fx.name) + '")(1).value';
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
  p.setValue(args.value);
  return AELL_okay({ layer: layer.name, effect: fx.name, param: p.name,
                     value: args.value });
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
  for (var i = 0; i < count; i++) {
    var dup = layer.duplicate();
    // Never leave two layers with the same name — duplicate names break
    // every name-based reference (expressions, later tool calls).
    var nm = AELL_uniqueLayerName(comp, base);
    if (nm !== base) autoNumbered = true;
    dup.name = nm;
    names.push(nm);
  }
  return AELL_okay({ created: count, duplicatedFrom: layer.name,
    names: (names.length > 10 ? names.slice(0, 10) : names).join(", ") +
           (names.length > 10 ? ", …" : ""),
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
  var n, chunk;
  if (args.chunks > 0) {
    // Exact piece count: the host does the division, not the model.
    n = Math.round(Number(args.chunks));
    if (n < 2) return AELL_err("'chunks' must be at least 2");
    if (n > 60) {
      return AELL_err("'chunks' is capped at 60 (asked for " + n + ")");
    }
    chunk = span / n;
  } else {
    chunk = args.chunkSeconds > 0 ? Number(args.chunkSeconds) : 5;
    if (span <= chunk) {
      return AELL_err("Layer '" + layer.name + "' is only " +
        (Math.round(span * 100) / 100) + "s from inPoint to outPoint — " +
        "nothing to split at " + chunk + "s chunks");
    }
    n = Math.ceil(span / chunk - 0.000001);
    if (n > 60) {
      return AELL_err("Would create " + n + " chunks (cap 60) — use a " +
        "larger chunkSeconds, or pass {chunks: N} for exactly N pieces");
    }
  }
  var offset = typeof args.offsetPerChunk === "number"
    ? args.offsetPerChunk : 0;

  // Duplicate FIRST (each copy inherits the full span), then trim each
  // copy to its own window. The original becomes chunk 1.
  var pieces = [layer];
  var i;
  for (i = 1; i < n; i++) pieces.push(layer.duplicate());

  var baseName = layer.name;
  for (i = 0; i < n; i++) {
    var s = inP + i * chunk;
    var e = i === n - 1 ? outP : inP + (i + 1) * chunk;
    var piece = pieces[i];
    piece.inPoint = s;
    piece.outPoint = e;
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
                inPoint: Math.round(pieces[i].inPoint * 100) / 100,
                outPoint: Math.round(pieces[i].outPoint * 100) / 100 });
  }
  var note = offset === 0
    ? "Chunks play seamlessly end-to-end on separate layers (no overlap)"
    : "Each chunk additionally slid by " + offset + "s per index";
  note += "; stacked " + (descending ? "descending" : "ascending") +
          " and now SELECTED";
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

function AELL_bezierArgs(args) {
  var b = args.bezier;
  if (b === null || typeof b === "undefined") return [0, 0, 1, 1]; // linear
  if (!AELLJSON.isArray(b) || b.length < 4) {
    throw new Error("'bezier' must be [x1, y1, x2, y2] (CSS cubic-bezier)");
  }
  return [Math.max(0, Math.min(1, Number(b[0]))), Number(b[1]),
          Math.max(0, Math.min(1, Number(b[2]))), Number(b[3])];
}

/* Resolve target layers: explicit list, else the user's selection. */
function AELL_targetLayers(comp, args) {
  var layers = [];
  var i;
  if (AELLJSON.isArray(args.layers) && args.layers.length > 0) {
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
  var order = String(args.order || "in");
  // User-facing aliases: 'ascending' assigns the earliest slot to the
  // BOTTOM layer (bars staircase upward); 'descending' to the top layer.
  if (/^asc/i.test(order)) order = "reverse";
  else if (/^desc/i.test(order)) order = "stack";
  if (order === "stack") {
    layers.sort(function (a, b) { return a.index - b.index; });
  } else if (order === "reverse") {
    layers.sort(function (a, b) { return b.index - a.index; });
  } else {   // "in": by current inPoint — natural for chunked sequences
    layers.sort(function (a, b) { return a.inPoint - b.inPoint; });
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
    if (by === "name") return L.name;
    return L.startTime;
  }
  var sorted = layers.slice(0);
  sorted.sort(function (a, b) {
    var ka = keyOf(a), kb = keyOf(b);
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });
  var descending = /^desc/i.test(String(args.order || ""));
  // Top-first sequence: ascending puts the LATEST key on top.
  var topFirst = descending ? sorted : sorted.slice(0).reverse();
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
  for (i = 0; i < topFirst.length && i < 5; i++) stacked.push(topFirst[i].name);
  return AELL_okay({ layers: layers.length, by: by,
    order: descending ? "descending" : "ascending",
    topToBottom: stacked.join(" | ") + (topFirst.length > 5 ? " | …" : ""),
    note: "Stacking changed only — start times untouched" });
};

AELL_TOOLS.stagger_layers = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var bez = AELL_bezierArgs(args);
  var layers = AELL_targetLayers(comp, args);
  // No spread declared -> fill the comp's WORK AREA (fall back to the
  // full comp duration), so bare requests need no numbers at all.
  var spread = args.spread > 0 ? Number(args.spread) : null;
  var usedWorkArea = false;
  if (spread === null) {
    if (comp.workAreaDuration > 0) {
      spread = Number(comp.workAreaDuration);
      usedWorkArea = true;
    } else if (comp.duration > 0) {
      spread = Number(comp.duration);
    } else {
      return AELL_err("'spread' (seconds) is required");
    }
  }
  var base;
  if (typeof args.startAt === "number") {
    base = args.startAt;
  } else if (usedWorkArea) {
    base = Number(comp.workAreaStart) || 0;
  } else {
    base = layers[0].startTime;
    for (var j = 1; j < layers.length; j++) {
      if (layers[j].startTime < base) base = layers[j].startTime;
    }
  }
  var n = layers.length;
  var placed = [];
  for (var i = 0; i < n; i++) {
    var t = i / (n - 1);
    var y = AELL_bezierY(bez[0], bez[1], bez[2], bez[3], t);
    layers[i].startTime = base + y * spread;
    placed.push({ layer: layers[i].name,
                  startTime: Math.round(layers[i].startTime * 1000) / 1000 });
  }
  return AELL_okay({ layers: n, spread: spread, startAt: base,
                     bezier: bez, placed: placed });
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
  var applied = [];
  for (var i = 0; i < n; i++) {
    var v;
    if (useStep) {
      v = stepStart + i * Number(args.step);
    } else {
      var y = AELL_bezierY(bez[0], bez[1], bez[2], bez[3], i / (n - 1));
      v = args.from + y * (args.to - args.from);
    }
    var prop = AELL_resolveProperty(layers[i], spec.path);
    if (spec.kind === "scalar") {
      prop.setValue(v);
    } else if (spec.kind === "uniform") {
      var cur = prop.value;
      var arr = [v, v];
      if (cur.length > 2) arr.push(cur[2]);
      prop.setValue(arr);
    } else {   // component
      var pos = prop.value;
      var out = [];
      for (var d = 0; d < pos.length; d++) out.push(pos[d]);
      out[spec.axis] = v;
      prop.setValue(out);
    }
    applied.push({ layer: layers[i].name,
                   value: Math.round(v * 100) / 100 });
  }
  return AELL_okay({ property: args.property, layers: n, applied: applied });
};

AELL_TOOLS.apply_keyframe_ease = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var prop = AELL_resolveProperty(layer, args.property);
  var bez = AELL_bezierArgs(args);
  if (prop.numKeys < 2) {
    return AELL_err("Property has " + prop.numKeys + " keyframe(s) — need " +
                    "at least 2 to ease between");
  }
  var pairs = [];
  if (args.allPairs || typeof args.keyIndex !== "number") {
    for (var p = 1; p < prop.numKeys; p++) pairs.push(p);
  } else {
    if (args.keyIndex < 1 || args.keyIndex >= prop.numKeys + 0) {
      return AELL_err("'keyIndex' must be 1.." + (prop.numKeys - 1));
    }
    pairs.push(Math.round(args.keyIndex));
  }

  // Temporal-ease dimensionality: spatial props take 1 ease, others one
  // per value dimension.
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
  return AELL_okay({ layer: layer.name, property: args.property,
                     easedPairs: pairs.length, bezier: bez });
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
  var scaled = 0, inherited = 0, i;
  for (i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    if (L.parent) { inherited++; continue; }
    try {
      AELL_mapPropValues(AELL_resolveProperty(L, "position"), function (v) {
        var out = [(v[0] - ow / 2) * s + nw / 2,
                   (v[1] - oh / 2) * s + nh / 2];
        if (v.length > 2) out.push(v[2] * s);
        return out;
      });
      var sc = null;
      try { sc = AELL_resolveProperty(L, "scale"); } catch (e1) {}
      if (sc) {
        AELL_mapPropValues(sc, function (v) {
          var out = [];
          for (var d = 0; d < v.length; d++) out.push(v[d] * s);
          return out;
        });
      }
      try {
        if (L.zoom) AELL_mapPropValues(L.zoom, function (z) { return z * s; });
      } catch (e2) {}
      scaled++;
    } catch (e3) { inherited++; }
  }
  return AELL_okay({ comp: comp.name, width: nw, height: nh,
    scaleFactor: Math.round(s * 10000) / 10000,
    layersScaled: scaled, layersInherited: inherited,
    note: "Content scaled uniformly and re-centered " +
          "(like the native Scale Composition script)" });
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
  var layer = comp.layers.addShape();
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
  var cam = comp.layers.addCamera(args.name ? String(args.name) : "Camera",
                                  center);
  var xform = cam.property("ADBE Transform Group");
  if (AELLJSON.isArray(args.position) && args.position.length >= 3) {
    xform.property("ADBE Position").setValue(args.position);
  }
  if (AELLJSON.isArray(args.pointOfInterest) &&
      args.pointOfInterest.length >= 3) {
    xform.property("ADBE Anchor Point").setValue(args.pointOfInterest);
  }
  if (args.zoom > 0) {
    cam.property("ADBE Camera Options Group")
       .property("ADBE Camera Zoom").setValue(args.zoom);
  }
  return AELL_okay({ index: cam.index, name: cam.name,
                     note: "Layers must be 3D (set_layer_3d) to be seen by a camera" });
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

AELL_TOOLS.set_layer_3d = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  layer.threeDLayer = !!args.enabled;
  return AELL_okay({ layer: layer.name, threeD: layer.threeDLayer });
};

AELL_TOOLS.set_layer_parent = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  if (args.parent === null || typeof args.parent === "undefined" ||
      args.parent === "") {
    layer.parent = null;
    return AELL_okay({ layer: layer.name, parent: null });
  }
  var parent = AELL_resolveLayer(comp, args.parent);
  if (parent.index === layer.index) {
    return AELL_err("A layer cannot be parented to itself");
  }
  layer.parent = parent;
  return AELL_okay({ layer: layer.name, parent: parent.name });
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

// Tools that modify the project get wrapped in an undo group.
var AELL_MUTATING = {
  create_comp: true, add_text_layer: true, add_solid: true,
  set_transform: true, add_keyframe: true, set_expression: true,
  apply_effect: true, set_effect_param: true, set_layer_timing: true,
  delete_layer: true, set_comp_setting: true, import_file: true,
  add_to_render_queue: true, add_shape_layer: true, add_mask: true,
  precompose: true, add_camera: true, add_marker: true,
  set_layer_3d: true, set_layer_parent: true,
  add_null: true, add_control: true, link_property: true,
  apply_expression_preset: true, set_text_style: true,
  center_anchor_point: true,
  create_folder: true, move_to_folder: true, rename_item: true,
  delete_item: true, duplicate_comp: true, organize_project: true,
  grid_layout: true, duplicate_layer: true, split_layer_into_chunks: true,
  stagger_layers: true, distribute_property: true, apply_keyframe_ease: true,
  scale_comp: true, reorder_layers: true
};

// --------------------------------------------------------------- entry point

function AELL_call(toolName, argsJson) {
  var result;
  try {
    var tool = AELL_TOOLS[toolName];
    if (!tool) {
      result = AELL_err("Unknown tool: " + toolName);
    } else {
      var args = AELLJSON.parse(argsJson);
      if (AELL_MUTATING[toolName]) {
        app.beginUndoGroup("AE Llama: " + toolName);
        try {
          result = tool(args);
        } finally {
          app.endUndoGroup();
        }
      } else {
        result = tool(args);
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
