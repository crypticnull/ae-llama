// Regression test: split_layer_into_chunks / duplicate_layer against a
// stubbed AE object model — the exact "cut the sequence into 5s chunks"
// field scenario (35.94s footage layer).
"use strict";
const fs = require("fs");
const path = require("path");

function Layer(name, comp, inP, outP, start) {
  this.name = name; this.comp = comp;
  this.inPoint = inP; this.outPoint = outP; this.startTime = start;
  this.selected = false;
}
Layer.prototype.duplicate = function () {
  const d = new Layer(this.name, this.comp, this.inPoint, this.outPoint,
                      this.startTime);
  this.comp._layers.splice(this.comp._layers.indexOf(this), 0, d);
  this.comp._reindex();
  return d;
};
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
Layer.prototype.property = function () { return null; };
Layer.prototype.moveAfter = function (other) {
  const arr = this.comp._layers;
  arr.splice(arr.indexOf(this), 1);
  arr.splice(arr.indexOf(other) + 1, 0, this);
};
Layer.prototype.moveBefore = function (other) {
  const arr = this.comp._layers;
  arr.splice(arr.indexOf(this), 1);
  arr.splice(arr.indexOf(other), 0, this);
};

function Comp(name, dur) {
  this.name = name; this.duration = dur; this.time = 0;
  this.width = 3840; this.height = 2860;
  this._layers = [];
}
Comp.prototype._reindex = function () {};
Comp.prototype.layer = function (ref) {
  const l = typeof ref === "number"
    ? this._layers[ref - 1]
    : this._layers.find(x => x.name === ref);
  if (!l) throw new Error("no layer " + ref);
  return l;
};
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { return this._layers.length; }
});
Object.defineProperty(Comp.prototype, "selectedLayers", {
  get() { return this._layers.filter(l => l.selected); }
});

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};

const comp = new Comp("Car Wash", 35.9359359359359);
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
const seq = new Layer("Car Wash[0000-1076].png", comp, 0, 35.9359359359359, 0);
comp._layers.push(seq);

const project = { rootFolder: { name: "(root)" }, numItems: 0,
                  item() { return null; }, items: {}, activeItem: comp };
const app = { project, beginUndoGroup() {}, endUndoGroup() {} };
const $ = { global: {} };

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "jsx",
                                "hostscript.jsx"), "utf8"));

function call(tool, args) {
  return JSON.parse($.global.AELL_call(tool, JSON.stringify(args)));
}
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// the exact field request: 35.94s layer, 5s chunks
const r = call("split_layer_into_chunks",
               { layer: "Car Wash[0000-1076].png", chunkSeconds: 5 });
assert(r.ok, "split succeeds: " + (r.error || ""));
assert(r.data.chunks === 8, "35.94s / 5s -> 8 chunks (got " + r.data.chunks + ")");
assert(comp._layers.length === 8, "comp now holds 8 layers");

const windows = comp._layers
  .map(l => [l.inPoint, l.outPoint])
  .sort((a, b) => a[0] - b[0]);
let contiguous = true;
for (let i = 0; i < windows.length - 1; i++) {
  if (Math.abs(windows[i][1] - windows[i + 1][0]) > 1e-9) contiguous = false;
}
assert(contiguous, "chunk windows are contiguous (no overlap, no gaps)");
assert(Math.abs(windows[0][0] - 0) < 1e-9 &&
       Math.abs(windows[7][1] - 35.9359359359359) < 1e-9,
       "full original span covered");
assert(comp._layers.every(l => l.startTime === 0),
       "startTime untouched -> seamless playback");
assert(comp._layers.every(l => /chunk \d+$/.test(l.name)),
       "chunks renamed for clarity");

