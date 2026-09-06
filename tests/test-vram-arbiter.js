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

/* A fake disk. The chat .gguf is always there; DISK holds the ComfyUI
 * model files, keyed by the path the arbiter would build, so a test can
 * take one away and watch the arithmetic go back to "unprovable".
 * Windows separators, because that is what path.join produces here and
 * what the arbiter is looking at in the field. */
const CHAT_GGUF = "C:\\models\\qwen7b.gguf";
let DISK = {};
const fakeFs = {
  statSync: (p) => {
    if (p === CHAT_GGUF) return { size: 4700 * 1048576 };
    if (Object.prototype.hasOwnProperty.call(DISK, p)) {
      return { size: DISK[p] * 1048576 };
    }
    throw new Error("ENOENT: " + p);
  },
  existsSync: (p) => p === CHAT_GGUF ||
    Object.prototype.hasOwnProperty.call(DISK, p)
};

const window = {
  AEBridge: { nodeRequire: (m) => (m === "fs" ? fakeFs : require(m)) },
  setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); },
  clearTimeout,
  Settings: { get: () => settings },
  Llama: {
    getState: () => llamaState,
    getCurrentModel: () => CHAT_GGUF,
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
    // The shape every SHIPPED manifest really has: a file and the model
    // dir it belongs in, and no size at all. The old stub handed the
    // arbiter sizeMB numbers no bundled template has ever carried, which
    // is why every scenario below passed while the field answer was
    // "the fit cannot be verified" on every card.
    readManifest: () => ({ models: [
      { file: "gen.safetensors", dir: "diffusion_models", role: "diffusion" },
      { file: "enc.safetensors", dir: "text_encoders", role: "text_encoder" },
      { file: "extra.safetensors", dir: "loras", optional: true }
    ] }),
    // The panel asks comfy.js WHICH backend it is talking to (managed
    // vs the user's own) rather than reading comfyUrl — keep the stub
    // faithful to that, or every call site throws.
    backendUrl: (s) => (s && s.comfyUrl) || "http://127.0.0.1:8288",
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
    serverPath: "s", modelPath: CHAT_GGUF, port: 1,
    ctxSize: 16384, gpuLayers: 99, comfyUrl: "http://127.0.0.1:8188",
    comfyWorkflowsDir: "/wf", comfyOutDir: "/out", comfyTimeoutSec: 60,
    comfyPauseLlm: "auto", comfyEnhance: {}, vramOverrideGB: 0,
    comfyDir: "C:\\Users\\x\\ComfyUI", comfyModelsDir: "",
    comfyModelRoots: []
  }, patch || {});
}

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tiers.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tools.js"), "utf8"));
const Tools = window.Tools;

// ------------------------------------------------- the weight bill
//
// The bill is what the card has to fit, and the FILES are the weights.
// Measured 2026-08-30 in the field: not one shipped manifest carries a
// sizeMB, so a manifest-only sum answered null for every template ever
// shipped and a 32 GB card paused chat for every generation it could
// have run beside it.

const jn = (...p) => require("path").join(...p);
const USER_MODELS = jn("C:\\Users\\x\\ComfyUI", "models");
function stockDisk() {
  return {
    [jn(USER_MODELS, "diffusion_models", "gen.safetensors")]: 6000,
    [jn(USER_MODELS, "text_encoders", "enc.safetensors")]: 500,
    // The optional one IS on disk — it must still not be counted, because
    // the run bypasses that branch.
    [jn(USER_MODELS, "loras", "extra.safetensors")]: 999
  };
}
/* A 26.5 GB bill: too much to sit beside a 6.2 GB chat model even on a
 * 32 GB card, so T7 hands the card over too. */
function bigDisk() {
  return {
    [jn(USER_MODELS, "diffusion_models", "gen.safetensors")]: 26000,
    [jn(USER_MODELS, "text_encoders", "enc.safetensors")]: 500
  };
}
DISK = stockDisk();
settings = baseSettings();

assert(Tools._genNeedMBFor(window.Comfy.readManifest(), settings) === 6500,
       "a shipped-shape manifest (file + dir, NO sizeMB) is measured on " +
       "disk: 6000 + 500, optional branch excluded");

assert(Tools._genNeedMBFor({ models: [
         { file: "gen.safetensors", dir: "diffusion_models", sizeMB: 4321 }
       ] }, settings) === 4321,
       "a manifest that DOES author a size is believed without touching " +
       "the disk");

{
  // One weight the panel cannot find is one weight it cannot count. A
  // partial sum reads like a verified fit and understates the bill in
  // exactly the direction that OOMs a card.
  const missing = Object.assign({}, stockDisk());
  delete missing[jn(USER_MODELS, "text_encoders", "enc.safetensors")];
  DISK = missing;
  assert(Tools._genNeedMBFor(window.Comfy.readManifest(), settings) === null,
         "ONE weight no root holds makes the whole answer unprovable, not " +
         "a partial sum");
  DISK = stockDisk();
}

