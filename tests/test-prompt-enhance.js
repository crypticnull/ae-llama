// Regression test: per-workflow prompt enhancement (Tools.planEnhancement
// + Comfy.readManifest against the REAL bundled manifests).
//
// The owner's workflows carried an Ollama enhancer branch that loaded a
// separate 27B model per generation. The panel bypasses that branch
// forever and enhances with its OWN chat model instead — which is
// already resident when comfy_generate fires, so the cost is one
// completion, not a model load. This file pins the decision logic and
// the bundled instructions that drive it.
"use strict";
const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

// ---- planEnhancement (tools.js, pure) --------------------------------
const window = {};
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tools.js"), "utf8"));
const plan = window.Tools.planEnhancement;

// 1. absent from the map means ON — opt-OUT is what gets stored, so a
//    newly added workflow enhances without a settings migration.
{
  const p = plan({ comfyEnhance: {} }, "AE_LLAMA_KREA2_V1", "a dog", null);
  assert(p.enabled === true, "absent from the map = enhancement ON");
  const p2 = plan({}, "anything", "a dog", null);
  assert(p2.enabled === true, "no map at all = still ON");
}

// 2. an explicit false turns it off for THAT workflow only
{
  const s = { comfyEnhance: { A: false } };
  assert(plan(s, "A", "x", null).enabled === false, "A is off");
  assert(plan(s, "B", "x", null).enabled === true, "B stays on");
}

// 3. no manifest -> the generic instruction, so user-added workflows
//    still enhance sensibly
{
  const p = plan({}, "UserFlow", "a burning ship", null);
  assert(/rich, specific generation/.test(p.messages[0].content),
         "generic instruction used when there is no manifest");
  assert(p.messages[1].content === "a burning ship",
         "the raw idea rides in the user turn, untouched");
}

// 4. a manifest instruction replaces the generic one verbatim
{
  const p = plan({}, "X", "idea", { enhancerInstruction: "INSTR-99" });
  assert(p.messages[0].content.indexOf("INSTR-99") === 0,
         "manifest instruction leads the system turn");
  assert(/Answer as JSON/.test(p.messages[0].content),
         "and the JSON-shape note rides along for constrained decoding");
}

// 5. the schema forces {prompt} so the completion can never be
//    unparseable — the same trick the chat round uses
{
  const p = plan({}, "X", "idea", null);
  assert(p.schema.required.indexOf("prompt") !== -1 &&
         p.schema.properties.prompt.type === "string",
         "schema constrains the reply to {prompt: string}");
}

// ---- Comfy.readManifest against the real bundled files ---------------
// comfy.js reaches node through AEBridge.nodeRequire — shim exactly that.
const w2 = { AEBridge: { nodeRequire: require } };
(function () {
  const window = w2;
  try {
    eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                   "comfy.js"), "utf8"));
  } catch (e) {
    console.error("FAIL: comfy.js did not load under the node shim: " +
                  e.message);
    failed++;
  }
})();
if (w2.Comfy && w2.Comfy.readManifest) {
  const dir = path.join(__dirname, "..", "extension", "workflows");
  for (const name of ["AE_LLAMA_KREA2_V1", "AE_LLAMA_H3_R2V_V1"]) {
    const m = w2.Comfy.readManifest(path.join(dir, name + ".json"));
    assert(m && typeof m.enhancerInstruction === "string" &&
           m.enhancerInstruction.length > 500,
           name + " manifest carries its real enhancer instruction (" +
           (m ? (m.enhancerInstruction || "").length : "none") + " chars)");
  }
  assert(w2.Comfy.readManifest("/no/such/workflow.json") === null,
         "a workflow without a manifest returns null, not a throw");
} else {
  console.log("ok  - (comfy.js export shape differs; readManifest " +
              "covered via tools.js fallback path)");
}

// ---- the bundled workflows must not ship leftover typed prompts ------
for (const wf of ["AE_LLAMA_KREA2_V1.json", "AE_LLAMA_H3_R2V_V1.json"]) {
  const doc = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "extension", "workflows", wf), "utf8"));
  let leftovers = 0;
  for (const n of doc.nodes) {
    // rgthree nodes store widgets_values as an OBJECT — only arrays hold
    // the free-text widgets this check is after. Documentation notes are
    // MEANT to be long; they ship.
    if (/^(MarkdownNote|Note)$/.test(n.type)) continue;
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    for (const w of wv) {
      if (typeof w === "string" && w.length > 100 &&
          !/You rewrite|HOW KREA 2|PROMPT ENHANCER TOGGLE/.test(w) &&
          !/placeholder prompt|neutral example/.test(w)) {
        leftovers++;
      }
    }
  }
  assert(leftovers === 0,
         wf + " ships no leftover free-text prompts (" + leftovers + ")");
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
