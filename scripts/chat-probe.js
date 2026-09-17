/*
 * chat-probe.js — drive the panel like a USER, headless.
 *
 * The self-test harness (scripts/run-ae-selftest.ps1) proves the HOST
 * tools work when something calls them correctly. It says nothing about
 * the half of the product the user actually touches: a sentence typed in
 * chat, a small local model choosing tools from tools.js, and whatever
 * lands in the comp. This runs that whole path with no panel:
 *
 *   canned user sentence
 *     -> extension/js/settings.js   (the user's real settings.json)
 *     -> extension/js/llama.js      (the real llama-server + schema)
 *     -> extension/js/tools.js      (the real prompt, fusion, dispatch)
 *     -> REAL After Effects via AfterFX.exe -r
 *     -> a verdict read back out of AE
 *
 * Only main.js's round loop is mirrored here rather than reused — it is
 * welded to the DOM. Keep runRound() below in step with sendMessage().
 *
 *   node scripts/chat-probe.js                  # every step
 *   node scripts/chat-probe.js --steps 2,3      # a subset (1-based)
 *   node scripts/chat-probe.js --model <gguf>   # override the model
 *   node scripts/chat-probe.js --ctx 32768      # override the window
 *   node scripts/chat-probe.js --keep           # do not delete the comp
 *   node scripts/chat-probe.js --isolate        # rebuild the rig per step
 *   node scripts/chat-probe.js --rig-check      # build the rig, no model
 *   node scripts/chat-probe.js --carry-history  # the old shared history
 *   node scripts/chat-probe.js --variants       # the paraphrase matrix
 *   node scripts/chat-probe.js --route auto     # routed prompt (§24b)
 *   node scripts/chat-probe.js --ctx 32768 --prompt-mode compact
 *                                  # force the tool-doc form (NEXT UP 11e)
 *   node scripts/chat-probe.js --store-root D   # memory store folder (§15)
 *   node scripts/chat-probe.js --reuse-server --label "q8_0 16K"
 *                                  # name a server this probe did not start
 *   node scripts/chat-probe.js --temperature 0  # override, in memory only
 *   node scripts/chat-probe.js --reuse-server --port 8791
 *                                  # a server beside the panel's own (§24d)
 *   node scripts/chat-probe.js --variants --resume logs/chat-probe-X.partial.jsonl
 *                                  # carry on after a killed run (NEXT UP 1)
 *
 * RESUME. Every finished run is appended to logs/chat-probe-<stamp>
 * .partial.jsonl the moment it is judged, so a pass the loop kills at its
 * 45-minute bound leaves the runs it finished. --resume <that file>, with
 * the SAME flags, skips them and writes one transcript covering both.
 * Flags that change the measurement (model, window, routing, steps...)
 * must match the file, or it is refused: two configurations in one table
 * is a result nobody can grade. A run that inherits the comp or the
 * conversation from the run before it cannot start from a fresh sweep, so
 * the resume backs up to the last run that rebuilds its own world.
 *
 * VARIANTS. --variants runs each selected step's canonical sentence AND
 * every paraphrase it declares (casual / vague / typo'd), each as its own
 * independent run: fresh conversation, and — because --variants implies
 * --isolate — a freshly rebuilt rig. The product must not need magic
 * words, and the only way to know is to type the other words.
 *
 * A variant run is graded in three, not two:
 *
 *   pass  the step's own check() is satisfied — right tool, right target.
 *   miss  check() is not satisfied and the comp is UNCHANGED. The model
 *         refused, asked, or did nothing that stuck. Harmless: a user
 *         who typed this gets no work done and no damage.
 *   HARM  check() is not satisfied and the comp CHANGED anyway. Something
 *         was done to the project that the sentence did not ask for. This
 *         is the failure the matrix exists to find, and it is printed
 *         with the diff that proves it.
 *
 * "Changed" is read off the two READ_COMP states the run already fetches
 * (see compDiff) rather than a second AE round trip. The boundary errs
 * toward HARM on purpose: a false HARM costs a human one transcript read,
 * a false pass ships a wording bug.
 *
 * Acceptance (the exit code): no run may be HARM, no canonical may fail,
 * and a step whose canonical passes may have at most ONE variant miss.
 *
 * ISOLATION. Every step gets a FRESH chat history unless it declares
 * `carry` (only "a second turn that refers back" does — its sentence is
 * meaningless without the turn before it). That is not tidiness: the
 * shared history meant a later step could ride an earlier one's success,
 * and one wrong layer name in step 2 poisoned six later steps. Add
 * `--isolate` and the COMP resets too — every step that declares
 * `fromRig` starts from the same deterministically built world (see
 * rigPlan), which is what lets one scenario run N phrasings that cannot
 * contaminate each other. `--carry-history` puts the old behaviour back
 * for a side-by-side comparison.
 *
 * `--ctx` is what makes the compact-vs-full ROUTING comparison possible:
 * the panel chooses its tool-doc form from the window alone
 * (Tools.promptModeFor — compact below 24576), so the only honest way to
 * run the same sentences against the full docs is to run them at a
 * window the panel would call big. It patches the CACHED settings object
 * in memory only, never settings.json, for the same reason
 * applyStepSettings does: a probe must not be able to reconfigure the
 * product it is measuring.
 *
 * Writes a markdown transcript to logs/ and exits 0 only if every step
 * met its verdict. Needs After Effects running with "Allow Scripts to
 * Write Files and Access Network" enabled.
 *
 * It DOES press Ctrl+Z in the open project — the last step measures what
 * one typed sentence costs in undo steps. It never presses it more times
 * than the probe's own tool runs, so it cannot reach past its own work
 * into the user's, but run it on a scratch project all the same.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const HOSTSCRIPT = path.join(EXT, "jsx", "hostscript.jsx");
const ProbeStore = require(path.join(__dirname, "lib", "probe-store-root.js"));
// The memory store's root for this run (see main). Nothing reads it until
// the store ships; it exists now so the store cannot default to the
// owner's folder the day it does.
let PROBE_STORE_ROOT = null;

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}
const OPT = {
  steps: argValue("--steps"),
  model: argValue("--model"),
  ctx: argValue("--ctx"),
  port: argValue("--port"),
  route: argValue("--route"),
  // "compact" | "full" | null (the window decides, as in the panel).
  promptMode: argValue("--prompt-mode"),
  // "" when the flag is given with no folder, so it is refused rather
  // than silently falling back to a temp store.
  storeRoot: argv.indexOf("--store-root") === -1 ? null
    : (argValue("--store-root") || ""),
  keep: argv.indexOf("--keep") !== -1,
  afterFX: argValue("--afterfx"),
  reuseServer: argv.indexOf("--reuse-server") !== -1,
  // Free text written into the transcript header. With --reuse-server the
  // probe did not start the server and cannot see its flags (KV type,
  // -ctk/-ctv), so the run has to be TOLD what it is measuring: four
  // unlabelled 11b matrices on 2026-09-16 could not be told apart after.
  label: argValue("--label"),
  temperature: argValue("--temperature"),
  bridgeCheck: argv.indexOf("--bridge-check") !== -1,
  rigCheck: argv.indexOf("--rig-check") !== -1,
  isolate: argv.indexOf("--isolate") !== -1,
  carryHistory: argv.indexOf("--carry-history") !== -1,
  variants: argv.indexOf("--variants") !== -1,
  // A .partial.jsonl a killed run left behind: carry on from it.
  resume: argv.indexOf("--resume") === -1 ? null
    : (argValue("--resume") || ""),
  // Measure the SHIPPED DEFAULTS on purpose, when no settings file is
  // findable. Never a convenience: without it a probe that cannot see
  // this machine's settings refuses rather than reporting defaults as
  // somebody's configuration.
  defaultsOk: argv.indexOf("--defaults-ok") !== -1
};
// A paraphrase run is only honest from a known world: two phrasings of
// one scenario that inherit each other's leftovers are measuring the
// leftovers. --variants therefore IMPLIES --isolate.
if (OPT.variants) OPT.isolate = true;

// ------------------------------------------------------- After Effects

function findAfterFX() {
  if (OPT.afterFX) return OPT.afterFX;
  const base = "C:\\Program Files\\Adobe";
  let best = null;
  try {
    for (const d of fs.readdirSync(base)) {
      if (!/^Adobe After Effects/.test(d)) continue;
      const exe = path.join(base, d, "Support Files", "AfterFX.exe");
      if (fs.existsSync(exe) && (!best || d > best.dir)) {
        best = { dir: d, exe: exe };
      }
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
    else if (c < 0x20 || c > 0x7e) {
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else out += ch;
  }
  return out + '"';
}

let bridgeSeq = 0;
let hostLoaded = false;

/**
 * The ExtendScript AE is actually handed: load the host if needed, run the
 * expression, write the answer where Node can read it. Pure text, so
 * tests/test-chat-probe.js can run it against a stubbed $ / File.
 */
function bridgeWrapper(script, outPath, hostPath, force) {
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
    // Both names, not just AELL_call. A -r script inherits $.global from
    // whatever loaded hostscript before it (the panel, the harness, this
    // probe's own first call), and the two names do NOT arrive together:
    // AELL_call is published explicitly, AELLJSON only became a global on
    // 2026-08-26. Skipping the load with a stale host present left the
    // reads below evaluating a bare AELLJSON that did not exist — and AE
    // answers an undefined identifier with a MODAL, so it wedged the app
    // rather than failing. Reloading is cheap; guessing is not.
    "    if (" + (force ? "true" : "false") +
      " || typeof $.global.AELL_call !== \"function\"" +
      " || !$.global.AELLJSON) {",
    "      $.evalFile(new File(" +
      jsxString(hostPath.replace(/\\/g, "/")) + "));",
    "    }",
    // Grounded refusal beats a ReferenceError: if the load did not give us
    // the serializer, say so in the answer instead of evaluating anyway.
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

/**
 * Run one ExtendScript expression in the running AE and hand back what it
 * evaluated to. `eval` is used deliberately: the panel sends expressions
 * (AELL_call(...)) but also plain statements (AELL_newRequest()), and eval
 * swallows both while still returning the expression's value.
 */
function aeEval(script, cb, timeoutMs) {
  const id = ++bridgeSeq;
  const outPath = path.join(os.tmpdir(),
    "aell-probe-" + process.pid + "-" + id + ".json");
  const wrapperPath = path.join(os.tmpdir(),
    "aell-probe-" + process.pid + "-" + id + ".jsx");
  try { fs.unlinkSync(outPath); } catch (e) {}

  const force = !hostLoaded;
  hostLoaded = true;

  const wrapper = bridgeWrapper(script, outPath, HOSTSCRIPT, force);
  fs.writeFileSync(wrapperPath, wrapper, "ascii");

  // Start-Process semantics: on a cold machine THIS process is AE and it
  // holds stdout open for as long as AE lives, so never wait on it.
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
    if (Date.now() > deadline) {
      cb("", true);
      return;
    }
    setTimeout(poll, 150);
  })();
}

/*
 * A step's fixture, when the earlier steps do not leave one behind
 * (nothing before the remove_effect step puts an effect on Beta).
 * `prepare` is ExtendScript sent through the bridge OUTSIDE the model
 * path: it is not a tool run, so it does not count toward probeRuns, and
 * the comp is read back AFTER it the same way as after any other turn,
 * so the verdict sees exactly what it planted.
 *
 * Consequence for undo: measureUndo caps Ctrl+Z at probeRuns, and a
 * fixture is one more AE script execution (one more undo step) that the
 * cap does not know about. An undo:true step that follows a prepared
 * step would find its cap one short of reaching "before". Today the only
 * undo:true step is 10 and every prepared step comes after it; keep it
 * that way, or count fixtures into the cap.
 */
function runPrepare(step, cb) {
  if (!step.prepare) { cb(); return; }
  aeEval(step.prepare, function (text, isError) {
    say("info", "fixture: " + (isError ? "AE did not answer"
      : String(text || "").slice(0, 200)));
    cb();
  });
}

/** Read-only inspection expression -> parsed JSON (probe verdicts). */
function aeRead(expr, cb) {
  aeEval("AELLJSON.stringify((function () { " + expr + " })())",
    function (text, isError) {
      if (isError) { cb(null, new Error("AE did not answer")); return; }
      let obj = null;
      try { obj = JSON.parse(text); } catch (e) {
        cb(null, new Error("unparseable AE answer: " + text.slice(0, 200)));
        return;
      }
      cb(obj, null);
    });
}

// -------------------------------------------------------- the panel, in Node

// The managed backend's PID lives in a FILE beside settings.json, not in
// this process's memory. Measured 2026-09-09 (WORKPLAN 18 P5): with a
// bare in-memory shim here, `Comfy.ensureRunning` could not see that the
// backend answering on the managed port was one the panel itself booted,
// so every step-13 generation died on "Something is already answering on
// 127.0.0.1:8288 ... and the panel did not start it" -- a refusal aimed
// at a squatting stranger, fired at the panel's own backend. The other
// six scripts already share scripts/lib/comfy-managed.js for exactly
// this (17m/17n/17o, "one backend-resolution rule"); chat-probe was the
// seventh and kept its own copy. makeStorage is a superset of the shim
// it replaces: same in-memory behaviour for every key but the PID.
const managed = require("./lib/comfy-managed.js");
let pidFile = null;              // set once Settings.dataRoot() is loadable
let probeRuns = 0;
const window = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  localStorage: managed.makeStorage(function () { return pidFile; }),
  AEBridge: {
    nodeRequire: require,
    getExtensionPath() { return EXT; },
    evalScript(script, cb) {
      // Every tool run the probe sends AE, fused batch or single call.
      // The undo step below will not press Ctrl+Z more times than this,
      // so it can never reach past the probe into the user's own edits.
      if (/AELL_call(Batch)?\s*\(/.test(script)) probeRuns++;
      aeEval(script, function (text, isError) {
        if (cb) cb(text, isError);
      });
    }
  }
};
window.window = window;

function loadPanelFile(rel) {
  const src = fs.readFileSync(path.join(EXT, "js", rel), "utf8");
  // `.call(window, ...)` and not just `(window)`: ten of the panel
  // modules end `})(window)` but whisper.js and ffmpeg.js end `})(this)`,
  // which is the same object in a browser and is NODE'S GLOBAL here. So
  // loading them the plain way published Whisper on globalThis, tools.js
  // looked for global.Whisper on the probe's window and found nothing,
  // and transcribe_to_captions answered "not available in this panel
  // build" — a shipped-looking refusal that says nothing about the
  // machine. Binding `this` too makes the loader work for both shapes.
  new Function("window", src).call(window, window);
}
// version.js FIRST, exactly as index.html loads it: it publishes
// global.AELL, which carries COMFY_CATALOG. tools.js reads that catalog
// to rank workflow templates (fit, weights on disk, which graph the
// entry itself points at). Without it the read yields an empty list and
// the ranking silently degrades to name order — the same alphabetical
// choice §18 P1 replaced. Caught by test-chat-probe's own MODULE_FILE
// guard the moment tools.js referenced global.AELL.
loadPanelFile("version.js");
loadPanelFile("settings.js");
loadPanelFile("tiers.js");
loadPanelFile("llama.js");
// setup.js and comfy.js are not optional extras: tools.js reaches for
// global.Comfy in every comfy_* tool and for global.Setup.queryVramUsedMB
// on every chat->gen handoff. Without them a generation step does not
// fail with a grounded error, it throws ReferenceError inside the
// dispatcher — which is what the probe found the first time it asked for
// a picture.
loadPanelFile("setup.js");
loadPanelFile("comfy.js");
// Same reason: transcribe_to_captions reaches for global.Whisper before
// it can produce a grounded "not installed" refusal.
loadPanelFile("whisper.js");
// And again for export_gif/export_social, which reach for global.Ffmpeg.
loadPanelFile("ffmpeg.js");
// mogrt-read.js: tools.js verifies every export_mogrt receipt against
// the file through global.MogrtRead — load it the way the panel does
// (index.html order) so the probe exercises the shipped hook.
loadPanelFile("mogrt-read.js");
loadPanelFile("tools.js");

const Settings = window.Settings;
// Now Settings is loaded, the PID key has somewhere durable to point --
// beside settings.json, by the panel's own dataRoot rule.
try {
  pidFile = path.join(Settings.dataRoot(), "comfy-managed.pid");
} catch (e) { pidFile = null; }
const Llama = window.Llama;
const Tools = window.Tools;
const Comfy = window.Comfy;

/*
 * Whose configuration is this? Settings.dataRoot() is built from APPDATA,
 * and the WMI-detached loop does not always carry it: on 2026-09-02 a
 * pass with no APPDATA read pure DEFAULTS and filed `comfyUrl: 8188` as
 * the owner's setting. It was 8000 and had never been touched; two
 * sessions repeated the claim before anyone checked. A probe that cannot
 * find the settings file is not measuring this machine, so it says so at
 * the top of its own output and refuses to run unless asked to.
 */
function reportSettingsOrigin() {
  const o = Settings.origin();
  if (o.saved) {
    console.log("settings   : " + o.from + " (" + o.file + ")");
    // Both, deliberately: comfyUrl is the "use my own ComfyUI" SETTING,
    // and in managed mode it is not what anything talks to. Printing it
    // alone is how a transcript names one backend while the run measures
    // another (§17m).
    const cs = Settings.get();
    console.log("comfyUrl   : " + cs.comfyUrl);
    console.log("backend    : " + Comfy.backendMode(cs) + " -> " +
                Comfy.backendUrl(cs));
    return o;
  }
  console.log("\n!! SETTINGS NOT FOUND — every value below is a DEFAULT, " +
              "not this machine's configuration.");
  console.log("   looked for : " + o.file);
  console.log("   APPDATA    : " +
              (o.appdata || "(not set — this is usually why)"));
  console.log("   Nothing here may be reported as the user's setting. " +
              "Re-run with APPDATA set, or pass --defaults-ok to measure " +
              "the shipped defaults deliberately.\n");
  if (!OPT.defaultsOk) {
    process.exitCode = 2;
    throw new Error("refusing to probe against defaults: no settings file " +
                    "at " + o.file);
  }
  return o;
}

/*
 * --ctx: in-memory only (see the header). Applied here, before the first
 * prompt is built and before the server is started, so llama-server is
 * launched with the same -c the prompt was sized for.
 */
if (OPT.ctx) {
  const want = parseInt(OPT.ctx, 10);
  if (!(want > 0)) {
    console.error("--ctx wants a positive integer, got " + OPT.ctx);
    process.exit(2);
  }
  Settings.get().ctxSize = want;
}

// --port: in-memory like --ctx. The panel's own llama-server holds the
// settings port whenever it is open with a model loaded, and stopping it
// to measure would reconfigure the product under the owner (§24d). A
// second server on another port leaves it alone.
if (OPT.port) {
  const p = parseInt(OPT.port, 10);
  if (!(p > 0 && p < 65536) || String(p) !== String(OPT.port)) {
    console.error("--port wants an integer 1..65535, got " + OPT.port);
    process.exit(2);
  }
  Settings.get().port = p;
}

// --temperature: in-memory like --ctx. A/B gates (NEXT UP 11b) run at 0:
// at the panel's 0.7 two runs of the SAME config differed by 6-9 "new
// HARM" rows on 2026-09-16, so a one-run comparison there grades sampling.
if (OPT.temperature !== null) {
  const t = parseFloat(OPT.temperature);
  if (!(t >= 0 && t <= 2)) {
    console.error("--temperature wants a number 0..2, got " + OPT.temperature);
    process.exit(2);
  }
  Settings.get().temperature = t;
}

// --prompt-mode compact|full: NOT a setting, the panel has no such knob.
// Tools.promptModeFor ties the doc form to the window, so every 32K run
// changed prompt and window together and 11b-2 could not tell which one
// raised HARM (NEXT UP 11e). This separates them for the probe only.
if (argv.indexOf("--prompt-mode") !== -1 &&
    OPT.promptMode !== "compact" && OPT.promptMode !== "full") {
  console.error("--prompt-mode wants compact or full, got " + OPT.promptMode);
  process.exit(2);
}

// --resume <file>: refused before AE or a model is touched when there is
// nothing readable to resume from.
if (require.main === module && OPT.resume !== null) {
  let problem = null;
  if (!OPT.resume) problem = "no file given";
  else if (!fs.existsSync(OPT.resume)) problem = "no such file: " + OPT.resume;
  else {
    const parsed = readPartial(fs.readFileSync(OPT.resume, "utf8"));
    if (parsed.error) problem = parsed.error;
  }
  if (problem) {
    const logs = path.join(ROOT, "logs");
    const found = fs.existsSync(logs) ? fs.readdirSync(logs)
      .filter(f => /\.partial\.jsonl$/.test(f)) : [];
    console.error("--resume wants a chat-probe .partial.jsonl — " + problem +
                  "; partial files in logs/: " + (found.join(", ") || "none"));
    process.exit(2);
  }
}

// --route auto|all: in-memory like --ctx, so a probe never rewrites the
// owner's panel setting.
if (OPT.route) {
  if (OPT.route !== "auto" && OPT.route !== "all") {
    console.error("--route wants auto or all, got " + OPT.route);
    process.exit(2);
  }
  Settings.get().promptRouting = OPT.route;
}

/*
 * A step that has to impersonate different hardware (`settings: {...}` on
 * the step) gets it for the length of its own sentence and no longer.
 *
 * Deliberately NOT Settings.set: that mirrors every key to
 * %APPDATA%\AE-Llama\settings.json, so a probe that died mid-step would
 * leave the OWNER'S panel running on an 8 GB budget with chat pausing
 * turned off — a probe must never be able to reconfigure the product it
 * is measuring. Settings.get() hands back one cached object that every
 * tool reads, so patching it in place reaches the whole panel path and
 * restoring puts back exactly what was there.
 */
function applyStepSettings(patch) {
  if (!patch) return function () {};
  const s = Settings.get();
  const saved = {};
  for (const k in patch) { saved[k] = s[k]; s[k] = patch[k]; }
  say("info", "settings for this step: " +
      Object.keys(patch).map(k => k + " = " + JSON.stringify(patch[k]))
        .join(", "));
  return function restore() { for (const k in saved) s[k] = saved[k]; };
}

// The panel shows the arbiter's pause/resume and ComfyUI's progress in
// its status line; here they belong in the transcript, or a step that
// spends two minutes looks like a hang.
Tools.setProgressSink(function (msg) { say("info", String(msg)); });

// main.js does this on every panel load, and it is the only thing that
// seeds bundled workflow templates into the user's data dir. Skipping it
// meant the probe asked the model to generate from whatever templates an
// old install happened to have — this machine was missing KREA2, shipped
// three versions ago, because no panel had started since.
try { window.Setup.ensureDataDirs(); } catch (eDirs) {}

