// Regression test: audit_comp_usage + rename_comps.
//
// The owner has a real roofing-presentation project whose comp names must
// come onto the org convention. Renaming comps is not a cosmetic act, and
// the facts below were MEASURED in AE 2026 before any of this was written
// (WORKPLAN-LOG 2026-08-25) — the stub models them, so a change that
// forgets one fails here rather than in the owner's project:
//
//  1. AE does NOT rewrite comp("Old Name") strings when a comp is
//     renamed. The expression breaks and AE disables it.
//  2. THE TRAP: after the break, prop.value still returns the same
//     number. Only prop.expressionError reveals it. Anything that
//     checked values would report a clean rename over a broken project,
//     which is exactly the failure this tool exists to prevent.
//  3. item.usedIn lists DIRECT parents only — not transitive — collapses
//     a comp used twice in one parent to a single entry, and still counts
//     a layer that is DISABLED.
//  4. A comp used as a LAYER is an object reference and survives a
//     rename untouched. Only the string forms are at risk.
//  5. A render-queue item follows its comp through a rename, so queue
//     membership is only ever answered by identity, never by name.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HOST = path.join(ROOT, "extension", "jsx", "hostscript.jsx");
const TOOLS = path.join(ROOT, "extension", "js", "tools.js");
const hostSrc = fs.readFileSync(HOST, "utf8");
const toolsSrc = fs.readFileSync(TOOLS, "utf8");

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------------------ stubbed AE

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};

/* A property that can carry an expression. `broken` models fact 2: the
 * value keeps reading normally while expressionError is set. */
function Prop(name, canExpr) {
  this.name = name;
  this.canSetExpression = !!canExpr;
  this._expression = "";
  this.numProperties = 0;
  this.value = 100;
  this.expressionError = "";
}
Object.defineProperty(Prop.prototype, "expression", {
  get() { return this._expression; },
  set(v) { this._expression = String(v); }
});

function Group(name, props) {
  this.name = name;
  this._props = props || [];
  this.canSetExpression = false;
}
Object.defineProperty(Group.prototype, "numProperties", {
  get() { return this._props.length; }
});
Group.prototype.property = function (i) { return this._props[i - 1]; };

function Layer(name, comp) {
  this.name = name;
  this.comp = comp;
  this.enabled = true;
  this.source = null;
  this.opacity = new Prop("Opacity", true);
  // A nested group, so the walk has to recurse to find the expression
  // that lives under Effects rather than only the top level.
  this.fxParam = new Prop("Blurriness", true);
  this._groups = [
    new Group("Transform", [this.opacity]),
    new Group("Effects", [new Group("Gaussian Blur", [this.fxParam])])
  ];
}
Object.defineProperty(Layer.prototype, "numProperties", {
  get() { return this._groups.length; }
});
Layer.prototype.property = function (i) { return this._groups[i - 1]; };
Layer.prototype.canSetExpression = false;

let nextId = 1;
function Comp(name) {
  this.name = name;
  this.id = nextId++;
  this.width = 640; this.height = 360;
  this.duration = 10; this.frameRate = 30;
  this.comment = "";
  this._layers = [];
  this.parentFolder = null;
}
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { return this._layers.length; }
});
Comp.prototype.layer = function (i) { return this._layers[i - 1]; };
// FACT 3: direct parents only, deduplicated, disabled layers still count.
Object.defineProperty(Comp.prototype, "usedIn", {
  get() {
    const self = this;
    const out = [];
    for (const it of project._items) {
      if (!(it instanceof CompItem)) continue;
      const uses = it._layers.some(L => L.source === self);
      if (uses && out.indexOf(it) === -1) out.push(it);
    }
    return out;
  }
});
Comp.prototype.addLayer = function (name, source) {
  const L = new Layer(name, this);
  L.source = source || null;
  this._layers.push(L);
  return L;
};

function makeComp(name) {
  const c = new Comp(name);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  return c;
}

const renderQueue = {
  _items: [],
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  items: { add(comp) {
    const it = { comp };            // FACT 5: identity, not name
    renderQueue._items.push(it);
    return it;
  } }
};

const project = {
  _items: [],
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  renderQueue,
  rootFolder: { name: "(root)" },
  items: {
    addComp(name) {
      const c = makeComp(name);
      project._items.push(c);
      return c;
    },
    addFolder(name) {
      const f = { name, remove() {} };
      Object.setPrototypeOf(f, FolderItem.prototype);
      project._items.push(f);
      return f;
    }
  }
};

const app = {
  project,
  version: "26.3x87",
  beginUndoGroup() {}, endUndoGroup() {}, executeCommand() {}
};
const $ = { global: {}, hiresTimer: 0 };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_revPrefix: AELL_revPrefix, " +
  "AELL_expressionNames: AELL_expressionNames, " +
  "AELL_runTool: AELL_runTool })");
const { AELL_TOOLS, AELL_MUTATING, AELL_revPrefix,
        AELL_expressionNames, AELL_runTool } = host;

// Through the real dispatcher, not the tool function: a grounded error
// reaches the model as an error RESULT, and only AELL_runTool turns a
// throw into one.
const call = (t, a) => AELL_runTool(t, a || {});

