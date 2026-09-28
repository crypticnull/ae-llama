// Regression test: the VRAM reserve for After Effects (§16b), and the
// gate in front of the chat model's own load.
//
// THE FIELD INCIDENT THIS EXISTS FOR (2026-09-15, the owner's machine):
// After Effects at 14:01, the panel's 32B chat model at 14:08, 28,804
// MiB of 32,607 held between them, and at 14:28 the display went black
// and froze with NO driver event logged. Stopping llama-server dropped
// the card to 5,572 MiB and the picture came back.
//
// The panel never did any arithmetic there, because it had none to do:
// `planHandoff` runs when a GENERATION is asked for, so the chat model's
// own `Llama.start` was the one VRAM decision made with no sum at all.
// The owner's decision (same day) is that the reserve is UNCONDITIONAL —
// not a setting, not a tier option.
//
// The stub could not have caught it before this file: nothing modelled a
// load that leaves the desktop with nothing.
"use strict";
const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------------------- fakes
const CHAT_GGUF = "C:\\models\\qwen7b.gguf";
let GGUF_MB = 4466;                  // Q4_K_M 7B, version.js:58
let vramUsed = 3255;                 // AE idle + desktop (LOG:7428)
let smiWorks = true;
let llamaState = "stopped";
const log = [];

const fakeFs = {
  statSync: (p) => {
    if (p === CHAT_GGUF) return { size: GGUF_MB * 1048576 };
    throw new Error("ENOENT: " + p);
  },
  existsSync: (p) => p === CHAT_GGUF
};

const window = {
  AEBridge: { nodeRequire: (m) => (m === "fs" ? fakeFs : require(m)) },
  setTimeout: (fn) => setTimeout(fn, 0),
  clearTimeout,
  Settings: { get: () => settings },
  Llama: {
    getState: () => llamaState,
    getCurrentModel: () => CHAT_GGUF,
    stop: () => { llamaState = "stopped"; },
    start: (o, cb) => { llamaState = "running"; cb(null); }
  },
  Setup: {
    queryVramUsedMB: (cb) => {
      log.push("smi");
      if (!smiWorks) { cb(new Error("nvidia-smi unavailable")); return; }
      cb(null, vramUsed);
    }
  },
  Comfy: {
    listWorkflows: () => [],
    describeWorkflows: () => [],
    backendUrl: (s) => (s && s.comfyUrl) || "http://127.0.0.1:8288",
    readManifest: () => ({ models: [] }),
    freeVram: (url, cb) => cb(null)
  }
};
window.window = window;

let settings = {
  serverPath: "s", modelPath: CHAT_GGUF, port: 1, ctxSize: 16384,
  gpuLayers: 99, vramOverrideGB: 0, comfyPauseLlm: "auto",
  comfyModelRoots: []
};

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tiers.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tools.js"), "utf8"));
const T = window.Tiers;
const Tools = window.Tools;

// ---- the two constants, and why there are two -------------------------
//
// One number cannot serve both sums. `planHandoff` sizes against the
// card's TOTAL, where nothing accounts for After Effects, so the reserve
// there must include AE's own resident footprint. `planChatLoad` starts
// from a MEASURED `memory.used`, which already contains it — charging
// for AE twice would refuse loads that fit.
{
  assert(T.desktopFreeMB() === 4096,
         "the desktop floor is 4,096 MB — the display starved at 3,803 " +
         "MB free, so the floor has to sit above the reading that failed");
  assert(T.hostReserveMB() === 3255 + 4096,
         "the TOTAL-based reserve is AE's measured 3,255 MB on top of it");
  assert(T.hostReserveMB() > T.desktopFreeMB(),
         "…so the two are never interchangeable");
}

// ---- planChatLoad: the arithmetic, pure -------------------------------
{
  const P = T.planChatLoad;
  const card32 = { cardTotalMB: 32607, gpuLayers: 99 };

  // The incident's own shape: AE with a real project, then a 32B model.
  const bad = P(Object.assign({ usedMB: 5572, chatNeedMB: 23232 }, card32));
  assert(bad.mode === "tight",
         "AE at 5.4 GB plus a 23 GB model leaves 3.7 GB — the reading " +
         "that froze the owner's display is TIGHT, not ok (got " +
         bad.mode + ")");
  assert(/freeze/.test(bad.reason) && /smaller model/.test(bad.reason),
         "…and the warning says what happens and what to do instead");

  const ok = P(Object.assign({ usedMB: 3255, chatNeedMB: 6002 }, card32));
  assert(ok.mode === "ok" && ok.freeAfterMB === 32607 - 3255 - 6002,
         "the 7B on the same card is fine, and the plan carries the " +
         "figure it decided on");

  // Physical impossibility is the ONLY thing that stops a load. An 8 GB
  // card + a 6 GB model is 'tight', NOT refused: that would decide the
  // honest chat floor for every 8 GB user by arithmetic, and §16d
  // reserves that call for the owner.
  const small = P({ cardTotalMB: 8192, usedMB: 1200, chatNeedMB: 6002,
                    gpuLayers: 99 });
  assert(small.mode === "tight",
         "8 GB card, 6 GB model: warned, not refused — the tier call is " +
         "the owner's, not this function's");
  const nope = P({ cardTotalMB: 8192, usedMB: 3255, chatNeedMB: 23232,
                   gpuLayers: 99 });
  assert(nope.mode === "refuse" && /will not fit/.test(nope.reason) &&
         /CPU/.test(nope.reason),
         "a model bigger than the free VRAM is refused, with the way out");

  // Unprovable is never a refusal — a gate that guesses is worse than
  // no gate, and every one of these is a real machine.
  assert(P({ cardTotalMB: null, usedMB: 3255, chatNeedMB: 6002,
             gpuLayers: 99 }).mode === "unknown" &&
         P({ cardTotalMB: 32607, usedMB: null, chatNeedMB: 6002,
             gpuLayers: 99 }).mode === "unknown" &&
         P({ cardTotalMB: 32607, usedMB: 3255, chatNeedMB: null,
             gpuLayers: 99 }).mode === "unknown",
         "no card / no reading / no model size -> unknown, load proceeds");
  const cpu = P({ cardTotalMB: 8192, usedMB: 8000, chatNeedMB: 23232,
                  gpuLayers: 0 });
  assert(cpu.mode === "unknown" && /system RAM/.test(cpu.reason),
         "GPU layers 0 asks nothing of the card, so nothing is refused");
}