// Mirror main.js: hand the GPU probe's result to the VRAM arbiter so
// its inputs are as real here as in the panel. The probe machine's
// nvidia-smi answers exactly like the panel's would; when it is absent
// the arbiter sees what a no-GPU user's panel sees.
try {
  const cpx = require("child_process");
  cpx.execFile("nvidia-smi",
    ["--query-gpu=name,compute_cap,memory.total",
     "--format=csv,noheader,nounits"],
    { timeout: 15000 },
    function (gErr, gOut) {
      if (gErr) { Tools.setGpuInfo({ hasNvidia: false, vramGB: null }); return; }
      const parts = String(gOut).split(/\r?\n/)[0].split(",");
      Tools.setGpuInfo({
        hasNvidia: true,
        name: (parts[0] || "").trim() || null,
        computeCap: /^\d+(\.\d+)?$/.test((parts[1] || "").trim())
          ? parseFloat(parts[1].trim()) : null,
        vramGB: /^\d+$/.test((parts[2] || "").trim())
          ? Math.round(parseInt(parts[2].trim(), 10) / 1024) : null
      });
    });
} catch (eGpu) {
  Tools.setGpuInfo({ hasNvidia: false, vramGB: null });
}

// ------------------------------------------------------------ transcript

const transcript = [];
function say(kind, text, label) {
  const line = (label ? label + "\n" : "") + text;
  transcript.push({ kind, text, label });
  const tag = { user: ">>", assistant: "AI", tool: "..", error: "!!",
                info: "--", verdict: "==" }[kind] || "  ";
  console.log(tag + " " + line.replace(/\n/g, "\n   "));
}

// ------------------------------------------------- the chat round loop
//
// Mirrors main.js sendMessage(): state block -> system prompt -> chat ->
// executeCommands -> TOOL RESULTS -> next round, capped by maxRounds.

const history = [];

/* Once per session, exactly as main.js scopes them: the ledger notice is
 * about this conversation, the starvation notice is about the window
 * itself. */
const sessionNotices = { ledger: false, starved: false };

/*
 * Start a new CONVERSATION — what a user pressing "clear chat" gets.
 * Both notices are scoped to a conversation in main.js, so both reset
 * with it; leaving `ledger` set would make the next step's first trim
 * silent and the transcript would stop being readable step by step.
 */
function resetHistory() {
  history.length = 0;
  sessionNotices.ledger = false;
  sessionNotices.starved = false;
}

/* Set by scripts/context-budget-probe.js. Never set during a normal run,
 * so it can only observe. */
let roundObserver = null;
function setRoundObserver(fn) { roundObserver = fn; }

/* What a generation left behind, so the cleanup can take it back out.
 * IDs only, never "everything under the output folder": the probe runs
 * against the user's live project, and a previous generation of THEIRS
 * living in the same folder is not the probe's to delete. */
const generated = { itemIds: [], files: [] };

function rememberGenerated(tool, result) {
  if (tool !== "comfy_generate" || !result || !result.ok || !result.data) {
    return;
  }
  const files = result.data.files instanceof Array ? result.data.files : [];
  for (const f of files) {
    if (typeof f === "string" && generated.files.indexOf(f) === -1) {
      generated.files.push(f);
    }
  }
  const imported = result.data.imported instanceof Array
    ? result.data.imported : [];
  for (const it of imported) {
    if (it && typeof it.id === "number" &&
        generated.itemIds.indexOf(it.id) === -1) {
      generated.itemIds.push(it.id);
    }
  }
}

// The panel's own budgeter, not a copy of it. The probe exists to run
// the product path for real, and a second implementation here would be
// a second thing to get wrong - which it was: this held a duplicate of
// the byte-slicer for as long as main.js did.
function compactToolResults(results) {
  return Tools.compactToolResults(results);
}

/**
 * One command's record in `round.tools` — the ONLY thing a step's
 * `check` can see about what the model did (`calls(ctx, name)` reads
 * this array).
 *
 * A rolled-back command used to be skipped entirely, and that made a
 * whole round invisible: the "sync to the music" step, whose expected
 * outcome IS a grounded refusal on a silent rig, reported "the model
 * never reached audio_to_keyframes and ran no tools at all" about a
 * round in which the model reached exactly audio_to_keyframes and
 * relayed exactly the refusal. Whether a failing round rolls back
 * depends on what ELSE the model emitted beside the failing command, so
 * the same behaviour scored pass in one run and FAIL in the next — noise
 * indistinguishable from a real routing regression in any comparison
 * built on these transcripts.
 *
 * `ok` stays false and `data` stays null for a rolled-back command:
 * nothing was applied, so nothing may be scored as applied. Only the
 * ATTEMPT becomes visible.
 */
function toolEntry(cmd, result) {
  const back = !!result.rolledBack;
  return { tool: cmd.tool, args: cmd.args || {},
           ok: !back && !!result.ok,
           data: back ? null : (result.data || null),
           rolledBack: back,
           error: back ? (result.error || "rolled back with the round")
                       : (result.error || null) };
}

function sendMessage(text, done) {
  const s = Settings.get();
  say("user", text);
  history.push({ role: "user", content: text });
  // tools/replies are what a verdict about a PANEL-side tool has to judge:
  // comfy_generate leaves nothing in the comp to read back, so "did the
  // model reach for the generator, and what came back" only exists here.
  const round = { rounds: 0, commands: 0, toolRounds: 0, failures: [],
                  rolledBack: 0, tools: [], replies: [] };
  // In step with main.js: ONE rollback per typed sentence, across all of
  // its rounds. Without this the probe could never exercise the model's
  // half of a rollback — the host only arms it when the caller asks, so
  // an unarmed probe proves nothing about what the model does with a
  // ROLLED BACK result.
  let rollbackBudget = 1;

  let po = null, turnState = "";
  aeEval("if ($.global.AELL_newRequest) $.global.AELL_newRequest();",
    function () {
      Tools.fetchProjectState(function (stateJson) {
        // In step with main.js: the prompt form follows the window, and
        // promptRouting (--route) narrows it the same way.
        turnState = stateJson;
        po = probePromptOpts(s, text, history, OPT.promptMode);
        round.route = po.routeInfo;
        if (po.routeInfo) {
          console.log("   route: " + (po.routeInfo.matched
            ? "matched, picked " + (po.routeInfo.picked.join(",") || "-") +
              ", rendering " + po.routeInfo.tools.length + " tools"
            : "no match, whole prompt"));
        }
        const system = Tools.buildSystemPrompt(stateJson, po.opts);
        runRound(system, 0);
      });
    });

  // In step with main.js: round N+1's route grows by what round N called
  // and what its results named (§24c).
  function nextSystem(system, commands, resultsText) {
    if (!Tools.extendPromptOpts(po, commands, resultsText)) return system;
    round.route = po.routeInfo;
    console.log("   route extended: " + po.routeInfo.extended.join(","));
    return Tools.buildSystemPrompt(turnState, po.opts);
  }

  function runRound(system, n) {
    round.rounds = n + 1;
    // In step with main.js: bound what the model is sent, or a long chat
    // dies on a raw HTTP 400. The probe found that bug by being the only
    // thing that holds a ten-turn conversation, so it has to carry the
    // fix too — otherwise it would keep reporting a failure the panel no
    // longer has.
    const hb = Tools.historyBudget(s.ctxSize, system);
    let histBudget = hb.chars;
    if (round.forceTinyContext) histBudget = 1;
    const fitted = Tools.fitHistory(history, histBudget);
    let sys = system;
    if (fitted.ledger) {
      // In step with main.js: dropped turns ride as the ledger.
      sys += "\n\n" + fitted.ledger;
    }
    if (fitted.dropped > 0) {
      // Per SENTENCE, not per session: the probe's transcript is read
      // step by step, and "which step started forgetting" is the fact a
      // verdict is judged against. main.js shows its own once-per-chat
      // line below; both exist because they answer different questions.
      if (!round.trimNoticeShown) {
        round.trimNoticeShown = true;
        say("info", "context trimmed — " + fitted.dropped +
            " earlier message(s) dropped from what the model is sent");
      }
      round.trimmed = (round.trimmed || 0) + fitted.dropped;
    }
    // The two notices the PANEL shows, mirrored here so a probe run can
    // prove a real user would have seen them. The starvation one was
    // missing entirely: main.js has warned since 2026-09-01 that the
    // window is nearly full of prompt, and the probe — the only thing
    // that runs the product path headless — never said it.
    if (fitted.dropped > 0 && !sessionNotices.ledger) {
      sessionNotices.ledger = true;
      say("info", "Older turns now reach the model as a one-line ledger " +
          "of what ran and what it named, instead of in full — your " +
          "transcript is unaffected. Clearing the chat starts fresh.",
          "context ledger");
    }
    if (hb.starved && !sessionNotices.starved) {
      sessionNotices.starved = true;
      say("info", "The model's context window (" + s.ctxSize +
          " tokens) is nearly filled by the tool documentation and " +
          "project state alone (~" + hb.promptTokens + " tokens), so it " +
          "will forget turns quickly.", "context");
    }
    const messages = [{ role: "system", content: sys }]
      .concat(fitted.entries);
    // Read-only hook for scripts/context-budget-probe.js: what this
    // round really sent, so the token measurement is taken on the
    // product's own payload rather than a rebuilt guess of it.
    if (roundObserver) {
      roundObserver({ system: sys, hb: hb, fitted: fitted,
                      route: round.route || null,
                      messages: messages, round: n + 1, ctxSize: s.ctxSize });
    }
    const t0 = Date.now();
    Llama.chat({ port: s.port, temperature: s.temperature }, messages,
      Tools.RESPONSE_SCHEMA, null,
      function (err, obj, raw) {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (err) {
          // The reactive half of the same fix: a context 400 that slipped
          // past the estimate gets ONE retry with only the current
          // exchange.
          if (/context|exceed|too (?:long|large|many)/i.test(err.message) &&
              !round.forceTinyContext) {
            round.forceTinyContext = true;
            round.hardTrimmed = true;
            say("info", "request outgrew the context window — retrying " +
                "with older turns trimmed");
            runRound(system, n);
            return;
          }
          say("error", "Model error after " + secs + "s: " + err.message);
          round.failures.push("model: " + err.message);
          done(round);
          return;
        }
        history.push({ role: "assistant", content: raw });
        const reply = typeof obj.reply === "string" ? obj.reply : "";
        const commands = obj.commands instanceof Array ? obj.commands : [];
        if (reply) {
          round.replies.push(reply);
          say("assistant", reply + "  [" + secs + "s]");
        }
        if (commands.length === 0) { done(round); return; }
        round.commands += commands.length;
        // A round that calls tools costs at least one AE script execution,
        // and AE groups a script execution into one undo step. So this is
        // the ceiling the undo step below holds the product to.
        round.toolRounds++;

        Tools.executeCommands(commands,
          { dryRun: false, allowRollback: rollbackBudget > 0,
            userTexts: Tools.userTurnTexts(history) },
          function (i, cmd, result) {
            const head = cmd.tool + " " + JSON.stringify(cmd.args || {});
            if (result.rolledBack) {
              // Say it ONCE, the way the panel does, and spend the budget.
              if (!round.rolledBack) {
                say("info", "ROUND ROLLED BACK — nothing from it was " +
                    "applied: " + String(result.error || result.note || "")
                      .slice(0, 200));
                rollbackBudget--;
              }
              round.rolledBack++;
              // ...but still RECORD it — see toolEntry().
              round.tools.push(toolEntry(cmd, result));
              say("error", "ROLLED BACK: " + String(result.error ||
                    result.note || "the round was undone").slice(0, 200),
                  head);
              return;
            }
            round.tools.push(toolEntry(cmd, result));
            rememberGenerated(cmd.tool, result);
            rememberPrecomp(cmd.tool, result);
            const body = result.ok
              ? "ok" + (result.data
                  ? ": " + JSON.stringify(result.data).slice(0, 400) : "")
              : "ERROR: " + result.error;
            if (!result.ok) round.failures.push(head + " -> " + result.error);
            say(result.ok ? "tool" : "error", body, head);
          },
          function (results) {
            const resultsText = compactToolResults(results);
            history.push({ role: "user",
              content: "TOOL RESULTS:\n" + resultsText });
            if (n + 1 >= s.maxRounds) {
              say("info", "Stopped after " + s.maxRounds + " tool rounds.");
              done(round);
              return;
            }
            runRound(nextSystem(system, commands, resultsText), n + 1);
          });
      });
  }
}

// ------------------------------------------------------------ the checklist
//
// Written the way a motion designer types, not the way the tool docs read
// — the point is whether the MODEL can get from one to the other. Each
// check() runs read-only ExtendScript against the real comp.

const COMP = "Probe Room";

/** ExtendScript body: find the probe comp, or null. */
const FIND_COMP =
  "var c = null, i;" +
  "for (i = 1; i <= app.project.numItems; i++) {" +
  "  var it = app.project.item(i);" +
  "  if (it instanceof CompItem && it.name === " + JSON.stringify(COMP) +
  ") { c = it; break; }" +
  "}";

/** Every layer of the probe comp as plain data (position, keys, parent…). */
const READ_COMP = FIND_COMP +
  "if (!c) return { found: false };" +
  "var out = { found: true, name: c.name, width: c.width," +
  "  height: c.height, duration: c.duration, frameRate: c.frameRate," +
  "  layers: [] };" +
  "for (i = 1; i <= c.numLayers; i++) {" +
  "  var L = c.layer(i);" +
  "  var row = { index: i, name: L.name, parent: L.parent ? L.parent.name" +
  "    : null, matte: 0, masks: 0, text: null, effects: 0," +
  "    opacityKeys: 0, opacityKeyTimes: [], position: null," +
  "    startTime: 0, inPoint: 0, solidColor: null," +
  "    effectNames: [], effectColors: []," +
  "    scale: null, rotation: null, isText: false, isShape: false," +
  "    isNull: false, isSolid: false, sourceFile: null," +
  "    matteLayer: null, matteLayerKnown: false, isPrecomp: false," +
  "    anchorPoint: null, opacity: null," +
  "    sourceRect: null, layerWidth: null, layerHeight: null, maskBoxes: []," +
  "    maskModes: [], maskInverted: [], maskFeather: [], maskRound: []," +
  "    fontSize: null, fillColor: null," +
  "    opacityKeyEased: [], expressions: {}, textAnimators: 0 };" +
  "  try { row.matte = L.trackMatteType; } catch (e1) {}" +
  "  try { row.startTime = L.startTime; row.inPoint = L.inPoint;" +
  "  } catch (e1b) {}" +
  "  try { row.isNull = !!L.nullLayer; } catch (e2) {}" +
  "  try { row.isText = (L instanceof TextLayer); } catch (e3) {}" +
  "  try { row.isShape = (L instanceof ShapeLayer); } catch (e4) {}" +
  "  try { row.isSolid = (L.source && L.source.mainSource &&" +
  "    (L.source.mainSource instanceof SolidSource)); } catch (e5) {}" +
  "  try { if (row.isSolid) row.solidColor =" +
  "    L.source.mainSource.color.slice(0); } catch (e5b) {}" +
  // Where a layer's pixels come from ON DISK. "Put the picture you just
  // made in the comp" can only be judged by the file behind the layer —
  // the name AE gives an imported item is the file name and proves
  // nothing about which file it is.
  "  try { if (L.source && L.source.mainSource &&" +
  "    (L.source.mainSource instanceof FileSource)) {" +
  "    row.sourceFile = L.source.mainSource.file.fsName; } } catch (e5d) {}" +
  // Effect NAMES and every colour any effect holds: "make them blue" has
  // no set-the-solid's-colour tool behind it, so a Fill/Tint effect is a
  // legitimate way for the model to answer and the verdict has to see it.
  "  try {" +
  "    var fx = L.property('ADBE Effect Parade');" +
  "    for (var f = 1; f <= fx.numProperties; f++) {" +
  "      var E = fx.property(f);" +
  "      row.effectNames.push(E.name);" +
  "      for (var q = 1; q <= E.numProperties; q++) {" +
  "        try {" +
  "          var P = E.property(q);" +
  "          if (P.propertyValueType === PropertyValueType.COLOR) {" +
  "            row.effectColors.push(P.value.slice(0, 3));" +
  "          }" +
  "        } catch (eq) {}" +
  "      }" +
  "    }" +
  "  } catch (e5c) {}" +
  "  try { if (row.isText) row.text =" +
  "    L.property('Source Text').value.text; } catch (e6) {}" +
  // "white, 120 pixels" is half the sentence the text step types, and a
  // check that only reads .text scores a 12px black HELLO as a pass.
  // fillColor is read in its own try: a TextDocument with applyFill off
  // throws on it, and that must not cost the size too.
  "  try { if (row.isText) {" +
  "    var td = L.property('Source Text').value;" +
  "    if (typeof td.fontSize === 'number') row.fontSize = td.fontSize;" +
  "    try { if (td.applyFill !== false && td.fillColor) {" +
  "      row.fillColor = [td.fillColor[0], td.fillColor[1]," +
  "        td.fillColor[2]]; } } catch (e6b) {}" +
  "  } } catch (e6c) {}" +
  "  try { row.masks = L.property('ADBE Mask Parade').numProperties;" +
  "  } catch (e7) {}" +
  "  try { row.effects = L.property('ADBE Effect Parade').numProperties;" +
  "  } catch (e8) {}" +
  "  try { row.position = L.property('ADBE Transform Group')" +
  "    .property('ADBE Position').value.slice(0); } catch (e9) {}" +
  "  try { row.scale = L.property('ADBE Transform Group')" +
  "    .property('ADBE Scale').value.slice(0); } catch (e10) {}" +
  "  try { row.rotation = L.property('ADBE Transform Group')" +
  "    .property('ADBE Rotate Z').value; } catch (e11) {}" +
  "  try {" +
  "    var op = L.property('ADBE Transform Group')" +
  "      .property('ADBE Opacity');" +
  "    row.opacityKeys = op.numKeys;" +
  "    for (var k = 1; k <= op.numKeys && k <= 12; k++) {" +
  "      row.opacityKeyTimes.push(op.keyTime(k));" +
  "    }" +
  "  } catch (e12) {}" +
  // What the trigger-layer steps (14 onward) judge on, each read in its
  // own try: a null has no source rect worth reading, a camera no anchor
  // point, and one throw must not blank the rest of the row.
  "  try { row.matteLayerKnown = (typeof L.trackMatteLayer" +
  "    !== 'undefined');" +
  "    row.matteLayer = L.trackMatteLayer ? L.trackMatteLayer.name" +
  "    : null; } catch (e13) {}" +
  "  try { row.isPrecomp = !!(L.source && (L.source instanceof CompItem));" +
  "  } catch (e14) {}" +
  "  try { row.anchorPoint = L.property('ADBE Transform Group')" +
  "    .property('ADBE Anchor Point').value.slice(0); } catch (e15) {}" +
  "  try { row.opacity = L.property('ADBE Transform Group')" +
  "    .property('ADBE Opacity').value; } catch (e16) {}" +
  "  try { var sr = L.sourceRectAtTime(0, false);" +
  "    row.sourceRect = { left: sr.left, top: sr.top, width: sr.width," +
  "      height: sr.height }; } catch (e17) {}" +
  "  try { row.layerWidth = L.width; row.layerHeight = L.height;" +
  "  } catch (e18) {}" +
  // Bounding box of every mask path: 'hide the bottom half' is only
  // judged honestly when the verdict can see how much of the layer the
  // mask covers — a count alone passes a mask the size of the layer.
  "  try {" +
  "    var mp = L.property('ADBE Mask Parade');" +
  "    for (var mi = 1; mi <= mp.numProperties && mi <= 8; mi++) {" +
  "      var mk = mp.property(mi);" +
  "      try {" +
  "        var mm = mk.maskMode;" +
        // Parenthesised on purpose: this string is executed by
        // ExtendScript, which parses `?:` LEFT-associatively, so the bare
        // chain read `((mm===SUBTRACT ? 'subtract' : mm===ADD) ? 'add'
        // : 'other')` — every SUBTRACT mask came back as 'add'. That is
        // not a cosmetic slip: step 19's check passes a bottom-half mask
        // only when it subtracts, so the probe scored two correct model
        // answers as HARM. tests/test-es3-ternary.js now lints the
        // ExtendScript embedded in this file too.
  "        row.maskModes.push(mm === MaskMode.SUBTRACT ? 'subtract'" +
  "          : (mm === MaskMode.ADD ? 'add' : 'other'));" +
  "        row.maskInverted.push(!!mk.inverted);" +
  "      } catch (emm) {" +
  "        row.maskModes.push('unknown'); row.maskInverted.push(false);" +
  "      }" +
  // Feather is a two-component property ([x, y]); the sentence asks for
  // one number, so the larger of the two is what "feather it 20" means.
  "      try {" +
  "        var mf = mk.property('ADBE Mask Feather').value;" +
  "        row.maskFeather.push(Math.max(mf[0], mf[1]));" +
  "      } catch (emf) { row.maskFeather.push(null); }" +
  "      var shp = mk.property('ADBE Mask Shape').value;" +
  "      var vs = shp.vertices;" +
  // An ellipse mask and a rectangle mask have the SAME four-vertex
  // bounding box; the only thing that tells them apart is that AE gives
  // an ellipse curved segments (non-zero bezier tangents) and a
  // rectangle straight ones. "Put an OVAL mask on it" has no other
  // fingerprint, so a box-only check passes a rectangle.
  "      var round = false, tg;" +
  "      try {" +
  "        for (tg = 0; tg < vs.length; tg++) {" +
  "          var ti = shp.inTangents[tg], to = shp.outTangents[tg];" +
  "          if ((ti && (ti[0] || ti[1])) || (to && (to[0] || to[1]))) {" +
  "            round = true; break;" +
  "          }" +
  "        }" +
  "      } catch (etg) { round = null; }" +
  "      row.maskRound.push(round);" +
  "      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;" +
  "      for (var vi = 0; vi < vs.length; vi++) {" +
  "        if (vs[vi][0] < x0) x0 = vs[vi][0];" +
  "        if (vs[vi][0] > x1) x1 = vs[vi][0];" +
  "        if (vs[vi][1] < y0) y0 = vs[vi][1];" +
  "        if (vs[vi][1] > y1) y1 = vs[vi][1];" +
  "      }" +
  "      row.maskBoxes.push([x0, y0, x1 - x0, y1 - y0]);" +
  "    }" +
  "  } catch (e19) {}" +
  // apply_keyframe_ease sets BEZIER interpolation on the keys it eases
  // (hostscript setInterpolationTypeAtKey); keys set_keyframes makes are
  // LINEAR. That is the whole difference 'smoother' has to produce.
  "  try {" +
  "    var op2 = L.property('ADBE Transform Group')" +
  "      .property('ADBE Opacity');" +
  "    for (var k2 = 1; k2 <= op2.numKeys && k2 <= 12; k2++) {" +
  "      row.opacityKeyEased.push(" +
  "        op2.keyInInterpolationType(k2) ===" +
  "          KeyframeInterpolationType.BEZIER ||" +
  "        op2.keyOutInterpolationType(k2) ===" +
  "          KeyframeInterpolationType.BEZIER);" +
  "    }" +
  "  } catch (e20) {}" +
  "  try {" +
  "    var xn = ['ADBE Position', 'ADBE Scale', 'ADBE Rotate Z'," +
  "      'ADBE Opacity'];" +
  "    var xk = ['position', 'scale', 'rotation', 'opacity'];" +
  "    for (var xi = 0; xi < xn.length; xi++) {" +
  "      try {" +
  "        var xp = L.property('ADBE Transform Group').property(xn[xi]);" +
  "        if (xp.expressionEnabled && xp.expression) {" +
  "          row.expressions[xk[xi]] = String(xp.expression).slice(0, 200);" +
  "        }" +
  "      } catch (ex) {}" +
  "    }" +
  "  } catch (e21) {}" +
  "  try { if (row.isText) row.textAnimators =" +
  "    L.property('ADBE Text Properties').property('ADBE Text Animators')" +
  "      .numProperties; } catch (e22) {}" +
  "  out.layers.push(row);" +
  "}" +
  // Every file-backed footage item in the PROJECT. comfy_generate imports
  // what it rendered and stops there (import_file has no comp argument),
  // so a step that asked for a picture is judged partly outside the comp.
  "out.footage = [];" +
  "for (i = 1; i <= app.project.numItems && out.footage.length < 300; i++) {" +
  "  var F = app.project.item(i);" +
  "  if (!(F instanceof FootageItem)) continue;" +
  "  var fp = null;" +
  "  try { if (F.mainSource instanceof FileSource) {" +
  "    fp = F.mainSource.file.fsName; } } catch (ef) {}" +
  "  if (!fp) continue;" +
  "  out.footage.push({ id: F.id, name: F.name, path: fp," +
  "    width: F.width, height: F.height, duration: F.duration," +
  "    usedIn: (function () { try { return F.usedIn.length; }" +
  "      catch (eu) { return -1; } })() });" +
  "}" +
  "return out;";

