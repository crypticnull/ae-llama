/*
 * mask-erase-probe.js — launcher for scripts/mask-erase-probe.jsx.
 * WORKPLAN item 8 follow-up: a full-coverage SUBTRACT mask hides the whole
 * layer and add_mask answers a bare ok.
 *
 *   node scripts/mask-erase-probe.js          # drives real AE
 *   node scripts/mask-erase-probe.js --read   # re-print the last run
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "logs");
const RESULT_JSON = path.join(OUT_DIR, "mask-erase-probe.json");
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
    const wrapper = path.join(os.tmpdir(), "aell-mask-probe-wrapper.jsx");
    fs.writeFileSync(wrapper,
      '$.global.AELL_PROBE_REPO = "' + fwd(REPO) + '";\n' +
      '$.global.AELL_PROBE_OUT = "' + fwd(RESULT_JSON) + '";\n' +
      '$.evalFile(new File("' +
        fwd(path.join(REPO, "scripts", "mask-erase-probe.jsx")) + '"));\n');

    say("driving " + exe);
    spawn(exe, ["-r", wrapper], { detached: true, stdio: "ignore" }).unref();

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
          if (parsed && (/cleaned|CLEANUP|crashed/.test(parsed.stage || "") ||
                         parsed.crashed)) return resolve(parsed);
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

function report(data) {
  say("AE " + (data.aeVersion || "?") + " — stage: " + data.stage);
  if (data.crashed) { say("CRASHED: " + data.crashed); return; }
  const rows = data.results || [];
  const by = (id) => rows.filter((r) => r.id === id);

  const verdict = (r) => (r.max === 0 ? "ERASED" :
    (r.mean === 1 ? "untouched" : "partial mean=" + r.mean));

  say("");
  say("=== M0  baseline (no mask) ===");
  for (const r of by("0-baseline")) {
    say("  layer " + r.layerW + "x" + r.layerH + " in comp " + r.compW + "x" +
        r.compH + "  max=" + r.max + " min=" + r.min + " mean=" + r.mean);
    say("  saveFrameToPng writes a file: " + r.saveFrameToPngWrites);
  }

  say("");
  say("=== M1  lone mask, exactly the layer's box ===");
  for (const r of by("1-lone")) {
    say("  " + (r.mode + (r.inverted ? " + inverted" : "")).padEnd(24) +
        verdict(r).padEnd(18) + " max=" + r.max + " min=" + r.min);
  }

  say("");
  say("=== M2  does a feather leave a visible band? ===");
  for (const r of by("2-feather")) {
    say("  " + r.mode.padEnd(14) + " feather " + String(r.feather).padStart(3) +
        "  " + verdict(r).padEnd(18));
    say("      " + r.points.join("  "));
  }

  say("");
  say("=== M3  added SECOND over an add mask on the left half ===");
  for (const r of by("3-base")) {
    say("  base (add, left half)    mean=" + r.mean);
    say("      " + r.points.join("  "));
  }
  for (const r of by("3-second")) {
    say("  " + (r.mode + (r.inverted ? " + inverted" : "")).padEnd(24) +
        verdict(r).padEnd(18) + " sameAsBase=" + r.sameAsBase);
  }

  say("");
  say("=== M5  lone mask that MISSES the layer entirely ===");
  for (const r of by("5-misses")) {
    say("  " + (r.mode + (r.inverted ? " + inverted" : "")).padEnd(24) +
        verdict(r).padEnd(18) + " max=" + r.max + " min=" + r.min);
  }

  say("");
  say("=== M4  what the shipped tool answers today ===");
  for (const r of by("4-receipt")) {
    say("  " + r.tag.padEnd(26) + verdict(r));
    say("      " + r.raw);
  }

  for (const r of by("CRASH")) {
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
