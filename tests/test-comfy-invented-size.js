// Regression test: a video size the MODEL invented is dropped (NEXT UP 39).
//
// Measured 2026-09-17 in a real panel (Qwen2.5-32B, no comp open): asked
// "Generate a video of a red paper boat drifting on a calm pond.", the
// model sent width 1920, height 1080 in 3 of 3 tries, and still in 1 of 5
// after the doc sentence was fixed (0.12.39). On H3 that is 442 s instead
// of the authored 1344x768's 153 s. comfy_generate only ever saw the
// model's args, so it could not tell a size asked for from one made up.
// The panel now hands it the user's own turns, and with no comp open and
// no turn that could name a size, width/height are dropped and `applied`
// says so.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-size39-"));
fs.writeFileSync(path.join(dir, "AE_LLAMA_H3_T2V_V1.json"), JSON.stringify({
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "real-video.safetensors" } }
}));
fs.writeFileSync(path.join(dir, "AE_LLAMA_H3_T2V_V1.manifest.json"),
  JSON.stringify({ kind: "video", catalogEntry: "minimax-h3", models: [] }));

const comfyWindow = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => dir },
  Settings: { dataRoot: () => dir, get: () => ({}) },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout
};
new Function("window", fs.readFileSync(
  path.join(__dirname, "..", "extension", "js", "comfy.js"), "utf8"))(comfyWindow);

// What the host answers get_project_info with; null = no comp active.
let activeComp = null;
let hostCalls = 0;
let hostFails = false;
const sent = [];
const window = {
  AEBridge: {
    nodeRequire: require,
    evalScript: (script, cb) => {
      hostCalls++;
      if (hostFails) { cb("EvalScript error.", true); return; }
      if (/get_project_info/.test(script)) {
        cb(JSON.stringify({ ok: true, data: { items: [], activeComp } }));
      } else {
        cb(JSON.stringify({ ok: false, error: "unexpected host call" }));
      }
    }
  },
  console, setTimeout, clearTimeout,
  Settings: { get: () => ({ comfyWorkflowsDir: dir, comfyUrl: "u",
                            comfyOutDir: dir, comfyTimeoutSec: 60,
                            comfyPauseLlm: "never", comfyEnhance: {},
                            comfyWorkflows: {}, vramOverrideGB: 0 }) },
  Llama: { getState: () => "stopped", chat: () => {} },
  Setup: { queryVramUsedMB: (cb) => cb(new Error("no smi")) },
  Comfy: {
    listWorkflows: comfyWindow.Comfy.listWorkflows,
    describeWorkflows: comfyWindow.Comfy.describeWorkflows,
    resolveWorkflow: comfyWindow.Comfy.resolveWorkflow,
    readManifest: comfyWindow.Comfy.readManifest,
    backendUrl: (s) => (s && s.comfyUrl) || "http://127.0.0.1:8288",
    ensureRunning: (url, st, cb) => cb(null),
    freeVram: (url, cb) => cb(null),
    generate: (opts, prog, cb) => {
      sent.push(opts.params);
      cb(null, { files: [], applied: ["prompt -> node 1"] });
    }
  }
};
window.window = window;
for (const f of ["tiers.js", "tools.js"]) {
  new Function("window", fs.readFileSync(
    path.join(__dirname, "..", "extension", "js", f), "utf8"))(window);
}
const Tools = window.Tools;
Tools.setGpuInfo({ hasNvidia: true, vramGB: 32, computeCap: 8.9 });

const BOAT = "Generate a video of a red paper boat drifting on a calm pond.";
const INVENTED = { prompt: "a red paper boat drifting on a calm pond",
                   workflow: "AE_LLAMA_H3_T2V_V1", width: 1920, height: 1080,
                   "import": false };

