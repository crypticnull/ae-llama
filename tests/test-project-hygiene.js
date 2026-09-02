// Regression test: clean_project against a stubbed AE project model.
//
// The stub models what AE 2026 was MEASURED to do (probes 2-4 of the
// 5.6 pass, see WORKPLAN-LOG 2026-08-28), not what the docs say:
//
//  - removeUnusedFootage() also deletes empty folders, recursively, and
//    counts them in its return value;
//  - it keeps footage used only by a comp that is itself unused;
//  - consolidateFootage() merges footage sharing a file and repoints the
//    layers that used the copies;
//  - reduceProject() deletes comps referenced only by an expression and
//    leaves expressionError EMPTY, and silently drops the render-queue
//    items of the comps it removes;
//  - reduceProject() ACCEPTS a footage item in the keep array and then
//    deletes every comp in the project;
//  - reduceProject([]) throws "Array is empty".
//
// Several checks drive the RAW stub API first, so a stub that quietly
// stopped modelling a hazard cannot let the tool pass on a technicality.
"use strict";
const fs = require("fs");
const path = require("path");

let NEXT_ID = 1;
let ALL_ITEMS = [];

function Item(name) {
  this.name = name;
  this.id = NEXT_ID++;
  this._parent = null;
  ALL_ITEMS.push(this);
}
Object.defineProperty(Item.prototype, "parentFolder", {
  get() { return this._parent; },
  set(f) {
    if (this._parent) {
      const i = this._parent.children.indexOf(this);
      if (i >= 0) this._parent.children.splice(i, 1);
    }
    this._parent = f;
    if (f) f.children.push(this);
  }
});
Item.prototype.remove = function () {
  const i = ALL_ITEMS.indexOf(this);
  if (i >= 0) ALL_ITEMS.splice(i, 1);
  if (this._parent) {
    const j = this._parent.children.indexOf(this);
    if (j >= 0) this._parent.children.splice(j, 1);
  }
};

function FolderItem(name) { Item.call(this, name); this.children = []; }
FolderItem.prototype = Object.create(Item.prototype);
Object.defineProperty(FolderItem.prototype, "numItems", {
  get() { return this.children.length; }
});
FolderItem.prototype.item = function (i) { return this.children[i - 1]; };

function Property(name, expression) {
  this.name = name;
  this.canSetExpression = true;
  this.expression = expression || "";
  this.expressionError = "";
  this.numProperties = 0;
}
Property.prototype.property = function () { return null; };

function Layer(name, source, expr) {
  this.name = name;
  this.source = source || null;
  this._props = expr ? [new Property("Position", expr)] : [];
  this.numProperties = this._props.length;
}
Layer.prototype.property = function (i) {
  if (typeof i === "number") return this._props[i - 1];
  for (const p of this._props) if (p.name === i) return p;
  return null;
};

function CompItem(name) {
  Item.call(this, name);
  this.layers = [];
}
CompItem.prototype = Object.create(Item.prototype);
Object.defineProperty(CompItem.prototype, "numLayers", {
  get() { return this.layers.length; }
});
CompItem.prototype.layer = function (i) { return this.layers[i - 1]; };
CompItem.prototype.addLayer = function (name, source, expr) {
  const L = new Layer(name, source, expr);
  this.layers.push(L);
  return L;
};

function SolidSource() {}
function FileSource(file) { this.file = { fsName: file }; }
function FootageItem(name, file) {
  Item.call(this, name);
  this.mainSource = file ? new FileSource(file) : new SolidSource();
}
FootageItem.prototype = Object.create(Item.prototype);
Object.defineProperty(FootageItem.prototype, "usedIn", {
  get() {
    const out = [];
    for (const it of ALL_ITEMS) {
      if (!(it instanceof CompItem)) continue;
      if (it.layers.some(L => L.source === this)) out.push(it);
    }
    return out;
  }
});
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {}
const ParagraphJustification = {};

