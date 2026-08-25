// Regression test: set_solid_color.
//
// The probe that found the need for this tool (chat-probe step 9, "make
// them blue instead") failed because NO tool could change a solid's
// colour — the model tried four approaches and none existed. The colour
// is not on the layer; it is on the solid SOURCE.
//
// Measured in AE 2026 before the tool was written, and modelled here:
//
//  1. `layer.source.mainSource.color` IS writable and reads back.
//  2. duplicate_layer hands out layers that SHARE one source — three
//     layers, one source id. split_layer_into_chunks does the same (3
//     chunk layers, 1 distinct source). So "recolouring one recolours
//     several" is this panel's NORMAL case, not an edge.
//  3. `app.project.items.addSolid` does NOT exist. The only way to mint
//     a SolidSource from script is to add a throwaway solid LAYER, take
//     its `.source`, and remove the layer — the source survives.
//  4. `replaceSource(fresh, false)` keeps keyframes, effects, masks,
//     transform, the layer's hand-set NAME and its in/out points. All
//     four were loaded onto a layer and counted before and after.
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

let solidId = 0;
function makeSolidSource(color, name, w, h) {
  const ms = Object.create(SolidSource.prototype);
  ms.color = color.slice(0);
  const item = { name, width: w, height: h, pixelAspect: 1,
                 mainSource: ms, id: ++solidId,
                 get usedIn() {
                   return project._items.filter(
                     it => it instanceof CompItem &&
                       it._layers.some(L => L.source === item));
                 },
                 remove() {
                   const k = project._items.indexOf(item);
                   if (k >= 0) project._items.splice(k, 1);
                 } };
  Object.setPrototypeOf(item, FootageItem.prototype);
  project._items.push(item);
  return item;
}

function Layer(name, comp, source) {
  this._name = null;              // null = AUTO, follows the source
  if (name) this._name = name;
  this.comp = comp;
  this.source = source;
  this.enabled = true;
  this.selected = false;
  this.inPoint = 0;
  this.outPoint = 5;
  this.replacedWith = null;
}
// FACT 5, measured the hard way (the self-test grew two layers with the
// SAME name): a layer that has never been renamed by hand DISPLAYS its
// source's name, so replaceSource silently renames it. A hand-set name
// survives. Modelled here so the fix cannot regress without AE.
Object.defineProperty(Layer.prototype, "name", {
  get() {
    if (this._name !== null) return this._name;
    return this.source ? this.source.name : "(none)";
  },
  set(v) { this._name = String(v); }
});
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
// FACT 4: replaceSource swaps ONLY the source. Everything else the layer
// carries is untouched — the stub asserts that by simply not touching it.
Layer.prototype.replaceSource = function (src, fixExpressions) {
  this.source = src;
  this.replacedWith = src.name;
};
Layer.prototype.remove = function () {
  const k = this.comp._layers.indexOf(this);
  if (k >= 0) this.comp._layers.splice(k, 1);
};
Layer.prototype.property = function () { throw new Error("no property"); };

function Comp(name) {
  this.name = name;
  this.width = 640; this.height = 480;
  this.duration = 5; this.frameRate = 30;
  this._layers = [];
}
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { return this._layers.length; }
});
Object.defineProperty(Comp.prototype, "selectedLayers", {
  get() { return this._layers.filter(l => l.selected); }
});
Comp.prototype.layer = function (ref) {
  const l = typeof ref === "number" ? this._layers[ref - 1]
    : this._layers.filter(x => x.name === ref)[0];
  if (!l) throw new Error("no layer " + ref);
  return l;
};
// FACT 3: the ONLY way to mint a SolidSource is through a solid LAYER.
// There is deliberately no project.items.addSolid on this stub either.
Object.defineProperty(Comp.prototype, "layers", {
  get() {
    const self = this;
    return {
      addSolid(color, name, w, h) {
        const src = makeSolidSource(color, name, w, h);
        const L = new Layer(name, self, src);
        self._layers.push(L);
        return L;
      }
    };
  }
});

function makeComp(name) {
  const c = new Comp(name);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  return c;
}

const project = {
  _items: [],
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  rootFolder: { name: "(root)" },
  renderQueue: { numItems: 0 },
  items: {
    addComp(name) { const c = makeComp(name); project._items.push(c); return c; },
    addFolder(name) {
      const f = { name, remove() {} };
      Object.setPrototypeOf(f, FolderItem.prototype);
      project._items.push(f);
      return f;
    }
  }
};

const app = { project, version: "26.3x87",
              beginUndoGroup() {}, endUndoGroup() {}, executeCommand() {} };
const $ = { global: {}, hiresTimer: 0 };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool, " +
  "AELL_ALREADY_BATCHED: AELL_ALREADY_BATCHED })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool, AELL_ALREADY_BATCHED } = host;
const call = (t, a) => AELL_runTool(t, a || {});

// ---------------------------------------------------------------- rig
//
// One solid duplicated three times (all sharing a source, the way
// duplicate_layer really leaves them), plus a lone solid and a text
// layer that is not a solid at all.
const comp = project.items.addComp("Room");
const sq1 = comp.layers.addSolid([1, 0, 0], "Square", 100, 100);
sq1._name = null;                 // AUTO-named, the way AE leaves it
const shared = sq1.source;
const sq2 = new Layer("Square 2", comp, shared);
const sq3 = new Layer("Square 3", comp, shared);
comp._layers.push(sq2, sq3);
const lone = comp.layers.addSolid([0, 0, 0], "Lone", 50, 50);
const words = new Layer("Words", comp, null);
Object.setPrototypeOf(words, Object.create(TextLayer.prototype,
  Object.getOwnPropertyDescriptors(Layer.prototype)));
