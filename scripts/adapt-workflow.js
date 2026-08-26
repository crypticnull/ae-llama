#!/usr/bin/env node
/**
 * Convert a ComfyUI UI-format workflow ("Export"/"Save") into the API format
 * that POST /prompt accepts, and apply the panel's declared adaptations.
 *
 * Why this exists: the bundled templates under extension/workflows/ are UI
 * exports, and comfy.js loadWorkflow() rejects UI format outright -- so none
 * of them could be run by the panel. Re-exporting by hand in ComfyUI is the
 * usual answer, but the panel's H3 template also needs an edit no export can
 * make for us (see panelAdaptation below), and a scripted conversion is the
 * only way a test can prove the template stayed correct.
 *
 * The hard part is that the UI format stores widget values POSITIONALLY --
 * `widgets_values: ["a", 1, 2]` with no names -- and only names the widgets
 * that happen to be linked. Recovering the names needs each class's ordered
 * input list, which lives in ComfyUI's own INPUT_TYPES. That is harvested
 * once into scripts/comfy-node-defs.json (see harvest-comfy-node-defs.py),
 * so this script and its test run with no ComfyUI install.
 *
 * Handled, because a real graph contains all of them:
 *   - mode 4 (bypass): dropped, and consumers are rewired to the bypassed
 *     node's same-typed input, the way litegraph does it.
 *   - mode 2 (mute/never): dropped; consumers lose the input.
 *   - frontend-only nodes (MarkdownNote/Note): dropped.
 *   - V3 dynamic combos: the selector consumes one widget value, then the
 *     SELECTED option's inputs expand inline as "<id>.<sub>" keys.
 *   - V3 autogrow groups: members are sockets named "<id>.<name>", never
 *     widgets, so they consume no widget positions.
 *   - control_after_generate: a frontend-only extra widget value that must
 *     be consumed or every later widget on that node shifts by one.
 *
 * The manifest sidecar may carry a panelAdaptation block:
 *   "panelAdaptation": { "dropNodes": [169, 170], "reason": "..." }
 * Dropping a node that FED a widget input is the point: the widget's own
 * value takes effect again, which is what lets the panel inject a prompt.
 *
 * Usage:
 *   node scripts/adapt-workflow.js <ui-workflow.json> [--out <api.json>]
 *                                  [--defs scripts/comfy-node-defs.json]
 *                                  [--manifest <sidecar.json>] [--quiet]
 */

"use strict";

var fs = require("fs");
var path = require("path");

// Nodes the ComfyUI frontend draws but the backend has never heard of.
var FRONTEND_ONLY = { MarkdownNote: true, Note: true };

var WIDGET_TYPES = {
  INT: true, FLOAT: true, STRING: true, BOOLEAN: true, COMBO: true
};

var AUTOGROW = "COMFY_AUTOGROW_V3";
var DYNAMIC_COMBO = "COMFY_DYNAMICCOMBO_V3";

function fail(msg) {
  var e = new Error(msg);
  e.adaptFailure = true;
  throw e;
}

/** required-then-optional, in declaration order (JSON preserves key order). */
function orderedInputs(inputTypes) {
  var out = [];
  ["required", "optional"].forEach(function (section) {
    var bag = inputTypes[section];
    if (!bag) return;
    Object.keys(bag).forEach(function (id) {
      out.push({ id: id, spec: bag[id], section: section });
    });
  });
  return out;
}

function specType(spec) {
  if (spec instanceof Array) {
    // old-style: [<type or option list>, {opts}]
    return spec[0] instanceof Array ? "COMBO" : String(spec[0]);
  }
  return String(spec);
}

function specOpts(spec) {
  return (spec instanceof Array && spec[1] && typeof spec[1] === "object")
    ? spec[1] : {};
}

/**
 * Walk a class's inputs the way the frontend lays widgets out, pulling values
 * off widgets_values as it goes. Returns {widgets: {name: value}, sockets:
 * [names], consumed: n} where names are already dot-prefixed for dynamic
 * groups. Reading the SELECTED dynamic-combo option needs the value we just
 * consumed, which is why this is one pass and not two.
 */