{
  // The user with models on another drive: a whole tree, and a per-kind
  // root written "kind=path", which answers only for its own kind.
  const spread = {
    [jn("D:\\big", "diffusion_models", "gen.safetensors")]: 6000,
    [jn("E:\\enc", "enc.safetensors")]: 500
  };
  DISK = spread;
  settings = baseSettings({ comfyDir: "", comfyModelsDir: "D:\\big",
                            comfyModelRoots: ["text_encoders=E:\\enc"] });
  assert(Tools._genNeedMBFor(window.Comfy.readManifest(), settings) === 6500,
         "comfyModelsDir and a 'kind=path' extra root both resolve");
  settings = baseSettings({ comfyDir: "", comfyModelsDir: "D:\\big",
                            comfyModelRoots: ["loras=E:\\enc"] });
  assert(Tools._genNeedMBFor(window.Comfy.readManifest(), settings) === null,
         "…and a per-kind root does NOT answer for a different kind");
  DISK = stockDisk();
  settings = baseSettings();
}

// ---- the roots the panel does not own -------------------------------
//
// ComfyUI loads models from places nothing in the panel's settings names,
// and a weight the panel cannot FIND is a generation it cannot PRICE:
// unprovable means pause the chat model, and refuse outright when pausing
// is set to never. Measured in the field 2026-08-30 by the tier ladder:
// all four MiniMax H3 weights on the dev machine live in the ComfyUI
// DESKTOP app's shared auto-download store, which no config file declares
// and no setting pointed at — so the shipped H3 template priced at null on
// a machine that had already rendered with it.
{
  const env = require("process").env;
  const savedLocal = env.LOCALAPPDATA, savedApp = env.APPDATA;
  env.LOCALAPPDATA = "C:\\Users\\x\\AppData\\Local";
  env.APPDATA = "C:\\Users\\x\\AppData\\Roaming";
  const SHARED = jn(env.LOCALAPPDATA, "Comfy-Desktop", "ComfyUI-Shared",
                    "models");

  settings = baseSettings({ comfyDir: "", comfyModelsDir: "",
                            comfyModelRoots: [] });
  DISK = {
    [jn(SHARED, "diffusion_models", "gen.safetensors")]: 6000,
    [jn(SHARED, "text_encoders", "enc.safetensors")]: 500
  };
  assert(Tools._genNeedMBFor(window.Comfy.readManifest(), settings) === 6500,
         "weights only in the Desktop app's shared store are found — no " +
         "setting and no config file names that root");

  // The classic answer to "my models are on another drive" is ComfyUI's
  // own yaml, next to main.py. The panel has to read what the user told
  // COMFYUI, because they had no reason to tell the panel twice.
  const YAML_DIR = "C:\\Users\\x\\ComfyUI";
  const yamlFile = jn(YAML_DIR, "extra_model_paths.yaml");
  const yamlText = [
    "# comment",
    "comfyui:",
    "  base_path: D:/spread",
    "  diffusion_models: models/diffusion_models",
    "  text_encoders: |",
    "    nowhere/one",
    "    models/text_encoders",
    "other:",
    "  loras: Z:/never/loras"
  ].join("\n");
  const withYaml = Object.assign({}, fakeFs);
  DISK = {
    [jn("D:/spread", "models", "diffusion_models", "gen.safetensors")]: 6000,
    [jn("D:/spread", "models", "text_encoders", "enc.safetensors")]: 500
  };
  const realExists = fakeFs.existsSync, realStat = fakeFs.statSync;
  fakeFs.existsSync = (p) => p === yamlFile || realExists(p);
  fakeFs.readFileSync = (p) => {
    if (p === yamlFile) return yamlText;
    throw new Error("ENOENT: " + p);
  };
  settings = baseSettings({ comfyDir: YAML_DIR, comfyModelsDir: "",
                            comfyModelRoots: [] });
  assert(Tools._genNeedMBFor(window.Comfy.readManifest(), settings) === 6500,
         "extra_model_paths.yaml roots resolve: base_path + a per-kind " +
         "key, and a '|' block whose SECOND line is the real one");

  const parsed = [];
  Tools._parseComfyPathsYaml(yamlText, require("path"), parsed);
  assert(parsed.length === 4 &&
         parsed[0].kind === "diffusion_models" &&
         parsed[3].kind === "loras" && parsed[3].path === "Z:/never/loras",
         "an ABSOLUTE value needs no base_path, and each section is " +
         "resolved against its own (got " + parsed.length + ")");

  // The Desktop app writes base_path LAST and calls the whole tree
  // `download_model_base` — a section's keys cannot be resolved until the
  // section ends. This is the real file from the dev machine.
  const desktop = [];
  Tools._parseComfyPathsYaml([
    "# ComfyUI extra_model_paths.yaml for win32",
    "comfyui_desktop:",
    "  is_default: \"true\"",
    "  custom_nodes: custom_nodes/",
    "  download_model_base: models",
    "  base_path: C:\\Users\\x\\Documents\\ComfyUI",
    "desktop_extensions:",
    "  custom_nodes: C:\\Users\\x\\AppData\\Local\\Programs\\ComfyUI"
  ].join("\n"), require("path"), desktop);
  assert(desktop.length === 1 && desktop[0].kind === null &&
         desktop[0].path === jn("C:\\Users\\x\\Documents\\ComfyUI", "models"),
         "the Desktop config yields ONE whole-tree root, resolved against " +
         "a base_path written after it, and no custom_nodes root (got " +
         JSON.stringify(desktop) + ")");

  // Reaching one tree two ways must not make it two roots.
  settings = baseSettings({ comfyDir: YAML_DIR });
  const roots = Tools._comfyModelRoots(settings);
  const sigs = roots.map(r => String(r.kind) + " " + r.path.toLowerCase());
  assert(sigs.length === new Set(sigs).size,
         "a root reached twice is listed once (" + sigs.join(" | ") + ")");

  fakeFs.existsSync = realExists;
  fakeFs.statSync = realStat;
  delete fakeFs.readFileSync;
  if (savedLocal === undefined) delete env.LOCALAPPDATA;
  else env.LOCALAPPDATA = savedLocal;
  if (savedApp === undefined) delete env.APPDATA;
  else env.APPDATA = savedApp;
  DISK = stockDisk();
  settings = baseSettings();
}

