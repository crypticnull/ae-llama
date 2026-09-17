// Regression test: WHICH workflow a generation runs.
//
// Found in the field on 2026-08-28 by the chat probe's new ComfyUI step.
// Asked for "a picture of a red apple", the model looked at the workflow
// list, picked the one whose name says what it wants — `example-txt2img`
// — and ComfyUI threw the request out:
//
//   Value not in list — ckpt_name: 'CHANGE-ME.safetensors' not in [...]
//
// That template is the FORMAT example this project ships so a user can
// see what an API-format graph looks like. It has never been able to
// render anything. comfy_list_workflows offered it with equal standing
// next to the two real templates, and its name is by far the most
// picture-like of the three — so the model named it outright. (It was
// also reachable as the DEFAULT: the default is simply list[0], and
// which file that is depends on nothing but the alphabet.)
//
// So the rule pinned here: a template still holding the placeholder is
// flagged by Comfy.listWorkflows, is never offered to the model, is
// never the default, and — when named outright — is refused with what it
// actually is instead of ComfyUI's validator dump.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// A workflow dir shaped like the one the panel seeds: two real
// templates, one format example, one manifest sidecar.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-wf-"));
fs.writeFileSync(path.join(dir, "AE_LLAMA_H3_T2V_V1.json"), JSON.stringify({
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "real-video.safetensors" } }
}));
fs.writeFileSync(path.join(dir, "AE_LLAMA_H3_T2V_V1.manifest.json"),
                 JSON.stringify({ kind: "video",
                                  catalogEntry: "minimax-h3",
                                  models: [] }));
fs.writeFileSync(path.join(dir, "AE_LLAMA_KREA2_V1.json"), JSON.stringify({
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "real-image.safetensors" } }
}));
fs.writeFileSync(path.join(dir, "AE_LLAMA_KREA2_V1.manifest.json"),
                 JSON.stringify({ kind: "image",
                                  catalogEntry: "krea2",
                                  models: [] }));
fs.writeFileSync(path.join(dir, "example-txt2img.json"), JSON.stringify({
  "4": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "CHANGE-ME.safetensors" } }
}));
// The seeder's own record of every version ever shipped (0.10.1). It is
// a real .json file sitting in the bundled workflow directory, and its
// leading dot sorts it FIRST — which is what made this worth pinning:
// found 2026-08-30, .hash-history was offered to the model as a template
// AND was list[0], so a generation that named no workflow ran the record
// file as a graph.
fs.writeFileSync(path.join(dir, ".hash-history.json"), JSON.stringify({
  files: { "AE_LLAMA_KREA2_V1.json": ["abc123"] }
}));

// ------------------------------------------------- 1. the Comfy half

const comfyWindow = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => dir },
  Settings: { dataRoot: () => dir, get: () => ({}) },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout
};
new Function("window", fs.readFileSync(
  path.join(__dirname, "..", "extension", "js", "comfy.js"), "utf8")
)(comfyWindow);

const listed = comfyWindow.Comfy.listWorkflows(dir);
assert(listed.length === 3,
       "the manifest sidecar and the dotfile are still not workflows");
const byName = {};
for (const w of listed) byName[w.name] = w;
assert(!byName[".hash-history"],
       "the seeder's hash record is not offered as a workflow");
assert(listed[0].name !== ".hash-history",
       "and so cannot be the default a nameless generation falls on");
assert(byName["example-txt2img"].example === true,
       "a template holding CHANGE-ME is flagged as an example");
assert(byName["AE_LLAMA_KREA2_V1"].example === false &&
       byName["AE_LLAMA_H3_T2V_V1"].example === false,
       "and the real ones are not");
assert(listed.map(w => w.name).indexOf("example-txt2img") !== -1,
       "it is still LISTED — the flag is what the tools go by, so the " +
       "file stays available to anyone reading it as documentation");

// ------------------------------------------------- 2. the tools half

const window = {
  AEBridge: { nodeRequire: require },
  console: console, setTimeout, clearTimeout,
  Settings: { get: () => Object.assign({
                            comfyWorkflowsDir: dir, comfyUrl: "u",
                            comfyOutDir: dir, comfyTimeoutSec: 60,
                            comfyPauseLlm: "never", comfyEnhance: {},
                            comfyWorkflows: {},
                            vramOverrideGB: 0 }, settingsPatch) },
  Llama: { getState: () => "stopped", chat: () => {} },
  Setup: { queryVramUsedMB: (cb) => cb(new Error("no smi")) },
  Comfy: {
    listWorkflows: comfyWindow.Comfy.listWorkflows,
    // The REAL describer and resolver, not a re-implementation: which
    // template a request runs is the thing under test, so a stub of it
    // would test nothing. They are pure over the fixture directory.
    describeWorkflows: comfyWindow.Comfy.describeWorkflows,
    resolveWorkflow: comfyWindow.Comfy.resolveWorkflow,
    readManifest: comfyWindow.Comfy.readManifest,
    // The panel asks comfy.js WHICH backend it is talking to (managed
    // vs the user's own) rather than reading comfyUrl — keep the stub
    // faithful to that, or every call site throws.
    backendUrl: (s) => (s && s.comfyUrl) || "http://127.0.0.1:8288",
    ensureRunning: (url, st, cb) => cb(null),
    freeVram: (url, cb) => cb(null),
    generate: (opts, prog, cb) => {
      ranWith.push(opts.workflowFile);
      cb(null, { files: [], applied: [] });
    }
  }
};
window.window = window;
const ranWith = [];
for (const f of ["tiers.js", "tools.js"]) {
  new Function("window", fs.readFileSync(
    path.join(__dirname, "..", "extension", "js", f), "utf8"))(window);
}
const Tools = window.Tools;
Tools.setGpuInfo({ hasNvidia: true, vramGB: 32, computeCap: 8.9 });

