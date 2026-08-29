// Regression test: duplicate_comp, and the four things AE does silently
// when a comp is copied.
//
// Every rule the stub below enforces was measured against real AE 2026
// (logs/probe-dup.txt, probe-dup2.txt, WORKPLAN-LOG 2026-08-29):
//
//  1. comp.duplicate() names the copy ITSELF: "Src" -> "Src 2", and the
//     next one "Src 3". The tool never has to invent a name.
//  2. The copy lands in the SOURCE'S OWN FOLDER, at the project index
//     directly after the source, and every comp setting comes with it
//     (bgColor, resolutionFactor, work area, motionBlur, comment,
//     markers).
//  3. It does NOT touch the project-panel selection: the source stays
//     selected and the copy is not (so there is nothing to restore).
//  4. Assigning a name another project item already holds is ACCEPTED.
//     A by-name walk then finds the OLDER item, so the copy is
//     unreachable by the name that was just asked for. THIS is the bug
//     the tool used to ship: `dup.name = String(args.name)`.
//  5. A BLANK name is accepted too, leaving a comp with no name at all.
//  6. Layer SOURCES are shared, not copied: the nested precomp, the
//     solid and the footage are the SAME project items in both comps
//     (measured: dup.layer(n).source === src.layer(n).source).
//  7. Expressions are copied verbatim and NOTHING is rewritten. A
//     relative one (thisComp.layer("A")) correctly follows the copy; an
//     absolute comp("Src") one still drives off the ORIGINAL, and
//     expressionError stays EMPTY, so nothing else ever mentions it.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const hostSrc = fs.readFileSync(
  path.join(ROOT, "extension", "jsx", "hostscript.jsx"), "utf8");
const toolsSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "tools.js"), "utf8");

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

let nextId = 1000;

function Prop(name, expr) {
  this.name = name;
  this.canSetExpression = true;
  this.expression = expr || "";
  this.expressionError = "";        // FACT 7: empty even when it dangles
  this.numProperties = 0;
}
Prop.prototype.property = function () { return null; };

function Layer(comp, name, source) {
  this.name = name;
  this.comp = comp;
  this.source = source || null;
  this.parent = null;
  this.selected = false;
  this._props = [new Prop("Opacity"), new Prop("Rotation")];
  this.numProperties = this._props.length;
}
Object.setPrototypeOf(Layer.prototype, AVLayer.prototype);
Layer.prototype.property = function (ref) {
  if (typeof ref === "number") return this._props[ref - 1] || null;
  for (const p of this._props) if (p.name === ref) return p;
  return null;
};
Layer.prototype.expr = function (propName, e) {
  this.property(propName).expression = e;
  return this;
};

function Folder(name) {
  this.name = name;
  this.id = ++nextId;
  this.numItems = 0;
  this.selected = false;
}
Object.setPrototypeOf(Folder.prototype, FolderItem.prototype);

function Footage(name, kind) {
  this.name = name;
  this.id = ++nextId;
  this.selected = false;
  this.parentFolder = null;
  this.mainSource = kind === "solid" ? new SolidSource() : {};
}
Object.setPrototypeOf(Footage.prototype, FootageItem.prototype);

function Comp(name, w, h, dur, fps) {
  this.name = name;
  this.id = ++nextId;
  this.width = w || 320;
  this.height = h || 240;
  this.duration = dur || 4;
  this.frameRate = fps || 24;
  this.bgColor = [0, 0, 0];
  this.resolutionFactor = [1, 1];
  this.workAreaStart = 0;
  this.workAreaDuration = this.duration;
  this.motionBlur = false;
  this.comment = "";
  this.selected = false;
  this.parentFolder = null;
  this._layers = [];
  const self = this;
  this.layers = {
    add(src) { const l = new Layer(self, src.name, src); self._layers.push(l);
               return l; },
    addSolid(color, nm, w2, h2) {
      const src = new Footage(nm, "solid");
      project._push(src, null);
      const l = new Layer(self, nm, src);
      self._layers.push(l);
      return l;
    }
  };
}
Object.setPrototypeOf(Comp.prototype, CompItem.prototype);
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { return this._layers.length; }
});
Comp.prototype.layer = function (ref) {
  if (typeof ref === "number") return this._layers[ref - 1];
  const l = this._layers.find(x => x.name === ref);
  if (!l) throw new Error("no layer " + ref);
  return l;
};
Object.defineProperty(Comp.prototype, "selectedLayers", {
  get() { return this._layers.filter(l => l.selected); }
});
// FACTS 1, 2, 3, 6, 7 in one method.
Comp.prototype.duplicate = function () {
  let n = 2;
  while (project._items.some(i => i.name === this.name + " " + n)) n++;
  const c = new Comp(this.name + " " + n, this.width, this.height,
                     this.duration, this.frameRate);
  c.bgColor = this.bgColor.slice();
  c.resolutionFactor = this.resolutionFactor.slice();
  c.workAreaStart = this.workAreaStart;
  c.workAreaDuration = this.workAreaDuration;
  c.motionBlur = this.motionBlur;
  c.comment = this.comment;
  for (const l of this._layers) {
    const copy = new Layer(c, l.name, l.source);   // FACT 6: SAME source
    for (let i = 0; i < l._props.length; i++) {
      copy._props[i].expression = l._props[i].expression;   // FACT 7
    }
    c._layers.push(copy);
  }
  // FACT 7: parenting is remapped INSIDE the copy.
  for (let i = 0; i < this._layers.length; i++) {
    const p = this._layers[i].parent;
    if (p) c._layers[i].parent = c._layers[this._layers.indexOf(p)];
  }
  project._push(c, this.parentFolder, this);       // FACT 2
  // FACT 3: the selection is left exactly as it was.
  return c;
};

