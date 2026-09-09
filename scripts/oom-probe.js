/*
 * oom-probe.js — WORKPLAN item 7, last bullet: "force one real OOM ... and
 * verify the chat model comes back afterward regardless."
 *
 * The bullet's premise did not survive first contact with this backend.
 * ComfyUI 0.32 on a 32 GB card does NOT raise CUDA OOM on an oversized
 * job — measured 2026-08-30: KREA2 at 4096x4096 offloads weights and
 * GRINDS (33 s/it on pass one, 92 s/it on pass two, no error, no end).
 * So the reachable shape of "a generation the card cannot do" is not an
 * exception at all: it is the panel's own generation TIMEOUT, with the
 * job still running and still holding the card afterwards.
 *
 * That is the HARDER case, which is why it is the one worth probing. A
 * torch OOM frees its allocation on the way out; an abandoned job does
 * not — it keeps computing and keeps ~19 GB, and the panel's very next
 * act is to reload a 20 GB chat model into whatever is left.
 *
 * One round through the REAL panel path:
 *
 *   settings.js + tiers.js + llama.js + comfy.js + tools.js
 *     -> Tools.executeCommands([comfy_generate])
 *     -> a REAL llama-server, a REAL local ComfyUI, real nvidia-smi
 *
 *   vramOverrideGB 6   -> the arbiter must PAUSE chat (mandatory handoff),
 *                         so the panel owes the user a chat model back.
 *   an unfinishable job + a short comfyTimeoutSec
 *                      -> the round fails with the card in hostile hands.
 *
 * The verdicts are the bullet's question, split into the four things that
 * have to be true for the answer to be "yes":
 *   1. the round ENDS, once, with a grounded error (never a hang);
 *   2. the abandoned job is not still burning the card when it does;
 *   3. the card is actually free for the chat model to come back into,
 *      and the panel's account of that is honest (0.10.15);
 *   4. the chat model is running AND answering afterwards.
 *
 *   node scripts/oom-probe.js
 *   node scripts/oom-probe.js --width 4096 --height 4096
 *   node scripts/oom-probe.js --timeout 90      # comfyTimeoutSec
 *   node scripts/oom-probe.js --override 6      # impersonated card, GB
 *   node scripts/oom-probe.js --model <path.gguf>
 *   node scripts/oom-probe.js --reuse-server    # do not start llama
 *
 * NO After Effects: the generation runs with {import: false}, so nothing
 * touches the user's project and no dialog can be raised. Writes a
 * markdown transcript to logs/ and exits 0 only if every verdict passed.
 * Whatever happens, the probe interrupts ComfyUI on the way out — an
 * unattended run must not leave a job grinding for the rest of the night.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
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
  workflow: argValue("--workflow", "AE_LLAMA_KREA2_T2I_V1"),
  // Measured on this machine: pass one alone is 2 m 19 s at this size and
  // pass two runs at 92 s/it, so no timeout under ~10 minutes can be met.
  width: parseInt(argValue("--width", "4096"), 10),
  height: parseInt(argValue("--height", "4096"), 10),
  seed: parseInt(argValue("--seed", "13579"), 10),
  timeout: parseInt(argValue("--timeout", "90"), 10),
  override: parseInt(argValue("--override", "6"), 10),
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

const OUT_DIR = path.join(ROOT, "logs", "oom-probe");
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

const timeline = [];
let phase = "start";
let vramTimer = null;
function setPhase(p) {
  phase = p;
  say("info", "[phase] " + p);
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

// ------------------------------------------------- ComfyUI, asked directly

/** GET/POST against ComfyUI without the panel's wrapper. cb(err, code, text). */
function comfyRequest(url, method, urlPath, bodyObj, cb) {
  const u = new URL(url);
  const body = bodyObj === null ? null : JSON.stringify(bodyObj);
  const req = http.request({ hostname: u.hostname, port: u.port,
    path: urlPath, method: method,
    headers: body === null ? {} : {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body) } },
    function (res) {
      let text = "";
      res.on("data", (d) => { text += d.toString(); });
      res.on("end", () => cb(null, res.statusCode, text));
    });
  req.on("error", (e) => cb(e));
  req.setTimeout(10000, function () { req.destroy(new Error("timeout")); });
  if (body !== null) req.write(body);
  req.end();
}