let root = new FolderItem("(root)");
ALL_ITEMS.length = 0;

const renderQueue = {
  queued: [],
  get numItems() { return this.queued.length; },
  item(i) { return this.queued[i - 1]; },
  items: { add(comp) { const it = { comp }; renderQueue.queued.push(it); return it; } }
};

// --- the three AE calls, modelled from the field measurements ---------
function sweepEmptyFolders() {
  let removed = 0, changed = true;
  while (changed) {
    changed = false;
    for (const it of ALL_ITEMS.slice()) {
      if (it instanceof FolderItem && it.children.length === 0) {
        it.remove(); removed++; changed = true;
      }
    }
  }
  return removed;
}

const project = {
  rootFolder: root,
  get numItems() { return ALL_ITEMS.length; },
  item(i) { return ALL_ITEMS[i - 1]; },
  renderQueue,
  items: {
    addFolder(name) { const f = new FolderItem(name); f.parentFolder = root; return f; },
    addComp(name) { const c = new CompItem(name); c.parentFolder = root; return c; }
  },
  activeItem: null,
  file: null,

  removeUnusedFootage() {
    let n = 0;
    for (const it of ALL_ITEMS.slice()) {
      if (it instanceof FootageItem && it.usedIn.length === 0) { it.remove(); n++; }
    }
    return n + sweepEmptyFolders();          // folders count too (measured)
  },

  consolidateFootage() {
    const byFile = new Map();
    for (const it of ALL_ITEMS) {
      if (!(it instanceof FootageItem)) continue;
      const f = it.mainSource && it.mainSource.file;
      if (!f) continue;
      if (!byFile.has(f.fsName)) byFile.set(f.fsName, []);
      byFile.get(f.fsName).push(it);
    }
    let n = 0;
    for (const group of byFile.values()) {
      if (group.length < 2) continue;
      const keeper = group[0];
      for (const dup of group.slice(1)) {
        for (const it of ALL_ITEMS) {
          if (!(it instanceof CompItem)) continue;
          for (const L of it.layers) if (L.source === dup) L.source = keeper;
        }
        dup.remove(); n++;
      }
    }
    return n;
  },

  reduceProject(keep) {
    if (arguments.length === 0) {
      throw new Error("After Effects error: Unable to call \u201creduceProject\u201d " +
                      "because the call requires 1 parameter.");
    }
    if (!keep || !keep.length) throw new Error("After Effects error: Array is empty.");
    const kept = new Set(), stack = keep.slice();
    while (stack.length) {
      const it = stack.pop();
      if (!it || kept.has(it)) continue;
      kept.add(it);
      if (it instanceof CompItem) {
        for (const L of it.layers) if (L.source) stack.push(L.source);
      }
    }
    for (const it of Array.from(kept)) {
      let f = it.parentFolder;
      while (f && f !== root) { kept.add(f); f = f.parentFolder; }
    }
    let n = 0;
    for (const it of ALL_ITEMS.slice()) {
      if (kept.has(it)) continue;
      if (it instanceof CompItem) {
        // AE drops the comp's render-queue items with no dialog at all.
        renderQueue.queued = renderQueue.queued.filter(q => q.comp !== it);
      }
      it.remove(); n++;
    }
    return n;
  }
};

const app = {
  project,
  beginUndoGroup() {}, endUndoGroup() {},
  beginSuppressDialogs() {}, endSuppressDialogs() {}
};
const $ = { global: {} };

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "jsx",
                               "hostscript.jsx"), "utf8"));

function call(tool, args) {
  return JSON.parse($.global.AELL_call(tool, JSON.stringify(args)));
}
let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}
function reset() {
  ALL_ITEMS = [];
  root = new FolderItem("(root)");
  ALL_ITEMS.length = 0;
  project.rootFolder = root;
  renderQueue.queued = [];
}
function names(list) { return (list || []).slice().sort().join(","); }

