// Regression test: the in-panel self-test suite — every step must target
// a real tool with well-formed args, the runner must sequence to
// completion, and failures must surface in the report.
"use strict";
const fs = require("fs");
const path = require("path");

const window = { setTimeout, clearTimeout };
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                "selftest.js"), "utf8"));
const SelfTest = window.SelfTest;

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// 1. every step references a tool that actually exists in TOOL_DEFS
const toolsSrc = fs.readFileSync(path.join(__dirname, "..", "extension",
                                            "js", "tools.js"), "utf8");
const steps = SelfTest._buildSteps();
assert(steps.length >= 20, "suite has " + steps.length + " steps (>= 20)");
function documented(name) {
  return toolsSrc.includes('name: "' + name + '"');
}
// A {batch: [...]} step has no single .tool -- it names one per command,
// and a deliberately bogus one is part of what it measures.
function stepTools(s) {
  if (!s.batch) return [s.tool];
  const cmds = typeof s.batch === "function" ? s.batch({ unComp: "C" })
                                             : s.batch;
  return cmds.map(c => c.tool).filter(t => t !== "not_a_real_tool");
}
let unknown = [];
for (const s of steps) {
  for (const t of stepTools(s)) if (!documented(t)) unknown.push(t);
}
assert(steps.filter(s => s.batch).length >= 2,
       "the suite exercises the multi-tool batch call");
assert(unknown.length === 0,
       "every step targets a documented tool" +
       (unknown.length ? " (unknown: " + unknown.join(", ") + ")" : ""));
const names = new Set(steps.map(s => s.name));
assert(names.size === steps.length, "step names are unique");

const hostSrc = fs.readFileSync(path.join(__dirname, "..", "extension",
                                          "jsx", "hostscript.jsx"), "utf8");

// get_comp_details / get_project_info cap their model-facing lists, and a
// stub that answered with the full list would let a suite step "pass"
// while checking rows real AE never sent. The cap number itself is read
// out of hostscript.jsx rather than copied, so the two cannot drift.
const LIST_LIMIT = Number(
  (/var AELL_LIST_LIMIT = (\d+);/.exec(hostSrc) || [])[1]);
assert(LIST_LIMIT > 0, "hostscript publishes a list cap (" + LIST_LIMIT + ")");

function listLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return LIST_LIMIT;
  if (raw === 0 || raw === "0" || raw === "all") return -1;
  const n = Math.round(Number(raw));
  return n > 0 ? n : LIST_LIMIT;
}

/** Window a full layer list the way the host does. */
function capLayers(compName, all, args) {
  const total = all.length;
  const limit = listLimit(args && args.limit);
  let start = (args && args.start > 0) ? Math.round(args.start) : 1;
  if (start > total) start = total > 0 ? total : 1;
  const last = limit < 0 ? total : Math.min(total, start + limit - 1);
  const wanted = [];
  for (const l of all) {                       // selected layers win slots
    if (l.selected && (limit < 0 || wanted.length < limit)) wanted.push(l);
  }
  for (let i = start; i <= last; i++) {
    if (limit >= 0 && wanted.length >= limit) break;
    const l = all[i - 1];
    if (l && wanted.indexOf(l) < 0) wanted.push(l);
  }
  wanted.sort((a, b) => a.index - b.index);
  const out = { name: compName, numLayers: total,
                layersShown: wanted.length, layers: wanted };
  if (wanted.length < total) {
    out.note = "Showing " + wanted.length + " of " + total +
      " layers (indexes " + start + "-" + last + "). Ask again with start:" +
      (last + 1) + " for the next " + limit + ", or limit:0 for all.";
  }
  return out;
}

