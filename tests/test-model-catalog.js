// Regression test: VRAM-tier model recommendation (version.js + setup.js).
"use strict";
const fs = require("fs");
const path = require("path");

const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => __dirname },
  Settings: { dataRoot: () => __dirname, get: () => ({}) },
  Llama: {},
  setInterval, clearInterval, setTimeout, clearTimeout
};

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js", "version.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js", "tiers.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js", "setup.js"), "utf8"));

const cat = window.AELL.MODEL_CATALOG;
function rec(gpu) {
  const m = window.Setup.recommendModel(cat, gpu);
  return m ? m.name : null;
}
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

assert(rec({ hasNvidia: true, vramGB: 32 }).indexOf("32B") > 0,
       "32GB (5090) -> Qwen2.5 32B");
assert(rec({ hasNvidia: true, vramGB: 24 }).indexOf("32B") > 0,
       "24GB (4090/3090) -> Qwen2.5 32B (tight but fits)");
assert(rec({ hasNvidia: true, vramGB: 16 }).indexOf("14B") > 0,
       "16GB -> Qwen2.5 14B");
assert(rec({ hasNvidia: true, vramGB: 12 }).indexOf("14B") > 0,
       "12GB -> Qwen2.5 14B");
assert(rec({ hasNvidia: true, vramGB: 8 }).indexOf("7B") > 0,
       "8GB -> Qwen2.5 7B");
assert(rec({ hasNvidia: true, vramGB: 6 }).indexOf("3B") > 0,
       "6GB -> Llama 3.2 3B");
assert(rec({ hasNvidia: true, vramGB: 4 }).indexOf("3B") > 0,
       "4GB -> Llama 3.2 3B");
assert(rec({ hasNvidia: true, vramGB: 2 }).indexOf("3B") > 0,
       "2GB (nothing fits) -> lightest model, not the CPU pick");
assert(rec({ hasNvidia: false, vramGB: null }).indexOf("7B") > 0,
       "no NVIDIA GPU -> CPU default (7B)");
assert(rec({ hasNvidia: true, vramGB: null }).indexOf("7B") > 0,
       "GPU present but VRAM unknown -> safe default (7B)");
assert(window.Setup.recommendModel([], {}) === null, "empty catalog -> null");
// hosted override wins over built-in
const overridden = window.Setup.modelCatalog({ modelCatalog: [{ name: "X.gguf", sizeMB: 1, minVramGB: 1 }] });
assert(overridden.length === 1 && overridden[0].name === "X.gguf",
       "manifest modelCatalog overrides built-in list");

// vramOverrideGB flows through Setup.recommendModel via live settings:
// a 32 GB card impersonating 6 GB gets the 6 GB pick.
window.Settings.get = () => ({ vramOverrideGB: 6 });
assert(rec({ hasNvidia: true, vramGB: 32 }).indexOf("3B") > 0,
       "vramOverrideGB 6 makes a 32GB card recommend the 6GB model");
window.Settings.get = () => ({});

// The generation catalog rides the same feed mechanism.
assert(window.Setup.comfyCatalog(null).length > 0 &&
       window.Setup.comfyCatalog(null) === window.AELL.COMFY_CATALOG,
       "built-in comfyCatalog serves when the manifest has none");
const cOver = window.Setup.comfyCatalog({ comfyCatalog: [
  { name: "y", kind: "image", minVramGB: 4, sizeMB: 1 }] });
assert(cOver.length === 1 && cOver[0].name === "y",
       "manifest comfyCatalog overrides the built-in list");

// The combined first-run recommendation: one tier, both picks, honest copy.
const combo = window.Setup.recommendSetup(null,
  { hasNvidia: true, name: "RTX 4060", vramGB: 8, computeCap: 8.9 });
