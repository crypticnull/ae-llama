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
 *   node scripts/chat-probe.js --keep           # do not delete the comp
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

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}
const OPT = {
  steps: argValue("--steps"),
  model: argValue("--model"),
  keep: argv.indexOf("--keep") !== -1,
  afterFX: argValue("--afterfx"),
  reuseServer: argv.indexOf("--reuse-server") !== -1,
  bridgeCheck: argv.indexOf("--bridge-check") !== -1
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

const storage = {};
let probeRuns = 0;
const window = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  localStorage: {
    getItem(k) { return Object.prototype.hasOwnProperty.call(storage, k)
      ? storage[k] : null; },
    setItem(k, v) { storage[k] = String(v); },
    removeItem(k) { delete storage[k]; }
  },
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
  new Function("window", src)(window);
}
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
loadPanelFile("tools.js");

const Settings = window.Settings;
const Llama = window.Llama;
const Tools = window.Tools;
const Comfy = window.Comfy;

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

  aeEval("if ($.global.AELL_newRequest) $.global.AELL_newRequest();",
    function () {
      Tools.fetchProjectState(function (stateJson) {
        const system = Tools.buildSystemPrompt(stateJson);
        runRound(system, 0);
      });
    });

  function runRound(system, n) {
    round.rounds = n + 1;
    // In step with main.js: bound what the model is sent, or a long chat
    // dies on a raw HTTP 400. The probe found that bug by being the only
    // thing that holds a ten-turn conversation, so it has to carry the
    // fix too — otherwise it would keep reporting a failure the panel no
    // longer has.
    let histBudget = Math.max(4000, (s.ctxSize - 3600) * 3 - system.length);
    if (round.forceTinyContext) histBudget = 1;
    const fitted = Tools.fitHistory(history, histBudget);
    let sys = system;
    if (fitted.dropped > 0) {
      sys += "\n\n(NOTE: " + fitted.dropped + " earlier message(s) " +
        "were trimmed from your context to fit the model's window. " +
        "The transcript the user sees is complete — if they refer to " +
        "something you cannot see, say so and ask, do not guess.)";
      if (!round.trimNoticeShown) {
        round.trimNoticeShown = true;
        say("info", "context trimmed — " + fitted.dropped +
            " earlier message(s) dropped from what the model is sent");
      }
      round.trimmed = (round.trimmed || 0) + fitted.dropped;
    }
    const messages = [{ role: "system", content: sys }]
      .concat(fitted.entries);
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
          { dryRun: false, allowRollback: rollbackBudget > 0 },
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
              return;
            }
            round.tools.push({ tool: cmd.tool, args: cmd.args || {},
                               ok: !!result.ok, data: result.data || null,
                               error: result.error || null });
            rememberGenerated(cmd.tool, result);
            const body = result.ok
              ? "ok" + (result.data
                  ? ": " + JSON.stringify(result.data).slice(0, 400) : "")
              : "ERROR: " + result.error;
            if (!result.ok) round.failures.push(head + " -> " + result.error);
            say(result.ok ? "tool" : "error", body, head);
          },
          function (results) {
            history.push({ role: "user",
              content: "TOOL RESULTS:\n" + compactToolResults(results) });
            if (n + 1 >= s.maxRounds) {
              say("info", "Stopped after " + s.maxRounds + " tool rounds.");
              done(round);
              return;
            }
            runRound(system, n + 1);
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
  "    isNull: false, isSolid: false, sourceFile: null };" +
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

/* Remove every comp this probe made, plus the solid footage it left
 * behind (only when nothing else uses it). Direct ExtendScript rather
 * than delete_item: a LEFTOVER comp is worse than a messy project — the
 * model's create_comp gets auto-numbered to "Probe Room 2" while the
 * verdicts below still read "Probe Room", so every check silently
 * inspects the previous run's comp. That happened. */
const SWEEP =
  "var killed = 0, i, it;" +
  "for (i = app.project.numItems; i >= 1; i--) {" +
  "  it = app.project.item(i);" +
  "  if (it instanceof CompItem && it.name.indexOf(" +
  JSON.stringify(COMP) + ") === 0) { it.remove(); killed++; }" +
  "}" +
  "for (i = app.project.numItems; i >= 1; i--) {" +
  "  it = app.project.item(i);" +
  "  if (!(it instanceof FootageItem)) continue;" +
  "  if (!/^(Red Square|White Ellipse|Rig)/.test(it.name)) continue;" +
  "  try { if (it.usedIn.length === 0) { it.remove(); killed++; } }" +
  "  catch (e) {}" +
  "}" +
  "return { removed: killed };";

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

const STEPS = [
  {
    title: "create a comp",
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
    title: "text layer",
    say: "Add a text layer to Probe Room that says HELLO, white, 120 " +
         "pixels, near the top of the frame.",
    check(state) {
      const t = state.layers.filter(l => l.isText);
      if (!t.length) return "no text layer in the comp";
      if (!t.some(l => /HELLO/i.test(l.text || ""))) {
        return "text layers say " + JSON.stringify(t.map(l => l.text));
      }
      return null;
    }
  },
  {
    title: "mask",
    say: "Put an oval mask on the HELLO layer and feather it 20 pixels.",
    check(state) {
      const t = state.layers.filter(l => l.isText);
      if (!t.length) return "the HELLO layer is gone";
      if (!t.some(l => l.masks > 0)) return "the text layer has no masks";
      return null;
    }
  },
  {
    title: "track matte",
    say: "Add a white ellipse shape layer above the top square and use it " +
         "as an alpha track matte for that square.",
    check(state) {
      if (!state.layers.some(l => l.isShape)) {
        return "no shape layer was created";
      }
      const matted = state.layers.filter(l => l.matte && l.matte !== 5013);
      if (!matted.length) return "no layer has a track matte set";
      return null;
    }
  },
  {
    title: "equidistant distribution",
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
  }
];

// ------------------------------------------------------------------ run

function pickSteps() {
  if (!OPT.steps) return STEPS.map((s, i) => i);
  return OPT.steps.split(",")
    .map(n => parseInt(n, 10) - 1)
    .filter(i => i >= 0 && i < STEPS.length);
}

function startModel(cb) {
  const s = Settings.get();
  const modelPath = OPT.model || s.modelPath;
  console.log("-- model:   " + modelPath);
  console.log("-- ctx:     " + s.ctxSize + ", maxRounds " + s.maxRounds +
              ", temp " + s.temperature);
  Llama.on("status", function (state, detail) {
    if (state === "error") console.log("!! llama: " + detail);
  });
  if (OPT.reuseServer) {
    console.log("-- reusing whatever already listens on " + s.port);
    cb(null);
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
  Llama.start({
    serverPath: s.serverPath, modelPath: modelPath, port: s.port,
    ctxSize: s.ctxSize, gpuLayers: s.gpuLayers
  }, function (err) {
    if (err && !settled) {
      settled = true;
      clearTimeout(giveUp);
      cb(err);
    }
  });
}

function writeTranscript(rows) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(ROOT, "logs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "chat-probe-" + stamp + ".md");
  const s = Settings.get();
  const out = ["# chat probe " + stamp, "",
    "- model: `" + (OPT.model || s.modelPath) + "`",
    "- ctx " + s.ctxSize + ", temperature " + s.temperature +
      ", maxRounds " + s.maxRounds, ""];
  for (const row of rows) {
    out.push("## " + (row.index + 1) + ". " + row.title +
             " — " + (row.verdict ? "FAIL" : "pass"));
    out.push("");
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
  if (!AFTERFX) {
    console.error("AfterFX.exe not found — pass --afterfx <path>");
    process.exit(2);
  }
  console.log("-- AfterFX: " + AFTERFX);

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

  const chosen = pickSteps();
  const rows = [];

  startModel(function (err) {
    if (err) {
      console.error("!! could not start the model: " + err.message);
      process.exit(3);
    }
    console.log("-- model ready");
    // Clear the decks BEFORE the first prompt: the comp name has to be
    // free or create_comp auto-numbers away from what the verdicts read.
    aeRead(SWEEP, function (res) {
      console.log("-- cleared " + ((res && res.removed) || 0) +
                  " leftover item(s)\n");
      next(0);
    });
  });

  function next(k) {
    if (k >= chosen.length) { finish(); return; }
    const idx = chosen[k];
    const step = STEPS[idx];
    const mark = transcript.length;
    console.log("\n=== step " + (idx + 1) + ": " + step.title + " ===");
    // How the comp looked BEFORE the sentence: a step that refers back to
    // an earlier turn is judged on what changed, not on absolutes.
    aeRead(READ_COMP, function (before) {
      aeRead(SIG_FN + " return sig();", function (sigBefore) {
        const runsBefore = probeRuns;
        sendMessage(step.say, function (round) {
          aeRead(READ_COMP, function (state, readErr) {
            const ctx = { before: before && before.found ? before : null,
                          rounds: round.rounds,
                          toolRounds: round.toolRounds,
                          rolledBack: round.rolledBack, undo: null,
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
          let verdict = null;
          if (readErr) verdict = "could not read the comp: " + readErr.message;
          else verdict = step.check(state, ctx) || null;
          if (verdict) say("verdict", "FAIL — " + verdict);
          else say("verdict", "pass (" + summary(ctx) + ")");
          rows.push({ index: idx, title: step.title, verdict: verdict,
                      lines: transcript.slice(mark) });
          next(k + 1);
        }
        function summary(ctx) {
          return ctx.rounds + " round(s)" +
                 (ctx.undo ? ", " + ctx.undo.undos + " Ctrl+Z" : "");
        }
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
                " steps met their verdict");
    for (const r of failed) {
      console.log("FAIL " + (r.index + 1) + ". " + r.title + " — " +
                  r.verdict);
    }
    console.log("transcript: " + file);
    const done = function () {
      try { Llama.stop(); } catch (e) {}
      process.exit(failed.length ? 1 : 0);
    };
    if (OPT.keep) { done(); return; }
    aeRead(SWEEP, function (res) {
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
  module.exports = { STEPS, squares, undoProbe, SIG_FN, READ_COMP,
                     bridgeWrapper, sweepImports, samePath, rememberGenerated,
                     generated };
}