// ---------------------------------------------------------------- rig A
// KEEP uses a solid, a PNG and a nested comp. Unused: a duplicate PNG, a
// placeholder-ish solid nobody uses, and two nested EMPTY folders.
function rigA() {
  reset();
  const keep = project.items.addComp("KEEP");
  const nested = project.items.addComp("NESTED");
  const solids = project.items.addFolder("Solids");
  const keepSolid = new FootageItem("keepSolid"); keepSolid.parentFolder = solids;
  const orphan = new FootageItem("orphanSolid"); orphan.parentFolder = solids;
  const png = new FootageItem("hygA.png", "C:/tmp/hygA.png");
  const dup = new FootageItem("hygA.png", "C:/tmp/hygA.png");
  const box = project.items.addFolder("EmptyBox");
  const inner = project.items.addFolder("InnerBox"); inner.parentFolder = box;
  keep.addLayer("keepSolid", keepSolid);
  keep.addLayer("hygA.png", png);
  keep.addLayer("NESTED", nested);
  return { keep, nested, png, dup, orphan, box, inner, solids };
}

// 1. Preview does not touch anything, and names what would go.
let r = rigA();
const before = project.numItems;
let res = call("clean_project", { action: "remove_unused_footage" });
assert(res.ok, "preview succeeds");
assert(res.data.dryRun === true, "dryRun defaults to TRUE");
assert(project.numItems === before, "preview deleted nothing (" +
       project.numItems + " items still there)");
assert(names(res.data.items) === "EmptyBox,EmptyBox/InnerBox," +
       "Solids/orphanSolid,hygA.png",
       "preview names the unused footage AND both empty folders: " +
       names(res.data.items));
assert(res.data.foldersIncluded === 2,
       "preview counts the folders AE throws in unasked");
assert(/Folders left empty/.test(res.data.foldersNote || ""),
       "preview says WHY folders are in the list");

// 2. Execute matches the preview exactly.
res = call("clean_project", { action: "remove_unused_footage", dryRun: false });
assert(res.ok, "execute succeeds");
assert(res.data.removedCount === 4, "AE's own count includes the folders: " +
       res.data.removedCount);
assert(names(res.data.removed) === names(res.data.items),
       "what was removed == what the preview promised");
assert(!res.data.removedUnexpectedly, "nothing removed that was not predicted");
assert(!res.data.predictedButKept, "nothing predicted that survived");
assert(project.numItems === 5, "five items left: " + project.numItems);

// 3. Footage used ONLY by an unused comp is NOT unused (measured).
reset();
const lonely = project.items.addComp("LONELY");
const inUnused = new FootageItem("insideUnused");
lonely.addLayer("insideUnused", inUnused);
assert(project.removeUnusedFootage() === 0,
       "raw API: footage inside an unused comp survives (stub is faithful)");
rigA();
res = call("clean_project", { action: "remove_unused_footage" });
assert(res.data.items.indexOf("Solids/keepSolid") === -1,
       "preview never lists footage a comp uses");

// 4. Recursive empty-folder sweep: emptying a child empties its parent.
reset();
const outer = project.items.addFolder("Outer");
const mid = project.items.addFolder("Mid"); mid.parentFolder = outer;
const ph = new FootageItem("phA"); ph.parentFolder = mid;
project.items.addComp("HOLDER");
res = call("clean_project", { action: "remove_unused_footage" });
assert(names(res.data.items) === "Outer,Outer/Mid,Outer/Mid/phA",
       "one unused item takes both folders above it: " + names(res.data.items));
res = call("clean_project", { action: "remove_unused_footage", dryRun: false });
assert(res.data.removedCount === 3 && !res.data.removedUnexpectedly,
       "and AE agrees with the preview");