// canned happy-path results per tool
let createCount = 0;
const createdComps = [];
let camProbeReads = 0;
let textStyle = null;
// The ordering steps read back what the previous step wrote, so the canned
// host has to REMEMBER instead of answering with a constant — otherwise
// "did slot i go to layer i" is a question the stub answers for free.
let ordX = {};
let ordStack = [];
// The mask rig reads back what it just wrote (numKeys after a refusal),
// so the canned host has to remember how many keys each mask carries.
let maskKeys = {};
// The batch rig checks that for_each_layer really touched all 60 layers
// and that the tools it must refuse changed nothing, so the canned host
// tracks which layers carry the blur, what value it holds, and whether a
// refused comp-level tool leaked new project items.
let batchLayers = 0;
let batchFx = {};
let batchBlur = null;

// Expression-driven properties, the way real AE behaves: a write is
// ACCEPTED and then invisible, because `.value` is the expression's
// answer. `driven[layer/prop]` is what the comp shows; "passthru" models
// an expression that consumes the written value (`value + wiggle(…)`) and
// so really does move. A stub that just remembered the last write would
// let the tools claim a spread that is not in the comp — which is the bug
// the field found.
let driven = {};
// The nine squares grid_layout rigs in the suite (it is called with a
// column count, not a layer list).
const SQUARES = ["ST Square"];
for (let i = 2; i <= 9; i++) SQUARES.push("ST Square " + i);
const drivenKey = (layer, prop) => layer + "/" + String(prop || "")
  .replace(/^position_[xy]$/, "position").toLowerCase();
function markDriven(layer, prop, shows) { driven[drivenKey(layer, prop)] = shows; }
function drivenShows(layer, prop) {
  const v = driven[drivenKey(layer, prop)];
  return (typeof v === "undefined" || v === "passthru") ? null : v;
}

// The batch-call rig asks whether commands after a FAILING one still ran,
// so the canned host has to know which layers exist in that comp -- a stub
// that accepted any layer name would answer the question for free.
let batSolids = [];
let batSolidFx = {};
let batSolidPos = {};
const inBatComp = a => !!(a && /Undo/.test(a.comp || ""));