function run(args, opts, cb) {
  sent.length = 0;
  hostCalls = 0;
  Tools.executeCommands([{ tool: "comfy_generate", args }], opts, null,
    function (results) { cb(results[0], sent[0]); });
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

// ------------------------------------------------ 1. the detector alone

const named = Tools._userNamesSize;
const JA = String.fromCharCode(0x7e26, 0x9577, 0x306e, 0x52d5, 0x753b);
const RU = String.fromCharCode(0x0432, 0x0438, 0x0434, 0x0435, 0x043e);
const TIMES = String.fromCharCode(0xd7);
const QUOTES = String.fromCharCode(0x201c) + "the boat" +
               String.fromCharCode(0x201d) + " drift " +
               String.fromCharCode(0x2014) + " slowly" +
               String.fromCharCode(0x2026) + " " +
               String.fromCharCode(0xd83d, 0xdea3);
for (const t of ["Make a 1920x1080 video of a boat", "a 1280 " + TIMES + " 720 clip",
                 "render it in 720p", "4K please", "a vertical video",
                 "portrait, for Instagram", "square clip of a cat",
                 "9:16 for reels", "full HD", "same size as before",
                 JA, RU + " boat"]) {
  assert(named([t]), "names a size (or cannot be read): " + JSON.stringify(t));
}
for (const t of [BOAT, "a cat on a skateboard, 5 seconds, slow motion",
                 "Dolly in on a lighthouse at dusk", "make " + QUOTES]) {
  assert(!named([t]), "names no size: " + JSON.stringify(t));
}
assert(named(["a boat", "now make it 1080p"]),
       "any turn counts, so a size named earlier is still honoured");

// ----------------------------------------------- 2. what the user typed

const typed = Tools.userTurnTexts([
  { role: "user", content: BOAT },
  { role: "assistant", content: "{}" },
  { role: "user", content: "TOOL RESULTS:\n[{\"width\":1920,\"height\":1080}]" },
  { role: "user", content: "SYSTEM: Only your LAST response was truncated" },
  { role: "user", content: "again, but blue" }
]);
assert(typed.length === 2 && typed[0] === BOAT && typed[1] === "again, but blue",
       "tool results and SYSTEM notes are not the user's words: " +
       JSON.stringify(typed));

// ------------------------------------------------ 3. the tool, end to end

step(function (done) {
  activeComp = null;
  run(INVENTED, { userTexts: [BOAT] }, function (r, params) {
    assert(r.ok, "the generation still runs: " + (r.ok ? "" : r.error));
    assert(params && params.width === undefined && params.height === undefined,
           "no comp, no size in the request: width/height are dropped (sent " +
           JSON.stringify(params && [params.width, params.height]) + ")");
    assert(r.ok && /^width\/height dropped: 1920x1080 was not asked for/.test(
             r.data.applied[0]),
           "and applied says so first: " + (r.ok && r.data.applied[0]));
    assert(r.ok && r.data.applied[1] === "prompt -> node 1",
           "the template's own applied lines follow");
    done();
  });
});

step(function (done) {
  activeComp = "Main";
  run(INVENTED, { userTexts: [BOAT] }, function (r, params) {
    assert(params.width === 1920 && params.height === 1080,
           "a comp is open: the size is kept (the doc lets it match a comp)");
    assert(r.ok && !/dropped/.test(r.data.applied.join("\n")),
           "and nothing is claimed as dropped");
    activeComp = null;
    done();
  });
});

step(function (done) {
  run(INVENTED, { userTexts: ["Make a 1920x1080 video of a boat"] },
    function (r, params) {
      assert(params.width === 1920 && params.height === 1080 && hostCalls === 0,
             "a size the user named is kept, without asking the host");
      done();
    });
});

step(function (done) {
  run(INVENTED, {}, function (r, params) {
    assert(params.width === 1920 && params.height === 1080 && hostCalls === 0,
           "no user turns handed over (a probe, a direct call): unchanged");
    done();
  });
});

step(function (done) {
  run(Object.assign({}, INVENTED, { image: "C:/ref.png" }), { userTexts: [BOAT] },
    function (r, params) {
      assert(params.width === 1920 && hostCalls === 0,
             "a reference image is involved: the size is kept");
      done();
    });
});

step(function (done) {
  hostFails = true;
  run(INVENTED, { userTexts: [BOAT] }, function (r, params) {
    assert(params.width === 1920 && params.height === 1080,
           "the project cannot be read: the size is kept, not guessed");
    hostFails = false;
    done();
  });
});

step(function (done) {
  const noSize = { prompt: "a boat", workflow: "AE_LLAMA_H3_T2V_V1",
                   "import": false };
  run(noSize, { userTexts: [BOAT] }, function (r) {
    assert(r.ok && hostCalls === 0 && !/dropped/.test(r.data.applied.join("")),
           "no size sent at all: nothing to drop, no host call");
    done();
  });
});

step(function (done) {
  run(INVENTED, { userTexts: [BOAT] }, function () {
    assert(INVENTED.width === 1920,
           "the model's own args object is not mutated by the drop");
    done();
  });
});

step(function (done) {
  // NEXT UP 22: a named comp is the size source, so an invented size
  // gives way to it even while a comp is active.
  activeComp = "Main";
  run(Object.assign({}, INVENTED, { comp: "Main" }), { userTexts: [BOAT] },
    function (r, params) {
      assert(r.ok && !(params.width > 0) && !(params.height > 0) &&
             /1920x1080 was not asked for, and comp 'Main' sets the size/
               .test(r.data.applied[0]),
             "comp named, no size named: the invented size is dropped for " +
             "the comp's: " + JSON.stringify(r.data && r.data.applied[0]));
      activeComp = null;
      done();
    });
});

step(function (done) {
  run(Object.assign({}, INVENTED, { comp: "Main" }),
      { userTexts: ["Make a 1920x1080 video of a boat"] },
    function (r, params) {
      assert(params.width === 1920 && params.height === 1080,
             "comp named AND a size named: the named size wins");
      done();
    });
});

next(0);
