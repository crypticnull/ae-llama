/*
 * catalog-vram-probe.js — WORKPLAN item 7, bullet 4, the half that was left:
 * what does a catalog entry ACTUALLY cost on the card?
 *
 * catalog-probe.js (0.10.11) settled the SIZE and URL halves of
 * COMFY_CATALOG from the network and the disk. Every `minVramGB` in it is
 * still a training guess, and every entry still says `measured: false`.
 * That number is not decoration: tiers.js `fits()` gates an entry on
 * `vram < entry.minVramGB`, so a wrong one either offers a user a model
 * their card cannot run or hides one it can.
 *
 * The only honest way to fix a VRAM figure is to watch the card while the
 * model runs. That is this probe:
 *
 *   COMFY_CATALOG entry
 *     -> its workflowTemplate + every weight the template names, on disk
 *     -> extension/js/settings.js + comfy.js + tools.js  (the real panel)
 *     -> a REAL local ComfyUI, real weights, real GPU
 *     -> nvidia-smi streaming at 250 ms THROUGHOUT
 *     -> idle floor, peak, delta, wall clock, release floor
 *
 *   node scripts/catalog-vram-probe.js --list          # no GPU work at all
 *   node scripts/catalog-vram-probe.js --entry krea2
 *   node scripts/catalog-vram-probe.js                 # every measurable one
 *
 * Three things it does deliberately, each learned from an earlier pass:
 *
 *  1. THE FLOOR IS ESTABLISHED, NOT GLANCED AT. `nvidia-smi memory.used` is
 *     the whole card — desktop, After Effects, anything else — and a
 *     generation that ran ten minutes ago may still have ~19 GB resident.
 *     Sampling once before the run and calling it "idle" understates the
 *     delta by exactly the amount already loaded. So the probe POSTs /free
 *     (0.10.10: HTTP 200, and this backend also drops weights on its own)
 *     and then waits for the reading to STOP MOVING before it writes the
 *     number down.
 *
 *  2. THE WITNESS IS ONE STREAMING PROCESS, NOT A TIMER. comfy-probe.js
 *     samples with execFile every 4 s, which is fine for "did it use the
 *     GPU" and useless for a peak: a VAE decode spike is shorter than one
 *     sample. `nvidia-smi -lms 250` is a single child that prints a reading
 *     four times a second, so the peak is a measurement rather than a
 *     coincidence of phase.
 *
 *  3. IT NEVER TOUCHES AFTER EFFECTS. `import: false`. The catalog question
 *     is about the card; putting a file into the user's open project is a
 *     different probe (comfy-probe.js) and a risk this one has no reason to
 *     take.
 *
 * Writes a markdown transcript to logs/ and exits non-zero if any verdict
 * failed. It does NOT edit version.js: what goes into the catalog is a
 * judgement about what this machine can prove, and that belongs to a human
 * reading the transcript.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const OPT = {
  boot: process.argv.indexOf("--boot") !== -1,
  stop: process.argv.indexOf("--stop") !== -1,
  entry: argValue("--entry", null),
  url: argValue("--url", null),
  prompt: argValue("--prompt", null),
  seed: parseInt(argValue("--seed", "12345"), 10),
  width: argValue("--width", null),
  height: argValue("--height", null),
  timeout: parseInt(argValue("--timeout", "1800"), 10),
  // How long to wait for the card to stop moving, and how still is still.
  settleSec: parseInt(argValue("--settle", "45"), 10),
  settleTolMB: parseInt(argValue("--settle-tolerance", "64"), 10),
  list: argv.indexOf("--list") !== -1
};

// -------------------------------------------------------- the panel, in Node

// Shared with comfy-probe and comfy-install: the PID must survive this
// process or a later --stop kills nothing while reporting a stop.
const managed = require("./lib/comfy-managed.js");
let pidFile = null;
let bootedHere = false;
const storage = managed.makeStorage(function () { return pidFile; });
const window = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  localStorage: storage,
  /* No AE. `import: false` means the generate path never reaches the host,
   * and if it ever did, a silent empty answer is a bug this probe should
   * show rather than hide — so it is logged. */
  AEBridge: {
    nodeRequire: require,
    getExtensionPath() { return EXT; },
    evalScript(script, cb) {
      say("info", "AEBridge.evalScript called (unexpected with import:false)");
      if (cb) cb("", true);
    }
  }
};
window.window = window;

