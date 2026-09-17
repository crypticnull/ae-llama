/*
 * test-h3-prompt-format.js — the panel shapes an H3 prompt itself (WORKPLAN
 * NEXT UP 2, §13e; research in docs/proposals/h3-prompt-format.md).
 *
 * Owner, 2026-09-17: format ONLY when the text carries no bracketed seconds
 * and no camera term, otherwise send it untouched. The panel invents
 * nothing: it knows the user's words and the clip length, so a formatted
 * prompt is "[0-Ns] <words>" and nothing more.
 */
"use strict";

const fs = require("fs");
const path = require("path");

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}

const REPO = path.join(__dirname, "..");
const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => REPO },
  Settings: { dataRoot: () => REPO },
  setTimeout, clearTimeout, setInterval, clearInterval
};
eval(fs.readFileSync(path.join(REPO, "extension", "js", "version.js"), "utf8"));
eval(fs.readFileSync(path.join(REPO, "extension", "js", "comfy.js"), "utf8"));
const Comfy = window.Comfy;
const f = Comfy.formatH3Prompt;

// ------------------------------------------------------------ the detector

let r = f("a paper boat drifts across a pond", { seconds: 6 });
assert(r.formatted && r.prompt === "[0-6s] a paper boat drifts across a pond",
       "a plain sentence gets the clip's timeline and nothing else: " + r.prompt);

r = f("  a kite  ", { seconds: 5.1666 });
assert(r.prompt === "[0-5.2s] a kite",
       "seconds round to one decimal, the words are trimmed: " + r.prompt);

[
  "[0-3s] a cat sits [3-6s] the cat jumps",
  "a door opens [2.5 - 4s] light floods in",
  "rain begins [5.4s] a quiet ceramic click",
  "a bird lands [0 to 3s]"
].forEach(function (t) {
  const x = f(t, { seconds: 6 });
  assert(!x.formatted && x.prompt === t && /timeline/.test(x.reason),
         "a bracketed timeline passes through untouched: " + t);
});

[
  ["slow dolly in on a lighthouse", "dolly"],
  ["the camera pans across the skyline", "pans"],
  ["tilt up to reveal the tower", "tilt"],
  ["orbit around the statue", "orbit"],
  ["crane shot over a crowd", "crane"],
  ["handheld walk through a market", "handheld"],
  ["a whip pan to the door", "whip pan"],
  ["locked-off shot of a street", "locked-off"],
  ["track left past the cars", "track left"],
  ["a tracking shot of a runner", "tracking shot"]
].forEach(function (c) {
  const x = f(c[0], { seconds: 6 });
  assert(!x.formatted && x.prompt === c[0] && x.reason.indexOf(c[1]) !== -1,
         "a camera term passes through untouched, naming it: " + c[0] +
         " (" + x.reason + ")");
});

// Words that CONTAIN a camera term, or share one's spelling in another
// sense, are the common case and must still be formatted.
[
  "a race track at dusk",
  "a sunrise over Japan",
  "a glowing control panel",
  "a company logo on a sign",
  "an expanding galaxy"
].forEach(function (t) {
  assert(f(t, { seconds: 6 }).formatted,
         "not a camera move, so it is formatted: " + t);
});

// ------------------------------------------------------ never invent

r = f("a red balloon", {});
assert(!r.formatted && r.prompt === "a red balloon" && /length/.test(r.reason),
       "no known length: no timeline is guessed, the text goes as-is");
r = f("a red balloon", { seconds: 6 });
assert(r.prompt.replace("[0-6s] ", "") === "a red balloon",
       "the formatted prompt is the user's words plus the timeline, " +
       "no camera, audio or constraint filled in");

// ------------------------------------------------------ the length bound

// The encoder's tokenizer max_length is 99999999 and it RAISES past one
// batch. The bound is checked on what is SENT, so the 7 bytes the timeline
// adds count.
let msg = null;
try { f("a".repeat(99999995), { seconds: 6 }); } catch (e) { msg = e.message; }
assert(msg && msg.indexOf("99999999") !== -1 && msg.indexOf("100000002") !== -1,
       "a prompt that could exceed the encoder is refused, naming the " +
       "limit and the size: " + msg);

