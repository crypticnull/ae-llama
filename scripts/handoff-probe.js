/*
 * handoff-probe.js — WORKPLAN item 7, bullet 1: drive the chat<->generation
 * VRAM handoff on a real card, headless, and write down the real numbers.
 *
 * The tier plan (docs/COMFY_TIERS_PLAN.md) and the arbiter in tools.js were
 * built and stub-tested without ever touching a GPU. Everything the stubs
 * assert is arithmetic the stubs themselves supply. This runs the SAME code
 * against a real llama-server, a real ComfyUI, real weights and real
 * nvidia-smi, and reports what actually changed hands:
 *
 *   settings.js + tiers.js + llama.js + comfy.js + tools.js   (the panel)
 *     -> Tools.executeCommands([comfy_generate])              (the real path)
 *     -> a REAL llama-server and a REAL local ComfyUI
 *     -> nvidia-smi sampled throughout, as the witness
 *
 * Two rounds, because the interesting behaviour is the DIFFERENCE:
 *
 *   A. no override      — the card's own VRAM decides. On a 32 GB card with
 *                         a small chat model the arithmetic should say
 *                         CONCURRENT and nothing should be paused.
 *   B. vramOverrideGB 8 — the same job on an impersonated 8 GB card must
 *                         pause chat, generate, POST /free, and warm the
 *                         chat model back up. Total used VRAM has to
 *                         actually DROP at the handoff and again after /free
 *                         or the "verified release" is not verified.
 *
 * It also answers the tier plan's open question directly: does this backend
 * support POST /free {unload_models:true}? The HTTP status and the observed
 * VRAM delta are recorded either way.
 *
 *   node scripts/handoff-probe.js
 *   node scripts/handoff-probe.js --model <path.gguf>   # chat model to use
 *   node scripts/handoff-probe.js --workflow AE_LLAMA_KREA2_V1
 *   node scripts/handoff-probe.js --width 768 --height 768
 *   node scripts/handoff-probe.js --rounds a            # a, b or ab
 *   node scripts/handoff-probe.js --override 8          # round B's budget
 *   node scripts/handoff-probe.js --reuse-server        # do not start llama
 *
 * NO After Effects: every generation runs with {import: false}, so nothing
 * touches the user's project and no dialog can be raised. Files land in
 * logs/handoff-probe/. Writes a markdown transcript to logs/ and exits 0
 * only if every verdict passed.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const managed = require("./lib/comfy-managed.js");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const OPT = {
  model: argValue("--model", null),
  workflow: argValue("--workflow", "AE_LLAMA_KREA2_V1"),
  prompt: argValue("--prompt", null),
  width: parseInt(argValue("--width", "768"), 10),
  height: parseInt(argValue("--height", "768"), 10),
  seed: parseInt(argValue("--seed", "24680"), 10),
  rounds: String(argValue("--rounds", "ab")).toLowerCase(),
  override: parseInt(argValue("--override", "8"), 10),
  timeout: parseInt(argValue("--timeout", "1800"), 10),
  reuseServer: argv.indexOf("--reuse-server") !== -1
};

// --------------------------------------------------------- the panel, in Node

const storage = {};
const window = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  localStorage: {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null;
    },
    setItem(k, v) { storage[k] = String(v); },
    removeItem(k) { delete storage[k]; }
  },
  AEBridge: {
    nodeRequire: require,
    getExtensionPath() { return EXT; },
    // Every generation here runs with {import:false}, so nothing should
    // ever reach After Effects. If something does, say so loudly rather
    // than silently launching AE from an unattended probe.
    evalScript(script, cb) {
      say("error", "AE was called and this probe has no AE half: " +
                   String(script).slice(0, 120));
      if (cb) cb("", true);
    }
  }
};
window.window = window;

function loadPanelFile(rel) {
  const src = fs.readFileSync(path.join(EXT, "js", rel), "utf8");
  new Function("window", src)(window);
}
loadPanelFile("settings.js");
loadPanelFile("tiers.js");
loadPanelFile("setup.js");
loadPanelFile("llama.js");
loadPanelFile("comfy.js");
loadPanelFile("tools.js");

const Settings = window.Settings;
const Comfy = window.Comfy;
const Llama = window.Llama;
const Tiers = window.Tiers;
const Tools = window.Tools;

/* The probe reads the user's REAL settings and overrides only what it must:
 * the workflow dir (the REPO's shipped template, not a stale install copy),
 * the output dir (probe junk out of the user's generated/), the timeout, and
 * the two knobs the rounds are about. */
