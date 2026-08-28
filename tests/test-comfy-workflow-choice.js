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
fs.writeFileSync(path.join(dir, "AE_LLAMA_H3_I2V_V1.json"), JSON.stringify({
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "real-video.safetensors" } }
}));
fs.writeFileSync(path.join(dir, "AE_LLAMA_H3_I2V_V1.manifest.json"),
                 JSON.stringify({ models: [] }));
fs.writeFileSync(path.join(dir, "AE_LLAMA_KREA2_V1.json"), JSON.stringify({
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "real-image.safetensors" } }
}));
fs.writeFileSync(path.join(dir, "example-txt2img.json"), JSON.stringify({
  "4": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "CHANGE-ME.safetensors" } }
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
assert(listed.length === 3, "the manifest sidecar is still not a workflow");
const byName = {};
for (const w of listed) byName[w.name] = w;
assert(byName["example-txt2img"].example === true,
       "a template holding CHANGE-ME is flagged as an example");
assert(byName["AE_LLAMA_KREA2_V1"].example === false &&
       byName["AE_LLAMA_H3_I2V_V1"].example === false,
       "and the real ones are not");
assert(listed.map(w => w.name).indexOf("example-txt2img") !== -1,
       "it is still LISTED — the flag is what the tools go by, so the " +
       "file stays available to anyone reading it as documentation");

// ------------------------------------------------- 2. the tools half

const window = {
  AEBridge: { nodeRequire: require },
  console: console, setTimeout, clearTimeout,
  Settings: { get: () => ({ comfyWorkflowsDir: dir, comfyUrl: "u",
                            comfyOutDir: dir, comfyTimeoutSec: 60,
                            comfyPauseLlm: "never", comfyEnhance: {},
                            vramOverrideGB: 0 }) },
  Llama: { getState: () => "stopped", chat: () => {} },
  Setup: { queryVramUsedMB: (cb) => cb(new Error("no smi")) },
  Comfy: {
    listWorkflows: comfyWindow.Comfy.listWorkflows,
    readManifest: () => null,
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

function run(cmd, cb) {
  Tools.executeCommands([cmd], {}, null, function (results) {
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
  // The default with no workflow named is list[0], which is decided by
  // the alphabet alone. It must be the first RUNNABLE one — rename the
  // example to "aaa-example" and the old code would have queued it.
  ranWith.length = 0;
  run({ tool: "comfy_generate", args: { prompt: "a red apple",
                                        "import": false } }, function (r) {
    assert(r.ok, "a generation with no workflow named still runs: " +
           (r.ok ? "" : r.error));
    assert(/AE_LLAMA_H3_I2V_V1\.json$/.test(ranWith[0] || ""),
           "and it defaults to the first RUNNABLE template, not the " +
           "example that sorts above it (ran: " + ranWith[0] + ")");
    done();
  });
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
