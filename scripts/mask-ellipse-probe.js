/*
 * mask-ellipse-probe.js — launcher for scripts/mask-ellipse-probe.jsx.
 * WORKPLAN item 8 follow-up, filed by the 0.11.28 pass as its top item:
 * an ELLIPSE is not its bounding box, and three of add_mask's sentences
 * assume it is.
 *
 *   node scripts/mask-ellipse-probe.js          # drives real AE
 *   node scripts/mask-ellipse-probe.js --read   # re-print the last run
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO, "logs");
const RESULT_JSON = path.join(OUT_DIR, "mask-ellipse-probe.json");
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
    const wrapper = path.join(os.tmpdir(), "aell-mask-ellipse-wrapper.jsx");
    fs.writeFileSync(wrapper,
      '$.global.AELL_PROBE_REPO = "' + fwd(REPO) + '";\n' +
      '$.global.AELL_PROBE_OUT = "' + fwd(RESULT_JSON) + '";\n' +
      '$.evalFile(new File("' +
        fwd(path.join(REPO, "scripts", "mask-ellipse-probe.jsx")) + '"));\n');

    say("driving " + exe);
    spawn(exe, ["-r", wrapper], { detached: true, stdio: "ignore" }).unref();

    // ~60 nine-point reads plus 12 area grids of 99, so of the same order
    // as mask-above-probe.js — same 600 s deadline.
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

  const bare = by("0-bare")[0];
  say("");
  say("=== A0  the bare layer, and the area instrument ===");
  if (bare) {
    say("  bare       mean=" + bare.mean + " corners=" + bare.corners +
        " mids=" + bare.mids + " area=" + bare.area);
  }
  for (const r of by("0-calib")) {
    say("  calib " + r.shape.padEnd(10) + "area showing = " + r.area +
        (r.shape === "ellipse" ? "   (pi/4 = 0.785)" : "   (1.0 expected)"));
  }

  say("");
  say("=== A1  the same region, ellipse vs rectangle, on a bare layer ===");
  say("  " + "mode".padEnd(22) + "ellipse: corners mids centre".padEnd(34) +
      "rectangle: corners mids centre");
  const alone = by("1-alone");
  const seen = [];
  for (const r of alone) {
    const key = r.mode + (r.inverted ? " + inverted" : "");
    if (seen.indexOf(key) !== -1) continue;
    seen.push(key);
    const cell = (shape) => {
      const hit = alone.filter((x) => x.shape === shape && x.mode === r.mode &&
        x.inverted === r.inverted)[0];
      if (!hit) return "?";
      const centre = (hit.points.filter((p) => /^centre=/.test(p))[0] || "")
        .replace("centre=", "");
      return (hit.corners + "  " + hit.mids + "  " + centre);
    };
    const e = cell("ellipse"), q = cell("rectangle");
    say("  " + key.padEnd(22) + e.padEnd(34) + q +
        (e === q ? "" : "   <-- DIFFER"));
  }

  say("");
  say("=== A2  area still showing, per row ===");
  const areas = by("2-area");
  const tags = [];
  for (const r of areas) if (tags.indexOf(r.tag) === -1) tags.push(r.tag);
  for (const t of tags) {
    const pick = (s) => {
      const hit = areas.filter((x) => x.tag === t && x.shape === s)[0];
      return hit ? String(hit.area) : "?";
    };
    say("  " + t.padEnd(20) + "ellipse " + pick("ellipse").padEnd(8) +
        "rectangle " + pick("rectangle"));
  }

  say("");
  say("=== A3  over one add mask on the left half ===");
  const b3 = by("3-base")[0];
  if (b3) {
    say("  base       mean=" + b3.mean + " corners=" + b3.corners +
        " mids=" + b3.mids);
  }
  for (const r of by("3-over")) {
    say("  " + r.tag.padEnd(16) + r.shape.padEnd(11) +
        ("mean " + r.baseMean + " -> " + r.mean).padEnd(22) +
        "corners=" + r.corners + " mids=" + r.mids +
        (r.sameAsBase ? "  (unchanged)" : ""));
  }

  say("");
  say("=== A4  what the shipped tool answers today ===");
  for (const r of by("4-receipt")) {
    const parsed = (() => {
      try { return JSON.parse(r.raw); } catch (e) { return null; }
    })();
    const w = parsed
      ? (parsed.ok
          ? (parsed.data.warning || parsed.data.note || "(no warning)")
          : "REFUSED: " + parsed.error)
      : r.raw;
    say("  " + r.shape.padEnd(11) + r.tag.padEnd(22) +
        "mean=" + String(r.mean).padEnd(7) + "corners=" +
        String(r.corners).padEnd(7) + "mids=" + r.mids);
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
