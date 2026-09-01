// Regression test: split_layer_into_chunks / duplicate_layer against a
// stubbed AE object model — the exact "cut the sequence into 5s chunks"
// field scenario (35.94s footage layer).
"use strict";
const fs = require("fs");
const path = require("path");

// srcDuration models a real FOOTAGE source: measured in AE 2026, writing an
// inPoint before the source starts or an outPoint past its end does NOT
// throw — AE silently CLAMPS it (startTime 1, 10s source: inPoint = 0.2
// came back 1, outPoint = 13 came back 11). A solid has no such limit.
function Layer(name, comp, inP, outP, start, srcDuration) {
  this.name = name; this.comp = comp;
  this.startTime = start;
  this.srcDuration = srcDuration || 0;
  this._in = inP; this._out = outP;
  this.selected = false;
}
Object.defineProperty(Layer.prototype, "inPoint", {
  get() { return this._in; },
  set(v) { this._in = this._clamp(v); }
});
Object.defineProperty(Layer.prototype, "outPoint", {
  get() { return this._out; },
  set(v) { this._out = this._clamp(v); }
});
Layer.prototype._clamp = function (v) {
  if (!this.srcDuration) return v;
  return Math.min(Math.max(v, this.startTime),
                  this.startTime + this.srcDuration);
};
Layer.prototype.duplicate = function () {
  const d = new Layer(this.name, this.comp, this.inPoint, this.outPoint,
                      this.startTime, this.srcDuration);
  this.comp._layers.splice(this.comp._layers.indexOf(this), 0, d);
  this.comp._reindex();
  return d;
};
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
Layer.prototype.property = function () { return null; };
// A layer moved relative to ITSELF throws here: after the first splice
// indexOf(this) is -1, and the silent version inserted before the LAST
// element — a scrambled stack that a host dropping its self-move refusal
// would have passed with. (What real AE does with moveBefore(self) is
// unmeasured; the host refuses before the call either way.)
Layer.prototype.moveAfter = function (other) {
  if (other === this) throw new Error("After Effects error: a layer cannot be moved after itself");
  const arr = this.comp._layers;
  arr.splice(arr.indexOf(this), 1);
  arr.splice(arr.indexOf(other) + 1, 0, this);
};
Layer.prototype.moveBefore = function (other) {
  if (other === this) throw new Error("After Effects error: a layer cannot be moved before itself");
  const arr = this.comp._layers;
  arr.splice(arr.indexOf(this), 1);
  arr.splice(arr.indexOf(other), 0, this);
};

