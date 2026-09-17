/*
 * test-comfy-output-size.js — what `width`/`height` actually become.
 *
 * Filed by the tier-P4 catalog VRAM pass (WORKPLAN-LOG 2026-08-30) and
 * measured on the real backend: the shipped KREA2 template upscales the
 * latent 1.6x between its two passes, so `comfy_generate {width: 1024,
 * height: 1024}` returns a 1640x1640 image. That is deliberate in the
 * graph — 0.9.23 substituted `LatentUpscaleBy` for `SesquiLatentUpscale`
 * precisely so a machine without the pack would not render SMALLER — but
 * the tool documented width/height to the model as the OUTPUT size, and
 * nothing in the panel ever said otherwise. A model that plans a comp
 * around its own request plans it around the wrong number.
 *
 * Two halves are covered here:
 *   1. injectParams appends one honest line saying what the size becomes;
 *   2. it stays SILENT for every chain it cannot account for — the same
 *      rule the weight check (0.10.20) lives by, because a size note that
 *      is wrong sends a user looking for pixels that were never there.
 *
 * The arithmetic is the node's own: a LATENT upscale lands on the /8 grid
 * and multiplies back out, which is why 1024 becomes 1640 and not 1638.
 * The real shipped template is replayed at the bottom against both
 * numbers this machine has actually seen: 1640x1640 measured, and
 * 3072x1728 from the authored 1920x1080.
 */
"use strict";

const fs = require("fs");
const path = require("path");

let failures = 0;
let checks = 0;
function assert(cond, label) {
  checks++;
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}

const REPO = path.join(__dirname, "..");
const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => REPO },
  Settings: { dataRoot: () => REPO },
  setTimeout, clearTimeout, setInterval, clearInterval
};
eval(fs.readFileSync(path.join(REPO, "extension", "js", "comfy.js"), "utf8"));
const Comfy = window.Comfy;

/** The one line this feature exists to produce, or null. */
function sizeNote(graph, params) {
  const applied = Comfy.injectParams(graph, params || {}, null);
  for (const line of applied) {
    if (line.indexOf("is enlarged ") !== -1) return line;
  }
  return null;
}

// ------------------------------------------------------- the stub graph
//
// The KREA2 shape, reduced to the chain that decides a size: an empty
// latent, a sampler, the between-passes upscale, a second sampler, a
// decode, and the node that writes the file. `upscale` is spliced in by
// each case so one skeleton serves them all.

function chain(upscaleNode, opts) {
  opts = opts || {};
  const g = {
    "500": { class_type: "EmptyLatentImage",
             inputs: { width: 1920, height: 1080, batch_size: 1 } },
    "279": { class_type: "SamplerCustomAdvanced",
             inputs: { latent_image: ["500", 0] } },
    "450": { class_type: "SamplerCustomAdvanced",
             inputs: { latent_image: ["476", 0] } },
    "416": { class_type: "VAEDecode", inputs: { samples: ["450", 0] } },
    "474": { class_type: "SaveImage",
             inputs: { filename_prefix: "AELL/x", images: ["416", 0] } }
  };
  if (upscaleNode) g["476"] = upscaleNode;
  else g["450"].inputs.latent_image = ["279", 0];
  // A preview branch hanging off the FIRST pass, exactly as the shipped
  // graph has it. It is not an output node, so it must not count as a
  // second, disagreeing answer.
  if (opts.preview !== false) {
    g["415"] = { class_type: "VAEDecode", inputs: { samples: ["279", 0] } };
    g["478"] = { class_type: "PreviewImage", inputs: { images: ["415", 0] } };
  }
  return g;
}

const sesqui = () => ({ class_type: "SesquiLatentUpscale",
                        inputs: { model_format: "Wan 2.1", scale: 1.6,
                                  half_precision: false,
                                  latent: ["279", 0] } });
const upscaleBy = () => ({ class_type: "LatentUpscaleBy",
                           inputs: { upscale_method: "bislerp",
                                     scale_by: 1.6, samples: ["279", 0] } });

// ------------------------------------------------------- 1. it speaks up

{
  const note = sizeNote(chain(sesqui()), { width: 1024, height: 1024 });
  assert(note !== null, "a template that upscales says so");
  assert(/1640x1640/.test(note || ""),
         "and the number is the one the field measured, not 1638 " +
         "(latent upscales land on the /8 grid): " + note);
  assert(/1024x1024/.test(note || ""),
         "the requested size is named too, so the two are comparable: " +
         note);
  assert(/GENERATES/.test(note || ""),
         "and it says which of the two width/height set: " + note);
}

{
  // The class this graph becomes on a machine without the Sesqui pack.
  // The substitution keeps the factor, so the answer must not move.
  const note = sizeNote(chain(upscaleBy()), { width: 1024, height: 1024 });
  assert(/1640x1640/.test(note || ""),
         "the substituted LatentUpscaleBy reads the same: " + note);
}

{
  // Non-square, and only one dimension asked for: the other keeps the
  // template's own number and must still be scaled.
  const note = sizeNote(chain(sesqui()), { width: 1024 });
  assert(/size 1024x1080 /.test(note || "") && /1640x1728/.test(note || ""),
         "an un-set dimension keeps the template's value and scales with " +
         "it: " + note);
}

