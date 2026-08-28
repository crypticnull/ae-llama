// Regression test: what the MODEL actually receives back from a TOOL.
//
// Sibling of test-context-budget.js, which defends the state block at the
// top of the system prompt. This file defends the other half of the same
// promise — the results the model reads after it calls something — and it
// exists because that half was still byte-slicing long after the state
// block stopped.
//
// Measured in real AE 2026 on a 200-layer comp (WORKPLAN item 4, the
// performance bullet). Serialized size of one tool result, against the
// panel's old fixed 1200-byte per-result cap:
//
//   get_comp_details      7305   (already row-capped at 40 by the HOST)
//   stagger_layers        7262
//   grid_layout           7258
//   distribute_property   6529
//   list_properties       5648
//   scale_comp            3577
//   list_effects          3514
//   get_project_info      3207   (already row-capped at 40 by the HOST)
//   distribute_property   2286   (the overriddenByExpression path)
//   set_layer_parent      1589
//   audit_comp_usage      1442
//   rename_comps          1339
//
// Eleven of the tools the model leans on hardest, and `slice(0, 1200)`
// handed every one of them over as JSON cut mid-object — no closing
// brace, no count of what went missing, nothing to tell the model it was
// reading a fragment. Two of them had ALREADY been bounded host-side by
// the 2026-08-21 pass: the host's 40-row cap and the panel's 1200-byte
// cap were never reconciled, so forty rows the host went to the trouble
// of selecting arrived as six.
//
// The rule, the same one budgetState follows: NOTHING IS BYTE-SLICED.
// Whole rows come off the END of the longest array (these lists are
// ordered, so the head is the informative part), the result says how many
// of how many survived, and what is sent is always parseable JSON.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const hostSrc = fs.readFileSync(
  path.join(ROOT, "extension", "jsx", "hostscript.jsx"), "utf8");
const toolsSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "tools.js"), "utf8");
const mainSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "main.js"), "utf8");

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

const window = {};
new Function("window", toolsSrc)(window);
const Tools = window.Tools;

const BUDGET = 6000;

/** What the model is handed: parse it, or the test has found the bug. */
function sent(results) {
  const out = Tools.compactToolResults(results);
  let parsed = null, err = null;
  try { parsed = JSON.parse(out); } catch (e) { err = e; }
  return { text: out, parsed, err };
}

// --------------------------------------------- 1. the field-shaped rows

// Layer names are the ones the field probe used: real names carry real
// bytes, and the byte count is the whole subject of this file.
function placedRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ layer: "Sq " + (i + 1), row: Math.floor(i / 20), col: i % 20 });
  }
  return rows;
}
function gridResult() {
  return { ok: true, data: {
    control: "Grid Control", columns: 20, rows: 10,
    sliders: ["Grid X Spacing", "Grid Y Spacing", "Grid Columns"],
    initialSpacing: [120, 120], placed: placedRows(200),
    note: "Move 'Grid Control' to move the whole grid"
  } };
}

const gridRaw = JSON.stringify(gridResult());
assert(gridRaw.length > 6000,
       "the measured grid_layout result really is over 6 KB (" +
       gridRaw.length + " bytes) — the fixture matches the field");

// The bug, stated as a test: the OLD cap produced invalid JSON.
let oldCutParses = true;
try { JSON.parse(gridRaw.slice(0, 1200) + " …(truncated)"); }
catch (e) { oldCutParses = false; }
assert(!oldCutParses,
       "the old byte-slice DID hand the model unparseable JSON " +
       "(this is the bug; if this assertion ever passes, re-read it)");

// ------------------------------------------------- 2. always valid JSON

