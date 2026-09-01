// Regression test: what the MODEL actually receives about a big project.
//
// Measured in AE 2026 on a 200-layer comp inside a 206-item project (the
// numbers this file exists to defend):
//
//   get_project_info   27082 bytes
//   get_comp_details   22128 bytes
//   combined state     49198 bytes, against a 6000-byte prompt budget
//
// The panel guarded that budget with `json.slice(0, 6000)`. Because the
// state serialized `project` FIRST, 206 project items ate the whole
// budget and the model saw:
//
//   layer entries visible to model: 0 of 200
//   selected layer visible: false
//
// Not "truncated" — ABSENT. The system prompt tells the model to read
// `selected: true` out of the comp details to resolve "these layers", and
// on a real project there were no comp details at all. A byte slice also
// cuts mid-object, so what did arrive was unparseable JSON.
//
// Two fixes, tested here together because either alone still loses the
// comp: the host caps its own lists (and says what it left out), and the
// panel trims WHOLE ROWS with the comp trimmed LAST.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const hostSrc = fs.readFileSync(
  path.join(ROOT, "extension", "jsx", "hostscript.jsx"), "utf8");
const toolsSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "tools.js"), "utf8");

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------------------ stubbed AE

let NEXT_ID = 1;
const ALL_ITEMS = [];

function Item(name) { this.name = name; this.id = NEXT_ID++; this._parent = null; }
Object.defineProperty(Item.prototype, "parentFolder", {
  get() { return this._parent; },
  set(f) { this._parent = f; if (f) f.children.push(this); }
});
function FolderItem(name) { Item.call(this, name); this.children = []; }
FolderItem.prototype = Object.create(Item.prototype);
function CompItem(name) {
  Item.call(this, name);
  this.layers = [];
  // Every real comp carries these, and get_comp_details reports them.
  this.width = 1920; this.height = 1080;
  this.duration = 10; this.frameRate = 30;
  this.workAreaStart = 0; this.workAreaDuration = 10;
  this.resolutionFactor = [1, 1];
}
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
  this.name = name;
  this.enabled = true;
  this.inPoint = 0;
  this.outPoint = 10;
  this.startTime = 0;
  this.selected = false;
  // Real AE layer names in the field are not "P1" — a solid carries the
  // name the user typed, and the byte cost of the list is what this file
  // measures, so keep them realistic in length.
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
  rootFolder: root,
  expressionEngine: "javascript-1.0",
  file: null,
  activeItem: null,
  get numItems() { return ALL_ITEMS.length; },
  item(i) { return ALL_ITEMS[i - 1]; },
  items: {}
};
const app = { project, beginUndoGroup() {}, endUndoGroup() {} };
const $ = { global: {} };

function addItem(it) { it.parentFolder = root; ALL_ITEMS.push(it); return it; }

// A project shaped like the scratch project on the AE machine: a handful
// of comps and folders drowning in accumulated solid footage.
const SHOT = addItem(new CompItem("SHOT 010 main comp"));
addItem(new CompItem("SHOT 020 main comp"));
addItem(new CompItem("Titles v3"));
addItem(new FolderItem("Solids"));
addItem(new FolderItem("_COMPS"));
const NAMED_ITEMS = 5;
const FOOTAGE_ITEMS = 200;
for (let i = 1; i <= FOOTAGE_ITEMS; i++) {
  addItem(new FootageItem("Blue Solid " + i + " 100x100"));
}
project.activeItem = SHOT;

const LAYERS = 200;
const SELECTED_INDEX = 180;
for (let i = 1; i <= LAYERS; i++) {
  SHOT.layers.push(new AVLayer("Blue Solid " + i));
}
SHOT.layers[SELECTED_INDEX - 1].selected = true;

eval(hostSrc);
function call(tool, args) {
  return JSON.parse($.global.AELL_call(tool, JSON.stringify(args || {})));
}

// ------------------------------------------------- 1. the host's own caps