{
  // An IMAGE-space scale is plain arithmetic, not the /8 grid.
  const g = chain(sesqui());
  delete g["476"];
  g["450"].inputs.latent_image = ["279", 0];
  g["477"] = { class_type: "ImageScaleBy",
               inputs: { upscale_method: "lanczos", scale_by: 2,
                         image: ["416", 0] } };
  g["474"].inputs.images = ["477", 0];
  const note = sizeNote(g, { width: 1000, height: 1000 });
  assert(/2000x2000/.test(note || ""),
         "an image-space scale multiplies pixels directly: " + note);
}

{
  // Two of them compound.
  const g = chain(sesqui());
  g["477"] = { class_type: "LatentUpscaleBy",
               inputs: { upscale_method: "bislerp", scale_by: 2,
                         samples: ["450", 0] } };
  g["416"].inputs.samples = ["477", 0];
  const note = sizeNote(g, { width: 1024, height: 1024 });
  assert(/enlarged 3.2x/.test(note || "") && /3280x3280/.test(note || ""),
         "two upscales compound into one factor: " + note);
}

// ------------------------------------------------ 2. and otherwise it is
//                                                     silent
{
  assert(sizeNote(chain(null), { width: 1024, height: 1024 }) === null,
         "a template that does not enlarge says nothing");
}

{
  assert(sizeNote(chain(sesqui()), {}) === null,
         "and nothing at all when the caller set no size");
}

{
  const g = chain(sesqui());
  g["476"].inputs.scale = ["136", 0];              // a link, not a widget
  g["136"] = { class_type: "PrimitiveFloat", inputs: { value: 1.6 } };
  assert(sizeNote(g, { width: 1024, height: 1024 }) === null,
         "a factor that lives on another node is not guessed at");
}

{
  const g = chain(sesqui());
  g["476"].inputs.scale = 0;
  assert(sizeNote(g, { width: 1024, height: 1024 }) === null,
         "nor a factor that is not a positive number");
}

{
  // The factor is inside the .pth, and the graph cannot be read for it.
  const g = chain(null);
  g["477"] = { class_type: "ImageUpscaleWithModel",
               inputs: { upscale_model: ["490", 0], image: ["416", 0] } };
  g["490"] = { class_type: "UpscaleModelLoader",
               inputs: { model_name: "4x_foo.pth" } };
  g["474"].inputs.images = ["477", 0];
  assert(sizeNote(g, { width: 1024, height: 1024 }) === null,
         "a model-driven upscale is left alone rather than guessed");
}

{
  // Two savers that disagree: one answer cannot be given, so none is.
  const g = chain(sesqui());
  g["473"] = { class_type: "SaveImage",
               inputs: { filename_prefix: "AELL/first", images: ["415", 0] } };
  assert(sizeNote(g, { width: 1024, height: 1024 }) === null,
         "two output branches with different sizes get no single answer");
}

{
  // A chain that reaches nothing on disk. Silence, not a note about a
  // file that is never written.
  const g = chain(sesqui());
  delete g["474"];
  assert(sizeNote(g, { width: 1024, height: 1024 }) === null,
         "a chain that saves nothing produces no note");
}

{
  // An ABSOLUTE resize after the scale. injectParams has just written the
  // caller's own numbers into it, so the saved size IS the request and
  // there is nothing to warn about.
  const g = chain(sesqui());
  g["477"] = { class_type: "LatentUpscale",
               inputs: { upscale_method: "nearest-exact", width: 512,
                         height: 512, crop: "disabled",
                         samples: ["450", 0] } };
  g["416"].inputs.samples = ["477", 0];
  assert(sizeNote(g, { width: 1024, height: 1024 }) === null,
         "an absolute resize downstream makes the request the truth again");
  assert(g["477"].inputs.width === 1024,
         "STUB FIDELITY: injectParams really did write into it (" +
         g["477"].inputs.width + ")");
}

// ------------------------------------- 3. the SHIPPED template, replayed
//
// Both numbers below have been seen on this machine: 1640x1640 came back
// from a real render at width/height 1024, and 3072x1728 is what the
// catalog VRAM probe measured the authored template producing.

{
  // Moved out of the bundle by WORKPLAN 18 P8; kept as a fixture because
  // it is the only graph here whose output size is not its latent size.
  const file = path.join(REPO, "tests", "fixtures", "authored-krea2",
                         "AE_LLAMA_KREA2_V1.json");
  const load = () => JSON.parse(fs.readFileSync(file, "utf8"));

  const n1 = sizeNote(load(), { prompt: "x", width: 1024, height: 1024 });
  assert(/1640x1640/.test(n1 || ""),
         "the shipped KREA2 template reproduces the measured 1640x1640: " +
         n1);

  const n2 = sizeNote(load(), { prompt: "x", width: 1920, height: 1080 });
  assert(/3072x1728/.test(n2 || ""),
         "and its authored 1920x1080 reproduces the measured 3072x1728: " +
         n2);

  const n3 = sizeNote(load(), { prompt: "x" });
  assert(n3 === null, "a caller that set no size is told nothing new");
}

// ---------------------------------------- 4. the tool's own words, fixed

{
  const src = fs.readFileSync(
    path.join(REPO, "extension", "js", "tools.js"), "utf8");
  const at = src.indexOf('name: "comfy_generate"');
  assert(at > 0, "comfy_generate is still a tool");
  const def = src.slice(at, at + 2000);
  assert(/height\?: int \(generation size;/.test(def),
         "its args no longer call width/height the output size");
  assert(/result reports the size imported/.test(def),
         "and they point at where the real size comes from");
}

console.log("\n" + checks + " checks");
if (failures) {
  console.log(failures + " FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
