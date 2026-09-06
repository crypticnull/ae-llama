/*
 * test-workflow-bundle.js — every template the panel SHIPS must be
 * describable, priceable and runnable, and CI must be able to say so
 * without a ComfyUI.
 *
 * WORKPLAN §18 / docs/proposals/comfy-templates-PLAN.md §5. This is the
 * ratchet half: it walks extension/comfy-workflows/ rather than a
 * hardcoded list, so a template added without its sidecar fails here
 * instead of at a buyer's first generation.
 *
 * The three things it is written around, each measured:
 *
 *   1. The MANIFEST is the only place `kind`, the catalog link and the
 *      image contract live. Nothing consumed manifest.kind at all until
 *      §18 — both shipped manifests carried it unread — so it could say
 *      anything and no test would notice.
 *
 *   2. `models[].dir` is what the arbiter's disk lookup walks
 *      (tools.js modelFilePath). 0.10.9 measured the cost of getting the
 *      weights wrong: every shipped manifest lacked sizeMB, genNeedMBFor
 *      returned null for every template, and a 32 GB card paused chat for
 *      every generation it could have run concurrently. sizeMB is an
 *      optional override now — `file` + `dir` are what must be right.
 *
 *   3. The non-optional models a graph loads must be weights the catalog
 *      entry actually names, or `catalogModelStatus` reports a model as
 *      absent that the template needs, or present when it does not.
 *      OPTIONAL entries are EXEMPT and that exemption is load-bearing:
 *      the shipped H3 manifest carries a turbo LoRA under a subfolder
 *      (`MiniMax_H3/...`) that appears in no catalog url list, and it is
 *      exactly the branch weight genNeedMBFor skips. A subset rule
 *      without the exemption goes red on the day it lands.
 *
 * No ComfyUI, no GPU, no AE — pure file reading.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const BUNDLE = path.join(REPO, "extension", "comfy-workflows");

let failures = 0;
function assert(cond, label, detail) {
  console.log((cond ? "ok  - " : "FAIL- ") + label +
              (detail ? "  (" + detail + ")" : ""));
  if (!cond) failures++;
}
function warn(label) { console.log("warn- " + label); }

// The catalog, read the way the panel reads it.
const window = { AELL: {} };
eval(fs.readFileSync(path.join(REPO, "extension", "js", "version.js"),
                     "utf8"));
const CATALOG = window.AELL.COMFY_CATALOG;
const CATALOG_NAMES = CATALOG.map((e) => e.name);

// The model sub-folders ComfyUI knows, straight out of comfy.js rather
// than a second copy — a manifest naming a folder the backend does not
// search is a weight it will never find.
const MODEL_SUBS = (function () {
  const src = fs.readFileSync(
    path.join(REPO, "extension", "js", "comfy.js"), "utf8");
  const m = src.match(/COMFY_MODEL_SUBS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("could not read COMFY_MODEL_SUBS from comfy.js");
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
             .filter(Boolean);
})();
assert(MODEL_SUBS.indexOf("diffusion_models") !== -1 &&
       MODEL_SUBS.indexOf("checkpoints") !== -1,
       "read the real COMFY_MODEL_SUBS out of comfy.js",
       MODEL_SUBS.length + " folders");

// --------------------------------------------------------------- the walk

const templates = fs.readdirSync(BUNDLE)
  .filter((n) => /\.json$/i.test(n))
  .filter((n) => !/\.manifest\.json$/i.test(n))
  .filter((n) => n.charAt(0) !== ".")
  .sort();

assert(templates.length > 0, "the bundle holds at least one template",
       templates.join(", "));

// example-txt2img is the FORMAT example and can never render: its
// checkpoint is the placeholder. It is excluded from every rule below,
// and comfy.js flags it so the model is never offered it — 0.9.28
// measured a generation running the placeholder because it was listed
// with equal standing and has the most picture-like name.
function isExample(file) {
  return fs.readFileSync(file, "utf8").indexOf("CHANGE-ME") !== -1;
}

const shipped = [];
templates.forEach((name) => {
  const file = path.join(BUNDLE, name);
  const base = name.replace(/\.json$/i, "");
  if (isExample(file)) {
    assert(base === "example-txt2img",
           base + ": a template holding the CHANGE-ME placeholder is the " +
           "format example and nothing else");
    return;
  }
  shipped.push({ base: base, file: file });
});

assert(shipped.length > 0, "and at least one that is not the example",
       shipped.map((t) => t.base).join(", "));

// ------------------------------------------------------- per template

shipped.forEach((t) => {
  const graph = JSON.parse(fs.readFileSync(t.file, "utf8"));

  // API format, not a UI export: loadWorkflow rejects the latter
  // outright (comfy.js), so a UI file here is a template that cannot run.
  assert(!(graph.nodes && graph.links),
         t.base + ": is API format, not a UI export");
  assert(Object.keys(graph).some((k) => graph[k] && graph[k].class_type),
         t.base + ": has class_type nodes");

  const mfPath = t.file.replace(/\.json$/i, ".manifest.json");
  const hasMf = fs.existsSync(mfPath);
  assert(hasMf, t.base + ": has a manifest sidecar");
  if (!hasMf) return;

  const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));

  assert(mf.workflow === t.base,
         t.base + ": the manifest names its own workflow", mf.workflow);
  assert(mf.kind === "image" || mf.kind === "video",
         t.base + ": declares kind image|video", String(mf.kind));

  // catalogEntry is P1's key. Until it lands this WARNS rather than
  // fails, so P0 can ship a ratchet that is green on the bundle as it
  // stands; P1 flips this to an assert in the same pass that adds it.
  if (mf.catalogEntry === undefined) {
    warn(t.base + ": no catalogEntry yet (P1 adds it, then this asserts)");
  } else {
    assert(CATALOG_NAMES.indexOf(mf.catalogEntry) !== -1,
           t.base + ": catalogEntry names a real catalog entry",
           mf.catalogEntry);
  }

  assert(mf.models instanceof Array && mf.models.length > 0,
         t.base + ": lists the models it loads");
  if (!(mf.models instanceof Array)) return;

  const entry = mf.catalogEntry
    ? CATALOG.filter((e) => e.name === mf.catalogEntry)[0]
    : null;
  // Fall back to the entry that NAMES this template, so the weights rule
  // still bites before catalogEntry exists.
  const linked = entry ||
    CATALOG.filter((e) => e.workflowTemplate === t.base)[0] || null;

  const catalogFiles = linked
    ? (linked.urls || []).map((u) => String(u.url).split("?")[0]
        .split("#")[0].split("/").pop())
        .concat(linked.files || [])
    : [];

  mf.models.forEach((m) => {
    assert(typeof m.file === "string" && m.file !== "",
           t.base + ": every model names its file");
    assert(MODEL_SUBS.indexOf(m.dir) !== -1,
           t.base + ": " + m.file + " lands in a folder ComfyUI searches",
           String(m.dir));
    if (m.optional) return;               // branch weights: see the header
    if (!linked || !catalogFiles.length) return;
    const bare = String(m.file).split(/[\\/]/).pop();
    assert(catalogFiles.indexOf(bare) !== -1,
           t.base + ": " + bare + " is a weight its catalog entry names",
           linked.name);
  });

  // procedural entries must point at nodes that exist, or injectParams
  // throws mid-generation on a graph the user already paid GPU time for.
  const proc = mf.procedural || {};
  ["prompt", "durationSeconds", "resolution", "firstFrame"].forEach((k) => {
    const p = proc[k];
    if (!p || typeof p !== "object" || p.nodeId === undefined) return;
    const node = graph[String(p.nodeId)];
    assert(!!node,
           t.base + ": procedural." + k + " points at a node that exists",
           "node " + p.nodeId);
    if (node && typeof p.input === "string") {
      assert(node.inputs &&
             Object.prototype.hasOwnProperty.call(node.inputs, p.input),
             t.base + ": procedural." + k + " names an input that exists",
             p.nodeId + "." + p.input);
    }
  });

  // A video template must end somewhere AE can read. Measured: AE cannot
  // import animated webp, so a graph that only writes one renders fine
  // and then fails at the import with nothing to show for the GPU time.
  if (mf.kind === "video") {
    const savers = Object.keys(graph)
      .map((k) => graph[k])
      .filter((n) => n && /SaveVideo|VHS_VideoCombine|SaveAnimated/i
                        .test(String(n.class_type)));
    assert(savers.length > 0,
           t.base + ": a video template writes a video file");
    const writesMp4 = savers.some((n) => {
      const i = n.inputs || {};
      const fmt = String(i.format || i.filename_prefix || "").toLowerCase();
      const codec = String(i.codec || "").toLowerCase();
      return /mp4|h264/.test(fmt) || /h264/.test(codec);
    });
    assert(writesMp4,
           t.base + ": and writes mp4/h264 — AE cannot import animated webp");
  }
});

// --------------------------------------------- the catalog's own side

// Every entry that NAMES a template must name one that is bundled AND
// not the placeholder. test-model-catalog.js checks existence; this adds
// "and it is a real one".
CATALOG.forEach((e) => {
  if (!e.workflowTemplate) return;
  const f = path.join(BUNDLE, e.workflowTemplate + ".json");
  const ok = fs.existsSync(f) && !isExample(f);
  assert(ok, e.name + ": its workflowTemplate is a runnable bundled graph",
         e.workflowTemplate);
});

console.log(failures ? "\n" + failures + " FAILED" : "\nALL TESTS PASSED");
process.exitCode = failures ? 1 : 0;