// for_each_layer's whole job is deciding which tools it may drive. Rather
// than paraphrasing that rule here — which would let the suite expect a
// refusal for a tool the host happily drives — read the host's own three
// lists straight out of hostscript.jsx.
function hostList(name) {
  const m = new RegExp("var\\s+" + name + "\\s*=\\s*\\[([\\s\\S]*?)\\];")
    .exec(hostSrc);
  if (!m) throw new Error("hostscript.jsx no longer defines " + name);
  return (m[1].match(/"([A-Za-z0-9_]+)"/g) || [])
    .map(s => s.replace(/"/g, ""));
}
const PER_LAYER_TOOLS = hostList("AELL_PER_LAYER_LIST");
const READ_TOOLS = hostList("AELL_PER_LAYER_READ_LIST");
const BATCHED_TOOLS = hostList("AELL_ALREADY_BATCHED_LIST");
function cannedOk(tool, args) {
  switch (tool) {
    case "create_comp":
      createCount++;
      // Remember every comp, so get_project_info can answer with the
      // project this run actually built instead of a hard-coded list that
      // would drift the moment a step creates a differently-named comp.
      createdComps.push(createCount === 1 ? "AELL Self-Test"
        : createCount === 2 ? "AELL Self-Test 2"
        : ((args && args.name) || "AELL Self-Test 3"));
      // 1st = the scratch comp, 2nd = the deliberate name collision that
      // must auto-number, 3rd+ = whatever was asked for (the camera comp).
      if (createCount === 1) return { name: "AELL Self-Test", id: 1 };
      if (createCount === 2) return { name: "AELL Self-Test 2", id: 2 };
      return { name: (args && args.name) || "AELL Self-Test 3",
               id: createCount };
    case "duplicate_layer": {
      const n = (args && args.count) || 8;
      if (args && args.layer === "ST Batch") batchLayers = n + 1;
      return { created: n, totalLayersInComp: n + 1 };
    }
    case "for_each_layer": {
      const t = (args && args.tool) || "";
      const drivable = "Drivable tools: " + PER_LAYER_TOOLS.join(", ") + ".";
      if (BATCHED_TOOLS.indexOf(t) !== -1) {
        return { __err: "'" + t + "' already takes its own {layers} list " +
          "— call it ONCE with every layer instead of once per layer. " +
          drivable };
      }
      if (READ_TOOLS.indexOf(t) !== -1) {
        return { __err: "'" + t + "' READS a value, and for_each_layer " +
          "reports only counts — every value it returned would be " +
          "discarded. " + drivable };
      }
      if (PER_LAYER_TOOLS.indexOf(t) === -1) {
        // Refused, so it never runs and the project never grows. In REAL
        // AE the "and NO junk comps were created" step is a measurement;
        // here it checks that a refusal really is inert.
        return { __err: "'" + t + "' has no per-layer target, so running " +
          "it once per layer would just repeat the same comp- or " +
          "project-level action N times and report it as success. " +
          drivable };
      }
      const L = ((args && args.layers) || []).slice();
      const sub = (args && args.args) || {};
      if (t === "apply_effect") {
        L.forEach(nm => { batchFx[nm] = sub.effect; });
        return { tool: t, layers: L.length, succeeded: L.length,
                 failures: "" };
      }
      if (t === "set_effect_param") {
        // Only layers that really carry the effect can take the param —
        // that is what makes "reaches all 60" mean anything.
        const hit = L.filter(nm => batchFx[nm] === sub.effect);
        if (hit.length) batchBlur = sub.value;
        return { tool: t, layers: L.length, succeeded: hit.length,
                 failures: hit.length === L.length ? ""
                   : (L.length - hit.length) + " layers lack " + sub.effect };
      }
      return { tool: t, layers: L.length, succeeded: L.length,
               failures: "" };
    }
    case "get_project_info": {
      // A scratch project the size of the real one: a few comps drowning
      // in accumulated solid footage. Comps come first out of the cap.
      const items = createdComps.map((nm, i) => ({ name: nm, id: i + 1,
                                                   type: "comp" }));
      for (let i = 1; i <= 400; i++) {
        items.push({ name: "Blue Solid " + i, id: 100 + i, type: "footage" });
      }
      const limit = listLimit(args && args.limit);
      const total = items.length;
      let shown = items;
      if (limit >= 0 && total > limit) shown = items.slice(0, limit);
      const out = { numItems: total, itemsShown: shown.length,
                    items: shown,
                    activeComp: createdComps[createdComps.length - 1] || null };
      if (shown.length < total) {
        out.note = "Showing " + shown.length + " of " + total +
          " items (comps and folders first). " + (total - shown.length) +
          " footage items not listed — ask again with limit:0.";
      }
      return out;
    }
    case "distribute_property": {
      const L = (args && args.layers) || [];
      const from = (args && typeof args.from === "number") ? args.from : 0;
      const step = (args && typeof args.step === "number") ? args.step : 0;
      const applied = [], overridden = [];
      L.forEach((nm, i) => {
        // A layer whose property is driven does not move, however happily
        // AE accepted the write -- so it cannot be reported as applied.
        if (drivenShows(nm, args && args.property) !== null) {
          overridden.push(nm);
          return;
        }
        applied.push({ layer: nm, value: from + i * step });
      });
      for (const a of applied) ordX[a.layer] = a.value;
      const out = { property: args && args.property, layers: L.length,
                    applied };
      if (overridden.length) {
        out.overriddenByExpression = overridden;
        out.note = overridden.length + " of " + L.length + " layer(s) did " +
          "NOT move because an expression drives " +
          (args && args.property) + " on them: clear it first " +
          "(set_expression with expression: \"\").";
      }
      return out;
    }
    case "reorder_layers": {
      const L = ((args && args.layers) || []).slice();
      if (args && args.by === "name") {
        // Faithful to the fix: the trailing number sorts as a NUMBER, so
        // "ST Ord 2" comes before "ST Ord 10". A stub that string-sorted
        // here would let a string-sorting host pass.
        L.sort((a, b) => {
          const na = parseInt((/(\d+)\s*$/.exec(a) || [0, "1"])[1], 10);
          const nb = parseInt((/(\d+)\s*$/.exec(b) || [0, "1"])[1], 10);
          return na - nb;
        });
      }
      if (!(args && /^desc/i.test(args.order || ""))) L.reverse();
      ordStack = L;
      return { layers: L.length, by: (args && args.by) || "startTime",
               order: (args && /^desc/i.test(args.order || ""))
                 ? "descending" : "ascending",
               topToBottom: L.join(" | "), slots: "1.." + L.length,
               note: "Stacking changed only" };
    }
    case "get_comp_details": {
      if (inBatComp(args)) {
        return capLayers(args.comp, batSolids.map((nm, i) => ({
          index: i + 1, name: nm,
          effects: batSolidFx[nm] ? [batSolidFx[nm]] : [] })), args);
      }
      if (args && /Batch/.test(args.comp || "")) {
        const ls = [];
        for (let i = 1; i <= batchLayers; i++) {
          const nm = i === 1 ? "ST Batch" : "ST Batch " + i;
          ls.push({ index: i, name: nm,
                    effects: batchFx[nm] ? [batchFx[nm]] : [] });
        }
        return capLayers(args.comp, ls, args);
      }
      return capLayers(args && args.comp,
        ordStack.map((nm, i) => ({ index: i + 1, name: nm })), args);
    }
    case "grid_layout":
      // The rig it builds DRIVES Position and ignores whatever value sits
      // underneath — every later write to those layers is swallowed.
      (((args && args.layers) || SQUARES)).forEach((nm, i) =>
        markDriven(nm, "position", [320 + (i % 3) * 320, 180, 0]));
      return { sliders: ["Grid X Spacing", "Grid Y Spacing",
                         "Grid Columns"] };
    case "link_property":
      // Same shape: the linked property now reads from the slider.
      markDriven(args && args.layer, args && args.property, 22.2);
      return { layer: args && args.layer,
               property: args && args.property };
    case "get_property":
      // The batch rig reads back the write that came AFTER a failing
      // command. Padded to three components, the way real AE answers.
      if (inBatComp(args) && batSolidPos[args.layer]) {
        const bp = batSolidPos[args.layer];
        return { value: [bp[0], bp[1], 0] };
      }
      // Position on a 2D layer: the scripting API pads the value to 3
      // components ([x, y, 0]) even though the expression engine sees
      // 2 — model that faithfully, and give the two grid squares
      // different cells so the "distinct cells" step is real.
      if (args && /^ST Ord/.test((args && args.layer) || "")) {
        return { value: [ordX[args.layer], 300, 0] };
      }
      // Read back what for_each_layer wrote through set_effect_param.
      if (args && /Blurriness/.test(args.property || "")) {
        return { value: batchBlur };
      }
      if (args && args.property === "Zoom") { return { value: 500 }; }
      if (args && args.property === "Point of Interest") {
        return args.layer === "ST Cam One"
          ? { value: [400, 300, 0] }    // no aim point; left alone
          : { value: [200, 150, 0] };   // re-centred with the comp
      }
      if (args && args.property === "Scale") {
        // Halved with the comp: [100,100] -> [50,50], [200,50] -> [100,25].
        return { keys: [{ time: 0, value: [50, 50, 100] },
                        { time: 2, value: [100, 25, 100] }] };
      }
      if (args && args.property === "Position") {
        // The mask probes read maskPath.points(t) BETWEEN two keys: 150
        // is halfway from 100 to 200, and 280 is frame 10 of keys that
        // sit on frames 8 and 18. Both are values a held or popped path
        // can never produce.
        if (args.layer === "ST Mask Probe") return { value: [150, 0, 0] };
        if (args.layer === "ST Off Probe") return { value: [280, 0, 0] };
        // The eased-motion probe reads the SAME point before and after
        // the resize, so a correct scale_comp halves it exactly.
        if (args.layer === "ST Cam Probe") {
          camProbeReads++;
          return camProbeReads === 1 ? { value: [520, 300, 0] }
                                     : { value: [260, 150, 0] };
        }
        if (args.layer === "ST Cam Ease") {
          return { keys: [{ time: 0, value: [50, 150, 0] },
                          { time: 2, value: [350, 150, 0] }] };
        }
        if (args.layer === "ST Cam Kid") return { value: [400, 300, -800] };
        // The anchor probes measure the SAME layer origin before and
        // after center_anchor_point, so a correct tool leaves these
        // readings identical — hence one fixed value per probe.
        if (args.layer === "ST AP Probe 0") return { value: [420.5, 311.25, 0] };
        if (args.layer === "ST AP Probe 2") return { value: [588.75, 402.5, 0] };
        return args.layer === "ST Square 2"
          ? { value: [640, 180, 0], expression: "// grid rig" }
          : { value: [320, 180, 0], expression: "// grid rig" };
      }
      return { value: 3 };
    case "set_keyframes":
      // 9 layers x 2 keys for the batch step; one layer x its own keys
      // for the single-layer ones.
      return { keysSet: (args && args.layer && args.keys)
        ? args.keys.length : 18 };
    case "add_null":
      return { index: 1, name: (args && args.name) || "Null 1" };
    case "set_expression": {
      const expr = (args && args.expression) || "";
      if (expr === "") {
        delete driven[drivenKey(args && args.layer, args && args.property)];
        return { layer: args && args.layer, property: args && args.property,
                 expression: "cleared" };
      }
      // An expression that reads the property's own value passes writes
      // through; anything else computes the property from scratch and
      // swallows them.
      markDriven(args && args.layer, args && args.property,
                 /\bvalue\b/.test(expr) ? "passthru" : 999);
      return { expressionEnabled: true, expression: expr };
    }
    case "center_anchor_point":
      return { layer: (args && args.layer) || "Anchor",
               oldAnchor: [0, 0, 0], newAnchor: [113.07, -35.33, 0],
               note: "anchor centered on content; all 2 Position " +
                     "keyframes offset so the layer did not move (NOTE: " +
                     "Scale/Rotation are animated too, so the offset is " +
                     "exact at the Position keyframes and approximate " +
                     "between them)" };
    case "apply_keyframe_ease":
      // The camera-comp steps ease ONE pair; the batch step eases nine.
      return { easedPairs: (args && args.layer) ? 1 : 9 };
    case "stagger_layers": return { layers: 9 };
    case "add_mask":
      return { layer: args && args.layer,
               mask: (args && args.name) || "Mask 1",
               shape: (args && args.shape) || "rectangle" };
    case "set_mask_path": {
      // Faithful to the host's rules, not to its happy path: keys that
      // disagree on point count and key times that collide on a frame
      // must be REFUSED here too, or a host that accepted them again
      // would sail through this suite.
      const fd = 1 / 25;            // the mask scratch comp runs at 25 fps
      const id = ((args && args.layer) || "") + "/" + ((args && args.mask) || "");
      const keys = (args && args.keys) || [];
      if (keys.length) {
        const counts = keys.map(k => (k.vertices || []).length);
        if (counts.some(c => c !== counts[0])) {
          const odd = counts.findIndex(c => c !== counts[0]);
          return { __err: "Mask path keys must all have the same number " +
            "of points: keys[" + odd + "] has " + counts[odd] + " but " +
            "keys[0] has " + counts[0] + ". After Effects cannot " +
            "interpolate between paths with different point counts, so " +
            "the mask would POP instead of animating, and AE raises a " +
            "modal warning that blocks the whole application. Give every " +
            "key " + counts[0] + " points (repeat a vertex to pad a " +
            "simpler shape)." };
        }
        const times = keys.map(k => Math.round(k.time / fd) * fd);
        const frames = times.map(t => Math.round(t / fd));
        for (let i = 0; i < frames.length; i++) {
          for (let j = i + 1; j < frames.length; j++) {
            if (frames[i] === frames[j]) {
              return { __err: "keys[" + i + "] (" + keys[i].time + "s) and " +
                "keys[" + j + "] (" + keys[j].time + "s) both land on the " +
                "same frame -- the later one would silently overwrite the " +
                "earlier. Put them on different frames." };
            }
          }
        }
        let snapped = 0;
        keys.forEach((k, i) => {
          if (Math.abs(times[i] - k.time) > 1e-9) snapped++;
        });
        maskKeys[id] = keys.length;
        const out = { keysSet: keys.length, numKeys: keys.length,
          points: counts[0], keyFrames: frames,
          keyTimes: times.map(t => Math.round(t * 10000) / 10000),
          note: "Mask path animated" };
        if (snapped) out.snappedToFrames = snapped;
        return out;
      }
      if (args && typeof args.atTime === "number") {
        maskKeys[id] = (maskKeys[id] || 0) + 1;
        const at = Math.round(args.atTime / fd) * fd;
        return { keyframed: true, numKeys: maskKeys[id],
                 time: Math.round(at * 10000) / 10000,
                 frame: Math.round(at / fd),
                 points: ((args && args.vertices) || []).length };
      }
      if (maskKeys[id]) {
        return { __err: "Mask '" + (args && args.mask) + "' is already " +
          "animated (" + maskKeys[id] + " keyframes) -- pass 'atTime' to " +
          "add a keyframe, 'keys' to rewrite the animation, or clear it " +
          "first with remove_keyframes." };
      }
      return { points: ((args && args.vertices) || []).length };
    }
    case "add_shape_content": return { params: "End" };
    case "set_track_matte": return { mode: "alpha" };
    case "set_layer_parent": return { parented: "ST Square 5" };
    case "scale_comp":
      // layersSkipped absent = nothing refused the write. That is the
      // assertion the camera regression would have tripped.
      return { scaleFactor: 0.5, layersScaled: 6, layersInherited: 1,
               parentedCamerasRezoomed: ["ST Cam Kid"] };
    case "add_solid":
      if (inBatComp(args)) batSolids.push(args.name);
      return { name: (args && args.name) || "ST Square" };
    case "apply_effect":
      if (inBatComp(args)) {
        if (batSolids.indexOf(args.layer) === -1) {
          return { __err: "No layer '" + args.layer + "' in '" +
            args.comp + "' -- it holds: " + batSolids.join(", ") };
        }
        batSolidFx[args.layer] = args.effect;
        return { layer: args.layer, effect: args.effect };
      }
      return { done: true };
    case "set_transform": {
      const shows = drivenShows(args && args.layer, args && args.property);
      if (shows !== null) {
        // Accepted and invisible: the honest answer names the value that
        // is really in the comp.
        return { layer: args.layer, property: args.property,
                 value: args.value, applied: false,
                 warning: "'" + args.property + "' is driven by an " +
                   "expression that ignores written values -- the comp " +
                   "still shows " + JSON.stringify(shows) + ", not " +
                   JSON.stringify(args.value) + ". Clear it first " +
                   "(set_expression with expression: \"\")." };
      }
      if (inBatComp(args)) {
        if (batSolids.indexOf(args.layer) === -1) {
          return { __err: "No layer '" + args.layer + "' in '" +
            args.comp + "' -- it holds: " + batSolids.join(", ") };
        }
        // AE takes {property, value} here, NOT {position: [...]}. The stub
        // used to accept either, so a malformed step passed CI and only
        // failed in real AE -- which is exactly what happened.
        const OK = ["position", "scale", "rotation", "opacity",
                    "anchorPoint"];
        if (OK.indexOf(args.property) === -1) {
          return { __err: "'property' must be one of: " + OK.join(", ") };
        }
        if (args.property === "position") {
          batSolidPos[args.layer] = args.value;
        }
        return { layer: args.layer, property: args.property,
                 value: args.value };
      }
      return { done: true };
    }
    case "add_text_layer":
      textStyle = { fontSize: args && args.fontSize,
                    font: "StubFont-Regular",
                    tracking: args && args.tracking,
                    leading: args && args.leading };
      // AE names a new text layer after its own text.
      return { index: 1, name: (args && args.text) || "Text",
               style: textStyle };
    case "set_text_style":
      if (!textStyle) textStyle = {};
      if (args && args.fontSize !== undefined) textStyle.fontSize = args.fontSize;
      if (args && args.tracking !== undefined) textStyle.tracking = args.tracking;
      if (args && args.font !== undefined) textStyle.font = args.font;
      if (args && args.leading !== undefined) {
        textStyle.leading = args.leading === "auto" ? "auto" : args.leading;
      }
      return { style: textStyle };
    case "add_camera":
      return { index: 1, name: (args && args.name) || "Camera" };
    case "set_layer_timing":
      // Writing the trim echoes it back; calling it with no timing args is
      // a pure READ, which is how the suite gets AE's unrounded in/out.
      if (args && typeof args.inPoint === "number") {
        return { layer: args.layer, inPoint: args.inPoint,
                 outPoint: args.outPoint, startTime: 0 };
      }
      return { layer: args && args.layer, inPoint: 85 / 30,
               outPoint: 107 / 30, startTime: 0 };
    case "split_layer_into_chunks": {
      // A 1.35s..6.55s clip at 30 fps cut into 7: the ends stay verbatim
      // (frames 40.5 and 196.5) and every interior cut is moved onto a
      // whole frame. Reported in/out are rounded to 4 decimals, as the
      // host does.
      const fr = [40.5, 63, 85, 107, 130, 152, 174, 196.5];
      const pieces = [];
      for (let i = 0; i < 7; i++) {
        pieces.push({ layer: "ST Clip chunk " + (i + 1), index: 7 - i,
                      inPoint: Math.round(fr[i] / 30 * 10000) / 10000,
                      outPoint: Math.round(fr[i + 1] / 30 * 10000) / 10000 });
      }
      return { chunks: 7, chunkSeconds: 0.743, pieces: pieces,
               note: "Chunks play seamlessly end-to-end on separate " +
                     "layers (no overlap); stacked ascending and now " +
                     "SELECTED; cut on whole frames at 30 fps" };
    }
    default: return { done: true };
  }
}

function cannedResult(tool, args) {
  if (!documented(tool)) return { ok: false, error: "Unknown tool: " + tool };
  const d = cannedOk(tool, args);
  return d && d.__err ? { ok: false, error: d.__err } : { ok: true, data: d };
}

// Many tools in ONE host call. Faithful to AELL_callBatch on two points
// the suite measures: one row per command, in order, and a failing row
// does NOT stop the commands behind it.
const batchCalls = [];
function cannedBatch(cmds, cb) {
  batchCalls.push(cmds.length);
  cb(cmds.map(c => cannedResult(c.tool, c.args || {})));
}

// 2. happy path: all steps pass, cleanup (delete_item) runs last
const calls = [];
SelfTest.run({
  callHostTool(tool, args, cb) {
    calls.push(tool);
    assert(args && typeof args === "object",
           "args object for " + tool);
    cb(cannedResult(tool, args));
  },
  callHostBatch: cannedBatch,
  onLine() {},
  onDone(res) {
    assert(res.passed === res.total,
           "happy path: " + res.passed + "/" + res.total + " passed" +
           (res.passed === res.total ? "" : " -- " + res.text));
    assert(calls[calls.length - 1] === "delete_item",
           "cleanup delete_item runs last");
    assert(/Self-test: \d+\/\d+ passed/.test(res.text),
           "report carries the summary line");

    // 3. failure path: a failing tool surfaces in the report and the run
    // still completes (cleanup included)
    createCount = 0;
    camProbeReads = 0;
    ordX = {};
    ordStack = [];
    maskKeys = {};
    batchLayers = 0; batchFx = {}; batchBlur = null;
    batSolids = []; batSolidFx = {}; batSolidPos = {};
    SelfTest.run({
      callHostTool(tool, args, cb) {
        if (tool === "grid_layout") {
          cb({ ok: false, error: "boom" });
          return;
        }
        cb(cannedResult(tool, args));
      },
      onLine() {},
      onDone(res2) {
        assert(res2.passed === res2.total - 1,
               "one failure recorded (" + res2.passed + "/" +
               res2.total + ")");
        assert(/FAIL grid rig/.test(res2.text) && /boom/.test(res2.text),
               "report names the failed step with its error");

        // 4. the inverted steps must really be inverted: a host that
        // ACCEPTS a call the suite expects to be refused has to fail, or
        // every grounded-refusal step is decorative.
        const inverted = steps.filter(st => st.expectError);
        assert(inverted.length >= 3,
               "suite carries " + inverted.length + " refusal steps");
        createCount = 0;
        camProbeReads = 0;
        ordX = {};
        ordStack = [];
        maskKeys = {};
        batchLayers = 0; batchFx = {}; batchBlur = null;
        batSolids = []; batSolidFx = {}; batSolidPos = {};
        SelfTest.run({
          callHostTool(tool, args, cb) {
            // Never refuse anything -- the old permissive host.
            const d3 = cannedOk(tool, args);
            cb({ ok: true, data: d3 && d3.__err ? { keysSet: 2 } : d3 });
          },
          onLine() {},
          onDone(res3) {
            assert(res3.passed <= res3.total - inverted.length,
                   "a permissive host fails every refusal step (" +
                   res3.passed + "/" + res3.total + ", " +
                   inverted.length + " refusals)");
            assert(/expected a refusal/.test(res3.text),
                   "the report says the tool accepted what it must refuse");
            checkFlatStack();
          }
        });
      }
    });
  }
});

// 5. the CLI runner drives this SAME suite with a shimmed setTimeout, and
// ExtendScript's stack is small. selftest.js ends every step with
// setTimeout(step), so a shim that called straight through nested each
// step inside the last one and the suite killed itself with "Stack
// overrun" once it outgrew ~100 steps -- a failure that looks nothing
// like a failing step. scripts/ae-selftest.jsx queues instead and drains
// from the top level; this proves the queue is flat AND that the
// measurement can actually see the difference.
function checkFlatStack() {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts",
                                        "ae-selftest.jsx"), "utf8");
  assert(!/setTimeout:\s*function\s*\(fn\)\s*\{\s*fn\(\)/.test(src),
         "the CLI runner's setTimeout does not call straight through");
  assert(/pending\.push\(fn\)/.test(src) &&
         /while \(pending\.length > 0/.test(src),
         "the CLI runner queues each step and drains it from the top level");

  // Model both shims against the real step list: the queue must stay at
  // depth 1 whatever the suite length, the pass-through must not.
  const steps2 = SelfTest._buildSteps();
  let recursive = 0, flat = 0, depth = 0;
  const recurse = fn => { depth++; if (depth > recursive) recursive = depth;
                          fn(); depth--; };
  const pending = [];
  const queueUp = fn => { pending.push(fn); };
  (function model(shim, drain) {
    let i = 0;
    const step = () => { if (i++ < steps2.length) shim(step); };
    step();
    if (drain) {
      let d = 0;
      while (pending.length) {
        d++;
        if (d > flat) flat = d;
        const fn = pending.shift();
        fn();
        d--;
      }
    }
  })(queueUp, true);
  (function () {
    depth = 0;
    let i = 0;
    const step = () => { if (i++ < steps2.length) recurse(step); };
    step();
  })();
  assert(flat === 1,
         "queued steps stay one frame deep (" + flat + ")");
  assert(recursive >= steps2.length - 1,
         "pass-through nests one frame PER STEP (" + recursive + " for " +
         steps2.length + " steps) — that is the stack ExtendScript ran out " +
         "of");
  console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
}