const project = {
  _items: [],
  rootFolder: new Folder("Root"),
  activeItem: null,
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  get selection() { return this._items.filter(i => i.selected); },
  _push(it, folder, after) {
    it.parentFolder = folder || this.rootFolder;
    const at = after ? this._items.indexOf(after) + 1 : this._items.length;
    this._items.splice(at, 0, it);
    return it;
  },
  items: {
    addComp(name, w, h, par, dur, fps) {
      return project._push(new Comp(name, w, h, dur, fps), null);
    },
    addFolder(name) { return project._push(new Folder(name), null); }
  }
};
const app = {
  project: project, version: "26.3x87",
  beginUndoGroup() {}, endUndoGroup() {}, executeCommand() {},
  findMenuCommandId() { return 0; }
};
const $ = { global: {}, hiresTimer: 0, sleep() {} };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool, " +
  "AELL_uniqueItemName: AELL_uniqueItemName })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool, AELL_uniqueItemName } = host;
const call = (t, a) => AELL_runTool(t, a || {});

// ------------------------------------------------------------- the rig
const bin = project.items.addFolder("Sequences");
const nested = project.items.addComp("Nested", 160, 120, 1, 2, 24);
const src = project.items.addComp("Src", 320, 240, 1, 4, 24);
src.parentFolder = bin;
src.bgColor = [0.1, 0.2, 0.3];
src.resolutionFactor = [2, 2];
src.workAreaStart = 1;
src.workAreaDuration = 2;
src.motionBlur = true;
src.comment = "a comment";
const A = src.layers.addSolid([1, 0, 0], "A");
const B = src.layers.addSolid([0, 1, 0], "B");
B.parent = A;
B.expr("Opacity", 'thisComp.layer("A").transform.opacity');
A.expr("Rotation", 'comp("Src").layer("B").transform.rotation');
src.layers.add(nested);
project.activeItem = src;

// ------------------------------------------------ 1. the stub is faithful
//
// Drive the raw API first: if the stub ever stopped modelling what AE
// really does here, every check below would pass on a technicality.
{
  const before = project.numItems;
  src.selected = true;
  const d = src.duplicate();
  assert(d.name === "Src 2",
         "STUB FIDELITY: AE names the copy itself, 'Src' -> 'Src 2' (FACT 1)");
  assert(d.parentFolder === bin &&
         project._items.indexOf(d) === project._items.indexOf(src) + 1,
         "STUB FIDELITY: the copy lands in the source's folder, right " +
         "after it (FACT 2)");
  assert(d.bgColor[0] === 0.1 && d.resolutionFactor[1] === 2 &&
         d.workAreaStart === 1 && d.workAreaDuration === 2 &&
         d.motionBlur === true && d.comment === "a comment" &&
         d.numLayers === src.numLayers,
         "STUB FIDELITY: every comp setting comes with the copy (FACT 2)");
  assert(src.selected === true && d.selected === false &&
         project.selection.length === 1,
         "STUB FIDELITY: duplicating does NOT touch the project-panel " +
         "selection (FACT 3)");
  assert(d.layer(1).source === src.layer(1).source &&
         d.layer(3).source === nested,
         "STUB FIDELITY: the copy's layers point at the SAME sources " +
         "(FACT 6)");
  assert(d.layer("B").parent === d.layer("A"),
         "STUB FIDELITY: parenting is remapped inside the copy (FACT 7)");
  assert(d.layer("B").property("Opacity").expression ===
           'thisComp.layer("A").transform.opacity' &&
         d.layer("A").property("Rotation").expression ===
           'comp("Src").layer("B").transform.rotation' &&
         d.layer("A").property("Rotation").expressionError === "",
         "STUB FIDELITY: expressions are copied VERBATIM and comp(\"Src\") " +
         "is not rewritten, with no expressionError (FACT 7)");

  d.name = "Src";
  assert(project._items.filter(i => i.name === "Src").length === 2,
         "STUB FIDELITY: AE ACCEPTS a name another item already holds " +
         "(FACT 4)");
  assert(project._items.find(i => i.name === "Src") === src,
         "STUB FIDELITY: a by-name walk then finds the OLDER item, so the " +
         "copy is unreachable by name (FACT 4)");
  d.name = "";
  assert(d.name === "",
         "STUB FIDELITY: AE accepts a BLANK comp name (FACT 5)");

  project._items.splice(project._items.indexOf(d), 1);
  src.selected = false;
  assert(project.numItems === before, "rig restored");
}

