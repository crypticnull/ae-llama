// Regression test: the VRAM arbiter wiring in tools.js — who owns the
// GPU during comfy_generate and how it changes hands.
//
// The old code paused llama per generation behind a FIXED 1.5 s sleep
// and restarted it per generation: five variations in one round meant
// five load/unload cycles, and "the VRAM is free now" was hope. The
// arbiter pauses once per round after real arithmetic (tiers.js), polls
// nvidia-smi until the memory measurably drops, asks ComfyUI to unload
// its cache before the chat model returns, and resumes exactly once —
// after the last command, before the model formulates its reply.
"use strict";
const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------------------- fakes
const log = [];            // ordered trace of everything that happened
let vramReadings = [];     // scripted nvidia-smi answers (null = error)
let llamaState = "running";
const delays = [];

const fakeFs = {
  statSync: () => ({ size: 4700 * 1048576 })   // the chat .gguf on disk
};

const window = {
  AEBridge: { nodeRequire: (m) => (m === "fs" ? fakeFs : require(m)) },
  setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); },
  clearTimeout,
  Settings: { get: () => settings },
  Llama: {
    getState: () => llamaState,
    getCurrentModel: () => "C:\\models\\qwen7b.gguf",
    stop: () => { log.push("llama.stop"); llamaState = "stopped"; },
    start: (opts, cb) => {
      log.push("llama.start");
      llamaState = "running";
      cb(null);
    },
    // The enhancer's completion — fail it so the raw prompt rides
    // (enhancement itself is test-prompt-enhance's subject).
    chat: (o, m, s, d, cb) => cb(new Error("no enhancer in this test"))
  },
  Setup: {
    queryVramUsedMB: (cb) => {
      const v = vramReadings.shift();
      log.push("smi:" + v);
      if (v === null || typeof v === "undefined") {
        cb(new Error("nvidia-smi unavailable"));
      } else cb(null, v);
    }
  },
  Comfy: {
    listWorkflows: () => [{ name: "WF", file: "/wf/WF.json" }],
    readManifest: () => ({ models: [
      { file: "gen.safetensors", sizeMB: 6000 },
      { file: "enc.safetensors", sizeMB: 500 },
      { file: "extra.safetensors", sizeMB: 999, optional: true }
    ] }),
    ensureRunning: (url, st, cb) => { log.push("comfy.ensure"); cb(null); },
    generate: (opts, prog, cb) => {
      log.push("comfy.generate");
      cb(null, { files: [], applied: [] });
    },
    freeVram: (url, cb) => { log.push("comfy.free"); cb(null); }
  }
};
window.window = window;

let settings = null;
function baseSettings(patch) {
  return Object.assign({
    serverPath: "s", modelPath: "C:\\models\\qwen7b.gguf", port: 1,
    ctxSize: 16384, gpuLayers: 99, comfyUrl: "http://127.0.0.1:8188",
    comfyWorkflowsDir: "/wf", comfyOutDir: "/out", comfyTimeoutSec: 60,
    comfyPauseLlm: "auto", comfyEnhance: {}, vramOverrideGB: 0
  }, patch || {});
}

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tiers.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tools.js"), "utf8"));
const Tools = window.Tools;

// The non-optional manifest weights: 6000 + 500 (the optional 999 is a
// bypassed branch the run never loads).
assert(Tools._genNeedMBFor(window.Comfy.readManifest()) === 6500,
       "genNeedMB sums the manifest's non-optional weights (6.5 GB)");

const gen = (n) => {
  const cmds = [];
  for (let i = 0; i < n; i++) {
    cmds.push({ tool: "comfy_generate",
                args: { prompt: "a thing " + i, import: false } });
  }
  return cmds;
};

function run(cmds, cb) {
  Tools.executeCommands(cmds, {}, null, cb);
}