const OUT_DIR = path.join(ROOT, "logs", "handoff-probe");
const OVERRIDE = {
  comfyWorkflowsDir: path.join(EXT, "comfy-workflows"),
  comfyOutDir: OUT_DIR,
  comfyTimeoutSec: OPT.timeout,
  vramOverrideGB: 0
};
if (OPT.model) OVERRIDE.modelPath = OPT.model;
const realGet = Settings.get;
Settings.get = function () {
  const s = realGet.apply(Settings, arguments);
  for (const k in OVERRIDE) s[k] = OVERRIDE[k];
  return s;
};

// --------------------------------------------------------------- reporting

const transcript = [];
let failures = 0;
function say(kind, text) {
  transcript.push({ kind: kind, text: text });
  const tag = { info: "--", tool: "..", verdict: "==", error: "!!" }[kind] || "  ";
  console.log(tag + " " + String(text).replace(/\n/g, "\n   "));
}
function verdict(ok, label, detail) {
  if (!ok) failures++;
  say("verdict", (ok ? "PASS " : "FAIL ") + label + (detail ? " — " + detail : ""));
}

// ------------------------------------------------------------ VRAM witness

/* One timeline for the whole run: every sample carries the label of the
 * phase it landed in, so the transcript shows WHEN the memory moved and
 * not merely that it did. */
const timeline = [];
let phase = "start";
let vramTimer = null;
function setPhase(p) {
  phase = p;
  say("info", "[phase] " + p);
  // A phase can be shorter than the sampler's period; take one reading of
  // its own so no phase is invisible in the timeline.
  sampleVram(function (mb) {
    if (mb !== null) timeline.push({ t: Date.now(), mb: mb, phase: p });
  });
}

function sampleVram(cb) {
  execFile("nvidia-smi",
    ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
    { timeout: 10000 }, function (err, out) {
      if (err) { cb(null); return; }
      const mb = parseInt(String(out).trim().split(/\r?\n/)[0], 10);
      cb(isNaN(mb) ? null : mb);
    });
}
function watchOn() {
  if (vramTimer) return;
  vramTimer = setInterval(function () {
    sampleVram(function (mb) {
      if (mb !== null) timeline.push({ t: Date.now(), mb: mb, phase: phase });
    });
  }, 500);
}
function watchOff() {
  if (vramTimer) clearInterval(vramTimer);
  vramTimer = null;
}
/** Highest / lowest reading recorded while a phase (prefix) was current. */
function phaseStats(prefix) {
  const rows = timeline.filter((r) => r.phase.indexOf(prefix) === 0);
  if (!rows.length) return null;
  let min = rows[0].mb, max = rows[0].mb;
  for (const r of rows) { if (r.mb < min) min = r.mb; if (r.mb > max) max = r.mb; }
  return { n: rows.length, min: min, max: max,
           first: rows[0].mb, last: rows[rows.length - 1].mb };
}
function fmtStats(s) {
  return s ? s.min + "-" + s.max + " MB over " + s.n + " samples"
           : "no samples";
}

// ------------------------------------------------------- instrumentation

/* The arbiter's decision is not in its result — it is a status line and a
 * side effect. Wrap the pure function it asks so the probe records the
 * exact inputs and the exact answer, and let the real one run. */
const decisions = [];
const realPlan = Tiers.planHandoff;
Tiers.planHandoff = function (inp) {
  const out = realPlan.call(Tiers, inp);
  decisions.push({ input: inp, output: out });
  say("info", "planHandoff(" + JSON.stringify(inp) + ") -> " +
              out.mode + ": " + out.reason);
  return out;
};

/* /free is best-effort inside the arbiter (an older backend answering 404
 * must not break the resume), so its answer never surfaces. The tier plan
 * asks what this backend really says — record it. */
