/*
 * download-gen-weight.js — fetch a catalog model's weights headlessly,
 * through the panel's own downloader.
 *
 * Why this exists: `Setup.downloadGenWeight` had exactly ONE caller —
 * the per-model Download button in Settings (main.js). So every WORKPLAN
 * §18 pass that says "download sd15, then measure it" contained a human
 * click, and an unattended pass could not take any of them.
 *
 * It runs the SHIPPED code: settings.js + comfy.js + setup.js in a window
 * shim, the same pattern comfy-probe.js and comfy-install.js use. Where
 * the file lands, which URLs are pinned, and the resume/rename dance all
 * stay in the panel — this owns the sequence and the verdicts.
 *
 *   node scripts/download-gen-weight.js --entry sd15
 *   node scripts/download-gen-weight.js --entry sd15 --check   # plan only
 *   node scripts/download-gen-weight.js --list
 *
 * Exit 0 only when every file the entry names is on disk afterwards.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const EXT = path.join(REPO, "extension");

function argValue(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const OPT = {
  entry: argValue("--entry", null),
  check: process.argv.indexOf("--check") !== -1,
  list: process.argv.indexOf("--list") !== -1
};

let failures = 0;
function verdict(ok, label, detail) {
  console.log((ok ? "ok  - " : "FAIL- ") + label +
              (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
}
function say(kind, msg) { console.log("[" + kind + "] " + msg); }

// -------------------------------------------------------- the panel, in Node

const managed = require("./lib/comfy-managed.js");
let pidFile = null;
const window = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  localStorage: managed.makeStorage(function () { return pidFile; }),
  AEBridge: {
    nodeRequire: require,
    getExtensionPath() { return EXT; },
    evalScript(script, cb) { if (cb) cb("", "no AE in this script"); }
  }
};
window.window = window;
function loadPanelFile(rel) {
  new Function("window", fs.readFileSync(path.join(EXT, "js", rel), "utf8"))
    (window);
}
loadPanelFile("version.js");
loadPanelFile("settings.js");
loadPanelFile("tiers.js");
loadPanelFile("comfy.js");
loadPanelFile("setup.js");

const Settings = window.Settings;
const Setup = window.Setup;
try {
  pidFile = path.join(Settings.dataRoot(), "comfy-managed.pid");
} catch (e) { pidFile = null; }

// ------------------------------------------------------------- gate 0
//
// Every path here is Settings.dataRoot()-relative, and dataRoot falls
// through APPDATA -> USERPROFILE -> the extension folder. Measured
// 2026-09-02: an unattended pass with no APPDATA landed on a root
// holding no settings.json and reported pure defaults as the owner's
// settings. A downloader inheriting that does not misreport a number —
// it puts GIGABYTES somewhere nobody will look and calls it done.

const origin = Settings.origin();
say("info", "settings: from=" + origin.from + " saved=" + origin.saved +
            " dataRoot=" + origin.dataRoot);
if (!origin.appdata) {
  console.error("\nAPPDATA is empty, so the data root is a guess and this " +
    "would download gigabytes somewhere the panel may never look. Run " +
    "this from a session that has APPDATA set (WORKPLAN §18 'gate 0').");
  process.exit(2);
}

const s = Settings.get();
const catalog = Setup.comfyCatalog(null) || [];

if (OPT.list || !OPT.entry) {
  console.log("\ncatalog entries and what they would cost:\n");
  catalog.forEach(function (e) {
    const urls = e.urls || [];
    const mb = urls.reduce(function (a, u) { return a + (u.sizeMB || 0); }, 0);
    console.log("  " + e.name.padEnd(18) +
                (urls.length ? urls.length + " file(s), ~" +
                  (Math.round(mb / 1024 * 10) / 10) + " GB"
                             : "no pinned URLs — nothing to download"));
  });
  if (!OPT.entry) {
    console.log("\nPass --entry <name>.");
    process.exit(OPT.list ? 0 : 2);
  }
  process.exit(0);
}

const entry = catalog.filter(function (e) { return e.name === OPT.entry; })[0];
if (!entry) {
  console.error("No catalog entry '" + OPT.entry + "'. Have: " +
                catalog.map(function (e) { return e.name; }).join(", "));
  process.exit(2);
}

const urls = entry.urls || [];
if (!urls.length) {
  // ltx-small is exactly this: an entry the tier line offers with no
  // weights pinned and no graph. Say so rather than "downloaded 0 files".
  verdict(false, entry.name + " has pinned download URLs",
          "none — there is nothing to fetch (see WORKPLAN §18, owner Q1)");
  console.log("\n1 FAILED");
  process.exit(1);
}

// Where each file WOULD land, by the panel's own rule. Reported before
// anything is fetched, because "no place to put it" is the failure this
// is most likely to hit on a machine without the managed backend:
// genWeightDest falls back to <vendor>/ComfyUI/models and refuses when
// neither that nor comfyModelsDir exists.
say("info", "models folder: " + (s.comfyModelsDir || "(not set — using " +
            "the managed backend's own models folder)"));
let blocked = false;
urls.forEach(function (u) {
  const plan = Setup._genWeightDest(u);
  if (plan.err) {
    verdict(false, "a destination for " + String(u.url).split("/").pop(),
            plan.err);
    blocked = true;
  } else {
    const have = fs.existsSync(plan.dest);
    say("info", (have ? "present " : "MISSING ") + plan.dest);
  }
});
if (blocked || OPT.check) {
  console.log(failures ? "\n" + failures + " FAILED"
                       : "\n" + (OPT.check ? "PLAN ONLY — nothing fetched"
                                           : "ALL CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
}

// ------------------------------------------------------------- fetch

(function next(i) {
  if (i >= urls.length) {
    // The only verdict that matters: is it on disk NOW. An exit code
    // from a downloader is not evidence the file arrived.
    let missing = 0;
    urls.forEach(function (u) {
      const plan = Setup._genWeightDest(u);
      if (plan.err || !fs.existsSync(plan.dest)) { missing++; return; }
      const mb = Math.round(fs.statSync(plan.dest).size / 1048576);
      verdict(true, path.basename(plan.dest) + " is on disk", mb + " MB");
    });
    if (missing) {
      verdict(false, "every file the entry names is on disk",
              missing + " still missing");
    }
    console.log(failures ? "\n" + failures + " FAILED" : "\nALL CHECKS PASSED");
    process.exit(failures ? 1 : 0);
    return;
  }
  const u = urls[i];
  const base = String(u.url).split("?")[0].split("/").pop();
  let lastPct = -1;
  say("info", "fetching " + base +
              (u.sizeMB ? " (~" + Math.round(u.sizeMB / 1024 * 10) / 10 +
               " GB)" : ""));
  Setup.downloadGenWeight(u, {
    status: function (t) { say("dl", t); },
    progress: function (rec, total) {
      if (!total) return;
      const pct = Math.floor(rec / total * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        say("dl", base + " " + pct + "%");
      }
    }
  }, function (err, dest) {
    if (err) {
      verdict(false, base + " downloaded", err.message);
      next(i + 1);
      return;
    }
    say("info", "-> " + dest);
    next(i + 1);
  });
})(0);
