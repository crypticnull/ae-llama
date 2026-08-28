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
 *   - frontend-only nodes (MarkdownNote/Note/rgthree labels): dropped.
 *   - V3 dynamic combos: the selector consumes one widget value, then the
 *     SELECTED option's inputs expand inline as "<id>.<sub>" keys.
 *   - V3 autogrow groups: members are sockets named "<id>.<name>", never
 *     widgets, so they consume no widget positions.
 *   - control_after_generate: a frontend-only extra widget value that must
 *     be consumed or every later widget on that node shifts by one.
 *   - SUBGRAPHS: expanded inline as "<instance>:<inner>", the same node ids
 *     ComfyUI's own expansion produces.
 *   - cg-use-everywhere "Anything Everywhere": its broadcast is applied to
 *     the unconnected sockets it was standing in for.
 *
 * The manifest sidecar may carry a panelAdaptation block:
 *   "panelAdaptation": { "dropNodes": [169, 170],
 *                        "setInputs": { "474": { "filename_prefix": "..." } },
 *                        "reason": "..." }
 * Dropping a node that FED a widget input is the point: the widget's own
 * value takes effect again, which is what lets the panel inject a prompt.
 * setInputs overwrites literal widget values that are true only on the
 * machine the workflow was authored on - an absolute output path being the
 * one that actually shipped broken.
 *
 * Usage:
 *   node scripts/adapt-workflow.js <ui-workflow.json> [--out <api.json>]
 *                                  [--defs scripts/comfy-node-defs.json]
 *                                  [--manifest <sidecar.json>] [--quiet]
 */

"use strict";

var fs = require("fs");
var path = require("path");

// Nodes the ComfyUI frontend draws but the backend has never heard of. This
// is measured, not assumed: harvest-comfy-node-defs.py loads every installed
// custom-node pack and reports exactly these as absent from
// NODE_CLASS_MAPPINGS (ComfyUI 0.32.0, 2026-08-28). "Fast Groups Bypasser"
// looks load-bearing and is not: what it toggles is each node's `mode`, and
// the export already carries the modes it left behind.
var FRONTEND_ONLY = {
  MarkdownNote: true,
  Note: true,
  "Label (rgthree)": true,
  "Fast Groups Bypasser (rgthree)": true
};

// cg-use-everywhere draws no wire. "Anything Everywhere" broadcasts each of
// its inputs to every unconnected socket of the same type, and the FRONTEND
// applies that when it builds the API prompt -- so a graph converted without
// it is missing links the author is looking straight at.
var UE_CLASS = "Anything Everywhere";
// The restricted variants pick their targets with regexes, group and colour
// rules the export does not fully describe. Emulating them by guesswork would
// wire the wrong nodes silently, so they are refused.
var UE_VARIANTS = {
  "Anything Everywhere?": true,
  "Anything Everywhere3": true,
  "Prompts Everywhere": true,
  "Seed Everywhere": true
};
var UE_RESTRICTIONS = ["group_restricted", "color_restricted", "title_regex",
                       "input_regex", "group_regex", "send_to_any",
                       "string_to_combo"];

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

/** UI links come in both the array and the object shape; read either. */
function linkParts(l) {
  if (l instanceof Array) {
    return { id: l[0], origin: l[1], originSlot: l[2],
             target: l[3], targetSlot: l[4], type: l[5] };
  }
  return { id: l.id, origin: l.origin_id, originSlot: l.origin_slot,
           target: l.target_id, targetSlot: l.target_slot, type: l.type };
}

/**
 * Expand every subgraph instance inline.
 *
 * A subgraph is stored as a DEFINITION (its own nodes and links, plus a
 * boundary input node and a boundary output node) and, in the parent graph,
 * an INSTANCE node whose "type" is the definition's UUID. /prompt has never
 * heard of either -- ComfyUI expands instances before it executes, and the
 * ids it produces are "<instance>:<inner>", which is what this produces too,
 * so an adapted template can be compared against a /history prompt id for id.
 *
 * Measured on the KREA2 template (2026-08-28): the instance carries its three
 * promoted COMBO inputs as WIDGETS (`inputs: []`, three widgets_values in
 * definition-input order) while the inner loaders still hold their own copies
 * of those values. The instance's copy is the one the user edits, so it wins
 * -- hence a promoted widget is carried across as an override instead of
 * being left to whatever the inner node last stored.
 *
 * Returns the graph unchanged when there are no subgraphs, so a template
 * without one converts byte for byte the way it always did.
 */
