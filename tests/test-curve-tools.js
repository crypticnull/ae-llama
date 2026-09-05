// Regression test: bezier curve tools (stagger_layers, distribute_property,
// apply_keyframe_ease) against a stubbed AE object model.
"use strict";
const fs = require("fs");
const path = require("path");

// AE's own enum values, so `p.propertyType === PropertyType.PROPERTY`
// means here what it means in the host.
const PropertyType = { PROPERTY: 6270, INDEXED_GROUP: 6271,
                       NAMED_GROUP: 6272 };

function Prop(value, matchName, name) {
  this._value = value;
  this.matchName = matchName || "";
  this.name = name || matchName || "";
  this.propertyType = PropertyType.PROPERTY;
  this.canSetExpression = true;
  this.expression = "";
  this.expressionError = "";
  this.numKeys = 0;
  this._keyTimes = [];
  this._keyValues = [];
  this._eases = {};
}
// Faithful to AE: assigning `.expression` is what enables/disables the
// expression — writing "" turns the rig OFF (the property shows its
// underlying value again), writing text turns it on. The stub used to
// keep `expression` as an inert string field, which would let host code
// "clear" a rig without changing what the property returns.
Object.defineProperty(Prop.prototype, "expression", {
  get() { return this._expr || ""; },
  set(s) {
    if (!this.canSetExpression) {
      throw new Error("This property cannot be set by expression.");
    }
    this._expr = String(s);
    this.expressionEnabled = this._expr !== "";
    if (!this.expressionEnabled) delete this._exprValue;
  }
});
// Faithful to AE: `.value` on an EXPRESSION-DRIVEN property is the
// expression's EVALUATED result, not the value underneath it. The stub
// used to hand back whatever was last written, which made an ignored
// write indistinguishable from a real one — and that is precisely the
// bug the field found (a grid_layout rig drove Position, distribute_property
// wrote nine x values AE accepted and discarded, and the tool reported
// them as applied). `_exprValue` is what the expression computes; set it
// to model a rig that ignores `value`, leave it undefined to model an
// expression that passes writes through (`value + wiggle(2, 30)`).
Object.defineProperty(Prop.prototype, "value", {
  get() {
    if (this.expressionEnabled && typeof this._exprValue !== "undefined") {
      return this._exprValue;
    }
    return this._value;
  }
});
Prop.prototype.setValue = function (v) {
  // Faithful to AE: setValue on a keyframed property throws.
  if (this.numKeys > 0) {
    throw new Error("Cannot set a value on a property with keyframes; " +
                    "use setValueAtTime or setValueAtKey instead.");
  }
  // Also faithful: AE ACCEPTS the write on a driven property. It just
  // never shows it.
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

// A property GROUP, reachable by match name AND by 1-based index — the
// index half is what a whole-layer walk uses, and the old stub had only
// the name half, so no stubbed run could see a walk at all.
function Group(name, matchName, kids) {
  this.name = name; this.matchName = matchName;
  this.propertyType = PropertyType.NAMED_GROUP;
  this._kids = kids || [];   // [[matchName, prop], ...]
}
Object.defineProperty(Group.prototype, "numProperties", {
  get() { return this._kids.length; }
});
Group.prototype.property = function (ref) {
  if (typeof ref === "number") {
    const k = this._kids[ref - 1];
    return k ? k[1] : null;
  }
  const hit = this._kids.find(k => k[0] === ref || k[1].name === ref);
  return hit ? hit[1] : null;
};
Group.prototype.push = function (matchName, prop) {
  this._kids.push([matchName, prop]);
  return prop;
};

function Layer(name, comp, inP) {
  this.name = name; this.comp = comp; this.selected = true;
  this.inPoint = inP; this.outPoint = inP + 1; this.startTime = 0;
  this._transform = {
    "ADBE Position": new Prop([100, 100], "ADBE Position", "Position"),
    // faithful to AE: 2D scale is PADDED to 3 components via scripting
    "ADBE Scale": new Prop([100, 100, 100], "ADBE Scale", "Scale"),
    "ADBE Rotate Z": new Prop(0, "ADBE Rotate Z", "Rotation"),
    "ADBE Opacity": new Prop(100, "ADBE Opacity", "Opacity"),
    "ADBE Anchor Point": new Prop([0, 0], "ADBE Anchor Point", "Anchor Point")
  };
  const xform = new Group("Transform", "ADBE Transform Group",
    Object.keys(this._transform).map(k => [k, this._transform[k]]));
  this._effects = new Group("Effects", "ADBE Effect Parade", []);
  this._masks = new Group("Masks", "ADBE Mask Parade", []);
  // Measured AE 26.3x87 (scripts/stagger-motion-probe.jsx): a layer's
  // ROOT property list starts with Marker and Time Remap, and BOTH are
  // LEAF properties — a marker reads numKeys > 0 and is not animation.
  this._marker = new Prop(null, "ADBE Marker", "Marker");
  this._timeRemap = new Prop(0, "ADBE Time Remapping", "Time Remap");
  this._root = new Group(name, "", [
    ["ADBE Marker", this._marker],
    ["ADBE Time Remapping", this._timeRemap],
    ["ADBE Mask Parade", this._masks],
    ["ADBE Effect Parade", this._effects],
    ["ADBE Transform Group", xform]
  ]);
  // Measured: a SOLID's source reports duration 0, a precomp's reports
  // its real length — that is what separates a still from something
  // that plays on its own.
  this.source = { name: name + " Solid", duration: 0 };
  this.hasAudio = false;
}
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
Object.defineProperty(Layer.prototype, "numProperties", {
  get() { return this._root.numProperties; }
});
Layer.prototype.property = function (ref) {
  return this._root.property(ref);
};

function Comp(name) {
  this.name = name; this._layers = []; this.time = 0;
  // Real comps have a frame grid, and stagger_layers measures its own
  // spacing against it — a stub without one cannot see a stagger that
  // lands every layer on the same frame.
  this.frameRate = 30; this.frameDuration = 1 / 30;
}
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

// 7a. stagger GAP mode. Field bug: "stagger them 4 frames apart" reached
// the tool as spread 0.133 across nine layers — spread is the TOTAL span,
// so that is half a frame each and every layer lands on the same frame —
// and the tool reported nine placements without a word. Frames are the
// unit designers speak in, so the tool takes them.
comp._layers.forEach(l => { l.selected = false; l.startTime = 0; });
r = call("stagger_layers",
         { layers: ["L1", "L2", "L3", "L4", "L5"], stepFrames: 4,
           startAt: 0 });
starts = ["L1", "L2", "L3", "L4", "L5"].map(nm => comp.layer(nm).startTime);
assert(r.ok && [0, 4, 8, 12, 16].every((f, i) =>
         near(starts[i], f / 30, 1e-6)),
       "stepFrames: 4 puts consecutive layers 4 frames apart (got " +
       starts.map(v => (v * 30).toFixed(2) + "f") + ")");
assert(r.ok && near(r.data.step, 0.133) && r.data.stepFrames === 4 &&
       near(r.data.spread, 0.533),
       "gap mode reports step, stepFrames and the TOTAL it works out to (" +
       JSON.stringify(r.ok ? [r.data.step, r.data.stepFrames, r.data.spread]
                           : r.error) + ")");

// step in seconds is the same door; a quoted number must not be dropped.
r = call("stagger_layers",
         { layers: ["L1", "L2", "L3"], step: "0.5", startAt: 1 });
assert(r.ok && near(comp.layer("L2").startTime, 1.5) &&
       near(comp.layer("L3").startTime, 2),
       "step accepts a quoted number and spaces layers by it (got " +
       ["L1", "L2", "L3"].map(nm => comp.layer(nm).startTime) + ")");

// The two units mean different things, so asking for both is a refusal
// that says which is which — not a silent pick.
r = call("stagger_layers",
         { layers: ["L1", "L2", "L3"], step: 0.5, spread: 4 });
assert(!r.ok && /TOTAL span/.test(r.error) && /BETWEEN/.test(r.error),
       "spread + step together is refused with both meanings spelled out: " +
       (r.error || "(accepted!)"));
r = call("stagger_layers",
         { layers: ["L1", "L2"], step: 0.5, stepFrames: 4 });
assert(!r.ok && /not both/.test(r.error),
       "step + stepFrames together is refused: " + (r.error || "(accepted!)"));

// The original bug, verbatim: spread that works out to under a frame per
// layer. The placement is honored (the caller may mean it) but the answer
// has to name the unit confusion and the argument that fixes it.
r = call("stagger_layers",
         { layers: ["L1", "L2", "L3", "L4", "L5"], spread: 0.133,
           startAt: 0 });
assert(r.ok && /TOTAL/.test(r.data.note || "") &&
       /step: 0\.133/.test(r.data.note || ""),
       "a sub-frame spread says spread is the TOTAL and names step: " +
       (r.ok ? (r.data.note || "(no note)") : r.error));
assert(r.ok && near(r.data.perLayer, 0.033) &&
       near(r.data.perLayerFrames, 1, 0.01),
       "curve mode reports the per-layer gap in seconds AND frames (" +
       (r.ok ? r.data.perLayer + "s / " + r.data.perLayerFrames + "f"
             : r.error) + ")");
// ...and a spread that is comfortably over a frame per layer says nothing.
r = call("stagger_layers",
         { layers: ["L1", "L2", "L3", "L4", "L5"], spread: 4, startAt: 0 });
assert(r.ok && !r.data.note,
       "a sane spread gets no scolding (note: " +
       (r.ok ? r.data.note : r.error) + ")");

// A bezier in gap mode is not silently obeyed or silently dropped.
r = call("stagger_layers",
         { layers: ["L1", "L2", "L3"], stepFrames: 6, startAt: 0,
           bezier: [0, 0, 0.58, 1] });
assert(r.ok && near(comp.layer("L2").startTime, 6 / 30) &&
       /bezier was not used/.test(r.data.note || ""),
       "gap mode stays evenly spaced and says the bezier went unused: " +
       (r.ok ? (r.data.note || "(no note)") : r.error));

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
driven._transform["ADBE Opacity"]._exprValue = 100;   // rig ignores `value`
r = call("set_transform", { layer: "L2", property: "opacity", value: 25 });
assert(r.ok && /expression/i.test((r.data && r.data.warning) || ""),
       "driven property: write succeeds but warns it is overridden (got: " +
       ((r.data && r.data.warning) || "") + ")");
assert(r.data.applied === false,
       "…and says applied:false, so a summary reader cannot read it as done");
assert(/100/.test(r.data.warning) && /25/.test(r.data.warning),
       "…and quotes what the comp really shows vs what was asked (got: " +
       r.data.warning + ")");

// The other half of the same coin: an expression that CONSUMES the value
// (`value + wiggle(…)`) really does move when you write to it, so warning
// about it would be a false alarm. Only the read-back can tell them apart.
const passthru = comp.layer("L3");
passthru._transform["ADBE Opacity"].expressionEnabled = true;
r = call("set_transform", { layer: "L3", property: "opacity", value: 25 });
assert(r.ok && !(r.data && r.data.warning),
       "a pass-through expression is NOT warned about (got: " +
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

// 11b. The field case, from a real chat transcript: "add nine squares in a
// 3x3 grid" (grid_layout rigs Position to an expression), then "spread them
// equally across the width". AE accepted all nine writes and showed none of
// them, and the tool answered with nine `applied` rows of values that were
// not in the comp — the summary a model (or a user skimming) reads first.
// A driven-and-ignored layer belongs with the ones that did not move.
const rigged = ["L3", "L4", "L5"];
for (const n of rigged) {
  const p = comp.layer(n)._transform["ADBE Position"];
  p.expressionEnabled = true;
  p._exprValue = [940, 500];      // what the grid rig computes, always
}
r = call("distribute_property", {
  property: "position_x", layers: rigged, from: 200, to: 1720, step: 180,
  order: "stack"
});
assert(r.ok, "distribute over a rigged grid still answers (" +
       (r.error || "") + ")");
assert(r.data.applied.length === 0,
       "…and claims NOTHING was applied, because nothing moved (got " +
       JSON.stringify(r.data.applied) + ")");
assert(Array.isArray(r.data.overriddenByExpression) &&
       r.data.overriddenByExpression.length === 3,
       "…it lists the three layers the expression overrode (got " +
       JSON.stringify(r.data.overriddenByExpression) + ")");
assert(/3 of 3/.test(r.data.note || "") &&
       /expression/i.test(r.data.note || "") &&
       /clearExpressions/.test(r.data.note || ""),
       "…and the note counts them and names the deterministic way out " +
       "(got: " + (r.data.note || "") + ")");
// The honest answer also has to FIT: the panel caps each tool result at
// 1200 chars, and the version that failed in the field spent 1600 of them
// on nine repeated warning sentences, so the truth was what got cut.
assert(JSON.stringify(r.data).length < 1200,
       "…and the whole result still fits the panel's 1200-char cap (got " +
       JSON.stringify(r.data).length + ")");

// 11c. The other half of the contract: WITHOUT the flag nothing was
// touched — the escalation is a deliberate re-call, never a side effect.
for (const n of rigged) {
  assert(comp.layer(n)._transform["ADBE Position"].expressionEnabled === true,
         n + "'s rig must survive a call that did not ask to clear it");
}

// 11d. The user said "spread them across the width" and MEANT it — the
// explicit request outranks the panel's own rig. The re-call with
// clearExpressions: true removes exactly the expressions that swallowed
// the write, applies the values for real, and says which rigs are gone.
r = call("distribute_property", {
  property: "position_x", layers: rigged, from: 200, to: 1720, step: 180,
  order: "stack", clearExpressions: true
});
assert(r.ok, "clearExpressions re-call answers (" + (r.error || "") + ")");
assert(r.data.applied.length === 3 && !r.data.overriddenByExpression,
       "…all three layers move once the rigs are cleared (got " +
       JSON.stringify(r.data) + ")");
assert(Array.isArray(r.data.expressionsCleared) &&
       r.data.expressionsCleared.slice().sort().join(",") ===
       rigged.slice().sort().join(","),
       "…and expressionsCleared names exactly the rigged layers (got " +
       JSON.stringify(r.data.expressionsCleared) + ")");
assert(/tell the user/i.test(r.data.note || ""),
       "…and the note tells the model to report the removed rigs (got: " +
       (r.data.note || "") + ")");
for (const n of rigged) {
  const p = comp.layer(n)._transform["ADBE Position"];
  assert(p.expressionEnabled === false && p.expression === "",
         n + "'s rig is really gone after clearExpressions");
}
// The values must be IN the comp, not just in the report: match each
// applied row back to the layer's actual x.
for (const row of r.data.applied) {
  const p = comp.layer(row.layer)._transform["ADBE Position"];
  assert(Math.abs(p.value[0] - row.value) < 0.01,
         row.layer + " reports x=" + row.value + " but the comp shows " +
         p.value[0]);
}

// 11e. A PASS-THROUGH expression (`value + …`) never swallowed anything,
// so clearExpressions must leave it alone — surgical, not a purge.
const keeper = comp.layer("L3")._transform["ADBE Position"];
keeper.expression = "value + [0, 0]";     // enabled, passes writes through
r = call("distribute_property", {
  property: "position_x", layers: rigged, from: 200, step: 180,
  clearExpressions: true
});
assert(r.ok && r.data.applied.length === 3 && !r.data.expressionsCleared,
       "a pass-through expression is not cleared (got " +
       JSON.stringify(r.data) + ")");
assert(keeper.expressionEnabled === true,
       "L3's pass-through expression survived clearExpressions");
keeper.expression = "";

// 11f. The note has to say WHICH layers to re-send, because the obvious
// reading of "these 8 did not move" is "retry those 8" — and that is
// exactly what the model did in the field on 2026-08-26. Nine squares on
// a grid rig: one was not driven and landed at 960, the other eight were
// reported as overridden, the model re-called with only those eight, and
// from/to 200..1720 was then divided across EIGHT — 217px gaps with the
// ninth square stranded at 960. Every tool call in that round succeeded.
// So the fix is the wording of the way out, and this pins it.
{
  // Nine FRESH layers: the L1..L5 the other cases share carry keyframes
  // by now, and a keyframed layer lands in `skipped`, not in the
  // overridden list this case is about.
  const all = [];
  for (let i = 0; i < 9; i++) {
    const nm = "N" + (i + 1);
    comp._layers.push(new Layer(nm, comp, comp._layers.length));
    all.push(nm);
  }
  const eight = all.slice(0, 8);
  for (const n of eight) {
    const p = comp.layer(n)._transform["ADBE Position"];
    p.expressionEnabled = true;
    p._exprValue = [940, 500];
  }
  const rr = call("distribute_property", {
    property: "position_x", layers: all, from: 200, to: 1720
  });
  assert(rr.ok, "the nine-square shape answers (" + (rr.error || "") + ")");
  assert(rr.data.overriddenByExpression.length === 8 &&
         rr.data.applied.length === 1,
         "…eight blocked, one landed (got " + JSON.stringify(rr.data.applied) +
         ")");
  const note = rr.data.note || "";
  assert(/SAME 9 layer\(s\)/.test(note),
         "…and the note asks for the SAME 9 layers on the re-call, not " +
         "the 8 it just named (got: " + note + ")");
  assert(/strands the rest/.test(note),
         "…and says what re-calling with only those 8 would do (got: " +
         note + ")");
  assert(JSON.stringify(rr.data).length < 1200,
         "…while still fitting the panel's 1200-char cap (got " +
         JSON.stringify(rr.data).length + ")");
  comp._layers.length = 5;          // hand the comp back as it was found
}

// 12. An explicit 'layers' list is an ORDER, not a set. The tool used to
// re-sort it by inPoint, so a grid whose layers all sit at inPoint 0 got
// its values handed out in whatever order the sort felt like. Measured in
// AE 2026 on five solids all at inPoint 0: the SAME call produced
// P2,P3,P4,P5,P1 once and P4,P3,P2,P1,P5 with the list reversed - neither
// the caller's order nor the stack's, and not repeatable.
//
// Node's Array.sort is STABLE, so that scramble cannot reproduce by
// running the code. This shim makes the host's sort behave the way
// ExtendScript's actually does - a legal permutation before sorting,
// which disturbs TIED keys only.
function withUnstableSort(fn) {
  const real = Array.prototype.sort;
  Array.prototype.sort = function (cmp) {
    this.reverse();
    return real.call(this, cmp);
  };
  try { return fn(); } finally { Array.prototype.sort = real; }
}

const flat = [];
for (let i = 0; i < 5; i++) {
  const f = new Layer("F" + (i + 1), comp, 0);   // every inPoint tied at 0
  f.selected = false;
  comp._layers.push(f);
  flat.push(f);
}
const fx = () => ["F1", "F2", "F3", "F4", "F5"].map(n =>
  comp.layer(n)._transform["ADBE Position"].value[0]);

r = withUnstableSort(() => call("distribute_property", {
  property: "position_x", from: 100, step: 100,
  layers: ["F1", "F2", "F3", "F4", "F5"]
}));
assert(r.ok && [100, 200, 300, 400, 500].every((v, i) => near(fx()[i], v)),
       "step mode honors the caller's layer order when inPoints all tie " +
       "(got " + fx() + ")");

r = withUnstableSort(() => call("distribute_property", {
  property: "position_x", from: 100, step: 100,
  layers: ["F5", "F4", "F3", "F2", "F1"]
}));
assert(r.ok && [500, 400, 300, 200, 100].every((v, i) => near(fx()[i], v)),
       "...and reversing the list reverses the spread (got " + fx() + ")");
assert(r.data.applied.map(a => a.layer).join("|") === "F5|F4|F3|F2|F1",
       "...and 'applied' reports the order the values actually went out " +
       "in (got " + r.data.applied.map(a => a.layer).join("|") + ")");

// An explicit 'order' still overrides the list order - that is what it is for.
r = withUnstableSort(() => call("distribute_property", {
  property: "position_x", from: 100, step: 100, order: "stack",
  layers: ["F5", "F4", "F3", "F2", "F1"]
}));
assert(r.ok && [100, 200, 300, 400, 500].every((v, i) => near(fx()[i], v)),
       "order:'stack' re-sorts a reversed list back to stack order (got " +
       fx() + ")");

// Same rule for stagger_layers: the list is the sequence.
r = withUnstableSort(() => call("stagger_layers", {
  layers: ["F5", "F4", "F3", "F2", "F1"], spread: 4, startAt: 0
}));
const fst = ["F1", "F2", "F3", "F4", "F5"].map(n => comp.layer(n).startTime);
assert(r.ok && [4, 3, 2, 1, 0].every((v, i) => near(fst[i], v)),
       "stagger_layers honors the caller's layer order too (got " +
       fst.map(v => v.toFixed(1)) + ")");

// Selection-based targeting has no caller order, so it still sorts - and
// must do it without leaning on a stable sort.
flat.forEach((f, i) => { f.selected = true; f.inPoint = 4 - i; });
comp._layers.forEach(l => { if (flat.indexOf(l) === -1) l.selected = false; });
r = withUnstableSort(() => call("distribute_property", {
  property: "rotation", from: 0, step: 10
}));
const rots = ["F1", "F2", "F3", "F4", "F5"].map(n =>
  comp.layer(n)._transform["ADBE Rotate Z"].value);
assert(r.ok && [40, 30, 20, 10, 0].every((v, i) => near(rots[i], v)),
       "selection default still sorts by inPoint (got " + rots + ")");


// ------------------------------------- a refusal a model can act on
//
// Measured 2026-09-02, real AE + the real 32B, --variants on the "smooth
// a mechanical fade" row. Two of four phrasings failed and NEITHER was a
// routing miss - both were REFUSALS whose words were the defect:
//
//   canonical  "make it feel smoother" -> apply_keyframe_ease with no
//              'layers' and nothing selected. The old refusal said
//              "select layers in AE or pass {layer} / {layers}" and named
//              nothing that exists, so the model relayed it to the user
//              ("please select the square layers") and stopped. Right
//              tool, no work done. A caller that cannot click has only
//              names to work with, and the comp knows them.
//
//   vague      "the squares' entrance feels cheap, fix it" -> the model
//              tried distribute_property on already-animated opacity.
//              The old refusal ADVISED "delete the existing keyframes
//              first"; the model obeyed, ran remove_keyframes over 18
//              keys and wrote static values. The tool's own advice was
//              the harm vector - the same shape as clean_project's
//              ungated preview advice.
comp._layers.forEach(l => { l.selected = false; });
const eKp = comp.layer("L1")._transform["ADBE Opacity"];
eKp.numKeys = 2; eKp._keyTimes = [0, 2]; eKp._keyValues = [0, 100];
r = call("apply_keyframe_ease",
         { property: "opacity", bezier: [0.42, 0, 0.58, 1] });
assert(!r.ok, "no layers and no selection is still a refusal");
assert(/Layers here:/.test(r.error) && /L1/.test(r.error) && /L2/.test(r.error),
       "...and it NAMES the comp's layers (" + r.error + ")");
assert(/With opacity keyframes: L1/.test(r.error),
       "...and which of them have keys on the property that was asked for");
assert(/by NAME/.test(r.error) && !/select layers in AE/.test(r.error),
       "...and does not send a caller that cannot click back to AE's UI");

// The same refusal without a property still grounds itself in layer names
// (set_layer_parent's path - it has no 'property' at all).
r = call("set_layer_parent", { parent: "L1" });
assert(!r.ok && /Layers here:/.test(r.error) && !/ keyframes: /.test(r.error),
       "a property-less caller gets the layer list and no empty key list (" +
       r.error + ")");

// A keyframed property still refuses a plain value. The question the field
// answered is what it tells the caller to do NEXT.
const aKp = comp.layer("L2")._transform["ADBE Opacity"];
aKp.numKeys = 2; aKp._keyTimes = [0, 2]; aKp._keyValues = [0, 100];
r = call("distribute_property",
         { property: "opacity", layers: ["L2", "L3"], from: 0, to: 100 });
const skipped = (r.ok ? (r.data.skipped || []) : [r.error]).join(" ");
assert(/is animated \(2 keyframes\)/.test(skipped),
       "an animated property still refuses a single value (" + skipped + ")");
assert(/apply_keyframe_ease/.test(skipped) && /set_keyframes/.test(skipped),
       "...and points at the tools that change HOW it animates");
assert(!/delete the existing keyframes first/.test(skipped) &&
       !/delete the keyframes first/.test(skipped),
       "...and never advises deleting the user's animation as the fix");
assert(/remove_keyframes THROWS THE ANIMATION AWAY/.test(skipped),
       "...and says outright what remove_keyframes would cost");

// The third refusal of the same class, found by the same run: with the
// routing fixed, "the squares' entrance feels cheap" reached
// apply_keyframe_ease, GUESSED 'position' (the sentence names no
// property), was told position has 0 keyframes - and asked the user to go
// add some. The opacity keys it was sent to smooth were on the same layer.
comp.layer("L2")._transform["ADBE Position"].numKeys = 0;
r = call("apply_keyframe_ease",
         { layers: ["L2"], property: "position", bezier: [0.42, 0, 0.58, 1] });
assert(!r.ok && /position has 0 keyframe/.test(r.error),
       "easing an unkeyed property is still a refusal (" + r.error + ")");
assert(/Keyframed on this layer: [^"]*opacity \(2 keys\)/.test(r.error),
       "...and it names the property that DOES carry the animation");
assert(/ease one of those instead/.test(r.error),
       "...and says what to do with that");
// A layer with nothing keyframed gets the other half of the answer, not an
// empty list dressed up as one.
r = call("apply_keyframe_ease",
         { layers: ["L3"], property: "position", bezier: [0.42, 0, 0.58, 1] });
assert(!r.ok && /Nothing on this layer is keyframed/.test(r.error) &&
       /set_keyframes first/.test(r.error),
       "an unanimated layer is told there is nothing to ease yet (" +
       r.error + ")");

// 7c. A stagger on layers with NOTHING on them. Field run 2026-09-03,
// row 32: three of four phrasings called stagger_layers ALONE, it moved
// six start times and answered ok {layers:6, spread:2.5, placed:[…]} —
// and nothing faded, because there were no keyframes to stagger. A
// success receipt for a comp where nothing animates.
//
// Runs LAST and starts from clean: every section above leaves keyframes
// and rigs on these layers, and the subject here is a comp with none.
comp._layers.forEach(l => {
  Object.keys(l._transform).forEach(k => {
    const p = l._transform[k];
    p.numKeys = 0; p._keyTimes = []; p._keyValues = []; p._eases = {};
    if (p.expressionEnabled) p.expression = "";
  });
  l._marker.numKeys = 0;
  l._timeRemap.numKeys = 0;
  l._effects._kids.length = 0;
  l._masks._kids.length = 0;
  l.startTime = 0;
  l.source = { name: l.name + " Solid", duration: 0 };
});
const staggerFive = { layers: ["L1", "L2", "L3", "L4", "L5"], spread: 4,
                      startAt: 0 };

// STUB FIDELITY, measured AE 26.3x87 (scripts/stagger-motion-probe.jsx):
// a layer's ROOT property 1 is Marker and it is a LEAF. The old stub had
// no root list at all — `property()` answered by name only — so no
// stubbed run could see a whole-layer walk, which is why this class was
// invisible here.
const rootOne = comp.layer("L1").property(1);
assert(rootOne && rootOne.matchName === "ADBE Marker" &&
       rootOne.propertyType === PropertyType.PROPERTY,
       "stub fidelity: root property 1 is Marker, and it is a LEAF");
assert(comp.layer("L1").property("ADBE Transform Group").numProperties === 5,
       "stub fidelity: a group answers by INDEX as well as by name");

r = call("stagger_layers", staggerFive);
assert(r.ok &&
       /nothing on these 5 layers varies over time/.test(r.data.warning || ""),
       "staggering layers with no animation warns the stagger is " +
       "invisible: " + (r.ok ? (r.data.warning || "(NO WARNING)") : r.error));
assert(r.ok && /set_keyframes/.test(r.data.warning || "") &&
       /relativeTo/.test(r.data.warning || ""),
       "...and names the tool that adds the animation and the argument " +
       "that keeps these offsets");

// A MARKER is not animation. It reads numKeys > 0 in real AE, so a walk
// that counted it would fall silent on exactly the layers this is for.
comp._layers.forEach(l => { l._marker.numKeys = 1; });
r = call("stagger_layers", staggerFive);
assert(r.ok && /varies over time/.test(r.data.warning || ""),
       "a marker on every layer does NOT count as animation");
comp._layers.forEach(l => { l._marker.numKeys = 0; });

// One keyframe anywhere and it goes quiet: the warning speaks only when
// EVERY target is static.
const kOpa = comp.layer("L3")._transform["ADBE Opacity"];
kOpa.numKeys = 2; kOpa._keyTimes = [0, 1]; kOpa._keyValues = [0, 100];
r = call("stagger_layers", staggerFive);
assert(r.ok && !r.data.warning,
       "one keyframed layer among five silences the warning (got: " +
       (r.ok ? r.data.warning : r.error) + ")");
kOpa.numKeys = 0; kOpa._keyTimes = []; kOpa._keyValues = [];

// ...and the keyframe is found however deep it sits. An effect param is
// three levels below the layer root, past groups the old stub could not
// even enumerate.
const blurFx = new Group("Gaussian Blur", "ADBE Gaussian Blur 2", []);
const blurriness = blurFx.push("ADBE Gaussian Blur 2-0001",
  new Prop(0, "ADBE Gaussian Blur 2-0001", "Blurriness"));
comp.layer("L2")._effects.push("ADBE Gaussian Blur 2", blurFx);
blurriness.numKeys = 2;
r = call("stagger_layers", staggerFive);
assert(r.ok && !r.data.warning,
       "a keyframe on an EFFECT parameter counts as animation");

// An effect with NO keys silences it too: some effects animate on their
// own at zero keyframes (CC Particle World, Radio Waves), so an effect
// is doubt — and a warning that says nothing animates has to be right.
blurriness.numKeys = 0;
r = call("stagger_layers", staggerFive);
assert(r.ok && !r.data.warning,
       "an unkeyed EFFECT is doubt enough to stay quiet");
comp.layer("L2")._effects._kids.length = 0;

// An expression is doubt for the same reason: it may be reading a
// keyframed slider on another layer, which no walk of THIS layer sees.
comp.layer("L4")._transform["ADBE Position"].expression =
  "thisComp.layer(\"CTRL\").effect(\"Spacing X\")(1)";
r = call("stagger_layers", staggerFive);
assert(r.ok && !r.data.warning,
       "an expression anywhere is doubt enough to stay quiet");
comp.layer("L4")._transform["ADBE Position"].expression = "";

// A source that PLAYS is motion without a single keyframe. Measured: a
// solid's source reports duration 0 where a precomp's reports 4.
comp.layer("L5").source = { name: "Sub", duration: 4 };
r = call("stagger_layers", staggerFive);
assert(r.ok && !r.data.warning,
       "a moving source (precomp or clip) counts as animation");
comp.layer("L5").source = { name: "L5 Solid", duration: 0 };

// Time Remap is a root LEAF exactly like Marker — and unlike Marker its
// keys ARE animation, so the two cannot be handled by position.
comp.layer("L1")._timeRemap.numKeys = 2;
r = call("stagger_layers", staggerFive);
assert(r.ok && !r.data.warning, "Time Remap keys count as animation");
comp.layer("L1")._timeRemap.numKeys = 0;

// The walk is budgeted (measured 162 nodes for a bare solid at 0.008 ms
// each), and a budget that runs out is UNPROVED — not proof of nothing.
const fatGroup = new Group("Fat", "ADBE Fat", []);
for (let i = 0; i < 21000; i++) {
  fatGroup.push("ADBE Fat-" + i, new Prop(0, "ADBE Fat-" + i, "F" + i));
}
comp.layer("L1")._root.push("ADBE Fat", fatGroup);
r = call("stagger_layers", staggerFive);
assert(r.ok && !r.data.warning,
       "an exhausted scan budget says nothing rather than guessing");
comp.layer("L1")._root._kids.pop();

// ...and with every fixture removed the warning comes back, so none of
// the silences above passed by accident.
r = call("stagger_layers", staggerFive);
assert(r.ok && /varies over time/.test(r.data.warning || ""),
       "the warning returns once the fixtures are taken away");
comp._layers.forEach(l => { l.startTime = 0; });


console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
