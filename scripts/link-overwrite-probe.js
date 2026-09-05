/*
 * link-overwrite-probe.js — launcher for scripts/link-overwrite-probe.jsx.
 * WORKPLAN item 8 follow-up, filed by the 0.11.31 pass as its top item:
 * link_property silently overwrites an existing link on the same
 * property. The probe also asks the question nobody had: what the
 * FAILING write does to an expression that was already working.
 *
 *   node scripts/link-overwrite-probe.js          # drives real AE
 *   node scripts/link-overwrite-probe.js --read   # re-print the last run
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "logs");
const RESULT_JSON = path.join(OUT_DIR, "link-overwrite-probe.json");
const READ_ONLY = process.argv.indexOf("--read") !== -1;

function say(s) { process.stdout.write(s + "\n"); }

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

function runInAE() {
  return new Promise((resolve, reject) => {
    const exe = findAfterFX();
    if (!exe) return reject(new Error("AfterFX.exe not found"));
    fs.mkdirSync(OUT_DIR, { recursive: true });
    try { fs.unlinkSync(RESULT_JSON); } catch (e) {}

    const fwd = (p) => p.replace(/\\/g, "/");
    const wrapper = path.join(os.tmpdir(), "aell-link-overwrite-wrapper.jsx");
    fs.writeFileSync(wrapper,
      '$.global.AELL_PROBE_REPO = "' + fwd(REPO) + '";\n' +
      '$.global.AELL_PROBE_OUT = "' + fwd(RESULT_JSON) + '";\n' +
      '$.evalFile(new File("' +
        fwd(path.join(REPO, "scripts", "link-overwrite-probe.jsx")) + '"));\n');

    say("driving " + exe);
    spawn(exe, ["-r", wrapper], { detached: true, stdio: "ignore" }).unref();

    // No image sampling here — a few dozen property reads — but AE's own
    // launch is the slow part, so the same 600 s deadline as its siblings.
    const deadline = Date.now() + 600000;
    let lastSize = -1, stable = 0;
    const tick = () => {
      let st = null;
      try { st = fs.statSync(RESULT_JSON); } catch (e) {}
      if (st) {
        if (st.size === lastSize) stable++;
        else { stable = 0; lastSize = st.size; }
        if (stable >= 4) {
          let parsed = null;
          try { parsed = JSON.parse(fs.readFileSync(RESULT_JSON, "utf8")); }
          catch (e) { stable = 0; }
          if (parsed && (/cleaned|CLEANUP|crashed/.test(parsed.stage || "") ||
                         parsed.crashed)) return resolve(parsed);
          if (parsed && stable >= 20) return resolve(parsed);
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

function short(s, n) {
  s = String(s === undefined || s === null ? "" : s).replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

function report(data) {
  say("AE " + (data.aeVersion || "?") + " — stage: " + data.stage);
  if (data.crashed) { say("CRASHED: " + data.crashed); return; }
  const rows = data.results || [];
  const by = (id) => rows.filter((r) => r.id === id);
  const crash = by("CRASH")[0];

  const bare = by("0-bare")[0];
  say("");
  say("=== A0  a property that never had an expression ===");
  if (bare) {
    say("  text=" + JSON.stringify(bare.state.text) +
        " enabled=" + bare.state.enabled +
        " err=" + JSON.stringify(bare.state.err) +
        " value=" + bare.state.value);
  }

  say("");
  say("=== A1  plain overwrite ===");
  for (const r of by("1-overwrite")) {
    say("  first  " + short(r.first.text, 60));
    say("  second " + short(r.second.text, 60));
    say("  the first text survives anywhere: " + r.firstTextSurvives);
  }

  say("");
  say("=== A2  an INVALID write landing on a VALID expression (raw) ===");
  say("  " + "case".padEnd(24) + "threw?".padEnd(8) + "text after".padEnd(28) +
      "err?".padEnd(6) + "restorable");
  for (const r of by("2-invalid")) {
    say("  " + String(r.tag).padEnd(24) +
        (r.threw ? "THREW" : "no").padEnd(8) +
        short(r.afterText, 26).padEnd(28) +
        (r.afterErr ? "yes" : "no").padEnd(6) + r.restoreWorks);
    if (r.threw) say("      threw: " + short(r.threw, 90));
  }

  say("");
  say("=== A2b what the SHIPPED AELL_setExpr does with the same input ===");
  say("  " + "case".padEnd(24) + "text after".padEnd(28) + "PRIOR LOST?");
  for (const r of by("2b-helper")) {
    say("  " + String(r.tag).padEnd(24) + short(r.afterText, 26).padEnd(28) +
        (r.priorLost ? "YES  <-- the user's expression, gone" : "no"));
  }

  say("");
  say("=== A3  a DISABLED expression ===");
  for (const r of by("3-disabled")) {
    say("  readable while off: " + r.textReadableWhileOff +
        "   (text " + short(r.off.text, 40) + ")");
    say("  a new write re-enabled it: " + r.writeReEnabled);
  }

  say("");
  say("=== A4  keyframes under an expression ===");
  for (const r of by("4-keys")) {
    say("  keys before " + r.keyed.keys + ", under the expression " +
        r.linked.keys + ", after clearing " + r.cleared.keys);
    say("  survive: " + r.keysSurvive + " / still there after clear: " +
        r.keysStillThere);
  }

  say("");
  say("=== A5  writing the identical text again ===");
  for (const r of by("5-identical")) {
    say("  threw: " + (r.threw || "no") + "  err after: " +
        JSON.stringify(r.after.err));
  }

  say("");
  say("=== A6  what the SHIPPED TOOLS say when they overwrite ===");
  for (const r of by("6-receipt")) {
    say("  " + r.tag);
    say("      was:  " + short(r.wasText, 70));
    say("      now:  " + short(r.nowText, 70));
    say("      says: " + short(r.raw, 150));
    say("      names what it replaced: " + r.mentionsOld +
        (r.silentLoss && !r.mentionsOld ? "   <-- SILENT LOSS" : ""));
  }

  say("");
  say("=== A7  grid_layout over a linked Position ===");
  for (const r of by("7-grid")) {
    say("      was:  " + short(r.wasText, 70));
    say("      now:  " + short(r.nowText, 70));
    say("      says: " + short(r.raw, 150));
    say("      silent loss: " + r.silentLoss);
  }

  const clean = by("9-cleanup")[0];
  say("");
  if (clean) {
    say("cleanup: removed " + clean.strays.length + " item(s) [" +
        clean.strays.join(", ") + "], project now " + clean.itemsNow);
  } else {
    say("cleanup: NO cleanup row — check the project by hand");
  }
  if (crash) say("CRASH at " + crash.stage + ": " + crash.message +
                 " (line " + crash.line + ")");
}

(async function main() {
  let data = null;
  if (READ_ONLY) {
    data = JSON.parse(fs.readFileSync(RESULT_JSON, "utf8"));
  } else {
    data = await runInAE();
  }
  report(data);
  say("");
  say("raw: " + RESULT_JSON);
})().catch((e) => { say("FAILED: " + e.message); process.exit(1); });
