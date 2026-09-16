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

  // catalogEntry is the link the resolver ranks on: it is how a template
  // is priced (entryFits), how its weights are checked
  // (catalogModelStatus) and how the BASELINE tiebreak knows which graph
  // the catalog itself points at. A template without it is invisible to
  // all three and silently sorts last.
  assert(CATALOG_NAMES.indexOf(mf.catalogEntry) !== -1,
         t.base + ": catalogEntry names a real catalog entry",
         String(mf.catalogEntry));

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

// ------------------------------------ replay the real injection (P5)
//
// Everything above reads the files. This RUNS the panel's own
// injectParams over each shipped template + its manifest and checks what
// landed, which is the half docs/proposals/comfy-templates-PLAN.md §5
// asked for and the file did not do.
//
// It exists because of a bug it would have caught for free. Measured
// 2026-09-09 (WORKPLAN §18 P5): the sd15 manifest was authored with
// `procedural.resolution: {nodeId: 4, widget: 0}`, and proceduralKey's
// POSITIONAL fallback resolved widget 0 to the node's first settable
// input — `batch_size`, not width — so the panel wrote 0.15 megapixels
// into it and ComfyUI refused the whole graph: "Value 0 smaller than
// min of 1 — batch_size". Nothing here or in CI noticed; it took a GPU,
// a backend and a real generation to find. The rule below is the
// general form: injection may CHANGE a literal input, but it may never
// turn a whole positive number into a fraction or a zero. Every real
// injection (width, height, frames, seed, steps) writes integers; only
// a widget landing on the wrong input produces 0.15 where 1 was.
{
  const win = {
    AEBridge: { nodeRequire: require, getExtensionPath: () => REPO },
    Settings: { dataRoot: () => REPO },
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  (new Function("window", fs.readFileSync(
    path.join(REPO, "extension", "js", "comfy.js"), "utf8")))(win);
  const Comfy = win.Comfy;

  const PROMPT = "a lighthouse in a storm, oil painting";
  const NEGATIVE = "blurry, watermark";
  const SEED = 424242;

  shipped.forEach((t) => {
    const graph = JSON.parse(fs.readFileSync(t.file, "utf8"));
    const mfPath = t.file.replace(/\.json$/i, ".manifest.json");
    if (!fs.existsSync(mfPath)) return;
    const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));

    // Every literal number the graph carries, before anything is written.
    const before = {};
    Object.keys(graph).forEach((k) => {
      const n = graph[k];
      if (!n || !n.inputs) return;
      Object.keys(n.inputs).forEach((ik) => {
        if (typeof n.inputs[ik] === "number") before[k + "." + ik] = n.inputs[ik];
      });
    });

    const params = {
      prompt: PROMPT, negative: NEGATIVE, seed: SEED,
      width: 512, height: 288
    };
    // A video template is asked in the units its own manifest declares.
    if (mf.kind === "video") {
      if (mf.procedural && mf.procedural.durationSeconds) {
        params.durationSeconds = 2;
      } else {
        params.frames = 25;
      }
    }

    let applied = null, err = null;
    try { applied = Comfy.injectParams(graph, params, mf); }
    catch (e) { err = e.message; }
    assert(!err, t.base + ": injectParams runs over the shipped file",
           err || (applied.length + " change(s)"));
    if (err) return;

    assert(Comfy._graphCarriesValue(graph, PROMPT),
           t.base + ": the prompt landed in the graph as a literal");

    // The seed is a number, so _graphCarriesValue (string compare) cannot
    // see it — look for it directly.
    const seeded = Object.keys(graph).some((k) => {
      const n = graph[k];
      if (!n || !n.inputs) return false;
      return Object.keys(n.inputs).some((ik) =>
        /seed/i.test(ik) && n.inputs[ik] === SEED);
    });
    assert(seeded, t.base + ": the pinned seed landed on a seed input");

    // THE RULE: no whole positive number became a fraction or a zero.
    const wrecked = [];
    Object.keys(before).forEach((key) => {
      const parts = key.split(".");
      const n = graph[parts[0]];
      const now = n && n.inputs ? n.inputs[parts.slice(1).join(".")] : undefined;
      if (typeof now !== "number") return;          // detached/rewired: fine
      const was = before[key];
      if (!(was > 0 && was === Math.round(was))) return;
      if (now === 0 || now !== Math.round(now)) {
        wrecked.push(key + ": " + was + " -> " + now);
      }
    });
    assert(wrecked.length === 0,
           t.base + ": injection left every whole-number input whole",
           wrecked.join("; ") || "none broken");
  });
}