function flattenSubgraphs(uiGraph, warn) {
  var subs = (uiGraph.definitions && uiGraph.definitions.subgraphs) || [];
  if (!subs.length) return uiGraph;
  if (!warn) warn = function () {};

  var defById = {};
  subs.forEach(function (s) { defById[String(s.id)] = s; });

  // Fresh link ids must not collide with any level's existing ones.
  var nextLink = 1;
  function noteId(id) {
    var n = Number(id);
    if (isFinite(n) && n >= nextLink) nextLink = n + 1;
  }
  (uiGraph.links || []).forEach(function (l) { noteId(linkParts(l).id); });
  subs.forEach(function (s) {
    (s.links || []).forEach(function (l) { noteId(linkParts(l).id); });
  });

  var outNodes = [];
  var outLinks = [];
  var expanded = [];

  /**
   * Emit one level. `boundary` holds this level's incoming bindings, one per
   * definition input: a resolved {kind:"src"} from the parent, a
   * {kind:"value"} promoted widget, or {kind:"none"} for a socket the parent
   * left empty. Returns the level's output sources, one per definition
   * output, in FLATTENED terms.
   */
  function processLevel(nodes, links, prefix, def, boundary, path) {
    var byId = {};
    nodes.forEach(function (n) { byId[String(n.id)] = n; });

    var linkById = {};
    (links || []).forEach(function (l) {
      var p = linkParts(l);
      linkById[String(p.id)] = p;
    });

    var inBoundary = def && def.inputNode && def.inputNode.id != null
      ? String(def.inputNode.id) : null;
    var outBoundary = def && def.outputNode && def.outputNode.id != null
      ? String(def.outputNode.id) : null;

    function absId(localId) { return prefix + localId; }
    function isInstance(node) { return !!(node && defById[String(node.type)]); }

    var instanceOutputs = {};
    var expanding = {};

    function expandInstance(node) {
      var key = String(node.id);
      if (instanceOutputs[key]) return instanceOutputs[key];
      if (expanding[key]) {
        fail("subgraph instance " + absId(key) + " contains itself (" +
             path.concat(["..."]).join(" -> ") + ")");
      }
      expanding[key] = true;

      var sub = defById[String(node.type)];
      var label = sub.name || key;
      if (node.mode === 2 || node.mode === 4) {
        fail("subgraph instance " + absId(key) + " (\"" + label + "\") is " +
             "muted or bypassed. Rewiring a whole subgraph through a bypass " +
             "is not something this converter can do faithfully - un-bypass " +
             "it in ComfyUI and export again.");
      }
      if ((sub.widgets || []).length) {
        fail("subgraph \"" + label + "\" promotes " + sub.widgets.length +
             " widget(s) that are not also inputs, a shape this converter " +
             "has never been able to measure. Queue it once in ComfyUI and " +
             "pull the executed prompt from /history instead.");
      }

      var slots = {};
      (node.inputs || []).forEach(function (s) { slots[s.name] = s; });
      var values = node.widgets_values instanceof Array
        ? node.widgets_values : [];
      var vi = 0;
      var bindings = (sub.inputs || []).map(function (inp) {
        var slot = slots[inp.name];
        if (slot && slot.link != null) {
          return sourceOfLink(slot.link) || { kind: "none" };
        }
        if (slot) return { kind: "none" };   // a socket the parent left empty
        if (vi < values.length) return { kind: "value", value: values[vi++] };
        fail("subgraph \"" + label + "\" input '" + inp.name + "' on " +
             "instance " + absId(key) + " has neither a connection nor a " +
             "stored widget value (the instance stores " + values.length +
             " value(s) for " + (sub.inputs || []).length + " input(s)).");
      });
      if (vi < values.length) {
        warn("subgraph instance " + absId(key) + ": " + (values.length - vi) +
             " trailing widget value(s) ignored.");
      }

      expanded.push(absId(key) + " (\"" + label + "\", " +
                    (sub.nodes || []).length + " nodes)");
      instanceOutputs[key] = processLevel(
        sub.nodes || [], sub.links || [], absId(key) + ":", sub, bindings,
        path.concat([label]));
      delete expanding[key];
      return instanceOutputs[key];
    }

    /** Where a link's signal comes from, in FLATTENED terms. */
    function sourceOfLink(linkId) {
      var p = linkById[String(linkId)];
      if (!p) return null;
      return sourceOfOrigin(p.origin, p.originSlot);
    }

    function sourceOfOrigin(originId, slot) {
      if (inBoundary !== null && String(originId) === inBoundary) {
        var b = boundary[slot];
        return (b && b.kind !== "none") ? b : null;
      }
      var src = byId[String(originId)];
      if (!src) return null;
      if (isInstance(src)) {
        var o = expandInstance(src)[slot];
        return o ? { kind: "src", src: o } : null;
      }
      return { kind: "src", src: [absId(originId), slot] };
    }

    nodes.forEach(function (node) {
      if (isInstance(node)) { expandInstance(node); return; }

      var copy = {};
      Object.keys(node).forEach(function (k) { copy[k] = node[k]; });
      copy.id = absId(node.id);
      copy.inputs = (node.inputs || []).map(function (slot, index) {
        var s = {};
        Object.keys(slot).forEach(function (k) { s[k] = slot[k]; });
        if (s.link == null) return s;
        var got = sourceOfLink(s.link);
        if (!got) { s.link = null; return s; }
        if (got.kind === "value") {
          if (!s.widget || !s.widget.name) {
            fail("node " + copy.id + " input '" + s.name + "' is fed by a " +
                 "promoted subgraph widget but is a socket, not a widget " +
                 "input - a value cannot stand in for a signal.");
          }
          copy.promotedWidgets = copy.promotedWidgets || {};
          copy.promotedWidgets[s.widget.name] = got.value;
          s.link = null;
          return s;
        }
        var id = nextLink++;
        outLinks.push([id, got.src[0], got.src[1], copy.id, index, s.type]);
        s.link = id;
        return s;
      });
      outNodes.push(copy);
    });

    if (!def) return [];
    var outputs = (def.outputs || []).map(function () { return null; });
    (links || []).forEach(function (l) {
      var p = linkParts(l);
      if (String(p.target) !== outBoundary) return;
      var got = sourceOfOrigin(p.origin, p.originSlot);
      if (got && got.kind === "src") outputs[p.targetSlot] = got.src;
    });
    return outputs;
  }

  processLevel(uiGraph.nodes || [], uiGraph.links || [], "", null, [], []);

  var flat = {};
  Object.keys(uiGraph).forEach(function (k) { flat[k] = uiGraph[k]; });
  flat.nodes = outNodes;
  flat.links = outLinks;
  flat.definitions = { subgraphs: [] };
  flat.expandedSubgraphs = expanded;
  return flat;
}