function loadPanelFile(rel) {
  const src = fs.readFileSync(path.join(EXT, "js", rel), "utf8");
  new Function("window", src)(window);
}
loadPanelFile("version.js");
loadPanelFile("settings.js");
loadPanelFile("tiers.js");
loadPanelFile("setup.js");
loadPanelFile("llama.js");
loadPanelFile("comfy.js");
loadPanelFile("ffmpeg.js");
loadPanelFile("tools.js");

const AELL = window.AELL;
const Settings = window.Settings;
try {
  pidFile = require("path").join(Settings.dataRoot(), "comfy-managed.pid");
} catch (ePid) { pidFile = null; }
const Setup = window.Setup;
const Comfy = window.Comfy;
const Ffmpeg = window.Ffmpeg;
const Tools = window.Tools;

/* Same override shape as comfy-probe: the REPO's templates (not whatever
 * stale copy the install holds), probe junk out of the user's generated/,
 * and a timeout long enough that a first load of a 20 GB model is measured
 * rather than failed on. */
const OUT_DIR = path.join(ROOT, "logs", "catalog-vram");
const OVERRIDE = {
  comfyWorkflowsDir: path.join(EXT, "comfy-workflows"),
  comfyOutDir: OUT_DIR,
  comfyTimeoutSec: OPT.timeout
};
// Both fields, via the shared patch: comfyUrl alone is never read in
// managed mode, so --url was accepted and ignored (§17m).
if (OPT.url) Object.assign(OVERRIDE, managed.urlOverride(OPT.url));
const realGet = Settings.get;
Settings.get = function () {
  const s = realGet.apply(Settings, arguments);
  for (const k in OVERRIDE) s[k] = OVERRIDE[k];
  return s;
};
const S = Settings.get();

// --------------------------------------------------------------- reporting

const transcript = [];
let failures = 0;
function say(kind, text) {
  transcript.push({ kind: kind, text: text });
  const tag = { info: "--", row: "  ", tool: "..", verdict: "==", error: "!!" }[kind] || "  ";
  console.log(tag + " " + String(text).replace(/\n/g, "\n   "));
}
function verdict(ok, label, detail) {
  if (!ok) failures++;
  say("verdict", (ok ? "PASS " : "FAIL ") + label + (detail ? " - " + detail : ""));
}

const measurements = [];

function writeTranscript() {
  const dir = path.join(ROOT, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, "catalog-vram-probe-" + stamp + ".md");
  const lines = ["# catalog-vram-probe " + stamp, "",
                 "- url: " + Comfy.backendUrl(S) +
                   "  (backend: " + Comfy.backendMode(S) + ")",
                 "- card: " + (cardName || "?") + " (" +
                   (cardTotalMB === null ? "?" : cardTotalMB + " MiB") + ")", ""];
  if (measurements.length) {
    lines.push("## measured", "");
    lines.push("| entry | template | output | idle MiB | peak MiB | delta MiB |" +
               " delta GiB | seconds | minVramGB |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    measurements.forEach(function (m) {
      lines.push("| " + [m.name, m.workflow, m.output || "?", m.idle, m.peak,
                         m.delta, (m.delta / 1024).toFixed(1), m.seconds,
                         m.minVramGB].join(" | ") + " |");
    });
    lines.push("");
  }
  lines.push("## transcript", "");
  for (const t of transcript) lines.push("- **" + t.kind + "** " + t.text);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

// ------------------------------------------------------------ model roots

/* Mirrors tools.js `comfyModelRoots` (private there) the way catalog-probe
 * does, INCLUDING the Comfy-Desktop shared auto-download store — the root
 * 0.10.13 found that no setting and no config file declares, and where
 * every H3 weight on this machine actually lives. */
function modelRoots() {
  const s = Settings.get();
  const roots = [];
  if (s.comfyModelRoots) {
    String(s.comfyModelRoots).split(/[;\n]/).forEach(function (raw) {
      const p = raw.trim();
      if (p) roots.push(p);
    });
  }
  if (s.comfyDir) roots.push(path.join(s.comfyDir, "models"));
  try {
    const install = Setup.findComfyInstall && Setup.findComfyInstall();
    if (install && install.root) {
      roots.push(path.join(install.root, "ComfyUI", "models"));
    }
  } catch (e) {}
  const home = process.env.USERPROFILE || "";
  if (home) {
    roots.push(path.join(home, "Documents", "ComfyUI", "models"));
    roots.push(path.join(home, "AppData", "Local", "Comfy-Desktop",
                         "ComfyUI-Shared", "models"));
  }
  const seen = {};
  return roots.filter(function (p) {
    if (!p || seen[p]) return false;
    seen[p] = true;
    return true;
  });
}
const ROOTS = modelRoots();