// ------------------------------------- what the bundle can no longer do
//
// WORKPLAN 18 P9 replaced the minimax-h3 entry's graph with the core-only
// AE_LLAMA_H3_T2V_V1 and moved the owner's authored AE_LLAMA_H3_I2V_V1 out
// to tests/fixtures/authored-h3/. That graph was the LAST shipped template
// declaring procedural.firstFrame, so as of 0.12.14 no bundled graph can
// take a reference image at all: every image-to-video and image-to-image
// path left the product with it.
//
// The panel is honest about it -- comfy.js refuses an image that lands on
// no node and names the templates that would accept one, which is now the
// branch that says "none of the templates alongside this one do"
// (test-comfy-image-landed.js case 2 covers the branch, against a
// synthetic folder). What nothing said is that the REAL bundle is now that
// case. So the gap is pinned here, in BOTH directions, the way 18 P7a's
// video-gate gap is pinned: a count that is not the expected one fails
// whether it went up or down, and the day someone ships an i2v template
// they update this line and the count with it.
//
// This is a GAP, not a rule. It is filed as WORKPLAN 18 P9a.
{
  const IMAGE_CAPABLE_SHIPPED = [];   // <- 18 P9a: should not stay empty
  const capable = [];
  fs.readdirSync(BUNDLE)
    .filter((n) => /\.manifest\.json$/i.test(n))
    .sort()
    .forEach((n) => {
      const mf = JSON.parse(fs.readFileSync(path.join(BUNDLE, n), "utf8"));
      if ((mf.procedural || {}).firstFrame) {
        capable.push(n.replace(/\.manifest\.json$/i, ""));
      }
    });
  assert(capable.join(",") === IMAGE_CAPABLE_SHIPPED.slice().sort().join(","),
         "the set of shipped templates that accept a reference image is " +
         "exactly what this file says it is",
         "found [" + (capable.join(", ") || "none") + "], expected [" +
         (IMAGE_CAPABLE_SHIPPED.join(", ") || "none") + "]");
  // Stated as its own assertion so the failure READS as the gap rather
  // than as a list mismatch, and so it flips the moment 18 P9a is done.
  assert(capable.length === 0,
         "18 P9a is still open: no shipped template can take a reference " +
         "image (if this fails, one now can -- close P9a and update the " +
         "list above)",
         capable.join(", ") || "none");
}

// -------------------------------------- two templates, one output folder
//
// A relative filename_prefix is joined onto ComfyUI's own output dir, so
// two templates that share one write their clips into the same folder
// under the same stem and are told apart only by ComfyUI's _00001_
// counter. Nothing downstream can then say which entry produced which
// file -- not the owner reading the folder, and not a probe that greps
// for its own output by name.
//
// This became reachable on 2026-09-09 (WORKPLAN 18 P10), the first time
// the bundle held two templates for ONE model: AE_LLAMA_H3_INT8_T2V_V1 is
// AE_LLAMA_H3_T2V_V1 with the text encoder swapped, and it was authored
// by copying the file. A copy inherits the prefix, and the prefix is the
// kind of input a reviewer's eye slides over because it is a long string
// that looks right. The int8 template writes to MiniMaxH3int8/; this pins
// that no future sibling arrives without doing the same.
{
  const seen = {};
  shipped.forEach((t) => {
    const graph = JSON.parse(fs.readFileSync(t.file, "utf8"));
    Object.keys(graph).forEach((k) => {
      const n = graph[k];
      const p = n && n.inputs && n.inputs.filename_prefix;
      if (typeof p !== "string" || p === "") return;
      (seen[p] = seen[p] || []).push(t.base + " node " + k);
    });
  });
  const shared = Object.keys(seen).filter((p) => seen[p].length > 1);
  assert(shared.length === 0,
         "no two shipped templates write to the same filename_prefix",
         shared.map((p) => p + " <- " + seen[p].join(", ")).join("; ") ||
         "every prefix is unique");
}

