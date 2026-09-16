// Regression test: the two VRAM readings the panel takes anyway are KEPT
// (WORKPLAN §16f #1-2).
//
// The arbiter measured where the card settled once the chat model was
// paused (`_floorMB`: everything but the chat model, on the user's REAL
// project) and nulled it at resume; `planChatLoad` read memory.used
// before the first chat load (the non-panel baseline) and kept only the
// decision. So §16d's After Effects reserve still rests on one idle
// 3,255 MB reading from 2026-08, while the numbers that would replace it
// were taken and thrown away on every generation.
//
// Now each lands as one JSON line in <dataRoot>/vram-readings.jsonl, with
// the card, the context size and whether a saved project was open.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "aell-vram-readings-"));
const FILE = path.join(ROOT, "vram-readings.jsonl");
const CHAT_GGUF = "C:\\models\\qwen7b.gguf";

let vramReadings = [];
let llamaState = "stopped";
let projectAnswer = "1,12";
let evalCalls = [];
let dataRoot = ROOT;

const fakeFs = Object.assign({}, fs, {
  statSync: (p) => (p === CHAT_GGUF ? { size: 4466 * 1048576 }
                                    : fs.statSync(p)),
  existsSync: (p) => p === CHAT_GGUF || fs.existsSync(p)
});

const window = {
  AEBridge: {
    nodeRequire: (m) => (m === "fs" ? fakeFs : require(m)),
    evalScript: (script, cb) => {
      evalCalls.push(script);
      if (projectAnswer === "ERR") cb("EvalScript error.", true);
      else cb(projectAnswer, false);
    }
  },
  setTimeout: (fn) => setTimeout(fn, 0),
  clearTimeout,
  Settings: { get: () => settings, dataRoot: () => dataRoot },
  Llama: {
    getState: () => llamaState,
    getCurrentModel: () => CHAT_GGUF,
    stop: () => { llamaState = "stopped"; },
    start: (o, cb) => { llamaState = "running"; cb(null); }
  },
  Setup: {
    queryVramUsedMB: (cb) => {
      const v = vramReadings.length > 1 ? vramReadings.shift()
                                        : vramReadings[0];
      if (v === null || typeof v === "undefined") {
        cb(new Error("nvidia-smi unavailable"));
      } else cb(null, v);
    }
  },
  Comfy: {
    listWorkflows: () => [],
    describeWorkflows: () => [],
    backendUrl: () => "http://127.0.0.1:8288",
    readManifest: () => ({ models: [] }),
    freeVram: (url, cb) => cb(null)
  }
};
window.window = window;

let settings = {
  serverPath: "s", modelPath: CHAT_GGUF, port: 1, ctxSize: 16384,
  gpuLayers: 99, vramOverrideGB: 0, comfyPauseLlm: "always",
  comfyModelRoots: []
};

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tiers.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tools.js"), "utf8"));
const Tools = window.Tools;
Tools.setGpuInfo({ hasNvidia: true, vramGB: 32, computeCap: 12.0 });

function readLines() {
  if (!fs.existsSync(FILE)) return [];
  return fs.readFileSync(FILE, "utf8").split("\n")
    .filter((l) => l.length > 0).map((l) => JSON.parse(l));
}
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  // ---- the probe's parse ---------------------------------------------
  const P = Tools._parseProjectProbe;
  assert(JSON.stringify(P("1,12")) === '{"saved":true,"items":12}',
         "'1,12' is a saved project holding 12 items");
  assert(JSON.stringify(P("0,0")) === '{"saved":false,"items":0}',
         "'0,0' is the untitled empty project AE always has open");
  assert(P("") === null && P("EvalScript error.") === null && P(null) === null,
         "anything else is unknown, never a guessed project");

  // ---- #2: launch-time reading before the first chat load ------------
  llamaState = "stopped";
  vramReadings = [3255];
  let plan = null;
  Tools.planChatLoad(settings, (p) => { plan = p; });
  await tick();
  let rows = readLines();
  assert(plan && plan.mode === "ok", "the gate still answers as before");
  assert(rows.length === 1 && rows[0].kind === "launch" &&
         rows[0].usedMB === 3255,
         "planChatLoad's memory.used is kept as a 'launch' reading");
  assert(rows[0].cardMB === 32 * 1024 && rows[0].ctxSize === 16384,
         "…with the card's real size and the context size");
  assert(rows[0].project && rows[0].project.saved === true &&
         rows[0].project.items === 12,
         "…and whether a saved project was open");
  assert(typeof rows[0].at === "string" && !isNaN(Date.parse(rows[0].at)),
         "…and when");
  assert(evalCalls.length === 1 &&
         !/\?[^:]*\?/.test(evalCalls[0].replace(/"[^"]*"/g, "")),
         "the host probe is one evalScript with no nested ternary (ES3)");

  // A load onto a card the chat model already holds is not a baseline.
  llamaState = "running";
  Tools.planChatLoad(settings, () => {});
  await tick();
  assert(readLines().length === 1,
         "no 'launch' reading while the chat model is resident");

  // No nvidia-smi: nothing is written rather than a null reading.
  llamaState = "stopped";
  vramReadings = [null];
  Tools.planChatLoad(settings, () => {});
  await tick();
  assert(readLines().length === 1, "no reading, no line");

  // ---- #1: the handoff floor is kept ---------------------------------
  // Pause: baseline 9 000, then the card drops by the chat model's size.
  llamaState = "running";
  projectAnswer = "ERR";
  vramReadings = [9000, 3900];
  const A = Tools._vramArbiter;
  A.paused = false;
  let refusal = "pending";
  A.ensureFor(settings, { models: [] }, null, (r) => { refusal = r; });
  await tick();
  rows = readLines();
  assert(refusal === null && A.paused === true,
         "pauseMode 'always' pauses the chat model");
  assert(rows.length === 2 && rows[1].kind === "floor" &&
         rows[1].usedMB === 3900 && rows[1].usedMB === A._floorMB,
         "the settled floor is kept as a 'floor' reading (was nulled)");
  assert(rows[1].project === null,
         "a failed host probe records the project as unknown, and still " +
         "records the reading");

  // ---- bounded -------------------------------------------------------
  const filler = [];
  for (let i = 0; i < 250; i++) {
    filler.push(JSON.stringify({ kind: "launch", usedMB: i }));
  }
  fs.writeFileSync(FILE, filler.join("\n") + "\n");
  llamaState = "stopped";
  projectAnswer = "0,0";
  vramReadings = [4100];
  Tools.planChatLoad(settings, () => {});
  await tick();
  rows = readLines();
  assert(rows.length === 200 && rows[199].usedMB === 4100 &&
         rows[0].usedMB === 51,
         "the file keeps the newest 200 lines, oldest dropped");

  // ---- never in the way ----------------------------------------------
  dataRoot = path.join(FILE, "not-a-dir");   // unwritable
  vramReadings = [3300];
  let answered = false;
  Tools.planChatLoad(settings, () => { answered = true; });
  await tick();
  assert(answered, "an unwritable data folder never blocks the load gate");

  fs.rmSync(ROOT, { recursive: true, force: true });
  if (failed) {
    console.error("\n" + failed + " assertion(s) failed");
    process.exit(1);
  }
  console.log("\nall VRAM-reading assertions passed");
})();
