/*
 * comfy-probe.js — run ONE real generation end-to-end, headless.
 *
 * chat-probe.js drives the AE half of the product (sentence -> model ->
 * host tools -> comp). Nothing drove the OTHER half: the bundled ComfyUI
 * template has only ever been checked against ComfyUI's own
 * validate_prompt, which says a graph is well-formed and nothing about
 * whether it renders, what it saves, or whether AE can read the file.
 * This runs that whole path with no panel:
 *
 *   canned prompt
 *     -> extension/js/settings.js  (the user's real settings, overridable)
 *     -> extension/js/tools.js     (comfy_generate, VRAM arbiter, import)
 *     -> extension/js/comfy.js     (graft -> optional nodes -> queue -> poll)
 *     -> a REAL local ComfyUI      (real weights, real GPU)
 *     -> REAL After Effects via AfterFX.exe -r (import_file)
 *     -> verdicts read back out of AE, then the import is removed again
 *
 *   node scripts/comfy-probe.js                       # the default smoke
 *   node scripts/comfy-probe.js --url http://127.0.0.1:8188
 *   node scripts/comfy-probe.js --duration 0.2 --width 512 --height 288
 *   node scripts/comfy-probe.js --image C:\ref.png    # i2v instead of t2v
 *   node scripts/comfy-probe.js --no-ae               # generation only
 *   node scripts/comfy-probe.js --keep                # leave the AE import
 *
 * Defaults are deliberately the SMALLEST thing the template can render
 * (0.2s -> the graph's own 17k+5 floor of 5 frames, ~0.15 MP): this is a
 * plumbing test, not a quality test. Writes a markdown transcript to
 * logs/ and exits 0 only if every verdict passed.
 *
 * It DOES import one file into the open AE project and then delete that
 * item again (delete_item, the panel's own tool). Nothing else in the
 * project is touched, and the project is never saved.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const HOSTSCRIPT = path.join(EXT, "jsx", "hostscript.jsx");

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const OPT = {
  url: argValue("--url", null),
  workflow: argValue("--workflow", "AE_LLAMA_H3_I2V_V1"),
  duration: parseFloat(argValue("--duration", "0.2")),
  width: parseInt(argValue("--width", "512"), 10),
  height: parseInt(argValue("--height", "288"), 10),
  seed: parseInt(argValue("--seed", "12345"), 10),
  timeout: parseInt(argValue("--timeout", "1800"), 10),
  image: argValue("--image", null),
  noAe: argv.indexOf("--no-ae") !== -1,
  keep: argv.indexOf("--keep") !== -1,
  afterFX: argValue("--afterfx", null)
};

// ------------------------------------------------------- After Effects

function findAfterFX() {
  if (OPT.afterFX) return OPT.afterFX;
  const base = "C:\\Program Files\\Adobe";
  let best = null;
  try {
    for (const d of fs.readdirSync(base)) {
      if (!/^Adobe After Effects/.test(d)) continue;
      const exe = path.join(base, d, "Support Files", "AfterFX.exe");
      if (fs.existsSync(exe) && (!best || d > best.dir)) best = { dir: d, exe: exe };
    }
  } catch (e) {}
  return best ? best.exe : null;
}
const AFTERFX = findAfterFX();

/** ExtendScript (ES3) string literal, pure ASCII. */
function jsxString(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c < 0x20 || c > 0x7e) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

let bridgeSeq = 0;
let hostLoaded = false;

/* Same wrapper contract as chat-probe: load the host when either published
 * global is missing (AE answers an undefined identifier with a MODAL, which
 * wedges the app rather than failing), then write the answer where Node can
 * read it — ExtendScript has no stdout. */