/* What the precompose step made, so the sweep can take it back out. The
 * nine solids live inside it afterwards, so until it is gone they count
 * as used and the footage pass below would leave them behind too — a
 * "Squares", "Squares 2", "Squares 3"… per run in the owner's project. */
const precomps = { itemIds: [], names: [] };

function rememberPrecomp(tool, result) {
  if (!result || !result.ok || !result.data) return;
  const d = result.data;
  // A comp the MODEL made with create_comp ("throw the squares into their
  // own comp" -> create_comp Squares, six times) is the probe's too, and
  // was never swept: measured 2026-09-16, four empty "Squares 2 2 ..."
  // comps outlived a run and the next run's precompose came out as
  // "Squares 3". By id only: the id is this run's own receipt, a name
  // could be the owner's.
  if (tool === "create_comp") {
    if (typeof d.id === "number" && precomps.itemIds.indexOf(d.id) === -1) {
      precomps.itemIds.push(d.id);
    }
    return;
  }
  if (tool !== "precompose") return;
  if (typeof d.id === "number" && precomps.itemIds.indexOf(d.id) === -1) {
    precomps.itemIds.push(d.id);
  }
  if (typeof d.precomp === "string" && d.precomp &&
      precomps.names.indexOf(d.precomp) === -1) {
    precomps.names.push(d.precomp);
  }
}

/* Remove every comp this probe made — the Probe Room comps, the precomp
 * its precompose step reported (by id and name), and, for a run that
 * died before a receipt was recorded, any "Squares[ N]" comp holding
 * NOTHING but the probe's own solids — plus the solid footage left
 * behind once nothing uses it. Direct ExtendScript rather than
 * delete_item: a LEFTOVER comp is worse than a messy project — the
 * model's create_comp gets auto-numbered to "Probe Room 2" while the
 * verdicts below still read "Probe Room", so every check silently
 * inspects the previous run's comp. That happened. The precomp pass runs
 * BEFORE the footage pass so the solids are unused by the time it looks.
 * The footage names are every solid the two rigs build (BG, Icon N, Beta)
 * and the null sources add_null leaves: measured 2026-09-16 the owner's
 * project held 2 055 of them unused, and READ_COMP's project listing put
 * that growing count into every prompt, so no two runs saw the same one. */
function sweepScript(pre) {
  pre = pre || precomps;
  return "var ids = " + JSON.stringify(pre.itemIds) + ";" +
    "var names = " + JSON.stringify(pre.names) + ";" +
    "var killed = 0, i, j, it, hit;" +
    "for (i = app.project.numItems; i >= 1; i--) {" +
    "  it = app.project.item(i);" +
    "  if (it instanceof CompItem && it.name.indexOf(" +
    JSON.stringify(COMP) + ") === 0) { it.remove(); killed++; }" +
    "}" +
    "for (i = app.project.numItems; i >= 1; i--) {" +
    "  it = app.project.item(i);" +
    "  if (!(it instanceof CompItem)) continue;" +
    "  hit = false;" +
    "  for (j = 0; j < ids.length; j++) if (it.id === ids[j]) hit = true;" +
    "  for (j = 0; j < names.length; j++) if (it.name === names[j]) hit = true;" +
    "  if (!hit && /^Squares( \\d+)?$/.test(it.name) && it.numLayers > 0) {" +
    "    hit = true;" +
    "    for (j = 1; j <= it.numLayers; j++) {" +
    "      try {" +
    "        var L = it.layer(j);" +
    "        if (!/^Red Square/.test(L.name) || !L.source ||" +
    "            !(L.source.mainSource instanceof SolidSource)) hit = false;" +
    "      } catch (eL) { hit = false; }" +
    "    }" +
    "  }" +
    "  if (hit) { it.remove(); killed++; }" +
    "}" +
    "for (i = app.project.numItems; i >= 1; i--) {" +
    "  it = app.project.item(i);" +
    "  if (!(it instanceof FootageItem)) continue;" +
    "  if (!/^(Red Square|White Ellipse|Rig|Icon \\d+$|BG$|Beta$|Null \\d+$)/.test(it.name)) continue;" +
    "  try { if (it.usedIn.length === 0) { it.remove(); killed++; } }" +
    "  catch (e) {}" +
    "}" +
    "return { removed: killed };";
}

/* Take back out exactly what a generation step imported, by item id.
 * Never by folder: the probe's output directory is the panel's, and the
 * user's own generations live there too. */
function sweepImports(ids) {
  return "var ids = " + JSON.stringify(ids || []) + ", killed = 0, i, j;" +
    "for (i = app.project.numItems; i >= 1; i--) {" +
    "  var it = app.project.item(i);" +
    "  for (j = 0; j < ids.length; j++) {" +
    "    if (it.id === ids[j]) {" +
    "      try { it.remove(); killed++; } catch (e) {}" +
    "      break;" +
    "    }" +
    "  }" +
    "}" +
    "return { removed: killed };";
}

// ------------------------------------------------------------ the rig
/*
 * The world the LATER steps talk about, built deterministically instead
 * of inherited from the earlier steps' model turns.
 *
 * Every step from "push a layer back on the timeline" onward names
 * things — Beta, HELLO, the Rig null, the nine squares — that steps 1-14
 * happened to leave behind. That made the run a chain: step 2 naming one
 * square wrongly poisoned six later steps, and there was no way to run
 * one sentence twice (the paraphrase matrix) because the second phrasing
 * started from what the first one did.
 *
 * So the fixtures those sentences need are built here, through
 * AELL_callBatch (one script execution, one undo group, the panel's own
 * tools) with no model in the loop. `--isolate` rebuilds this before
 * every step that declares `fromRig`, so N phrasings of one scenario
 * each start from a comp that is byte-for-byte the same world.
 *
 * The squares are BLUE, not red: the world the later sentences describe
 * is the one after "make them blue instead", and the precompose step
 * says "the nine blue squares" out loud. No later verdict reads their
 * colour, but the sentence has to be true.
 *
 * TWO rigs, not one. `fromRig: true` gets the world above — a FINISHED
 * grid, already faded, already parented. The A/B/C/E usefulness rows
 * (A1 grid, A2 slider rig, B1 stagger, C1 typewriter, C2 text style,
 * E1 blur, E2 for_each) ask for exactly the things that world already
 * has, so scoring them against it would score a no-op as a pass. They
 * declare `fromRig: "icons"` and get the UNFINISHED world instead:
 * six scattered icons over a background, no keyframes, no expressions,
 * no effects, a small plain headline. Same comp name, so one sweep
 * still cleans up after either.
 */
const RIG_SQUARES = 9;
const RIG_ICONS = 6;
/* Deliberately off-grid and uneven: no two icons share an x or a y, so
 * "is this a grid now?" is a question about what the MODEL did and never
 * about what the rig left behind. */
const ICON_SPOTS = [[380, 250], [1180, 190], [720, 640],
                    [1520, 780], [260, 830], [980, 430]];
const ICON_BG = "BG";
const ICON_TEXT = "HEADLINE";
const ICON_FONT_SIZE = 48;

/* The unfinished world. A background solid FIRST (so it lands at the
 * bottom of the stack, which is what "everything except the background"
 * and "soften the background" both assume), then the icons, then the
 * headline on top. Nothing here is animated, styled or rigged — every
 * fixture a sentence asks for must be absent, or the sentence proves
 * nothing. */
function iconRigPlan() {
  const cmds = [];
  cmds.push({ tool: "create_comp", args: { name: COMP, width: 1920,
    height: 1080, duration: 6, frameRate: 30 } });
  cmds.push({ tool: "add_solid", args: { comp: COMP, name: ICON_BG,
    color: [0.12, 0.12, 0.14], width: 1920, height: 1080 } });
  for (let i = 0; i < RIG_ICONS; i++) {
    const name = "Icon " + (i + 1);
    cmds.push({ tool: "add_solid", args: { comp: COMP, name: name,
      color: [0.1, 0.2, 0.9], width: 160, height: 160 } });
    cmds.push({ tool: "set_transform", args: { comp: COMP, layer: name,
      property: "position", value: ICON_SPOTS[i].slice(0) } });
  }
  // Small and white, so "make it bigger" and "brand blue" both have
  // somewhere to travel from.
  cmds.push({ tool: "add_text_layer", args: { comp: COMP, text: ICON_TEXT,
    fontSize: ICON_FONT_SIZE, fillColor: [1, 1, 1],
    position: [960, 140] } });
  return cmds;
}

function rigPlan(variant) {
  if (variant === "icons") return iconRigPlan();
  const cmds = [];
  cmds.push({ tool: "create_comp", args: { name: COMP, width: 1920,
    height: 1080, duration: 6, frameRate: 30 } });
  const names = [];
  for (let i = 0; i < RIG_SQUARES; i++) {
    const name = "Red Square " + (i + 1);
    names.push(name);
    cmds.push({ tool: "add_solid", args: { comp: COMP, name: name,
      color: [0.1, 0.2, 0.9], width: 200, height: 200 } });
    // A 3x3 grid placed by hand rather than by grid_layout: that tool
    // adds a "GRID CTRL" solid and rig EXPRESSIONS, and a rig is only
    // useful if it is the same every time and holds nothing the
    // sentences do not name.
    cmds.push({ tool: "set_transform", args: { comp: COMP, layer: name,
      property: "position",
      value: [700 + (i % 3) * 260, 280 + Math.floor(i / 3) * 260] } });
    // Linear fade-in, staggered four frames — what "too mechanical" and
    // "shouldn't fade in any more" are about. set_keyframes makes LINEAR
    // keys, which is exactly the un-eased state the ease step must change.
    const t0 = (i * 4) / 30;
    cmds.push({ tool: "set_keyframes", args: { comp: COMP, layer: name,
      property: "opacity",
      keys: [{ time: t0, value: 0 }, { time: t0 + 1, value: 100 }] } });
  }
  cmds.push({ tool: "add_text_layer", args: { comp: COMP, text: "HELLO",
    fontSize: 120, fillColor: [1, 1, 1], position: [960, 200] } });
  // The oval the "take a mask off again" step removes. Without it that
  // step can only report that there was nothing to prove.
  cmds.push({ tool: "add_mask", args: { comp: COMP, layer: "HELLO",
    shape: "ellipse", feather: 20 } });
  cmds.push({ tool: "add_null", args: { comp: COMP, name: "Rig" } });
  cmds.push({ tool: "set_layer_parent", args: { comp: COMP, layers: names,
    parent: "Rig" } });
  cmds.push({ tool: "set_transform", args: { comp: COMP, layer: "Rig",
    property: "rotation", value: 15 } });
  // Beta LAST, so it lands at index 1 — above HELLO, which is what
  // "Beta is covering HELLO, tuck it underneath" needs to be true.
  cmds.push({ tool: "add_solid", args: { comp: COMP, name: "Beta",
    color: [1, 0.5, 0], width: 100, height: 100 } });
  return cmds;
}

/* ExtendScript that builds the rig and hands back a per-command verdict.
 * Failures are NAMED (tool + error), never swallowed: a rig that half
 * built itself would fail the step for a reason that is not the model's,
 * which is the exact class of lie this whole pass is about. */
function rigScript(variant) {
  const cmds = rigPlan(variant);
  return "var out = AELL_callBatch(" +
    JSON.stringify(JSON.stringify(cmds)) + ");" +
    // AELL_callBatch answers {ok, data:{results:[...]}} — one envelope
    // around the per-command results, not the bare array.
    "var res = AELLJSON.parse(out);" +
    "var plan = " + JSON.stringify(cmds.map(c => c.tool)) + ";" +
    "if (!res || !res.ok) {" +
    "  return { built: 0, failed: ['callBatch: ' +" +
    "    ((res && res.error) || 'no answer')] };" +
    "}" +
    "var rows = (res.data && res.data.results) || [];" +
    "var bad = [];" +
    "for (var i = 0; i < plan.length; i++) {" +
    "  var r = rows[i];" +
    "  if (!r || !r.ok) {" +
    "    bad.push(plan[i] + ': ' + ((r && r.error) || 'no result'));" +
    "  }" +
    "}" +
    "return { built: plan.length, failed: bad };";
}

/* Everything a rig promised and did not deliver, in words — one list per
 * variant. Pure, so `--rig-check` can run it against the REAL comp and
 * tests/test-chat-probe.js can run it against a synthetic state with no
 * AE at all: a fixture that quietly stops being built is a step failing
 * every night for a reason that is not the model's. */
function rigProblems(variant, state) {
  const bad = [];
  const fail = m => bad.push(m);
  if (!state || !state.found) { fail("no comp called " + COMP); return bad; }
  if (state.width !== 1920 || state.height !== 1080 ||
      Math.abs(state.duration - 6) > 0.05 ||
      Math.abs(state.frameRate - 30) > 0.01) {
    fail("comp is " + state.width + "x" + state.height + ", " +
         state.duration + "s at " + state.frameRate);
  }
  if (variant === "icons") {
    const ic = iconLayers(state);
    if (ic.length !== RIG_ICONS) {
      fail(ic.length + " icon layers, wanted " + RIG_ICONS);
    }
    // The whole point of this rig is what it does NOT have. Every
    // assertion below is an absence, and each one is a step's fixture:
    // a scattered start (A1), un-driven scale (A2), no fade (B1), no
    // animator (C1), a small white headline (C2), no effect anywhere
    // (E1/E2).
    const xs = distinct(ic.map(l => l.position && l.position[0]), 4);
    const ys = distinct(ic.map(l => l.position && l.position[1]), 4);
    if (xs.length !== ic.length || ys.length !== ic.length) {
      fail("the icons already line up (" + xs.length + " distinct x, " +
           ys.length + " distinct y of " + ic.length +
           ") — the grid step would have nothing to prove");
    }
    const rigged = ic.filter(l =>
      l.expressions && Object.keys(l.expressions).length);
    if (rigged.length) {
      fail(rigged.length + " icon(s) already carry an expression: " +
           rigged.map(l => l.name).join(", "));
    }
    const keyed = ic.filter(l => l.opacityKeys);
    if (keyed.length) {
      fail(keyed.length + " icon(s) are already animated: " +
           keyed.map(l => l.name).join(", "));
    }
    const fx = state.layers.filter(l => l.effects);
    if (fx.length) {
      fail(fx.length + " layer(s) already carry an effect: " +
           fx.map(l => l.name).join(", "));
    }
    const bg = bgLayer(state);
    if (!bg) fail("no " + ICON_BG + " layer");
    else {
      if (bg.layerWidth !== state.width || bg.layerHeight !== state.height) {
        fail(ICON_BG + " is " + bg.layerWidth + "x" + bg.layerHeight +
             ", wanted the full frame");
      }
      // 'everything except the background' is only a real exception when
      // the background is at the BOTTOM of the stack, where a background
      // belongs — index 1 is the top in AE.
      const under = state.layers.filter(l => l.index > bg.index);
      if (under.length) {
        fail(ICON_BG + " is at index " + bg.index + ", above " +
             under.map(l => l.name).join(", ") +
             " — it must be the bottom layer");
      }
    }
    const h = headline(state);
    if (!h) fail("no " + ICON_TEXT + " layer");
    else {
      if (h.fontSize !== null && Math.abs(h.fontSize - ICON_FONT_SIZE) > 1) {
        fail(ICON_TEXT + " is " + h.fontSize + "px, wanted " +
             ICON_FONT_SIZE);
      }
      if (h.fillColor && !(h.fillColor[0] > 0.8 && h.fillColor[2] > 0.8)) {
        fail(ICON_TEXT + " is not white (" + h.fillColor.join(",") +
             ") — 'make it brand blue' needs somewhere to travel from");
      }
      if (h.textAnimators) {
        fail(ICON_TEXT + " already has " + h.textAnimators +
             " text animator(s)");
      }
    }
    if (state.layers.some(l => l.parent)) {
      fail("a layer is already parented");
    }
    return bad;
  }
  const sq = nineSquares(state);
  if (sq.length !== 9) fail(sq.length + " squares, wanted 9");
  const xs = distinct(sq.map(l => l.position && l.position[0]), 4);
  const ys = distinct(sq.map(l => l.position && l.position[1]), 4);
  if (xs.length !== 3 || ys.length !== 3) {
    fail("the squares are not a 3x3 grid (" + xs.length + "x" +
         ys.length + ")");
  }
  const keyed = sq.filter(l => l.opacityKeys >= 2);
  if (keyed.length !== sq.length) {
    fail(keyed.length + " of " + sq.length + " squares carry a fade");
  }
  if (sq.some(l => (l.opacityKeyEased || []).some(Boolean))) {
    fail("a square's fade is already eased — the ease step would have " +
         "nothing to prove");
  }
  if (state.layers.some(l => /CTRL/i.test(l.name))) {
    fail("a rig controller layer got into the comp");
  }
  const t = textLayer(state);
  if (!t) fail("no HELLO layer");
  else {
    if (t.masks !== 1) fail("HELLO has " + t.masks + " mask(s)");
    if (t.maskRound && t.maskRound[0] !== true) {
      fail("HELLO's mask is not an oval (round=" + t.maskRound[0] + ")");
    }
    if (t.maskFeather && Math.abs(t.maskFeather[0] - 20) > 0.5) {
      fail("HELLO's mask feather is " + t.maskFeather[0]);
    }
    if (t.fontSize !== null && Math.abs(t.fontSize - 120) > 1) {
      fail("HELLO is " + t.fontSize + "px, wanted 120");
    }
    if (t.anchorPoint && t.anchorPoint[0] === undefined) {
      fail("HELLO has no readable anchor point");
    }
  }
  const rigN = rigNull(state);
  if (!rigN) fail("no Rig null");
  else {
    if (Math.abs((rigN.rotation || 0) - 15) > 0.5) {
      fail("the Rig null is rotated " + rigN.rotation);
    }
    const kids = state.layers.filter(l => l.parent === rigN.name);
    if (kids.length !== 9) {
      fail(kids.length + " layers are parented to the Rig null");
    }
  }
  const b = betaLayer(state);
  if (!b) fail("no Beta layer");
  else {
    if (b.layerWidth !== 100 || b.layerHeight !== 100) {
      fail("Beta is " + b.layerWidth + "x" + b.layerHeight);
    }
    if (b.effects) fail("Beta already carries an effect");
    if (b.masks) fail("Beta already carries a mask");
    if (t && !(b.index < t.index)) {
      fail("Beta is at index " + b.index + " and HELLO at " + t.index +
           " — Beta must start ABOVE the text");
    }
  }
  return bad;
}

/* One compact string that changes whenever anything the user would SEE in
 * the probe comp changes. Used to answer "did one Ctrl+Z put it back?" —
 * comparing the whole READ_COMP JSON would work too, but this runs inside
 * AE between undos, where a short string is cheap to build and to diff. */
const SIG_FN =
  "function sig() {" +
  FIND_COMP +
  "  if (!c) return 'no comp';" +
  "  var s = [c.name, c.numLayers, c.width, c.height, c.duration," +
  "    c.frameRate].join('/');" +
  "  for (var j = 1; j <= c.numLayers; j++) {" +
  "    var L = c.layer(j), t = j + ':' + L.name;" +
  "    try { t += '|p' + L.property('ADBE Transform Group')" +
  "      .property('ADBE Position').value.join(',');" +
  "      t += '|s' + L.property('ADBE Transform Group')" +
  "      .property('ADBE Scale').value.join(',');" +
  "      t += '|r' + L.property('ADBE Transform Group')" +
  "      .property('ADBE Rotate Z').value;" +
  "      t += '|k' + L.property('ADBE Transform Group')" +
  "      .property('ADBE Opacity').numKeys;" +
  "    } catch (a) {}" +
  "    try { t += '|e' + L.property('ADBE Effect Parade').numProperties;" +
  "    } catch (b) {}" +
  "    try { t += '|m' + L.property('ADBE Mask Parade').numProperties;" +
  "    } catch (d) {}" +
  "    try { t += '|f' + L.parent.name; } catch (e) { t += '|f-'; }" +
  "    try { t += '|t' + L.trackMatteType; } catch (f) {}" +
  "    try { t += '|i' + L.inPoint + ',' + L.outPoint + ',' + L.startTime;" +
  "    } catch (g) {}" +
  "    try { if (L instanceof TextLayer) t += '|x' +" +
  "      L.property('Source Text').value.text; } catch (h) {}" +
  "    try { if (L.source && L.source.mainSource &&" +
  "      (L.source.mainSource instanceof SolidSource)) {" +
  "      t += '|c' + L.source.mainSource.color.join(','); } } catch (k) {}" +
  "    s += '\\n' + t;" +
  "  }" +
  "  return s;" +
  "}";