/** How many prompts is ComfyUI running or holding right now? */
function queueDepth(url, cb) {
  comfyRequest(url, "GET", "/queue", null, function (err, code, text) {
    if (err || code !== 200) { cb(null); return; }
    let j = null;
    try { j = JSON.parse(text); } catch (e) { cb(null); return; }
    cb({ running: (j.queue_running || []).length,
         pending: (j.queue_pending || []).length });
  });
}

// ------------------------------------------------------ llama, asked directly

/**
 * "Running" is a state string. What the user needs is an ANSWER, so the
 * last verdict asks the server for one and times it — a chat model that
 * has been pushed into host memory by a card someone else is holding
 * technically came back and practically did not.
 */
function askChat(port, cb) {
  const body = JSON.stringify({
    model: "default",
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
    temperature: 0, max_tokens: 8, stream: false
  });
  const t0 = Date.now();
  const req = http.request({ host: "127.0.0.1", port: port,
    path: "/v1/chat/completions", method: "POST",
    headers: { "Content-Type": "application/json",
               "Content-Length": Buffer.byteLength(body) } },
    function (res) {
      let text = "";
      res.on("data", (d) => { text += d.toString(); });
      res.on("end", function () {
        let reply = null;
        try {
          const j = JSON.parse(text);
          reply = j.choices && j.choices[0] && j.choices[0].message
            ? String(j.choices[0].message.content || "").trim() : null;
        } catch (e) {}
        cb(null, { code: res.statusCode, reply: reply, ms: Date.now() - t0 });
      });
    });
  req.on("error", (e) => cb(e));
  req.setTimeout(120000, function () {
    req.destroy(new Error("no reply in 120 s"));
  });
  req.write(body);
  req.end();
}

// ------------------------------------------------------- instrumentation

const decisions = [];
const realPlan = Tiers.planHandoff;
Tiers.planHandoff = function (inp) {
  const out = realPlan.call(Tiers, inp);
  decisions.push({ input: inp, output: out });
  say("info", "planHandoff(" + JSON.stringify(inp) + ") -> " +
              out.mode + ": " + out.reason);
  return out;
};

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

// ---------------------------------------------------------------- the round

function runRound(cb) {
  const s = Settings.get();
  const status = [];
  Tools.setProgressSink(function (msg) {
    status.push(msg);
    say("tool", msg);
  });
  setPhase("decide");

  let chatDuringGen = null;
  const watcher = setInterval(function () {
    if (chatDuringGen === null && phase === "generate") {
      chatDuringGen = Llama.getState();
    }
  }, 250);

  // The warm-up is the moment the whole bullet is about: what does the
  // card look like when llama-server is asked to load into it again?
  let vramAtWarm = null;
  let queueAtWarm = null;
  const realStart = Llama.start;
  Llama.start = function (opts, done) {
    Llama.start = realStart;
    setPhase("warm");
    sampleVram(function (mb) {
      vramAtWarm = mb;
      queueDepth(Comfy.backendUrl(s), function (q) {
        queueAtWarm = q;
        say("info", "at warm-up: VRAM " + mb + " MB, ComfyUI queue " +
                    (q ? q.running + " running / " + q.pending + " pending"
                       : "unreadable"));
        realStart.call(Llama, opts, done);
      });
    });
  };

  const realGenerate = Comfy.generate;
  Comfy.generate = function (opts, prog, done) {
    setPhase("generate");
    Comfy.generate = realGenerate;
    return realGenerate.call(Comfy, opts, prog, done);
  };

  // "cb fires exactly once" is not a nicety here: the generate poller
  // settles on a timer while an in-flight /history response is still
  // coming back, which is exactly where a double callback lives.
  let calls = 0;
  const t0 = Date.now();
  const hardStop = setTimeout(function () {
    if (calls === 0) {
      calls = -1;
      say("error", "the round never ended — hard stop after " +
                   Math.round((Date.now() - t0) / 1000) + "s");
      cb({ hung: true, status: status, chatDuringGen: chatDuringGen,
           ms: Date.now() - t0 });
    }
  }, (OPT.timeout + 600) * 1000);

  Tools.executeCommands([{ tool: "comfy_generate", args: {
      workflow: OPT.workflow,
      prompt: "A single red enamel coffee cup on a pale concrete surface, " +
              "soft north-window daylight, photographic.",
      width: OPT.width, height: OPT.height, seed: OPT.seed,
      "import": false
    } }], {}, null, function (results) {
      if (calls === -1) {
        say("error", "the round called back AFTER the hard stop");
        return;
      }
      calls++;
      if (calls > 1) {
        say("error", "the round called back " + calls + " times");
        return;
      }
      clearTimeout(hardStop);
      const ms = Date.now() - t0;
      Comfy.generate = realGenerate;
      Llama.start = realStart;
      clearInterval(watcher);
      setPhase("after");
      queueDepth(Comfy.backendUrl(s), function (qAfter) {
        cb({
          hung: false,
          result: results[0] || {},
          decision: decisions.length ? decisions[decisions.length - 1] : null,
          status: status,
          chatDuringGen: chatDuringGen,
          chatAfter: Llama.getState(),
          vramAtWarm: vramAtWarm,
          queueAtWarm: queueAtWarm,
          queueAfter: qAfter,
          ms: ms
        });
      });
    });
}

