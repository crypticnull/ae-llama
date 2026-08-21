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
    case "duplicate_layer": return { created: 8, totalLayersInComp: 9 };
    case "grid_layout":
      return { sliders: ["Grid X Spacing", "Grid Y Spacing",
                         "Grid Columns"] };
    case "get_property":
      // Position on a 2D layer: the scripting API pads the value to 3
      // components ([x, y, 0]) even though the expression engine sees
      // 2 — model that faithfully, and give the two grid squares
      // different cells so the "distinct cells" step is real.
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
    case "set_mask_path": return { keysSet: 2 };
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
    cb({ ok: true, data: cannedOk(tool, args) });
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
    SelfTest.run({
      callHostTool(tool, args, cb) {
        if (tool === "grid_layout") {
          cb({ ok: false, error: "boom" });
          return;
        }
        cb({ ok: true, data: cannedOk(tool, args) });
      },
      onLine() {},
      onDone(res2) {
        assert(res2.passed === res2.total - 1,
               "one failure recorded (" + res2.passed + "/" +
               res2.total + ")");
        assert(/FAIL grid rig/.test(res2.text) && /boom/.test(res2.text),
               "report names the failed step with its error");
        console.log(process.exitCode
          ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
      }
    });
  }
});
