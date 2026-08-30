/*
 * weight-availability-probe.js — WORKPLAN item 7: the panel decides a model
 * is available by looking at the DISK, and the backend decides by its own
 * search path. On this machine the two disagree, and the disagreement costs
 * a user a full VRAM handoff for a job that was never runnable.
 *
 * The two questions are genuinely different and both sources are needed:
 * the DISK knows how big a weight is (/object_info carries no sizes, and the
 * size is what the arbiter's arithmetic runs on), and the BACKEND knows
 * whether it can OPEN it (the disk cannot know the search path). This probe
 * asks both, through the panel's own code, against the real backend:
 *
 *   settings.js + tiers.js + comfy.js + tools.js        (the panel)
 *     -> Comfy.missingWeights + Tools._weightRefusalFor (the new check)
 *     -> Tools.executeCommands([comfy_generate])        (the real path)
 *     -> a REAL local ComfyUI's /object_info            (the ground truth)
 *
 * The verdicts are INVARIANTS, not a table read by eye:
 *
 *   1. a template whose weights the backend lists is never refused;
 *   2. a template whose weights it does NOT list is refused, and the
 *      sentence names every missing file AND where it sits on disk;
 *   3. the panel still PRICES that same template off the disk — that is
 *      the disagreement, stated as a number;
 *   4. an unreachable backend refuses NOTHING (the check may never invent
 *      a failure it could not measure);
 *   5. the refusal arrives through the real comfy_generate path with the
 *      chat model still loaded and ComfyUI never queued.
 *
 * NO After Effects: nothing is generated and nothing is imported, so no
 * dialog can be raised and the user's project is never touched.
 *
 *   node scripts/weight-availability-probe.js
 *   node scripts/weight-availability-probe.js --url http://127.0.0.1:8188
 *
 * Writes a markdown transcript to logs/ and exits 0 only if every verdict
 * passed.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const OPT = { url: argValue("--url", null) };

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
const Tools = window.Tools;

/* The user's REAL settings, with only the workflow dir pinned to the REPO's
 * shipped templates (an install copy can be stale) and the output dir moved
 * out of the user's generated/. */
const OUT_DIR = path.join(ROOT, "logs", "weight-availability-probe");
const OVERRIDE = {
  comfyWorkflowsDir: path.join(EXT, "comfy-workflows"),
  comfyOutDir: OUT_DIR,
  comfyTimeoutSec: 60
};
if (OPT.url) OVERRIDE.comfyUrl = OPT.url;
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

// ------------------------------------------------------------------- probe

const s = Settings.get();
say("info", "ComfyUI URL: " + s.comfyUrl);
say("info", "Workflow dir: " + s.comfyWorkflowsDir);

const templates = Comfy.listWorkflows(s.comfyWorkflowsDir)
  .filter((w) => /^AE_LLAMA_/.test(w.name));
say("info", "Shipped templates: " +
    templates.map((w) => w.name).join(", "));

function measure(w, next) {
  const manifest = Comfy.readManifest(w.file);
  const graph = Comfy.loadWorkflow(w.file);
  const priced = Tools._genNeedMBFor(manifest, s);
  Comfy.missingWeights(s.comfyUrl, graph, function (err, res) {
    if (err) {
      say("error", w.name + ": " + err.message);
      next({ name: w.name, error: err, priced: priced });
      return;
    }
    say("info", w.name + ": backend checked " + res.checked +
        " weight slot(s), " + res.missing.length + " it cannot load; " +
        "panel prices it off disk at " +
        (priced === null ? "null" : priced + " MiB"));
    for (const m of res.missing) {
      say("tool", "   missing: " + m.value + "  (node " + m.node + " " +
          m.classType + "." + m.input + ", server lists " +
          m.choiceCount + " other choice(s))");
    }
    Tools._weightRefusalFor(s, w.file, manifest, function (refusal) {
      if (refusal) say("tool", "   refusal: " + refusal.error);
      next({ name: w.name, missing: res.missing, checked: res.checked,
             priced: priced, refusal: refusal, manifest: manifest });
    });
  });
}

const results = [];
(function nextTemplate(i) {
  if (i >= templates.length) { unreachableCheck(); return; }
  measure(templates[i], function (r) {
    results.push(r);
    nextTemplate(i + 1);
  });
})(0);

