/*
 * test-workflow-resolve.js — WHICH template a generation runs when the
 * model named none.
 *
 * WORKPLAN §18 P1. It used to be `list[0]` — the alphabet — and
 * test-comfy-workflow-choice.js pinned that as correct because nothing
 * better existed. With the shipped bundle it means "a picture of a red
 * apple" is handed to AE_LLAMA_H3_I2V_V1: a 40 GB Blackwell-only VIDEO
 * graph, chosen because ae_llama_h3 sorts before ae_llama_krea2.
 *
 * Comfy.resolveWorkflow is pure — descriptions, wants, tier context and
 * three injected predicates in, a choice out — so the whole matrix runs
 * here with no ComfyUI, no GPU and no AE. That purity is the point: the
 * decision happens BEFORE any tool runs, so it is invisible to the real-AE
 * harness and to comfy-probe alike.
 */
"use strict";

const fs = require("fs");
const path = require("path");

let failures = 0;
function assert(cond, label, detail) {
  console.log((cond ? "ok  - " : "FAIL- ") + label +
              (detail ? "  (" + detail + ")" : ""));
  if (!cond) failures++;
}

const win = {
  AEBridge: { nodeRequire: require },
  Settings: { get: () => ({}), dataRoot: () => "/tmp" },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  console, setTimeout, clearTimeout
};
new Function("window", fs.readFileSync(
  path.join(__dirname, "..", "extension", "js", "comfy.js"), "utf8"))(win);
const Comfy = win.Comfy;

// Shorthand: a described template.
function d(name, kind, opts) {
  return Object.assign({
    name: name, file: "/x/" + name + ".json", example: false,
    kind: kind, catalogEntry: name.toLowerCase(),
    takesImage: false, requiresImage: false, lengthIn: "frames"
  }, opts || {});
}

const IMAGE = d("AE_LLAMA_KREA2_V1", "image");
const VIDEO = d("AE_LLAMA_H3_I2V_V1", "video", { takesImage: true });

// 1. Kind decides, and it inverts the alphabet.
{
  const r = Comfy.resolveWorkflow([VIDEO, IMAGE], { kind: "image" }, null, {});
  assert(r.chosen && r.chosen.name === "AE_LLAMA_KREA2_V1",
         "a picture request picks the IMAGE template, not the video graph " +
         "that sorts first", r.chosen && r.chosen.name);

  const v = Comfy.resolveWorkflow([VIDEO, IMAGE], { kind: "video" }, null, {});
  assert(v.chosen && v.chosen.name === "AE_LLAMA_H3_I2V_V1",
         "a clip request picks the VIDEO template", v.chosen && v.chosen.name);
}

// 2. The format example is never chosen, even when it is the only thing
//    of the right kind. 0.9.28 measured a generation running the
//    placeholder because it was listed with equal standing.
{
  const ex = d("example-txt2img", "image", { example: true });
  const r = Comfy.resolveWorkflow([ex, VIDEO], { kind: "image" }, null, {});
  assert(r.chosen && r.chosen.name !== "example-txt2img",
         "the format example is never the default",
         r.chosen && r.chosen.name);
  const only = Comfy.resolveWorkflow([ex], { kind: "image" }, null, {});
  assert(!only.chosen && /format examples/.test(only.why),
         "and with nothing else it refuses, naming what those files are",
         only.why);
}

// 3. A template the user switched off is never chosen.
{
  const off = { AE_LLAMA_KREA2_V1: { enabled: false } };
  const r = Comfy.resolveWorkflow([VIDEO, IMAGE],
                                  { kind: "image", disabled: off }, null, {});
  assert(r.chosen && r.chosen.name !== "AE_LLAMA_KREA2_V1",
         "a disabled template is not run", r.chosen && r.chosen.name);
  // Absent means ENABLED — only the opt-OUT is recorded, so a template
  // arriving in an update is usable with no settings migration.
  const on = Comfy.resolveWorkflow([VIDEO, IMAGE],
                                   { kind: "image", disabled: {} }, null, {});
  assert(on.chosen.name === "AE_LLAMA_KREA2_V1",
         "and a name absent from the map is enabled, not disabled");
}