// ---- freeFloorWarning: the READING, after the fact --------------------
//
// The prediction prices a model at file size plus a flat constant. At the
// incident the real footprint landed ~800 MB under the floor while that
// estimate said it was clear, so the only honest check is to look again
// once the memory is really allocated.
{
  assert(T.freeFloorWarning(32607, 28804) !== null,
         "28,804 of 32,607 — the incident's own reading — warns");
  assert(/Stop/.test(T.freeFloorWarning(32607, 28804)),
         "…and names the one action that frees it without closing AE");
  assert(T.freeFloorWarning(32607, 9724) === null,
         "a card with 22 GB free says nothing");
  assert(T.freeFloorWarning(null, 28804) === null &&
         T.freeFloorWarning(32607, null) === null,
         "an unmeasured card claims nothing in either direction");
}

// ---- the wiring: Tools.planChatLoad reads the REAL numbers ------------
{
  const gpu = { hasNvidia: true, vramGB: 32, computeCap: 12.0 };
  Tools.setGpuInfo(gpu);

  let plan = null;
  vramUsed = 3255;
  Tools.planChatLoad(settings, (p) => { plan = p; });
  assert(plan && plan.mode === "ok",
         "a 7B onto an idle 32 GB card: ok (got " +
         (plan && plan.mode) + ")");

  // The model's cost is its FILE, not a guess — same rule, same
  // constant, as the running-model figure the arbiter already uses.
  GGUF_MB = 27000;
  vramUsed = 5572;
  Tools.planChatLoad(settings, (p) => { plan = p; });
  assert(plan.mode === "refuse",
         "a 27 GB file onto a card holding 5.5 GB is refused before " +
         "llama-server is ever spawned");
  GGUF_MB = 4466;

  // The override impersonates a card for POLICY; this gate asks a
  // physical question about a physical reading, so the override must
  // not reach it (cardTotalMBNow's rule).
  vramUsed = 3255;
  const overridden = Object.assign({}, settings, { vramOverrideGB: 8 });
  Tools.planChatLoad(overridden, (p) => { plan = p; });
  assert(plan.mode === "ok",
         "vramOverrideGB does NOT shrink the card this gate measures " +
         "against — a fiction beside a real reading is arithmetic about " +
         "no machine");

  // nvidia-smi missing is the common laptop/driver case, and it must not
  // block the panel's core function.
  smiWorks = false;
  Tools.planChatLoad(settings, (p) => { plan = p; });
  assert(plan.mode === "unknown" && /could not measure/.test(plan.reason),
         "no nvidia-smi -> unknown, and the panel says so rather than " +
         "pretending it checked");
  smiWorks = true;

  // No GPU info pushed yet (detectGpu has not answered): same rule.
  Tools.setGpuInfo(null);
  Tools.planChatLoad(settings, (p) => { plan = p; });
  assert(plan.mode === "unknown",
         "before detectGpu answers there is no card to size against");
  Tools.setGpuInfo(gpu);

  let warn = "nothing yet";
  vramUsed = 28804;
  Tools.checkVramAfterChatLoad((w) => { warn = w; });
  assert(typeof warn === "string" && /28804/.test(warn),
         "after the load the card is READ, and the incident's number is " +
         "reported back to the user");
  vramUsed = 9724;
  Tools.checkVramAfterChatLoad((w) => { warn = w; });
  assert(warn === null, "…and a healthy card is not nagged");
}

// ---- main.js really calls it -----------------------------------------
//
// The arithmetic is worth nothing if the panel still starts the server
// without asking. main.js is DOM-bound and cannot be evaluated here, so
// this reads the call site — the same technique the other panel-wiring
// tests use.
{
  const main = fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                         "main.js"), "utf8");
  const fn = main.slice(main.indexOf("function startServer()"),
                        main.indexOf("function updateServerButton"));
  assert(/Tools\.planChatLoad\(/.test(fn),
         "startServer asks the gate before it starts anything");
  assert(fn.indexOf("Tools.planChatLoad") < fn.indexOf("Llama.start"),
         "…BEFORE Llama.start, not after it (the incident was a load " +
         "that had already happened)");
  assert(/mode === "refuse"/.test(fn) && /mode === "tight"/.test(fn),
         "…and acts on both outcomes, not just the refusal");
  assert(/checkVramAfterChatLoad/.test(fn),
         "…then reads the card once the model is really resident");
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