function flattenWidgets(inputTypes, values, classType) {
  var widgets = {};
  var sockets = [];
  var i = 0;

  function walk(inputs, prefix) {
    inputs.forEach(function (inp) {
      var id = prefix ? prefix + "." + inp.id : inp.id;
      var type = specType(inp.spec);
      var opts = specOpts(inp.spec);

      if (type === AUTOGROW) {
        // Members are force_input sockets: "values.a", "values.b", ...
        var tpl = (opts.template || {});
        var names = tpl.names;
        if (!names && typeof tpl.prefix === "string") {
          names = [];
          for (var n = 0; n < (tpl.max || 0); n++) names.push(tpl.prefix + n);
        }
        (names || []).forEach(function (nm) { sockets.push(id + "." + nm); });
        return;
      }

      if (type === DYNAMIC_COMBO) {
        var key = values[i++];
        widgets[id] = key;
        var chosen = null;
        (opts.options || []).forEach(function (o) {
          if (o.key === key) chosen = o;
        });
        if (!chosen) {
          fail(classType + ": dynamic combo '" + id + "' is set to " +
               JSON.stringify(key) + ", which is not one of [" +
               (opts.options || []).map(function (o) { return o.key; })
                 .join(", ") + "]");
        }
        walk(orderedInputs(chosen.inputs || {}), id);
        return;
      }

      if (WIDGET_TYPES[type] && !opts.forceInput) {
        widgets[id] = values[i++];
        // The frontend bolts a control widget on right after the value one.
        if (opts.control_after_generate) i++;
        return;
      }

      sockets.push(id);
    });
  }

  walk(orderedInputs(inputTypes), "");
  return { widgets: widgets, sockets: sockets, consumed: i };
}

function adapt(uiGraph, defs, manifest, warn) {
  if (!warn) warn = function () {};
  if (!uiGraph || !(uiGraph.nodes instanceof Array)) {
    fail("not a UI-format workflow (no nodes array) - already API format?");
  }

  // Subgraphs are stored as a definition plus nodes whose "type" is the
  // definition's UUID; flattening them faithfully is a second job. Refuse
  // rather than emit a graph with an unresolvable class_type in it.
  var subgraphs = (uiGraph.definitions && uiGraph.definitions.subgraphs) || [];
  if (subgraphs.length) {
    fail("this workflow uses " + subgraphs.length + " subgraph(s) (" +
         subgraphs.map(function (s) { return s.name || s.id; }).join(", ") +
         ") and this converter does not flatten them. Queue it once in " +
         "ComfyUI and pull the executed prompt from /history instead - that " +
         "comes back already flattened.");
  }

  var adaptation = (manifest && manifest.panelAdaptation) || {};
  var dropRequested = {};
  (adaptation.dropNodes || []).forEach(function (id) {
    dropRequested[String(id)] = true;
  });

  var byId = {};
  uiGraph.nodes.forEach(function (n) { byId[String(n.id)] = n; });

  Object.keys(dropRequested).forEach(function (id) {
    if (!byId[id]) {
      fail("manifest panelAdaptation.dropNodes lists node " + id +
           ", which this workflow does not have. It has: " +
           Object.keys(byId).join(", "));
    }
  });

  // link id -> [srcNodeId, srcSlot]
  var linkSource = {};
  (uiGraph.links || []).forEach(function (l) {
    linkSource[String(l[0])] = [String(l[1]), l[2]];
  });

  function state(node) {
    if (!node) return "gone";
    if (dropRequested[String(node.id)]) return "dropped";
    if (FRONTEND_ONLY[node.type]) return "dropped";
    if (node.mode === 2) return "dropped";      // mute / never
    if (node.mode === 4) return "bypassed";
    return "live";
  }

  /** Follow a link to a live producer, stepping through bypassed nodes. */
  function resolve(linkId, seen) {
    var src = linkSource[String(linkId)];
    if (!src) return null;
    var node = byId[src[0]];
    var st = state(node);
    if (st === "live") return src;
    if (st !== "bypassed") return null;

    seen = seen || {};
    if (seen[src[0]]) return null;              // a bypass loop resolves to nothing
    seen[src[0]] = true;

    var outs = node.outputs || [];
    var wantType = outs[src[1]] ? outs[src[1]].type : null;
    var ins = node.inputs || [];
    for (var k = 0; k < ins.length; k++) {
      var it = ins[k];
      if (it.widget) continue;                  // a widget slot carries no signal
      if (wantType && it.type !== wantType && it.type !== "*" &&
          wantType !== "*") continue;
      if (it.link == null) continue;
      return resolve(it.link, seen);
    }
    return null;
  }

  var api = {};
  var dropped = [];
  var rewired = [];

  uiGraph.nodes.forEach(function (node) {
    var id = String(node.id);
    var st = state(node);
    if (st !== "live") {
      dropped.push(id + " (" + node.type + ", " + st + ")");
      return;
    }

    var def = defs.defs[node.type];
    if (!def) {
      fail("no harvested definition for node type '" + node.type + "' (node " +
           id + "). Re-run scripts/harvest-comfy-node-defs.py against a " +
           "ComfyUI that has it. Known types: " +
           Object.keys(defs.defs).sort().join(", "));
    }

    var values = node.widgets_values instanceof Array
      ? node.widgets_values : [];
    var flat = flattenWidgets(def.input_types, values, node.type);

    if (flat.consumed > values.length) {
      fail(node.type + " (node " + id + ") needs " + flat.consumed +
           " widget values but the workflow stores " + values.length +
           ". The harvested definitions are out of step with this export.");
    }
    if (flat.consumed < values.length) {
      // Frontend-only extras (upload buttons, collapsed helpers) sit after
      // the real ones, so this is a note, not a fault.
      warn(node.type + " (node " + id + "): " +
           (values.length - flat.consumed) + " trailing widget value(s) " +
           "ignored - frontend-only widgets.");
    }

    var inputs = {};
    Object.keys(flat.widgets).forEach(function (name) {
      inputs[name] = flat.widgets[name];
    });

    (node.inputs || []).forEach(function (slot) {
      var name = slot.widget ? slot.widget.name : slot.name;
      if (slot.link == null) return;   // widget keeps its value / socket idle
      var origin = linkSource[String(slot.link)];
      var src = resolve(slot.link);
      if (!src) {
        if (slot.widget) {
          rewired.push("node " + id + "." + name +
                       ": upstream removed, widget value used");
        } else {
          rewired.push("node " + id + "." + name + ": upstream removed, " +
                       "input left unconnected");
        }
        return;
      }
      if (!origin || String(src[0]) !== String(origin[0])) {
        rewired.push("node " + id + "." + name + ": rewired past bypass to " +
                     src[0] + ":" + src[1]);
      }
      inputs[name] = [src[0], src[1]];
    });

    api[id] = {
      inputs: inputs,
      class_type: node.type,
      _meta: { title: node.title || node.type }
    };
  });

  // A required socket left unconnected fails at queue time with a server-side
  // error the user cannot act on; say it here instead.
  Object.keys(api).forEach(function (id) {
    var node = api[id];
    var required = (defs.defs[node.class_type].input_types.required) || {};
    Object.keys(required).forEach(function (name) {
      var type = specType(required[name]);
      if (type === AUTOGROW || type === DYNAMIC_COMBO) return;
      if (WIDGET_TYPES[type]) return;
      if (!(name in node.inputs)) {
        fail("node " + id + " (" + node.class_type + ") is missing required " +
             "input '" + name + "' after adaptation - something it depended " +
             "on was dropped.");
      }
    });
  });

  return { api: api, dropped: dropped, rewired: rewired };
}