// What the panel would have SAID — the status lines are half the contract.
const sink = [];
Tools.setProgressSink((msg) => { sink.push(msg); });

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
      assert(!/override/i.test(r3[0].error),
             "a REAL 8 GB card's refusal says nothing about an override");

      // ---- scenario 3b: the same refusal on an IMPERSONATED card.
      // Found in the field 2026-08-30 by chat-probe step 14: the chat
      // model's figure is measured off what is really loaded while the
      // card's comes from vramOverrideGB, so the two can contradict
      // each other outright — a 32B model on an 8 GB override reads
      // "the chat model holds ~20 GB of the card's 8 GB". Both numbers
      // are true; the sentence has to say which one is a fiction.
      log.length = 0;
      settings = baseSettings({ comfyPauseLlm: "never",
                                vramOverrideGB: 8 });
      Tools.setGpuInfo({ hasNvidia: true, vramGB: 32, computeCap: 12 });
      run(gen(1), function (r3b) {
        assert(r3b[0].ok === false && /8 GB \(VRAM override\)/
                 .test(r3b[0].error),
               "an impersonated budget is named as one (got: " +
               (r3b[0].error || "ok") + ")");
        assert(/6\.3 GB/.test(r3b[0].error) && /6\.1 GB/.test(r3b[0].error),
               "…without losing either measured number");

      // ---- scenario 4: nvidia-smi dead — the old fixed grace period
      // is the fallback, loudly not silently better.
      log.length = 0;
      delays.length = 0;
      settings = baseSettings();
      // Declared, not inherited: this scenario is about a card too small
      // for both, and it used to pick that up from whichever scenario ran
      // before it.
      Tools.setGpuInfo({ hasNvidia: true, vramGB: 8, computeCap: 8.9 });
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

          // ---- scenario 6: ComfyUI has ALREADY let go by the time the
          // round ends.
          //
          // Measured 2026-08-30 on a 5090: ComfyUI 0.32 drops a finished
          // generation's ~19.5 GB about TEN SECONDS before the round is
          // over, so /free frees nothing and the card is already at the
          // floor. The resume used to sample a fresh baseline at that
          // moment and then wait for it to drop 512 MB further — which can
          // never happen — so every healthy paused round paid a full 10 s
          // timeout and told the user "VRAM did not visibly release".
          // The wait is an absolute question now: are we back at the floor
          // the pause left?
          log.length = 0;
          delays.length = 0;
          sink.length = 0;
          llamaState = "running";
          settings = baseSettings();
          Tools.setGpuInfo({ hasNvidia: true, vramGB: 8, computeCap: 8.9 });
          vramReadings = [7000,   // baseline before the stop
                          600,    // released: the floor is 600
                          620,    // resume: already there, nothing to wait for
                          // …and plenty more of the same, so a version that
                          // waits for a further drop has something to spin
                          // on rather than running the array dry.
                          620, 620, 620, 620, 620, 620, 620, 620, 620,
                          620, 620, 620, 620, 620, 620, 620, 620, 620];
          run(gen(1), function (r6) {
            assert(r6[0].ok, "the round still generates");
            const polls = log.filter((x) => /^smi:/.test(x)).length;
            assert(polls === 3,
                   "an already-released card costs ONE resume poll, not " +
                   "twenty (3 nvidia-smi reads total, got " + polls + ")");
            assert(sink.join(" ").indexOf("did not visibly release") === -1,
                   "…and nothing cries about a release that had already " +
                   "happened (said: " + sink.join(" | ") + ")");
            assert(delays.filter((d) => d === 500).length <= 1,
                   "…and it does not sit in the 500 ms poll loop " +
                   "(delays: " + delays.join(",") + ")");
            assert(llamaState === "running",
                   "…the chat model is back either way");

          // ---- scenario 7: ComfyUI is still holding the card, and there
          // is ROOM ANYWAY.
          //
          // Measured 2026-08-30 (0.10.14's own probe, re-run): after a
          // cancelled round the card sat at 23 654 MB of 32 768 for the
          // whole wait and fell to 2 918 MB one second after it expired,
          // so the panel told a user with 29 GB free that their VRAM had
          // not been released. The floor is a harder question than the
          // resume needs: what llama-server has to have is ROOM, and a
          // card holding a generation's cache can have plenty.
          //
          // 32 GB card, chat model 4700 MB file (+1536 overhead = 6236),
          // ComfyUI sitting on 8000 MB: 24 768 MB free, nowhere near the
          // 900 MB floor. The old floor-only wait spun 20 polls and cried.
          log.length = 0;
          delays.length = 0;
          sink.length = 0;
          llamaState = "running";
          settings = baseSettings();
          Tools.setGpuInfo({ hasNvidia: true, vramGB: 32, computeCap: 12 });
          DISK = bigDisk();       // a bill this 32 GB card must still pause for
          vramReadings = [20000,        // baseline before the stop
                          900,          // released: the floor is 900
                          8000,         // resume: ComfyUI's cache, room to spare
                          8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000,
                          8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000,
                          8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000];
          run(gen(1), function (r7) {
            assert(r7[0].ok, "the round still generates");
            assert(log.indexOf("llama.stop") !== -1,
                   "…having really paused chat (a 32 GB card the bill " +
                   "does not fit beside)");
            const polls7 = log.filter((x) => /^smi:/.test(x)).length;
            assert(polls7 === 3,
                   "a card with ROOM costs ONE resume poll even though it " +
                   "is nowhere near the floor (3 reads total, got " +
                   polls7 + ")");
            assert(sink.join(" ").indexOf("did not visibly release") === -1 &&
                   sink.join(" ").indexOf("loading it anyway") === -1,
                   "…and nothing is claimed about a release that did not " +
                   "have to happen (said: " + sink.join(" | ") + ")");
            assert(llamaState === "running", "…the chat model is back");

            // ---- scenario 8: and when there really is NO room, the
            // sentence says what it measured instead of asserting a
            // release failure. 8 GB card, ComfyUI keeping 7000 MB, a
            // chat model that needs 6236: it waits, gives up, and says
            // so with all three numbers in it.
            log.length = 0;
            delays.length = 0;
            sink.length = 0;
            llamaState = "running";
            settings = baseSettings();
            Tools.setGpuInfo({ hasNvidia: true, vramGB: 8, computeCap: 8.9 });
            DISK = stockDisk();
            vramReadings = [20000, 900].concat(
              new Array(200).fill(7000));    // never any room, ever
            run(gen(1), function (r8) {
              assert(r8[0].ok, "the round still generates");
              const said = sink.join(" | ");
              assert(said.indexOf("did not visibly release") === -1,
                     "a full card is not reported as a failed release " +
                     "(said: " + said + ")");
              assert(/still holds 7000 MB of 8192 MB/.test(said) &&
                     /needs about 6236 MB/.test(said),
                     "…it is reported with the three numbers that make it " +
                     "true (said: " + said + ")");
              assert(llamaState === "running",
                     "…and the chat model is loaded anyway — proceeding " +
                     "loudly, never hanging");
              const polls8 = log.filter((x) => /^smi:/.test(x)).length;
              assert(polls8 > 20 && polls8 <= 63,
                     "…after a wait long enough to outlast this backend's " +
                     "own ~10.5 s post-cancel release (" + polls8 +
                     " reads)");

              console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
              process.exitCode = failed ? 1 : 0;
            });
          });
          });
        });
      });
      });
    });
  });
});