const frees = [];
const realFree = Comfy.freeVram;
Comfy.freeVram = function (url, cb) {
  const t0 = Date.now();
  sampleVram(function (before) {
    realFree.call(Comfy, url, function (err) {
      sampleVram(function (after) {
        frees.push({ err: err ? err.message : null, before: before,
                     after: after, ms: Date.now() - t0 });
        say("info", "Comfy.freeVram -> " + (err ? err.message : "ok") +
                    " (VRAM " + before + " -> " + after + " MB, " +
                    (Date.now() - t0) + " ms)");
        cb(err);
      });
    });
  });
};

/** POST /free directly, for the HTTP status the panel's wrapper hides. */
function rawFree(url, cb) {
  const http = require("http");
  const u = new URL(url);
  const body = JSON.stringify({ unload_models: true, free_memory: true });
  const req = http.request({ hostname: u.hostname, port: u.port,
    path: "/free", method: "POST",
    headers: { "Content-Type": "application/json",
               "Content-Length": Buffer.byteLength(body) } },
    function (res) {
      let text = "";
      res.on("data", (d) => { text += d.toString(); });
      res.on("end", () => cb(null, res.statusCode, text.slice(0, 200)));
    });
  req.on("error", (e) => cb(e));
  req.write(body);
  req.end();
}

// ------------------------------------------------------------------- setup

function detectGpu(cb) {
  execFile("nvidia-smi",
    ["--query-gpu=name,compute_cap,memory.total",
     "--format=csv,noheader,nounits"], { timeout: 15000 },
    function (err, out) {
      if (err) { cb({ hasNvidia: false, vramGB: null }); return; }
      const p = String(out).split(/\r?\n/)[0].split(",");
      cb({ hasNvidia: true,
           name: (p[0] || "").trim() || null,
           computeCap: /^\d+(\.\d+)?$/.test((p[1] || "").trim())
             ? parseFloat(p[1].trim()) : null,
           vramGB: /^\d+$/.test((p[2] || "").trim())
             ? Math.round(parseInt(p[2].trim(), 10) / 1024) : null });
    });
}

function startChat(cb) {
  const s = Settings.get();
  if (OPT.reuseServer) {
    say("info", "--reuse-server: using whatever listens on " + s.port);
    cb(null);
    return;
  }
  say("info", "starting llama-server: " + s.modelPath);
  let settled = false;
  const giveUp = setTimeout(function () {
    if (!settled) { settled = true; cb(new Error("chat server never came up")); }
  }, 900000);
  Llama.on("status", function (state, detail) {
    if (state === "error") say("error", "llama: " + detail);
    if (state === "running" && !settled) {
      settled = true;
      clearTimeout(giveUp);
      cb(null);
    }
  });
  Llama.start({ serverPath: s.serverPath, modelPath: s.modelPath,
                port: s.port, ctxSize: s.ctxSize, gpuLayers: s.gpuLayers },
    function (err) {
      if (err && !settled) { settled = true; clearTimeout(giveUp); cb(err); }
    });
}

// -------------------------------------------------------------- the rounds

function generateArgs() {
  return {
    workflow: OPT.workflow,
    prompt: OPT.prompt ||
      "A single red enamel coffee cup on a pale concrete surface, soft " +
      "north-window daylight, shallow depth of field, photographic.",
    width: OPT.width,
    height: OPT.height,
    seed: OPT.seed,
    "import": false
  };
}

/**
 * One round through the REAL panel path. Returns everything the verdicts
 * need: the decision the arbiter took, whether llama was up while ComfyUI
 * worked, and the wall clock.
 */
function runRound(label, cb) {
  const before = decisions.length;
  const freesBefore = frees.length;
  const status = [];
  Tools.setProgressSink(function (msg) {
    status.push(msg);
    say("tool", msg);
  });
  setPhase(label + ":decide");
  // Sampled mid-generation: is the chat server still holding the card?
  let chatDuringGen = null;
  const watcher = setInterval(function () {
    if (chatDuringGen === null && phase === label + ":generate") {
      chatDuringGen = Llama.getState();
    }
  }, 250);
  const t0 = Date.now();
  const realGenerate = Comfy.generate;
  Comfy.generate = function (opts, prog, done) {
    setPhase(label + ":generate");
    Comfy.generate = realGenerate;
    return realGenerate.call(Comfy, opts, prog, done);
  };
  Tools.executeCommands([{ tool: "comfy_generate", args: generateArgs() }],
    {}, null, function (results) {
      const ms = Date.now() - t0;
      Comfy.generate = realGenerate;
      clearInterval(watcher);
      setPhase(label + ":done");
      cb({
        result: results[0] || {},
        decision: decisions.length > before
          ? decisions[decisions.length - 1] : null,
        free: frees.length > freesBefore ? frees[frees.length - 1] : null,
        status: status,
        chatDuringGen: chatDuringGen,
        chatAfter: Llama.getState(),
        ms: ms
      });
    });
}

