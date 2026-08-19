// Regression test: bezier curve tools (stagger_layers, distribute_property,
// apply_keyframe_ease) against a stubbed AE object model.
"use strict";
const fs = require("fs");
const path = require("path");

function Prop(value) {
  this._value = value;
  this.expression = "";
  this.expressionError = "";
  this.canSetExpression = true;
  this.numKeys = 0;
  this._keyTimes = [];
  this._keyValues = [];
  this._eases = {};
}
Object.defineProperty(Prop.prototype, "value", { get() { return this._value; } });
Prop.prototype.setValue = function (v) { this._value = v; };
Prop.prototype.keyTime = function (i) { return this._keyTimes[i - 1]; };
Prop.prototype.keyValue = function (i) { return this._keyValues[i - 1]; };
Prop.prototype.setInterpolationTypeAtKey = function () {};
Prop.prototype.keyInTemporalEase = function (i) {
  return (this._eases[i] && this._eases[i].inE) || [new KeyframeEase(0, 16.7)];
};
Prop.prototype.keyOutTemporalEase = function (i) {
  return (this._eases[i] && this._eases[i].outE) || [new KeyframeEase(0, 16.7)];
};
Prop.prototype.setTemporalEaseAtKey = function (i, inE, outE) {
  this._eases[i] = { inE, outE };
};

function KeyframeEase(speed, influence) {
  this.speed = speed; this.influence = influence;
}
const KeyframeInterpolationType = { BEZIER: "bezier" };

function Layer(name, comp, inP) {
  this.name = name; this.comp = comp; this.selected = true;
  this.inPoint = inP; this.outPoint = inP + 1; this.startTime = 0;
  this._transform = {
    "ADBE Position": new Prop([100, 100]),
    "ADBE Scale": new Prop([100, 100]),
    "ADBE Rotate Z": new Prop(0),
    "ADBE Opacity": new Prop(100),
    "ADBE Anchor Point": new Prop([0, 0])
  };
}
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
Layer.prototype.property = function (name) {
  if (name === "ADBE Transform Group") {
    const t = this._transform;
    return { property(n) { return t[n]; } };
  }
  return null;
};

function Comp(name) { this.name = name; this._layers = []; this.time = 0; }
Comp.prototype.layer = function (ref) {
  const l = typeof ref === "number" ? this._layers[ref - 1]
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

const comp = new Comp("Curves");
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
for (let i = 0; i < 5; i++) comp._layers.push(new Layer("L" + (i + 1), comp, i));

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
function near(a, b, eps) { return Math.abs(a - b) < (eps || 0.02); }

// 1. linear bezier (handles on the diagonal) -> even stagger
let r = call("stagger_layers",
             { bezier: [0.25, 0.25, 0.75, 0.75], spread: 8, startAt: 0 });
assert(r.ok, "stagger succeeds: " + (r.error || ""));
let starts = comp._layers.map(l => l.startTime);
assert([0, 2, 4, 6, 8].every((v, i) => near(starts[i], v)),
       "linear curve -> even stagger [0,2,4,6,8] (got " +
       starts.map(s => s.toFixed(2)) + ")");

// 2. ease-out curve front-loads motion: middle layer lands late
r = call("stagger_layers", { bezier: [0, 0, 0.58, 1], spread: 8, startAt: 0 });
starts = comp._layers.map(l => l.startTime).sort((a, b) => a - b);
assert(r.ok && starts[2] > 4.8, "ease-out pushes middle landing past 60% " +
       "(mid=" + starts[2].toFixed(2) + ")");
let mono = true;
for (let i = 0; i < starts.length - 1; i++) if (starts[i + 1] <= starts[i]) mono = false;
assert(mono, "monotonic curve -> monotonic start times");

// 3. distribute opacity linearly across 3 explicit layers
r = call("distribute_property", {
  bezier: [0.25, 0.25, 0.75, 0.75], property: "opacity",
  layers: ["L1", "L2", "L3"], from: 0, to: 100, order: "stack"
});
assert(r.ok, "distribute_property succeeds: " + (r.error || ""));
const ops = ["L1", "L2", "L3"].map(n =>
  comp.layer(n)._transform["ADBE Opacity"].value);
assert(near(ops[0], 0) && near(ops[1], 50) && near(ops[2], 100),
       "opacity ramps 0/50/100 (got " + ops.map(o => o.toFixed(1)) + ")");

// 4. scale distributes uniformly as [v, v]
r = call("distribute_property", {
  bezier: [0.25, 0.25, 0.75, 0.75], property: "scale",
  layers: ["L1", "L2"], from: 50, to: 150, order: "stack"
});
const sc = comp.layer("L2")._transform["ADBE Scale"].value;
assert(r.ok && near(sc[0], 150) && near(sc[1], 150),
       "scale sets both axes uniformly");

// 5. keyframe ease conversion (ease-in-out on a 2-key opacity ramp)
const kprop = comp.layer("L1")._transform["ADBE Opacity"];
kprop.numKeys = 2;
kprop._keyTimes = [0, 2];
kprop._keyValues = [0, 100];
r = call("apply_keyframe_ease", {
  layer: "L1", property: "opacity", bezier: [0.42, 0, 0.58, 1]
});
assert(r.ok && r.data.easedPairs === 1, "ease applied to the key pair");
const e1 = kprop._eases[1], e2 = kprop._eases[2];
assert(e1 && near(e1.outE[0].influence, 42, 0.5) && near(e1.outE[0].speed, 0),
       "outgoing ease: influence 42, speed 0 (ease-in-out)");
assert(e2 && near(e2.inE[0].influence, 42, 0.5) && near(e2.inE[0].speed, 0),
       "incoming ease: influence 42, speed 0");

// 6. guards
comp._layers.forEach(l => { l.selected = false; });
comp._layers[0].selected = true;
r = call("stagger_layers", { bezier: [0, 0, 1, 1], spread: 5 });
assert(!r.ok && /at least 2 layers/.test(r.error),
       "single-layer selection refused with clear error");
r = call("stagger_layers", { bezier: [0, 0, 1, 1],
                             layers: ["L1", "L2"] });
assert(!r.ok && /'spread'/.test(r.error), "missing spread refused");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
