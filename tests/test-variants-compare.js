/*
 * test-variants-compare.js — scripts/lib/variants-compare.js, the §24d bar
 * applied to chat-probe --variants transcripts (WORKPLAN §13b, NEXT UP 11b).
 *
 * The table rows are REAL transcript lines (logs/chat-probe-2026-09-16T16-25-01.md,
 * 7B Q4_K_M, ctx 16384, shipped KV), trimmed to a handful. The shape they
 * carry that a hand-written row would not: HARM is written **HARM** in
 * bold, miss and pass are bare, and a verdict carries its own reason
 * after an em dash.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const VC = require(path.join(__dirname, "..", "scripts", "lib", "variants-compare.js"));

let n = 0;
function check(name, fn) { fn(); n++; console.log("ok - " + name); }

const HEAD = [
  "# chat probe 2026-09-16T16-25-01", "",
  "- ctx 16384, temperature 0.7, maxRounds 6", "",
  "## the paraphrase matrix", "",
  "| # | scenario | phrasing | said | tools | verdict |",
  "|---|----------|----------|------|-------|---------|"
];
const ROW = {
  comp: "| 1 | create a comp | canonical | Make a new comp called Probe Room, 1920x1080, 6 seconds long at 30 fps. | create_comp | pass |",
  gridHarm: "| 2 | grid layout | canonical | In Probe Room, add nine red 200x200 square solids and arrange them in a 3 by 3 grid in the middle of the comp. | add_solid add_solid grid_layout | **HARM** — only 8 solids in the comp |",
  gridPass: "| 2 | grid layout | canonical | In Probe Room, add nine red 200x200 square solids and arrange them in a 3 by 3 grid in the middle of the comp. | add_solid grid_layout | pass |",
  spaceMiss: "| 7 | equidistant distribution | canonical | Spread the nine squares out equally across the width of the comp, from x 200 to x 1720. | distribute_property | miss — only 8 squares to space |",
  tuckCasualHarm: "| 60 | tuck one layer under another | casual | shove Beta below HELLO in the stack | reorder_layers | **HARM** — 2 of the other 11 layers changed places — a SORT ran where one layer should have moved |",
  tuckCasualMiss: "| 60 | tuck one layer under another | casual | shove Beta below HELLO in the stack |  | miss — Beta is at index 1 and HELLO at 3 |"
};
function doc(rows) { return HEAD.concat(rows, ["", "## step 1", "| 9 | not | a | matrix | row | pass |"]).join("\n"); }

check("parses grades, keys and the reason after the dash; stops at the next section", function () {
  const rows = VC.parseMatrix(doc([ROW.comp, ROW.gridHarm, ROW.spaceMiss]));
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.map(function (r) { return r.grade; }), ["pass", "harm", "miss"]);
  assert.strictEqual(rows[1].key, "grid layout / canonical");
  assert.strictEqual(rows[1].detail, "only 8 solids in the comp");
  assert.strictEqual(rows[2].detail, "only 8 squares to space");
});

check("a transcript with no matrix parses to NO rows, never to zero misses", function () {
  assert.strictEqual(VC.parseMatrix("# chat probe\n\n=== step 1 ===\n== pass").length, 0);
});

check("counts: canonical not passing includes both miss and HARM", function () {
  const c = VC.counts(VC.parseMatrix(doc([ROW.comp, ROW.gridHarm, ROW.spaceMiss, ROW.tuckCasualMiss])));
  assert.deepStrictEqual([c.runs, c.pass, c.miss, c.harm, c.canonicalFail], [4, 1, 2, 1, 2]);
});

check("a HARM the baseline also had is not new; a canonical that stopped passing is a regression", function () {
  const base = [VC.parseMatrix(doc([ROW.comp, ROW.gridHarm, ROW.spaceMiss]))];
  const same = [VC.parseMatrix(doc([ROW.comp, ROW.gridHarm, ROW.spaceMiss]))];
  assert.strictEqual(VC.compare(base, same).green, true);
  const worse = [VC.parseMatrix(doc([ROW.comp.replace("| pass |", "| miss — no comp |"), ROW.gridHarm, ROW.spaceMiss]))];
  const r = VC.compare(base, worse);
  assert.strictEqual(r.green, false);
  assert.deepStrictEqual(r.candidate[0].canonicalRegressions, ["create a comp / canonical"]);
});

check("a row that went miss -> HARM is new HARM, and fails the bar", function () {
  const base = [VC.parseMatrix(doc([ROW.tuckCasualMiss]))];
  const cand = [VC.parseMatrix(doc([ROW.tuckCasualHarm]))];
  const r = VC.compare(base, cand);
  assert.deepStrictEqual(r.candidate[0].newHarm, ["tuck one layer under another / casual"]);
  assert.strictEqual(r.green, false);
});

check("misses: the bar is the worst baseline run + 2, and each candidate run must clear it alone", function () {
  const m = function (i) { return ROW.spaceMiss.replace("| 7 | equidistant distribution |", "| " + i + " | s" + i + " |"); };
  const base = [VC.parseMatrix(doc([m(1)])), VC.parseMatrix(doc([m(1), m(2)]))];   // worst = 2
  const ok = VC.parseMatrix(doc([m(1), m(2), m(3), m(4)]));                          // 4 = bar
  const over = VC.parseMatrix(doc([m(1), m(2), m(3), m(4), m(5)]));                  // 5 > bar
  assert.strictEqual(VC.compare(base, [ok]).baseMissMax, 2);
  assert.strictEqual(VC.compare(base, [ok]).green, true);
  assert.strictEqual(VC.compare(base, [ok, over]).green, false);
});

check("a baseline run that fixes a row does not make the other baseline run's pass a regression source", function () {
  // grid passed in base run 2 only: a candidate harming grid is NOT new HARM
  // (base run 1 harmed it) but IS a canonical regression (base run 2 passed it).
  const base = [VC.parseMatrix(doc([ROW.gridHarm])), VC.parseMatrix(doc([ROW.gridPass]))];
  const r = VC.compare(base, [VC.parseMatrix(doc([ROW.gridHarm]))]);
  assert.deepStrictEqual(r.candidate[0].newHarm, []);
  assert.deepStrictEqual(r.candidate[0].canonicalRegressions, ["grid layout / canonical"]);
});

check("a transcript names its config by label or reused-server line, and an unlabelled one reads as null", function () {
  const head = "# chat probe X\n\n- model: `m`\n- label: q8_0 16K\n" +
    "- server (reused): `C:/q.gguf`, n_ctx 16384\n\n## the paraphrase matrix\n- label: not header\n";
  assert.deepStrictEqual(VC.readIdentity(head),
    { label: "q8_0 16K", server: "`C:/q.gguf`, n_ctx 16384" });
  assert.strictEqual(VC.readIdentity("# chat probe X\n\n- model: `m`\n\n## the paraphrase matrix\n"), null);
});

console.log("\n" + n + " checks passed");