// 5. consolidate_footage: preview groups by file, execute repoints layers.
reset();
const c1 = project.items.addComp("C1");
const c2 = project.items.addComp("C2");
const a1 = new FootageItem("hygA.png", "C:/tmp/hygA.png");
const a2 = new FootageItem("hygA.png", "C:/tmp/hygA.png");
const a3 = new FootageItem("hygA.png", "C:/tmp/hygA.png");
const solo = new FootageItem("other.png", "C:/tmp/other.png");
c1.addLayer("copy1", a1);
c2.addLayer("copy2", a2);
c2.addLayer("solo", solo);
res = call("clean_project", { action: "consolidate" });
assert(res.ok && res.data.action === "consolidate_footage",
       "'consolidate' is accepted as the action name");
assert(res.data.duplicateGroups && res.data.duplicateGroups.length === 1 &&
       res.data.duplicateGroups[0].copies === 3,
       "the three copies are reported as ONE group");
assert(res.data.willRemove === 2, "two of the three would go");
res = call("clean_project", { action: "consolidate_footage", dryRun: false });
assert(res.data.removedCount === 2 && !res.data.removedUnexpectedly,
       "execute removes exactly two");
assert(c1.layer(1).source === c2.layer(1).source,
       "both comps now point at the same surviving footage item");
assert(ALL_ITEMS.indexOf(solo) !== -1, "the un-duplicated file is untouched");

// ---------------------------------------------------------------- rig B
// MAIN keeps a solid; OTHER is reached only by an expression; DEAD is in
// the render queue and reached by nothing.
function rigB() {
  reset();
  const main = project.items.addComp("MAIN");
  const other = project.items.addComp("OTHER");
  const dead = project.items.addComp("DEAD");
  const solids = project.items.addFolder("Solids");
  const junk = project.items.addFolder("_JUNK");
  dead.parentFolder = junk;
  const mainSolid = new FootageItem("mainSolid"); mainSolid.parentFolder = solids;
  const otherSolid = new FootageItem("otherSolid"); otherSolid.parentFolder = solids;
  other.addLayer("otherSolid", otherSolid);
  main.addLayer("mainSolid", mainSolid,
                'comp("OTHER").layer("otherSolid").transform.position');
  renderQueue.items.add(dead);
  return { main, other, dead, junk, solids };
}

// 6. reduce_project will not guess, and says what it could keep.
rigB();
res = call("clean_project", { action: "reduce_project" });
assert(!res.ok, "reduce_project without keepComps is refused");
assert(/DEAD.*MAIN.*OTHER|MAIN/.test(res.error) && /keepComps/.test(res.error),
       "the refusal lists the comps that exist: " + res.error);
assert(project.numItems > 0, "and nothing was deleted");

// 7. The hazard: AE accepts a non-comp and then deletes every comp.
const rawCount = (() => {
  rigB();
  const footage = ALL_ITEMS.find(x => x.name === "otherSolid");
  project.reduceProject([footage]);
  return ALL_ITEMS.filter(x => x instanceof CompItem).length;
})();
assert(rawCount === 0,
       "raw API: a footage item in the keep array wipes every comp (hazard is real)");
rigB();
res = call("clean_project",
           { action: "reduce_project", keepComps: ["otherSolid"], dryRun: false });
assert(!res.ok && /not a comp/.test(res.error),
       "the tool refuses a non-comp keepComps entry: " + res.error);
assert(ALL_ITEMS.filter(x => x instanceof CompItem).length === 3,
       "all three comps survive the refusal");

// 8. Unknown / missing action is refused with the real menu.
res = call("clean_project", {});
assert(!res.ok && /remove_unused_footage/.test(res.error) &&
       /consolidate_footage/.test(res.error) && /reduce_project/.test(res.error),
       "a missing action lists all three actions");
res = call("clean_project", { action: "vacuum" });
assert(!res.ok && /Unknown action 'vacuum'/.test(res.error),
       "an invented action is named back and refused");