comp._layers.push(words);

const colourOf = l => l.source.mainSource.color;

assert(sq1.source === sq2.source && sq2.source === sq3.source,
       "STUB FIDELITY: duplicated layers share ONE solid source");

// ------------------------------------- 1. every sharer asked for = fine

{
  const r = call("set_solid_color",
    { comp: "Room", layers: ["Square", "Square 2", "Square 3"],
      color: [0, 0, 1] });
  assert(r.ok, "recolouring all three sharers is allowed: " + (r.error || ""));
  assert(String(colourOf(sq1)) === "0,0,1" &&
         String(colourOf(sq3)) === "0,0,1",
         "and all three really change (one write to the shared source)");
  assert(r.data.solidsTouched === 1,
         "one solid touched, not three (got " + r.data.solidsTouched + ")");
  assert(!r.data.alsoChanged && /Nothing else uses/.test(r.data.note),
         "and the result says nothing else was affected: " + r.data.note);
}

// -------------------------------- 2. a SUBSET is refused, not surprised

{
  const r = call("set_solid_color",
    { comp: "Room", layer: "Square", color: [0, 1, 0] });
  assert(!r.ok, "recolouring ONE of three sharers is refused");
  assert(/Square 2/.test(r.error) && /Square 3/.test(r.error),
         "naming exactly who else would have changed: " +
         r.error.slice(0, 90));
  assert(/makeUnique/.test(r.error),
         "and offering both ways out");
  assert(String(colourOf(sq1)) === "0,0,1",
         "nothing was changed by the refusal");
}

// ------------------------------------------ 3. makeUnique:true isolates

{
  const itemsBefore = project.numItems;
  const r = call("set_solid_color",
    { comp: "Room", layer: "Square", color: [0, 1, 0], makeUnique: true });
  assert(r.ok, "makeUnique:true is accepted: " + (r.error || ""));
  assert(String(colourOf(sq1)) === "0,1,0", "the named layer changes");
  assert(String(colourOf(sq2)) === "0,0,1" &&
         String(colourOf(sq3)) === "0,0,1",
         "and the two that still share are untouched");
  assert(sq1.source !== sq2.source, "it now has its OWN source");
  assert(project.numItems === itemsBefore + 1,
         "which is one new project item (got " +
         (project.numItems - itemsBefore) + ")");
  assert(/OWN solid/.test(r.data.note) && /project panel/.test(r.data.note),
         "and the result says so, including the panel clutter: " +
         r.data.note);
  assert(sq1.name === "Square",
         "the layer KEEPS its name (got " + sq1.name + ") — an " +
         "auto-named layer would otherwise follow its new source and " +
         "collide with a sibling, which is what real AE did");
  assert(sq1.source.name !== "Square",
         "even though its new source is called something else (" +
         sq1.source.name + ")");
}

// --------------------------- 4. makeUnique:false spreads, and admits it

{
  const r = call("set_solid_color",
    { comp: "Room", layer: "Square 2", color: [1, 1, 0],
      makeUnique: false });
  assert(r.ok, "makeUnique:false is accepted");
  assert(String(colourOf(sq2)) === "1,1,0" &&
         String(colourOf(sq3)) === "1,1,0",
         "both sharers change, as asked");
  assert(r.data.alsoChanged && r.data.alsoChanged.join(",") === "Square 3",
         "and the ones nobody named are reported: " +
         JSON.stringify(r.data.alsoChanged));
}

// ------------------------------------------- 5. refusals worth having

{
  const r = call("set_solid_color", { comp: "Room", layer: "Words",
                                      color: [1, 0, 0] });
  assert(!r.ok && /only works on SOLID layers/.test(r.error),
         "a text layer is refused: " + r.error.slice(0, 60));
  assert(/set_text_style/.test(r.error) && /set_property/.test(r.error),
         "and the refusal points at the tools that DO change those");
}
{
  const r = call("set_solid_color", { comp: "Room", layer: "Lone" });
  assert(!r.ok && /'color' is required/.test(r.error),
         "a missing colour is refused: " + r.error);
}
{
  const r = call("set_solid_color",
    { comp: "Room", layer: "Lone", color: [2, -1, 0.5] });
  assert(r.ok && String(colourOf(lone)) === "1,0,0.5",
         "out-of-range components are clamped to 0..1, not rejected: " +
         String(colourOf(lone)));
}

// --------------------------------------------- 6. wiring, not drift

assert(AELL_MUTATING.set_solid_color === true,
       "set_solid_color is registered as mutating");
assert(AELL_ALREADY_BATCHED.set_solid_color === true,
       "and as already-batched, so for_each_layer refuses to drive it " +
       "one layer at a time");
assert(toolsSrc.includes('name: "set_solid_color"'),
       "and it is documented to the model");
assert(/ONLY way/.test(toolsSrc),
       "with the doc saying it is the only way to recolour a solid");

console.log("\n" + checks + " checks");
