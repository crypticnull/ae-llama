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
Prop.prototype.setValue = function (v) {
  // Faithful to AE: setValue on a keyframed property throws.
  if (this.numKeys > 0) {
    throw new Error("Cannot set a value on a property with keyframes; " +
                    "use setValueAtTime or setValueAtKey instead.");
  }
  this._value = v;
};
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
    // faithful to AE: 2D scale is PADDED to 3 components via scripting
    "ADBE Scale": new Prop([100, 100, 100]),
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

// 5b. scale ease arrays must follow the PADDED scripting dims (3) — the
// field failure was "Value array does not have 3 elements"
const sprop = comp.layer("L2")._transform["ADBE Scale"];
sprop.numKeys = 2;
sprop._keyTimes = [0, 1];
sprop._keyValues = [[100, 100, 100], [150, 150, 100]];
r = call("apply_keyframe_ease", { layer: "L2", property: "scale",
                                  bezier: [0.42, 0, 0.58, 1] });
assert(r.ok && r.data.easedPairs === 1,
       "scale ease applies on a 2D layer: " + (r.error || ""));
assert(sprop._eases[1].outE.length === 3,
       "ease arrays carry 3 elements for padded scale (got " +
       sprop._eases[1].outE.length + ")");

// 5c. one apply_keyframe_ease call eases MANY layers
const o4 = comp.layer("L4")._transform["ADBE Opacity"];
const o5 = comp.layer("L5")._transform["ADBE Opacity"];
[o4, o5].forEach(p => {
  p.numKeys = 2; p._keyTimes = [0, 1]; p._keyValues = [0, 100];
});
r = call("apply_keyframe_ease", { layers: ["L4", "L5"],
  property: "opacity", bezier: [0.42, 0, 0.58, 1] });
assert(r.ok && r.data.layers === 2 && r.data.easedPairs === 2,
       "one call eases both layers (got " +
       (r.ok ? r.data.easedPairs : r.error) + ")");

// 6. guards
comp._layers.forEach(l => { l.selected = false; });
comp._layers[0].selected = true;
r = call("stagger_layers", { bezier: [0, 0, 1, 1], spread: 5 });
assert(!r.ok && /at least 2 layers/.test(r.error),
       "single-layer selection refused with clear error");
// no spread, no work area, no comp duration -> still a clear error
r = call("stagger_layers", { bezier: [0, 0, 1, 1],
                             layers: ["L1", "L2"] });
assert(!r.ok && /'spread'/.test(r.error),
       "no spread and no work area -> clear error");

// 7. omitted spread/startAt/bezier fill the comp's WORK AREA linearly
comp.workAreaStart = 2;
comp.workAreaDuration = 10;
r = call("stagger_layers", { layers: ["L1", "L2"] });
assert(r.ok && near(r.data.spread, 10) && near(r.data.startAt, 2),
       "bare stagger fills the work area (spread=" +
       (r.ok ? r.data.spread : r.error) + ", startAt=" +
       (r.ok ? r.data.startAt : "-") + ")");
assert(near(comp.layer("L1").startTime, 2) &&
       near(comp.layer("L2").startTime, 12),
       "layers span work area 2..12 with the default linear curve");

// 7b. equidistant step mode: "space them every 120px" in one call
comp.layer("L1")._transform["ADBE Position"].setValue([200, 540]);
r = call("distribute_property", {
  property: "position_x", step: 120, layers: ["L1", "L2", "L3"],
  order: "stack"
});
const xs = ["L1", "L2", "L3"].map(nm =>
  comp.layer(nm)._transform["ADBE Position"].value[0]);
assert(r.ok && near(xs[0], 200) && near(xs[1], 320) && near(xs[2], 440),
       "step 120 anchors at L1's x and spaces 200/320/440 (got " +
       xs.map(v => v.toFixed(0)) + ")");
r = call("distribute_property", {
  property: "position_x", step: 50, from: 0, layers: ["L1", "L2"],
  order: "stack"
});
assert(r.ok && near(comp.layer("L2")._transform["ADBE Position"].value[0], 50),
       "explicit from overrides the anchor in step mode");