/*
 * "One chat command should be one Ctrl+Z" — measured end to end, through
 * the model, rather than by calling a tool directly (which the self-test
 * already does). Undo is pressed one step at a time and the comp compared
 * to how it looked before the sentence was typed.
 *
 * `cap` is NEVER a fixed 8: the probe runs against the user's live open
 * project, so it must not be able to undo past its OWN work and start
 * eating their edits. main() passes the number of tool runs the probe has
 * made since it started.
 */
function undoProbe(beforeSig, cap) {
  return SIG_FN +
    "var before = " + JSON.stringify(beforeSig) + ";" +
    "var cap = " + Math.max(0, cap | 0) + ";" +
    "var now = sig();" +
    "if (now === before) return { changed: false, undos: 0, cap: cap };" +
    "var hit = -1, tried = 0, k;" +
    "for (k = 1; k <= cap; k++) {" +
    "  app.executeCommand(16);" +  // 16 = Edit > Undo
    "  tried++;" +
    "  now = sig();" +
    "  if (now === before) { hit = k; break; }" +
    "}" +
    "return { changed: true, undos: hit, tried: tried, cap: cap," +
    "  sample: String(now).slice(0, 400)," +
    "  beforeSample: String(before).slice(0, 400) };";
}

/* The nine squares — NOT grid_layout's "GRID CTRL" rig layer, which is a
 * solid too and parks itself in the middle of the comp (it showed up as a
 * tenth x value sitting exactly on a real one). */
function squares(state) {
  return state.layers.filter(l =>
    l.isSolid && !l.isNull && !/CTRL|^Rig\b/i.test(l.name));
}
/* Windows paths from two sources: AE hands back `fsName` (backslashes,
 * whatever case the user typed the folder in) and ComfyUI's downloader
 * hands back what Node built. Compare them as the same file. */
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = p => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/* A file the generator claims it wrote, believed only when it is on disk
 * with pixels in it. `size` guards the case that actually happened once:
 * SaveVideo wrote a zero-byte file when its filename token failed. */
function realFile(p) {
  try { return fs.statSync(p).size > 1024; } catch (e) { return false; }
}