assert(combo.tier.id === "T3" && combo.chat &&
       combo.chat.name.indexOf("7B") > 0 &&
       combo.gen.image && combo.gen.image.name === "sdxl" &&
       combo.gen.video && combo.gen.video.name === "wan22-5b",
       "recommendSetup(8GB): T3, 7B chat, SDXL images, Wan video (got " +
       JSON.stringify({ t: combo.tier.id,
                        c: combo.chat && combo.chat.name,
                        i: combo.gen.image && combo.gen.image.name,
                        v: combo.gen.video && combo.gen.video.name }) + ")");
assert(/RTX 4060/.test(combo.copy) && /pauses chat/i.test(combo.copy),
       "…and its copy names the card and says generation pauses chat");

// ---------------------------------------------------------------------
// Catalog honesty: units, totals, and the real byte counts.
//
// Every sizeMB in version.js was written from training. Measured on
// 2026-08-30 by scripts/catalog-probe.js — a HEAD against each URL, whose
// redirect carries HuggingFace's `x-linked-size`, cross-checked against the
// copies already on the AE machine's disk. All twelve URLs answered.
//
// The bug class this pins is a UNIT: the catalog counted in decimal MB
// while everything downstream counts in MiB (nvidia-smi, tools.js
// modelFileMB, planHandoff's vramGB*1024), so every file was overstated by
// ~5%. The numbers below are bytes, exactly as the network reported them,
// and the assertion is the same division the panel does.

const MIB = 1048576;
const MEASURED_BYTES = {           // filename -> bytes, 2026-08-30
  "Qwen2.5-32B-Instruct-Q4_K_M.gguf": 19851336576,
  "Qwen2.5-14B-Instruct-Q4_K_M.gguf": 8988110976,
  "Qwen2.5-7B-Instruct-Q4_K_M.gguf": 4683074240,
  "Llama-3.2-3B-Instruct-Q4_K_M.gguf": 2019377696,
  "v1-5-pruned-emaonly-fp16.safetensors": 2132696762,
  "sd_xl_base_1.0.safetensors": 6938078334,
  "wan2.2_ti2v_5B_fp16.safetensors": 9999658848,
  "umt5_xxl_fp8_e4m3fn_scaled.safetensors": 6735906897,
  "wan2.2_vae.safetensors": 1409400960,
  "minimax_h3_fl2va_pruned_int8_convrot.safetensors": 20970379616,
  "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": 15687142551,
  "qwen3vl_32b_minimax_h3_int8_convrot.safetensors": 27141342152,
  "minimax_h3_video_vae_fp16.safetensors": 5207808496,
  "minimax_h3_audio_vae_fp32.safetensors": 605254808
};
function fileOf(url) {
  return decodeURIComponent(String(url).split("/").pop().split("?")[0]);
}

let sized = 0;
cat.forEach((m) => {
  assert(fileOf(m.url) === m.name,
         m.name + ": the URL's filename is the name it is saved under");
  const bytes = MEASURED_BYTES[m.name];
  assert(typeof bytes === "number", m.name + ": has a measured byte count");
  if (typeof bytes !== "number") return;
  sized++;
  assert(m.sizeMB === Math.round(bytes / MIB),
         m.name + ": sizeMB " + m.sizeMB + " is the file in MiB (" +
         Math.round(bytes / MIB) + "), not decimal MB (" +
         Math.round(bytes / 1e6) + ")");
});
assert(sized === 4, "all four chat models are covered by the capture");

window.AELL.COMFY_CATALOG.forEach((e) => {
  const urls = e.urls || [];
  urls.forEach((u) => {
    const f = fileOf(u.url);
    const bytes = MEASURED_BYTES[f];
    assert(typeof bytes === "number", e.name + "/" + f + ": measured");
    if (typeof bytes !== "number") return;
    assert(u.sizeMB === Math.round(bytes / MIB),
           e.name + "/" + f + ": sizeMB " + u.sizeMB + " is MiB (" +
           Math.round(bytes / MIB) + "), not decimal MB (" +
           Math.round(bytes / 1e6) + ")");
    assert(typeof u.dir === "string" && u.dir,
           e.name + "/" + f + ": names the models/ subfolder it lands in");
  });
  if (!urls.length) {
    assert(e.sizeMB === null,
           e.name + ": nothing to download, so no download total is quoted");
    return;
  }
  // The entry total is the only figure a user sees before agreeing to the
  // download; a total that disagrees with its own parts is a bug. Both Wan
  // 2.2 (17000 vs 17500) and MiniMax H3 (40543 vs 40503) shipped that way.
  const sum = urls.reduce((a, u) => a + u.sizeMB, 0);
  assert(e.sizeMB === sum,
         e.name + ": entry sizeMB " + e.sizeMB + " is the sum of its " +
         urls.length + " files (" + sum + ")");
});