r = call("distribute_property", {
  property: "position_x", layers: ["L1", "L2"], order: "stack"
});
assert(!r.ok && /'step'/.test(r.error),
       "missing from/to AND step -> clear error naming both modes");

// 8. scale_comp: resize + uniform content scale, re-centered (the field
// case: 3840x2860 -> 1920x1080)
comp.width = 3840; comp.height = 2860;
const lay = comp.layer("L1");
lay._transform["ADBE Position"].setValue([1920, 1430]); // old dead center
lay._transform["ADBE Scale"].setValue([100, 100]);
r = call("scale_comp", { width: 1920, height: 1080 });
const sFit = Math.min(1920 / 3840, 1080 / 2860);
assert(r.ok && near(r.data.scaleFactor, sFit, 1e-3),
       "fit mode picks the min ratio (" + sFit.toFixed(4) + "): " +
       (r.error || ""));
assert(comp.width === 1920 && comp.height === 1080, "comp canvas resized");
const pC = lay._transform["ADBE Position"].value;
assert(near(pC[0], 960) && near(pC[1], 540),
       "old comp center maps to new comp center (got " +
       pC.map(v => v.toFixed(1)) + ")");
const scC = lay._transform["ADBE Scale"].value;
assert(near(scC[0], 100 * sFit, 0.1) && near(scC[1], 100 * sFit, 0.1),
       "layer scale multiplied by the factor");

// fill mode crops instead of letterboxing
comp.width = 3840; comp.height = 2860;
lay._transform["ADBE Position"].setValue([1920, 1430]);
r = call("scale_comp", { width: 1920, height: 1080, mode: "fill" });
assert(r.ok && near(r.data.scaleFactor, 0.5, 1e-3),
       "fill mode picks the max ratio (0.5)");

// 9-11. Animated / driven properties. AE REFUSES setValue on a keyframed
// property and silently IGNORES it on an expression-driven one. Both
// used to surface as a raw AE throw or a false success; the tools must
// now say which it is, in words the model can act on.
const anim = comp.layer("L1");
anim._transform["ADBE Position"].numKeys = 2;
anim._transform["ADBE Position"]._keyTimes = [0, 1];
anim._transform["ADBE Position"]._keyValues = [[0, 0], [50, 50]];

r = call("set_transform", { layer: "L1", property: "position",
                            value: [10, 10] });
assert(!r.ok, "set_transform on an animated property refuses");
assert(/animated/i.test(r.error || "") && /2 keyframes/.test(r.error || "") &&
       /atTime/.test(r.error || ""),
       "…and the error names the count AND the way out (got: " +
       (r.error || "") + ")");

const driven = comp.layer("L2");
driven._transform["ADBE Opacity"].expressionEnabled = true;
r = call("set_transform", { layer: "L2", property: "opacity", value: 25 });
assert(r.ok && /expression/i.test((r.data && r.data.warning) || ""),
       "driven property: write succeeds but warns it is overridden (got: " +
       ((r.data && r.data.warning) || "") + ")");

// One un-writable layer must not abort the spread for the others.
r = call("distribute_property", {
  bezier: [0.25, 0.25, 0.75, 0.75], property: "position_x",
  layers: ["L1", "L3", "L4"], from: 0, to: 100, order: "stack"
});
assert(r.ok, "distribute continues past an unwritable layer (" +
       (r.error || "") + ")");
assert(Array.isArray(r.data.skipped) && r.data.skipped.length === 1 &&
       /L1/.test(r.data.skipped[0]),
       "…names the skipped layer (got " +
       JSON.stringify(r.data.skipped) + ")");
assert(r.data.applied.length === 2,
       "…and still applied the other two (got " +
       r.data.applied.length + ")");
assert(/1 of 3/.test(r.data.note || ""),
       "…and the note counts what was left out (got: " +
       (r.data.note || "") + ")");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