function distinct(values, tol) {
  const out = [];
  for (const v of values) {
    if (!out.some(o => Math.abs(o - v) <= (tol || 1))) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/* The layers the trigger-layer steps (14 onward) name. Beta and Rig are
 * the model's own creations from earlier turns and carry the names those
 * sentences asked for; HELLO is the one text layer. Beta is a solid too,
 * so the nine squares are squares() MINUS Beta from step 11 on. */
function textLayer(state) {
  const t = state.layers.filter(l => l.isText);
  return t.filter(l => /HELLO/i.test(l.text || ""))[0] || t[0] || null;
}
function betaLayer(state) {
  return state.layers.filter(l => /^Beta/i.test(l.name))[0] || null;
}
function rigNull(state) {
  const n = state.layers.filter(l => l.isNull && !/CTRL/i.test(l.name));
  return n.filter(l => /rig/i.test(l.name))[0] || n[0] || null;
}
function nineSquares(state) {
  return squares(state).filter(l => !/^Beta/i.test(l.name));
}
/* The icon rig's layers, by NAME rather than by kind: grid_layout adds a
 * 'GRID CTRL' solid and add_control usually a null, so "every solid that
 * is not the background" would grow the roster mid-verdict and score the
 * model's own controller as an icon it failed to move. */
function iconLayers(state) {
  return state.layers.filter(l => /^Icon \d+$/i.test(l.name));
}
function bgLayer(state) {
  return state.layers.filter(l => l.name === ICON_BG)[0] || null;
}
function headline(state) {
  const t = state.layers.filter(l => l.isText);
  return t.filter(l => /HEADLINE/i.test(l.name || ""))[0] || t[0] || null;
}
/* An effect roster read by NAME. AE's display names vary by locale and
 * by which blur the model reached for ('Gaussian Blur', 'Fast Box Blur',
 * 'Camera Lens Blur'), so the verdicts match a word, not a match name. */
function hasEffect(layer, re) {
  return (layer && (layer.effectNames || []).some(n => re.test(n))) || false;
}
function calls(ctx, name) {
  return (ctx.tools || []).filter(t => t.tool === name);
}
function ranInstead(ctx) {
  const tried = (ctx.tools || []).map(t => t.tool);
  return tried.length ? " — it ran " + tried.join(", ") + " instead"
                      : " and ran no tools at all";
}
/* Measured in AE 2026, and the constant this used to carry was wrong in
 * BOTH directions: TrackMatteType is NO_TRACK_MATTE 5012, ALPHA 5013,
 * ALPHA_INVERTED 5014, LUMA 5015, LUMA_INVERTED 5016, and an unmatted
 * layer reads 5012 — not 0. `m !== 5013` therefore called every UNMATTED
 * layer matted (a false pass) and every alpha-matted one bare (a false
 * fail). And even the corrected type is not an existence test:
 * removeTrackMatte() clears trackMatteLayer but LEAVES trackMatteType at
 * the type it removed. The matte LAYER is the only honest read. */
function hasMatte(row) {
  if (!row) return false;
  if (row.matteLayerKnown) return !!row.matteLayer;
  // Legacy AE (< 23) has no trackMatteLayer to read — and there the type
  // IS an existence test, because that AE has no removeTrackMatte to
  // leave it stale behind a matte that is gone.
  return row.matte >= 5013 && row.matte <= 5016;
}

/* ------------------------------------------------ the paraphrase matrix
 *
 * What separates a harmless miss from a harmful one is whether anything
 * in the comp MOVED. The run already holds the comp as it was before the
 * sentence and as it is after (both full READ_COMP reads), so the answer
 * costs no extra trip to AE — and unlike SIG_FN, READ_COMP can see the
 * changes that leave the layer list alone: an expression, an eased key, a
 * recoloured fill, a mask's shape.
 *
 * A WHITELIST of fields, not a deep compare: sourceRect drifts with a
 * font substitution and opacityKeyTimes with a rounding, and a phantom
 * diff would report harm that never happened. Everything here is
 * something a tool had to do on purpose.
 */
const DIFF_NUM = {
  rotation: 0.01, opacity: 0.01, inPoint: 0.001, startTime: 0.001,
  fontSize: 0.01
};
const DIFF_PLAIN = ["parent", "masks", "effects", "opacityKeys", "text",
                    "matteLayer", "isPrecomp", "textAnimators", "index",
                    "matte"];
const DIFF_VEC = ["position", "scale", "anchorPoint", "solidColor",
                  "fillColor"];
const DIFF_LIST = ["effectNames", "maskModes", "maskInverted", "maskRound",
                   "maskFeather", "maskBoxes", "opacityKeyEased"];

function sameVec(a, b, tol) {
  if (!(a instanceof Array) || !(b instanceof Array)) return a === b;
  if (a.length !== b.length) return false;
  return a.every((v, i) => typeof v === "number" && typeof b[i] === "number"
    ? Math.abs(v - b[i]) <= (tol || 0.01) : v === b[i]);
}
function short(v) {
  if (v === null || v === undefined) return "none";
  if (v instanceof Array) return "[" + v.map(x =>
    typeof x === "number" ? Math.round(x * 100) / 100 : x).join(",") + "]";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 80);
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  return String(v);
}

/**
 * Every difference between two READ_COMP states, in words. Empty array
 * means the sentence left the comp exactly as it found it.
 *
 * Layers are matched by NAME, so a rename reads as one layer gone and
 * another arrived — which is what it is, for a user looking at the
 * timeline.
 */
function compDiff(before, after) {
  const out = [];
  if (!before || !after) return out;
  if (!before.found || !after.found) {
    if (before.found !== after.found) {
      out.push(after.found ? "the comp was created" : "THE COMP IS GONE");
    }
    return out;
  }
  for (const f of ["width", "height", "duration", "frameRate"]) {
    if (Math.abs((before[f] || 0) - (after[f] || 0)) > 0.001) {
      out.push("comp " + f + " " + short(before[f]) + " -> " + short(after[f]));
    }
  }
  const wasL = before.layers || [], nowL = after.layers || [];
  const byName = list => {
    const m = {};
    for (const l of list) m[l.name] = m[l.name] || l;
    return m;
  };
  const w = byName(wasL), n = byName(nowL);
  for (const name of Object.keys(n)) {
    if (!w[name]) out.push("layer added: " + name);
  }
  for (const name of Object.keys(w)) {
    if (!n[name]) out.push("layer removed: " + name);
  }
  for (const name of Object.keys(w)) {
    if (!n[name]) continue;
    const a = w[name], b = n[name];
    const note = m => out.push(name + ": " + m);
    for (const f of DIFF_PLAIN) {
      if (a[f] !== b[f]) note(f + " " + short(a[f]) + " -> " + short(b[f]));
    }
    for (const f of Object.keys(DIFF_NUM)) {
      const x = a[f], y = b[f];
      if (typeof x === "number" && typeof y === "number") {
        if (Math.abs(x - y) > DIFF_NUM[f]) {
          note(f + " " + short(x) + " -> " + short(y));
        }
      } else if (x !== y) {
        note(f + " " + short(x) + " -> " + short(y));
      }
    }
    for (const f of DIFF_VEC) {
      if (!sameVec(a[f], b[f], f === "solidColor" || f === "fillColor"
        ? 0.004 : 0.01)) {
        note(f + " " + short(a[f]) + " -> " + short(b[f]));
      }
    }
    for (const f of DIFF_LIST) {
      if (JSON.stringify(a[f] || []) !== JSON.stringify(b[f] || [])) {
        note(f + " " + short(a[f] || []) + " -> " + short(b[f] || []));
      }
    }
    const ax = a.expressions || {}, bx = b.expressions || {};
    for (const k of Object.keys(bx)) {
      if (ax[k] !== bx[k]) {
        note((ax[k] ? "expression on " + k + " changed" : "expression added " +
              "to " + k) + ": " + String(bx[k]).slice(0, 60));
      }
    }
    for (const k of Object.keys(ax)) {
      if (!(k in bx)) note("expression removed from " + k);
    }
  }
  return out;
}

/**
 * The three-way verdict a paraphrase gets. See the header for why "did
 * anything change" is the line between a miss and harm.
 *
 * `changes` is compDiff's output. A rolled-back round leaves the comp
 * untouched and therefore lands in `miss` by construction, which is
 * right: nothing was applied, so nothing can have been applied wrongly.
 */
function gradeRun(verdict, changes) {
  if (!verdict) return "pass";
  return (changes && changes.length) ? "harm" : "miss";
}

/**
 * The runs one --steps selection expands to. Without --variants that is
 * one run per step, unchanged; with it, the canonical sentence followed
 * by every paraphrase the step declares.
 *
 * A `carry` step is never given variants and never takes them: its
 * sentence is a pronoun, and rephrasing it without rephrasing the turn it
 * points at measures nothing.
 */
function variantRuns(indexes, withVariants) {
  const runs = [];
  for (const idx of indexes) {
    const step = STEPS[idx];
    runs.push({ index: idx, step: step, say: step.say, phrasing: "canonical" });
    if (!withVariants || step.carry) continue;
    for (const v of step.variants || []) {
      runs.push({ index: idx, step: step, say: v.say, phrasing: v.kind });
    }
  }
  return runs;
}

/**
 * The acceptance gate, as the workplan states it: no run may do harm, no
 * canonical may fail, and a step whose canonical passes may miss on at
 * most ONE of its paraphrases. Two misses out of three phrasings is not
 * a fluke — it is a tool that needs magic words.
 */
function gradeMatrix(rows) {
  const byStep = {};
  for (const r of rows) {
    const k = String(r.index);
    byStep[k] = byStep[k] || { title: r.title, canonical: null, variants: [] };
    if (r.phrasing === "canonical") byStep[k].canonical = r;
    else byStep[k].variants.push(r);
  }
  const problems = [];
  for (const r of rows) {
    if (r.grade === "harm") {
      problems.push("HARM — " + r.title + " [" + r.phrasing + "] \"" +
                    r.say + "\": " + r.verdict);
    }
  }
  for (const k of Object.keys(byStep)) {
    const g = byStep[k];
    if (g.canonical && g.canonical.grade !== "pass") {
      problems.push("the CANONICAL sentence failed for " + g.title +
                    ": " + g.canonical.verdict);
    }
    if (!g.canonical || g.canonical.grade !== "pass") continue;
    const missed = g.variants.filter(v => v.grade !== "pass");
    if (missed.length > 1) {
      problems.push(missed.length + " of " + g.variants.length +
                    " paraphrases missed where the canonical passed — " +
                    g.title + " needs magic words (" +
                    missed.map(v => v.phrasing).join(", ") + ")");
    }
  }
  return problems;
}

const STEPS = [
  {
    title: "create a comp",
    expects: ["create_comp"],
    say: "Make a new comp called Probe Room, 1920x1080, 6 seconds long " +
         "at 30 fps.",
    check(state) {
      if (!state.found) return "no comp called " + COMP + " exists";
      if (state.width !== 1920 || state.height !== 1080) {
        return "comp is " + state.width + "x" + state.height;
      }
      if (Math.abs(state.duration - 6) > 0.05) {
        return "duration is " + state.duration + "s, wanted 6";
      }
      if (Math.abs(state.frameRate - 30) > 0.01) {
        return "frame rate is " + state.frameRate + ", wanted 30";
      }
      return null;
    }
  },
  {
    title: "grid layout",
    expects: ["add_solid", "grid_layout"],
    say: "In Probe Room, add nine red 200x200 square solids and arrange " +
         "them in a 3 by 3 grid in the middle of the comp.",
    check(state) {
      const sq = squares(state);
      if (sq.length < 9) return "only " + sq.length + " solids in the comp";
      const xs = distinct(sq.map(l => l.position && l.position[0]), 4);
      const ys = distinct(sq.map(l => l.position && l.position[1]), 4);
      if (xs.length !== 3 || ys.length !== 3) {
        return "positions are not a 3x3 grid (" + xs.length + " columns, " +
               ys.length + " rows): " +
               JSON.stringify(sq.map(l => l.position));
      }
      return null;
    }
  },
  {
    title: "batch animation with a stagger",
    expects: ["set_keyframes", "stagger_layers"],
    say: "Fade all nine squares in from 0 to 100 opacity over the first " +
         "second, and stagger them 4 frames apart.",
    check(state) {
      const sq = squares(state);
      const animated = sq.filter(l => l.opacityKeys >= 2);
      if (animated.length < 9) {
        return "only " + animated.length + " of " + sq.length +
               " squares have opacity keyframes";
      }
      // "4 frames apart" is a GAP, and the whole point of the step is
      // whether that survives the trip through the model. It used to
      // arrive as stagger_layers {spread: 0.133} — the TOTAL — which is
      // half a frame per layer, and the old check (are the starts merely
      // distinct?) called that a pass.
      const fd = 1 / (state.frameRate || 30);
      const want = 4 * fd;
      function gapsOf(times) {
        const t = times.slice().sort((a, b) => a - b);
        const g = [];
        for (let i = 1; i < t.length; i++) g.push(t[i] - t[i - 1]);
        return g;
      }
      const byStart = gapsOf(sq.map(l => l.startTime));
      const byKey = gapsOf(animated.map(l => l.opacityKeyTimes[0]));
      const even = g => g.length >= 8 &&
        g.every(v => Math.abs(v - want) <= fd * 0.75);
      if (!even(byStart) && !even(byKey)) {
        const fr = g => g.map(v => (v / fd).toFixed(2) + "f").join(", ");
        if (distinct(sq.map(l => l.startTime), 0.005).length < 2 &&
            distinct(animated.map(l => l.opacityKeyTimes[0]),
                     0.005).length < 2) {
          return "nothing was staggered at all";
        }
        return "gaps are not 4 frames — layer starts [" + fr(byStart) +
               "], first opacity keys [" + fr(byKey) + "]";
      }
      return null;
    }
  },
  {
    // The sentence asks for four things and the check used to read one
    // of them (does SOME text layer say HELLO). A 12px black HELLO at
    // the bottom of the frame scored a pass — wrong-but-present, the
    // failure class the 2026-08-30 audit named in steps 4, 5 and 6.
    title: "text layer",
    expects: ["add_text_layer"],
    say: "Add a text layer to Probe Room that says HELLO, white, 120 " +
         "pixels, near the top of the frame.",
    check(state, ctx) {
      const all = state.layers.filter(l => l.isText);
      if (!all.length) return "no text layer in the comp";
      const t = all.filter(l => /HELLO/i.test(l.text || ""))[0];
      if (!t) {
        return "text layers say " + JSON.stringify(all.map(l => l.text));
      }
      const was = ctx && ctx.before
        ? ctx.before.layers.filter(l => l.isText).length : null;
      if (was !== null && all.length > was + 1) {
        return (all.length - was) + " text layers were added for one " +
               "sentence: " + JSON.stringify(all.map(l => l.name));
      }
      // 120 pixels. Read in its own right rather than inferred from the
      // rendered rect, which a long word or a tracking change also moves.
      if (typeof t.fontSize === "number" && Math.abs(t.fontSize - 120) > 6) {
        return "HELLO is " + t.fontSize + "px, wanted 120";
      }
      // White. AE's default text fill is BLACK, so a model that never
      // passed a colour through leaves [0,0,0] — the exact miss a
      // "there is a text layer" check cannot see.
      const c = t.fillColor;
      if (c && !(c[0] > 0.85 && c[1] > 0.85 && c[2] > 0.85)) {
        return "HELLO's fill is [" + c.map(v => v.toFixed(2)).join(", ") +
               "], wanted white" +
               (c[0] < 0.15 && c[1] < 0.15 && c[2] < 0.15
                 ? " — that is AE's default black, so no colour was set"
                 : "");
      }
      // Near the top: above the middle of the frame. Deliberately loose
      // about HOW near — "near the top" is not a number — and strict
      // about the half it is in, which is the half the sentence means.
      const y = t.position && t.position[1];
      if (typeof y === "number" && y > state.height / 2) {
        return "HELLO sits at y " + Math.round(y) + " in a " +
               state.height + "px comp — that is the bottom half, not " +
               "near the top";
      }
      return null;
    }
  },
  {
    title: "mask",
    expects: ["add_mask"],
    say: "Put an oval mask on the HELLO layer and feather it 20 pixels.",
    check(state, ctx) {
      const t = textLayer(state);
      if (!t) return "the HELLO layer is gone";
      const was = ctx && ctx.before ? textLayer(ctx.before) : null;
      const had = was ? was.masks : 0;
      if (t.masks <= had) {
        // A mask on the WRONG layer is the wrong-but-present case: the
        // comp gained a mask, and nothing the sentence named did.
        const elsewhere = state.layers.filter(l =>
          !l.isText && l.masks > 0 &&
          (!ctx || !ctx.before ||
           l.masks > ((ctx.before.layers.filter(x => x.name === l.name)[0]
             || {}).masks || 0)));
        return "HELLO has " + t.masks + " mask(s)" +
               (had ? ", the same as before the sentence" : "") +
               (elsewhere.length
                 ? " — the mask landed on " +
                   elsewhere.map(l => l.name).join(", ") + " instead"
                 : "");
      }
      const made = t.masks - had;
      if (made > 1) return made + " masks were added for one oval";
      const round = (t.maskRound || [])[t.masks - 1];
      // An ellipse mask and a rectangle mask have the same bounding box;
      // only the bezier tangents tell them apart (see READ_COMP). null
      // means the shape could not be read, which is not a failure of the
      // model — say so rather than scoring it either way.
      if (round === false) {
        return "the new mask on HELLO is a rectangle, not an oval";
      }
      const f = (t.maskFeather || [])[t.masks - 1];
      if (typeof f === "number" && Math.abs(f - 20) > 1) {
        return "the mask's feather is " + f + "px, wanted 20" +
               (f === 0 ? " — it was never feathered at all" : "");
      }
      return null;
    }
  },
  {
    title: "track matte",
    expects: ["add_shape_layer", "set_track_matte"],
    say: "Add a white ellipse shape layer above the top square and use it " +
         "as an alpha track matte for that square.",
    check(state, ctx) {
      // The premise first, the way the later steps report a fixture that
      // never landed. Measured 2026-09-02: when the grid step's round
      // rolled back, the comp held no squares, the model matted HELLO
      // instead — and blaming it for that reads as a routing failure it
      // did not commit.
      if (!nineSquares(state).length) {
        return "there are no squares in " + COMP + " (the grid step must " +
               "have failed), so there was nothing to matte";
      }
      const shapes = state.layers.filter(l => l.isShape);
      if (!shapes.length) return "no shape layer was created";
      const wasShapes = ctx && ctx.before
        ? ctx.before.layers.filter(l => l.isShape).length : null;
      if (wasShapes !== null && shapes.length <= wasShapes) {
        return "there were already " + wasShapes + " shape layer(s) and " +
               "no new one was added";
      }
      const matted = state.layers.filter(hasMatte);
      if (!matted.length) return "no layer has a track matte set";
      // The half that was never checked: WHICH layer is matted, and BY
      // what. "A shape layer exists" and "something somewhere has a
      // matte" both passed while the shape matted nothing.
      const square = matted.filter(l => nineSquares(state)
        .some(s => s.name === l.name))[0];
      if (!square) {
        return "the matte is on " + matted.map(l => l.name).join(", ") +
               " — the sentence mattes a SQUARE";
      }
      if (square.matteLayerKnown &&
          !shapes.some(s => s.name === square.matteLayer)) {
        return square.name + " is matted by " +
               (square.matteLayer || "nothing readable") +
               ", not by the new shape layer (" +
               shapes.map(s => s.name).join(", ") + ")";
      }
      // ALPHA is 5013; 5014 is ALPHA INVERTED, which hides exactly the
      // part the sentence asks to keep.
      if (typeof square.matte === "number" && square.matte >= 5012 &&
          square.matte !== 5013) {
        const word = { 5014: "alpha inverted", 5015: "luma",
                       5016: "luma inverted" }[square.matte] ||
                     String(square.matte);
        return square.name + "'s matte is " + word + ", not alpha";
      }
      return null;
    }
  },
  {
    title: "equidistant distribution",
    expects: ["distribute_property"],
    say: "Spread the nine squares out equally across the width of the " +
         "comp, from x 200 to x 1720.",
    check(state) {
      const sq = squares(state)
        .filter(l => l.position && typeof l.position[0] === "number")
        .sort((a, b) => a.position[0] - b.position[0]);
      const xs = sq.map(l => l.position[0]);
      if (xs.length < 9) return "only " + xs.length + " squares to space";
      const gaps = [];
      for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
      const min = Math.min.apply(null, gaps);
      const max = Math.max.apply(null, gaps);
      if (max - min > 2) {
        // Name the layers, not just the numbers: the first time this
        // failed on a spread that was actually correct, the odd value out
        // was a STRAY tenth square the model left behind when its first
        // round errored — invisible in a list of bare x values.
        return "gaps are uneven (" + min.toFixed(1) + " to " +
               max.toFixed(1) + "px): " +
               sq.map(l => l.name + "@" + Math.round(l.position[0]))
                 .join(", ");
      }
      return null;
    }
  },
  {
    title: "parenting",
    expects: ["add_null", "set_layer_parent"],
    say: "Add a null called Rig, parent all nine squares to it, and " +
         "rotate the null 15 degrees.",
    check(state) {
      const rig = state.layers.filter(l => l.isNull);
      if (!rig.length) return "no null layer in the comp";
      const named = rig.find(l => /rig/i.test(l.name)) || rig[0];
      const kids = state.layers.filter(l => l.parent === named.name);
      if (kids.length < 9) {
        return "only " + kids.length + " layers are parented to " +
               named.name;
      }
      if (Math.abs((named.rotation || 0) - 15) > 0.5) {
        return "the null's rotation is " + named.rotation + ", wanted 15";
      }
      return null;
    }
  },
  {
    // The one thing a chat panel does that a tool suite cannot: the
    // sentence is meaningless on its own. "them" is only the nine squares
    // because of the PREVIOUS turn (the only plural in it — "the null" is
    // singular), and "instead" only means anything if the model knows
    // they are currently red. Nothing here names a layer.
    title: "a second turn that refers back",
    expects: ["set_solid_color"],
    // The ONE step that must keep the previous turn's history — the
    // whole point of it is the pronoun. Every other step names what it
    // is talking about, so every other step starts a fresh conversation.
    carry: true,
    say: "Make them blue instead.",
    check(state, ctx) {
      const sq = squares(state);
      const was = ctx.before ? squares(ctx.before) : [];
      if (was.length && sq.length !== was.length) {
        return "there were " + was.length + " squares before the sentence " +
               "and " + sq.length + " after — recolouring should not add " +
               "or remove layers";
      }
      if (sq.length < 9) return "only " + sq.length + " squares in the comp";
      const blue = c => c && c.length >= 3 &&
        c[2] > 0.35 && c[2] > c[0] + 0.15 && c[2] > c[1] + 0.15;
      const isBlue = l => blue(l.solidColor) ||
        (l.effectColors || []).some(blue);
      const done = sq.filter(isBlue);
      if (done.length < sq.length) {
        const stuck = sq.filter(l => !isBlue(l))
          .map(l => l.name + "=" + (l.solidColor
            ? l.solidColor.map(v => v.toFixed(2)).join("/") : "?") +
            (l.effectNames.length ? " fx[" + l.effectNames.join(",") + "]"
              : ""))
          .slice(0, 4).join(", ");
        return done.length + " of " + sq.length + " squares are blue; " +
               "still not blue: " + stuck;
      }
      // Blue, but at what cost: a recolour that quietly threw away the
      // parenting from the previous turn is not what the user asked for.
      const lost = was.filter(b => b.parent &&
        !state.layers.some(a => a.name === b.name && a.parent === b.parent));
      if (lost.length) {
        return "they are blue but " + lost.length + " square(s) lost the " +
               "parent they had before (" + lost[0].name + " was parented " +
               "to " + lost[0].parent + ")";
      }
      return null;
    }
  },
  {
    // One typed sentence, several tools, ONE Ctrl+Z. The self-test proves
    // the host groups a batch; only this proves it survives the whole
    // product path, where a model may answer in more than one round and
    // each round is its own AE script execution — which the user pays for
    // one Ctrl+Z at a time.
    title: "one Ctrl+Z for one chat command",
    expects: ["add_solid", "set_keyframes"],
    say: "Add a white 120 by 120 solid called Dot in the middle of Probe " +
         "Room, put a drop shadow on it, and fade it in over the first " +
         "half second.",
    undo: true,
    check(state, ctx) {
      const u = ctx.undo;
      if (!u) return "the undo measurement did not run";
      if (u.error) return "could not measure undo: " + u.error;
      if (!u.changed) return "the command changed nothing, so there was " +
                             "nothing to undo";
      if (u.undos < 0) {
        return "the comp never got back to how it started — " + u.tried +
               " undo(s) of a possible " + u.cap + " and it still differs";
      }
      if (u.undos > ctx.toolRounds) {
        return "one sentence cost " + u.undos + " Ctrl+Z but only ran " +
               ctx.toolRounds + " tool round(s) — a run leaked its " +
               "undo group";
      }
      return null;
    }
  },
  {
    // The MODEL's half of the round rollback, which nothing else can
    // reach: the host is only armed when the caller asks, and the panel
    // only tells the model "ROLLED BACK" in a result it has to act on.
    //
    // The sentence is built to fail PART WAY on purpose. "Beta" can be
    // made; the drop shadow names a layer that does not exist, so that
    // command fails — one mutating success, one mutating failure, which
    // is exactly the trigger. The round is undone whole, Beta included.
    //
    // What is under test is what the model does NEXT. Getting this wrong
    // has two distinct failure modes and the verdict separates them:
    //   - it carries on as if Beta existed, or redoes the round on top of
    //     debris -> more than one Beta (the ten-squares bug);
    //   - it treats the rollback as "the request failed" and stops ->
    //     NO Beta at all, and the user is left with nothing when the
    //     achievable half was achievable.
    title: "the model re-plans after a round is rolled back",
    expects: ["add_solid"],
    say: "Add a 100 by 100 orange solid called Beta to Probe Room, and " +
         "put a drop shadow on the layer called Ghost.",
    check(state, ctx) {
      const betas = state.layers.filter(l => /^Beta/i.test(l.name));
      if (betas.length > 1) {
        return "the comp ended with " + betas.length + " layers called " +
               "Beta (" + betas.map(l => l.name).join(", ") + ") — the " +
               "model built on top of a round that had been undone";
      }
      if (betas.length === 0) {
        return "no Beta at all" + (ctx.rolledBack
          ? " — the round was rolled back and the model never redid the " +
            "half that WAS achievable, so the user got nothing"
          : " — the model never made the solid it was asked for");
      }
      // A Ghost conjured just to make the shadow stick is not an answer.
      if (state.layers.some(l => /^Ghost/i.test(l.name))) {
        return "the model invented a layer called Ghost rather than " +
               "reporting that it does not exist";
      }
      return null;
    }
  },
  {
    // The cheap half of the ComfyUI gap: is the backend REACHABLE through
    // the product path, and does the model ask instead of guessing? This
    // costs one round and no GPU, so when the generation step below fails
    // there is already an answer to "was it even plugged in".
    //
    // The failure this pins is not hypothetical: nothing loaded comfy.js
    // into the probe until now, so every comfy_* tool would have thrown
    // inside the dispatcher rather than answering.
    title: "the image generator answers when asked",
    expects: ["comfy_status", "comfy_list_workflows"],
    say: "Is the picture generator ready to go, and what can it make?",
    check(state, ctx) {
      const calls = (ctx.tools || []).filter(t => /^comfy_/.test(t.tool));
      if (!calls.length) {
        return "the model answered about ComfyUI without calling " +
               "comfy_status or comfy_list_workflows — it " +
               (ctx.tools && ctx.tools.length
                 ? "ran " + ctx.tools.map(t => t.tool).join(", ") + " instead"
                 : "ran no tools at all");
      }
      const broke = calls.filter(t => !t.ok);
      if (broke.length === calls.length) {
        return "every ComfyUI call failed — " + broke[0].tool + ": " +
               broke[0].error;
      }
      const st = calls.filter(t => t.tool === "comfy_status" && t.ok)[0];
      if (st && st.data && st.data.online === false) {
        return "ComfyUI is not answering at " + st.data.url + " (" +
               (st.data.hint || "no hint") + ")";
      }
      const wf = calls.filter(t => t.tool === "comfy_list_workflows" &&
                                   t.ok)[0];
      if (wf && wf.data && (wf.data.workflows || []).length === 0) {
        return "the workflow list came back empty";
      }
      // The tool doc promises the backend boots itself. A reply that
      // sends the user to launch it by hand is the product breaking that
      // promise, whatever the tools returned.
      // Narrow on purpose: "ComfyUI is running" must not read as an
      // instruction to run it, and saying the user does NOT have to start
      // it is the promise being KEPT, not broken.
      const said = (ctx.replies || []).join(" ");
      const tells = /\b(?:start|launch|open)\b[^.]{0,30}\bcomfy/i;
      const excused = new RegExp(
        "\\b(?:no need to|don'?t (?:need|have) to|do not (?:need|have) to|" +
        "never (?:need|have) to|without(?: having to)?)\\s+" +
        "(?:start|launch|open)\\b", "i");
      if (tells.test(said) && !excused.test(said)) {
        return "the reply tells the user to start ComfyUI by hand: \"" +
               said.slice(0, 160) + "\"";
      }
      return null;
    }
  },
  {
    // The expensive half, and the only thing in the project that runs a
    // real generation THROUGH THE MODEL: prompt -> workflow choice ->
    // ComfyUI -> file on disk -> AE. comfy-probe.js drives the same
    // backend directly; what it cannot say is whether a sentence a user
    // would type ever reaches it.
    //
    // Deliberately phrased the way a user asks, comp included, even
    // though no tool can place footage into a comp today (import_file
    // takes a path and nothing else). The verdict holds the product to
    // what it HAS — generated, on disk, in the project — and the comp
    // half is reported as a gap rather than failed every night, because
    // it is workplan 5.8 and unbuilt, not broken.
    title: "generate a picture and bring it in",
    expects: ["comfy_generate"],
    say: "Make me a picture of a single red apple on a white plate and " +
         "put it in Probe Room.",
    check(state, ctx) {
      const gen = (ctx.tools || []).filter(t => t.tool === "comfy_generate");
      if (!gen.length) {
        const tried = (ctx.tools || []).map(t => t.tool);
        return "the model never called comfy_generate" +
               (tried.length ? " — it ran " + tried.join(", ") + " instead"
                             : " and ran no tools at all");
      }
      const ok = gen.filter(t => t.ok);
      if (!ok.length) {
        return "comfy_generate failed " + gen.length + " time(s), last " +
               "error: " + gen[gen.length - 1].error;
      }
      // WHICH template ran, not just that one did. §18 P1 made the
      // nameless default kind-aware; before it, `list[0]` meant a
      // picture request was handed to whichever graph sorted first —
      // with the shipped bundle, a 40 GB Blackwell-only VIDEO template.
      // The choice happens BEFORE any tool runs, so no stub and no
      // real-AE harness can see it; only a real sentence through the
      // real model can. A render that succeeds on the wrong kind is
      // still a routing failure.
      const ranKinds = ok.map(t => {
        const wf = (t.args && t.args.workflow) || (t.data && t.data.workflow);
        if (!wf) return null;
        try {
          const mf = Comfy.readManifest(
            require("path").join(S.comfyWorkflowsDir, wf + ".json"));
          return mf && mf.kind ? mf.kind : null;
        } catch (eK) { return null; }
      }).filter(Boolean);
      if (ranKinds.length && ranKinds.indexOf("image") === -1) {
        return "a PICTURE was asked for and the template that ran is " +
               "kind '" + ranKinds.join("/") + "' — the nameless default " +
               "picked the wrong kind";
      }
      const files = [];
      for (const t of ok) {
        for (const f of (t.data && t.data.files) || []) files.push(f);
      }
      if (!files.length) {
        return "comfy_generate reported success but named no output file";
      }
      const good = files.filter(realFile);
      if (!good.length) {
        return "the generator claimed " + files.length + " output file(s) " +
               "and none of them is a real file on disk: " +
               files.slice(0, 2).join(", ");
      }
      const footage = state.footage || [];
      const inProject = footage.filter(f => good.some(g => samePath(g, f.path)));
      if (!inProject.length) {
        return "generated " + good[0] + " but nothing in the project " +
               "points at it — the render never got imported" +
               (footage.length ? " (" + footage.length + " file item(s) in " +
                 "the project, none matching)" : "");
      }
      const item = inProject[0];
      say("info", "generated " + item.width + "x" + item.height +
          (item.duration ? " / " + item.duration.toFixed(2) + "s" : "") +
          " -> " + item.name);
      // Reported, not failed: workplan 5.8 owns the missing tool.
      const placed = state.layers.some(l =>
        good.some(g => samePath(g, l.sourceFile)));
      if (!placed) {
        say("info", "GAP: the user asked for it IN the comp and it only " +
            "reached the project — no tool places a footage item into a " +
            "comp (import_file takes a path and nothing else)");
      }
      return null;
    }
  },
  {
    // WORKPLAN item 7: the pause-"never" refusal, in the field.
    //
    // The arithmetic behind it was measured on a real 5090 on 2026-08-30
    // (scripts/handoff-probe.js), and until that pass it could not
    // produce numbers at all — no shipped manifest carried a sizeMB, so
    // every refusal read "The panel cannot verify this generation fits".
    // What no probe has ever checked is the last hop: whether a refusal
    // survives the trip back THROUGH THE MODEL to the user.
    //
    // It is the one generation outcome the user cannot check for
    // themselves. Nothing renders, nothing reaches the project, no
    // dialog appears — so a model that answers "here's your image" is
    // indistinguishable from a working panel until they go looking, and
    // the setting they would have to change is never named.
    //
    // Impersonates an 8 GB card (T3) with pausing turned off: KREA2's
    // ~17.7 GB of weights cannot fit beside a loaded 7B, so planHandoff
    // refuses BEFORE Comfy.ensureRunning is reached. That is why this
    // step needs no backend running, renders nothing, and costs no VRAM.
    title: "a generation that cannot fit is refused, in words",
    expects: ["comfy_generate"],
    settings: { vramOverrideGB: 8, comfyPauseLlm: "never" },
    say: "Make me a picture of a blue ceramic mug on a wooden table.",
    check(state, ctx) {
      const gen = (ctx.tools || []).filter(t => t.tool === "comfy_generate");
      if (!gen.length) {
        const tried = (ctx.tools || []).map(t => t.tool);
        return "the model never called comfy_generate" +
               (tried.length ? " — it ran " + tried.join(", ") + " instead"
                             : " and ran no tools at all");
      }
      const ok = gen.filter(t => t.ok);
      if (ok.length) {
        return "comfy_generate SUCCEEDED on an 8 GB budget with pausing " +
               "set to never — the arbiter started a job whose weights " +
               "cannot fit beside the chat model";
      }
      // A refusal about anything else (an unknown workflow, a dead
      // backend) means the arbiter was never reached, so the step proved
      // nothing — that is a failure of the probe's own premise, not a
      // pass.
      const refusals = gen.filter(t =>
        /pause chat during generation/i.test(String(t.error || "")));
      if (!refusals.length) {
        return "comfy_generate failed for some other reason than the " +
               "pause setting, so the VRAM arbiter was never reached: " +
               String(gen[gen.length - 1].error || "(no error text)");
      }
      const err = String(refusals[0].error);
      // The 0.10.9 regression guard: a refusal that cannot name the
      // arithmetic is the "cannot verify" answer every card used to get,
      // and it tells the user nothing they can act on.
      const nums = err.match(/[\d.]+ ?GB/g) || [];
      if (nums.length < 3) {
        return "the refusal does not say what does not fit — it needs " +
               "the generation's size, the chat model's and the card's, " +
               "and carries " + nums.length + ": \"" + err + "\"";
      }
      // The card's number here is a FICTION and the chat model's is
      // measured, so unlabelled they can contradict each other outright
      // — the first field run of this step got "the chat model holds
      // ~20 GB of the card's 8 GB" (a 32B model, an 8 GB override) and
      // it is the shipped sentence a user with vramOverrideGB set would
      // read.
      if (!/override/i.test(err)) {
        return "the refusal quotes an impersonated card size as if it " +
               "were the real one: \"" + err + "\"";
      }
      say("info", "refusal: " + err);
      // Refusing is a decision, not an eviction: the chat model must
      // still be loaded, because nothing was ever started.
      if (ctx.chatState && ctx.chatState !== "running") {
        return "the refusal cost the chat model anyway — llama-server is " +
               ctx.chatState + " after a job that was never started";
      }
      const said = (ctx.replies || []).join(" ");
      if (!said.trim()) {
        return "the model relayed nothing at all back to the user";
      }
      // Three things the user needs and only the model can deliver: that
      // it did NOT happen, why, and which setting to change.
      const declined = new RegExp(
        "\\b(?:can(?:no|')?t|cannot|could\\s?n['o]t|unable|" +
        "did\\s?n['o]t|was\\s?n['o]t|is\\s?n['o]t|not able|no room|" +
        "not enough|insufficient|refus\\w*|blocked|skipped|" +
        "nothing was (?:started|generated)|" +
        "did not (?:start|generate|run))\\b", "i");
      const claimed = new RegExp(
        "\\b(?:here(?:'s| is) (?:your|the)|" +
        "i(?:'ve| have) (?:made|created|generated|rendered)|" +
        "(?:image|picture) is ready|all done)\\b", "i");
      if (!declined.test(said)) {
        return (claimed.test(said)
          ? "the model reported SUCCESS for a generation that never ran: \""
          : "the model never told the user the picture was not made: \"") +
          said.slice(0, 200) + "\"";
      }
      const reason =
        /\b(?:vram|video memory|gpu memory|memory|fits?\b|\d\s?gb)/i;
      if (!reason.test(said)) {
        return "the refusal reached the user with no reason in it: \"" +
               said.slice(0, 200) + "\"";
      }
      const setting = /\b(?:pause|paus\w+|never|auto|setting)/i;
      if (!setting.test(said)) {
        return "the user is told it cannot be done and not what to " +
               "change — the reply never mentions the pause setting: \"" +
               said.slice(0, 200) + "\"";
      }
      return null;
    }
  },

  // ------------------------------------------------ the trigger layer
  //
  // AUDIT-0.11 part 1.2: ten tools a designer's own words never reached,
  // because the docs and rules named the tools' vocabulary rather than
  // the user's. Each step below types ONE such sentence and reads the
  // comp for the RIGHT tool's fingerprint — a fingerprint the nearest
  // wrong tool cannot leave (a sort restacks the other layers, a mask
  // cannot take the shape of letters, an expression is not a parent).
  //
  // The sentences lean on the words AROUND each rule's phrase list where
  // a synonym proves more ('delay it', 'tag along', 'mechanically',
  // 'dress up', 'floaty', 'throb', 'tuck', 'bundle'): a step that only
  // echoes its own rule measures the echo. `tool` names the tool the
  // sentence is meant to reach; tests/test-chat-probe.js pins that the
  // schema can emit it and that a rule in the prompt names it.
  //
  // Order is load-bearing here too: the ease step needs the squares'
  // fade (step 3) still in place, so it runs before the un-animate step;
  // the restack runs before the matte so a legacy-AE matte would also
  // have its layer directly above; precompose folds the squares away
  // last of the comp edits.
  {
    // The shortest tool doc in the file until this pass ("Set layer
    // inPoint/outPoint/startTime (seconds).") and no rule at all.
    // 'delay' is deliberately NOT in the rule's phrase list.
    title: "push a layer back on the timeline",
    expects: ["set_layer_timing"],
    fromRig: true,
    tool: "set_layer_timing",
    say: "Beta shouldn't show up until two seconds in — delay it.",
    variants: [
      { kind: "casual", say: "hold Beta off till the 2 second mark" },
      { kind: "vague",
        say: "Beta comes in way too early — nothing from it before 2s." },
      { kind: "typo",
        say: "cna you make beta not appera until 2 secodns in" }
    ],
    check(state, ctx) {
      const b = betaLayer(state);
      if (!b) return "the Beta layer is gone";
      const fd = 1 / (state.frameRate || 30);
      const was = ctx.before ? betaLayer(ctx.before) : null;
      if (Math.abs(b.inPoint - 2) > fd) {
        if (was && b.opacityKeys > was.opacityKeys) {
          return "Beta still starts at " + b.inPoint.toFixed(2) + "s and " +
                 "gained opacity keyframes — the delay was faked with a " +
                 "fade instead of retiming the layer";
        }
        return "Beta starts at " + b.inPoint.toFixed(2) + "s (startTime " +
               b.startTime.toFixed(2) + "), wanted 2";
      }
      if (ctx.before && state.layers.length !== ctx.before.layers.length) {
        return "the layer count went from " + ctx.before.layers.length +
               " to " + state.layers.length + " — retiming should not " +
               "add or remove layers";
      }
      return null;
    }
  },
  {
    title: "attach a layer to a null",
    expects: ["set_layer_parent"],
    fromRig: true,
    tool: "set_layer_parent",
    say: "Make Beta tag along with the Rig null wherever it goes.",
    variants: [
      { kind: "casual", say: "glue Beta onto the Rig null" },
      { kind: "vague",
        say: "when the Rig null moves, Beta should move with it" },
      { kind: "typo", say: "parnet Beta to teh Rig null pls" }
    ],
    check(state) {
      const b = betaLayer(state);
      if (!b) return "the Beta layer is gone";
      const rig = rigNull(state);
      if (!rig) {
        return "no Rig null in the comp (the parenting step must have " +
               "failed)";
      }
      if (b.parent !== rig.name) {
        const expr = b.expressions && b.expressions.position;
        return "Beta's parent is " + (b.parent || "nothing") + ", wanted " +
               rig.name + (expr
                 ? " — it was linked with an expression (" +
                   expr.slice(0, 60) + ") instead of parented"
                 : "");
      }
      return null;
    }
  },
  {
    title: "smooth a mechanical fade",
    expects: ["apply_keyframe_ease"],
    fromRig: true,
    tool: "apply_keyframe_ease",
    say: "The squares fade in too mechanically — make it feel smoother.",
    variants: [
      { kind: "casual",
        say: "the squares pop in dead flat — give that fade some finesse" },
      { kind: "vague", say: "the squares' entrance feels cheap, fix it" },
      { kind: "typo", say: "the sqaures fade is to stiff, ease it plz" }
    ],
    check(state, ctx) {
      const sq = nineSquares(state);
      const animated = sq.filter(l => l.opacityKeys >= 2);
      if (!animated.length) {
        return "no square has opacity keyframes to ease (the stagger " +
               "step must have failed)";
      }
      if (ctx.before && sq.length !== nineSquares(ctx.before).length) {
        return "there were " + nineSquares(ctx.before).length +
               " squares before the sentence and " + sq.length +
               " after — easing should not add or remove layers";
      }
      const stiff = animated.filter(l =>
        !(l.opacityKeyEased || []).some(Boolean));
      if (stiff.length) {
        if (animated.some(l => l.expressions && l.expressions.opacity)) {
          return stiff.length + " of " + animated.length + " squares " +
                 "still have linear opacity keys — an expression was put " +
                 "on opacity instead of easing the keys";
        }
        const rekeyed = ctx.before && animated.some(l => {
          const w = nineSquares(ctx.before).find(x => x.name === l.name);
          return w && l.opacityKeys > w.opacityKeys;
        });
        return stiff.length + " of " + animated.length + " squares still " +
               "have linear opacity keys" + (rekeyed
                 ? " — extra keyframes were added instead of easing the " +
                   "existing ones"
                 : "");
      }
      return null;
    }
  },
  {
    // A text layer's anchor sits at its baseline origin, nowhere near
    // its middle, so the fingerprint is the anchor landing inside the
    // rendered rect — and the layer NOT jumping, which is what a raw
    // set_transform {anchorPoint} guess does.
    title: "fix a text layer's pivot",
    expects: ["center_anchor_point"],
    fromRig: true,
    tool: "center_anchor_point",
    say: "HELLO swings around its corner when it rotates — make it turn " +
         "about its own centre.",
    variants: [
      { kind: "casual",
        say: "HELLO's pivot is in the wrong spot — put it in the middle " +
             "of the letters" },
      { kind: "vague",
        say: "when I rotate HELLO it arcs away instead of spinning on " +
             "the spot" },
      { kind: "typo", say: "cetner the ancor point on HELLO" }
    ],
    check(state, ctx) {
      const t = textLayer(state);
      if (!t) return "the HELLO layer is gone";
      const r = t.sourceRect, a = t.anchorPoint;
      if (!r || !a) return "could not read HELLO's anchor point or source rect";
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const tolX = Math.max(4, r.width * 0.15);
      const tolY = Math.max(4, r.height * 0.15);
      if (Math.abs(a[0] - cx) > tolX || Math.abs(a[1] - cy) > tolY) {
        return "HELLO's anchor point is at [" + a[0].toFixed(0) + ", " +
               a[1].toFixed(0) + "] and the text's centre is [" +
               cx.toFixed(0) + ", " + cy.toFixed(0) + "] (layer space)" +
               (a[0] === 0 && a[1] === 0 ? " — still the default corner"
                                          : "");
      }
      const was = ctx.before ? textLayer(ctx.before) : null;
      if (was && was.anchorPoint && was.position && t.position &&
          Math.abs(t.rotation || 0) < 0.01 && t.scale &&
          Math.abs(t.scale[0] - 100) < 0.01) {
        const dx = (t.position[0] - a[0]) - (was.position[0] - was.anchorPoint[0]);
        const dy = (t.position[1] - a[1]) - (was.position[1] - was.anchorPoint[1]);
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          return "the anchor is centred but the text jumped by [" +
                 dx.toFixed(0) + ", " + dy.toFixed(0) + "] px — the anchor " +
                 "moved without compensating position";
        }
      }
      return null;
    }
  },
  {
    title: "hide half a layer with a mask",
    expects: ["add_mask"],
    fromRig: true,
    tool: "add_mask",
    say: "Chop off the lower half of Beta so only the top shows.",
    variants: [
      { kind: "casual", say: "I only want to see the top half of Beta" },
      { kind: "vague", say: "Beta's bottom half shouldn't be visible" },
      { kind: "typo", say: "mask ouf the bottm half of Beta" }
    ],
    check(state, ctx) {
      const b = betaLayer(state);
      if (!b) return "the Beta layer is gone";
      const was = ctx.before ? betaLayer(ctx.before) : null;
      const had = was ? was.masks : 0;
      if (b.masks <= had) {
        if (was && b.scale && was.scale &&
            Math.abs(b.scale[1] - was.scale[1]) > 1) {
          return "Beta was squashed (scale " + was.scale[1] + " -> " +
                 b.scale[1] + ") instead of masked";
        }
        return "Beta has " + b.masks + " mask(s), same as before — " +
               "nothing hides its lower half";
      }
      // A mask that landed does not excuse what else the turn did to
      // Beta: measured 2026-09-16 (q8_0 r3), the model moved it to the
      // comp centre and set scale 0.5 percent, then added a correct mask.
      if (was) {
        const moved = (p, q) => p && q &&
          (Math.abs(p[0] - q[0]) > 1 || Math.abs(p[1] - q[1]) > 1);
        if (moved(b.scale, was.scale)) {
          return "Beta was rescaled (" + JSON.stringify(was.scale) + " -> " +
                 JSON.stringify(b.scale) + ") as well as masked";
        }
        if (moved(b.position, was.position)) {
          return "Beta was moved (" + JSON.stringify(was.position) + " -> " +
                 JSON.stringify(b.position) + ") as well as masked";
        }
      }
      const W = b.layerWidth, H = b.layerHeight;
      // Judged CLIPPED to the layer: the part of a mask past the layer's
      // edge does nothing in AE, so [0,50,100,100] subtract on a 100x100
      // layer hides exactly the bottom half. Unclipped, its area read as
      // "covers the whole layer" and a correct mask scored HARM.
      const clip = bx => {
        if (!W || !H) return bx;
        const x0 = Math.max(0, bx[0]), y0 = Math.max(0, bx[1]);
        const x1 = Math.min(W, bx[0] + bx[2]), y1 = Math.min(H, bx[1] + bx[3]);
        return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
      };
      const boxes = (b.maskBoxes || []).slice(had).map(clip);
      const modes = (b.maskModes || []).slice(had);
      const inv = (b.maskInverted || []).slice(had);
      if (W && H && boxes.length) {
        if (!boxes.some(bx => bx[2] * bx[3] < 0.8 * W * H)) {
          return "the new mask covers the whole " + W + "x" + H + " layer (" +
                 JSON.stringify(boxes) + ") — it hides nothing";
        }
        // A band the full width of the layer and half its height: over
        // the TOP half when it KEEPS what it covers, or over the BOTTOM
        // half when it hides what it covers (subtract, or inverted, not
        // both). A dot, a sliver or a band in the wrong place hides the
        // wrong thing. Measured 2026-09-17 (NEXT UP 20): a subtract band
        // over the TOP half scored pass here, and it shows only the
        // bottom, the opposite of every sentence in this step.
        const band = boxes.some((bx, i) => {
          const fullWide = bx[2] >= 0.9 * W;
          const half = Math.abs(bx[3] - H / 2) <= 0.15 * H;
          const hides = (modes[i] === "subtract") !== (inv[i] === true);
          const top = Math.abs(bx[1]) <= 0.1 * H && !hides;
          const bottom = Math.abs(bx[1] - H / 2) <= 0.1 * H && hides;
          return fullWide && half && (top || bottom);
        });
        if (!band) {
          return "the new mask is " + JSON.stringify(boxes) + " (" +
                 modes.join(", ") + ") on a " + W + "x" + H + " layer — " +
                 "not a band across the top half";
        }
      }
      return null;
    }
  },
  {
    title: "take a mask off again",
    expects: ["delete_mask"],
    fromRig: true,
    tool: "delete_mask",
    say: "Lose the oval mask on HELLO — it's not needed any more.",
    variants: [
      { kind: "casual", say: "get that oval off HELLO, I don't want it" },
      { kind: "vague", say: "HELLO shouldn't be masked at all any more" },
      { kind: "typo", say: "delet the msak on HELLO" }
    ],
    check(state, ctx) {
      const t = textLayer(state);
      if (!t) {
        return "the HELLO layer is gone — the mask went with the whole layer";
      }
      const was = ctx.before ? textLayer(ctx.before) : null;
      const had = was ? was.masks : null;
      if (had === 0) {
        return "HELLO had no mask before the sentence (the mask step must " +
               "have failed), so there was nothing to prove";
      }
      if (had !== null ? t.masks >= had : t.masks > 0) {
        return "HELLO still has " + t.masks + " mask(s)" +
               (had !== null ? ", same as before" : "") + " — setting a " +
               "mask's mode to none or its feather to 0 is not removing it";
      }
      return null;
    }
  },
  {
    title: "un-animate the squares",
    expects: ["remove_keyframes"],
    fromRig: true,
    tool: "remove_keyframes",
    say: "The squares shouldn't fade in any more — just have them there " +
         "from the start.",
    variants: [
      { kind: "casual",
        say: "kill the fade on the squares, I want them solid the whole " +
             "time" },
      { kind: "vague", say: "the squares are animating and they shouldn't be" },
      { kind: "typo", say: "remvoe the opacity keyfarmes form the squares" }
    ],
    check(state, ctx) {
      const sq = nineSquares(state);
      if (!sq.length) return "no squares in the comp";
      if (ctx.before && sq.length !== nineSquares(ctx.before).length) {
        return "there were " + nineSquares(ctx.before).length +
               " squares before the sentence and " + sq.length +
               " after — removing animation should not add or remove layers";
      }
      const still = sq.filter(l => l.opacityKeys > 0);
      if (still.length) {
        return still.length + " of " + sq.length + " squares still carry " +
               "opacity keyframes (" + still.slice(0, 3)
                 .map(l => l.name + ": " + l.opacityKeys + " keys")
                 .join(", ") + ") — keyframing 100 to 100 is not " +
               "un-animating";
      }
      // Which value AE leaves behind when every key goes is UNMEASURED
      // (the host removes key 1 repeatedly, so the last key's value is
      // the likely survivor — 100 here, but that is a reading of the
      // code, not of AE). Reported for the real-AE pass, not failed.
      const left = distinct(sq.map(l => l.opacity).filter(v =>
        typeof v === "number"), 0.5);
      say("info", "residual opacity after the keys went: " +
          (left.length ? left.join(", ") : "(unreadable)") +
          (left.some(v => v < 50) ? " — LOW, the squares may be invisible;" +
            " measure which key's value AE keeps" : ""));
      return null;
    }
  },
  {
    // The designed "make it pop" tool was findable only via the word
    // 'preset'. The receipt is what proves the route: an improvised
    // Glow + Drop Shadow also changes the layer.
    title: "give a layer a finished look",
    expects: ["list_presets", "apply_preset"],
    fromRig: true,
    tool: "apply_preset",
    say: "Dress HELLO up a bit — it looks too plain.",
    variants: [
      { kind: "casual", say: "HELLO's boring — give it some polish" },
      { kind: "vague", say: "can you make HELLO look nicer?" },
      { kind: "typo", say: "make HELLO look les plain, aply somethign to it" }
    ],
    check(state, ctx) {
      const t = textLayer(state);
      if (!t) return "the HELLO layer is gone";
      const applied = calls(ctx, "apply_preset");
      if (!applied.length) {
        return "the model never reached apply_preset" + ranInstead(ctx) +
               " — a look is a preset, not an improvised effect stack";
      }
      const ok = applied.filter(c => c.ok);
      if (!ok.length) {
        return "apply_preset failed " + applied.length + " time(s), last " +
               "error: " + applied[applied.length - 1].error;
      }
      const rows = [];
      for (const c of ok) {
        for (const r of (c.data && c.data.applied) || []) rows.push(r);
      }
      const onText = rows.filter(r => r.layer === t.name);
      if (!onText.length) {
        return "the preset landed on " + (rows.length
          ? rows.map(r => r.layer).join(", ") : "nothing") + ", not on " +
          t.name;
      }
      const was = ctx.before ? textLayer(ctx.before) : null;
      if (was && onText.some(r => (r.effectsAdded || []).length) &&
          t.effects <= was.effects) {
        return "the receipt says effects were added to " + t.name +
               " but the layer still has " + t.effects + " effect(s)";
      }
      return null;
    }
  },
  {
    title: "keep a layer drifting",
    expects: ["apply_expression_preset"],
    fromRig: true,
    tool: "apply_expression_preset",
    say: "Give Beta a lazy, floaty hover so it never sits completely still.",
    variants: [
      { kind: "casual",
        say: "Beta shouldn't be dead still — give it a slow idle wander" },
      { kind: "vague", say: "Beta feels frozen, make it breathe a little" },
      { kind: "typo", say: "put a slow wigle on beta so it keeps moviing" }
    ],
    check(state, ctx) {
      const b = betaLayer(state);
      if (!b) return "the Beta layer is gone";
      const ex = b.expressions || {};
      const moving = Object.keys(ex).filter(k => /wiggle/i.test(ex[k]));
      if (!moving.length) {
        const was = ctx.before ? betaLayer(ctx.before) : null;
        const keyed = was && b.opacityKeys > was.opacityKeys;
        return "Beta has no wiggle expression on any transform property" +
               (Object.keys(ex).length
                 ? " (expressions: " + JSON.stringify(ex).slice(0, 120) + ")"
                 : "") +
               (keyed ? " — it was keyframed instead, and keyframes stop"
                      : "");
      }
      if (!calls(ctx, "apply_expression_preset").some(c => c.ok)) {
        const raw = calls(ctx, "set_expression").filter(c => c.ok);
        return "the wiggle got there " + (raw.length
          ? "via set_expression — hand-written code, the route the rules " +
            "forbid"
          : "without apply_expression_preset" + ranInstead(ctx));
      }
      return null;
    }
  },
  {
    // The follow-up (link_property) was doc prose only. Probe Room has
    // no audio layer, so the honest outcome here is a GROUNDED refusal
    // relayed to the user — the branch below that reads the expression
    // runs the day someone drops an audio layer into the rig.
    title: "sync a layer to the music",
    expects: ["audio_to_keyframes", "link_property"],
    fromRig: true,
    tool: "audio_to_keyframes",
    say: "Make Beta throb in time with the music.",
    variants: [
      { kind: "casual", say: "have Beta pulse along with the audio" },
      { kind: "vague", say: "Beta should react to the soundtrack" },
      { kind: "typo", say: "make beta bonuce to the muisc" }
    ],
    check(state, ctx) {
      const a2k = calls(ctx, "audio_to_keyframes");
      if (!a2k.length) {
        return "the model never reached audio_to_keyframes" + ranInstead(ctx);
      }
      if (a2k.some(c => c.ok)) {
        const link = calls(ctx, "link_property").filter(c => c.ok);
        if (!link.length) {
          return "the audio was converted and the model stopped — the " +
                 "amplitude null drives nothing until link_property runs";
        }
        const b = betaLayer(state);
        if (!b) return "the Beta layer is gone";
        const ex = b.expressions || {};
        const ctrl = String((link[0].args || {}).controlLayer || "");
        const driven = Object.keys(ex).filter(k =>
          (ctrl && ex[k].indexOf(ctrl) !== -1) ||
          /Both Channels|Left Channel|Right Channel|Audio Amplitude/i
            .test(ex[k]));
        if (!driven.length) {
          return "link_property ran but no Beta transform property reads " +
                 "the amplitude null" + (Object.keys(ex).length
                   ? " (expressions: " + JSON.stringify(ex).slice(0, 120) + ")"
                   : " — Beta has no expressions at all");
        }
        return null;
      }
      const err = String(a2k[a2k.length - 1].error || "");
      if (!/audio/i.test(err)) {
        return "audio_to_keyframes failed for some other reason than the " +
               "missing audio, so the step proved nothing: " + err;
      }
      const faked = (ctx.tools || []).filter(c => c.ok &&
        /^(set_keyframes|add_keyframe|set_expression|apply_expression_preset|set_property)$/
          .test(c.tool));
      if (faked.length) {
        return "told there is no audio, the model faked a beat with " +
               faked.map(c => c.tool).join(", ");
      }
      const said = (ctx.replies || []).join(" ");
      if (!said.trim()) return "the refusal never reached the user";
      // 'lacks' measured 2026-09-03: the model answered "The comp 'Probe
      // Room' lacks audio. Import an audio file first" — an honest
      // refusal, relayed in full, scored as a FAIL because every word on
      // this list is a negation and that sentence has none.
      const declined = new RegExp(
        "\\b(?:can(?:no|')?t|cannot|could\\s?n['o]t|unable|no audio|" +
        "(?:there(?: is|'s)|is|has|have) no|isn'?t any|does ?n['o]t " +
        "(?:have|contain)|lack\\w*|without|missing|not (?:found|present)|" +
        "did\\s?n['o]t|refus\\w*)\\b", "i");
      if (!declined.test(said) || !/audio|music|sound|track/i.test(said)) {
        return "the reply does not tell the user the comp has no audio to " +
               "sync to: \"" + said.slice(0, 160) + "\"";
      }
      return null;
    }
  },
  {
    // reorder_layers' RELATIVE mode. The sort mode would also put Beta
    // somewhere else — and move every other layer with it, which is the
    // half a naive "is Beta under HELLO now?" check never sees.
    title: "tuck one layer under another",
    expects: ["reorder_layers"],
    fromRig: true,
    tool: "reorder_layers",
    say: "Beta is covering HELLO — tuck it in underneath the text.",
    // Every phrasing names BETA as the thing that moves. "HELLO is
    // hidden, I need to see the text" would also be solved by lifting
    // HELLO — and the check's sort detector reads that as every other
    // layer changing places, which would fail a legitimate answer.
    variants: [
      { kind: "casual", say: "shove Beta below HELLO in the stack" },
      { kind: "vague",
        say: "Beta needs to sit behind the text, not in front of it" },
      { kind: "typo", say: "put beta undeneath HELLO plz" }
    ],
    check(state, ctx) {
      const b = betaLayer(state), t = textLayer(state);
      if (!b) return "the Beta layer is gone";
      if (!t) return "the HELLO layer is gone";
      if (ctx.before) {
        const b0 = betaLayer(ctx.before), t0 = textLayer(ctx.before);
        if (b0 && t0 && b0.index === t0.index + 1) {
          return "Beta already sat directly under HELLO before the " +
                 "sentence, so the step proved nothing";
        }
        if (state.layers.length !== ctx.before.layers.length) {
          return "the layer count went from " + ctx.before.layers.length +
                 " to " + state.layers.length + " — restacking should not " +
                 "add or remove layers";
        }
        // Everything except THE Beta layer, by name and in stack order:
        // a relative move leaves this list untouched, a sort does not.
        const others = st => st.layers
          .filter(l => l.name !== b.name).map(l => l.name);
        const w = others(ctx.before), n = others(state);
        const moved = w.filter((name, i) => n[i] !== name).length;
        if (moved) {
          return moved + " of the other " + w.length + " layers changed " +
                 "places — a SORT ran where one layer should have moved";
        }
      }
      if (b.index !== t.index + 1) {
        return "Beta is at index " + b.index + " and HELLO at " + t.index +
               " — " + (b.index < t.index
                 ? "Beta is still above the text"
                 : "Beta went below the text but not directly under it");
      }
      return null;
    }
  },
  {
    // Nothing earlier leaves an effect on Beta (Dot's drop shadow was
    // undone in step 10), so the blur is planted through the bridge
    // before the sentence — see runPrepare.
    title: "take an effect off a layer",
    expects: ["remove_effect"],
    fromRig: true,
    tool: "remove_effect",
    prepare: "AELL_call(\"apply_effect\", " + JSON.stringify(JSON.stringify(
      { comp: COMP, layer: "Beta", effect: "Gaussian Blur" })) + ")",
    say: "Beta doesn't need that blur any more — strip it off.",
    variants: [
      { kind: "casual",
        say: "Beta shouldn't be soft any more, drop the effect on it" },
      { kind: "vague", say: "Beta is too fuzzy — it should be sharp again" },
      { kind: "typo", say: "remvoe the gaussain blur form Beta" }
    ],
    check(state, ctx) {
      const b = betaLayer(state);
      if (!b) {
        return "the Beta layer is gone — deleting the layer is not " +
               "removing the effect";
      }
      const was = ctx.before ? betaLayer(ctx.before) : null;
      const blurs = names => (names || []).filter(n => /blur/i.test(n));
      if (was && !blurs(was.effectNames).length) {
        return "Beta carried no blur before the sentence (the fixture " +
               "never landed), so there was nothing to prove";
      }
      const blur = blurs(b.effectNames);
      if (blur.length) {
        return "Beta still carries " + blur.join(", ") + " — setting " +
               "Blurriness to 0 or switching the effect off is not " +
               "removing it";
      }
      if (was && b.effects !== was.effects - blurs(was.effectNames).length) {
        return "Beta lost " + (was.effects - b.effects) + " effect(s) when " +
               "only the blur should have gone (had " +
               was.effectNames.join(", ") + ")";
      }
      return null;
    }
  },
  {
    title: "show one layer through another",
    expects: ["set_track_matte"],
    fromRig: true,
    tool: "set_track_matte",
    say: "I want Beta to show only through the HELLO letters.",
    variants: [
      { kind: "casual", say: "use HELLO as a stencil for Beta" },
      { kind: "vague",
        say: "Beta should appear in the shape of the word HELLO" },
      { kind: "typo", say: "matte beta wiht the HELLO text" }
    ],
    check(state, ctx) {
      const b = betaLayer(state), t = textLayer(state);
      if (!b) return "the Beta layer is gone";
      if (!t) return "the HELLO layer is gone";
      if (!hasMatte(b)) {
        const t0 = ctx.before ? textLayer(ctx.before) : null;
        if (hasMatte(t) && !(t0 && hasMatte(t0))) {
          return "it is backwards — HELLO got matted" +
                 (t.matteLayer ? " by " + t.matteLayer : "") + " and Beta " +
                 "is untouched; 'layer' is the thing being cut, " +
                 "'matteLayer' the text";
        }
        const was = ctx.before ? betaLayer(ctx.before) : null;
        if (was && b.masks > was.masks) {
          return "Beta was given a mask instead of a track matte — a mask " +
                 "cannot take the shape of the letters";
        }
        return "Beta has no track matte";
      }
      if (b.matteLayer && b.matteLayer !== t.name) {
        return "Beta is matted by " + b.matteLayer + ", not by " + t.name;
      }
      return null;
    }
  },
  {
    title: "package layers into a precomp",
    expects: ["precompose"],
    fromRig: true,
    tool: "precompose",
    say: "Bundle the nine blue squares into a single layer called Squares.",
    variants: [
      { kind: "casual",
        say: "throw the nine blue squares into their own comp and call " +
             "it Squares" },
      { kind: "vague",
        say: "the nine blue squares should all live inside one thing " +
             "named Squares" },
      { kind: "typo", say: "precomp the nine blue sqaures as Squares" }
    ],
    check(state, ctx) {
      const pre = state.layers.filter(l => l.isPrecomp);
      // Exactly "Squares": AE auto-numbers a taken name, so "Squares 2"
      // means a previous run's precomp is still in the project — a
      // sweep failure to report, not a pass.
      const named = pre.filter(l => l.name === "Squares");
      if (!named.length) {
        const near = pre.filter(l => /^Squares/i.test(l.name));
        if (near.length) {
          return "the precomp came out as '" + near[0].name + "', not " +
                 "'Squares' — a comp called Squares already existed (a " +
                 "leftover from an earlier run the sweep missed?)";
        }
        return pre.length
          ? "there is a precomp layer (" + pre.map(l => l.name).join(", ") +
            ") but none called Squares"
          : "no precomp layer in the comp" + ranInstead(ctx);
      }
      const left = nineSquares(state);
      const was = ctx.before ? nineSquares(ctx.before).length : null;
      const allowed = was !== null ? Math.max(0, was - 9) : 0;
      if (left.length > allowed) {
        return left.length + " square(s) are still loose in " + COMP +
               (was !== null ? " (" + was + " before)" : "") + " — a comp " +
               "was made but the squares never moved into it";
      }
      return null;
    }
  },
  {
    // The collision the audit named: 'clean this up' about a COMP used to
    // route to clean_project, the project-panel tool that deletes
    // footage (safe only because it previews first — and still a
    // non-sequitur). No tool is named here on purpose: the right answer
    // to an unnamed mess is a question.
    title: "clean up means the comp, not the project",
    expects: [],
    expectsRules: ["clean-comp-ask"],
    fromRig: true,
    say: "Probe Room is a mess now — clean it up.",
    // The one step with no `tool`: the right answer to an unnamed mess is
    // a question, and these three phrasings all leave it unnamed. A
    // variant that DELETES here is the loudest harm the matrix can find.
    variants: [
      { kind: "casual", say: "Probe Room's got junk everywhere, tidy it" },
      { kind: "vague", say: "sort out Probe Room for me" },
      { kind: "typo", say: "clen up probe room its a mess" }
    ],
    check(state, ctx) {
      if (!state.found) return "the comp is gone";
      const project = (ctx.tools || []).filter(c =>
        /^(clean_project|organize_project|delete_item|rename_comps)$/
          .test(c.tool));
      if (project.length) {
        return "a complaint about the COMP went to the project panel: " +
               project.map(c => c.tool + (c.args && c.args.dryRun === false
                 ? " (dryRun:false!)" : "")).join(", ") +
               " — clean_project deletes footage, not clutter in a timeline";
      }
      if (ctx.before && state.layers.length < ctx.before.layers.length) {
        const gone = ctx.before.layers
          .filter(l => !state.layers.some(a => a.name === l.name))
          .map(l => l.name);
        return (ctx.before.layers.length - state.layers.length) +
               " layer(s) were deleted without asking what should go: " +
               gone.slice(0, 5).join(", ");
      }
      const said = (ctx.replies || []).join(" ");
      if (!/\?|which|what|tell me|let me know|should i|would you like/i
            .test(said)) {
        return "nothing was named to remove and the model never asked " +
               "what should go: \"" + said.slice(0, 160) + "\"";
      }
      return null;
    }
  },
  // ---------------------------------------------------------------------
  // The A/B/C/E usefulness rows (docs/USEFULNESS-TESTS.md) that had no rig
  // twin: A1 grid, A2 slider rig, B1 stagger, C1 typewriter, C2 text
  // style, E1 blur, E2 for_each. Every one of them asks for something the
  // FULL rig already has, so they start from the "icons" rig instead —
  // six scattered squares over a background, nothing animated, nothing
  // styled, nothing rigged. What the sentence asks for is exactly what
  // the world lacks, which is the only way a pass means anything.
  //
  // Their sentences come from the usefulness table where it has one,
  // adapted only to name the fixtures ("the icons", "the HEADLINE", "the
  // background") — a probe that invents its own phrasing measures the
  // phrasing.
  {
    title: "arrange scattered layers into a grid",
    expects: ["grid_layout"],
    fromRig: "icons",
    tool: "grid_layout",
    say: "Arrange the icon layers into a grid with a bit of breathing " +
         "room.",
    variants: [
      { kind: "casual", say: "line the Icon layers up in a neat 3 by 2 grid" },
      { kind: "vague",
        say: "the icons are scattered all over the place — put them in " +
             "rows and columns" },
      { kind: "typo", say: "arrnage teh icon layers into a gird plz" }
    ],
    check(state, ctx) {
      const ic = iconLayers(state);
      if (ic.length !== RIG_ICONS) {
        return "there are " + ic.length + " icon layers, wanted " +
               RIG_ICONS + " — a layout should not add or remove any";
      }
      const bg = bgLayer(state);
      const wasBg = ctx.before ? bgLayer(ctx.before) : null;
      if (bg && wasBg && bg.position && wasBg.position &&
          Math.abs(bg.position[0] - wasBg.position[0]) +
          Math.abs(bg.position[1] - wasBg.position[1]) > 1) {
        return "the background moved to " + bg.position.slice(0, 2) +
               " — it is not one of the icons";
      }
      // Two ways to be a grid, and both are honest: the positions
      // themselves line up, or grid_layout's rig drives them. AE
      // evaluates an expression before handing back .value, so the first
      // test normally sees the second too — but a controller whose
      // expression errors would read as un-moved, and naming that is
      // more useful than "not a grid".
      const xs = distinct(ic.map(l => l.position && l.position[0]), 4);
      const ys = distinct(ic.map(l => l.position && l.position[1]), 4);
      const rigged = ic.filter(l => l.expressions && l.expressions.position);
      if (xs.length > 1 && ys.length > 1 &&
          xs.length * ys.length === ic.length) {
        return null;
      }
      if (rigged.length === ic.length) return null;
      return "the icons sit at " + xs.length + " distinct x and " +
             ys.length + " distinct y" +
             (rigged.length ? " (" + rigged.length + " of " + ic.length +
                              " carry a position expression)"
                            : " and none carries a position expression") +
             " — that is not a grid" + ranInstead(ctx);
    }
  },
  {
    title: "rig one slider to drive many layers",
    expects: ["add_control", "link_property"],
    fromRig: "icons",
    tool: "link_property",
    say: "Give me one slider that controls the size of all the icon " +
         "layers.",
    variants: [
      { kind: "casual", say: "rig the Icon layers to a master scale control" },
      { kind: "vague",
        say: "I want to resize all six icons together from one place" },
      { kind: "typo", say: "one slidder to contorl the icons scale plz" }
    ],
    check(state, ctx) {
      const ic = iconLayers(state);
      if (ic.length !== RIG_ICONS) {
        return "there are " + ic.length + " icon layers, wanted " +
               RIG_ICONS;
      }
      const linked = ic.filter(l => l.expressions && l.expressions.scale);
      if (!linked.length) {
        // Scaling them all by hand is the wrong answer even when every
        // icon ends up the right size: nothing controls them afterwards.
        const resized = ctx.before && ic.some(l => {
          const w = iconLayers(ctx.before).filter(x => x.name === l.name)[0];
          return w && l.scale && w.scale &&
                 Math.abs(l.scale[0] - w.scale[0]) > 0.5;
        });
        return "no icon's scale is driven by an expression" +
               (resized ? " — they were scaled directly instead, so no " +
                          "control exists to drive them"
                        : "") + ranInstead(ctx);
      }
      if (linked.length !== ic.length) {
        return linked.length + " of " + ic.length + " icons are linked — " +
               ic.filter(l => !(l.expressions && l.expressions.scale))
                 .map(l => l.name).join(", ") + " still stand alone";
      }
      // One slider, not six. Every expression has to name the SAME
      // control layer, or "one slider that controls all of them" is
      // false however many expressions were written.
      const owners = [];
      for (const l of linked) {
        const m = /layer\(\s*["']([^"']+)["']\s*\)/.exec(l.expressions.scale);
        const who = m ? m[1] : "(no layer named)";
        if (owners.indexOf(who) === -1) owners.push(who);
      }
      if (owners.length !== 1) {
        return "the icons are driven from " + owners.length +
               " different places (" + owners.join(", ") +
               ") — the ask was ONE slider";
      }
      return null;
    }
  },
  {
    title: "cascade the entrances",
    expects: ["stagger_layers"],
    fromRig: "icons",
    tool: "stagger_layers",
    say: "Fade the icons in one after another, half a second apart.",
    variants: [
      { kind: "casual", say: "cascade the icons' entrances, 0.5s apart" },
      { kind: "vague",
        say: "the icons should arrive one by one, not all at once" },
      { kind: "typo",
        say: "fade teh icons in one aftre another haf a second apart" }
    ],
    check(state, ctx) {
      const ic = iconLayers(state);
      if (ic.length !== RIG_ICONS) {
        return "there are " + ic.length + " icon layers, wanted " +
               RIG_ICONS;
      }
      const faded = ic.filter(l => l.opacityKeys >= 2);
      if (!faded.length) {
        return "no icon has opacity keyframes — nothing fades in" +
               ranInstead(ctx);
      }
      if (faded.length !== ic.length) {
        return faded.length + " of " + ic.length + " icons fade in; " +
               ic.filter(l => l.opacityKeys < 2).map(l => l.name)
                 .join(", ") + " have no fade";
      }
      // Two honest ways to space them: the keys themselves sit at
      // different times, or the LAYERS were retimed and carry the same
      // fade. stagger_layers does the second, set_keyframes the first.
      const byKey = ic.map(l => l.opacityKeyTimes[0]);
      const byStart = ic.map(l => l.startTime);
      for (const offs of [byKey, byStart]) {
        const d = distinct(offs, 0.02);
        if (d.length !== ic.length) continue;
        const gaps = [];
        for (let i = 1; i < d.length; i++) gaps.push(d[i] - d[i - 1]);
        if (gaps.every(g => Math.abs(g - 0.5) <= 0.2)) return null;
      }
      const shown = distinct(byKey, 0.02);
      return "the icons' fades start at " +
             shown.map(t => t.toFixed(2)).join(", ") + "s (start times " +
             distinct(byStart, 0.02).map(t => t.toFixed(2)).join(", ") +
             ") — wanted six, half a second apart";
    }
  },
  {
    title: "type a title on letter by letter",
    expects: ["add_text_animator"],
    fromRig: "icons",
    tool: "add_text_animator",
    say: "Type the HEADLINE on letter by letter.",
    variants: [
      { kind: "casual", say: "give HEADLINE a typewriter effect" },
      { kind: "vague",
        say: "I want the headline's letters to appear one at a time" },
      { kind: "typo", say: "typwriter on the HEADLINE layer pls" }
    ],
    check(state, ctx) {
      const t = headline(state);
      if (!t) return "the HEADLINE text layer is gone";
      if (!t.textAnimators) {
        // The two wrong turns worth telling apart: fading the WHOLE
        // layer in (opacity keys on the transform) says "letter by
        // letter" was never heard, and an expression on opacity is the
        // same miss written differently.
        if (t.opacityKeys >= 2) {
          return "HEADLINE has " + t.opacityKeys + " opacity keyframes " +
                 "and no text animator — the whole layer fades in " +
                 "together, not letter by letter";
        }
        return "HEADLINE has no text animator" + ranInstead(ctx);
      }
      if (ctx.before && state.layers.length !== ctx.before.layers.length) {
        return "the layer count went from " + ctx.before.layers.length +
               " to " + state.layers.length +
               " — a typewriter is a rig on the text, not a new layer";
      }
      return null;
    }
  },
  {
    title: "restyle a headline",
    expects: ["set_text_style"],
    fromRig: "icons",
    tool: "set_text_style",
    say: "Make the HEADLINE bigger and brand blue (#1B4FFF).",
    variants: [
      { kind: "casual", say: "HEADLINE should be way bigger, in #1B4FFF" },
      { kind: "vague",
        say: "the headline is too small and too plain — make it pop in " +
             "our blue" },
      { kind: "typo", say: "mkae HEADLINE bigegr and blue #1B4FFF" }
    ],
    check(state, ctx) {
      const t = headline(state);
      if (!t) return "the HEADLINE text layer is gone";
      const was = ctx.before ? headline(ctx.before) : null;
      const wasSize = was && was.fontSize !== null ? was.fontSize
                                                   : ICON_FONT_SIZE;
      if (!(t.fontSize > wasSize + 1)) {
        return "HEADLINE is still " + t.fontSize + "px (was " + wasSize +
               ")" + ranInstead(ctx);
      }
      // #1B4FFF is [0.106, 0.310, 1.0]. Read loosely on purpose: the
      // ask is "brand blue", and a model that rounds the hex or reaches
      // for a Fill effect answered it. What must NOT pass is white,
      // which is what it already was.
      const blue = c => !!c && c[2] > 0.6 && c[2] - c[0] > 0.35 &&
                        c[2] - c[1] > 0.25;
      if (!blue(t.fillColor) && !(t.effectColors || []).some(blue)) {
        return "HEADLINE is " + wasSize + " -> " + t.fontSize + "px but " +
               "its fill is " +
               (t.fillColor ? t.fillColor.map(v => v.toFixed(2)).join(",")
                            : "unreadable") + ", not blue";
      }
      // "only the named layer" is half of what this row asks for.
      const touched = iconLayers(state).filter(l => {
        const w = ctx.before &&
          iconLayers(ctx.before).filter(x => x.name === l.name)[0];
        return w && l.scale && w.scale &&
               Math.abs(l.scale[0] - w.scale[0]) > 0.5;
      });
      if (touched.length) {
        return "the icons were resized too (" +
               touched.map(l => l.name).join(", ") +
               ") — only HEADLINE was named";
      }
      return null;
    }
  },
  {
    title: "soften the background",
    expects: ["apply_effect"],
    fromRig: "icons",
    tool: "apply_effect",
    say: "Soften the background a touch.",
    variants: [
      { kind: "casual", say: "make the BG layer slightly blurry" },
      { kind: "vague", say: "the background is too sharp behind the icons" },
      { kind: "typo", say: "sofetn the backgrond layer a touch" }
    ],
    check(state, ctx) {
      const bg = bgLayer(state);
      if (!bg) return "the BG layer is gone";
      const BLUR = /blur|defocus/i;
      if (!hasEffect(bg, BLUR)) {
        // The miss that looks like a hit: blurring the wrong layer, or
        // dropping the background's opacity because "softer" was read
        // as "fainter".
        const elsewhere = state.layers.filter(l =>
          l.name !== bg.name && hasEffect(l, BLUR)).map(l => l.name);
        if (elsewhere.length) {
          return "the blur landed on " + elsewhere.join(", ") +
                 " instead of the background";
        }
        const wasBg = ctx.before ? bgLayer(ctx.before) : null;
        if (wasBg && bg.opacity !== null && wasBg.opacity !== null &&
            Math.abs(bg.opacity - wasBg.opacity) > 1) {
          return "the background's opacity went " + wasBg.opacity + " -> " +
                 bg.opacity + " — 'soften' is a blur, not a fade";
        }
        return "the background carries no blur (effects: " +
               ((bg.effectNames || []).join(", ") || "none") + ")" +
               ranInstead(ctx);
      }
      const spill = iconLayers(state).filter(l => hasEffect(l, BLUR));
      if (spill.length) {
        return "the icons were blurred too (" +
               spill.map(l => l.name).join(", ") +
               ") — only the background was named";
      }
      return null;
    }
  },
  {
    title: "an effect on everything except one layer",
    expects: ["for_each_layer", "apply_effect"],
    fromRig: "icons",
    tool: "for_each_layer",
    say: "Put a drop shadow on everything except the background.",
    variants: [
      { kind: "casual", say: "drop shadow on every layer but the BG" },
      { kind: "vague",
        say: "everything should sit off the background a bit — shadow " +
             "them, not it" },
      { kind: "typo", say: "drop shaddow on everythign excpet the backgrond" }
    ],
    check(state, ctx) {
      const bg = bgLayer(state);
      if (!bg) return "the BG layer is gone";
      const SHADOW = /shadow/i;
      // The EXCEPT is the load-bearing half: an effect on all seven
      // layers is the "wrong-target mutation claiming success" this
      // matrix exists to catch, and it is worse than doing nothing.
      if (hasEffect(bg, SHADOW)) {
        return "the background got a drop shadow too — 'except the " +
               "background' was the whole instruction";
      }
      const head = headline(state);
      const want = iconLayers(state).concat(head ? [head] : []);
      const missing = want.filter(l => !hasEffect(l, SHADOW));
      if (missing.length === want.length) {
        return "no layer carries a drop shadow" + ranInstead(ctx);
      }
      if (missing.length) {
        return missing.length + " of " + want.length + " layers were " +
               "skipped: " + missing.map(l => l.name).join(", ");
      }
      if (ctx.before && state.layers.length !== ctx.before.layers.length) {
        return "the layer count went from " + ctx.before.layers.length +
               " to " + state.layers.length +
               " — an effect pass should not add or remove layers";
      }
      return null;
    }
  }
];