const det = call("get_comp_details", {});
assert(det.ok, "get_comp_details succeeds on a 200-layer comp");
assert(det.data.numLayers === LAYERS,
       "the TOTAL layer count is always reported (" + det.data.numLayers + ")");
assert(det.data.layers.length <= 41,
       "the layer list is capped, not dumped whole (" +
       det.data.layers.length + " rows)");
assert(det.data.layersShown === det.data.layers.length,
       "layersShown matches the rows actually sent");
assert(/Showing \d+ of 200 layers/.test(det.data.note || ""),
       "the omission is stated in the model's own terms: " +
       String(det.data.note).slice(0, 80));
assert(/start:\d+/.test(det.data.note || "") &&
       /limit:0/.test(det.data.note || ""),
       "and the note says how to get the rest (start / limit:0)");

// The one that would have caught the field bug: the user's selection is
// deep in the stack, far outside any first-N window.
const selRows = det.data.layers.filter(l => l.selected);
assert(selRows.length === 1 && selRows[0].index === SELECTED_INDEX,
       "the SELECTED layer survives the cap although it sits at index " +
       SELECTED_INDEX);
assert(/selected/i.test(det.data.note || ""),
       "the note mentions the selection so the model trusts the flag");

const all = call("get_comp_details", { limit: 0 });
assert(all.ok && all.data.layers.length === LAYERS,
       "limit:0 still returns every layer (panel-internal callers)");
assert(!all.data.note, "an uncapped result carries no truncation note");

const page2 = call("get_comp_details", { start: 41, limit: 10 });
const idx = page2.data.layers.map(l => l.index);
assert(idx.indexOf(41) >= 0 && idx.indexOf(40) < 0,
       "start/limit pages through the stack (got " + idx.join(",") + ")");
assert(idx.length === 10,
       "a page never exceeds its limit (got " + idx.length + " rows)");
// The selection is pulled in from index 180, so it SPENDS one of the ten
// slots and the window stops at 49. Deliberate: a page that quietly grew
// to limit+selection would put the byte budget back at the model's mercy.
assert(idx.indexOf(SELECTED_INDEX) >= 0 && idx.indexOf(50) < 0,
       "the selection costs a slot rather than widening the page");
assert(page2.data.layers.filter(l => l.selected).length === 1,
       "every page still carries the selection");

const beyond = call("get_comp_details", { start: 9999, limit: 5 });
assert(beyond.ok && beyond.data.layers.length > 0,
       "a start past the end clamps instead of returning nothing");

// A selection LARGER than the cap must not reopen the blowup.
for (let i = 0; i < LAYERS; i++) SHOT.layers[i].selected = true;
const allSel = call("get_comp_details", {});
assert(allSel.data.layers.length <= 41,
       "selecting all 200 layers does not uncap the list (" +
       allSel.data.layers.length + " rows)");
assert(JSON.stringify(allSel.data).length < 12000,
       "…and the result stays bounded (" +
       JSON.stringify(allSel.data).length + " bytes)");
for (let i = 0; i < LAYERS; i++) SHOT.layers[i].selected = false;
SHOT.layers[SELECTED_INDEX - 1].selected = true;

const info = call("get_project_info", {});
assert(info.ok, "get_project_info succeeds on a 205-item project");
assert(info.data.numItems === NAMED_ITEMS + FOOTAGE_ITEMS,
       "the TOTAL item count is always reported");
assert(info.data.items.length <= 40,
       "the item list is capped (" + info.data.items.length + " rows)");

// Comps and folders are what every comp/folder ARGUMENT is named after —
// footage is what a project accumulates. Dropping the wrong one would
// make the model invent comp names.
const shownNames = info.data.items.map(x => x.name);
for (const n of ["SHOT 010 main comp", "SHOT 020 main comp", "Titles v3",
                 "Solids", "_COMPS"]) {
  assert(shownNames.indexOf(n) >= 0,
         "a capped project still lists '" + n + "'");
}
assert(/Showing \d+ of 205 items/.test(info.data.note || "") &&
       /footage/.test(info.data.note || ""),
       "the note says what was dropped: " +
       String(info.data.note).slice(0, 90));