// ------------------------------------ wired into injectParams, both modes

function shipped(base) {
  const dir = path.join(REPO, "extension", "comfy-workflows");
  const file = path.join(dir, base + ".json");
  return { graph: Comfy.loadWorkflow(file), mf: Comfy.readManifest(file) };
}

// t2v: the shipped basic carries literal frames (124 @ 24 fps = 5.17 s).
let t = shipped("AE_LLAMA_H3_T2V_V1");
let applied = Comfy.injectParams(t.graph, { prompt: "a kite over the sea" }, t.mf);
assert(t.graph["138"].inputs.prompt === "[0-5.2s] a kite over the sea",
       "t2v basic: the prompt is shaped with the frames the graph renders: " +
       t.graph["138"].inputs.prompt);
assert(applied.promptSent === t.graph["138"].inputs.prompt &&
       Comfy._graphCarriesValue(t.graph, applied.promptSent),
       "applied.promptSent is what the landed check must look for");
assert(applied.join(" | ").indexOf("prompt shaped for H3") !== -1,
       "applied says the prompt was shaped");

// Frames off the 17k+5 grid are snapped UP by the node, so the timeline is.
t = shipped("AE_LLAMA_H3_T2V_V1");
Comfy.injectParams(t.graph, { prompt: "a kite", frames: 100 }, t.mf);
assert(t.graph["138"].inputs.prompt === "[0-4.5s] a kite",
       "100 frames render as 107 (17k+5) = 4.46 s: " +
       t.graph["138"].inputs.prompt);

// A camera term: untouched, and applied says why.
t = shipped("AE_LLAMA_H3_T2V_V1");
applied = Comfy.injectParams(t.graph, { prompt: "dolly in on a kite" }, t.mf);
assert(t.graph["138"].inputs.prompt === "dolly in on a kite" &&
       applied.join(" | ").indexOf("untouched") !== -1,
       "t2v basic: a camera move is sent verbatim and reported");

// i2v: seconds template with a first_frame link. Same shape.
function i2vGraph() {
  return {
    "114": { class_type: "LoadImage", inputs: { image: "ref.png" } },
    "136": { class_type: "PrimitiveFloat", inputs: { value: 15 } },
    "138": { class_type: "MiniMaxH3ImageToVideo",
             inputs: { prompt: "(example)", length: ["135", 1],
                       first_frame: ["114", 0] } }
  };
}
const i2vMf = { procedural: {
  prompt: { nodeId: 138, input: "prompt" },
  durationSeconds: { nodeId: 136, input: "value" },
  firstFrame: { nodeId: 114, input: "image" }
} };
let g = i2vGraph();
Comfy.injectParams(g, { prompt: "the logo glows", imageName: "ref.png" }, i2vMf);
assert(g["138"].inputs.prompt === "[0-6s] the logo glows",
       "i2v: the capped 6 s is the timeline, the words are not restated or " +
       "added to: " + g["138"].inputs.prompt);
g = i2vGraph();
Comfy.injectParams(g, { prompt: "the logo glows", durationSeconds: 8 }, i2vMf);
assert(g["138"].inputs.prompt === "[0-8s] the logo glows",
       "i2v: a named length is the timeline");

// Not H3: a manifest prompt on another class is left exactly as written.
g = { "5": { class_type: "SomeSampler", inputs: { prompt: "" } },
      "7": { class_type: "CreateVideo", inputs: { fps: 24 } } };
applied = Comfy.injectParams(g, { prompt: "a kite" },
                             { procedural: { prompt: { nodeId: 5, input: "prompt" } } });
assert(g["5"].inputs.prompt === "a kite" && applied.promptSent === undefined,
       "a non-H3 template's prompt is not shaped");

console.log(failures ? failures + " FAILED" : "all passed");
process.exit(failures ? 1 : 0);