{
  const r = sent([gridResult()]);
  assert(!r.err, "a 7 KB result now arrives as parseable JSON");
  assert(r.text.length <= BUDGET,
         "and inside the round budget (" + r.text.length + " bytes)");
  const d = r.parsed[0].data;
  assert(Array.isArray(d.placed) && d.placed.length > 0,
         "with rows the model can actually read (" + d.placed.length + ")");
  assert(d.placed[0].layer === "Sq 1",
         "rows come off the END, so the head of the list survives");
  assert(/placed: \d+ of 200 shown/.test(String(d.truncated)),
         "and the result SAYS how many of how many it is showing: " +
         d.truncated);
  assert(/NOT by the tool/.test(String(d.truncated)),
         "worded so the model cannot read the omission as a tool failure");
  assert(d.control === "Grid Control" && d.columns === 20,
         "the scalar fields — the ones the model quotes back — are intact");
}

// --------------------------------------- 3. the caller's object is safe

{
  const live = gridResult();
  Tools.compactToolResults([live]);
  assert(live.data.placed.length === 200,
         "shrinking is done on a copy — the transcript the USER sees " +
         "keeps every row");
  assert(live.data.truncated === undefined,
         "and the caller's result is not annotated behind its back");
}

// ------------------------------------------------------ 4. fair sharing

{
  const ack = { ok: true, data: { index: 1, name: "PBox" } };
  const keys = { ok: true, data: { layers: 200, property: "Opacity",
                                   keysSet: 600 } };
  const r = sent([ack, gridResult(), keys]);
  assert(!r.err, "a mixed round stays parseable");
  assert(r.text.length <= BUDGET,
         "and inside the budget (" + r.text.length + " bytes)");
  assert(r.parsed[0].data.name === "PBox" &&
         r.parsed[2].data.keysSet === 600,
         "small results are never trimmed to make room — they had room");
  const kept = r.parsed[1].data.placed.length;
  assert(kept > 30,
         "and the one big result inherits what they did not use (" + kept +
         " rows; the old fixed 1200-byte cap allowed about 12)");

  const solo = sent([gridResult()]);
  assert(solo.parsed[0].data.placed.length >= kept,
         "a result that runs ALONE gets at least as much as one sharing " +
         "the round");
}

// ------------------------------------- 5. the budget holds under crowds

for (const n of [1, 2, 3, 8, 20]) {
  const many = [];
  for (let i = 0; i < n; i++) many.push(gridResult());
  const r = sent(many);
  assert(!r.err, n + " oversized results in one round: still parseable");
  assert(r.text.length <= BUDGET,
         n + " oversized results: " + r.text.length + " bytes, within " +
         BUDGET);
  assert(r.parsed.length === n, n + " results in, " + n + " results out");
}

// ---------------------------------- 6. two arrays in one result, and none

{
  // distribute_property against 200 expression-driven layers: the rows it
  // applied AND the layers it refused, in the same result.
  const names = placedRows(200).map(r => r.layer);
  const r = sent([{ ok: true, data: {
    property: "opacity", layers: 200, applied: placedRows(150),
    overriddenByExpression: names,
    note: "200 of 200 layer(s) did NOT move because an expression drives it"
  } }]);
  assert(!r.err, "a result carrying TWO long lists stays parseable");
  const d = r.parsed[0].data;
  assert(d.applied.length + d.overriddenByExpression.length > 0,
         "and keeps rows from them");
  assert(/\d+ of \d+ shown/.test(String(d.truncated)),
         "reporting each list it shortened: " + d.truncated);
  assert(d.note.indexOf("did NOT move") > 0,
         "the grounded note survives the trim — it is the part that " +
         "explains the empty list");
}

{
  // Nothing to drop rows FROM: one enormous error string.
  const r = sent([{ ok: false, error: "x".repeat(9000) }]);
  assert(!r.err, "a result with no arrays at all is still valid JSON");
  assert(r.text.length <= BUDGET, "and still inside the budget");
  assert(r.parsed[0].ok === false,
         "with ok:false intact — the model must still see that it failed");
}

{
  assert(sent([]).text === "[]", "an empty round is an empty array");
}

// ------------------------- 7. the HOST's own cap, against this budget

