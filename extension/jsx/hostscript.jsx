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
    throw new Error("Layer not found in '" + comp.name + "': " + ref);
  }
  return layer;
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
  if (args.parent) {
    var p = AELL_resolveFolderRef(args.parent);
    if (!p) {
      return AELL_err("Parent folder not found: " + args.parent +
        ". Use a name, id, or path like '_COMPS/Promo' " +
        "(see get_project_info).");
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
  if (String(args.folder).toLowerCase() === "root") {
    folder = proj.rootFolder;
  } else {
    folder = AELL_resolveFolderRef(args.folder);
  }
  if (!folder) {
    return AELL_err("Folder not found: " + args.folder +
                    ". Create it with create_folder first (paths like " +
                    "'_COMPS/Promo' work).");
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
    layers.push({
      index: i,
      name: layer.name,
      type: AELL_layerType(layer),
      enabled: layer.enabled,
      inPoint: layer.inPoint,
      outPoint: layer.outPoint,
      startTime: layer.startTime,
      effects: AELL_effectNames(layer)
    });
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

  var expr;
  if (ctrlDims === 1 && targetDims === 1) {
    expr = src + arith + ";";
  } else if (ctrlDims === 1 && targetDims > 1) {
    // Broadcast a scalar control across every target component.
    var comps = [];
    for (var i = 0; i < targetDims; i++) comps.push("c");
    expr = "var c = " + src + arith + ";\n[" + comps.join(", ") + "];";
  } else if (ctrlDims === targetDims) {
    if (arith === "") {
      expr = src + ";";
    } else {
      var parts = [];
      for (var j = 0; j < targetDims; j++) {
        parts.push("c[" + j + "]" + arith);
      }
      expr = "var c = " + src + ";\n[" + parts.join(", ") + "];";
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
  p.setValue(args.value);
  return AELL_okay({ layer: layer.name, effect: fx.name, param: p.name,
                     value: args.value });
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
  delete_item: true, duplicate_comp: true, organize_project: true
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