// 9. reduce_project preview: the two silent losses are stated up front.
rigB();
res = call("clean_project", { action: "reduce_project", keepComps: ["MAIN"] });
assert(res.ok && res.data.dryRun === true, "reduce_project previews by default");
assert(names(res.data.items) === "OTHER,Solids/otherSolid,_JUNK,_JUNK/DEAD",
       "preview names the comps by their folder path, the solid and the " +
       "emptied folder: " + names(res.data.items));
assert(names(res.data.renderQueueLost) === "DEAD",
       "the render-queue item that would vanish is named");
assert(res.data.expressionBreaks && res.data.expressionBreaks.length === 1 &&
       /OTHER is named/.test(res.data.expressionBreaks[0]),
       "the expression that would break silently is named");
assert(/expressionError reads empty/.test(res.data.expressionNote || ""),
       "and the preview says AE will not report it");
assert(project.numItems === 7 && renderQueue.numItems === 1,
       "preview changed nothing at all");

// 10. Execute: AE's result is diffed against the promise.
res = call("clean_project",
           { action: "reduce_project", keepComps: ["MAIN"], dryRun: false });
assert(res.ok && res.data.removedCount === 4, "four items removed");
assert(names(res.data.removed) === "OTHER,Solids/otherSolid,_JUNK,_JUNK/DEAD",
       "and they are the four the preview named");
assert(!res.data.removedUnexpectedly && !res.data.predictedButKept,
       "preview and reality agree exactly");
assert(renderQueue.numItems === 0, "the render-queue item went with DEAD");
assert(/Ctrl\+Z/.test(res.data.note), "the result says one Ctrl+Z undoes it");

// 11. keepComps naming a comp that does not exist is grounded.
rigB();
res = call("clean_project", { action: "reduce_project", keepComps: ["Nope"] });
assert(!res.ok && /Comp not found: Nope/.test(res.error) &&
       /MAIN/.test(res.error), "a bad comp name lists the real ones");

// 11b. The grounded list is RANKED and the cap ANNOUNCES itself.
//      Measured in real AE 2026 (self-test 588/589, 2026-09-02): the
//      roster was flat project order capped at 15 with nothing saying so,
//      so a project that had grown past fifteen comps truncated exactly
//      the near-miss the caller needed -- a complete-looking roster that
//      does not contain the answer, which reads as "it does not exist".
reset();
for (let i = 1; i <= 18; i++) project.items.addComp("Filler " + i);
project.items.addComp("ST HYG Keep");          // 19th: past every cap
project.items.addComp("ST HYG Drop");
res = call("clean_project", { action: "reduce_project",
                              keepComps: ["ST HYG Nope"] });
assert(!res.ok && /Comp not found: ST HYG Nope/.test(res.error),
       "a 20-comp project still refuses the unknown name");
assert(/ST HYG Keep/.test(res.error) && /ST HYG Drop/.test(res.error),
       "the two near-miss comps survive the cap despite being LAST in " +
       "project order: " + res.error);
assert(res.error.indexOf("ST HYG Keep") < res.error.indexOf("Filler"),
       "and they are listed BEFORE the unrelated comps");
assert(/and 5 more/.test(res.error),
       "the cap says how many it did not show: " + res.error);
assert(/get_project_info \{limit: "all"\}/.test(res.error),
       "and names the tool that shows the rest");
// Nothing is dropped when the roster fits, and no cap noise is added.
reset();
project.items.addComp("MAIN");
project.items.addComp("OTHER");
res = call("clean_project", { action: "reduce_project", keepComps: ["Nope"] });
assert(/MAIN/.test(res.error) && /OTHER/.test(res.error) &&
       !/more\)?$/.test(res.error) && !/get_project_info/.test(res.error),
       "a short roster is listed whole, with no cap wording: " + res.error);
// The "which comps matter" refusal shares the helper, so its 20-cap
// discloses itself too.
reset();
for (let i = 1; i <= 26; i++) project.items.addComp("Filler " + i);
res = call("clean_project", { action: "reduce_project" });
assert(!res.ok && /keepComps/.test(res.error) && /and 6 more/.test(res.error),
       "the no-keepComps refusal caps at 20 and says so: " + res.error);