// ---------------------------------------------------------------- verdicts

function judgeConcurrent(r) {
  verdict(!!(r.decision && r.decision.output.mode === "concurrent"),
    "round A decides CONCURRENT on the card's own VRAM",
    r.decision ? r.decision.output.mode + ": " + r.decision.output.reason
               : "the arbiter never asked");
  verdict(!!(r.result && r.result.ok), "round A generated",
          r.result && r.result.ok ? Math.round(r.ms / 1000) + "s"
                                  : (r.result && r.result.error));
  verdict(r.status.join(" ").indexOf("Pausing the chat model") === -1,
          "…with no pause status line", r.status.length
            ? r.status.join(" | ").slice(0, 200) : "(no status lines)");
  verdict(r.chatDuringGen === "running",
          "…and the chat server held the card THROUGHOUT",
          "llama was '" + r.chatDuringGen + "' while ComfyUI worked");
  const gen = phaseStats("A:generate");
  say("info", "round A VRAM during generation: " + fmtStats(gen));
}

function judgeHandoff(r) {
  verdict(!!(r.decision && r.decision.output.mode === "handoff"),
    "round B decides HANDOFF on an impersonated " + OPT.override + " GB card",
    r.decision ? r.decision.output.mode + ": " + r.decision.output.reason
               : "the arbiter never asked");
  verdict(r.status.join(" ").indexOf("Pausing the chat model") !== -1,
          "…and says so before it does it",
          r.status.join(" | ").slice(0, 200));
  verdict(r.chatDuringGen === "stopped",
          "…the chat server really was down while ComfyUI worked",
          "llama was '" + r.chatDuringGen + "'");
  verdict(!!(r.result && r.result.ok), "round B generated",
          r.result && r.result.ok ? Math.round(r.ms / 1000) + "s"
                                  : (r.result && r.result.error));
  const decide = phaseStats("B:decide");
  const gen = phaseStats("B:generate");
  verdict(!!(decide && gen && gen.min < decide.max - 512),
    "total VRAM measurably DROPPED at the handoff",
    (decide ? "before " + decide.max + " MB" : "?") + " -> " +
    (gen ? "low during generation " + gen.min + " MB" : "?"));
  verdict(!!(r.free && r.free.err === null), "ComfyUI answered POST /free",
          r.free ? (r.free.err || "ok") + ", " +
                   r.free.before + " -> " + r.free.after + " MB in " +
                   r.free.ms + " ms"
                 : "/free was never called");
  // NOT "did /free free N megabytes". Measured 2026-08-30: ComfyUI 0.32
  // drops a finished generation's weights on its own, ~10 s before the
  // round ends, so /free routinely has nothing left to release. What has
  // to be true is the thing the chat model needs — the card is back at the
  // floor the pause left it at.
  const floor = gen ? gen.first : null;
  verdict(!!(r.free && r.free.after !== null && floor !== null &&
             r.free.after <= floor + 512),
    "…and the card is back at the floor the pause left it at",
    r.free && floor !== null
      ? "floor " + floor + " MB, after /free " + r.free.after + " MB"
      : "no readings");
  verdict(r.chatAfter === "running",
          "the chat model was warmed back up before the reply",
          "llama is '" + r.chatAfter + "'");
  say("info", "round B VRAM during generation: " + fmtStats(gen));
}

// ------------------------------------------------------------- transcript

