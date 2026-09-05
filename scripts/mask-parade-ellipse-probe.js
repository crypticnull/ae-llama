/*
 * mask-parade-ellipse-probe.js — launcher for
 * scripts/mask-parade-ellipse-probe.jsx. Filed by the 0.11.34 pass as its
 * top open item: one ellipse anywhere in a mask parade makes
 * AELL_paradeShows return "", and every sentence add_mask / set_mask /
 * delete_mask build on that reading goes quiet.
 *
 *   node scripts/mask-parade-ellipse-probe.js          # drives real AE
 *   node scripts/mask-parade-ellipse-probe.js --read   # re-print the last
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "logs");
const RESULT_JSON = path.join(OUT_DIR, "mask-parade-ellipse-probe.json");
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
    const wrapper = path.join(os.tmpdir(), "aell-parade-ellipse-wrapper.jsx");
    fs.writeFileSync(wrapper,
      '$.global.AELL_PROBE_REPO = "' + fwd(REPO) + '";\n' +
      '$.global.AELL_PROBE_OUT = "' + fwd(RESULT_JSON) + '";\n' +
      '$.evalFile(new File("' +
        fwd(path.join(REPO, "scripts", "mask-parade-ellipse-probe.jsx")) +
        '"));\n');

    say("driving " + exe);
    spawn(exe, ["-r", wrapper], { detached: true, stdio: "ignore" }).unref();

    // 18 area grids of 315 reads plus nine-point reads on each row, so
    // several times mask-ellipse-probe.js — 900 s.
    const deadline = Date.now() + 900000;
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
          if (parsed && stable >= 40) return resolve(parsed);
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

  say("");
  say("=== A0  the instrument ===");
  for (const r of by("0-bare")) {
    say("  bare layer   area=" + r.area + "  (1.0 expected)  " +
        r.read.points.join(" "));
  }
  for (const r of by("0-calib")) {
    say("  inscribed " + r.shape + "  area=" + r.area + "   " + r.note);
  }

  say("");
  say("=== A1  truth vs the SHIPPED reader vs the plan ===");
  say("  " + "row".padEnd(5) + "truth".padEnd(7) + "shipped".padEnd(10) +
      "plan".padEnd(7) + "area".padEnd(7) + "min/max");
  let disagree = 0, silent = 0;
  for (const r of by("1-row")) {
    const q = (s) => (s === "" ? "(silent)" : s);
    const flag = r.truth === r.want ? "" : "   <-- PLAN DISAGREES WITH AE";
    if (r.truth !== r.want) disagree++;
    if (r.shipped === "") silent++;
    say("  " + r.row.padEnd(5) + r.truth.padEnd(7) + q(r.shipped).padEnd(10) +
        q(r.want).padEnd(7) + String(r.area).padEnd(7) +
        r.min + "/" + r.max + flag);
    say("      " + r.why);
    say("      " + r.specs);
  }
  say("");
  say("  " + silent + " of " + by("1-row").length +
      " rows the shipped reader cannot answer; " + disagree +
      " rows where the plan's prediction is not what AE drew.");

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
