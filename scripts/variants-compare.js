/*
 * variants-compare.js — hold chat-probe --variants transcripts for one
 * config against another by the §24d bar (see scripts/lib/variants-compare.js).
 *
 *   node scripts/variants-compare.js --base a.md[,b.md] --cand c.md[,d.md]
 *        [--skip-scenarios "title one;title two"]
 *
 * Exit 0 when every candidate run clears the bar, 1 when one does not,
 * 2 on bad input (a transcript with no matrix table is refused, never
 * counted as zero misses).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const VC = require(path.join(__dirname, "lib", "variants-compare.js"));

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

// Scenario titles to leave out on BOTH sides, ";"-separated — for rows one
// run could not take on equal terms (e.g. a generation step whose backend
// was up in one run and down in the other).
const SKIP = (argValue("--skip-scenarios") || "").split(";")
  .map(function (s) { return s.trim(); }).filter(Boolean);

function load(list, side) {
  if (!list) { console.error("missing --" + side); process.exit(2); }
  return list.split(",").map(function (f) {
    const rows = VC.parseMatrix(fs.readFileSync(f, "utf8"))
      .filter(function (r) { return SKIP.indexOf(r.scenario) === -1; });
    if (!rows.length) {
      console.error(f + ": no paraphrase-matrix table (was it a --variants run?)");
      process.exit(2);
    }
    const text = fs.readFileSync(f, "utf8");
    const id = VC.readIdentity(text);
    if (!id) {
      console.error("WARNING " + path.basename(f) + ": no label and no reused-server " +
                    "line — which config this run measured is an assumption, not a record");
    }
    return { file: f, rows: rows, id: id };
  });
}

const base = load(argValue("--base"), "base");
const cand = load(argValue("--cand"), "cand");
const r = VC.compare(base.map(function (t) { return t.rows; }),
                     cand.map(function (t) { return t.rows; }));

function line(label, t, c) {
  return label + " " + path.basename(t.file) +
    " [" + (t.id ? (t.id.label || t.id.server) : "unlabelled") + "]: " + c.runs + " runs, pass " +
    c.pass + ", miss " + c.miss + ", HARM " + c.harm +
    (c.unknown ? ", ungraded " + c.unknown : "") +
    ", canonical not passing " + c.canonicalFail;
}
base.forEach(function (t, i) { console.log(line("base", t, r.baseline[i])); });
cand.forEach(function (t, i) {
  const c = r.candidate[i];
  console.log(line("cand", t, c));
  console.log("  new HARM (" + c.newHarm.length + "): " + (c.newHarm.join("; ") || "none"));
  console.log("  canonical regressions (" + c.canonicalRegressions.length + "): " +
              (c.canonicalRegressions.join("; ") || "none"));
  console.log("  misses " + c.miss + " vs bar " + (r.baseMissMax + 2) +
              (c.missesOverBar ? " — OVER" : " — ok"));
  console.log("  => " + (c.green ? "GREEN" : "RED"));
});
console.log("verdict: " + (r.green ? "GREEN" : "RED"));
process.exit(r.green ? 0 : 1);