// ---------------------------------------------------------------- verdicts

function judge(r, cb) {
  const s = Settings.get();
  if (r.hung) {
    verdict(false, "the failed round ENDS and hands back a result",
            "no callback in " + Math.round(r.ms / 1000) + "s");
    cb();
    return;
  }
  verdict(true, "the failed round ENDS and hands back a result, once",
          Math.round(r.ms / 1000) + "s");

  verdict(!!(r.decision && r.decision.output.mode === "handoff"),
    "the arbiter PAUSED chat for this job (impersonated " + OPT.override +
    " GB card)",
    r.decision ? r.decision.output.mode + ": " + r.decision.output.reason
               : "the arbiter never asked");
  verdict(r.chatDuringGen === "stopped",
    "…so the chat server really was down while ComfyUI worked",
    "llama was '" + r.chatDuringGen + "'");

  const err = String((r.result && r.result.error) || "");
  verdict(!!(r.result && r.result.ok === false && err),
    "the generation failed with a grounded error, not silence",
    err.slice(0, 200) || "(result was " + JSON.stringify(r.result).slice(0, 120) + ")");

  // The heart of it. An abandoned job keeps the card; a torch OOM would
  // not have. If ComfyUI is still working when the panel starts putting
  // the chat model back, the two are fighting over the same 32 GB.
  verdict(!!(r.queueAtWarm && r.queueAtWarm.running === 0 &&
             r.queueAtWarm.pending === 0),
    "the abandoned job is no longer running when the chat model is reloaded",
    r.queueAtWarm
      ? r.queueAtWarm.running + " running / " + r.queueAtWarm.pending +
        " pending in ComfyUI"
      : "ComfyUI's queue was unreadable");

  let chatMB = null;
  try { chatMB = Math.round(fs.statSync(s.modelPath).size / (1024 * 1024)); }
  catch (e) {}
  const totalMB = (window.__gpuTotalMB || 0);
  const roomAtWarm = r.vramAtWarm !== null && totalMB > 0 && chatMB !== null
    ? r.vramAtWarm + chatMB <= totalMB
    : r.vramAtWarm !== null && r.vramAtWarm < 8000;
  verdict(roomAtWarm,
    "…and the card has room for it",
    "VRAM at warm-up " + r.vramAtWarm + " MB" +
      (chatMB !== null ? ", chat model " + chatMB + " MB" : "") +
      (totalMB ? ", card " + totalMB + " MB" : ""));

  // What the panel TOLD the user about that handover has to be true too.
  // Measured here 2026-08-30: the card sat at 23 654 MB for the whole
  // release wait and fell to 2 918 MB one second after it expired, so a
  // user with 29 GB free was told their VRAM had not been released. The
  // wait asks about ROOM now; a sentence about the release may only
  // appear when there was none.
  const cried = (r.status || []).filter(
    (m) => /did not visibly release|still holds/.test(String(m)));
  verdict(!(roomAtWarm && cried.length),
    "…and the panel did not report a release failure on a card with room",
    cried.length ? cried.join(" | ")
                 : "nothing was claimed about the release");

  verdict(r.chatAfter === "running",
    "the chat model came back",
    "llama is '" + r.chatAfter + "'");

  if (r.chatAfter !== "running") { cb(); return; }
  askChat(s.port, function (aErr, ans) {
    if (aErr) {
      verdict(false, "…and it ANSWERS", aErr.message);
      cb();
      return;
    }
    verdict(ans.code === 200 && !!ans.reply, "…and it ANSWERS",
            "HTTP " + ans.code + " in " + ans.ms + " ms: " +
            JSON.stringify(String(ans.reply).slice(0, 60)));
    cb();
  });
}