// 4. requiresImage. A true i2v/img2img graph cannot run without one: the
//    detach primitive can DELETE a LoadImage node but cannot rewire a
//    sampler's latent from EmptyLatentImage to VAEEncode. Without this
//    the graph keeps its authored filename — a file that exists on one
//    machine — and dies inside ComfyUI after the queue.
{
  const i2v = d("AE_LLAMA_IMG2IMG_V1", "image",
                { takesImage: true, requiresImage: true });
  const noImg = Comfy.resolveWorkflow([i2v, IMAGE], { kind: "image" },
                                      null, {});
  assert(noImg.chosen.name === "AE_LLAMA_KREA2_V1",
         "with no image, a template that REQUIRES one is skipped",
         noImg.chosen.name);

  const withImg = Comfy.resolveWorkflow([i2v, IMAGE],
    { kind: "image", image: "C:\\x.png" }, null, {});
  assert(withImg.chosen.name === "AE_LLAMA_IMG2IMG_V1",
         "with an image, the template that takes one wins",
         withImg.chosen.name);

  // A refusal that names the wrong cause sends the user to the wrong
  // setting. "Nothing is enabled" would point at the Workflows toggles
  // when the real answer is "give me an image".
  const onlyReq = Comfy.resolveWorkflow([i2v], { kind: "image" }, null, {});
  assert(!onlyReq.chosen && /needs a reference image/.test(onlyReq.why) &&
         /image: <absolute path>/.test(onlyReq.why),
         "and when it is the ONLY candidate the refusal names THAT cause " +
         "and the argument that fixes it", onlyReq.why);

  const allOff = Comfy.resolveWorkflow([IMAGE],
    { kind: "image", disabled: { AE_LLAMA_KREA2_V1: { enabled: false } } },
    null, {});
  assert(/switched off in Settings/.test(allOff.why),
         "while everything disabled names the SETTING instead",
         allOff.why);
}

// 5. Fit comes FIRST. Never hand a card a graph it cannot hold while one
//    it can is sitting there — the 8 GB case the tier work is about.
{
  const big = d("AE_LLAMA_BIG_V1", "image");
  const small = d("AE_LLAMA_SMALL_V1", "image");
  const r = Comfy.resolveWorkflow([big, small], { kind: "image" }, null, {
    fits: (x) => x.name !== "AE_LLAMA_BIG_V1"
  });
  assert(r.chosen.name === "AE_LLAMA_SMALL_V1",
         "a template that does not fit this card loses to one that does",
         r.chosen.name);
  // But it is never EXCLUDED: an unfit template still beats nothing, and
  // the grounded refusal from the backend is better than a silent "no
  // generation is possible".
  const onlyBig = Comfy.resolveWorkflow([big], { kind: "image" }, null, {
    fits: () => false
  });
  assert(onlyBig.chosen && onlyBig.chosen.name === "AE_LLAMA_BIG_V1",
         "but an unfit template is still offered when it is all there is");
}

// 6. Weights on disk beat weights that are not.
{
  const here = d("AE_LLAMA_HERE_V1", "image");
  const gone = d("AE_LLAMA_ABSENT_V1", "image");
  const r = Comfy.resolveWorkflow([gone, here], { kind: "image" }, null, {
    weightsPresent: (x) => x.name === "AE_LLAMA_HERE_V1"
  });
  assert(r.chosen.name === "AE_LLAMA_HERE_V1",
         "a template whose weights are on this disk wins", r.chosen.name);
}