// ---------------------------------------------------------------------------
// A `measured` VRAM figure has to BE a measurement.
//
// Every COMFY_CATALOG entry shipped `measured: false` and a minVramGB copied
// out of training. On 2026-08-30 scripts/catalog-vram-probe.js ran the
// shipped KREA2 template on a real 5090 and the card disagreed with the
// catalog by a factor of two: 24 160 MiB measured against a claimed 12 GB
// floor, and the three weights alone are 18 109 MiB, so no arrangement of
// offload makes 12 GB hold the job. entryFits() gates on minVramGB, so that
// number decides whether a card is offered a model it cannot run.
//
// These assertions are the bug class, not the instance: an entry may not
// claim to be measured without carrying the reading, and no entry's gate may
// sit below what was measured through it.
const MEASURED_FIELDS = ["measuredVramMB", "measuredSeconds", "measuredAt",
                         "measuredOn"];
let measuredEntries = 0;
window.AELL.COMFY_CATALOG.forEach((e) => {
  if (!e.measured) {
    MEASURED_FIELDS.forEach((f) => {
      assert(!(f in e), e.name + ": measured:false, so it carries no " + f);
    });
    return;
  }
  measuredEntries++;
  MEASURED_FIELDS.forEach((f) => {
    assert(e[f] !== undefined && e[f] !== null && e[f] !== "",
           e.name + ": measured:true, so it carries " + f);
  });
  assert(typeof e.measuredVramMB === "number" && e.measuredVramMB > 0,
         e.name + ": measuredVramMB is a real reading");
  assert(typeof e.measuredSeconds === "number" && e.measuredSeconds > 0,
         e.name + ": measuredSeconds is a real wall clock");
  // The size is half the number: a delta without the frame it was taken at
  // cannot be compared with anything.
  assert(/\d+\s*x\s*\d+/.test(String(e.measuredAt)),
         e.name + ": measuredAt names the pixel size it was measured at");
  assert(typeof e.minVramGB === "number",
         e.name + ": a measured entry still has a gate");
  assert(e.minVramGB * 1024 >= e.measuredVramMB,
         e.name + ": minVramGB " + e.minVramGB + " (" + (e.minVramGB * 1024) +
         " MiB) covers the measured " + e.measuredVramMB + " MiB");
});
assert(measuredEntries >= 1,
       "at least one catalog entry has had its VRAM figure measured");

// The one that was measured, pinned by name so a silent revert is a failure.
const krea2 = window.AELL.COMFY_CATALOG.filter((e) => e.name === "krea2")[0];
assert(!!krea2, "the catalog still holds krea2");
if (krea2) {
  assert(krea2.measured === true,
         "krea2: measured on real hardware 2026-08-30");
  assert(krea2.minVramGB === 24,
         "krea2: the 12 GB floor was disproved by measurement -> 24");
  // The weights are the floor and they are knowable without a GPU: the
  // entry's own file list is 18 109 MiB, so any gate under 18 GB is wrong
  // whatever the activations cost.
  assert(krea2.minVramGB * 1024 >= 18109,
         "krea2: the gate at least holds the weights it names");
}