// ------------------------------------------------------------- transcript

function writeTranscript() {
  const dir = path.join(ROOT, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, "oom-probe-" + stamp + ".md");
  const s = Settings.get();
  const lines = ["# OOM / abandoned-job recovery probe " + stamp, "",
    "- chat model: `" + s.modelPath + "`",
    "- workflow: " + OPT.workflow + " at " + OPT.width + "x" + OPT.height,
    "- backend: " + Comfy.backendUrl(s) +
      "  (" + Comfy.backendMode(s) + ")",
    "- comfyTimeoutSec: " + OPT.timeout + ", vramOverrideGB: " + OPT.override,
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

/* An unattended probe must never leave a 4096x4096 job grinding for the
 * rest of the night, whether it passed, failed or threw. */
function finish() {
  const s = Settings.get();
  const URL = Comfy.backendUrl(s);
  comfyRequest(URL, "POST", "/interrupt", {}, function () {
    comfyRequest(URL, "POST", "/free",
      { unload_models: true, free_memory: true }, function () {
        watchOff();
        try { Llama.stop(); } catch (e) {}
        const file = writeTranscript();
        say("info", "transcript: " + file);
        console.log(failures === 0 ? "\nOOM PROBE PASSED"
                                   : "\nOOM PROBE FAILED (" + failures +
                                     " verdict(s))");
        process.exit(failures === 0 ? 0 : 1);
      });
  });
}
process.on("uncaughtException", function (e) {
  say("error", "uncaught: " + e.stack);
  finish();
});

// ------------------------------------------------------------------ run

try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {}

detectGpu(function (gpu) {
  Tools.setGpuInfo(gpu);
  window.__gpuTotalMB = gpu.vramGB ? gpu.vramGB * 1024 : 0;
  const s = Settings.get();
  say("info", "GPU: " + (gpu.name || "none") + ", " +
              (gpu.vramGB === null ? "VRAM unknown" : gpu.vramGB + " GB"));
  say("info", "chat model: " + s.modelPath);
  say("info", "pause mode: " + s.comfyPauseLlm);
  say("info", "the job: " + OPT.workflow + " at " + OPT.width + "x" +
              OPT.height + ", comfyTimeoutSec " + OPT.timeout +
              " — chosen because this backend does not OOM on it, it grinds");

  // NOT `if (err)`: Comfy.status reports a DOWN backend as
  // cb(null, {online:false, hint}) so the panel can show the hint, so a
  // caller testing only `err` printed PASS with nothing listening (§17n).
  //
  // And NOT s.comfyUrl (§17o): comfyUrl is the "use my own ComfyUI"
  // setting, and in managed mode the panel talks to its own port. This
  // probe exists to watch ONE backend take the card — pointed at another
  // instance its numbers are about a different process.
  const URL = Comfy.backendUrl(s);
  say("info", "ComfyUI at " + URL + "  (backend: " +
              Comfy.backendMode(s) + ")");
  managed.reachable(Comfy, URL, s, function (down, st) {
    if (down) {
      verdict(false, "ComfyUI reachable at " + URL, down);
      say("error", "Nothing to hand the card to — stopping.");
      finish();
      return;
    }
    verdict(true, "ComfyUI reachable at " + URL,
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
      OVERRIDE.vramOverrideGB = OPT.override;
      say("info", "vramOverrideGB = " + OPT.override + " -> " +
                  Tiers.tierFor(OPT.override).id + ", mandatory handoff");
      runRound(function (r) {
        say("info", "VRAM while ComfyUI worked: " + fmtStats(phaseStats("generate")));
        say("info", "VRAM after the round: " + fmtStats(phaseStats("after")));
        judge(r, finish);
      });
    });
  });
});