// Settings the current step wants on top of the defaults above. Set
// around one run and cleared after, so no step leaks into the next.
let settingsPatch = {};
function run(cmd, cb, patch) {
  settingsPatch = patch || {};
  Tools.executeCommands([cmd], {}, null, function (results) {
    settingsPatch = {};
    cb(results[0]);
  });
}

const pending = [];
function step(fn) { pending.push(fn); }
function next(i) {
  if (i >= pending.length) {
    console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
    return;
  }
  pending[i](function () { next(i + 1); });
}

step(function (done) {
  run({ tool: "comfy_list_workflows", args: {} }, function (r) {
    assert(r.ok && r.data.workflows.length === 2,
           "the model is offered only the runnable templates");
    assert(r.data.workflows.indexOf("example-txt2img") === -1,
           "the format example is not among them: " +
           r.data.workflows.join(", "));
    done();
  });
});

step(function (done) {
  // SUPERSEDES the old expectation. The default WAS list[0] — the
  // alphabet — and this test pinned that as correct because nothing
  // better existed. With the shipped bundle it means "a picture of a red
  // apple" is handed to AE_LLAMA_H3_T2V_V1: a 40 GB Blackwell-only VIDEO
  // graph, chosen because ae_llama_h3 sorts before ae_llama_krea2.
  //
  // Comfy.resolveWorkflow decides now, and a request with no frames and
  // no durationSeconds is an IMAGE request.
  ranWith.length = 0;
  run({ tool: "comfy_generate", args: { prompt: "a red apple",
                                        "import": false } }, function (r) {
    assert(r.ok, "a generation with no workflow named still runs: " +
           (r.ok ? "" : r.error));
    assert(/AE_LLAMA_KREA2_V1\.json$/.test(ranWith[0] || ""),
           "and a picture request goes to the IMAGE template, not the " +
           "video graph that sorts above it (ran: " + ranWith[0] + ")");
    done();
  });
});

step(function (done) {
  // ...and a length asked for is a VIDEO request. No new argument and no
  // prompt bytes: durationSeconds and frames are already in the doc.
  ranWith.length = 0;
  run({ tool: "comfy_generate",
        args: { prompt: "a red apple rolling", durationSeconds: 3,
                "import": false } }, function (r) {
    assert(r.ok, "a generation asking for a duration runs: " +
           (r.ok ? "" : r.error));
    assert(/AE_LLAMA_H3_T2V_V1\.json$/.test(ranWith[0] || ""),
           "and goes to the VIDEO template (ran: " + ranWith[0] + ")");
    done();
  });
});

step(function (done) {
  // A template the user switched off in Settings is never chosen, and
  // the refusal names what is left rather than falling back silently.
  ranWith.length = 0;
  const off = { comfyWorkflows: { AE_LLAMA_KREA2_V1: { enabled: false } } };
  run({ tool: "comfy_generate", args: { prompt: "a red apple",
                                        "import": false } },
      function (r) {
        assert(/AE_LLAMA_KREA2_V1\.json$/.test(ranWith[0] || "") === false,
               "a disabled template is not run (ran: " + ranWith[0] + ")");
        done();
      }, off);
});

step(function (done) {
  ranWith.length = 0;
  run({ tool: "comfy_generate",
        args: { workflow: "example-txt2img", prompt: "a red apple" } },
    function (r) {
      assert(!r.ok, "naming the example outright is refused");
      assert(/placeholder CHANGE-ME/.test(r.error),
             "with what it actually is: " + r.error);
      assert(/AE_LLAMA_KREA2_V1/.test(r.error) &&
             !/example-txt2img'\. Available/.test(r.error),
             "and the templates that WOULD work, so the model can retry");
      assert(ranWith.length === 0,
             "nothing was queued at ComfyUI (the refusal is grounded, " +
             "not a validator error paid for with a round trip)");
      done();
    });
});