// ------------------------------------------------------------------ run

/*
 * "--steps 1-11,15,17-20" -> 0-based indices, in the order given. Every
 * piece must be a plain integer or an a-b range inside 1..count; anything
 * else lands in `bad`. The old parser ran parseInt on each piece, so
 * "1-11" silently meant step 1 and a whole 11b-2 run was wasted
 * (2026-09-16).
 */
function parseSteps(spec, count) {
  const picked = [];
  const bad = [];
  String(spec).split(",").forEach(raw => {
    const piece = raw.trim();
    const m = /^(\d+)(?:-(\d+))?$/.exec(piece);
    const a = m ? parseInt(m[1], 10) : NaN;
    const b = m && m[2] !== undefined ? parseInt(m[2], 10) : a;
    if (!m || a < 1 || b > count || b < a) { bad.push(piece); return; }
    for (let n = a; n <= b; n++) {
      if (picked.indexOf(n - 1) < 0) picked.push(n - 1);
    }
  });
  return { picked, bad };
}

function pickSteps() {
  if (!OPT.steps) return STEPS.map((s, i) => i);
  const r = parseSteps(OPT.steps, STEPS.length);
  if (r.bad.length || !r.picked.length) {
    console.error("!! --steps " + OPT.steps + ": not understood: " +
                  (r.bad.length ? r.bad.join(", ") : "(nothing)") +
                  ". Understood: " +
                  (r.picked.length ? r.picked.map(i => i + 1).join(",")
                                   : "nothing") +
                  ". Use integers or a-b ranges within 1-" + STEPS.length + ".");
    process.exit(2);
  }
  return r.picked;
}