const order = info.data.items.map(x => x.id);
assert(JSON.stringify(order) === JSON.stringify(order.slice().sort((a, b) => a - b)),
       "the surviving items stay in project-panel order");
assert(call("get_project_info", { limit: 0 }).data.items.length ===
       NAMED_ITEMS + FOOTAGE_ITEMS,
       "limit:0 still returns the whole project");

// The ACTIVE comp is the one name every request needs. Bury it under more
// comps than the cap allows and it must still come back — project order
// alone would have dropped it, because AE numbers new items LAST.
for (let i = 1; i <= 60; i++) addItem(new CompItem("Filler comp " + i));
const buried = call("get_project_info", {});
assert(buried.data.items.length <= 40,
       "a project of 60+ comps is still capped (" +
       buried.data.items.length + " rows)");
assert(buried.data.items.map(x => x.name).indexOf("SHOT 010 main comp") >= 0,
       "…and the ACTIVE comp is never the one that gets dropped");
assert(buried.data.items.filter(x => x.name === "SHOT 010 main comp").length === 1,
       "…exactly once, not duplicated into the list");
const bOrder = buried.data.items.map(x => x.id);
assert(JSON.stringify(bOrder) ===
       JSON.stringify(bOrder.slice().sort((a, b) => a - b)),
       "…and project-panel order is preserved even so");
for (let i = 0; i < 60; i++) ALL_ITEMS.pop();

// ------------------------------------- 2. the panel's state block budget

const window = { setTimeout, clearTimeout, console };
window.AEBridge = {
  evalScript(script, cb) {
    const m = script.match(/^AELL_call\("([^"]+)", (.*)\)$/);
    const out = m ? $.global.AELL_call(m[1], JSON.parse(m[2]))
                  : JSON.stringify({ ok: false, error: "no" });
    setTimeout(() => cb(out, false), 0);
  }
};
new Function("window", toolsSrc)(window);
const Tools = window.Tools;
assert(typeof Tools.fetchProjectState === "function",
       "tools.js owns fetchProjectState (testable without a panel)");