// Every real comp has a frame rate, and AE quantizes nothing for you: a
// sub-frame inPoint/outPoint pair is accepted and then renders NO frames.
// The old stub had no frame grid at all, so mid-frame cuts were invisible.
function Comp(name, dur, fps) {
  this.name = name; this.duration = dur; this.time = 0;
  this.width = 3840; this.height = 2860;
  this.frameRate = fps || 30;
  this.frameDuration = 1 / this.frameRate;
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

const comp = new Comp("Car Wash", 35.9359359359359, 29.97);
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
const seq = new Layer("Car Wash[0000-1076].png", comp, 0,
                      35.9359359359359, 0, 35.9359359359359);
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
const comp5 = new Comp("Car Wash 3", 35.9359359359359, 29.97);
Object.setPrototypeOf(comp5, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
const seq5 = new Layer("seq", comp5, 0, 35.9359359359359, 0,
                       35.9359359359359);
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
// Frame-aligned, not arithmetically equal: 35.9359s / 5 is 215.4 frames, so
// AE-correct pieces are 215 and 216 frames, never 215.4. A cut landing
// mid-frame gives a piece an arbitrary frame count — or, if it is short
// enough, none at all.
const fd5 = comp5.frameDuration;
const onGrid5 = w5.every(([s, e]) =>
  Math.abs(s) < 1e-9 || Math.abs(s / fd5 - Math.round(s / fd5)) < 1e-6);
assert(onGrid5, "every cut lands on a whole comp frame (in-points at " +
       w5.map(x => (x[0] / fd5).toFixed(3)).join(", ") + " frames)");
const lens5 = w5.map(([s, e]) => Math.round((e - s) / fd5));
assert(Math.max.apply(null, lens5) - Math.min.apply(null, lens5) <= 1,
       "5 pieces are within one frame of each other (" + lens5 + " frames)");
assert(lens5.reduce((a, b) => a + b, 0) ===
         Math.round(35.9359359359359 / fd5),
       "the 5 pieces add up to the layer's whole frame count");
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

// ---- Sorting that does not depend on a stable sort (real-AE finding) ----
// ExtendScript's Array.sort is UNSTABLE: six layers all at startTime 0
// came back with one of them yanked to the top for no reason. Node's sort
// IS stable, so the bug cannot reproduce by running the code -- this shim
// makes the host's sort behave the way AE's actually does (a legal
// permutation before sorting, which only ever disturbs TIED keys).
function withUnstableSort(fn) {
  const real = Array.prototype.sort;
  Array.prototype.sort = function (cmp) {
    this.reverse();
    return real.call(this, cmp);
  };
  try { return fn(); } finally { Array.prototype.sort = real; }
}

const comp8b = new Comp("Tied", 20);
Object.setPrototypeOf(comp8b, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
["T1", "T2", "T3", "T4"].forEach(n =>
  comp8b._layers.push(new Layer(n, comp8b, 0, 5, 0)));   // every start tied
project.activeItem = comp8b;
const before8b = comp8b._layers.map(l => l.name).join("|");
const r15a = withUnstableSort(() => call("reorder_layers", {}));
assert(r15a.ok && comp8b._layers.map(l => l.name).join("|") === before8b,
       "tied startTimes keep the stack they had, ascending (got " +
       comp8b._layers.map(l => l.name).join("|") + ")");
const r15b = withUnstableSort(() =>
  call("reorder_layers", { order: "descending" }));
assert(r15b.ok && comp8b._layers.map(l => l.name).join("|") === before8b,
       "tied startTimes keep the stack they had, descending (got " +
       comp8b._layers.map(l => l.name).join("|") + ")");

// by:'name' must read the numbers in names as numbers. Layer names in AE
// are numbered far more often than alphabetic (split_layer_into_chunks
// emits "X 1".."X 30"), and a string compare buries 10..30 between 1 and 2.
const comp8c = new Comp("Names", 20);
Object.setPrototypeOf(comp8c, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
["N 2", "N 10", "N 1", "N 21"].forEach(n =>
  comp8c._layers.push(new Layer(n, comp8c, 0, 5, 0)));
project.activeItem = comp8c;
const r15c = call("reorder_layers", { by: "name", order: "descending" });
assert(r15c.ok && comp8c._layers.map(l => l.name).join("|") ===
       "N 1|N 2|N 10|N 21",
       "by:'name' sorts N 2 before N 10, not after (got " +
       comp8c._layers.map(l => l.name).join("|") + ")");
assert(r15c.data.topToBottom === "N 1 | N 2 | N 10 | N 21",
       "…and topToBottom reports the same order (got " +
       r15c.data.topToBottom + ")");
assert(r15c.data.slots === "1..4",
       "…and reports the slots it actually landed in (got " +
       r15c.data.slots + ")");

// Reordering a SUBSET pulls it contiguous, which shoves untargeted layers
// out of the way. That is not wrong, but it must be reported, not silent.
const comp8d = new Comp("Subset", 20);
Object.setPrototypeOf(comp8d, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
[["s1", 1], ["s2", 2], ["s3", 3], ["s4", 4], ["s5", 5], ["s6", 6]]
  .forEach(([n, st]) => comp8d._layers.push(new Layer(n, comp8d, 0, 8, st)));
project.activeItem = comp8d;
const r15d = call("reorder_layers", { layers: ["s2", "s4", "s6"] });
assert(r15d.ok && r15d.data.displaced === 2,
       "subset reorder reports the 2 untargeted layers it pushed aside " +
       "(got " + r15d.data.displaced + ")");
assert(/pushed aside/.test(r15d.data.note || ""),
       "…and says so in the note (got: " + (r15d.data.note || "") + ")");
assert(r15d.data.topToBottom === "s6 | s4 | s2",
       "…and the targets land contiguous, latest on top (got " +
       r15d.data.topToBottom + ")");

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

// --- the frame grid: cuts AE can actually render -------------------------
// Measured in AE 2026: a layer whose inPoint and outPoint both fall between
// the same two frames is accepted without complaint and renders NOTHING.
// Splitting a 0.5s span into 30 pieces at 25 fps left 17 of the 30 layers
// invisible while the tool reported 30 seamless chunks.
const compF = new Comp("Frames", 12, 30);
Object.setPrototypeOf(compF, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
compF._layers.push(new Layer("clipF", compF, 1, 1.5, 0, 12));
project.activeItem = compF;
const rF = call("split_layer_into_chunks", { layer: "clipF", chunks: 30 });
assert(!rF.ok, "sub-frame chunks refused instead of made invisible");
assert(/shorter than one frame/.test(rF.error || "") &&
       /30 fps/.test(rF.error || "") &&
       /at most 15 chunks/i.test(rF.error || ""),
       "refusal is grounded: names the fps and how many chunks DO fit (" +
       rF.error + ")");
const rF2 = call("split_layer_into_chunks",
                 { layer: "clipF", chunkSeconds: 0.01 });
assert(!rF2.ok && /shorter than one frame/.test(rF2.error || ""),
       "sub-frame chunkSeconds refused too");

// a legal split of an OFF-GRID span keeps the user's own in/out verbatim
// and still puts every interior cut on a frame
const compG = new Comp("Grid", 12, 30);
Object.setPrototypeOf(compG, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
compG._layers.push(new Layer("clipG", compG, 1.35, 6.55, 0, 12));
project.activeItem = compG;
const rG = call("split_layer_into_chunks", { layer: "clipG", chunks: 7 });
assert(rG.ok && rG.data.chunks === 7, "7 chunks of an off-grid span: " +
       (rG.error || ""));
const wG = compG._layers.map(l => [l.inPoint, l.outPoint])
  .sort((a, b) => a[0] - b[0]);
assert(Math.abs(wG[0][0] - 1.35) < 1e-9 && Math.abs(wG[6][1] - 6.55) < 1e-9,
       "the layer's OWN first in and last out are kept verbatim, off-grid " +
       "or not (got " + wG[0][0] + " / " + wG[6][1] + ")");
const fdG = compG.frameDuration;
let interiorOnGrid = true;
for (let i = 1; i < wG.length; i++) {
  const b = wG[i][0];
  if (Math.abs(b / fdG - Math.round(b / fdG)) > 1e-6) interiorOnGrid = false;
  if (Math.abs(wG[i - 1][1] - b) > 1e-9) interiorOnGrid = false;
}
assert(interiorOnGrid,
       "interior cuts are frame-aligned AND still tile (in-points at " +
       wG.map(x => (x[0] / fdG).toFixed(2)).join(", ") + " frames)");
assert(wG.every(([s, e]) => Math.round((e - s) / fdG) >= 1),
       "every piece holds at least one frame");
assert(/cut on whole frames at 30 fps/.test(rG.data.note),
       "note says the cuts are frame-aligned: " + rG.data.note);

// a final remainder too short to hold a frame is folded away, not shipped
// as an empty layer — and the result says so instead of claiming 5 pieces
const compH = new Comp("Remainder", 12, 30);
Object.setPrototypeOf(compH, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
compH._layers.push(new Layer("clipH", compH, 0, 10, 0, 12));
project.activeItem = compH;
const rH = call("split_layer_into_chunks",
                { layer: "clipH", chunkSeconds: 2.4995 });
assert(rH.ok && rH.data.chunks === 4,
       "a sub-frame final remainder is folded into the piece before it " +
       "(got " + (rH.ok ? rH.data.chunks : rH.error) + ")");
assert(compH._layers.length === 4, "no empty layer is left behind");
assert(/cut point\(s\) dropped/.test(rH.data.note),
       "the dropped cut is reported, not swallowed: " + rH.data.note);

// split never writes outside the source range, so AE's silent clamp on a
// footage layer's in/out points can never quietly reshape the pieces
const compS = new Comp("Src", 20, 30);
Object.setPrototypeOf(compS, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
compS._layers.push(new Layer("shot", compS, 2, 7, 1, 10));  // 10s src @ t=1
project.activeItem = compS;
const rS = call("split_layer_into_chunks", { layer: "shot", chunks: 3 });
assert(rS.ok, "footage-backed split succeeds: " + (rS.error || ""));
assert(compS._layers.every(l => l.inPoint >= 1 - 1e-9 &&
                                l.outPoint <= 11 + 1e-9),
       "every piece stays inside the source range (no clamp was hit)");
const wS = compS._layers.map(l => [l.inPoint, l.outPoint])
  .sort((a, b) => a[0] - b[0]);
assert(Math.abs(wS[0][0] - 2) < 1e-9 && Math.abs(wS[2][1] - 7) < 1e-9,
       "trimmed footage keeps its trim: pieces cover exactly 2s..7s");
assert(compS._layers.every(l => l.startTime === 1),
       "startTime untouched, so each piece shows the same source frames it " +
       "did before the split");

// ---- reorder_layers RELATIVE mode (audit 0.11 item 4) -------------------
// "Put it behind the logo" used to have no tool: the nearest routing was
// the SORTER above, which restacks a whole list by start time. The start
// times here are deliberately scrambled so that a host which fell through
// to the sort would scramble the stack — a reverted host answers these
// calls with {by, topToBottom} and a re-sorted comp, never with movedTo.
// The stub's moveBefore/moveAfter are the splice AE documents: moveBefore
// lands directly ABOVE the anchor (one index lower), moveAfter directly
// BELOW. Locked/shy carry no AE behaviour in this stub beyond the flags —
// the host refuses locked and notes shy before touching either.
const compR = new Comp("Relative", 10, 30);
Object.setPrototypeOf(compR, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
[["L1", 5], ["L2", 1], ["L3", 4], ["L4", 2], ["L5", 6], ["L6", 3]]
  .forEach(([n, st]) => compR._layers.push(new Layer(n, compR, 0, 8, st)));
project.activeItem = compR;
const stackR = () => compR._layers.map(l => l.name).join("|");

let rr = call("reorder_layers", { layer: "L2", below: "L5" });
assert(rr.ok, "below: moves one layer under the anchor: " + (rr.error || ""));
assert(stackR() === "L1|L3|L4|L5|L2|L6",
       "…and every other layer keeps its order (got " + stackR() + ")");
assert(rr.ok && rr.data.layer === "L2" && rr.data.movedTo === 5 &&
       rr.data.previousIndex === 2 && rr.data.below === "L5",
       "receipt: {layer, movedTo, previousIndex, below} (got " +
       JSON.stringify(rr.data) + ")");
assert(rr.ok && rr.data.by === undefined && rr.data.displaced === undefined &&
       rr.data.topToBottom === undefined,
       "a relative move never reports as a sort");
assert(rr.ok && /Only 'L2' moved/.test(rr.data.note),
       "the note says only the named layer moved: " + (rr.ok && rr.data.note));

rr = call("reorder_layers", { layer: "L2", above: "L3" });
assert(rr.ok && stackR() === "L1|L2|L3|L4|L5|L6" && rr.data.movedTo === 2 &&
       rr.data.previousIndex === 5 && rr.data.above === "L3",
       "above: lands directly on top of the anchor (got " + stackR() +
       ", " + JSON.stringify(rr.ok ? rr.data : rr.error) + ")");

rr = call("reorder_layers", { layer: "L6", toFront: true });
assert(rr.ok && stackR() === "L6|L1|L2|L3|L4|L5" && rr.data.movedTo === 1 &&
       rr.data.previousIndex === 6 && rr.data.toFront === true,
       "toFront: slot 1 (got " + stackR() + ")");
rr = call("reorder_layers", { layer: "L6", toBack: true });
assert(rr.ok && stackR() === "L1|L2|L3|L4|L5|L6" && rr.data.movedTo === 6 &&
       rr.data.previousIndex === 1 && rr.data.toBack === true,
       "toBack: last slot (got " + stackR() + ")");

// Already there: an honest no-op, not a claimed move.
rr = call("reorder_layers", { layer: "L1", toFront: true });
assert(rr.ok && rr.data.movedTo === 1 && rr.data.previousIndex === 1 &&
       /Nothing moved/.test(rr.data.note) && stackR() === "L1|L2|L3|L4|L5|L6",
       "toFront on the top layer says nothing moved: " +
       JSON.stringify(rr.ok ? rr.data : rr.error));
rr = call("reorder_layers", { layer: "L3", above: "L4" });
assert(rr.ok && rr.data.movedTo === 3 && rr.data.previousIndex === 3 &&
       /already above 'L4'/.test(rr.data.note),
       "above the layer it already sits above says so: " +
       JSON.stringify(rr.ok ? rr.data : rr.error));

// The refusals, each grounded.
rr = call("reorder_layers", { layer: "L2", above: "L2" });
assert(!rr.ok && /cannot be moved above itself/.test(rr.error) &&
       /Layers in 'Relative': L1, L2, L3/.test(rr.error),
       "relative to ITSELF is refused with the comp's layers: " + rr.error);
rr = call("reorder_layers", { layer: "L2", above: "L3", below: "L4" });
assert(!rr.ok && /ONE relative key/.test(rr.error) &&
       /above \+ below/.test(rr.error),
       "two relative keys are refused by name: " + rr.error);
rr = call("reorder_layers", { layer: "L2", above: "L3", by: "name" });
assert(!rr.ok && /cannot be combined/.test(rr.error) &&
       /'by: name'/.test(rr.error) && /drop 'by'/.test(rr.error),
       "a relative key plus 'by' is refused, naming both: " + rr.error);
rr = call("reorder_layers", { layers: ["L1", "L2"], above: "L3" });
assert(!rr.ok && /moves ONE layer/.test(rr.error) &&
       /\{layers, by/.test(rr.error),
       "{layers} with a relative key is refused, naming the sort form: " +
       rr.error);
rr = call("reorder_layers", { layer: "L2", above: "Logo" });
assert(!rr.ok && /Layer not found in 'Relative': Logo/.test(rr.error) &&
       /Actual layers: L1, L2, L3, L4, L5, L6/.test(rr.error),
       "a missing anchor lists the comp's real layers: " + rr.error);
// The wrong TYPE in a relative slot is a request nobody made: an anchor
// in toFront/toBack must not become "true", and a boolean in above/below
// must not reach comp.layer(true).
rr = call("reorder_layers", { layer: "L2", toFront: "L5" });
assert(!rr.ok && /'toFront' takes true, got 'L5'/.test(rr.error) &&
       /did you mean \{above: 'L5'\}/.test(rr.error),
       "an anchor name in toFront is refused, suggesting above: " + rr.error);
rr = call("reorder_layers", { layer: "L2", toBack: "L5" });
assert(!rr.ok && /'toBack' takes true, got 'L5'/.test(rr.error) &&
       /did you mean \{below: 'L5'\}/.test(rr.error),
       "an anchor name in toBack is refused, suggesting below: " + rr.error);
rr = call("reorder_layers", { layer: "L2", above: true });
assert(!rr.ok && /'above' names a layer to sit next to/.test(rr.error) &&
       /\{toFront: true\}/.test(rr.error),
       "a boolean in above is refused, suggesting toFront: " + rr.error);
rr = call("reorder_layers", { layer: "L2", below: true });
assert(!rr.ok && /'below' names a layer to sit next to/.test(rr.error) &&
       /\{toBack: true\}/.test(rr.error),
       "a boolean in below is refused, suggesting toBack: " + rr.error);
assert(stackR() === "L1|L2|L3|L4|L5|L6",
       "no refusal moved anything (got " + stackR() + ")");

// toFront:false is not a request — the call is still the sorter. (By
// name, descending, puts L1 on top: the stack is already in that order,
// so the sort proves the mode without disturbing the checks below.)
rr = call("reorder_layers", { by: "name", order: "descending",
                              toFront: false });
assert(rr.ok && rr.data.by === "name" && rr.data.movedTo === undefined &&
       stackR() === "L1|L2|L3|L4|L5|L6",
       "a false relative flag leaves the call in sort mode: " +
       JSON.stringify(rr.ok ? rr.data : rr.error) + " " + stackR());

// {layer} omitted = the user's selection, and the selection survives.
compR._layers.forEach(l => { l.selected = l.name === "L4"; });
rr = call("reorder_layers", { below: "L6" });
assert(rr.ok && rr.data.layer === "L4" && rr.data.movedTo === 6 &&
       stackR() === "L1|L2|L3|L5|L6|L4",
       "no {layer}: the selected layer moves (got " + stackR() + ", " +
       JSON.stringify(rr.ok ? rr.data : rr.error) + ")");
assert(compR.selectedLayers.length === 1 &&
       compR.selectedLayers[0].name === "L4",
       "…and stays selected afterwards");
compR._layers.forEach(l => { l.selected = l.name === "L1" || l.name === "L2"; });
rr = call("reorder_layers", { toFront: true });
assert(!rr.ok && /2 layers selected \(L1, L2\)/.test(rr.error),
       "two selected and no {layer} is refused, naming them: " + rr.error);
compR._layers.forEach(l => { l.selected = false; });

// Locked: refused before the primitive runs (AE's scripting behaviour on
// a locked layer is unmeasured — see the host comment).
compR.layer("L3").locked = true;
rr = call("reorder_layers", { layer: "L3", toBack: true });
assert(!rr.ok && /'L3' is LOCKED/.test(rr.error) && /padlock/.test(rr.error) &&
       stackR() === "L1|L2|L3|L5|L6|L4",
       "a locked layer is refused and untouched: " + rr.error);
compR.layer("L3").locked = false;
// Shy: moved, and the receipt says the timeline may be hiding it.
compR.layer("L5").shy = true;
rr = call("reorder_layers", { layer: "L5", toFront: true });
assert(rr.ok && rr.data.movedTo === 1 && /SHY/.test(rr.data.shyNote || ""),
       "a shy layer moves with a note: " +
       JSON.stringify(rr.ok ? rr.data : rr.error));

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