// 12. A keepComps string (not an array) is accepted rather than refused.
rigB();
res = call("clean_project", { action: "reduce_project", keepComps: "MAIN" });
assert(res.ok && res.data.keepComps.length === 1,
       "a single comp name as a plain string works");

// 13. Nothing to do says so, and never claims work it did not do.
reset();
project.items.addComp("ONLY");
res = call("clean_project", { action: "remove_unused_footage" });
assert(res.ok && res.data.willRemove === 0 &&
       /nothing to do/i.test(res.data.note), "an already-clean project: " +
       res.data.note);
// The preview above was of a DIFFERENT action, and the gate says so —
// each action is previewed on its own or it does not run.
res = call("clean_project", { action: "consolidate_footage", dryRun: false });
assert(!res.ok && /no preview of consolidate_footage/.test(res.error),
       "a preview of another action does not authorise this one: " +
       (res.error || JSON.stringify(res.data)));
call("clean_project", { action: "consolidate_footage" });
res = call("clean_project", { action: "consolidate_footage", dryRun: false });
assert(res.ok && res.data.removedCount === 0 && res.data.itemsRemoved === 0,
       "executing on a clean project removes nothing");

// 15. THE PREVIEW GATE. Four field runs of the chat probe (2026-09-02)
//     measured what "dryRun defaults to true" buys when it is only
//     advice: twice out of four the model went straight to dryRun:false
//     and deleted real project items with no list ever shown. A delete
//     must now cite a preview of the SAME plan, taken in an EARLIER user
//     request -- the only boundary at which the user could have seen it.
function rigGate() {
  reset();
  const keep = project.items.addComp("KEEP");
  const used = new FootageItem("usedPNG");
  keep.addLayer("usedPNG", used);
  new FootageItem("orphanA");
  new FootageItem("orphanB");
  return keep;
}

// (a) No preview at all: refused, and the refusal IS the preview.
rigGate();
delete $.global.AELL_hygShown;
$.global.AELL_requestSeq = 0;
$.global.AELL_newRequest();
res = call("clean_project", { action: "remove_unused_footage", dryRun: false });
assert(!res.ok && /nothing has been previewed yet/.test(res.error),
       "a first-call delete is refused: " + (res.error || "").slice(0, 60));
assert(/orphanA/.test(res.error) && /orphanB/.test(res.error),
       "and the refusal names what would have gone: " + res.error);
assert(ALL_ITEMS.some(it => it.name === "orphanA") &&
       ALL_ITEMS.some(it => it.name === "orphanB"),
       "nothing was deleted by the refused call");

// (b) That refusal recorded the plan, but in THIS request — an immediate
//     retry is still refused, because nobody has seen the list yet.
res = call("clean_project", { action: "remove_unused_footage", dryRun: false });
assert(!res.ok && /THIS same reply/.test(res.error),
       "retrying inside the same request is refused: " +
       (res.error || "").slice(0, 80));
assert(ALL_ITEMS.some(it => it.name === "orphanA"),
       "and still nothing was deleted");

// (c) The next request goes through — that is the user saying go.
$.global.AELL_newRequest();
res = call("clean_project", { action: "remove_unused_footage", dryRun: false });
assert(res.ok && res.data.itemsRemoved === 2,
       "the request after the preview deletes: " +
       JSON.stringify(res.error || res.data.removed));

// (d) An explicit preview in one request, delete in the next.
rigGate();
$.global.AELL_newRequest();
res = call("clean_project", { action: "remove_unused_footage" });
assert(res.ok && res.data.willRemove === 2, "preview still previews");
assert(ALL_ITEMS.some(it => it.name === "orphanA"),
       "the preview deleted nothing");
res = call("clean_project", { action: "remove_unused_footage", dryRun: false });
assert(!res.ok && /THIS same reply/.test(res.error),
       "preview and delete in ONE reply never shows the user anything");