// The two tools the 2026-08-21 pass bounded host-side are the ones that
// prove the caps were never reconciled: 40 rows is still ~7 KB.
{
  const ALL_ITEMS = [];
  let NEXT_ID = 1;
  function Item(name) { this.name = name; this.id = NEXT_ID++; this._parent = null; }
  Object.defineProperty(Item.prototype, "parentFolder", {
    get() { return this._parent; },
    set(f) { this._parent = f; if (f) f.children.push(this); }
  });
  function FolderItem(name) { Item.call(this, name); this.children = []; }
  FolderItem.prototype = Object.create(Item.prototype);
  function CompItem(name) { Item.call(this, name); this.layers = []; }
  CompItem.prototype = Object.create(Item.prototype);
  Object.defineProperty(CompItem.prototype, "numLayers", {
    get() { return this.layers.length; }
  });
  CompItem.prototype.layer = function (i) {
    const l = this.layers[i - 1];
    if (!l) throw new Error("No layer " + i);
    return l;
  };
  function FootageItem(name) { Item.call(this, name); }
  FootageItem.prototype = Object.create(Item.prototype);
  function SolidSource() {}
  function AVLayer(name) {
    this.name = name; this.enabled = true;
    this.inPoint = 0; this.outPoint = 10; this.startTime = 0;
    this.selected = false;
    this.source = { mainSource: new SolidSource() };
  }
  AVLayer.prototype.property = function () {
    return { numProperties: 0, property() { return null; } };
  };
  function TextLayer() {} function ShapeLayer() {}
  function CameraLayer() {} function LightLayer() {}
  const ParagraphJustification = {};

  const root = new FolderItem("(root)");
  const project = {
    rootFolder: root, expressionEngine: "javascript-1.0", file: null,
    activeItem: null,
    get numItems() { return ALL_ITEMS.length; },
    item(i) { return ALL_ITEMS[i - 1]; },
    items: {}
  };
  const app = { project, beginUndoGroup() {}, endUndoGroup() {} };
  const $ = { global: {} };
  function addItem(it) { it.parentFolder = root; ALL_ITEMS.push(it); return it; }

  const SHOT = addItem(new CompItem("SHOT 010 main comp"));
  for (let i = 1; i <= 200; i++) {
    addItem(new FootageItem("Blue Solid " + i + " 100x100"));
  }
  project.activeItem = SHOT;
  for (let i = 1; i <= 200; i++) SHOT.layers.push(new AVLayer("Blue Solid " + i));
  SHOT.layers[179].selected = true;

  eval(hostSrc);
  const det = JSON.parse($.global.AELL_call("get_comp_details", "{}"));
  const raw = JSON.stringify(det);
  assert(det.ok && det.data.layers.length <= 40,
         "the host still caps its own list at AELL_LIST_LIMIT rows");
  assert(raw.length > 1200 * 3,
         "and that CAPPED result is still " + raw.length + " bytes — far " +
         "past the old per-result cap, which is why the reconciliation " +
         "had to happen at the panel");

  const r = sent([det]);
  assert(!r.err, "a real capped get_comp_details now reaches the model whole");
  assert(r.parsed[0].data.numLayers === 200,
         "with the TRUE layer count still on it");
  assert(r.parsed[0].data.layers.length > 0,
         "and layer rows the model can resolve names from (" +
         r.parsed[0].data.layers.length + ")");
  assert(r.parsed[0].data.layers.some(l => l.selected) ||
         /layers: \d+ of/.test(String(r.parsed[0].data.truncated)),
         "and either the selected layer or an honest count of what went");
}

// ------------------------------------------------------ 8. anti-drift

assert(/global\.Tools\.compactToolResults/.test(mainSrc),
       "main.js delegates the budgeting to tools.js, where it is testable");
assert(!/slice\(0,\s*1200\)/.test(mainSrc),
       "main.js no longer byte-slices a tool result at 1200");
assert(!/out\.slice\(0,\s*6000\)/.test(mainSrc),
       "nor byte-slices the combined round at 6000");
assert(typeof Tools.compactToolResults === "function",
       "Tools.compactToolResults is exported");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
