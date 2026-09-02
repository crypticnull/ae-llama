/*
 * mogrt-verify-probe.js — WORKPLAN item 1c bullet 4 / SELF-VERIFY-PLANS
 * section 1: point the shipped .mogrt verifier at a template ADOBE wrote.
 *
 * Everything the verifier knew about definition.json before this probe
 * came out of hand-built zips in tests/test-mogrt-read.js — the repo had
 * never opened a file After Effects produced. A reader validated only
 * against its own fixtures agrees with itself perfectly and can still be
 * unable to read one real file, which is exactly what this found.
 *
 * What it does, in order:
 *   1. drives real AE (AfterFX.exe -r) through scripts/mogrt-verify-probe.jsx
 *      — four Essential Graphics controllers, two real exports;
 *   2. runs the SHIPPED panel hook (Tools._verifyMogrtResult) on the real
 *      receipt, which is the code path a user gets;
 *   3. prints Adobe's definition.json keys against MogrtRead.PROVISIONAL_KEYS;
 *   4. truncates a copy and re-verifies, so the failure path is measured
 *      on real bytes too.
 *
 * Nothing here re-implements the reader or the hook: a second copy of the
 * thing under test is the bug this probe exists to find.
 *
 *   node scripts/mogrt-verify-probe.js            # full run, needs AE
 *   node scripts/mogrt-verify-probe.js --no-ae    # re-read what AE left
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "logs", "mogrt-verify");
const RESULT_JSON = path.join(OUT_DIR, "probe-results.json");
const NO_AE = process.argv.indexOf("--no-ae") !== -1;

const MogrtRead = require(path.join(REPO, "extension", "js", "mogrt-read.js"));

function say(s) { process.stdout.write(s + "\n"); }
function hr(t) { say("\n=== " + t + " " + "=".repeat(Math.max(0, 62 - t.length))); }

const claims = [];
function claim(name, held, detail) {
  claims.push({ name, held, detail: detail || "" });
  say((held ? "  HOLDS  " : "  MISSED ") + name + (detail ? " — " + detail : ""));
}

// ------------------------------------------------------------ find AE
function findAfterFX() {
  const roots = ["C:\\Program Files\\Adobe", "C:\\Program Files (x86)\\Adobe"];
  const hits = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (e) { continue; }
    for (const d of dirs) {
      if (!/After Effects/i.test(d)) continue;
      const exe = path.join(root, d, "Support Files", "AfterFX.exe");
      if (fs.existsSync(exe)) hits.push(exe);
    }
  }
  hits.sort();
  return hits.length ? hits[hits.length - 1] : null;
}

// ------------------------------------------------------- drive real AE
function runInAE() {
  return new Promise((resolve, reject) => {
    const exe = findAfterFX();
    if (!exe) return reject(new Error("AfterFX.exe not found"));
    fs.mkdirSync(OUT_DIR, { recursive: true });
    try { fs.unlinkSync(RESULT_JSON); } catch (e) {}

    const fwd = (p) => p.replace(/\\/g, "/");
    const wrapper = path.join(os.tmpdir(), "aell-mogrt-probe-wrapper.jsx");
    fs.writeFileSync(wrapper,
      '$.global.AELL_PROBE_REPO = "' + fwd(REPO) + '";\n' +
      '$.global.AELL_PROBE_OUT = "' + fwd(RESULT_JSON) + '";\n' +
      '$.global.AELL_PROBE_DIR = "' + fwd(OUT_DIR) + '";\n' +
      '$.evalFile(new File("' +
        fwd(path.join(REPO, "scripts", "mogrt-verify-probe.jsx")) + '"));\n');

    say("driving " + exe);
    spawn(exe, ["-r", wrapper], { detached: true, stdio: "ignore" }).unref();

    // Two real exports at ~3-5 s each plus AE's own startup. Poll for the
    // file, then for it to stop growing: the probe rewrites it after every
    // measurement, so a read mid-write is a parse error, not a result.
    const deadline = Date.now() + 240000;
    let lastSize = -1, stable = 0;
    const tick = () => {
      let st = null;
      try { st = fs.statSync(RESULT_JSON); } catch (e) {}
      if (st) {
        if (st.size === lastSize) stable++; else { stable = 0; lastSize = st.size; }
        if (stable >= 4) {
          let parsed = null;
          try { parsed = JSON.parse(fs.readFileSync(RESULT_JSON, "utf8")); }
          catch (e) { stable = 0; }
          if (parsed && /cleaned|CLEANUP|crashed/.test(parsed.stage || "") ||
              (parsed && parsed.crashed)) return resolve(parsed);
          if (parsed && stable >= 12) return resolve(parsed);
        }
      }
      if (Date.now() > deadline) {
        return reject(new Error("AE never finished (last size " + lastSize +
          ") — check for a modal on screen"));
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

// ------------------------------------------------------- the panel hook
//
// tools.js is a browser-shaped file: it wants a global `window` and the
// MogrtRead global the panel gives it. Loading it the way the panel does
// is the point — a hand-rolled copy of verifyMogrtResult would grade its
// own homework.
function loadPanelTools() {
  const src = fs.readFileSync(
    path.join(REPO, "extension", "js", "tools.js"), "utf8");
  const window = { MogrtRead: MogrtRead };
  new Function("window", src)(window);
  return window.Tools;
}

// ------------------------------------------------------------ the pass
function analyse(results) {
  const byId = {};
  for (const r of (results.results || [])) byId[r.id] = r;

  hr("what AE did");
  say("AE version: " + (results.aeVersion || "?") + "   stage: " + results.stage);
  if (results.crashed) { say("CRASHED: " + results.crashed); return; }
  if (byId.GUARD) { say("REFUSED: " + byId.GUARD.refused); return; }
  if (byId.CRASH) {
    say("CRASH in " + byId.CRASH.stage + ": " + byId.CRASH.message +
        " (line " + byId.CRASH.line + ")");
  }

  const exposed = (byId["1-expose"] || {}).exposed || [];
  for (const e of exposed) {
    say("  expose " + JSON.stringify(e.want) + ": " +
        (e.ok ? "ok as " + JSON.stringify(e.got) : "FAILED " + e.error));
  }

  const main = byId["2-export"];
  if (!main || !main.ok) {
    say("export FAILED: " + (main ? main.error : "(no step)"));
    return;
  }
  const receipt = main.receipt;
  say("\nreceipt (host side, before the panel hook):");
  for (const k of ["comp", "template", "path", "bytes", "seconds",
                   "controllers", "controllerNames", "returned"]) {
    if (k in receipt) say("  " + k + ": " + JSON.stringify(receipt[k]));
  }

  // ---------------------------------------------------- the shipped hook
  hr("the shipped panel hook, on Adobe's own bytes");
  const Tools = loadPanelTools();
  const hooked = Tools._verifyMogrtResult(JSON.parse(JSON.stringify(receipt)));
  say(JSON.stringify({
    zipValid: hooked.zipValid,
    controllersInFileCount: hooked.controllersInFileCount,
    templateNameInFile: hooked.templateNameInFile,
    verifyNote: hooked.verifyNote || null
  }, null, 1));

  claim("receipt carries controllerNames",
        Array.isArray(receipt.controllerNames) && receipt.controllerNames.length > 0,
        JSON.stringify(receipt.controllerNames));
  claim("zipValid true on a real export", hooked.zipValid === true);
  claim("controllersInFile equals the exposed count",
        hooked.controllersInFileCount === receipt.controllers,
        hooked.controllersInFileCount + " in file, " + receipt.controllers +
        " exposed");
  claim("templateNameInFile is present",
        typeof hooked.templateNameInFile === "string",
        JSON.stringify(hooked.templateNameInFile));
  claim("no verifyNote on a clean export", !hooked.verifyNote,
        hooked.verifyNote || "");

  // The name parity that CAN fail on a real file. capsuleName is the
  // placeholder "Untitled" in every AE 2026 export; the comp name is
  // written for real, so that is the one worth checking.
  const nameV = MogrtRead.verifyExport({
    path: receipt.path, templateName: receipt.template, compName: receipt.comp,
    expectedControllers: receipt.controllerNames, definitionOnly: true
  });
  claim("capsuleName is AE's placeholder and raises no false mismatch",
        nameV.templateNameUnwritten === true &&
        nameV.templateNameMatches === null &&
        nameV.warnings.join(" ").indexOf("template name expected") === -1,
        "templateNameInFile=" + JSON.stringify(nameV.templateNameInFile));
  claim("the comp name in the file matches the receipt",
        nameV.compNameMatches === true,
        JSON.stringify(nameV.compNameInFile) + " vs " +
        JSON.stringify(receipt.comp));
  const wrongComp = MogrtRead.verifyExport({
    path: receipt.path, compName: "Some Other Comp", definitionOnly: true
  });
  claim("a comp-name disagreement IS reported",
        wrongComp.compNameMatches === false &&
        wrongComp.warnings.join(" ").indexOf("comp name expected") !== -1,
        wrongComp.warnings.join(" | "));

  // ------------------------------------------------- Adobe's own fields
  hr("Adobe's definition.json against PROVISIONAL_KEYS");
  const read = MogrtRead.readMogrt(receipt.path);
  const def = read.definition || {};
  say("top-level keys: " + Object.keys(def).sort().join(", "));
  const arrKey = MogrtRead.PROVISIONAL_KEYS.controllerArray
    .filter((k) => Array.isArray(def[k]));
  say("controller array key(s) present: " + (arrKey.join(", ") || "(none)"));
  const first = arrKey.length ? def[arrKey[0]][0] : null;
  if (first) say("first controller, verbatim: " + JSON.stringify(first));
  say("templateNameOf(): " + JSON.stringify(MogrtRead.templateNameOf(def)));
  const roster = MogrtRead.readRoster(def);
  say("readRoster(): via=" + roster.via + " provisional=" + roster.provisional +
      " names=" + JSON.stringify(roster.controllers.map((c) => c.name)));
  say("what AE said it exposed: " + JSON.stringify(receipt.controllerNames));

  const wanted = (receipt.controllerNames || []).slice().sort().join("|");
  const got = roster.controllers.map((c) => c.name).sort().join("|");
  claim("the roster read back equals the roster AE exposed", wanted === got,
        got);

  const dflt = byId["3-export-default-name"];
  if (dflt && dflt.ok) {
    const d2 = MogrtRead.readMogrt(dflt.receipt.path).definition || {};
    say("\nsecond export, template name left to AE: asked " +
        JSON.stringify(dflt.receipt.template) + ", capsuleName " +
        JSON.stringify(MogrtRead.templateNameOf(d2)));
  }

  // ------------------------------------------------------- the sad path
  hr("a truncated copy");
  const cut = path.join(OUT_DIR, "truncated.mogrt");
  const whole = fs.readFileSync(receipt.path);
  fs.writeFileSync(cut, whole.slice(0, Math.floor(whole.length * 0.6)));
  const v = MogrtRead.verifyExport({
    path: cut, templateName: receipt.template,
    expectedControllers: receipt.controllerNames, definitionOnly: true
  });
  say(JSON.stringify({ readable: v.readable, zipValid: v.zipValid,
                       errors: v.errors }, null, 1));
  claim("a truncated export is refused, naming the path",
        v.zipValid !== true && v.errors.length > 0 &&
        v.errors.join(" ").indexOf("truncated.mogrt") !== -1,
        v.errors[0] || "");

  hr("verdict");
  const missed = claims.filter((c) => !c.held);
  say(claims.length - missed.length + "/" + claims.length + " claims held");
  for (const m of missed) say("  MISSED: " + m.name + " — " + m.detail);
  process.exitCode = missed.length ? 1 : 0;
}

(async function main() {
  let results;
  if (NO_AE) {
    results = JSON.parse(fs.readFileSync(RESULT_JSON, "utf8"));
  } else {
    results = await runInAE();
  }
  analyse(results);
})().catch((e) => { say("FAILED: " + e.message); process.exitCode = 2; });