function findWeight(file) {
  for (const r of ROOTS) {
    let hit = null;
    const stack = [r];
    let guard = 0;
    while (stack.length && guard++ < 400) {
      const d = stack.pop();
      let names;
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
      for (const n of names) {
        const full = path.join(d, n.name);
        if (n.isDirectory()) { stack.push(full); continue; }
        if (n.name === file) { hit = full; break; }
      }
      if (hit) break;
    }
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------- which entries are runnable

/* The weights a template actually loads, read out of the GRAPH rather than
 * out of the catalog entry — 0.10.9's lesson: an entry's `urls`/`files` and
 * what the shipped template names are two different lists, and the one that
 * decides what lands on the card is the graph. */
function templateWeights(name) {
  const file = path.join(EXT, "comfy-workflows", name + ".json");
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, "utf8");
  const out = [];
  const seen = {};
  const re = /"([A-Za-z0-9_.\/\\-]+\.(?:safetensors|ckpt|sft|pt|pth|gguf))"/g;
  let m;
  while ((m = re.exec(src))) {
    const base = m[1].split(/[\\/]/).pop();
    if (!seen[base]) { seen[base] = true; out.push(base); }
  }
  return out;
}

function planEntry(entry) {
  const plan = { name: entry.name, label: entry.label, entry: entry,
                 workflow: entry.workflowTemplate || null,
                 minVramGB: entry.minVramGB, weights: [], missing: [],
                 runnable: false, why: "" };
  if (!plan.workflow) {
    plan.why = "no workflowTemplate — the panel ships no graph that runs it";
    return plan;
  }
  const weights = templateWeights(plan.workflow);
  if (weights === null) {
    plan.why = "template " + plan.workflow + ".json is not in the bundle";
    return plan;
  }
  weights.forEach(function (w) {
    const hit = findWeight(w);
    if (hit) plan.weights.push({ file: w, path: hit, bytes: fs.statSync(hit).size });
    else plan.missing.push(w);
  });
  if (plan.missing.length) {
    plan.why = "weights not on this disk: " + plan.missing.join(", ");
    return plan;
  }
  plan.runnable = true;
  plan.onDiskMB = Math.round(plan.weights.reduce(function (a, w) {
    return a + w.bytes;
  }, 0) / 1048576);
  return plan;
}

// ------------------------------------------------------------ the witness

let cardTotalMB = null;
let cardName = null;

function readCard(cb) {
  const p = spawn("nvidia-smi",
    ["--query-gpu=name,memory.used,memory.total",
     "--format=csv,noheader,nounits"]);
  let out = "";
  p.stdout.on("data", function (d) { out += d; });
  p.on("error", function () { cb(null); });
  p.on("close", function () {
    const row = String(out).trim().split(/\r?\n/)[0] || "";
    const parts = row.split(",").map(function (x) { return x.trim(); });
    if (parts.length < 3) { cb(null); return; }
    const used = parseInt(parts[1], 10);
    const total = parseInt(parts[2], 10);
    if (isNaN(used) || isNaN(total)) { cb(null); return; }
    cardName = parts[0];
    cardTotalMB = total;
    cb({ name: parts[0], used: used, total: total });
  });
}

/* One streaming nvidia-smi, 250 ms. Returns a handle whose `samples` grows
 * for as long as it runs; `stop()` kills the child. */
function startWitness() {
  const w = { samples: [], t0: Date.now(), proc: null, stopped: false };
  const p = spawn("nvidia-smi",
    ["--query-gpu=memory.used", "--format=csv,noheader,nounits", "-lms", "250"]);
  w.proc = p;
  let buf = "";
  p.stdout.on("data", function (d) {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (ln) {
      const mb = parseInt(ln.trim(), 10);
      if (!isNaN(mb)) w.samples.push({ t: Date.now() - w.t0, mb: mb });
    });
  });
  p.on("error", function (e) { say("error", "nvidia-smi: " + e.message); });
  w.stop = function () {
    if (w.stopped) return;
    w.stopped = true;
    try { p.kill(); } catch (e) {}
  };
  return w;
}