// A workflowTemplate an entry names must be a template the panel BUNDLES,
// or the recommendation points at a graph that cannot be run.
const wfDir = path.join(__dirname, "..", "extension", "comfy-workflows");
window.AELL.COMFY_CATALOG.forEach((e) => {
  if (!e.workflowTemplate) return;
  assert(fs.existsSync(path.join(wfDir, e.workflowTemplate + ".json")),
         e.name + ": bundles its workflowTemplate " + e.workflowTemplate);
});

// ------------------------------------------------------------ WORKPLAN §18
//
// The line above used to open `if (!e.workflowTemplate) return;` — so an
// entry with NO template at all was silently skipped, and five of seven
// were in that state: recommendGen offered them, comfy_generate could not
// render them, catalog-vram-probe refused to measure them, and no test
// said a word. A check that returns the same answer for "this is fine"
// and "there is nothing here to check" is the bug class this repo keeps
// finding; here it was in the checker itself.
//
// Two allowlists replace the skip, and BOTH fail in both directions: a
// name removed while the gap remains, and a name still listed once the
// gap is closed. Shrinking them is the work; nothing may grow them
// without an entry in docs/WORKPLAN-LOG.md saying why.

// Entries that ship no graph yet. §18 P5-P10 empty this, except
// ltx-small, whose seat is PERMANENT until the owner pins its weights or
// drops the entry (Q1: postponed, 2026-09-06) — it has `urls: []`, so
// there is nothing to download and nothing to render.
const ALLOW_NO_TEMPLATE = ["sd15", "sdxl", "ltx-small", "wan22-5b",
                           "minimax-h3-int8"];

// Entries whose template has never been measured through
// catalog-vram-probe. EXISTENCE IS NOT PROOF: a graph can be committed,
// named by workflowTemplate, and never have rendered once. minimax-h3 is
// exactly that today — it HAS rendered end to end (LOG 2445-2515,
// 2026-08-27) but carries no measured block, so the arbiter still prices
// it from `minVramGB` alone.
const ALLOW_UNMEASURED = ["minimax-h3"];

{
  const noTemplate = window.AELL.COMFY_CATALOG
    .filter((e) => !e.workflowTemplate).map((e) => e.name).sort();
  assert(noTemplate.join(",") === ALLOW_NO_TEMPLATE.slice().sort().join(","),
         "the entries with no bundled graph are exactly the allowlisted " +
         "ones (add a template -> remove the name; add an entry -> give " +
         "it a template or list it)");
  if (noTemplate.join(",") !== ALLOW_NO_TEMPLATE.slice().sort().join(",")) {
    console.error("       allowlist: " + ALLOW_NO_TEMPLATE.slice().sort()
                  .join(", "));
    console.error("       actual   : " + noTemplate.join(", "));
  }

  const unmeasured = window.AELL.COMFY_CATALOG
    .filter((e) => e.workflowTemplate && !e.measured)
    .map((e) => e.name).sort();
  assert(unmeasured.join(",") === ALLOW_UNMEASURED.slice().sort().join(","),
         "every entry that ships a graph is MEASURED, except the " +
         "allowlisted ones — a committed template that never rendered is " +
         "not proof that it can");
  if (unmeasured.join(",") !== ALLOW_UNMEASURED.slice().sort().join(",")) {
    console.error("       allowlist: " + ALLOW_UNMEASURED.slice().sort()
                  .join(", "));
    console.error("       actual   : " + unmeasured.join(", "));
  }
}

// No consumer may do decimal-MB arithmetic on the field. main.js's model
// dropdown divided by 1000 while the downloader's status line divided by
// 1024, so one file was quoted two sizes in the same window.
const jsDir = path.join(__dirname, "..", "extension", "js");
fs.readdirSync(jsDir).filter((f) => /\.js$/.test(f)).forEach((f) => {
  const src = fs.readFileSync(path.join(jsDir, f), "utf8");
  const bad = src.match(/sizeMB\s*[\/*]\s*(1000|1e6|1000000)\b/g);
  assert(!bad, "extension/js/" + f + ": no decimal-MB arithmetic on " +
                "sizeMB" + (bad ? " (found " + bad.join(", ") + ")" : ""));
});

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