// ------------------------------------------------ 2. the copy, unnamed
{
  const r = call("duplicate_comp", { comp: "Src" });
  assert(r.ok && r.data.name === "Src 2" && r.data.duplicatedFrom === "Src",
         "duplicate_comp takes AE's own name for the copy: " +
         (r.error || r.data.name));
  assert(r.ok && r.data.folder === "Sequences",
         "it says WHERE the copy landed — the source's own folder, not " +
         "the root: " + (r.ok ? r.data.folder : r.error));
  assert(r.ok && typeof r.data.id === "number", "and the copy's id");
  const r2 = call("duplicate_comp", { comp: "Src" });
  assert(r2.ok && r2.data.name === "Src 3",
         "a second copy is 'Src 3' (AE's numbering, not the tool's): " +
         (r2.error || r2.data.name));
  project._items = project._items.filter(
    i => i.name !== "Src 2" && i.name !== "Src 3");
}

// ------------------------------------------ 3. FACT 4: the name collision
{
  $.global.AELL_compAliases = {};
  const r = call("duplicate_comp", { comp: "Src", name: "Nested" });
  assert(r.ok, "a copy asked for a taken name still gets made: " +
         (r.error || ""));
  assert(r.ok && r.data.name === "Nested 2",
         "…under an auto-numbered one, because AE would have accepted the " +
         "collision and hidden the copy behind the older item: " +
         (r.ok ? r.data.name : r.error));
  assert(r.ok && /nameTaken/.test(Object.keys(r.data).join(",")) &&
         /Nested 2/.test(r.data.nameTaken),
         "and it SAYS so, with the name to use instead");
  assert($.global.AELL_compAliases["Nested"] === "Nested 2",
         "the rest of the batch is redirected at the copy (the model wrote " +
         "those commands before seeing this result)");
  assert(project._items.filter(i => i.name === "Nested").length === 1,
         "the item that already held the name is untouched");
  // and the redirect really resolves
  const r2 = call("get_comp_details", { comp: "Nested" });
  assert(r2.ok && r2.data.name === "Nested 2",
         "a later command saying 'Nested' now reaches the copy: " +
         (r2.ok ? r2.data.name : r2.error));
  project._items = project._items.filter(i => i.name !== "Nested 2");
  $.global.AELL_compAliases = {};
}

// ------------------- 3b. the copy asked for the SOURCE'S OWN name
{
  $.global.AELL_compAliases = {};
  const r = call("duplicate_comp", { comp: "Src", name: "Src" });
  assert(r.ok && r.data.name === "Src 2",
         "'duplicate Src and call it Src' auto-numbers like any other " +
         "collision: " + (r.error || r.data.name));
  assert(typeof $.global.AELL_compAliases["Src"] === "undefined",
         "but NO alias is registered — 'Src' must still mean the comp it " +
         "was copied FROM, not the copy");
  assert(/copied FROM/.test(r.data.nameTaken || ""),
         "and the result says which one 'Src' still means: " +
         r.data.nameTaken);
  const back = call("get_comp_details", { comp: "Src" });
  assert(back.ok && back.data.name === "Src",
         "a later command saying 'Src' reaches the original: " +
         (back.ok ? back.data.name : back.error));
  project._items = project._items.filter(i => i.name !== "Src 2");
}

// ---------------------------------------- 4. a free name is used verbatim
{
  $.global.AELL_compAliases = {};
  const r = call("duplicate_comp", { comp: "Src", name: "Src Backup" });
  assert(r.ok && r.data.name === "Src Backup" && !r.data.nameTaken,
         "a free name is taken verbatim, with nothing to report: " +
         (r.error || r.data.name));
  assert(typeof $.global.AELL_compAliases["Src Backup"] === "undefined",
         "and no alias is left behind for it");
  project._items = project._items.filter(i => i.name !== "Src Backup");
}