function peakOf(samples) {
  return samples.reduce(function (a, s) { return s.mb > a ? s.mb : a; }, 0);
}

// ---------------------------------------------------------------- ComfyUI

function postFree(cb) {
  const s = Settings.get();
  let u;
  // The RESOLVED backend, not comfyUrl: /free has to reach the instance
  // whose VRAM this probe is measuring (§17m/§17o).
  const target = Comfy.backendUrl(s);
  try { u = new URL(target); }
  catch (e) { cb(new Error("bad backend URL: " + target)); return; }
  const body = JSON.stringify({ unload_models: true, free_memory: true });
  const req = http.request({
    hostname: u.hostname, port: u.port || 80, path: "/free", method: "POST",
    headers: { "Content-Type": "application/json",
               "Content-Length": Buffer.byteLength(body) }
  }, function (res) {
    res.resume();
    res.on("end", function () { cb(null, res.statusCode); });
  });
  req.on("error", function (e) { cb(e); });
  req.setTimeout(15000, function () { req.destroy(); cb(new Error("timeout")); });
  req.end(body);
}

/**
 * Ask the backend to let go, then WAIT FOR THE CARD TO STOP MOVING.
 *
 * The stillness test, not a fixed sleep: the last `need` samples (3 s at
 * 250 ms) must span less than settleTolMB. 0.10.15 measured this backend
 * sitting at 23 654 MiB for ten seconds and dropping to 2 918 one second
 * later — a floor read on a timer would have been that 23 654.
 */
function settleFloor(label, cb) {
  postFree(function (err, status) {
    say("info", "POST /free -> " + (err ? err.message : "HTTP " + status));
    const w = startWitness();
    const need = 12;
    const deadline = Date.now() + OPT.settleSec * 1000;
    (function poll() {
      const n = w.samples.length;
      if (n >= need) {
        const win = w.samples.slice(-need).map(function (s) { return s.mb; });
        const lo = Math.min.apply(null, win), hi = Math.max.apply(null, win);
        if (hi - lo <= OPT.settleTolMB) {
          w.stop();
          say("info", label + " floor " + lo + " MiB (still to within " +
              (hi - lo) + " MiB over " + (need * 250 / 1000) + "s)");
          cb(lo, false);
          return;
        }
      }
      if (Date.now() > deadline) {
        w.stop();
        const last = w.samples.length ? w.samples[w.samples.length - 1].mb : null;
        say("info", label + " floor did NOT settle in " + OPT.settleSec +
            "s; taking the last reading " + last + " MiB");
        cb(last, true);
        return;
      }
      setTimeout(poll, 250);
    })();
  });
}

// --------------------------------------------------------- output geometry

/* What actually came out, read from the FILE. The catalog number means
 * nothing without the size it was measured at. */
function describeOutput(file, cb) {
  if (!file || !fs.existsSync(file)) { cb(null); return; }
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") {
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const b = Buffer.alloc(24);
      fs.readSync(fd, b, 0, 24, 0);
      fs.closeSync(fd);
      if (b.slice(1, 4).toString() === "PNG") {
        cb(b.readUInt32BE(16) + "x" + b.readUInt32BE(20));
        return;
      }
    } catch (e) { try { if (fd) fs.closeSync(fd); } catch (e2) {} }
    cb(null);
    return;
  }
  let bin = null;
  try { bin = Ffmpeg.find({}); } catch (e) {}
  if (!bin || !bin.ok) { cb(null); return; }
  const p = spawn(bin.ffprobe, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_frames",
    "-of", "default=nw=1:nk=1", file]);
  let out = "";
  p.stdout.on("data", function (d) { out += d; });
  p.on("error", function () { cb(null); });
  p.on("close", function () {
    const v = String(out).trim().split(/\r?\n/);
    if (v.length < 2) { cb(null); return; }
    cb(v[0] + "x" + v[1] + (v[2] && v[2] !== "N/A" ? " " + v[2] + "f" : ""));
  });
}

// ------------------------------------------------------------- one entry