// ------------------------------------------- 1. the year rules, in a table

const YEARS = [
  // [old name,                    expected prefix or null for "flagged"]
  ["Roof_Shingle_2019_v2",         "REV19_"],
  ["2026_Roof_Intro",              "REV26_"],
  ["Roof_1998_Archive",            "REV98_"],
  ["Intro",                        "REV_NO-YEAR_"],
  ["Roof_v26",                     "REV_NO-YEAR_"],   // version, not a year
  ["Roof_26",                      "REV_NO-YEAR_"],   // bare 26, not a year
  ["Shoot_20190412",               "REV_NO-YEAR_"],   // datestamp, not 2019
  ["Roof_12019",                   "REV_NO-YEAR_"],   // digit before
  ["Take_1899",                    "REV_NO-YEAR_"],   // not 19xx/20xx
  ["Take_2199",                    "REV_NO-YEAR_"],   // not 19xx/20xx
  ["Roof_2019_and_2021",           null],             // two years -> flag
  ["Roof_2019_v2_2019_final",      "REV19_"]          // same year twice
];
for (const [name, want] of YEARS) {
  const v = AELL_revPrefix(name);
  if (want === null) {
    assert(!!v.flag && !v.prefix,
           '"' + name + '" is flagged for a human, not guessed');
  } else {
    assert(v.prefix === want,
           '"' + name + '" -> ' + want + " (got " +
           (v.prefix || v.flag || "already") + ")");
  }
}
assert(AELL_revPrefix("REV19_Roof_2019").already === true,
       "an already-prefixed name is recognised");
assert(AELL_revPrefix("REV_NO-YEAR_Intro").already === true,
       "so is the no-year prefix");

// -------------------------------------- 2. which expressions name a comp

assert(AELL_expressionNames('comp("Main").width', "Main") === "comp()",
       'comp("Main") is the comp() kind');
assert(AELL_expressionNames("comp('Main').width", "Main") === "comp()",
       "single quotes count too");
assert(AELL_expressionNames('var n = "Main"; comp(n)', "Main") === "quoted",
       "a name in some other quoted string is the quoted kind");
assert(AELL_expressionNames("thisComp.layer(1).background", "BG") === null,
       "an unquoted substring does NOT match — 'background' is not comp BG");
assert(AELL_expressionNames('thisComp.layer("BG").opacity', "BG") === "quoted",
       "but a quoted layer name of the same spelling does, conservatively");

// ------------------------------------------------------ 3. the audit facts

const plain = project.items.addComp("Roof_Shingle_2019_v2");
const util = project.items.addComp("Roof_Utility_2019");
const linked = project.items.addComp("Roof_Linked_2020");
const host1 = project.items.addComp("Roof_Master_2021");

host1.addLayer("nested", util);          // util is used, never queued
host1.addLayer("nested twice", util);    // FACT 3: collapses to one entry
const disabled = host1.addLayer("nested but off", util);
disabled.enabled = false;
renderQueue.items.add(host1);
renderQueue.items.add(plain);
// The expression that must protect `linked` — and it lives under a nested
// effect group, so the walk has to recurse to find it.
host1._layers[0].fxParam.expression =
  'comp("Roof_Linked_2020").layer("x").transform.opacity';

const audit = call("audit_comp_usage", {});
assert(audit.ok, "audit_comp_usage runs: " + (audit.error || ""));
const byName = {};
for (const c of audit.data.comps) byName[c.name] = c;

assert(byName["Roof_Utility_2019"].usedIn.join(",") === "Roof_Master_2021",
       "usedIn names the DIRECT parent");
assert(byName["Roof_Utility_2019"].usedInCount === 1,
       "a comp used three times in one parent counts ONCE (got " +
       byName["Roof_Utility_2019"].usedInCount + ")");
assert(byName["Roof_Master_2021"].inRenderQueue === true &&
       byName["Roof_Utility_2019"].inRenderQueue === false,
       "render-queue membership is answered by identity");
assert(byName["Roof_Utility_2019"].looksLikeUtility === true,
       "nested + never queued reads as a utility comp");
assert(byName["Roof_Master_2021"].looksLikeUtility === false,
       "a queued comp does not, even though it is a parent");
assert(byName["Roof_Linked_2020"].expressionRefCount === 1,
       "the expression reference is found (under a NESTED effect group)");
assert(byName["Roof_Linked_2020"].expressionRefs[0].kind === "comp()",
       "and reported as the comp() kind");
assert(byName["Roof_Shingle_2019_v2"].expressionRefCount === 0,
       "an unreferenced comp is reported as such");
assert(audit.data.scanned.expressionsFound === 1,
       "the scan reports what it walked");

const one = call("audit_comp_usage", { comp: "Roof_Linked_2020" });
assert(one.ok && one.data.comps.length === 1,
       "a single comp can be audited on its own");
const bad = call("audit_comp_usage", { comp: "No Such Comp" });
assert(!bad.ok && /Comp not found/.test(bad.error) &&
       /Roof_Shingle_2019_v2/.test(bad.error),
       "a bad name gets the grounded comp list: " +
       String(bad.error).slice(0, 60));

