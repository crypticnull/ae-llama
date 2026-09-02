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
const Llama = window.Llama;
const Tools = window.Tools;
const Comfy = window.Comfy;

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

  aeEval("if ($.global.AELL_newRequest) $.global.AELL_newRequest();",
    function () {
      Tools.fetchProjectState(function (stateJson) {
        // In step with main.js: the prompt form follows the window.
        const system = Tools.buildSystemPrompt(
          stateJson, Tools.promptModeFor(s.ctxSize));
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
    const hb = Tools.historyBudget(s.ctxSize, system.length);
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
  "    isNull: false, isSolid: false, sourceFile: null," +
  "    matteLayer: null, matteLayerKnown: false, isPrecomp: false," +
  "    anchorPoint: null, opacity: null," +
  "    sourceRect: null, layerWidth: null, layerHeight: null, maskBoxes: []," +
  "    maskModes: [], maskInverted: []," +
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
  "        row.maskModes.push(mm === MaskMode.SUBTRACT ? 'subtract'" +
  "          : mm === MaskMode.ADD ? 'add' : 'other');" +
  "        row.maskInverted.push(!!mk.inverted);" +
  "      } catch (emm) {" +
  "        row.maskModes.push('unknown'); row.maskInverted.push(false);" +
  "      }" +
  "      var vs = mk.property('ADBE Mask Shape').value.vertices;" +
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
  if (tool !== "precompose" || !result || !result.ok || !result.data) return;
  const d = result.data;
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
 * BEFORE the footage pass so the solids are unused by the time it looks. */
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
    "  if (!/^(Red Square|White Ellipse|Rig)/.test(it.name)) continue;" +
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
      const matted = state.layers.filter(hasMatte);
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
    tool: "set_layer_timing",
    say: "Beta shouldn't show up until two seconds in — delay it.",
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
    tool: "set_layer_parent",
    say: "Make Beta tag along with the Rig null wherever it goes.",
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
    tool: "apply_keyframe_ease",
    say: "The squares fade in too mechanically — make it feel smoother.",
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
    tool: "center_anchor_point",
    say: "HELLO swings around its corner when it rotates — make it turn " +
         "about its own centre.",
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
    tool: "add_mask",
    say: "Chop off the lower half of Beta so only the top shows.",
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
      const W = b.layerWidth, H = b.layerHeight;
      const boxes = (b.maskBoxes || []).slice(had);
      const modes = (b.maskModes || []).slice(had);
      const inv = (b.maskInverted || []).slice(had);
      if (W && H && boxes.length) {
        if (!boxes.some(bx => bx[2] * bx[3] < 0.8 * W * H)) {
          return "the new mask covers the whole " + W + "x" + H + " layer (" +
                 JSON.stringify(boxes) + ") — it hides nothing";
        }
        // A band the full width of the layer and half its height: over
        // the TOP half (add mode keeps what it covers), or over the
        // BOTTOM half when the mask subtracts or is inverted. A dot, a
        // sliver or a band in the wrong place hides the wrong thing.
        const band = boxes.some((bx, i) => {
          const fullWide = bx[2] >= 0.9 * W;
          const half = Math.abs(bx[3] - H / 2) <= 0.15 * H;
          const top = Math.abs(bx[1]) <= 0.1 * H;
          const bottom = Math.abs(bx[1] - H / 2) <= 0.1 * H &&
            (modes[i] === "subtract" || inv[i] === true);
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
    tool: "delete_mask",
    say: "Lose the oval mask on HELLO — it's not needed any more.",
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
    tool: "remove_keyframes",
    say: "The squares shouldn't fade in any more — just have them there " +
         "from the start.",
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
    tool: "apply_preset",
    say: "Dress HELLO up a bit — it looks too plain.",
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
    tool: "apply_expression_preset",
    say: "Give Beta a lazy, floaty hover so it never sits completely still.",
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
    tool: "audio_to_keyframes",
    say: "Make Beta throb in time with the music.",
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
      const declined = new RegExp(
        "\\b(?:can(?:no|')?t|cannot|could\\s?n['o]t|unable|no audio|" +
        "(?:there(?: is|'s)|is|has|have) no|isn'?t any|does ?n['o]t " +
        "(?:have|contain)|without|missing|not (?:found|present)|" +
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
    tool: "reorder_layers",
    say: "Beta is covering HELLO — tuck it in underneath the text.",
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
    tool: "remove_effect",
    prepare: "AELL_call(\"apply_effect\", " + JSON.stringify(JSON.stringify(
      { comp: COMP, layer: "Beta", effect: "Gaussian Blur" })) + ")",
    say: "Beta doesn't need that blur any more — strip it off.",
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
    tool: "set_track_matte",
    say: "I want Beta to show only through the HELLO letters.",
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
    tool: "precompose",
    say: "Bundle the nine blue squares into a single layer called Squares.",
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
    say: "Probe Room is a mess now — clean it up.",
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
              ", temp " + s.temperature + ", tool docs " +
              (Tools.promptModeFor(s.ctxSize).compact ? "COMPACT" : "FULL"));
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
      ", maxRounds " + s.maxRounds,
    "- tool docs: " +
      (Tools.promptModeFor(s.ctxSize).compact ? "COMPACT" : "FULL") +
      " (Tools.promptModeFor)", ""];
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
    aeRead(sweepScript(), function (res) {
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
    // an earlier turn is judged on what changed, not on absolutes. A
    // fixture the step plants goes in first, so it is part of "before".
    runPrepare(step, function () {
    aeRead(READ_COMP, function (before) {
      aeRead(SIG_FN + " return sig();", function (sigBefore) {
        const runsBefore = probeRuns;
        const restoreSettings = applyStepSettings(step.settings);
        sendMessage(step.say, function (round) {
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
  module.exports = { STEPS, squares, undoProbe, SIG_FN, READ_COMP,
                     bridgeWrapper, sweepImports, samePath, rememberGenerated,
                     generated, runPrepare, sweepScript, rememberPrecomp,
                     precomps, toolEntry,
                     // For scripts/context-budget-probe.js: the REAL round
                     // loop, the REAL panel modules and the REAL AE bridge,
                     // so the context measurements are taken on the product
                     // path instead of a second copy of it.
                     sendMessage, setRoundObserver, history, transcript, say,
                     aeEval, aeRead, startModel, Tools, Settings, Llama,
                     AFTERFX, sessionNotices };
}
