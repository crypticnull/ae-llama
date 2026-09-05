/*
 * mask-opacity-probe.js — launcher for scripts/mask-opacity-probe.jsx.
 * WORKPLAN item 8 follow-up, filed by the 0.11.26 pass and carried by
 * every mask pass since: a mask's OPACITY is read nowhere, and neither
 * is its EXPANSION.
 *
 *   node scripts/mask-opacity-probe.js          # drives real AE
 *   node scripts/mask-opacity-probe.js --read   # re-print the last run
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "logs");
const RESULT_JSON = path.join(OUT_DIR, "mask-opacity-probe.json");
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
    const wrapper = path.join(os.tmpdir(), "aell-mask-opacity-wrapper.jsx");
    fs.writeFileSync(wrapper,
      '$.global.AELL_PROBE_REPO = "' + fwd(REPO) + '";\n' +
      '$.global.AELL_PROBE_OUT = "' + fwd(RESULT_JSON) + '";\n' +
      '$.evalFile(new File("' +
        fwd(path.join(REPO, "scripts", "mask-opacity-probe.jsx")) + '"));\n');

    say("driving " + exe);
    spawn(exe, ["-r", wrapper], { detached: true, stdio: "ignore" }).unref();

    // ~100 readings x 7 sample points, in the same band as the above
    // probe's 168, so the same 600 s deadline.
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

  // "EMPTY" is max, not mean: one lit pixel means the layer is still
  // there. A part-lit layer is its own answer and must not read as either.
  const verdict = (r) => {
    if (r.max === 0) return "EMPTY";
    if (r.min === 1) return "shows ALL";
    if (r.max === r.min) return "faded " + r.max;
    return "partial " + r.mean;
  };

  const bare = by("0-bare")[0];
  if (bare) say("\nbare layer: " + verdict(bare) + "  " + bare.points.join(" "));

  const lone = by("1-lone");
  const modes = [];
  for (const r of lone) if (modes.indexOf(r.mode) === -1) modes.push(r.mode);
  for (const region of ["all", "half", "none"]) {
    if (!lone.some((r) => r.region === region)) continue;
    say("");
    say("=== A1  ONE mask, region worth " + region.toUpperCase() +
        " — opacity 0 / 50 / 100 ===");
    for (const m of modes) {
      const cells = [0, 50, 100].map((op) => {
        const hit = lone.filter((x) => x.region === region && x.mode === m &&
          x.opacity === op)[0];
        return (hit ? verdict(hit) : "?").padEnd(15);
      });
      say("  " + m.padEnd(12) + cells.join(""));
    }
  }

  say("");
  say("=== A2  what each base shows on its own ===");
  for (const r of by("2-base")) {
    say("  " + r.base.padEnd(12) + verdict(r).padEnd(14) + r.points.join("  "));
  }

  const over = by("3-over");
  if (over.length) {
    const bases = by("2-base").map((r) => r.base);
    const secModes = [];
    for (const r of over) if (secModes.indexOf(r.mode) === -1) secModes.push(r.mode);
    say("");
    say("=== A3  a second FULL-COVERAGE mask at opacity 100, per base ===");
    say("  " + "mode".padEnd(12) + bases.map((b) => b.padEnd(13)).join(""));
    for (const m of secModes) {
      const cells = bases.map((b) => {
        const hit = over.filter((x) => x.base === b && x.mode === m)[0];
        return (hit ? verdict(hit) : "?").padEnd(13);
      });
      say("  " + m.padEnd(12) + cells.join(""));
    }
  }

  const exp = by("4-expansion");
  if (exp.length) {
    say("");
    say("=== A4  EXPANSION on a mask whose SHAPE never changes ===");
    for (const r of exp) {
      say("  " + (r.mode + " " + r.region).padEnd(16) +
          ("expansion " + r.expansion).padEnd(16) + verdict(r).padEnd(14) +
          r.points.join("  "));
    }
  }

  const parades = by("4b-parade");
  if (parades.length) {
    say("");
    say("=== A4b  an opacity-0 mask further UP the parade ===");
    for (const r of parades) {
      say("  " + r.tag.padEnd(30) + verdict(r).padEnd(14) + "reader=" +
          (r.shows === "" ? "(unreadable)" : r.shows));
    }
  }

  say("");
  say("=== A5  what the shipped tools answer today ===");
  for (const r of by("5-receipt")) {
    const parsed = (() => { try { return JSON.parse(r.raw); } catch (e) { return null; } })();
    const w = parsed && parsed.data
      ? (parsed.data.warning || parsed.data.note || "(no warning)")
      : r.raw;
    say("  " + r.tag.padEnd(34) +
        ("mean " + r.beforeMean + " -> " + r.mean).padEnd(20) + verdict(r));
    say("      " + w);
  }

  const reader = by("6-reader");
  if (reader.length) {
    say("");
    say("=== A6  what AELL_paradeShows answers for each base ===");
    for (const r of reader) {
      say("  " + r.base.padEnd(12) + "shows=" +
          (r.shows === "" ? "(unreadable)" : r.shows).padEnd(14) +
          "alpha mean " + r.mean);
    }
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