function main(argv) {
  var src = null, out = null, quiet = false;
  var defsFile = path.join(__dirname, "comfy-node-defs.json");
  var manifestFile = null;

  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "--defs") defsFile = argv[++i];
    else if (a === "--manifest") manifestFile = argv[++i];
    else if (a === "--quiet") quiet = true;
    else if (a.charAt(0) === "-") fail("unknown option " + a);
    else src = a;
  }
  if (!src) {
    console.error("usage: node scripts/adapt-workflow.js <ui-workflow.json> " +
                  "[--out api.json] [--defs f] [--manifest f] [--quiet]");
    process.exit(2);
  }
  if (!manifestFile) manifestFile = src.replace(/\.json$/i, ".manifest.json");

  var ui = JSON.parse(fs.readFileSync(src, "utf8"));
  var defs = JSON.parse(fs.readFileSync(defsFile, "utf8"));
  var manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); }
  catch (e) { manifest = null; }

  var warnings = [];
  var res = adapt(ui, defs, manifest, function (m) { warnings.push(m); });

  if (out) {
    fs.writeFileSync(out, JSON.stringify(res.api, null, 1) + "\n");
  } else {
    process.stdout.write(JSON.stringify(res.api, null, 1) + "\n");
  }
  if (!quiet) {
    console.error("nodes: " + Object.keys(res.api).length + " kept, " +
                  res.dropped.length + " dropped");
    res.dropped.forEach(function (d) { console.error("  drop   " + d); });
    res.rewired.forEach(function (r) { console.error("  wire   " + r); });
    warnings.forEach(function (w) { console.error("  note   " + w); });
  }
}

module.exports = { adapt: adapt, flattenWidgets: flattenWidgets };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error("adapt-workflow: " + e.message);
    process.exit(1);
  }
}