function bridgeWrapper(script, outPath, force) {
  return [
    "(function () {",
    "  var out = " + jsxString(outPath.replace(/\\/g, "/")) + ";",
    "  function w(s) {",
    "    try {",
    "      var f = new File(out); f.encoding = \"UTF-8\";",
    "      f.open(\"w\"); f.write(s); f.close();",
    "    } catch (e) {}",
    "  }",
    "  try {",
    "    if (" + (force ? "true" : "false") +
      " || typeof $.global.AELL_call !== \"function\"" +
      " || !$.global.AELLJSON) {",
    "      $.evalFile(new File(" +
      jsxString(HOSTSCRIPT.replace(/\\/g, "/")) + "));",
    "    }",
    "    if (!$.global.AELLJSON) {",
    "      w('{\"ok\":false,\"error\":\"probe wrapper: hostscript loaded" +
      " but $.global.AELLJSON is missing\"}');",
    "      return;",
    "    }",
    "    var res = eval(" + jsxString(script) + ");",
    "    w(typeof res === \"undefined\" ? \"\" : String(res));",
    "  } catch (e) {",
    "    w('{\"ok\":false,\"error\":\"probe wrapper: ' +",
    "      String(e).replace(/[\\\\\"\\r\\n]/g, \" \") + '\"}');",
    "  }",
    "})();"
  ].join("\n");
}