step(function (done) {
  run({ tool: "comfy_generate",
        args: { workflow: "no-such-thing", prompt: "x" } }, function (r) {
    assert(!r.ok && /Unknown workflow/.test(r.error),
           "an unknown name is still its own error");
    assert(!/example-txt2img/.test(r.error),
           "and it does not advertise the example as an alternative: " +
           r.error);
    done();
  });
});

// NEXT UP 44: the model's first call invented a name in 3/3 measured
// runs. A name made only of kind words is resolved like a nameless call
// and says so; a name with any other word keeps the grounded refusal.
[["Image Generation", {}, /AE_LLAMA_KREA2_V1\.json$/],
 ["image_txt2img", {}, /AE_LLAMA_KREA2_V1\.json$/],
 ["default", {}, /AE_LLAMA_KREA2_V1\.json$/],
 ["textToVideo", {}, /AE_LLAMA_H3_T2V_V1\.json$/],
 ["default", { durationSeconds: 3 }, /AE_LLAMA_H3_T2V_V1\.json$/],
 // A family plus kind words picks within that family.
 ["Krea", {}, /AE_LLAMA_KREA2_V1\.json$/],
 ["minimax H3 video", {}, /AE_LLAMA_H3_T2V_V1\.json$/]
].forEach(function (c) {
  step(function (done) {
    ranWith.length = 0;
    run({ tool: "comfy_generate",
          args: Object.assign({ workflow: c[0], prompt: "a red apple",
                                "import": false }, c[1]) }, function (r) {
      assert(r.ok && c[2].test(ranWith[0] || ""),
             "invented name '" + c[0] + "' " + JSON.stringify(c[1]) +
             " runs the resolver's pick (ran: " + ranWith[0] + ", " +
             (r.ok ? "ok" : r.error) + ")");
      const note = r.ok && r.data.applied[0];
      assert(note && note.indexOf("'" + c[0] + "' is not a template") !== -1 &&
             /AE_LLAMA_KREA2_V1, AE_LLAMA_H3_T2V_V1|AE_LLAMA_H3_T2V_V1, AE_LLAMA_KREA2_V1/.test(note) &&
             !/example-txt2img/.test(note),
             "and applied says so, with the real names: " + note);
      done();
    });
  });
});

// SDXL / Stable Diffusion are families with no template in this fixture,
// so they are refused and say which family is missing.
["SDXL", "Stable Diffusion 1.5", "image to video", "i2v", "flux",
 "krea video", "krea h3"].forEach(function (n) {
  step(function (done) {
    ranWith.length = 0;
    run({ tool: "comfy_generate",
          args: { workflow: n, prompt: "x", "import": false } }, function (r) {
      assert(!r.ok && /Unknown workflow/.test(r.error) && ranWith.length === 0,
             "a name that may mean a specific model is refused, not " +
             "guessed: '" + n + "' -> " + (r.ok ? "ran" : r.error));
      if (/sd|diffusion/i.test(n)) {
        assert(/no (SDXL|SD15) template is installed/.test(r.error),
               "and says the family has no template: " + r.error);
      }
      done();
    });
  });
});

step(function (done) {
  ranWith.length = 0;
  run({ tool: "comfy_generate",
        args: { workflow: "ae_llama_krea2_v1", prompt: "x",
                "import": false } }, function (r) {
    assert(r.ok && /AE_LLAMA_KREA2_V1\.json$/.test(ranWith[0] || "") &&
           r.data.applied.length === 0,
           "a real name in any case runs as named, with no note");
    done();
  });
});

step(function (done) {
  ranWith.length = 0;
  const off = { comfyWorkflows: { AE_LLAMA_KREA2_V1: { enabled: false } } };
  run({ tool: "comfy_generate",
        args: { workflow: "default", prompt: "x", "import": false } },
      function (r) {
        assert(!/AE_LLAMA_KREA2_V1\.json$/.test(ranWith[0] || ""),
               "an invented name never reaches a switched-off template " +
               "(ran: " + ranWith[0] + ")");
        done();
      }, off);
});

step(function (done) {
  // A dir with NOTHING but the example: the error has to say why the one
  // file sitting there is not usable, or it reads as "no files".
  const only = fs.mkdtempSync(path.join(os.tmpdir(), "aell-wf-ex-"));
  fs.copyFileSync(path.join(dir, "example-txt2img.json"),
                  path.join(only, "example-txt2img.json"));
  const realGet = window.Settings.get;
  window.Settings.get = () => Object.assign(realGet(),
                                            { comfyWorkflowsDir: only });
  run({ tool: "comfy_list_workflows", args: {} }, function (r) {
    assert(!r.ok && /format example/.test(r.error) &&
           /example-txt2img/.test(r.error),
           "listing names the example and says it cannot render: " +
           r.error);
    run({ tool: "comfy_generate", args: { prompt: "x" } }, function (r2) {
      assert(!r2.ok && /No runnable workflow/.test(r2.error),
             "and a generation refuses rather than queueing it: " +
             r2.error);
      window.Settings.get = realGet;
      done();
    });
  });
});

next(0);