$.global.AELL_newRequest();
res = call("clean_project", { action: "remove_unused_footage", dryRun: false });
assert(res.ok && res.data.itemsRemoved === 2,
       "and the next request deletes the previewed list");

// (e) Plan drift between the preview and the go: the user agreed to a
//     different list, so it is refused and re-previewed.
rigGate();
$.global.AELL_newRequest();
call("clean_project", { action: "remove_unused_footage" });
new FootageItem("orphanC");
$.global.AELL_newRequest();
res = call("clean_project", { action: "remove_unused_footage", dryRun: false });
assert(!res.ok && /project has changed since the last preview/.test(res.error),
       "a drifted plan is not the list they agreed to: " +
       (res.error || "").slice(0, 80));
assert(/orphanC/.test(res.error),
       "and the new list names the item that appeared: " + res.error);
$.global.AELL_newRequest();
res = call("clean_project", { action: "remove_unused_footage", dryRun: false });
assert(res.ok && res.data.itemsRemoved === 3,
       "after that re-preview it goes, all three: " +
       JSON.stringify(res.error || res.data.removed));

// 16. NO COMP SCOPE. The field call was
//     {action:"remove_unused_footage", keepComps:["Probe Room"],
//      dryRun:false} -- the tool ignored keepComps and deleted
//     project-wide. A protective argument is never dropped in silence.
rigGate();
$.global.AELL_newRequest();
res = call("clean_project", { action: "remove_unused_footage",
                              keepComps: ["KEEP"], dryRun: false });
assert(!res.ok && /no comp or layer scope/.test(res.error),
       "keepComps on remove_unused_footage is refused, not ignored: " +
       (res.error || "").slice(0, 80));
assert(/'KEEP' is a comp in this project/.test(res.error),
       "and the refusal names the comp the user meant: " + res.error);
assert(/delete_layer/.test(res.error) && /precompose/.test(res.error),
       "and points at the tools that tidy a COMP: " + res.error);
assert(ALL_ITEMS.some(it => it.name === "orphanA"),
       "the scoped call deleted nothing");
res = call("clean_project", { action: "consolidate_footage", comp: "KEEP" });
assert(!res.ok && /no comp or layer scope/.test(res.error),
       "a comp scope is refused on the PREVIEW too");
res = call("clean_project", { action: "remove_unused_footage",
                              keepComps: [] });
assert(res.ok, "an EMPTY keepComps is not a scope and does not refuse");
// reduce_project keeps its aliases; no action has ever had a layer scope.
res = call("clean_project", { action: "reduce_project", comps: ["KEEP"] });
assert(res.ok && res.data.keepComps.join() === "KEEP",
       "reduce_project still reads comps as keepComps: " +
       (res.error || ""));
res = call("clean_project", { action: "reduce_project", keepComps: ["KEEP"],
                              layers: ["usedPNG"] });
assert(!res.ok && /no comp or layer scope/.test(res.error) &&
       /plus keepComps/.test(res.error),
       "a LAYER scope is refused even on reduce_project: " +
       (res.error || "").slice(0, 90));

// 14. The tool is registered as mutating, so it gets an undo group.
//     (reduceProject inside one was measured to close cleanly and to be
//     undone whole by a single Ctrl+Z -- unlike render_comp.)
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "jsx",
                                      "hostscript.jsx"), "utf8");
assert(/clean_project:\s*true/.test(src.split("AELL_MUTATING")[1] || ""),
       "clean_project is in AELL_MUTATING");
const defs = fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                       "tools.js"), "utf8");
assert(/name:\s*"clean_project",\s*mutating:\s*true/.test(defs),
       "clean_project is documented to the model as mutating");
assert(/dryRun is TRUE by default/.test(
         defs.split('name: "clean_project"')[1].slice(0, 1500)),
       "the tool doc tells the model the preview comes first");

console.log(failures ? "\nFAILURES: " + failures : "\nAll project-hygiene checks passed");
