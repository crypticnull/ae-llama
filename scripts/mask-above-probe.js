/*
 * mask-above-probe.js — launcher for scripts/mask-above-probe.jsx.
 * WORKPLAN item 8 follow-up, filed by the 0.11.27 pass: neither mask
 * table can see the mask ABOVE, only whether one EXISTS.
 *
 *   node scripts/mask-above-probe.js          # drives real AE
 *   node scripts/mask-above-probe.js --read   # re-print the last run
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "logs");
const RESULT_JSON = path.join(OUT_DIR, "mask-above-probe.json");
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
    const wrapper = path.join(os.tmpdir(), "aell-mask-above-wrapper.jsx");
    fs.writeFileSync(wrapper,
      '$.global.AELL_PROBE_REPO = "' + fwd(REPO) + '";\n' +
      '$.global.AELL_PROBE_OUT = "' + fwd(RESULT_JSON) + '";\n' +
      '$.evalFile(new File("' +
        fwd(path.join(REPO, "scripts", "mask-above-probe.jsx")) + '"));\n');

    say("driving " + exe);
    spawn(exe, ["-r", wrapper], { detached: true, stdio: "ignore" }).unref();

    // 168 readings x 7 sample points, where the erase probe took ~60 x 9,
    // so the deadline is longer than that probe's 240 s.
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
  const by = (id) => rows.filter((r) => r.id === id);

  // "erased" is the max, not the mean: one lit pixel means the layer is
  // still there. "untouched" is measured against the BASE, not against 1.
  const verdict = (r) => {
    if (r.max === 0) return "EMPTY";
    if (r.sameAsBase) return "unchanged";
    if (r.mean === 1) return "shows ALL";
    return "changed mean=" + r.mean;
  };

  say("");
  say("=== A0  what each base shows on its own ===");
  for (const r of by("0-base")) {
    say("  " + r.base.padEnd(12) + " max=" + r.max + " min=" + r.min +
        " mean=" + r.mean);
    say("      " + r.points.join("  "));
  }

  const bases = by("0-base").map((r) => r.base);
  const overs = by("1-over");
  for (const region of ["all", "none"]) {
    say("");
    say("=== A1  second mask, region worth " +
        (region === "all" ? "EVERYTHING" : "NOTHING") + " ===");
    say("  " + "mode".padEnd(22) + bases.map((b) => b.padEnd(13)).join(""));
    const seen = [];
    for (const r of overs) {
      if (r.region !== region) continue;
      const key = r.mode + (r.inverted ? " + inverted" : "");
      if (seen.indexOf(key) !== -1) continue;
      seen.push(key);
      const cells = bases.map((b) => {
        const hit = overs.filter((x) => x.region === region && x.base === b &&
          x.mode === r.mode && x.inverted === r.inverted)[0];
        return (hit ? verdict(hit) : "?").padEnd(13);
      });
      say("  " + key.padEnd(22) + cells.join(""));
    }
  }

  say("");
  say("=== A2  what the shipped tool answers today, per base ===");
  for (const r of by("2-receipt")) {
    const parsed = (() => { try { return JSON.parse(r.raw); } catch (e) { return null; } })();
    const w = parsed && parsed.data
      ? (parsed.data.warning || parsed.data.note || "(no warning)")
      : r.raw;
    say("  " + r.base.padEnd(11) + r.tag.padEnd(19) +
        ("base " + r.baseMean + " -> " + r.mean).padEnd(20) + verdict(r));
    say("      " + w);
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