function measure(plan, done) {
  say("info", "");
  say("info", "=== " + plan.name + " (" + plan.label + ") via " +
      plan.workflow + " ===");
  say("info", "weights on disk: " + plan.onDiskMB + " MiB across " +
      plan.weights.length + " file(s)");

  settleFloor("idle", function (idle, stalled) {
    if (idle === null) {
      verdict(false, plan.name + ": card readable", "nvidia-smi gave nothing");
      done();
      return;
    }
    if (stalled) {
      say("info", "NOTE: the floor never settled, so the delta below is a " +
                  "lower bound on a card that was already busy.");
    }
    const args = {
      workflow: plan.workflow,
      prompt: OPT.prompt || (plan.entry.kind === "video"
        ? "Live-action, cinematic. A red toy car sits on a white table in " +
          "daylight. The camera pushes in with small amplitude at slow " +
          "speed. overall_soundscape: quiet room tone. " +
          "non_diegetic_music: N/A"
        : "A red toy car on a white table in daylight, product photograph, " +
          "sharp focus"),
      seed: OPT.seed,
      "import": false
    };
    /* Left off by default ON PURPOSE. With no size the template renders at
     * the resolution it was AUTHORED at, which is what the panel gives a
     * user who just asks for a picture — so that is the number the catalog
     * has to cover. --width/--height is for decomposing an answer
     * afterwards (how much is the model, how much is the frame), not for
     * making the headline figure smaller. */
    if (OPT.width) args.width = parseInt(OPT.width, 10);
    if (OPT.height) args.height = parseInt(OPT.height, 10);
    say("info", "comfy_generate " + JSON.stringify(args));
    Tools.setProgressSink(function (msg) { say("tool", msg); });

    const w = startWitness();
    const t0 = Date.now();
    Tools.executeCommands([{ tool: "comfy_generate", args: args }], {}, null,
      function (results) {
        const seconds = Math.round((Date.now() - t0) / 1000);
        // Let the witness catch the tail: a VAE decode can peak after the
        // last progress line and before the file lands.
        setTimeout(function () {
          w.stop();
          const r = results[0] || {};
          const peak = peakOf(w.samples);
          const delta = peak - idle;
          say("info", "samples " + w.samples.length + " over " + seconds +
              "s; idle " + idle + " -> peak " + peak + " MiB");

          if (!r.ok) {
            verdict(false, plan.name + ": generation completed", r.error);
            done();
            return;
          }
          verdict(true, plan.name + ": generation completed", seconds + "s");

          const files = (r.data && r.data.files) || [];
          describeOutput(files[0], function (geom) {
            const m = { name: plan.name, workflow: plan.workflow,
                        idle: idle, peak: peak, delta: delta,
                        seconds: seconds, minVramGB: plan.minVramGB,
                        onDiskMB: plan.onDiskMB, output: geom,
                        file: files[0] || null, cardTotalMB: cardTotalMB,
                        settled: !stalled };
            measurements.push(m);
            say("info", "OUTPUT " + (geom || "?") + "  " +
                (files[0] || "(no file)"));
            say("info", "DELTA " + delta + " MiB (" +
                (delta / 1024).toFixed(1) + " GiB) in " + seconds + "s");

            verdict(delta > 0, plan.name + ": the generation moved the card",
                    "delta " + delta + " MiB");
            verdict(cardTotalMB === null || peak <= cardTotalMB,
                    plan.name + ": peak fits the card",
                    peak + " / " + cardTotalMB + " MiB");
            /* The catalog's own claim, tested the only way this machine
             * can test it: a card of exactly minVramGB has to HOLD what
             * the generation put on this one. A pass does not prove the
             * gate is right (offload means a smaller card may still
             * crawl through it); a FAIL proves it is wrong. */
            const claimMB = plan.minVramGB * 1024;
            verdict(delta <= claimMB,
                    plan.name + ": minVramGB " + plan.minVramGB +
                    " covers the measured delta",
                    "needs " + (delta / 1024).toFixed(1) + " GiB, claims " +
                    plan.minVramGB + " GiB");

            settleFloor("release", function (after) {
              say("info", "released to " + after + " MiB (idle was " +
                  idle + ")");
              m.releaseMB = after;
              done();
            });
          });
        }, 1500);
      });
  });
}

// ---------------------------------------------------------------- sequence

function finish() {
  // Only ever stop a backend THIS RUN booted — never the one the owner
  // already had running.
  if (OPT.stop || (OPT.boot && bootedHere)) {
    try { managed.stop(Comfy, storage, Comfy.managedPort(S), say); }
    catch (eS) {}
  }
  if (measurements.length) {
    say("info", "");
    say("info", "MEASURED on " + (cardName || "?") + ":");
    measurements.forEach(function (m) {
      say("row", m.name + ": delta " + m.delta + " MiB (" +
          (m.delta / 1024).toFixed(1) + " GiB), peak " + m.peak +
          ", idle " + m.idle + ", " + m.seconds + "s, output " +
          (m.output || "?") + ", weights " + m.onDiskMB + " MiB");
    });
  }
  const file = writeTranscript();
  say("info", "transcript: " + file);
  say("info", failures ? failures + " verdict(s) FAILED" : "all verdicts passed");
  process.exit(failures ? 1 : 0);
}