// ---------------------------- the two H3 siblings may not drift apart
//
// minimax-h3 and minimax-h3-int8 are ONE model offered with two text
// encoders: nvfp4 (Blackwell-native) and int8 (everything else). Their
// graphs are therefore the same fifteen nodes with one input different,
// and measurement backs that up -- 26 080 vs 26 048 MiB, 253 vs 259 s on
// the same card at the same size and length (WORKPLAN 18 P9, 18 P10).
//
// The bug class this pins is drift, and it is silent in the direction
// that matters: a fix to the H3 render path -- a sampler, a step count, a
// sigma shift, a frame count -- applied to the file someone had open and
// not to its sibling. The nvfp4 graph is the one every probe defaults to
// and the one a Blackwell dev machine runs, so the UNFIXED half is the
// one that only ships to buyers whose cards cannot run the other. Nothing
// else in this file compares two templates to each other.
//
// The allowed differences are enumerated, not pattern-matched: exactly
// the encoder file and the output prefix. A third difference fails here
// and is either a real divergence (say so, and list it) or the drift.
{
  const A = "AE_LLAMA_H3_T2V_V1", B = "AE_LLAMA_H3_INT8_T2V_V1";
  const fa = path.join(BUNDLE, A + ".json");
  const fb = path.join(BUNDLE, B + ".json");
  const both = fs.existsSync(fa) && fs.existsSync(fb);
  assert(both, "both H3 siblings are bundled", A + " + " + B);
  if (both) {
    const ga = JSON.parse(fs.readFileSync(fa, "utf8"));
    const gb = JSON.parse(fs.readFileSync(fb, "utf8"));
    const ka = Object.keys(ga).sort(), kb = Object.keys(gb).sort();
    assert(ka.join() === kb.join(),
           "the H3 siblings hold the same node ids",
           ka.length + " vs " + kb.length);

    // _meta.title is documentation and may differ; class_type and inputs
    // are the render.
    const diffs = [];
    ka.forEach((k) => {
      const na = ga[k] || {}, nb = gb[k] || {};
      if (na.class_type !== nb.class_type) {
        diffs.push(k + ".class_type");
        return;
      }
      const ia = na.inputs || {}, ib = nb.inputs || {};
      const keys = Object.keys(ia).concat(Object.keys(ib))
        .filter((x, i, all) => all.indexOf(x) === i).sort();
      keys.forEach((ik) => {
        if (JSON.stringify(ia[ik]) !== JSON.stringify(ib[ik])) {
          diffs.push(k + "." + ik);
        }
      });
    });
    const ALLOWED = ["137.clip_name", "92.filename_prefix"].sort();
    assert(diffs.sort().join(", ") === ALLOWED.join(", "),
           "the H3 siblings differ in exactly the encoder and the output " +
           "prefix, and in nothing else",
           "found [" + (diffs.join(", ") || "nothing") + "], expected [" +
           ALLOWED.join(", ") + "]");
  }
}

