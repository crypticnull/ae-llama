/*
 * stagger-motion-probe.js — launcher for scripts/stagger-motion-probe.jsx.
 * WORKPLAN item 8, row 32 (stagger_layers on layers with NO keyframes
 * reports ok and animates nothing).
 *
 *   node scripts/stagger-motion-probe.js          # drives real AE
 *   node scripts/stagger-motion-probe.js --read   # re-print the last run
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "logs");
const RESULT_JSON = path.join(OUT_DIR, "stagger-motion-probe.json");
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
    const wrapper = path.join(os.tmpdir(), "aell-stagger-probe-wrapper.jsx");
    fs.writeFileSync(wrapper,
      '$.global.AELL_PROBE_REPO = "' + fwd(REPO) + '";\n' +
      '$.global.AELL_PROBE_OUT = "' + fwd(RESULT_JSON) + '";\n' +
      '$.evalFile(new File("' +
        fwd(path.join(REPO, "scripts", "stagger-motion-probe.jsx")) + '"));\n');

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

  say("\n=== M1  layer ROOT property list ===");
  for (const r of by("1-root")) {
    say("  " + r.kind + " (" + r.numProperties + "): " + r.names.join(", "));
  }

  say("\n=== M2/M4  walk cost + verdict ===");
  for (const r of by("2-walk")) {
    say("  " + r.kind.padEnd(20) + " visited " + String(r.visited).padStart(5) +
        "  keyed=" + r.keyed + (r.why ? " (" + r.why + ")" : "") +
        (r.exprOn ? "  expr on " + r.exprOn + ": " + r.expr : "") +
        (r.exhausted ? "  BUDGET EXHAUSTED" : ""));
  }

  say("\n=== M3  source duration ===");
  for (const r of by("3-source")) {
    say("  " + r.kind.padEnd(14) + " hasSource=" + r.hasSource +
        " duration=" + r.duration + " isComp=" + r.isComp +
        " typeName=" + r.typeName + " hasAudio=" + r.hasAudio +
        " hasVideo=" + r.hasVideo);
  }

  say("\n=== M6  walk timing ===");
  for (const r of by("6-timing")) {
    say("  " + r.layers + " bare layers, " + r.nodes + " nodes in " + r.ms +
        " ms (" + Number(r.msPerNode).toFixed(3) + " ms/node)");
  }

  say("\n=== M5  the real receipt ===");
  for (const r of by("5-receipt")) say("  no keys : " + r.raw);
  for (const r of by("5-receipt-keyed")) say("  keyed   : " + r.raw);

  for (const r of by("CRASH")) {
    say("\n!! CRASH in " + r.stage + " line " + r.line + ": " + r.message);
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