// --------------------------------------------- 4. preview before execute

const dry = call("rename_comps", {});
assert(dry.ok, "rename_comps runs: " + (dry.error || ""));
assert(dry.data.dryRun === true,
       "dryRun DEFAULTS to true — a preview, not a rename");
const planBy = {};
for (const r of dry.data.plan) planBy[r.comp] = r;

assert(planBy["Roof_Shingle_2019_v2"].action === "rename" &&
       planBy["Roof_Shingle_2019_v2"].newName ===
         "REV19_Roof_Shingle_2019_v2",
       "the plain comp gets REV19_ prepended, old name kept verbatim");
assert(planBy["Roof_Linked_2020"].action === "skip",
       "the expression-referenced comp is skipped");
assert(/does NOT rewrite/.test(planBy["Roof_Linked_2020"].reason),
       "with the reason a human can act on: " +
       planBy["Roof_Linked_2020"].reason.slice(0, 60));
assert(planBy["Roof_Utility_2019"].action === "skip" &&
       /utility/.test(planBy["Roof_Utility_2019"].reason),
       "the utility comp is skipped BY DEFAULT and marked as such");
assert(/includeUtility/.test(planBy["Roof_Utility_2019"].reason),
       "and the preview says how to override it");
assert(/PREVIEW ONLY/.test(dry.data.note), "the note says nothing happened");

const namesNow = project._items.map(i => i.name).join(",");
assert(namesNow.indexOf("REV19_") === -1,
       "and NOTHING was actually renamed by the preview");

// ------------------------------------------------------- 5. the execute

const run = call("rename_comps", { dryRun: false });
assert(run.ok && run.data.dryRun === false, "dryRun:false executes");
assert(plain.name === "REV19_Roof_Shingle_2019_v2",
       "the plain comp really was renamed (now " + plain.name + ")");
assert(linked.name === "Roof_Linked_2020",
       "the expression-referenced comp was NOT touched");
assert(util.name === "Roof_Utility_2019",
       "nor the utility comp");
assert(host1.name === "REV21_Roof_Master_2021",
       "a queued parent comp IS renamed — it is not a utility (" +
       host1.name + ")");
assert(run.data.renamedCount === 2,
       "two comps renamed (got " + run.data.renamedCount + ")");

// ---------------------------------------------------- 6. idempotency

const again = call("rename_comps", { dryRun: false });
assert(again.data.renamedCount === 0,
       "running it twice renames NOTHING (got " + again.data.renamedCount +
       ")");
assert(plain.name === "REV19_Roof_Shingle_2019_v2",
       "and leaves the already-prefixed name alone");
const againRow = again.data.plan.filter(r => r.comp === plain.name)[0];
assert(/Already carries the prefix/.test(againRow.reason),
       "saying why: " + againRow.reason);

// ------------------------------------- 7. overrides, collisions, subsets

const utilRun = call("rename_comps", { dryRun: false, includeUtility: true });
assert(util.name === "REV19_Roof_Utility_2019",
       "includeUtility:true renames the utility comp (" + util.name + ")");
assert(linked.name === "Roof_Linked_2020",
       "but NEVER the expression-referenced one — that skip is hard");

const clash = project.items.addComp("Clash_2019");
project.items.addComp("REV19_Clash_2019");        // the name it would want
const clashRun = call("rename_comps", { dryRun: true, comps: ["Clash_2019"] });
assert(clashRun.data.plan.length === 1,
       "'comps' narrows the job to the named subset");
assert(clashRun.data.plan[0].action === "skip" &&
       /already called/.test(clashRun.data.plan[0].reason),
       "a name collision is refused, not overwritten: " +
       clashRun.data.plan[0].reason);

const mapped = call("rename_comps",
  { rule: "map", renames: { "Clash_2019": "Hand_Picked_Name" },
    dryRun: false });
assert(clash.name === "Hand_Picked_Name",
       "rule:'map' takes the caller's own names (" + clash.name + ")");
const mapNoNames = call("rename_comps", { rule: "map", dryRun: true });
assert(!mapNoNames.ok && /renames/.test(mapNoNames.error),
       "rule 'map' without a map is refused: " + mapNoNames.error);
const badRule = call("rename_comps", { rule: "vibes" });
assert(!badRule.ok && /rev-prefix/.test(badRule.error),
       "an unknown rule is refused and names the real ones");

// -------------------------------------------------- 8. wiring, not drift

assert(AELL_MUTATING.rename_comps === true,
       "rename_comps is registered as mutating (undo label + dry-run rule)");
assert(!AELL_MUTATING.audit_comp_usage,
       "audit_comp_usage is read-only and opens no undo group");
assert(toolsSrc.includes('name: "rename_comps"') &&
       toolsSrc.includes('name: "audit_comp_usage"'),
       "both tools are documented to the model in tools.js");
assert(/dryRun is TRUE by default/.test(toolsSrc),
       "and the doc leads with the preview-first contract");

console.log("\n" + checks + " checks");