Tools.fetchProjectState(function (json) {
  assert(json.length <= 6000,
         "the state block fits the prompt budget (" + json.length + " bytes)");

  let state = null;
  try { state = JSON.parse(json); } catch (e) { /* left null */ }
  assert(state !== null,
         "…and it is still VALID JSON — nothing is cut mid-object");
  if (!state) { done(); return; }

  // The failure the field bug actually produced.
  assert(!!state.activeComp,
         "the ACTIVE COMP reaches the model at all");
  assert(state.activeComp.name === "SHOT 010 main comp" &&
         state.activeComp.numLayers === LAYERS,
         "…named, with its true layer count (" +
         state.activeComp.numLayers + ")");
  assert(state.activeComp.layers.length > 0,
         "…and with layers (" + state.activeComp.layers.length +
         " of " + LAYERS + ")");
  const sel = state.activeComp.layers.filter(l => l.selected);
  assert(sel.length === 1 && sel[0].index === SELECTED_INDEX,
         "the user's SELECTED layer is in the prompt, not squeezed out");

  assert(Object.keys(state)[0] === "activeComp",
         "activeComp is serialized FIRST, so a downstream cut hits the " +
         "project list instead of the comp");
  assert(!!state.project && state.project.numItems === NAMED_ITEMS + FOOTAGE_ITEMS,
         "the project half still reports its true size");

  // Whatever the trimming dropped, the model is TOLD it was dropped.
  if (state.activeComp.layers.length < LAYERS) {
    assert(/Showing \d+ of 200 layers/.test(state.activeComp.note || ""),
           "trimmed layers are declared: " +
           String(state.activeComp.note).slice(0, 70));
  }
  // The comp is trimmed LAST, so the project list is what shrinks — and
  // comps-first ordering is what makes that survivable: the names the
  // model has to quote are still there.
  const left = state.project.items.map(x => x.name);
  for (const n of ["SHOT 010 main comp", "SHOT 020 main comp", "Titles v3",
                   "Solids", "_COMPS"]) {
    assert(left.indexOf(n) >= 0,
           "'" + n + "' survives the panel-side trim too (" +
           left.length + " items left)");
  }
  if (state.project.items.length < NAMED_ITEMS + FOOTAGE_ITEMS) {
    assert(/Showing \d+ of \d+ items/.test(state.project.note || ""),
           "trimmed items are declared: " +
           String(state.project.note).slice(0, 70));
  }

  assert(state.project.items.some(x => x.name === "SHOT 010 main comp"),
         "the panel's trim also refuses to drop the active comp");

  // The pre-fix arithmetic, so the numbers in the header stay honest.
  const raw = JSON.stringify({
    project: call("get_project_info", { limit: 0 }).data,
    activeComp: call("get_comp_details", { limit: 0 }).data
  });
  assert(raw.length > 6000 * 3,
         "an uncapped state is still far over budget (" + raw.length +
         " bytes) — the cap is load-bearing, not decorative");
  assert(raw.slice(0, 6000).indexOf('"activeComp"') < 0,
         "and the old byte-slice would still lose the comp entirely");

  // ---------------------------------------------- the prompt's own size
  //
  // Context is a functional resource (CLAUDE.md, owner 2026-09-01). The
  // full prompt measured 58,766 chars with no state on 2026-09-01 —
  // about 15K tokens against the 16,384 default window, which left no
  // room for a conversation. Two guards: the full form may not grow past
  // its ceiling without a matching cut, and the compact form (what a
  // 16K window actually gets) must be a real cut, not a rounding error.
  const Tools = window.Tools;
  const full = Tools.buildSystemPrompt("");
  const compact = Tools.buildSystemPrompt("", { compact: true });
  const FULL_CEILING = 59000;
  assert(full.length <= FULL_CEILING,
         "the full prompt stays under its ceiling (" + full.length +
         " of " + FULL_CEILING + ") — growth needs a matching cut");
  assert(compact.length < full.length * 0.72,
         "compact docs cut the prompt by more than a quarter (" +
         compact.length + " vs " + full.length + ")");
  for (const t of Tools.TOOL_DEFS) {
    if (compact.indexOf("- " + t.name + " " + t.args) === -1) {
      assert(false, "compact mode keeps every tool's args line: " + t.name);
      break;
    }
  }
  const rulesEnd = (s) => s.indexOf("Available tools:");
  assert(full.slice(0, rulesEnd(full)) === compact.slice(0, rulesEnd(compact)),
         "compact mode never touches the rules block (where the phrase " +
         "lists that route casual language live)");
  assert(/one or two short sentences/.test(full),
         "the reply-brevity rule is in the prompt");

  // The window arithmetic, on the measured sizes.
  const hb16 = Tools.historyBudget(16384, full.length);
  assert(hb16.starved,
         "at 16K the FULL prompt leaves the window starved (" +
         hb16.chars + " chars of history)");
  const hb16c = Tools.historyBudget(16384, compact.length);
  assert(hb16c.chars > hb16.chars,
         "and the compact prompt leaves more room (" + hb16c.chars + " vs " +
         hb16.chars + ")");
  const hb32 = Tools.historyBudget(32768, full.length);
  assert(!hb32.starved && hb32.chars > 20000,
         "at 32K the full prompt leaves a real conversation (" +
         hb32.chars + " chars)");
  assert(Tools.promptModeFor(16384).compact === true &&
         Tools.promptModeFor(32768).compact === false,
         "prompt mode follows the window: compact under 24K, full above");
  assert(Tools._compactDesc("First sentence here. Second sentence.") ===
         "First sentence here.",
         "compactDesc keeps the first sentence");
  const long = Tools._compactDesc("A".repeat(50) + " " + "B".repeat(200) + ".");
  assert(long.length <= 111 && /…$/.test(long),
         "a long first sentence is cut at a word boundary with an ellipsis");

  done();
});

function done() {
  console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
}