// 7. THE BASELINE TIEBREAK. Under the §18 reframe the owner's own
//    authored graphs become a personal layer beside the shipped basics,
//    so a machine holds BOTH for one catalog entry: same kind, same fit,
//    same weights. Everything ties and the old ordering falls through to
//    NAME — where AE_LLAMA_KREA2_T2I_V1 beats AE_LLAMA_KREA2_V1 by
//    alphabet alone. That is luck, not design; the catalog entry's own
//    workflowTemplate says which is the baseline.
{
  const basic = d("AE_LLAMA_KREA2_T2I_V1", "image");
  const authored = d("AE_LLAMA_KREA2_V1", "image");
  // Name order would pick the basic here anyway — so prove it the hard
  // way, with the BASELINE being the one that sorts LAST.
  const r = Comfy.resolveWorkflow([basic, authored], { kind: "image" },
    null, { baseline: (x) => x.name === "AE_LLAMA_KREA2_V1" });
  assert(r.chosen.name === "AE_LLAMA_KREA2_V1",
         "the catalog's own workflowTemplate wins a tie, even against a " +
         "name that sorts before it", r.chosen.name);

  // And with no baseline predicate at all it degrades to name order
  // rather than throwing.
  const plain = Comfy.resolveWorkflow([authored, basic], { kind: "image" },
                                      null, {});
  assert(plain.chosen.name === "AE_LLAMA_KREA2_T2I_V1",
         "with nothing to break the tie, name order still decides");
}

// 8. Ordering of the axes, all in one: fit beats weights beats baseline.
{
  const a = d("A_FITS_ONLY", "image");
  const b = d("B_PRESENT_AND_BASELINE", "image");
  const r = Comfy.resolveWorkflow([a, b], { kind: "image" }, null, {
    fits: (x) => x.name === "A_FITS_ONLY",
    weightsPresent: (x) => x.name === "B_PRESENT_AND_BASELINE",
    baseline: (x) => x.name === "B_PRESENT_AND_BASELINE"
  });
  assert(r.chosen.name === "A_FITS_ONLY",
         "fit outranks both weights-present and baseline — a graph the " +
         "card cannot hold is not a choice", r.chosen.name);
}

// 9. A template with NO manifest stays a candidate. The bundle README
//    promises a user's own API export "works as-is", so it has no kind
//    to match on and must not be refused for lacking a sidecar it was
//    never asked to have — but it ranks after described ones.
{
  const mine = d("my-own-export", undefined, { catalogEntry: undefined });
  const r = Comfy.resolveWorkflow([mine, IMAGE], { kind: "image" },
                                  null, {});
  assert(r.chosen.name === "AE_LLAMA_KREA2_V1",
         "a described template of the right kind outranks an undescribed one",
         r.chosen.name);

  const only = Comfy.resolveWorkflow([mine], { kind: "image" }, null, {});
  assert(only.chosen && only.chosen.name === "my-own-export",
         "but a user's own export with no manifest is still runnable");
  assert(/carries no manifest/.test(only.why),
         "and the reason says so rather than pretending it was a match",
         only.why);
}

// 10. Nothing of the wanted kind: run what there is and SAY so, rather
//     than refusing a user who has one working template.
{
  const r = Comfy.resolveWorkflow([VIDEO], { kind: "image" }, null, {});
  assert(r.chosen && r.chosen.name === "AE_LLAMA_H3_I2V_V1",
         "with nothing of the wanted kind, the other kind is still run");
  assert(/nothing of that kind/.test(r.why),
         "and the reason names the mismatch", r.why);
}

// 11. Empty input never throws — the caller turns `why` into a refusal.
{
  const r = Comfy.resolveWorkflow([], { kind: "image" }, null, {});
  assert(!r.chosen && /no workflow templates are installed/.test(r.why),
         "an empty bundle yields a reason, not an exception", r.why);
}

console.log(failures ? "\n" + failures + " FAILED" : "\nALL TESTS PASSED");
process.exitCode = failures ? 1 : 0;
