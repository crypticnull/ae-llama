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
function cannedOk(tool) {
  switch (tool) {
    case "create_comp":
      createCount++;
      return { name: createCount === 1 ? "AELL Self-Test"
                                       : "AELL Self-Test 2",
               id: createCount };
    case "duplicate_layer": return { created: 8, totalLayersInComp: 9 };
    case "grid_layout":
      return { sliders: ["Grid X Spacing", "Grid Y Spacing",
                         "Grid Columns"] };
    case "get_property": return { value: 3 };
    case "set_keyframes": return { keysSet: 18 };
    case "apply_keyframe_ease": return { easedPairs: 9 };
    case "stagger_layers": return { layers: 9 };
    case "set_mask_path": return { keysSet: 2 };
    case "add_shape_content": return { params: "End" };
    case "set_track_matte": return { mode: "alpha" };
    case "set_layer_parent": return { parented: "ST Square 5" };
    case "scale_comp": return { scaleFactor: 0.5 };
    case "add_solid": return { name: "ST Square" };
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
    cb({ ok: true, data: cannedOk(tool) });
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
    SelfTest.run({
      callHostTool(tool, args, cb) {
        if (tool === "grid_layout") {
          cb({ ok: false, error: "boom" });
          return;
        }
        cb({ ok: true, data: cannedOk(tool) });
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
