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
//
// The image pick was "sdxl" until 2026-09-09 and that was WRONG on this
// card, which is why the row moved rather than the assertion loosening.
// SDXL's minVramGB was 6, written from training; measured through the
// shipped AE_LLAMA_SDXL_T2I_V1 on the managed backend it costs 9472 MiB
// cold, and its checkpoint alone is 6617 MiB of resident weights. An 8 GB
// RTX 4060 cannot hold either number, so recommending SDXL to it was
// recommending a grind. The gate is 12 now and this card gets sd15
// (measured 2656 MiB), the largest image entry that actually fits it.
// See WORKPLAN 18 P6.
//
// The VIDEO pick moved the same way one day later and it is the bigger
// move: it was "wan22-5b" and it is now "ltx-small". wan22-5b's gate was
// 8, written from training; measured through the shipped
// AE_LLAMA_WAN22_5B_T2V_V1 on the managed backend the authored job costs
// 26 187 MiB, and a third run at 704x480 -- a third of the pixels -- still
// cost 21 536 MiB, because the floor is the 17 304 MiB of resident weights
// and not the frame. So no size this panel can inject fits Wan 2.2 5B on
// an 8 GB card, the gate is 32, and this row now asserts what an 8 GB
// buyer is actually offered.
//
// UPDATED 2026-09-16, and the update is that this row now asserts
// v: null. ltx-small used to be what an 8 GB card was offered, on a
// minVramGB of 6 that was written from nothing -- no weights, no graph,
// never rendered. WORKPLAN 18 P7c step 2 pinned it to a real LTX-Video 2B
// build and measured it through the shipped AE_LLAMA_LTXV_2B_T2V_V1:
// 13 921 MiB, so the gate is 16.
//
// So the VIDEO floor across the whole catalog went 32 -> 16 (a 16 GB card
// has a runnable video graph for the first time) and at the same time this
// 8 GB card lost the offer it had. Both halves are the same measurement
// and both are the honest answer. It does NOT get a worse offer than
// before -- it gets no offer, where before it got a recommendation for an
// entry with no weights to download and no graph to run, which could only
// ever have failed in the buyer's hands.
//
// The gap is therefore narrower but real, and it is WORKPLAN 18 P7a's
// remaining question. This row pins v: null deliberately: if some future
// change hands an 8 GB card a video entry again, it must be because
// something was MEASURED to fit, and this assertion is what forces that
// to be said out loud. 18 P7c step 2a is the next lever on it.
// See WORKPLAN 18 P7, 18 P6a and 18 P7c.
const combo = window.Setup.recommendSetup(null,
  { hasNvidia: true, name: "RTX 4060", vramGB: 8, computeCap: 8.9 });
