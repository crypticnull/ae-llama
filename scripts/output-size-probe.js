/*
 * output-size-probe.js — does the panel now tell the truth about the size
 * of the file a generation writes?
 *
 * Filed by the tier-P4 catalog pass (WORKPLAN-LOG 2026-08-30, 0.10.19):
 * the shipped KREA2 template upscales its latent 1.6x between its two
 * passes, so `comfy_generate {width: 1024, height: 1024}` returned a
 * 1640x1640 image while `width`/`height` were documented to the model as
 * the OUTPUT size. Nothing in the panel ever said otherwise, so a model
 * that sized a comp around its own request sized it around the wrong
 * number.
 *
 * The fix has two halves and only one of them can be checked without a
 * GPU. This probe checks the other one, the way this project checks
 * everything: by making a falsifiable prediction and then measuring.
 *
 *   the shipped template + extension/js/comfy.js  (the real panel code)
 *     -> injectParams writes the requested size and PREDICTS what it
 *        becomes on disk
 *     -> a REAL local ComfyUI renders it
 *     -> the saved PNG's own IHDR header is read back
 *     -> the two must be the same number
 *
 * A prediction that merely sounds plausible is exactly what the SILENCE
 * rule of 0.10.20 exists to prevent, so this is not a formality: 1024 at
 * 1.6x is 1638.4, and the file that comes back is 1640, because a latent
 * upscale lands on the /8 grid. Either the arithmetic reproduces the
 * card's own or the note is misinformation.
 *
 *   node scripts/output-size-probe.js               # 512x512, ~2 passes
 *   node scripts/output-size-probe.js --width 1024 --height 1024
 *   node scripts/output-size-probe.js --url http://127.0.0.1:8188
 *
 * It NEVER touches After Effects (`import: false`) and never asks the
 * arbiter for anything: it calls Comfy.generate directly, so the chat
 * model is not stopped and the user's project is not opened. The AE half
 * of the same fix — import_file reporting the size AE measured — is
 * covered by the self-test suite instead, where there is a real project
 * to import into.
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
const OPT = {
  url: argValue("--url", null),
  width: parseInt(argValue("--width", "512"), 10),
  height: parseInt(argValue("--height", "512"), 10),
  seed: parseInt(argValue("--seed", "424242"), 10),
  timeout: parseInt(argValue("--timeout", "900"), 10),
  workflow: argValue("--workflow", "AE_LLAMA_KREA2_T2I_V1"),
  prompt: argValue("--prompt", "a plain grey studio backdrop, soft light")
};

// ------------------------------------------------------------ the panel

const storage = {};
const window = {
  navigator: { userAgent: "node" },
  location: { href: "file:///probe" },
  setTimeout, clearTimeout, setInterval, clearInterval,
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
      say("error", "AEBridge.evalScript called - this probe must not reach AE");
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
loadPanelFile("comfy.js");

const Settings = window.Settings;
const Comfy = window.Comfy;
const managed = require("./lib/comfy-managed.js");

const OUT_DIR = path.join(ROOT, "logs", "output-size");
const OVERRIDE = {
  comfyWorkflowsDir: path.join(EXT, "comfy-workflows"),
  comfyOutDir: OUT_DIR,
  comfyTimeoutSec: OPT.timeout
};
// Mode as well as address, or --url is invisible in managed mode (§17m).
if (OPT.url) Object.assign(OVERRIDE, managed.urlOverride(OPT.url));
const realGet = Settings.get;
Settings.get = function () {
  const s = realGet.apply(Settings, arguments);
  for (const k in OVERRIDE) s[k] = OVERRIDE[k];
  return s;
};
const S = Settings.get();

// --------------------------------------------------------------- output

const transcript = [];
let failures = 0;
function say(kind, text) {
  transcript.push({ kind: kind, text: text });
  const tag = { info: "--", row: "  ", verdict: "==", error: "!!" }[kind] || "  ";
  console.log(tag + " " + text);
}
function verdict(ok, text) {
  if (!ok) failures++;
  say(ok ? "verdict" : "error", (ok ? "PASS  " : "FAIL  ") + text);
}

/* PNG carries its size in the IHDR chunk, which is always the first one:
 * 8 signature bytes, a 4-byte length, "IHDR", then width and height as
 * big-endian 32-bit ints. Reading it here rather than asking ComfyUI is
 * the point - the file on disk is the thing the user actually gets. */
