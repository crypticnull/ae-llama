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

  // Input comes only from our own panel, so eval-based parsing is acceptable.
  function parse(s) {
    if (!s) return {};
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
    var effectName = parts[1];
    var paramName = parts.slice(2).join(".");
    var effects = layer.property("ADBE Effect Parade");
    if (!effects) throw new Error("Layer has no effects group");
    var fx = effects.property(effectName);
    if (!fx) throw new Error("Effect not found on layer: " + effectName);
    var param = fx.property(paramName);
    if (!param) throw new Error("Effect parameter not found: " + paramName);
    return param;
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

AELL_TOOLS.add_text_layer = function (args) {
  var comp = AELL_resolveComp(args.comp);
  if (typeof args.text !== "string" || args.text === "") {
    return AELL_err("'text' is required");
  }
  var layer = comp.layers.addText(args.text);
  var textProp = layer.property("ADBE Text Properties")
                      .property("ADBE Text Document");
  var doc = textProp.value;
  if (args.fontSize > 0) doc.fontSize = args.fontSize;
  if (AELLJSON.isArray(args.fillColor) && args.fillColor.length >= 3) {
    doc.fillColor = [args.fillColor[0], args.fillColor[1], args.fillColor[2]];
  }
  if (typeof args.font === "string" && args.font !== "") doc.font = args.font;
  textProp.setValue(doc);
  if (AELLJSON.isArray(args.position) && args.position.length >= 2) {
    layer.property("ADBE Transform Group").property("ADBE Position")
         .setValue(args.position);
  }
  return AELL_okay({ index: layer.index, name: layer.name });
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
  if (!AELL_TRANSFORM_MAP[args.property]) {
    return AELL_err("'property' must be one of: position, scale, rotation, " +
                    "opacity, anchorPoint");
  }
  var prop = AELL_resolveProperty(layer, args.property);
  prop.setValue(args.value);
  return AELL_okay({ layer: layer.name, property: args.property,
                     value: args.value });
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

AELL_TOOLS.set_expression = function (args) {
  var comp = AELL_resolveComp(args.comp);
  var layer = AELL_resolveLayer(comp, args.layer);
  var prop = AELL_resolveProperty(layer, args.property);
  if (!prop.canSetExpression) {
    return AELL_err("Property cannot take an expression: " + args.property);
  }
  prop.expression = typeof args.expression === "string" ? args.expression : "";
  return AELL_okay({ layer: layer.name, property: args.property,
                     expressionEnabled: prop.expressionEnabled });
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
  add_to_render_queue: true
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
