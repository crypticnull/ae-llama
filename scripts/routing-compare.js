/*
 * routing-compare.js — did compacting the tool docs cost the model a
 * tool?
 *
 * The panel picks its tool-doc form from the context window alone
 * (Tools.promptModeFor: compact below 24576). Compacting keeps a tool's
 * FIRST sentence and drops the rest, and the rest is where several tools
 * kept the casual phrase that routes to them ("group these", "make it
 * pop"). WORKPLAN 1c bullet 2 asks the question this script answers: run
 * the same sentences in both forms and see which steps only the full
 * docs can reach.
 *
 *   node scripts/chat-probe.js --steps 1,...,29                # compact
 *   node scripts/chat-probe.js --steps 1,...,29 --ctx 32768    # full
 *   node scripts/routing-compare.js --compact a.md,b.md \
 *                                   --full c.md,d.md
 *
 * TWO runs per mode, never one: the panel runs at temperature 0.7, so a
 * single differing step is noise, not a finding. A step only counts as a
 * REGRESSION when it failed in every compact run and passed in every
 * full one — that is a doc that lost a load-bearing sentence. Anything
 * that disagrees with itself inside a mode is reported as FLAKY and
 * proves nothing either way.
 *
 * Exits 1 when there is at least one regression (so the pass has
 * something to fix), 0 when there is none.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

/** Parse one chat-probe transcript into {mode, steps: {n: {title, pass}}} */
function readTranscript(file) {
  const text = fs.readFileSync(file, "utf8");
  const out = { file: path.basename(file), mode: null, ctx: null, steps: {} };
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    let m = line.match(/^- tool docs: (COMPACT|FULL)/);
    if (m) { out.mode = m[1].toLowerCase(); continue; }
    m = line.match(/^- ctx (\d+)/);
    if (m) { out.ctx = Number(m[1]); continue; }
    m = line.match(/^## (\d+)\. (.*) — (pass|FAIL)$/);
    if (m) {
      out.steps[Number(m[1])] = { title: m[2], pass: m[3] === "pass" };
    }
  }
  // Transcripts written before --ctx existed carry no "tool docs" line;
  // fall back to the rule the panel itself uses rather than guessing.
  if (!out.mode && out.ctx) out.mode = out.ctx < 24576 ? "compact" : "full";
  if (!out.mode) throw new Error(out.file + ": cannot tell which doc form " +
    "it ran — no 'tool docs' line and no ctx line");
  if (!Object.keys(out.steps).length) {
    throw new Error(out.file + ": no step headings found");
  }
  return out;
}

function list(v) {
  return v ? v.split(",").map(s => s.trim()).filter(Boolean) : [];
}

const compactFiles = list(argValue("--compact"));
const fullFiles = list(argValue("--full"));
if (!compactFiles.length || !fullFiles.length) {
  console.error("usage: node scripts/routing-compare.js " +
                "--compact a.md,b.md --full c.md,d.md");
  process.exit(2);
}

const runs = { compact: compactFiles.map(readTranscript),
               full: fullFiles.map(readTranscript) };
for (const mode of ["compact", "full"]) {
  for (const r of runs[mode]) {
    if (r.mode !== mode) {
      console.error("!! " + r.file + " says its docs were " + r.mode +
                    " but it was passed as --" + mode);
      process.exit(2);
    }
  }
}

// Only steps every run actually ran can be compared; say so rather than
// silently scoring a step one side skipped.
const counts = {};
for (const mode of ["compact", "full"]) {
  for (const r of runs[mode]) {
    for (const n of Object.keys(r.steps)) counts[n] = (counts[n] || 0) + 1;
  }
}
const total = runs.compact.length + runs.full.length;
const shared = Object.keys(counts).filter(n => counts[n] === total)
  .map(Number).sort((a, b) => a - b);
const skipped = Object.keys(counts).filter(n => counts[n] !== total)
  .map(Number).sort((a, b) => a - b);

function verdicts(mode, n) {
  return runs[mode].map(r => r.steps[n].pass);
}
function all(v, want) { return v.every(x => x === want); }

const rows = [];
for (const n of shared) {
  const c = verdicts("compact", n);
  const f = verdicts("full", n);
  const title = runs.full[0].steps[n].title;
  let kind;
  if (!all(c, c[0]) || !all(f, f[0])) kind = "flaky";
  else if (!c[0] && f[0]) kind = "REGRESSION";
  else if (c[0] && !f[0]) kind = "compact-only pass";
  else if (c[0]) kind = "both pass";
  else kind = "both fail";
  rows.push({ n, title, c, f, kind });
}

function cell(v) { return v.map(x => (x ? "pass" : "FAIL")).join(" "); }

console.log("# compact vs full tool docs — routing comparison");
console.log("");
console.log("compact runs: " + runs.compact.map(r => r.file).join(", "));
console.log("full runs:    " + runs.full.map(r => r.file).join(", "));
if (skipped.length) {
  console.log("NOT COMPARED (a run skipped them): " + skipped.join(", "));
}
console.log("");
console.log("| step | title | compact | full | verdict |");
console.log("| ---: | --- | --- | --- | --- |");
for (const r of rows) {
  console.log("| " + r.n + " | " + r.title + " | " + cell(r.c) + " | " +
              cell(r.f) + " | " + r.kind + " |");
}
console.log("");
const regressions = rows.filter(r => r.kind === "REGRESSION");
const flaky = rows.filter(r => r.kind === "flaky");
console.log("compact: " + runs.compact.map(r =>
  Object.values(r.steps).filter(s => s.pass).length + "/" +
  Object.keys(r.steps).length).join(", "));
console.log("full:    " + runs.full.map(r =>
  Object.values(r.steps).filter(s => s.pass).length + "/" +
  Object.keys(r.steps).length).join(", "));
console.log("regressions: " + (regressions.length
  ? regressions.map(r => r.n + " (" + r.title + ")").join("; ") : "none"));
console.log("flaky (prove nothing): " + (flaky.length
  ? flaky.map(r => r.n).join(", ") : "none"));
process.exit(regressions.length ? 1 : 0);