function adapt(uiGraph, defs, manifest, warn) {
  if (!warn) warn = function () {};
  if (!uiGraph || !(uiGraph.nodes instanceof Array)) {
    fail("not a UI-format workflow (no nodes array) - already API format?");
  }

  uiGraph = flattenSubgraphs(uiGraph, warn);
  var expandedSubgraphs = uiGraph.expandedSubgraphs || [];

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

  // The use-everywhere broadcasters, found before anything is emitted: they
  // are frontend wiring, so they never reach the API graph themselves.
  var ueNodes = {};
  uiGraph.nodes.forEach(function (n) {
    var live = n.mode !== 2 && n.mode !== 4 && !dropRequested[String(n.id)];
    if (!live) return;
    if (UE_VARIANTS[n.type]) {
      fail("node " + n.id + " is a '" + n.type + "', a use-everywhere " +
           "broadcaster whose targets depend on regex/group/colour rules the " +
           "export does not fully describe. Queue the workflow once in " +
           "ComfyUI and pull the executed prompt from /history instead.");
    }
    if (n.type === UE_CLASS) ueNodes[String(n.id)] = n;
  });

  // link id -> [srcNodeId, srcSlot]
  var linkSource = {};
  (uiGraph.links || []).forEach(function (l) {
    var p = linkParts(l);
    linkSource[String(p.id)] = [String(p.origin), p.originSlot];
  });

  function state(node) {
    if (!node) return "gone";
    if (dropRequested[String(node.id)]) return "dropped";
    if (FRONTEND_ONLY[node.type]) return "dropped";
    if (ueNodes[String(node.id)]) return "dropped";
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

  // What each broadcaster sends, by type.
  var ueByType = {};
  Object.keys(ueNodes).forEach(function (id) {
    var n = ueNodes[id];
    var props = (n.properties && n.properties.ue_properties) || {};
    UE_RESTRICTIONS.forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === 0 || v === false || v === "") {
        return;
      }
      fail("node " + id + " (" + n.type + ") restricts its broadcast with " +
           "ue_properties." + k + " = " + JSON.stringify(v) + ", and only " +
           "the unrestricted case is emulated here. Queue the workflow once " +
           "in ComfyUI and pull the executed prompt from /history instead.");
    });
    (n.inputs || []).forEach(function (slot) {
      if (slot.link == null) return;            // an empty broadcast input
      var type = String(slot.type);
      if (type === "*") {
        fail("node " + id + " broadcasts an untyped (*) input, which sends " +
             "to any socket at all - too loose to reproduce here. Queue the " +
             "workflow once in ComfyUI and use the /history prompt.");
      }
      var src = resolve(slot.link);
      if (!src) return;                         // its own upstream was removed
      if (ueByType[type]) {
        fail("two use-everywhere inputs both broadcast " + type +
             " (node " + id + "." + slot.name + "); which one a socket gets " +
             "is not decidable from the export.");
      }
      ueByType[type] = src;
    });
  });

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

    // A widget promoted to the subgraph's boundary: the instance's value is
    // the one the user edits, so it overrides the inner node's stored copy.
    if (node.promotedWidgets) {
      Object.keys(node.promotedWidgets).forEach(function (name) {
        if (!(name in flat.widgets)) {
          fail("node " + id + " (" + node.type + ") has no widget '" + name +
               "' for its subgraph to promote. Its widgets are: " +
               Object.keys(flat.widgets).join(", "));
        }
        if (inputs[name] !== node.promotedWidgets[name]) {
          rewired.push("node " + id + "." + name + ": promoted subgraph " +
                       "widget value " + JSON.stringify(node.promotedWidgets[name]) +
                       " overrides the inner node's " +
                       JSON.stringify(inputs[name]));
        }
        inputs[name] = node.promotedWidgets[name];
      });
    }

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

  // Fill the sockets the broadcaster was standing in for. Only sockets the
  // node actually DRAWS are filled: an optional input the frontend never
  // rendered has no virtual link either.
  Object.keys(api).forEach(function (id) {
    var node = byId[id];
    var target = api[id];
    var types = defs.defs[target.class_type].input_types;
    (node.inputs || []).forEach(function (slot) {
      if (slot.link != null || slot.widget) return;
      var src = ueByType[String(slot.type)];
      if (!src || (slot.name in target.inputs)) return;
      var declared = ((types.required || {})[slot.name] !== undefined) ||
                     ((types.optional || {})[slot.name] !== undefined);
      if (!declared) {
        fail("node " + id + " (" + target.class_type + ") draws a " +
             slot.type + " socket named '" + slot.name + "' that the class " +
             "does not declare, so the use-everywhere broadcast cannot be " +
             "named. Known inputs: " +
             orderedInputs(types).map(function (i) { return i.id; }).join(", "));
      }
      target.inputs[slot.name] = [src[0], src[1]];
      rewired.push("node " + id + "." + slot.name + ": wired by Anything " +
                   "Everywhere to " + src[0] + ":" + src[1]);
    });
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

  // panelAdaptation.setInputs: literal widget values the SHIPPED template
  // must not inherit from the machine it was authored on. KREA2's SaveImage
  // prefix is an ABSOLUTE C:\Users\mr\... path, and ComfyUI joins a prefix
  // onto ITS OWN output dir before checking the result is inside it
  // (folder_paths.get_save_image_path -> "Saving image outside the output
  // folder is not allowed"). On the authoring machine those two paths agree;
  // on every other machine the render dies at the last node with all of the
  // GPU time already spent. Declared here, not hand-edited into the API file,
  // so the correction survives the next regeneration.
  var setInputs = adaptation.setInputs || {};
  Object.keys(setInputs).forEach(function (id) {
    var target = api[String(id)];
    if (!target) {
      fail("manifest panelAdaptation.setInputs names node " + id +
           ", which is not in the adapted graph. It has: " +
           Object.keys(api).join(", "));
    }
    var vals = setInputs[id] || {};
    Object.keys(vals).forEach(function (name) {
      if (!(name in target.inputs)) {
        fail("manifest panelAdaptation.setInputs names input '" + name +
             "' on node " + id + " (" + target.class_type + "), which has: " +
             Object.keys(target.inputs).join(", "));
      }
      if (target.inputs[name] instanceof Array) {
        fail("manifest panelAdaptation.setInputs would overwrite node " + id +
             "." + name + ", which is a LINK from node " +
             target.inputs[name][0] + " - not a widget value. Rewiring is " +
             "the graph author's job, not the sidecar's.");
      }
      var before = target.inputs[name];
      target.inputs[name] = vals[name];
      rewired.push("node " + id + "." + name + ": set by manifest (" +
                   JSON.stringify(before) + " -> " +
                   JSON.stringify(vals[name]) + ")");
    });
  });

  return { api: api, dropped: dropped, rewired: rewired,
           expandedSubgraphs: expandedSubgraphs };
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
    res.expandedSubgraphs.forEach(function (s) {
      console.error("  expand " + s);
    });
    res.dropped.forEach(function (d) { console.error("  drop   " + d); });
    res.rewired.forEach(function (r) { console.error("  wire   " + r); });
    warnings.forEach(function (w) { console.error("  note   " + w); });
  }
}

module.exports = { adapt: adapt, flattenWidgets: flattenWidgets,
                   flattenSubgraphs: flattenSubgraphs };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error("adapt-workflow: " + e.message);
    process.exit(1);
  }
}