function unreachableCheck() {
  // ---- verdicts 1-3, over whatever this machine actually has -------------
  const loadable = results.filter((r) => r.missing && !r.missing.length);
  const blocked = results.filter((r) => r.missing && r.missing.length);

  verdict(results.some((r) => r.checked > 0),
          "the backend answered about at least one weight slot",
          "checked " + results.map((r) => r.name + "=" + r.checked).join(", "));

  verdict(loadable.every((r) => !r.refusal),
          "a template whose weights the backend LISTS is not refused",
          loadable.length
            ? loadable.map((r) => r.name).join(", ")
            : "no fully-loadable template on this machine");

  if (!blocked.length) {
    say("info", "No template on this backend is missing weights, so the " +
        "disagreement this probe exists for is not reproducible here " +
        "today — verdicts 2 and 3 are reported as skipped, not passed.");
  }
  for (const r of blocked) {
    verdict(!!r.refusal, r.name + ": missing weights produce a refusal");
    const text = r.refusal ? r.refusal.error : "";
    verdict(r.missing.every((m) => text.indexOf(m.value) !== -1),
            r.name + ": the refusal names EVERY file the backend rejected",
            r.missing.length + " file(s)");
    // Where they sit on disk is the sentence that tells a user their
    // backend is pointed at the wrong root.
    const onDisk = r.missing
      .map((m) => Tools._describeMissingWeights([m], r.manifest, s))
      .filter((t) => /on disk at /.test(t)).length;
    verdict(onDisk === r.missing.length,
            r.name + ": every missing file is located ON DISK in the refusal",
            onDisk + "/" + r.missing.length);
    verdict(typeof r.priced === "number" && r.priced > 0,
            r.name + ": …while the panel still PRICES it off the disk — " +
            "that is the disagreement",
            r.priced + " MiB the arbiter would have paused chat for");
  }

  // ---- verdict 4: a backend that cannot be asked refuses NOTHING --------
  const dead = Object.assign({}, s, { comfyUrl: "http://127.0.0.1:1" });
  const any = results[0];
  Tools._weightRefusalFor(dead, templates[0].file, any.manifest,
    function (refusal) {
      verdict(!refusal,
              "an UNREACHABLE backend refuses nothing — the check may " +
              "never invent a failure it could not measure",
              refusal ? "refused: " + refusal.error : "silent, as designed");
      realPathCheck(blocked);
    });
}

// ---- verdict 5: the refusal on the REAL comfy_generate path -------------
//
// The ordering is the whole point of the fix, so it is measured rather than
// argued: with a chat model loaded, a blocked template must come back as a
// grounded refusal with llama NEVER stopped and ComfyUI NEVER queued.
function realPathCheck(blocked) {
  if (!blocked.length) {
    say("info", "No blocked template — verdict 5 (the real comfy_generate " +
        "path) has nothing to refuse on this machine.");
    finish();
    return;
  }
  const target = blocked[0];
  const trace = [];
  const realStop = Llama.stop;
  const realGenerate = Comfy.generate;
  const realState = Llama.getState;
  const realModel = Llama.getCurrentModel;
  // Impersonate a LOADED chat model so the arbiter has something to pause:
  // the fix is only interesting when there is a handoff to be saved. Nothing
  // is really started, and stop() is neutralised so nothing is really killed.
  Llama.getState = () => "running";
  Llama.getCurrentModel = () => s.modelPath;
  Llama.stop = () => { trace.push("llama.stop"); };
  Comfy.generate = (o, p, cb) => {
    trace.push("comfy.generate");
    cb(new Error("probe: the graph must never have been queued"));
  };
  say("info", "Driving the real comfy_generate for " + target.name +
      " with a chat model impersonated as loaded (" + s.modelPath + ")");
  // "llama was never stopped" only means something if the arbiter WOULD
  // have stopped it. Ask the decision directly — planFor has no side
  // effects, which is what it was split out for.
  const plan = Tools._vramArbiter.planFor(s, target.manifest);
  verdict(plan.decision.mode === "handoff",
          "…on a job the arbiter WOULD have paused chat for, so the " +
          "saved handoff is real and not a vacuous pass",
          plan.decision.mode + ": " + plan.decision.reason);
  Tools.executeCommands([{ tool: "comfy_generate", args: {
    workflow: target.name, prompt: "a probe that must never render",
    "import": false
  } }], {}, null, function (rs) {
    Llama.stop = realStop;
    Comfy.generate = realGenerate;
    Llama.getState = realState;
    Llama.getCurrentModel = realModel;
    const r = rs && rs[0] ? rs[0] : {};
    say("tool", "comfy_generate -> " +
        (r.ok ? "ok" : "refused: " + String(r.error).slice(0, 400)));
    verdict(r.ok === false && /cannot load/.test(String(r.error)),
            "the real comfy_generate path returns the weight refusal");
    verdict(trace.indexOf("llama.stop") === -1,
            "…with the chat model NEVER stopped — the handoff the user " +
            "used to pay for is saved",
            trace.length ? "trace: " + trace.join(", ") : "nothing churned");
    verdict(trace.indexOf("comfy.generate") === -1,
            "…and the graph NEVER queued");
    finish();
  });
}

function finish() {
  const dir = path.join(ROOT, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, "weight-availability-probe-" + stamp + ".md");
  const body = ["# weight availability probe", "",
    "- when: " + new Date().toISOString(),
    "- backend: " + s.comfyUrl, ""]
    .concat(transcript.map((t) => (t.kind === "verdict" ? "**" + t.text + "**"
                                                        : "    " + t.text)))
    .join("\n");
  try { fs.writeFileSync(file, body, "utf8"); say("info", "wrote " + file); }
  catch (e) { say("error", "could not write transcript: " + e.message); }
  say("info", failures ? failures + " verdict(s) FAILED" : "all verdicts passed");
  process.exit(failures ? 1 : 0);
}