// ---- scenario 1: 8 GB card, auto — handoff, ONCE for the whole round.
// chat 4.7 GB file (+overhead ≈ 6.2 GB) + 6.5 GB of weights cannot
// share 8 GB. Baseline 7000 MB; release is only believed when the
// reading DROPS (7000→6800 is not release, 7000→600 is).
settings = baseSettings();
Tools.setGpuInfo({ hasNvidia: true, vramGB: 8, computeCap: 8.9 });
vramReadings = [7000,          // baseline before stop
                6800, 600,     // release poll: not yet, then freed
                7100,          // baseline before ComfyUI unload
                6900, 900];    // unload poll: not yet, then freed
run(gen(2), function (results) {
  assert(results.length === 2 && results[0].ok && results[1].ok,
         "both generations in the round succeed");
  const stops = log.filter(x => x === "llama.stop").length;
  const starts = log.filter(x => x === "llama.start").length;
  const frees = log.filter(x => x === "comfy.free").length;
  assert(stops === 1 && starts === 1 && frees === 1,
         "TWO generations cost ONE pause, ONE unload, ONE resume (got " +
         stops + "/" + frees + "/" + starts + ")");
  const order = log.filter(x => /llama|generate|free/.test(x));
  assert(order.join(" ") ===
         "llama.stop comfy.generate comfy.generate comfy.free llama.start",
         "…in the right order (got: " + order.join(" ") + ")");
  const polls = log.filter(x => /^smi:/.test(x)).length;
  assert(polls === 6,
         "release was POLLED until the reading dropped, both directions " +
         "(6 nvidia-smi reads, got " + polls + ")");
  assert(llamaState === "running",
         "the chat model is back before the reply is formulated");

  // ---- scenario 2: 32 GB card, same job — fits, nothing is touched.
  log.length = 0;
  settings = baseSettings();
  Tools.setGpuInfo({ hasNvidia: true, vramGB: 32, computeCap: 12 });
  vramReadings = [];
  run(gen(1), function (r2) {
    assert(r2[0].ok && log.indexOf("llama.stop") === -1 &&
           log.indexOf("comfy.free") === -1,
           "on 32 GB the same job runs CONCURRENT — chat never pauses");

    // ---- scenario 3: pause 'never' on the 8 GB card — grounded
    // refusal BEFORE any churn.
    log.length = 0;
    settings = baseSettings({ comfyPauseLlm: "never" });
    Tools.setGpuInfo({ hasNvidia: true, vramGB: 8, computeCap: 8.9 });
    run(gen(1), function (r3) {
      assert(r3[0].ok === false &&
             /never/.test(r3[0].error) && /6\.3 GB/.test(r3[0].error) &&
             /6\.1 GB/.test(r3[0].error),
             "'never' + no fit refuses with the real numbers (got: " +
             (r3[0].error || "ok") + ")");
      assert(log.indexOf("llama.stop") === -1 &&
             log.indexOf("comfy.ensure") === -1 &&
             log.indexOf("comfy.generate") === -1,
             "…and NOTHING was started or stopped first");

      // ---- scenario 4: nvidia-smi dead — the old fixed grace period
      // is the fallback, loudly not silently better.
      log.length = 0;
      delays.length = 0;
      settings = baseSettings();
      vramReadings = [null, null];      // both baselines error out
      run(gen(1), function (r4) {
        assert(r4[0].ok, "no nvidia-smi still generates");
        assert(log.indexOf("llama.stop") !== -1 &&
               log.indexOf("llama.start") !== -1,
               "…with the handoff still happening (unprovable = pause)");
        assert(delays.indexOf(1500) !== -1,
               "…behind the 1.5 s fallback grace, since polling is " +
               "impossible (delays: " + delays.join(",") + ")");

        // ---- scenario 5: the user's own chat server stays THEIR
        // choice — stopped before the round means no resume after it.
        log.length = 0;
        settings = baseSettings();
        llamaState = "stopped";
        vramReadings = [];
        run(gen(1), function (r5) {
          assert(r5[0].ok && log.indexOf("llama.start") === -1,
                 "a chat server the USER had stopped is not restarted " +
                 "by the round");
          console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
          process.exitCode = failed ? 1 : 0;
        });
      });
    });
  });
});