// stagger with per-chunk offset
const comp2 = new Comp("B", 12);
Object.setPrototypeOf(comp2, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
comp2._layers.push(new Layer("clip", comp2, 0, 12, 0));
project.activeItem = comp2;
const r2 = call("split_layer_into_chunks",
                { layer: "clip", chunkSeconds: 4, offsetPerChunk: 1 });
assert(r2.ok && r2.data.chunks === 3, "12s / 4s -> 3 chunks");
const starts = comp2._layers.map(l => l.startTime).sort((a, b) => a - b);
assert(JSON.stringify(starts) === "[0,1,2]",
       "offsetPerChunk slides chunk i by i*offset (starts: " + starts + ")");

// guards
const comp3 = new Comp("C", 3);
Object.setPrototypeOf(comp3, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
comp3._layers.push(new Layer("tiny", comp3, 0, 3, 0));
project.activeItem = comp3;
const r3 = call("split_layer_into_chunks", { layer: "tiny", chunkSeconds: 5 });
assert(!r3.ok && /nothing to split/.test(r3.error),
       "too-short layer refused with clear error");

// duplicate_layer basic
project.activeItem = comp3;
const r4 = call("duplicate_layer", { layer: "tiny", name: "tiny copy" });
assert(r4.ok && comp3._layers.length === 2 &&
       comp3._layers.some(l => l.name === "tiny copy"),
       "duplicate_layer duplicates and renames");

// selection default: omitted layer resolves to the single selected layer
const comp4 = new Comp("Car Wash 2", 8);
Object.setPrototypeOf(comp4, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
comp4._layers.push(new Layer("bg", comp4, 0, 8, 0));
const hero = new Layer("hero", comp4, 0, 8, 0);
hero.selected = true;
comp4._layers.push(hero);
project.activeItem = comp4;
const r5 = call("split_layer_into_chunks", { comp: null, chunkSeconds: 2 });
assert(r5.ok && r5.data.chunks === 4,
       "omitted layer -> splits the selected layer (8s/2s -> 4 chunks): " +
       (r5.error || ""));
assert(comp4._layers.filter(l => /^hero chunk \d+$/.test(l.name)).length === 4,
       "chunks come from the selected layer, not an arbitrary one");
assert(comp4._layers.some(l => l.name === "bg"),
       "unselected layer left untouched");

// omitted layer with nothing selected -> clear guidance, no guessing
comp4._layers.forEach(l => { l.selected = false; });
const r6 = call("split_layer_into_chunks", { chunkSeconds: 2 });
assert(!r6.ok && /No layer selected/.test(r6.error),
       "no selection + omitted layer in a multi-layer comp -> clear error");

// …but a ONE-layer comp is unambiguous: omitted layer uses that layer
const compOne = new Comp("Solo", 6);
Object.setPrototypeOf(compOne, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
compOne._layers.push(new Layer("only", compOne, 0, 6, 0));
project.activeItem = compOne;
const rOne2 = call("duplicate_layer", { count: 2 });
assert(rOne2.ok && rOne2.data.duplicatedFrom === "only" &&
       compOne._layers.length === 3,
       "single-layer comp: omitted layer resolves without selection");
project.activeItem = comp4;

// omitted layer with several selected -> error names them
comp4.layer("bg").selected = true;
comp4.layer("hero chunk 1").selected = true;
const r7 = call("duplicate_layer", {});
assert(!r7.ok && /2 layers selected/.test(r7.error) && /bg/.test(r7.error),
       "multi-selection error lists the selected layer names");

// the exact field failure: model passed the placeholder "these layers"
const r8 = call("split_layer_into_chunks",
                { comp: null, layer: "these layers", chunkSeconds: 2 });
assert(!r8.ok && /Actual layers:/.test(r8.error),
       "placeholder layer name -> grounded error listing real layers");
assert(/\(SELECTED\)/.test(r8.error),
       "grounded error marks which layers are selected");
assert(/OMIT the 'layer' argument/.test(r8.error),
       "grounded error tells the model to omit the layer arg");

// duplicate_layer also honors the selection default
comp4._layers.forEach(l => { l.selected = false; });
comp4.layer("bg").selected = true;
const r9 = call("duplicate_layer", { name: "bg copy" });
assert(r9.ok && r9.data.duplicatedFrom === "bg" &&
       comp4._layers.some(l => l.name === "bg copy"),
       "duplicate_layer defaults to the selected layer");

// exact piece count: "5 equal chunks" -> {chunks: 5}, host does the math
const comp5 = new Comp("Car Wash 3", 35.9359359359359);
Object.setPrototypeOf(comp5, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
const seq5 = new Layer("seq", comp5, 0, 35.9359359359359, 0);
seq5.selected = true;
comp5._layers.push(seq5);
project.activeItem = comp5;
const r10 = call("split_layer_into_chunks", { chunks: 5 });
assert(r10.ok && r10.data.chunks === 5,
       "{chunks: 5} makes exactly 5 pieces (got " +
       (r10.ok ? r10.data.chunks : r10.error) + ")");
assert(comp5._layers.length === 5, "comp holds exactly 5 layers");
const w5 = comp5._layers.map(l => [l.inPoint, l.outPoint])
  .sort((a, b) => a[0] - b[0]);
let equal5 = true;
for (const [s, e] of w5) {
  if (Math.abs((e - s) - 35.9359359359359 / 5) > 1e-9) equal5 = false;
}
assert(equal5, "all 5 pieces are exactly span/5 long");
assert(Math.abs(w5[0][0]) < 1e-9 &&
       Math.abs(w5[4][1] - 35.9359359359359) < 1e-9,
       "5 equal pieces cover the full span");
assert(comp5._layers.map(l => l.name).join("|") ===
       "seq chunk 5|seq chunk 4|seq chunk 3|seq chunk 2|seq chunk 1",
       "chunks stack ascending — later chunks higher, chunk 1 at the " +
       "bottom (got " + comp5._layers.map(l => l.name).join("|") + ")");
assert(comp5._layers.every(l => l.selected),
       "chunks are left selected for follow-up commands");

// chunk-count guards
const rBad = call("split_layer_into_chunks", { layer: 1, chunks: 100 });
assert(!rBad.ok && /capped at 60/.test(rBad.error),
       "chunks > 60 refused");
const rOne = call("split_layer_into_chunks", { layer: 1, chunks: 1 });
assert(!rOne.ok && /at least 2/.test(rOne.error), "chunks: 1 refused");

// big batches report a sample, not every piece (context-window safety)
const comp6 = new Comp("Long", 36);
Object.setPrototypeOf(comp6, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
comp6._layers.push(new Layer("clip36", comp6, 0, 36, 0));
project.activeItem = comp6;
const r11 = call("split_layer_into_chunks",
                 { layer: "clip36", chunkSeconds: 1 });
assert(r11.ok && r11.data.chunks === 36 && r11.data.pieces.length === 3 &&
       /listing 3 of 36/.test(r11.data.note),
       "36-chunk result lists only a 3-piece sample");
assert(JSON.stringify(r11.data).length < 600,
       "large split result stays compact (" +
       JSON.stringify(r11.data).length + " chars)");

// stack order flips on request
const comp7 = new Comp("Desc", 9);
Object.setPrototypeOf(comp7, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
comp7._layers.push(new Layer("d", comp7, 0, 9, 0));
project.activeItem = comp7;
const r12 = call("split_layer_into_chunks",
                 { layer: "d", chunks: 3, order: "descending" });
assert(r12.ok && comp7._layers.map(l => l.name).join("|") ===
       "d chunk 1|d chunk 2|d chunk 3",
       "order: 'descending' puts chunk 1 on top — staircase down (got " +
       comp7._layers.map(l => l.name).join("|") + ")");

// reorder_layers: restack by start time, timing untouched
const comp8 = new Comp("Stack", 20);
Object.setPrototypeOf(comp8, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
const rA = new Layer("early", comp8, 0, 5, 0);
const rB = new Layer("late", comp8, 0, 5, 5);
const rC = new Layer("mid", comp8, 0, 5, 2);
comp8._layers.push(rA, rB, rC);
project.activeItem = comp8;
const r13 = call("reorder_layers", {});   // nothing selected -> all layers
assert(r13.ok && comp8._layers.map(l => l.name).join("|") ===
       "late|mid|early",
       "ascending: later start times stack higher — staircase up (got " +
       comp8._layers.map(l => l.name).join("|") + ")");
assert(rA.startTime === 0 && rB.startTime === 5 && rC.startTime === 2,
       "reorder_layers leaves start times untouched");
const r14 = call("reorder_layers", { order: "descending" });
assert(r14.ok && comp8._layers.map(l => l.name).join("|") ===
       "early|mid|late",
       "descending: earliest on top — staircase down (got " +
       comp8._layers.map(l => l.name).join("|") + ")");
const r15 = call("reorder_layers", { layers: ["early"] });
assert(!r15.ok && /at least 2/.test(r15.error),
       "reorder with fewer than 2 targets refused");

// duplicate_layer count: the "12 circles" field case in ONE call
const comp9 = new Comp("Dups", 10);
Object.setPrototypeOf(comp9, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
comp9._layers.push(new Layer("Circle", comp9, 0, 10, 0));
project.activeItem = comp9;
const r16 = call("duplicate_layer", { layer: "Circle", count: 11 });
assert(r16.ok && r16.data.created === 11 &&
       r16.data.totalLayersInComp === 12,
       "count: 11 makes 11 copies in one call (12 total): " +
       (r16.error || ""));
const names9 = comp9._layers.map(l => l.name);
assert(new Set(names9).size === 12,
       "every copy gets a unique name (got " + names9.join(", ") + ")");
assert(names9.includes("Circle 2") && names9.includes("Circle 12"),
       "copies auto-number Circle 2..Circle 12");
assert(names9[0] === "Circle" && names9[1] === "Circle 2" &&
       names9[11] === "Circle 12",
       "ORIGINAL stays on top; copies stack below in order (got " +
       names9.slice(0, 3).join("|") + "…)");

// explicit name that collides still auto-numbers
const r17 = call("duplicate_layer", { layer: "Circle", name: "Circle" });
assert(r17.ok && r17.data.names === "Circle 13" &&
       /auto-numbered/.test(r17.data.note),
       "explicit colliding name auto-numbers with a note");
const r18 = call("duplicate_layer", { layer: "Circle", count: 101 });
assert(!r18.ok && /capped at 100/.test(r18.error), "count > 100 refused");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
