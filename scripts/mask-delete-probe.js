/*
 * mask-delete-probe.js — launcher for scripts/mask-delete-probe.jsx.
 * Top open item after 0.11.33: delete_mask can empty a layer or hand it
 * back and its receipt says neither.
 *
 *   node scripts/mask-delete-probe.js          # drives real AE
 *   node scripts/mask-delete-probe.js --read   # re-print the last run
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "logs");
const RESULT_JSON = path.join(OUT_DIR, "mask-delete-probe.json");
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
    const wrapper = path.join(os.tmpdir(), "aell-mask-delete-wrapper.jsx");
    fs.writeFileSync(wrapper,
      '$.global.AELL_PROBE_REPO = "' + fwd(REPO) + '";\n' +
      '$.global.AELL_PROBE_OUT = "' + fwd(RESULT_JSON) + '";\n' +
      '$.evalFile(new File("' +
        fwd(path.join(REPO, "scripts", "mask-delete-probe.jsx")) + '"));\n');

    say("driving " + exe);
    spawn(exe, ["-r", wrapper], { detached: true, stdio: "ignore" }).unref();

    // Nine cases x 14 readings — far under the opacity probe's 168, but
    // the same 600 s deadline: the cost here is AE's launch, not the run.
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

function report(data) {
  say("AE " + (data.aeVersion || "?") + " — stage: " + data.stage);
  if (data.crashed) { say("CRASHED: " + data.crashed); return; }
  const rows = data.results || [];

  // "EMPTY" is max, not mean: one lit pixel means the layer is still
  // there. A part-lit layer is its own answer and must not read as either.
  const verdict = (max, min, mean) => {
    if (max === 0) return "EMPTY";
    if (min === 1) return "shows ALL";
    if (max === min) return "faded " + max;
    return "partial " + mean;
  };

  const bare = rows.filter((r) => r.id === "0-bare")[0];
  if (bare) {
    say("\nbare layer: " + verdict(bare.max, bare.min, bare.mean) + "  " +
        bare.points.join(" "));
  }

  say("");
  say("=== what deleting ONE mask does, and what the receipt says ===");
  for (const r of rows.filter((x) => x.id === "1-delete")) {
    const before = verdict(r.beforeMax, r.beforeMin, r.beforeMean);
    const after = verdict(r.max, r.min, r.mean);
    let parsed = null;
    try { parsed = JSON.parse(r.raw); } catch (e) {}
    const d = parsed && parsed.data ? parsed.data : null;
    const w = d ? (d.warning || d.note || "(no warning)")
                : (parsed && parsed.error ? "ERROR: " + parsed.error : r.raw);
    say("");
    say("  " + r.tag);
    say("      delete '" + r.target + "':  alpha " + before + " -> " + after +
        "   (expected " + r.expect + ")");
    const shows = (s) => (s === "" ? "(unreadable)" : s);
    say("      reader: " + shows(r.showsBefore) + " -> " + shows(r.showsAfter) +
        (r.showsAfter === r.showsFresh
          ? ""
          : "   !! a FRESH lookup says " + shows(r.showsFresh)));
    say("      remaining: " + (d && d.remainingMasks
      ? (d.remainingMasks.length ? d.remainingMasks.join(", ") : "(none)")
      : "?"));
    say("      says: " + w);
  }

  for (const r of rows.filter((x) => x.id === "CRASH")) {
    say("");
    say("!! CRASH in " + r.stage + " line " + r.line + ": " + r.message);
  }
}

(async () => {
  let data = null;
  if (READ_ONLY) {
    data = JSON.parse(fs.readFileSync(RESULT_JSON, "utf8"));
  } else {
    data = await runInAE();
  }
  report(data);
})().catch((e) => { say("FAILED: " + e.message); process.exit(1); });