function aeEval(script, cb, timeoutMs) {
  if (!AFTERFX) { cb("", true); return; }
  const id = ++bridgeSeq;
  const outPath = path.join(os.tmpdir(),
    "aell-comfyprobe-" + process.pid + "-" + id + ".json");
  const wrapperPath = path.join(os.tmpdir(),
    "aell-comfyprobe-" + process.pid + "-" + id + ".jsx");
  try { fs.unlinkSync(outPath); } catch (e) {}
  const force = !hostLoaded;
  hostLoaded = true;
  fs.writeFileSync(wrapperPath, bridgeWrapper(script, outPath, force), "ascii");
  const child = spawn(AFTERFX, ["-r", wrapperPath],
    { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + (timeoutMs || 180000);
  (function poll() {
    if (fs.existsSync(outPath)) {
      let text = "";
      try { text = fs.readFileSync(outPath, "utf8"); } catch (e) {}
      try { fs.unlinkSync(outPath); } catch (e) {}
      try { fs.unlinkSync(wrapperPath); } catch (e) {}
      cb(text, false);
      return;
    }
    if (Date.now() > deadline) { cb("", true); return; }
    setTimeout(poll, 150);
  })();
}

/** Read-only inspection expression -> parsed JSON. */
function aeRead(expr, cb) {
  aeEval("AELLJSON.stringify((function () { " + expr + " })())",
    function (text, isError) {
      if (isError) { cb(null, new Error("AE did not answer")); return; }
      let obj = null;
      try { obj = JSON.parse(text); }
      catch (e) {
        cb(null, new Error("unparseable AE answer: " +
                           String(text).slice(0, 200)));
        return;
      }
      cb(obj, null);
    });
}

// -------------------------------------------------------- the panel, in Node

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
      aeEval(script, function (t, e) { if (cb) cb(t, e); });
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
loadPanelFile("llama.js");
loadPanelFile("comfy.js");
loadPanelFile("tools.js");

const Settings = window.Settings;
const Comfy = window.Comfy;
const Tools = window.Tools;

/* The probe reads the user's REAL settings and overrides only what it must:
 * the workflow dir (so the REPO's shipped template is what gets tested, not
 * whatever stale copy the install happens to hold), the output dir (probe
 * junk stays out of the user's generated/), the timeout (a first load of a
 * ~20 GB model legitimately outruns the shipped 600s default — the probe
 * measures that instead of failing on it) and, when asked, the URL. */
const OUT_DIR = path.join(ROOT, "logs", "comfy-probe");
const OVERRIDE = {
  comfyWorkflowsDir: path.join(EXT, "comfy-workflows"),
  comfyOutDir: OUT_DIR,
  comfyTimeoutSec: OPT.timeout
};
if (OPT.url) OVERRIDE.comfyUrl = OPT.url;
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
  const tag = { info: "--", tool: "..", verdict: "==", error: "!!" }[kind] || "  ";
  console.log(tag + " " + String(text).replace(/\n/g, "\n   "));
}
function verdict(ok, label, detail) {
  if (!ok) failures++;
  say("verdict", (ok ? "PASS " : "FAIL ") + label + (detail ? " — " + detail : ""));
}

function writeTranscript() {
  const dir = path.join(ROOT, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, "comfy-probe-" + stamp + ".md");
  const lines = ["# comfy-probe " + stamp, "",
    "- workflow: " + OPT.workflow,
    "- url: " + S.comfyUrl,
    "- params: durationSeconds=" + OPT.duration + " " + OPT.width + "x" +
      OPT.height + " seed=" + OPT.seed +
      (OPT.image ? " image=" + OPT.image : " (text-to-video)"), ""];
  for (const t of transcript) lines.push("- **" + t.kind + "** " + t.text);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

// ------------------------------------------------------------ VRAM witness

let vramPeak = 0;
let vramIdle = null;
let vramTimer = null;
function sampleVram(cb) {
  execFile("nvidia-smi",
    ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
    { timeout: 10000 }, function (err, out) {
      if (err) { cb(null); return; }
      const mb = parseInt(String(out).trim().split(/\r?\n/)[0], 10);
      cb(isNaN(mb) ? null : mb);
    });
}
function startVramWatch() {
  vramTimer = setInterval(function () {
    sampleVram(function (mb) { if (mb !== null && mb > vramPeak) vramPeak = mb; });
  }, 4000);
}
function stopVramWatch() {
  if (vramTimer) clearInterval(vramTimer);
  vramTimer = null;
}

// ------------------------------------------------------------------- steps

function stepStatus(next) {
  say("info", "ComfyUI at " + S.comfyUrl);
  Comfy.status(S.comfyUrl, function (err, st) {
    if (err) {
      verdict(false, "ComfyUI reachable", err.message);
      say("error", "Nothing to generate with — stopping.");
      finish();
      return;
    }
    verdict(true, "ComfyUI reachable",
            "queue running=" + (st.running || 0) +
            " pending=" + (st.pending || 0));
    next();
  });
}

function stepWorkflowVisible(next) {
  const list = Comfy.listWorkflows(S.comfyWorkflowsDir);
  const names = list.map(function (w) { return w.name; });
  verdict(names.indexOf(OPT.workflow) !== -1,
          "the panel lists '" + OPT.workflow + "'", "saw: " + names.join(", "));
  next();
}

let genResult = null;
let genSeconds = 0;

function stepGenerate(next) {
  const args = {
    workflow: OPT.workflow,
    prompt: "Live-action, cinematic. A red toy car sits on a white table " +
            "in daylight. The camera pushes in with small amplitude at slow " +
            "speed. overall_soundscape: quiet room tone. " +
            "non_diegetic_music: N/A",
    durationSeconds: OPT.duration,
    width: OPT.width,
    height: OPT.height,
    seed: OPT.seed,
    "import": !OPT.noAe
  };
  if (OPT.image) args.image = OPT.image;
  say("info", "comfy_generate " + JSON.stringify(args));

  Tools.setProgressSink(function (msg) { say("tool", msg); });
  sampleVram(function (mb) {
    vramIdle = mb;
    say("info", "VRAM before: " + (mb === null ? "n/a" : mb + " MB"));
    startVramWatch();
    const t0 = Date.now();
    Tools.executeCommands([{ tool: "comfy_generate", args: args }], {}, null,
      function (results) {
        genSeconds = Math.round((Date.now() - t0) / 1000);
        stopVramWatch();
        const r = results[0] || {};
        genResult = r;
        say("info", "elapsed " + genSeconds + "s, VRAM peak " +
            (vramPeak || "n/a") + " MB (idle " +
            (vramIdle === null ? "n/a" : vramIdle) + ")");
        if (!r.ok) {
          verdict(false, "generation completed", r.error);
          next();
          return;
        }
        verdict(true, "generation completed", genSeconds + "s");
        const applied = (r.data && r.data.applied) || [];
        for (let i = 0; i < applied.length; i++) say("info", "applied: " + applied[i]);
        next();
      });
  });
}

function stepFiles(next) {
  if (!genResult || !genResult.ok) {
    verdict(false, "an output file came back", "no result");
    next();
    return;
  }
  const files = genResult.data.files || [];
  verdict(files.length > 0, "an output file came back", files.join(", "));
  for (const f of files) {
    let sz = -1;
    try { sz = fs.statSync(f).size; } catch (e) {}
    verdict(sz > 1024, "file exists on disk and is not empty",
            path.basename(f) + " = " + sz + " bytes");
    if (/\.mp4$/i.test(f) && sz > 12) {
      let box = "";
      try {
        const fd = fs.openSync(f, "r");
        const head = Buffer.alloc(12);
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
        box = head.slice(4, 8).toString("ascii");
      } catch (e) {}
      verdict(box === "ftyp", "the mp4 really is an mp4", "box: " + box);
    }
  }
  next();
}

function stepImported(next) {
  if (OPT.noAe) { say("info", "--no-ae: skipping the AE half"); next(); return; }
  if (!genResult || !genResult.ok) {
    verdict(false, "AE imported it", "no result");
    next();
    return;
  }
  const imported = genResult.data.imported || [];
  verdict(imported.length > 0 && imported[0] && !imported[0].error,
          "AE imported it", JSON.stringify(imported[0] || null));
  if (!imported.length || !imported[0] || imported[0].error) { next(); return; }
  const id = imported[0].id;
  // What the model would need to know to USE the footage: real pixel
  // dimensions and duration, read back out of the project.
  aeRead(
    "var it = null;" +
    "for (var i = 1; i <= app.project.numItems; i++) {" +
    "  if (app.project.item(i).id === " + Number(id) +
    ") { it = app.project.item(i); break; }" +
    "}" +
    "if (!it) return { found: false };" +
    "return { found: true, name: it.name, width: it.width, height: it.height," +
    " duration: it.duration, frameRate: it.frameRate," +
    " hasVideo: it.hasVideo, hasAudio: it.hasAudio };",
    function (info, err) {
      if (err) {
        verdict(false, "the imported footage reads back in AE", err.message);
        next();
        return;
      }
      say("info", "AE footage: " + JSON.stringify(info));
      verdict(!!(info && info.found && info.width > 0 && info.height > 0 &&
                 info.duration > 0),
              "the imported footage has real dimensions and duration",
              info && info.found
                ? info.width + "x" + info.height + " " +
                  (Math.round(info.duration * 1000) / 1000) + "s @ " +
                  (Math.round(info.frameRate * 100) / 100) + "fps"
                : "no answer");
      if (OPT.keep) { say("info", "--keep: leaving the imported item"); next(); return; }
      Tools.callHostTool("delete_item", { item: info.name }, function (res) {
        verdict(!!(res && res.ok), "the probe cleaned up after itself",
                res && res.ok ? "removed " + res.data.removed
                              : (res && res.error));
        next();
      });
    });
}

// ---------------------------------------------------------------- sequence

function finish() {
  stopVramWatch();
  const file = writeTranscript();
  say("info", "transcript: " + file);
  console.log(failures === 0 ? "\nCOMFY PROBE PASSED"
                             : "\nCOMFY PROBE FAILED (" + failures + " verdict(s))");
  process.exit(failures === 0 ? 0 : 1);
}

stepStatus(function () {
  stepWorkflowVisible(function () {
    stepGenerate(function () {
      stepFiles(function () {
        stepImported(function () { finish(); });
      });
    });
  });
});