// ----------------------------- 5. renaming the copy to its OWN AE name
{
  const r = call("duplicate_comp", { comp: "Src", name: "Src 2" });
  assert(r.ok && r.data.name === "Src 2" && !r.data.nameTaken,
         "asking for the name AE already gave the copy is a no-op, not a " +
         "bump to 'Src 3': " + (r.error || r.data.name));
  project._items = project._items.filter(i => i.name !== "Src 2");
  assert(AELL_uniqueItemName("Src", src) === "Src",
         "AELL_uniqueItemName lets the excepted item keep its own name");
  assert(AELL_uniqueItemName("Src") === "Src 2",
         "…and still numbers a name somebody else holds");
}

// ------------------------------------------- 6. FACT 5: the blank name
{
  const before = project.numItems;
  for (const blank of ["", "   ", "\t"]) {
    const r = call("duplicate_comp", { comp: "Src", name: blank });
    assert(!r.ok && /blank/i.test(r.error || ""),
           "a blank name (" + JSON.stringify(blank) + ") is REFUSED — AE " +
           "would have made a comp nothing can look up: " +
           (r.error || "(it succeeded!)"));
  }
  assert(project.numItems === before,
         "and the refusal happens before anything is duplicated");
}

// -------------------------------------- 7. FACT 6: the shared sources
{
  const r = call("duplicate_comp", { comp: "Src" });
  assert(r.ok && Array.isArray(r.data.sharedSources),
         "the copy reports the sources it SHARES with the original: " +
         (r.error || JSON.stringify(r.data.sharedSources)));
  const shared = (r.data.sharedSources || []).join(" | ");
  assert(/A \(solid\)/.test(shared) && /B \(solid\)/.test(shared),
         "solids are named as solids — set_solid_color on the copy would " +
         "recolor the original too: " + shared);
  assert(/Nested \(precomp\)/.test(shared),
         "and the nested comp as a precomp: " + shared);
  assert(r.ok && /same in both comps/.test(r.data.sharedNote || ""),
         "with the consequence spelled out, not left to be inferred");
  project._items = project._items.filter(i => i.name !== "Src 2");
}

// ------------------------ 8. FACT 7: the expression left driving the source
{
  const r = call("duplicate_comp", { comp: "Src" });
  const back = (r.data.stillDrivenBySource || []).join(" | ");
  assert(/A > Rotation/.test(back),
         "an absolute comp(\"Src\") expression in the copy is reported — " +
         "it still reads the ORIGINAL and AE flags nothing: " + back);
  assert(!/B > Opacity/.test(back),
         "the relative thisComp one is NOT reported: it correctly follows " +
         "the copy: " + back);
  assert(/expressionError stays empty/.test(r.data.expressionNote || ""),
         "and the note says why nothing else would ever mention it");
  project._items = project._items.filter(i => i.name !== "Src 2");
}

// ------------------------------------ 9. a copy with nothing to report
{
  const plain = project.items.addComp("Plain", 100, 100, 1, 1, 24);
  const r = call("duplicate_comp", { comp: "Plain" });
  assert(r.ok && !r.data.sharedSources && !r.data.stillDrivenBySource &&
         !r.data.nameTaken,
         "a comp with no sources and no expressions reports none of it: " +
         JSON.stringify(r.data));
  assert(r.ok && r.data.folder === "Root",
         "a root-level comp's copy stays at the root: " +
         (r.ok ? r.data.folder : r.error));
  project._items = project._items.filter(
    i => i.name !== "Plain" && i.name !== "Plain 2");
}

// -------------------------------------------- 10. wiring and the docs
{
  assert(AELL_MUTATING.duplicate_comp === true,
         "duplicate_comp is registered as mutating (one Ctrl+Z, rollback " +
         "arming)");
  const r = call("duplicate_comp", { comp: "No Such Comp" });
  assert(!r.ok && /Comp not found/.test(r.error || "") && /Src/.test(r.error),
         "an unknown comp is refused with what DOES exist: " +
         (r.error || "(it resolved!)"));
  const doc = toolsSrc.slice(toolsSrc.indexOf('name: "duplicate_comp"'),
                             toolsSrc.indexOf('name: "organize_project"'));
  assert(/sharedSources/.test(doc) && /nameTaken/.test(doc),
         "tools.js documents both — an undocumented field is one the model " +
         "never learns to read");
}

console.log("\nduplicate_comp: " + checks + " checks");