assert(combo.tier.id === "T3" && combo.chat &&
       combo.chat.name.indexOf("7B") > 0 &&
       combo.gen.image && combo.gen.image.name === "sd15" &&
       combo.gen.video === null,
       "recommendSetup(8GB): T3, 7B chat, sd15 images, and NO video at " +
       "all -- Wan 2.2 5B measured 26 187 MiB and LTX-Video 2B is gated " +
       "at 12 (18 P7c step 2f), and 8 GB is not measured (got " +
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
  // 2026-09-16, WORKPLAN 18 P7c step 2. The checkpoint was stat'd after the
  // download that measured ltx-small; the encoder was stat'd on disk AND
  // cross-checked against the HuggingFace content-length, which matched to
  // the byte -- worth recording, because that equality is the fact 18 P7b is
  // about: the file the panel's downloader would fetch is already here.
  "ltxv-2b-0.9.6-dev-04-25.safetensors": 6340743924,
  "t5xxl_fp8_e4m3fn_scaled.safetensors": 5157348688,
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
// Video-only companions to the four above: same rule, an entry that has not
// been measured may not carry any of them either.
const MEASURED_VIDEO_FIELDS = ["measuredClipSeconds", "authoredClipSeconds",
                               "authoredNote"];
const BUNDLE_DIR = path.join(__dirname, "..", "extension", "comfy-workflows");
let measuredEntries = 0;
window.AELL.COMFY_CATALOG.forEach((e) => {
  if (!e.measured) {
    MEASURED_FIELDS.concat(MEASURED_VIDEO_FIELDS).forEach((f) => {
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
  // For a VIDEO entry the frame is only half the size. The latent is
  // frames x pixels, so the same graph at two lengths is two different
  // jobs on the card — H3's authored 15 s and a 2 s decomposition of it
  // are not the same measurement, and a row carrying only "1920x1080"
  // cannot say which one it is. The pixel-size rule above passes either
  // way, which is exactly how that gap would ship.
  if (e.kind === "video") {
    assert(/\b\d+(\.\d+)?\s*(s\b|sec|seconds|f\b|frames)/i
             .test(String(e.measuredAt)),
           e.name + ": a video entry's measuredAt names the clip LENGTH " +
           "as well (seconds or frames)");
    // Prose is for the human reading the catalog; this is for the check.
    // A length only spelled out in a sentence cannot be compared with the
    // template it came from.
    assert(typeof e.measuredClipSeconds === "number" &&
           e.measuredClipSeconds > 0,
           e.name + ": a measured video entry carries measuredClipSeconds " +
           "(the clip length the reading was taken at, as a number)");
    assert(String(e.measuredAt).indexOf(String(e.measuredClipSeconds)) !== -1,
           e.name + ": and measuredAt states the same length that number does");

    // THE ONE THAT MATTERS, and the reason this rule exists at all.
    // `catalog-vram-probe --duration` lets a pass measure a video at a
    // length that finishes: H3's AUTHORED 15 s was still sampling at 901 s
    // on an RTX 5090 and had to be cancelled, so the only completed reading
    // this catalog can hold is a 2 s decomposition of it. Publishing that
    // is honest ONLY if the row also says what the panel renders when the
    // user names no length, because THAT is the job the buyer is given.
    // Without this, the catalog quotes a render nobody gets and nothing in
    // the repo notices. The authored length is not a matter of opinion — it
    // is the widget value in the entry's own shipped API template, reached
    // through that template's manifest, so this reads it rather than
    // trusting a number typed into version.js.
    if (e.workflowTemplate) {
      const api = path.join(BUNDLE_DIR, e.workflowTemplate + ".json");
      const mfp = path.join(BUNDLE_DIR, e.workflowTemplate + ".manifest.json");
      if (fs.existsSync(api) && fs.existsSync(mfp)) {
        const graph = JSON.parse(fs.readFileSync(api, "utf8"));
        const mf = JSON.parse(fs.readFileSync(mfp, "utf8"));
        const ptr = (mf.procedural || {}).durationSeconds;
        const node = ptr && graph[String(ptr.nodeId)];
        let authored = node
          ? Number((node.inputs || {})[ptr.input || "value"]) : 0;
        // Named on BOTH paths. The message used to interpolate ptr.nodeId,
        // which is undefined the moment the length is read from the graph
        // instead of a durationSeconds pointer — so the failure this rule
        // exists to report arrived as a TypeError that killed the run
        // before the remaining assertions ever executed.
        let where = node ? ("node " + ptr.nodeId) : "";
        // A manifest's procedural.durationSeconds was the ONLY way this
        // check could read a template's authored length, and most video
        // graphs do not have one. H3 does because its own math node
        // converts seconds to a frame grid; the wan22-5b basic does not,
        // because its latent node carries a literal frame COUNT — which is
        // the shape injectParams' generic frame walk expects, so declaring
        // durationSeconds there would be wrong (comfy.js frameKeys, and
        // that manifest's whyNoDurationSeconds).
        //
        // The hole that left: for every frames-based video template the
        // block above silently measured nothing, so an entry could quote a
        // short reading with no authoredNote and pass — the exact defect
        // this rule exists to catch, exempting the majority of the graphs
        // it is meant to police. Verified by reintroducing it: dropping
        // wan22-5b's authoredClipSeconds passes without this and fails
        // with it. Fall back to the graph's own frame key over the
        // CreateVideo fps, which is where the length physically lives.
        if (!(authored > 0)) {
          const FRAME_KEYS = ["length", "frames", "video_frames", "num_frames"];
          let frames = 0, fps = 0;
          Object.keys(graph).forEach((id) => {
            const n = graph[id] || {};
            const ins = n.inputs || {};
            if (!frames) {
              FRAME_KEYS.forEach((k) => {
                if (!frames && typeof ins[k] === "number") frames = ins[k];
              });
            }
            if (!fps && typeof ins.fps === "number") fps = ins.fps;
          });
          if (frames > 0 && fps > 0) {
            // Two decimals, because that is the precision a catalog row
            // can state and measuredAt has to repeat it verbatim.
            authored = Math.round((frames / fps) * 100) / 100;
            where = frames + " frames / " + fps + " fps";
          }
        }
        if (authored > 0) {
          assert(e.authoredClipSeconds === authored,
                 e.name + ": authoredClipSeconds is the template's OWN " +
                 "default (" + authored + " s from " + where + "), " +
                 "so the row says what a user who names no length gets");
          if (authored !== e.measuredClipSeconds) {
            assert(typeof e.authoredNote === "string" &&
                   e.authoredNote.length > 20,
                   e.name + ": the reading was taken at " +
                   e.measuredClipSeconds + " s but the panel's default " +
                   "renders " + authored + " s, so the entry must carry an " +
                   "authoredNote saying so — a shorter measurement quoted " +
                   "without it describes a job the buyer is not given");
          }
        }
      }
    }
  }
  /* The SIZE half of the same rule, and the defect it was written from.
   * A video entry's clip length is read out of its own template above; its
   * PIXEL size, and every image entry's, was taken on trust from a string
   * typed into version.js. WORKPLAN 18 P8 is what that costs: krea2's graph
   * was replaced (the owner's authored two-pass AE_LLAMA_KREA2_V1 left the
   * bundle for the core-only AE_LLAMA_KREA2_T2I_V1) and the entry kept a
   * measuredAt of "3072x1728 (the template's authored size)" -- a size the
   * shipped template no longer renders, attached to a VRAM figure for a
   * graph nobody runs. Nothing in the repo could have said so.
   *
   * The authored size is not a matter of opinion either: it is the literal
   * width+height on the template's own latent/video node, the same pair
   * injectParams overwrites when the user names a size (comfy.js). Read it
   * and require measuredAt to repeat it.
   *
   * A template with NO literal width+height node is SKIPPED rather than
   * assumed innocent -- H3 is one, because its size arrives as MEGAPIXELS
   * through a ResolutionSelector and there is no pixel pair in the graph to
   * compare against. So is a template whose nodes disagree on the size:
   * that is a real shape (a two-pass graph rendering at one size and
   * upscaling to another) and guessing which one was measured would be the
   * same trust this rule exists to remove. */
  if (e.workflowTemplate) {
    const sizeApi = path.join(BUNDLE_DIR, e.workflowTemplate + ".json");
    if (fs.existsSync(sizeApi)) {
      const g = JSON.parse(fs.readFileSync(sizeApi, "utf8"));
      const pairs = {};
      Object.keys(g).forEach((id) => {
        const ins = (g[id] || {}).inputs || {};
        if (typeof ins.width === "number" && typeof ins.height === "number") {
          pairs[ins.width + "x" + ins.height] = (g[id] || {}).class_type;
        }
      });
      const sizes = Object.keys(pairs);
      if (sizes.length === 1) {
        const stated = String(e.measuredAt).replace(/\s*x\s*/gi, "x");
        assert(stated.indexOf(sizes[0]) !== -1,
               e.name + ": measuredAt names the size its OWN shipped " +
               "template renders (" + sizes[0] + ", the literal " +
               "width+height on its " + pairs[sizes[0]] + "), not " +
               String(e.measuredAt) + " -- a reading taken at another size, " +
               "or kept across a change of graph, prices a job the buyer " +
               "is not given");
      }
    }
  }
  assert(typeof e.minVramGB === "number",
         e.name + ": a measured entry still has a gate");
  /* A gate BELOW the unconstrained reading is allowed on exactly one kind
   * of evidence, added 2026-09-16 (WORKPLAN 18 P7c step 2g, NEXT UP 5a-4c).
   * The old premise -- "0.10.14 measured that a job outgrowing the card
   * GRINDS" -- did not reproduce on the managed backend: DynamicVRAM
   * streams weights, so on a 5090 ballasted down to a small card's room the
   * job shrinks to fit. A card with room cannot show that, so
   * measuredVramMB (taken WITH room) overstates what the job needs.
   *
   * This is not a looser check, it is a different measurement with its
   * own bar, and every part of it is required:
   *   roomMB     what the backend was left, no more than the gate's card
   *              minus After Effects' resident footprint (tiers.js)
   *   seconds    within 2x the unconstrained measuredSeconds -- a grind
   *              is the thing this replaces, so the clock is the evidence
   *   identical  the output matches the unconstrained run byte for byte
   *              (png md5 / decoded-frame md5); a quietly different
   *              picture is worse than a slow one (5a-4b)
   *   on         where and with which boot flags, because a reading taken
   *              on a backend that no longer ships describes nothing */
  const AE_MB = window.Tiers.hostReserveMB() - window.Tiers.desktopFreeMB();
  const cf = e.constrainedFit;
  if (e.minVramGB * 1024 < e.measuredVramMB) {
    assert(!!cf && typeof cf === "object",
           e.name + ": minVramGB " + e.minVramGB + " (" + (e.minVramGB * 1024) +
           " MiB) is under the measured " + e.measuredVramMB + " MiB, so it " +
           "carries a constrainedFit reading");
  } else {
    assert(e.minVramGB * 1024 >= e.measuredVramMB,
           e.name + ": minVramGB " + e.minVramGB + " (" + (e.minVramGB * 1024) +
           " MiB) covers the measured " + e.measuredVramMB + " MiB");
  }
  if (cf) {
    assert(typeof cf.roomMB === "number" && cf.roomMB > 0 &&
           cf.roomMB <= e.minVramGB * 1024 - AE_MB,
           e.name + ": constrainedFit.roomMB " + cf.roomMB + " is no more " +
           "than a " + e.minVramGB + " GB card leaves after After Effects (" +
           (e.minVramGB * 1024 - AE_MB) + " MiB)");
    assert(typeof cf.seconds === "number" &&
           cf.seconds <= 2 * e.measuredSeconds,
           e.name + ": constrainedFit.seconds " + cf.seconds + " is within " +
           "2x the unconstrained " + e.measuredSeconds + " s -- over that is " +
           "the grind the gate exists to refuse");
    assert(cf.identical === true,
           e.name + ": constrainedFit output is identical to the " +
           "unconstrained run");
    assert(typeof cf.on === "string" && /disable-pinned-memory/.test(cf.on),
           e.name + ": constrainedFit names the boot it was taken on, and " +
           "it is the shipped unpinned one (0.12.26)");
  }
  // recommendFromGB holds a DEFAULT where the unconstrained reading put it
  // while the gate moves (tiers.js recommendFloor). It exists only beside a
  // constrained fit, never as a free knob, and never below the gate.
  if ("recommendFromGB" in e) {
    assert(!!cf, e.name + ": recommendFromGB only beside a constrainedFit");
    assert(typeof e.recommendFromGB === "number" &&
           e.recommendFromGB >= e.minVramGB &&
           e.recommendFromGB * 1024 >= e.measuredVramMB,
           e.name + ": recommendFromGB " + e.recommendFromGB + " is at or " +
           "above the gate and covers the unconstrained reading");
  }
});
assert(measuredEntries >= 1,
       "at least one catalog entry has had its VRAM figure measured");

// The one that was measured, pinned by name so a silent revert is a failure.
const krea2 = window.AELL.COMFY_CATALOG.filter((e) => e.name === "krea2")[0];
assert(!!krea2, "the catalog still holds krea2");
if (krea2) {
  assert(krea2.measured === true,
         "krea2: measured on real hardware 2026-08-30");
  // 24 -> 12 on 2026-09-16 (18 P7c step 2g). The weights are 18 109 MiB
  // and the old rule was "the gate holds them", because 0.10.14 said a job
  // outgrowing the card grinds. On the managed backend it does not: run
  // with a 12 GB card's room it streamed the weights and rendered the same
  // png. So the 12 is pinned WITH the reading that earned it, and the
  // default stays at 24 until the owner moves it.
  assert(krea2.minVramGB === 12 && !!krea2.constrainedFit,
         "krea2: gate 12, earned by a constrained-card run, not by arithmetic");
  assert(krea2.recommendFromGB * 1024 >= 18109,
         "krea2: it is only RECOMMENDED on a card that holds its weights");
}

// ---------------------------------------------------------------------
// A gate has to hold the biggest single file the graph loads — and this
// is checked for UNMEASURED entries too.
//
// The rule above ("minVramGB covers measuredVramMB") is the right rule
// and it is why sdxl's gate was wrong for months without anything
// noticing: it only fires on `measured: true`, so an entry written from
// training was exempt from the one check that would have caught it.
// sdxl shipped minVramGB 6 while its checkpoint alone is 6617 MiB —
// larger than the whole 6144 MiB card it was being offered to — and the
// contradiction needed no GPU, no backend and no measurement to see.
// Measured 2026-09-09 it costs 9472 MiB cold and the gate is 12 now
// (WORKPLAN 18 P6).
//
// The LARGEST file rather than the total, deliberately. A multi-file
// entry may free its text encoder before sampling, so "the sum must fit"
// is not true of minimax-h3 (40 503 MiB across four files, gate 32) and
// a rule that says it is would be a rule this catalog has to be exempted
// from. But nothing lets a sampler hold less than its one biggest
// tensor file, and 0.10.14 measured what this backend does when a job
// outgrows the card: it does not OOM, it GRINDS.
//
// Entries whose files carry no per-file size (krea2) cannot be checked
// here and are skipped rather than assumed innocent.
// EMPTY as of 2026-09-09. wan22-5b was this list's only seat and it is
// gone the way the item asked for: measured, not argued. Its gate was 8
// against a 9536 MiB single file; the shipped graph costs 26 187 MiB and
// the gate is 32 (WORKPLAN 18 P7). The list stays, and stays checked in
// BOTH directions, because the rule it encodes is the cheap one — it
// needs no GPU, and it is what caught wan22-5b before any card did.
const GATE_UNDER_ITS_BIGGEST_FILE = [];

/* The entries the rule below cannot ask the question OF, named rather than
 * silently skipped (WORKPLAN 18 P8a). krea2 carries `urls: []`, so there are
 * no per-file sizes to compare a gate against -- its weights are
 * owner-supplied and listed in `files` as bare names. An unnamed skip is the
 * same defect as the one the comment below this block describes -- a check
 * answering "fine" and "nothing here to check" identically -- so this fails
 * in BOTH directions too: give krea2's files their sizes and its seat must
 * go.
 *
 * ltx-small LEFT this list 2026-09-16 (WORKPLAN 18 P7c step 2). It was the
 * other seat for exactly the reason the old comment gave -- "no weights
 * pinned at all" -- and pinning them is what removed it. Its biggest file is
 * now 6047 MiB against a gate the measurement set, so the rule below can ask
 * the question and does. */
const NO_FILE_SIZES_TO_CHECK = ["krea2"];
{
  const offenders = [];
  const unaskable = [];
  window.AELL.COMFY_CATALOG.forEach((e) => {
    const sizes = (e.urls || []).map((u) => u.sizeMB)
      .filter((n) => typeof n === "number" && n > 0);
    if (!sizes.length) unaskable.push(e.name);
    if (!sizes.length || typeof e.minVramGB !== "number") return;
    let biggest = 0;
    sizes.forEach((n) => { if (n > biggest) biggest = n; });
    if (e.minVramGB * 1024 < biggest) {
      offenders.push(e.name + " (gate " + (e.minVramGB * 1024) +
                     " MiB < biggest file " + biggest + " MiB)");
    }
  });
  const seen = offenders.map((o) => o.split(" ")[0]).sort();
  // Both directions: fixing wan22-5b's gate must REMOVE its seat, and a
  // new entry may not quietly join the list.
  assert(seen.join(",") === GATE_UNDER_ITS_BIGGEST_FILE.slice().sort().join(","),
         "the entries whose gate is under their own biggest weight file " +
         "are exactly the allowlisted ones",
         offenders.join("; ") || "none");
  if (seen.join(",") !== GATE_UNDER_ITS_BIGGEST_FILE.slice().sort().join(",")) {
    console.error("       allowlist: " +
                  GATE_UNDER_ITS_BIGGEST_FILE.slice().sort().join(", "));
    console.error("       actual   : " + (offenders.join("; ") || "none"));
  }

  assert(unaskable.slice().sort().join(",") ===
         NO_FILE_SIZES_TO_CHECK.slice().sort().join(","),
         "the entries the biggest-file rule cannot ask about are exactly " +
         "the ones named as such",
         unaskable.join(", ") || "none");
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

// Entries that ship no graph yet. EMPTY as of 2026-09-16, and the seat
// that emptied it was the one this comment called PERMANENT.
//
// ltx-small's seat was held on the stated ground that it had `urls: []`,
// "so there is nothing to download and nothing to render", pending the
// owner answering Q1. That turned out to be a question a pass could
// answer by measuring rather than one needing a decision: the entry was
// imagining a model line that does exist, core ComfyUI still supports it
// (30 LTX classes on the managed backend, all comfy_extras), and the
// vendor ships the graph. So the weights are pinned, the graph is
// AE_LLAMA_LTXV_2B_T2V_V1, and it has rendered (WORKPLAN 18 P7c step 2).
// What is still the owner's is narrower and is filed as 18 P7c step 2b:
// the licence is LTXV Open Weights, not Apache-2.0.
// sd15 left this list 2026-09-09 (WORKPLAN 18 P5): it ships
// AE_LLAMA_SD15_T2I_V1 and that graph has rendered on the managed
// backend and imported into AE. sdxl left it the same day (P6), and
// wan22-5b the same day (P7) with AE_LLAMA_WAN22_5B_T2V_V1, which
// rendered 1280x704 x 121 frames twice on the managed backend.
// minimax-h3-int8 left it 2026-09-09 (P10) with AE_LLAMA_H3_INT8_T2V_V1,
// the nvfp4 sibling's graph with the text encoder swapped, rendered on
// the managed backend. ltx-small left it 2026-09-16 with
// AE_LLAMA_LTXV_2B_T2V_V1 and emptied the list; §18 P12 asked for exactly
// this. It may not grow without an entry in docs/WORKPLAN-LOG.md saying why.
const ALLOW_NO_TEMPLATE = [];

// Entries whose template has never been measured through
// catalog-vram-probe. EXISTENCE IS NOT PROOF: a graph can be committed,
// named by workflowTemplate, and never have rendered once.
//
// EMPTY as of 2026-09-09 (§18 P3): minimax-h3 was the last seat and it now
// carries a measured block taken on the managed backend. §18 P12 asked for
// exactly this, so the list stays empty — a new entry with a graph must be
// measured before it ships, not allowlisted. Adding a name back needs an
// entry in docs/WORKPLAN-LOG.md saying why.
const ALLOW_UNMEASURED = [];

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

// ---------------------------------------------------------------------
// wan22-5b and wan22-5b-fp8 are TWO ENTRIES OVER ONE DOWNLOAD.
//
// There is no fp8 build of the Wan 2.2 ti2v 5B to download. Comfy-Org
// publishes that model in fp16 only -- checked against the HF tree API on
// 2026-09-16, when every fp8_scaled file in
// Comfy-Org/Wan_2.2_ComfyUI_Repackaged/split_files/diffusion_models was a
// 14B variant. WORKPLAN 18 P7c step 1 was written expecting one and it is
// not there. The fp8 entry is the SAME file cast at load time by core
// UNETLoader's weight_dtype, so its urls[] and sizeMB are identical to the
// fp16's on purpose: a buyer who has one has both, and the panel must
// never ask them to download 17 GB twice.
//
// The bug class: a future pass reads "fp8" in the entry and gives it its
// own urls[] -- either a duplicate of the fp16 under a new name (17 GB of
// wasted disk, the 18 P7b defect again) or a guessed fp8 URL that 404s.
// Pinned by equality rather than by a comment, because a comment did not
// stop it last time.
{
  const cat = window.AELL.COMFY_CATALOG;
  const fp16 = cat.filter((e) => e.name === "wan22-5b")[0];
  const fp8 = cat.filter((e) => e.name === "wan22-5b-fp8")[0];
  assert(fp16 && fp8, "both Wan 2.2 5B entries are in the catalog");
  if (fp16 && fp8) {
    assert(JSON.stringify(fp8.urls) === JSON.stringify(fp16.urls),
           "wan22-5b-fp8 downloads exactly what wan22-5b downloads -- the " +
           "same files in the same order (there is no fp8 file to fetch)");
    assert(fp8.sizeMB === fp16.sizeMB,
           "and it therefore quotes the same sizeMB (" + fp16.sizeMB + ")");
    assert(fp8.workflowTemplate !== fp16.workflowTemplate,
           "but it is a SEPARATE graph, because the two entries carry " +
           "different measurements and a gate must belong to the thing it " +
           "was measured on");

    // The reading is the whole reason the entry exists. If the cast ever
    // stops being cheaper, the entry is dead weight and should be deleted
    // rather than shipped as a choice that costs a buyer more.
    assert(typeof fp8.measuredVramMB === "number" &&
           typeof fp16.measuredVramMB === "number" &&
           fp8.measuredVramMB < fp16.measuredVramMB,
           "the fp8 cast measured CHEAPER than the fp16 it casts (" +
           fp8.measuredVramMB + " vs " + fp16.measuredVramMB + " MiB)");

    // 18 P7c step 3 reports, it does not choose: the cast did NOT move the
    // gate, and the catalog must keep saying so. 24 314 MiB is 23.7 GiB
    // and a 24 GB card is 24 564 MiB in total, so the job's own delta
    // leaves it 250 MiB for Windows. If a future measurement really does
    // bring this under a 24 GB card, change this line deliberately and say
    // what moved -- do not let it drift.
    assert(fp8.minVramGB === fp16.minVramGB,
           "and the cast did NOT move the gate: both Wan entries still " +
           "need " + fp16.minVramGB + " GB (WORKPLAN 18 P7a is still open)");
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