const CATALOG = Setup.comfyCatalog(null);

const plans = CATALOG.map(planEntry);

if (OPT.list) {
  say("info", "catalog entries and whether this machine can measure them:");
  plans.forEach(function (p) {
    say("row", (p.runnable ? "RUNNABLE " : "skip     ") + p.name +
        "  minVramGB=" + p.minVramGB + "  measured=" + p.entry.measured +
        (p.runnable ? "  (" + p.workflow + ", " + p.onDiskMB + " MiB on disk)"
                    : "  (" + p.why + ")"));
  });
  process.exit(0);
}

readCard(function (card) {
  if (!card) {
    verdict(false, "nvidia-smi answers", "no GPU reading — nothing to measure");
    finish();
    return;
  }
  say("info", "card: " + card.name + ", " + card.used + " / " + card.total +
      " MiB in use before anything");

  // NOT S.comfyUrl. §17a put the backend choice behind Comfy.backendUrl:
  // in "managed" mode the panel talks to its OWN port and comfyUrl is
  // never consulted, so a probe reading comfyUrl measures one instance
  // while the generation runs on another.
  const URL = Comfy.backendUrl(S);
  // NOT `if (err)`: a down backend calls back cb(null, {online:false}),
  // so this branch was unreachable and --boot with it (§17n).
  managed.reachable(Comfy, URL, S, function (down, st) {
    if (down) {
      if (OPT.boot) {
        say("info", "--boot: bringing the managed backend up…");
        managed.boot(Comfy, URL, S, say, function (bErr) {
          if (bErr) {
            verdict(false, "ComfyUI reachable at " + URL, bErr.message);
            finish();
            return;
          }
          bootedHere = true;
          verdict(true, "ComfyUI reachable", "booted by --boot");
          afterStatus({ running: 0, pending: 0 });
        });
        return;
      }
      verdict(false, "ComfyUI reachable at " + URL, down);
      say("error", "Nothing is answering. Pass --boot to start the " +
                   "MANAGED backend (0.12.0+), or start one by hand. " +
                   "0.10.9 measured that ensureRunning cannot start the " +
                   "owner's own hand-built 0.32.0 — the managed install " +
                   "is the one it CAN start.");
      finish();
      return;
    }
    verdict(true, "ComfyUI reachable",
            "queue running=" + (st.running || 0) + " pending=" + (st.pending || 0));
    afterStatus(st);
  });

  // Everything past the reachability check, so the --boot path can reach
  // it too instead of duplicating the body.
  function afterStatus(st) {
    /* Someone else's job on the queue makes every reading below meaningless
     * — and 0.10.14 established this is the USER's ComfyUI, which they may
     * have queued their own work into. Refuse rather than measure noise. */
    if ((st.running || 0) + (st.pending || 0) > 0) {
      verdict(false, "the queue is idle",
              "another job is on it; its VRAM would be counted as ours");
      finish();
      return;
    }

    let todo = plans.filter(function (p) { return p.runnable; });
    if (OPT.entry) {
      const want = plans.filter(function (p) { return p.name === OPT.entry; });
      if (!want.length) {
        verdict(false, "entry '" + OPT.entry + "' is in the catalog",
                "have: " + plans.map(function (p) { return p.name; }).join(", "));
        finish();
        return;
      }
      if (!want[0].runnable) {
        verdict(false, "entry '" + OPT.entry + "' is measurable here",
                want[0].why);
        finish();
        return;
      }
      todo = want;
    }

    plans.forEach(function (p) {
      if (!p.runnable) say("info", "skipping " + p.name + ": " + p.why);
    });
    if (!todo.length) {
      verdict(false, "something is measurable on this machine",
              "no catalog entry has both a bundled template and its weights");
      finish();
      return;
    }
    say("info", "measuring: " + todo.map(function (p) { return p.name; }).join(", "));

    (function next(i) {
      if (i >= todo.length) { finish(); return; }
      measure(todo[i], function () { next(i + 1); });
    })(0);
  }
});
