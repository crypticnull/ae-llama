/*
 * test-workflow-rows.js — the Settings > ComfyUI > Workflows row model.
 *
 * WORKPLAN §18 P4. The owner's ask was that workflows be "arranged and
 * accessible via the plugin UI", and the review's sharpest note on the
 * first draft of that row was that it carried nothing about what a
 * template NEEDS: no VRAM floor, no architecture gate, no "needs an
 * image", no count of missing weights — while all four already exist one
 * hop away through the manifest's catalogEntry link.
 *
 * main.js has NO executed coverage, so the rules live in
 * Tools.workflowRows() and the DOM builder is a dumb renderer over it.
 * This file is why that split exists.
 *
 * The invariant that matters most: a row may never promise what the
 * CHOOSER would refuse. Both read the same workflowFacts(), and the
 * cases below pin the places they could drift — a disabled template, one
 * that needs an image, one this card cannot hold.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

let failures = 0;
function assert(cond, label, detail) {
  console.log((cond ? "ok  - " : "FAIL- ") + label +
              (detail ? "  (" + detail + ")" : ""));
  if (!cond) failures++;
}

// A workflow dir with one image template, one video template that needs
// a reference image, and the format example that must never get a row.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-rows-"));
function put(name, graph, manifest) {
  fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify(graph));
  if (manifest) {
    fs.writeFileSync(path.join(dir, name + ".manifest.json"),
                     JSON.stringify(manifest));
  }
}
const NODE = { "1": { class_type: "CheckpointLoaderSimple",
                      inputs: { ckpt_name: "real.safetensors" } } };
put("AE_LLAMA_KREA2_T2I_V1", NODE, { kind: "image", catalogEntry: "krea2",
                                 models: [] });
put("AE_LLAMA_H3_I2V_V1", NODE,
    { kind: "video", catalogEntry: "minimax-h3", models: [],
      procedural: { firstFrame: { nodeId: 1, input: "image" } } });
put("example-txt2img", { "4": { class_type: "CheckpointLoaderSimple",
                                inputs: { ckpt_name: "CHANGE-ME.safetensors" } } });
put("my-own-export", NODE);   // a user's API export: no sidecar at all

const comfyWin = {
  AEBridge: { nodeRequire: require },
  Settings: { dataRoot: () => dir, get: () => ({}) },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  console, setTimeout, clearTimeout
};
new Function("window", fs.readFileSync(
  path.join(__dirname, "..", "extension", "js", "comfy.js"), "utf8"))(comfyWin);

let settings = {};
const win = {
  AEBridge: { nodeRequire: require },
  console, setTimeout, clearTimeout,
  Settings: { get: () => settings },
  Llama: { getState: () => "stopped" },
  Setup: { queryVramUsedMB: (cb) => cb(new Error("no smi")) },
  Comfy: {
    describeWorkflows: comfyWin.Comfy.describeWorkflows,
    listWorkflows: comfyWin.Comfy.listWorkflows,
    readManifest: comfyWin.Comfy.readManifest,
    backendUrl: () => "http://127.0.0.1:8288"
  }
};
win.window = win;
for (const f of ["version.js", "tiers.js", "tools.js"]) {
  new Function("window", fs.readFileSync(
    path.join(__dirname, "..", "extension", "js", f), "utf8"))(win);
}
const Tools = win.Tools;

function rows(patch, gpu) {
  settings = Object.assign({ comfyWorkflowsDir: dir, comfyEnhance: {},
                             comfyWorkflows: {}, vramOverrideGB: 0 },
                           patch || {});
  Tools.setGpuInfo(gpu || { hasNvidia: true, vramGB: 32, computeCap: 8.9 });
  const out = {};
  Tools.workflowRows(settings).forEach((r) => { out[r.name] = r; });
  return out;
}

// 1. The format example gets NO row. It used to get a checkbox of its
//    own while tools.js hid it from the model — a control for something
//    that can never render.
{
  const r = rows();
  assert(!r["example-txt2img"],
         "the format example is not offered a row");
  assert(!!r["AE_LLAMA_KREA2_T2I_V1"] && !!r["AE_LLAMA_H3_I2V_V1"],
         "the real templates are");
  assert(!!r["my-own-export"],
         "and so is a user's own export with no manifest — the bundle " +
         "README promises those work as-is");
}

// 2. Kind, the catalog link and the label a user recognises.
{
  const r = rows();
  assert(r["AE_LLAMA_KREA2_T2I_V1"].kind === "image" &&
         r["AE_LLAMA_H3_I2V_V1"].kind === "video",
         "each row carries its kind");
  assert(r["AE_LLAMA_KREA2_T2I_V1"].label === "Krea 2 (turbo)",
         "and the catalog's own label, not the file name",
         r["AE_LLAMA_KREA2_T2I_V1"].label);
  assert(r["my-own-export"].kind === null &&
         r["my-own-export"].label === null,
         "an undescribed export claims neither");
}

// 3. NEEDS. This is the half the review said was missing, and every
//    phrase comes from data that already existed one hop away.
{
  const r = rows();
  const h3 = r["AE_LLAMA_H3_I2V_V1"];
  assert(h3.needs.some((n) => /32\+ GB VRAM/.test(n)),
         "a row names the VRAM floor its catalog entry declares",
         h3.needs.join(" · "));
  assert(h3.needs.some((n) => /RTX 50 series only/.test(n)),
         "and the architecture gate", h3.needs.join(" · "));
  assert(h3.needs.some((n) => /needs a reference image/.test(n)),
         "and that this template cannot run without an image — the " +
         "manifest's firstFrame is not detachable here",
         h3.needs.join(" · "));
  assert(r["my-own-export"].needs.length === 0,
         "an export with no catalog link promises nothing it cannot know");
}

// 4. Missing weights are COUNTED, not implied. "3 of 3 missing" is the
//    difference between "this will not run" and "this is not installed".
{
  const r = rows();
  const krea = r["AE_LLAMA_KREA2_T2I_V1"];
  assert(krea.weights && krea.weights.total === 3,
         "the row knows how many model files its entry names",
         JSON.stringify(krea.weights));
  assert(krea.needs.some((n) => /model file\(s\) missing/.test(n)),
         "and says how many are absent from this disk",
         krea.needs.join(" · "));
}

// 5. FIT is per card, and it is the one thing a row must not get wrong:
//    a green-looking row for a template the chooser will rank last is
//    worse than no row.
{
  const big = rows({}, { hasNvidia: true, vramGB: 8, computeCap: 8.9 });
  assert(big["AE_LLAMA_H3_I2V_V1"].fits === false,
         "on an 8 GB card the 32 GB template does not fit");
  const ok = rows({}, { hasNvidia: true, vramGB: 32, computeCap: 12.0 });
  assert(ok["AE_LLAMA_H3_I2V_V1"].fits === true,
         "on a 32 GB Blackwell card it does");
}

// 6. enabled / enhance both default ON and record only the opt-OUT, so a
//    template arriving in an update needs no settings migration.
{
  const plain = rows();
  assert(plain["AE_LLAMA_KREA2_T2I_V1"].enabled === true &&
         plain["AE_LLAMA_KREA2_T2I_V1"].enhance === true,
         "absent from both maps means ON");

  const off = rows({
    comfyWorkflows: { AE_LLAMA_KREA2_T2I_V1: { enabled: false } },
    comfyEnhance: { AE_LLAMA_H3_I2V_V1: false }
  });
  assert(off["AE_LLAMA_KREA2_T2I_V1"].enabled === false,
         "a recorded opt-out disables that row");
  assert(off["AE_LLAMA_H3_I2V_V1"].enhance === false,
         "and the enhancement opt-out is independent of it");
  assert(off["AE_LLAMA_H3_I2V_V1"].enabled === true,
         "disabling one template does not disable another");
}

// 7. THE ROW AND THE CHOOSER AGREE. Both read the same facts; this pins
//    the one thing that would make the UI lie — a row marked as the
//    default that the resolver would not pick.
{
  const r = rows();
  assert(r["AE_LLAMA_KREA2_T2I_V1"].baseline === true,
         "the graph its catalog entry points at is marked as the default");
  assert(r["my-own-export"].baseline === false,
         "and a template no entry points at is not");

  const chosen = comfyWin.Comfy.resolveWorkflow(
    comfyWin.Comfy.describeWorkflows(dir), { kind: "image" }, null,
    { baseline: (d) => r[d.name] && r[d.name].baseline });
  assert(chosen.chosen && r[chosen.chosen.name].baseline === true,
         "and a nameless image request really does pick the row marked " +
         "default — the UI and the chooser cannot disagree",
         chosen.chosen && chosen.chosen.name);
}

console.log(failures ? "\n" + failures + " FAILED" : "\nALL TESTS PASSED");
process.exitCode = failures ? 1 : 0;