function writeTranscript() {
  const dir = path.join(ROOT, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, "handoff-probe-" + stamp + ".md");
  const s = Settings.get();
  const lines = ["# handoff probe " + stamp, "",
    "- chat model: `" + s.modelPath + "`",
    "- workflow: " + OPT.workflow + " at " + OPT.width + "x" + OPT.height,
    "- comfyUrl: " + s.comfyUrl,
    "- rounds: " + OPT.rounds + " (round B override " + OPT.override + " GB)",
    ""];
  for (const t of transcript) lines.push("- **" + t.kind + "** " + t.text);
  lines.push("", "## VRAM timeline (MB, nvidia-smi total used)", "");
  const t0 = timeline.length ? timeline[0].t : 0;
  for (const r of timeline) {
    lines.push("- " + ((r.t - t0) / 1000).toFixed(1) + "s  " + r.mb +
               "  " + r.phase);
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function finish() {
  watchOff();
  try { Llama.stop(); } catch (e) {}
  const file = writeTranscript();
  say("info", "transcript: " + file);
  console.log(failures === 0 ? "\nHANDOFF PROBE PASSED"
                             : "\nHANDOFF PROBE FAILED (" + failures +
                               " verdict(s))");
  process.exit(failures === 0 ? 0 : 1);
}

// ------------------------------------------------------------------ run

try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {}

detectGpu(function (gpu) {
  Tools.setGpuInfo(gpu);
  const s = Settings.get();
  const eff = Tiers.effectiveVram(gpu, s);
  const tier = Tiers.tierFor(eff.vramGB);
  say("info", "GPU: " + (gpu.name || "none") + ", " +
              (eff.vramGB === null ? "VRAM unknown" : eff.vramGB + " GB") +
              " -> " + tier.id + " (policy " + tier.policy +
              (tier.mandatory ? ", mandatory handoff" : "") + ")");
  say("info", "chat model: " + s.modelPath);
  say("info", "pause mode: " + s.comfyPauseLlm);

  // NOT `if (err)`: Comfy.status reports a DOWN backend as
  // cb(null, {online:false, hint}) so the panel can show the hint, so a
  // caller testing only `err` printed PASS with nothing listening (§17n).
  managed.reachable(Comfy, s.comfyUrl, s, function (down, st) {
    if (down) {
      verdict(false, "ComfyUI reachable at " + s.comfyUrl, down);
      say("error", "Nothing to hand the card to — stopping.");
      finish();
      return;
    }
    verdict(true, "ComfyUI reachable at " + s.comfyUrl,
            "queue running=" + (st.running || 0) +
            " pending=" + (st.pending || 0));

    watchOn();
    setPhase("chat:start");
    startChat(function (cErr) {
      if (cErr) {
        verdict(false, "the chat model loaded", cErr.message);
        finish();
        return;
      }
      verdict(Llama.getState() === "running", "the chat model loaded",
              "state " + Llama.getState());
      setPhase("chat:loaded");
      sampleVram(function (mb) {
        say("info", "VRAM with chat loaded and ComfyUI idle: " +
                    (mb === null ? "n/a" : mb + " MB"));
      });

      const wantA = OPT.rounds.indexOf("a") !== -1;
      const wantB = OPT.rounds.indexOf("b") !== -1;

      function roundB() {
        if (!wantB) { probeFreeDirectly(); return; }
        OVERRIDE.vramOverrideGB = OPT.override;
        say("info", "vramOverrideGB = " + OPT.override +
                    " — the same job on an impersonated " +
                    Tiers.tierFor(OPT.override).id + " card");
        runRound("B", function (r) {
          judgeHandoff(r);
          OVERRIDE.vramOverrideGB = 0;
          probeFreeDirectly();
        });
      }

      function probeFreeDirectly() {
        // The tier plan's open question, answered with the status code.
        sampleVram(function (before) {
          rawFree(s.comfyUrl, function (fErr, code, body) {
            sampleVram(function (after) {
              if (fErr) {
                verdict(false, "POST /free is supported by this backend",
                        fErr.message);
              } else {
                verdict(code >= 200 && code < 300,
                        "POST /free is supported by this backend",
                        "HTTP " + code + " " + JSON.stringify(body) +
                        ", VRAM " + before + " -> " + after + " MB");
              }
              finish();
            });
          });
        });
      }

      if (wantA) {
        runRound("A", function (r) { judgeConcurrent(r); roundB(); });
      } else {
        roundB();
      }
    });
  });
});