// The OTHER sibling pair, and the one whose difference is easiest to
// "tidy" into a bug. wan22-5b and wan22-5b-fp8 are ONE download: there is
// no fp8 FILE of the Wan 2.2 ti2v 5B -- Comfy-Org publishes that model in
// fp16 only (checked against the HF tree API 2026-09-16; every fp8_scaled
// build in that repo is a 14B). The fp8 entry is the SAME file loaded
// through core UNETLoader's weight_dtype cast, measured 24 314 MiB against
// the fp16's 26 187 at the authored size and 16 834 against 21 536 at
// 704x480 (WORKPLAN 18 P7c step 1).
//
// Two bug classes, both silent:
//
//  1. Drift, as with the H3 pair above -- a fix to one Wan graph's
//     sampler, shift, size or length and not to the other.
//  2. A future pass "completing" the fp8 entry by pointing its unet_name
//     at a wan2.2_ti2v_5B_fp8*.safetensors. That file does not exist; the
//     entry would 404 on download and the graph would fail on a name the
//     backend cannot offer. The allowed-diff list is what refuses it: the
//     two graphs must name the SAME weight file, and the only permitted
//     difference on node 37 is weight_dtype.
{
  const A = "AE_LLAMA_WAN22_5B_T2V_V1", B = "AE_LLAMA_WAN22_5B_FP8_T2V_V1";
  const fa = path.join(BUNDLE, A + ".json");
  const fb = path.join(BUNDLE, B + ".json");
  const both = fs.existsSync(fa) && fs.existsSync(fb);
  assert(both, "both Wan 2.2 5B siblings are bundled", A + " + " + B);
  if (both) {
    const ga = JSON.parse(fs.readFileSync(fa, "utf8"));
    const gb = JSON.parse(fs.readFileSync(fb, "utf8"));
    const ka = Object.keys(ga).sort(), kb = Object.keys(gb).sort();
    assert(ka.join() === kb.join(),
           "the Wan siblings hold the same node ids",
           ka.length + " vs " + kb.length);

    const diffs = [];
    ka.forEach((k) => {
      const na = ga[k] || {}, nb = gb[k] || {};
      if (na.class_type !== nb.class_type) { diffs.push(k + ".class_type"); return; }
      const ia = na.inputs || {}, ib = nb.inputs || {};
      const keys = Object.keys(ia).concat(Object.keys(ib))
        .filter((x, i, all) => all.indexOf(x) === i).sort();
      keys.forEach((ik) => {
        if (JSON.stringify(ia[ik]) !== JSON.stringify(ib[ik])) {
          diffs.push(k + "." + ik);
        }
      });
    });
    const ALLOWED = ["37.weight_dtype", "58.filename_prefix"].sort();
    assert(diffs.sort().join(", ") === ALLOWED.join(", "),
           "the Wan siblings differ in exactly the dtype cast and the " +
           "output prefix, and in nothing else",
           "found [" + (diffs.join(", ") || "nothing") + "], expected [" +
           ALLOWED.join(", ") + "]");

    // Said separately from the diff list because it is the claim the
    // catalog's sizeMB rests on: one set of bytes, two entries.
    assert(ga["37"].inputs.unet_name === gb["37"].inputs.unet_name,
           "the Wan siblings load the SAME diffusion file (there is no " +
           "fp8 build of the 5B to point at)",
           gb["37"].inputs.unet_name);

    // weight_dtype is an enum on a core node. These four values are the
    // running managed backend's own /object_info list, re-read 2026-09-16.
    // fp8_e4m3fn_fast is deliberately NOT what ships: it routes the
    // matmuls through fp8 as well, which is a quality change, and a basic
    // is the shape ComfyUI ships rather than a tuned one.
    const DTYPES = ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"];
    assert(DTYPES.indexOf(gb["37"].inputs.weight_dtype) !== -1,
           "the fp8 sibling's weight_dtype is a value core UNETLoader " +
           "offers", gb["37"].inputs.weight_dtype);
    assert(gb["37"].inputs.weight_dtype === "fp8_e4m3fn",
           "and it is the conservative half of the fp8 pair (storage " +
           "only, not fast matmuls)", gb["37"].inputs.weight_dtype);
  }
}

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