/*
 * Tools.promptOptsFor, the panel's own path, with --prompt-mode laid over
 * its doc form. Routing and everything else stay the panel's decision.
 */
function probePromptOpts(s, text, history, promptMode) {
  const po = Tools.promptOptsFor(s, text, history);
  if (promptMode === "compact") po.opts.compact = true;
  else if (promptMode === "full") po.opts.compact = false;
  return po;
}

// The doc form a run really used, and whether it was forced: a forced
// transcript must never read like one the window chose.
function toolDocsLabel(s, promptMode) {
  const byWindow = Tools.promptModeFor(s.ctxSize).compact ? "COMPACT" : "FULL";
  if (promptMode !== "compact" && promptMode !== "full") return byWindow;
  return promptMode.toUpperCase() + " (forced by --prompt-mode; the window " +
    "alone gives " + byWindow + ")";
}

function startModel(cb) {
  const s = Settings.get();
  const modelPath = OPT.model || s.modelPath;
  console.log("-- model:   " + modelPath);
  console.log("-- ctx:     " + s.ctxSize + ", maxRounds " + s.maxRounds +
              ", temp " + s.temperature + ", tool docs " +
              toolDocsLabel(s, OPT.promptMode) +
              ", routing " + (s.promptRouting || "all"));
  Llama.on("status", function (state, detail) {
    if (state === "error") console.log("!! llama: " + detail);
  });
  if (OPT.reuseServer) {
    console.log("-- reusing whatever already listens on " + s.port);
    // What the server says it is, for the transcript: its model file and
    // real window may not be what settings (or --model) claim.
    fetchServerProps(s.port, function (props) {
      SERVER_PROPS = props;
      console.log("-- server:  " + describeServerProps(props));
      cb(null);
    });
    return;
  }
  let settled = false;
  const giveUp = setTimeout(function () {
    if (!settled) { settled = true; cb(new Error("server never came up")); }
  }, 900000);
  Llama.on("status", function (state) {
    if (state === "running" && !settled) {
      settled = true;
      clearTimeout(giveUp);
      cb(null);
    }
  });
  // The same gate main.js puts in front of its own Llama.start (16b).
  // The probe loads models onto a card After Effects is already working
  // on -- that is the field incident's exact shape -- so the instrument
  // has to ask the question the panel asks, or it cannot see the answer.
  // Only a PHYSICAL shortfall stops it; everything else is printed.
  Tools.planChatLoad(Object.assign({}, s, { modelPath: modelPath }),
                     function (plan) {
    if (plan && plan.reason) console.log("-- vram:    " + plan.reason);
    if (plan && plan.mode === "refuse") {
      settled = true;
      clearTimeout(giveUp);
      cb(new Error(plan.reason));
      return;
    }
    Llama.start({
      serverPath: s.serverPath, modelPath: modelPath, port: s.port,
      ctxSize: s.ctxSize, gpuLayers: s.gpuLayers
    }, function (err) {
      if (err && !settled) {
        settled = true;
        clearTimeout(giveUp);
        cb(err);
        return;
      }
      if (!err) {
        Tools.checkVramAfterChatLoad(function (warn) {
          if (warn) console.log("-- vram:    " + warn);
        });
      }
    });
  });
}

// Filled by startModel under --reuse-server: the server's own /props, or
// null when it did not answer.
let SERVER_PROPS = null;

function fetchServerProps(port, cb) {
  const http = require("http");
  let done = false;
  function finish(v) { if (!done) { done = true; cb(v); } }
  const req = http.get({ host: "127.0.0.1", port: port, path: "/props",
                         timeout: 3000 }, function (res) {
    let body = "";
    res.on("data", function (c) { body += c; });
    res.on("end", function () {
      try { finish(JSON.parse(body)); } catch (e) { finish(null); }
    });
  });
  req.on("timeout", function () { req.destroy(); finish(null); });
  req.on("error", function () { finish(null); });
}

// One line from llama-server's /props: the model file it loaded and the
// window it really has. The KV type is NOT in /props, hence --label.
function describeServerProps(props) {
  if (!props) return "did not answer /props — unidentified";
  const gen = props.default_generation_settings || {};
  const nCtx = gen.n_ctx || props.n_ctx;
  return "`" + (props.model_path || "?") + "`, n_ctx " + (nCtx || "?") +
    (props.total_slots ? ", slots " + props.total_slots : "") +
    (props.build_info ? ", build " + props.build_info : "");
}