function pngSize(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ----------------------------------------------------------------- run

function main() {
  const all = Comfy.listWorkflows(S.comfyWorkflowsDir);
  let chosen = null;
  for (const w of all) {
    if (w.name.toLowerCase() === OPT.workflow.toLowerCase()) chosen = w;
  }
  if (!chosen) {
    say("error", "No template named " + OPT.workflow + ". Available: " +
        all.map((w) => w.name).join(", "));
    process.exit(2);
  }
  say("info", "template " + chosen.name);
  say("info", "backend  " + Comfy.backendUrl(S) + "  (" +
              Comfy.backendMode(S) + ")");
  say("info", "asked for " + OPT.width + "x" + OPT.height);

  // The prediction, taken from the panel's own code on a throwaway copy
  // of the graph, BEFORE anything is rendered. Comfy.generate makes the
  // same call internally; doing it here first is what lets the number be
  // written down before the file exists to check it against.
  const preview = JSON.parse(fs.readFileSync(chosen.file, "utf8"));
  const applied = Comfy.injectParams(preview,
    { prompt: OPT.prompt, width: OPT.width, height: OPT.height,
      seed: OPT.seed }, Comfy.readManifest(chosen.file));
  let note = null;
  for (const line of applied) {
    if (line.indexOf("is enlarged ") !== -1) note = line;
  }
  if (!note) {
    verdict(false, "the panel predicted nothing for a template that " +
            "upscales - there is no claim left to check");
    finish();
    return;
  }
  say("info", "PREDICTION: " + note);
  const m = /the file will be (\d+)x(\d+)/.exec(note);
  if (!m) {
    verdict(false, "the note carries no size to check: " + note);
    finish();
    return;
  }
  const predicted = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  verdict(predicted.width !== OPT.width || predicted.height !== OPT.height,
          "the prediction differs from the request (" + predicted.width +
          "x" + predicted.height + " vs " + OPT.width + "x" + OPT.height +
          "), which is the whole defect this measures");

  say("info", "rendering (this holds the card for as long as it takes)...");
  const startedAt = Date.now();
  Comfy.generate({
    comfyUrl: Comfy.backendUrl(S),
    workflowFile: chosen.file,
    outDir: OUT_DIR,
    timeoutSec: OPT.timeout,
    params: { prompt: OPT.prompt, width: OPT.width, height: OPT.height,
              seed: OPT.seed }
  }, function (elapsed, progress) {
    // This probe drives Comfy.generate directly rather than through
    // Tools.comfy_generate, so it does not inherit the panel sentence.
    say("row", "  still generating... " + elapsed + "s" +
        (progress && progress.max > 1
          ? " - step " + progress.value + "/" + progress.max : ""));
  }, function (err, result) {
    if (err) {
      verdict(false, "the generation itself failed: " + err.message);
      finish();
      return;
    }
    const secs = Math.round((Date.now() - startedAt) / 1000);
    say("info", "rendered in " + secs + "s -> " +
        result.files.map((f) => path.basename(f)).join(", "));

    const pngs = result.files.filter((f) => /\.png$/i.test(f));
    if (!pngs.length) {
      verdict(false, "no PNG came back, so the header cannot be read: " +
              result.files.join(", "));
      finish();
      return;
    }
    let checked = 0;
    for (const f of pngs) {
      const real = pngSize(f);
      if (!real) {
        verdict(false, path.basename(f) + " is not a readable PNG");
        continue;
      }
      checked++;
      say("info", "MEASURED  " + path.basename(f) + ": " + real.width + "x" +
          real.height);
      verdict(real.width === predicted.width && real.height === predicted.height,
              "the file on disk is the size the panel predicted (" +
              real.width + "x" + real.height + " vs " + predicted.width +
              "x" + predicted.height + ")");
      verdict(real.width !== OPT.width || real.height !== OPT.height,
              "and it is NOT the size that was requested, so the old " +
              "documentation really was wrong");
    }
    verdict(checked > 0, "at least one rendered file was measured");
    finish();
  });
}

function finish() {
  try {
    fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
    const lines = ["# output-size-probe", "",
                   "template: " + OPT.workflow,
                   "requested: " + OPT.width + "x" + OPT.height, ""];
    for (const t of transcript) lines.push("- " + t.text);
    fs.writeFileSync(path.join(ROOT, "logs", "output-size-probe.md"),
                     lines.join("\n") + "\n");
  } catch (e) { /* the console transcript is the record either way */ }
  console.log("");
  console.log(failures ? failures + " VERDICT(S) FAILED" : "ALL VERDICTS PASSED");
  process.exit(failures ? 1 : 0);
}

main();
