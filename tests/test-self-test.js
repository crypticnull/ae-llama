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
let unknown = [];
for (const s of steps) {
  if (!toolsSrc.includes('name: "' + s.tool + '"')) unknown.push(s.tool);
}
assert(unknown.length === 0,
       "every step targets a documented tool" +
       (unknown.length ? " (unknown: " + unknown.join(", ") + ")" : ""));
const names = new Set(steps.map(s => s.name));
assert(names.size === steps.length, "step names are unique");

// canned happy-path results per tool
let createCount = 0;
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
function cannedOk(tool, args) {
  switch (tool) {
    case "create_comp":
      createCount++;
      // 1st = the scratch comp, 2nd = the deliberate name collision that
      // must auto-number, 3rd+ = whatever was asked for (the camera comp).
      if (createCount === 1) return { name: "AELL Self-Test", id: 1 };
      if (createCount === 2) return { name: "AELL Self-Test 2", id: 2 };
      return { name: (args && args.name) || "AELL Self-Test 3",
               id: createCount };
    case "duplicate_layer": {
      const n = (args && args.count) || 8;
      return { created: n, totalLayersInComp: n + 1 };
    }
    case "distribute_property": {
      const L = (args && args.layers) || [];
      const from = (args && typeof args.from === "number") ? args.from : 0;
      const step = (args && typeof args.step === "number") ? args.step : 0;
      const applied = L.map((nm, i) => ({ layer: nm, value: from + i * step }));
      for (const a of applied) ordX[a.layer] = a.value;
      return { property: args && args.property, layers: L.length, applied };
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
    case "get_comp_details":
      return { name: args && args.comp, numLayers: ordStack.length,
               layers: ordStack.map((nm, i) => ({ index: i + 1, name: nm })) };
    case "grid_layout":
      return { sliders: ["Grid X Spacing", "Grid Y Spacing",
                         "Grid Columns"] };
    case "get_property":
      // Position on a 2D layer: the scripting API pads the value to 3
      // components ([x, y, 0]) even though the expression engine sees
      // 2 — model that faithfully, and give the two grid squares
      // different cells so the "distinct cells" step is real.
      if (args && /^ST Ord/.test((args && args.layer) || "")) {
        return { value: [ordX[args.layer], 300, 0] };
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
    case "set_expression":
      return { expressionEnabled: true,
               expression: args && args.expression };
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
      return { name: (args && args.name) || "ST Square" };
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

// 2. happy path: all steps pass, cleanup (delete_item) runs last
const calls = [];
SelfTest.run({
  callHostTool(tool, args, cb) {
    calls.push(tool);
    assert(args && typeof args === "object",
           "args object for " + tool);
    const d = cannedOk(tool, args);
    cb(d && d.__err ? { ok: false, error: d.__err } : { ok: true, data: d });
  },
  onLine() {},
  onDone(res) {
    assert(res.passed === res.total,
           "happy path: " + res.passed + "/" + res.total + " passed");
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
    SelfTest.run({
      callHostTool(tool, args, cb) {
        if (tool === "grid_layout") {
          cb({ ok: false, error: "boom" });
          return;
        }
        const d2 = cannedOk(tool, args);
        cb(d2 && d2.__err ? { ok: false, error: d2.__err }
                          : { ok: true, data: d2 });
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