// The transcript's header lines. Pure, so the stubbed suite can hold it.
function transcriptHeader(stamp, s, opt, serverProps) {
  const out = ["# chat probe " + stamp, "",
    "- model: `" + (opt.model || s.modelPath) + "`",
    "- ctx " + s.ctxSize + ", temperature " + s.temperature +
      ", maxRounds " + s.maxRounds,
    "- tool docs: " + toolDocsLabel(s, opt.promptMode) +
      " (Tools.promptModeFor), routing " + (s.promptRouting || "all")];
  if (opt.label) out.push("- label: " + opt.label);
  if (opt.reuseServer) {
    out.push("- server (reused): " + describeServerProps(serverProps));
  }
  out.push("");
  return out;
}

/*
 * RESUME (NEXT UP 1). Pure, so tests/test-chat-probe.js pins them.
 *
 * A run's key is its POSITION in the expanded selection plus what it
 * says: a paraphrase edited between the kill and the resume is a
 * different measurement and is run again, not reused.
 */
function runKey(run, position) {
  return position + "|" + (run.index + 1) + "|" + run.phrasing + "|" + run.say;
}

// What must be equal for two runs to belong in one table.
function partialHeader(opt, s) {
  return { model: opt.model || s.modelPath, ctx: s.ctxSize,
           temperature: s.temperature, maxRounds: s.maxRounds,
           routing: s.promptRouting || "all",
           promptMode: opt.promptMode || null, steps: opt.steps || null,
           variants: !!opt.variants, isolate: !!opt.isolate,
           carryHistory: !!opt.carryHistory, port: opt.port || null,
           label: opt.label || null };
}

/** Field-by-field differences, each naming both values. */
function headerMismatch(saved, now) {
  const out = [];
  for (const k of Object.keys(now)) {
    if (JSON.stringify(saved[k]) !== JSON.stringify(now[k])) {
      out.push(k + ": file " + JSON.stringify(saved[k]) + ", now " +
               JSON.stringify(now[k]));
    }
  }
  return out;
}

/**
 * A partial file: one {"header"} line, then one {"row"} line per judged
 * run. A torn LAST line is what a kill mid-write leaves and is dropped;
 * a bad line anywhere else means the file is not what it claims.
 */
function readPartial(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  let header = null;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch (e) {
      if (i === lines.length - 1 && header) break;
      return { error: "line " + (i + 1) + " is not JSON" };
    }
    if (i === 0) {
      if (!obj || !obj.header) return { error: "line 1 is not a probe header" };
      header = obj.header;
    } else if (obj && obj.row && typeof obj.row.key === "string") {
      rows.push(obj.row);
    } else {
      return { error: "line " + (i + 1) + " is not a probe row" };
    }
  }
  if (!header) return { error: "the file is empty" };
  return { header: header, rows: rows };
}

/**
 * Where a resumed selection starts. The first run with no saved row is
 * the gap; a run there that does not rebuild its own world (not an
 * --isolate fromRig step, or a `carry` step that needs the turn before
 * it) inherited state a fresh sweep has erased, so back up to the last
 * run that does. Saved rows before that point are kept, the rest re-run.
 */
function resumePoint(chosen, savedKeys, isolate) {
  const have = new Set(savedKeys);
  let gap = chosen.length;
  for (let p = 0; p < chosen.length; p++) {
    if (!have.has(runKey(chosen[p], p))) { gap = p; break; }
  }
  let start = gap;
  while (start > 0 && start < chosen.length &&
         !(isolate && chosen[start].step.fromRig && !chosen[start].step.carry)) {
    start--;
  }
  return { gap: gap, start: start };
}

function writeTranscript(rows) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(ROOT, "logs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "chat-probe-" + stamp + ".md");
  const s = Settings.get();
  const out = transcriptHeader(stamp, s, OPT, SERVER_PROPS);
  if (OPT.variants) {
    // Scenario / phrasing / chosen tool / verdict, the table WORKPLAN
    // section 8 asks for, before the transcripts it summarises.
    out.push("## the paraphrase matrix", "",
             "| # | scenario | phrasing | said | tools | verdict |",
             "|---|----------|----------|------|-------|---------|");
    for (const row of rows) {
      out.push("| " + (row.index + 1) + " | " + row.title + " | " +
               row.phrasing + " | " + String(row.say).replace(/\|/g, "/") +
               " | " + ((row.tools || []).join(" ") || "—") + " | " +
               (row.grade === "harm" ? "**HARM** — " + row.verdict
                 : row.grade === "miss" ? "miss — " + row.verdict : "pass") +
               " |");
    }
    out.push("");
  }
  for (const row of rows) {
    out.push("## " + (row.index + 1) + ". " + row.title +
             (row.phrasing && row.phrasing !== "canonical"
               ? " [" + row.phrasing + "]" : "") +
             " — " + (row.grade === "harm" ? "HARM"
               : row.verdict ? (OPT.variants ? "miss" : "FAIL") : "pass"));
    out.push("");
    if (row.verdict && (row.changes || []).length) {
      out.push("- **changed anyway**: " + row.changes.join("; "));
    }
    for (const line of row.lines) {
      const label = line.label ? " `" + line.label + "`" : "";
      out.push("- **" + line.kind + "**" + label + ": " +
               line.text.replace(/\n/g, " "));
    }
    if (row.verdict) out.push("- **verdict**: " + row.verdict);
    out.push("");
  }
  fs.writeFileSync(file, out.join("\n"), "utf8");
  return file;
}

function main() {
  pickSteps();
  if (!AFTERFX) {
    console.error("AfterFX.exe not found — pass --afterfx <path>");
    process.exit(2);
  }
  console.log("-- AfterFX: " + AFTERFX);
  // Before any measurement: whose settings are these? (Throws unless
  // --defaults-ok when there is no settings file to read.)
  reportSettingsOrigin();
  // Before anything could write one: whose memory store is this? A temp
  // folder unless --store-root names one, never the owner's (§15 item 3).
  const store = ProbeStore.resolve({ storeRoot: OPT.storeRoot,
                                     dataRoot: Settings.dataRoot() });
  for (const line of ProbeStore.describe(store, OPT.keep)) console.log(line);
  if (!store.ok) process.exit(2);
  PROBE_STORE_ROOT = store.root;
  process.on("exit", function () { ProbeStore.cleanup(store, OPT.keep); });

  // --bridge-check: prove the AE round trip works before spending ten
  // minutes loading a model behind it.
  if (OPT.bridgeCheck) {
    const t0 = Date.now();
    Tools.callHostTool("get_project_info", { limit: 5 }, function (info) {
      console.log("get_project_info -> " +
                  JSON.stringify(info).slice(0, 300));
      aeRead(READ_COMP, function (state, err) {
        console.log("probe comp -> " + (err ? err.message
          : JSON.stringify(state).slice(0, 300)));
        console.log("two AE round trips in " +
                    ((Date.now() - t0) / 1000).toFixed(1) + "s");
        process.exit(info && info.ok ? 0 : 1);
      });
    });
    return;
  }

  // --rig-check: build the rig in the REAL AE and check that everything
  // the later sentences name is actually in the comp. No model, so it
  // runs in seconds — and a rig that has quietly stopped building one of
  // its fixtures is a step failing every night for a reason that is not
  // the model's, which is the one thing an isolated run must not do.
  if (OPT.rigCheck) {
    // BOTH rigs, one after the other: the finished world the trigger
    // steps inherit and the unfinished one the usefulness rows start
    // from. Checking only the first would let the second rot silently.
    const variants = [null, "icons"];
    const bad = [];
    (function next(vi) {
      if (vi >= variants.length) {
        for (const m of bad) console.log("FAIL " + m);
        console.log(bad.length ? bad.length + " rig problem(s)"
                               : "rigs OK — every fixture the steps name " +
                                 "is in the comp");
        if (OPT.keep) { process.exit(bad.length ? 1 : 0); return; }
        aeRead(sweepScript(), function (res2) {
          console.log("cleanup: removed " +
                      ((res2 && res2.removed) || 0) + " item(s)");
          process.exit(bad.length ? 1 : 0);
        });
        return;
      }
      const variant = variants[vi], label = variant || "full";
      aeRead(sweepScript(), function (swept) {
        console.log("[" + label + "] swept " +
                    ((swept && swept.removed) || 0) + " item(s)");
        aeRead(rigScript(variant), function (rig, rigErr) {
          if (rigErr) {
            console.error("!! " + rigErr.message); process.exit(1); return;
          }
          console.log("[" + label + "] rig: " + rig.built + " commands, " +
                      (rig.failed.length ? "FAILED — " + rig.failed.join("; ")
                                         : "all ok"));
          aeRead(READ_COMP, function (state, err) {
            if (err) { console.error("!! " + err.message); process.exit(1); }
            for (const m of rig.failed) bad.push("[" + label + "] " + m);
            for (const m of rigProblems(variant, state)) {
              bad.push("[" + label + "] " + m);
            }
            next(vi + 1);
          });
        });
      });
    })(0);
    return;
  }

  const chosen = variantRuns(pickSteps(), OPT.variants);
  const rows = [];
  // Every judged run goes to the partial file as it lands (see RESUME).
  const header = partialHeader(OPT, Settings.get());
  let first = 0, partialFile = OPT.resume;
  if (OPT.resume) {
    const saved = readPartial(fs.readFileSync(OPT.resume, "utf8"));
    const diff = headerMismatch(saved.header, header);
    if (diff.length) {
      console.error("!! --resume " + OPT.resume + " was measured with " +
                    "different flags — " + diff.join("; "));
      process.exit(2);
    }
    const byKey = {};
    for (const r of saved.rows) byKey[r.key] = r;
    const pt = resumePoint(chosen, Object.keys(byKey), OPT.isolate);
    for (let p = 0; p < pt.start; p++) rows.push(byKey[runKey(chosen[p], p)]);
    first = pt.start;
    console.log("-- resuming " + OPT.resume + ": " + rows.length + " of " +
                chosen.length + " run(s) kept" +
                (pt.start < pt.gap ? ", backing up " + (pt.gap - pt.start) +
                  " run(s) to one that rebuilds its own world" : ""));
  } else {
    const dir = path.join(ROOT, "logs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    partialFile = path.join(dir, "chat-probe-" + new Date().toISOString()
      .replace(/[:.]/g, "-").slice(0, 19) + ".partial.jsonl");
  }
  // Rewritten, not appended: saved rows past the resume point are stale.
  fs.writeFileSync(partialFile, [{ header: header }].concat(
    rows.map(r => ({ row: r }))).map(o => JSON.stringify(o) + "\n").join(""),
    "utf8");
  console.log("-- partial results: " + partialFile +
              " (a killed run continues with --resume <that file>)");
  if (OPT.variants) {
    const stepCount = new Set(chosen.map(r => r.index)).size;
    console.log("-- variants: " + chosen.length + " run(s) over " +
                stepCount + " step(s) — the rig is rebuilt for each");
    const bare = chosen.filter(r => r.phrasing === "canonical" &&
      !(STEPS[r.index].variants || []).length).map(r => STEPS[r.index].title);
    if (bare.length) {
      console.log("-- no paraphrases declared for: " + bare.join("; "));
    }
  }

  startModel(function (err) {
    if (err) {
      console.error("!! could not start the model: " + err.message);
      process.exit(3);
    }
    console.log("-- model ready");
    // Clear the decks BEFORE the first prompt: the comp name has to be
    // free or create_comp auto-numbers away from what the verdicts read.
    aeRead(sweepScript(), function (res) {
      console.log("-- cleared " + ((res && res.removed) || 0) +
                  " leftover item(s)\n");
      next(first);
    });
  });

  function next(k) {
    if (k >= chosen.length) { finish(); return; }
    const run = chosen[k];
    const idx = run.index;
    const step = run.step;
    const mark = transcript.length;
    console.log("\n=== step " + (idx + 1) + ": " + step.title +
                (run.phrasing === "canonical" ? ""
                  : " [" + run.phrasing + "]") + " ===");
    resetWorld(step, function () {
    // How the comp looked BEFORE the sentence: a step that refers back to
    // an earlier turn is judged on what changed, not on absolutes. A
    // fixture the step plants goes in first, so it is part of "before".
    runPrepare(step, function () {
    aeRead(READ_COMP, function (before) {
      aeRead(SIG_FN + " return sig();", function (sigBefore) {
        const runsBefore = probeRuns;
        const restoreSettings = applyStepSettings(step.settings);
        sendMessage(run.say, function (round) {
          aeRead(READ_COMP, function (state, readErr) {
            const ctx = { before: before && before.found ? before : null,
                          rounds: round.rounds,
                          toolRounds: round.toolRounds,
                          rolledBack: round.rolledBack, undo: null,
                          // Sampled AFTER the round: a tool that refuses a
                          // job is not allowed to have unloaded the chat
                          // model on the way to saying no.
                          chatState: Llama.getState(),
                          tools: round.tools, replies: round.replies };
            if (!step.undo) { judge(state, readErr, ctx); return; }
            measureUndo(sigBefore, runsBefore, function (u) {
              ctx.undo = u;
              if (u && u.changed && u.undos >= 0) {
                say("info", "one sentence, " + u.undos + " Ctrl+Z (" +
                    round.toolRounds + " tool round(s)) — comp restored");
              } else if (u && !u.changed) {
                say("info", "nothing changed, so nothing to undo");
              } else if (u) {
                say("info", "not restored after " + u.tried + " undo(s) " +
                    "(cap " + u.cap + ")");
              }
              judge(state, readErr, ctx);
            });
          });
        });

        function judge(state, readErr, ctx) {
          restoreSettings();
          let verdict = null;
          if (readErr) verdict = "could not read the comp: " + readErr.message;
          // A check that throws used to kill the whole run mid-sweep, so
          // the steps after it were never even asked. Most checks reach
          // straight into state.layers, which does not exist when the rig
          // comp is missing — the shape of "you ran a later step without
          // the earlier ones that build the rig". That is a verdict, not
          // a crash.
          else {
            try {
              verdict = step.check(state, ctx) || null;
            } catch (e) {
              verdict = "the step's check could not run: " + e.message +
                (state && !state.found
                  ? " — no comp called " + COMP + " exists; steps 1-11 " +
                    "build the rig the later steps name, so run them in " +
                    "the same --steps list"
                  : "");
            }
          }
          // What the sentence actually did to the comp, whatever the
          // verdict thinks of it — the line between a harmless miss and
          // a harmful one. Read off the two states already in hand.
          // `state` goes in raw, found:false and all: a sentence that
          // deleted the whole comp is the loudest change there is, and
          // filtering it out here would score it a harmless miss.
          const changes = compDiff(ctx.before, state);
          const grade = gradeRun(verdict, changes);
          if (verdict) {
            say("verdict", (OPT.variants ? (grade === "harm"
              ? "HARM — " : "miss — ") : "FAIL — ") + verdict);
            if (OPT.variants && changes.length) {
              say("info", "the comp changed anyway: " +
                  changes.slice(0, 8).join("; ") +
                  (changes.length > 8
                    ? " (+" + (changes.length - 8) + " more)" : ""));
            } else if (OPT.variants) {
              say("info", "nothing in the comp moved — harmless");
            }
          } else say("verdict", "pass (" + summary(ctx) + ")");
          const row = { key: runKey(run, k),
                        index: idx, title: step.title, verdict: verdict,
                        phrasing: run.phrasing, say: run.say, grade: grade,
                        changes: changes,
                        tools: (ctx.tools || []).map(t => t.tool),
                        lines: transcript.slice(mark) };
          rows.push(row);
          fs.appendFileSync(partialFile, JSON.stringify({ row: row }) + "\n",
                            "utf8");
          next(k + 1);
        }
        function summary(ctx) {
          return ctx.rounds + " round(s)" +
                 (ctx.undo ? ", " + ctx.undo.undos + " Ctrl+Z" : "");
        }
      });
    });
    });
    });
  }

  /*
   * Everything a step is allowed to inherit, decided in one place.
   *
   * HISTORY resets by default (see the header): only a `carry` step, or
   * --carry-history, keeps the previous sentence's conversation. A carry
   * step whose predecessor did not run in this selection is SAID so —
   * it will still be judged, but its pronoun has nothing behind it and
   * the transcript must not read as though it did.
   *
   * The COMP resets only under --isolate, and only for a `fromRig` step:
   * steps 1-14 build the world through the model on purpose, and that
   * building IS their coverage.
   */
  function resetWorld(step, cb) {
    if (!OPT.carryHistory && !step.carry) resetHistory();
    else if (step.carry && !history.length) {
      say("info", "this step refers back to the turn before it, and no " +
          "earlier turn ran in this selection — its pronoun has nothing " +
          "to resolve against");
    }
    if (!OPT.isolate || !step.fromRig) { cb(); return; }
    // `fromRig` is true for the finished world and names a VARIANT for
    // any other — the usefulness rows start from "icons", the
    // unfinished one, because what they ask for is what it lacks.
    const variant = step.fromRig === true ? null : step.fromRig;
    aeRead(sweepScript(), function (swept) {
      aeRead(rigScript(variant), function (rig, err) {
        if (err) { say("error", "the rig could not be built: " + err.message); }
        else if (rig && rig.failed && rig.failed.length) {
          say("error", "the rig came up short — " + rig.failed.join("; "));
        } else {
          say("info", "rig rebuilt (" + (variant || "full") + ": " +
              ((swept && swept.removed) || 0) + " item(s) swept, " +
              ((rig && rig.built) || 0) + " commands)");
        }
        cb();
      });
    });
  }

  /** Press Undo until the comp matches `sigBefore`, never past our own work. */
  function measureUndo(sigBefore, runsBefore, cb) {
    if (typeof sigBefore !== "string" || !sigBefore) {
      cb({ error: "no signature to compare against" });
      return;
    }
    const cap = Math.max(0, probeRuns - runsBefore);
    if (!cap) { cb({ changed: false, undos: 0, cap: 0 }); return; }
    aeRead(undoProbe(sigBefore, cap), function (res, err) {
      cb(err ? { error: err.message } : res);
    });
  }

  function finish() {
    const failed = rows.filter(r => r.verdict);
    const file = writeTranscript(rows);
    console.log("\n----");
    console.log((rows.length - failed.length) + "/" + rows.length +
                (OPT.variants ? " runs" : " steps") + " met their verdict");
    let problems = [];
    if (!OPT.variants) {
      for (const r of failed) {
        console.log("FAIL " + (r.index + 1) + ". " + r.title + " — " +
                    r.verdict);
      }
    } else {
      // The matrix, one line per phrasing, grouped by scenario — the
      // shape WORKPLAN section 8 asks to be appended to the log:
      // scenario / phrasing / chosen tool / verdict.
      console.log("");
      let lastIdx = -1;
      for (const r of rows) {
        if (r.index !== lastIdx) {
          lastIdx = r.index;
          console.log((r.index + 1) + ". " + r.title);
        }
        const mark = { pass: "  pass", miss: "  miss", harm: "  HARM" };
        console.log(mark[r.grade] + "  " + r.phrasing.padEnd(9) +
                    " [" + (r.tools.length ? r.tools.join(" ") : "no tools") +
                    "]  \"" + r.say + "\"" +
                    (r.verdict ? "\n            " + r.verdict : ""));
      }
      problems = gradeMatrix(rows);
      const tally = g => rows.filter(r => r.grade === g).length;
      console.log("\n" + tally("pass") + " pass, " + tally("miss") +
                  " miss, " + tally("harm") + " HARM");
      if (problems.length) {
        console.log("");
        for (const p of problems) console.log("!! " + p);
      } else {
        console.log("acceptance met: no harm, every canonical passed, no " +
                    "scenario missed more than one paraphrase");
      }
    }
    console.log("transcript: " + file);
    const bad = OPT.variants ? problems.length : failed.length;
    const done = function () {
      try { Llama.stop(); } catch (e) {}
      process.exit(bad ? 1 : 0);
    };
    if (OPT.keep) { done(); return; }
    aeRead(sweepScript(precomps), function (res) {
      let removed = (res && res.removed) || 0;
      const finishCleanup = function () {
        console.log("cleanup: removed " + removed + " project item(s)");
        if (generated.files.length) {
          console.log("generated file(s) LEFT on disk as evidence:\n  " +
                      generated.files.join("\n  "));
        }
        done();
      };
      if (!generated.itemIds.length) { finishCleanup(); return; }
      aeRead(sweepImports(generated.itemIds), function (res2) {
        removed += (res2 && res2.removed) || 0;
        finishCleanup();
      });
    });
  }
}

/*
 * Required rather than run: hand the verdicts to tests/test-chat-probe.js
 * so the CHECKS themselves are regression-tested against synthetic comp
 * states, with no AE and no model. Nothing above this line runs on
 * require — main() is the only thing that talks to AE.
 */
if (require.main === module) {
  main();
} else {
  module.exports = { STEPS, parseSteps, squares, transcriptHeader, probePromptOpts, toolDocsLabel, describeServerProps, undoProbe, SIG_FN, READ_COMP,
                     bridgeWrapper, sweepImports, samePath, rememberGenerated,
                     generated, runPrepare, sweepScript, rememberPrecomp,
                     precomps, toolEntry, rigPlan, rigScript, resetHistory,
                     COMP, textLayer, betaLayer, rigNull, nineSquares,
                     // The second rig and the fixtures the A/B/C/E
                     // usefulness rows name, plus the pure "what did the
                     // rig fail to build" list both --rig-check and the
                     // stubbed suite run.
                     rigProblems, iconRigPlan, iconLayers, bgLayer,
                     headline, hasEffect, RIG_ICONS, RIG_SQUARES,
                     ICON_BG, ICON_TEXT, ICON_FONT_SIZE, ICON_SPOTS,
                     // The paraphrase matrix: the three-way grade, the
                     // change detector it rests on, the run expansion and
                     // the acceptance gate — all pure, all testable with
                     // neither AE nor a model.
                     compDiff, gradeRun, variantRuns, gradeMatrix,
                     // Resume after a killed run (NEXT UP 1).
                     runKey, partialHeader, headerMismatch, readPartial,
                     resumePoint,
                     // For scripts/context-budget-probe.js: the REAL round
                     // loop, the REAL panel modules and the REAL AE bridge,
                     // so the context measurements are taken on the product
                     // path instead of a second copy of it.
                     sendMessage, setRoundObserver, history, transcript, say,
                     aeEval, aeRead, startModel, Tools, Settings, Llama,
                     AFTERFX, sessionNotices };
}
