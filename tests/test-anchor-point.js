// Regression test: center_anchor_point against a stub that models the AE
// behaviors the older stubs did not.
//
// This tool shipped with ZERO stubbed coverage, which is how it kept a
// real bug: it wrote Position with setValue(), and real AE THROWS on
// setValue() for a property that has keyframes. Every animated layer --
// the normal case for this panel -- hit a raw AE error.
//
// Two fidelity rules this stub enforces that the others do not:
//   1. setValue() throws when numKeys > 0, exactly like AE.
//   2. 2D Position/Anchor/Scale values are PADDED to 3 components, so
//      `value.length > 2` is true for 2D layers here as it is in AE.
//      (CLAUDE.md: 3D-ness comes from threeDLayer, never from length.)
"use strict";
const fs = require("fs");
const path = require("path");

function Prop(value) {
  this._value = value;
  this.expression = "";
  this.expressionError = "";
  this.expressionEnabled = false;
  this.canSetExpression = true;
  this.numKeys = 0;
  this._keyTimes = [];
  this._keyValues = [];
  this.setValueCalls = 0;
}
Object.defineProperty(Prop.prototype, "value", {
  get() {
    return this.numKeys > 0 ? this._keyValues[0] : this._value;
  }
});
Prop.prototype.setValue = function (v) {
  // Faithful to AE: a keyframed property rejects setValue outright.
  if (this.numKeys > 0) {
    throw new Error("Cannot set a value on a property with keyframes; " +
                    "use setValueAtTime or setValueAtKey instead.");
  }
  this.setValueCalls++;
  this._value = v;
};
Prop.prototype.keyTime = function (i) { return this._keyTimes[i - 1]; };
// AE reads an animated property through valueAtTime(t, preExpression).
// Held outside the key range, linearly interpolated between keys -- the
// in-between shape is an approximation, but AT a key time it returns that
// key's value exactly, which is all the assertions below rely on.
Prop.prototype.valueAtTime = function (t, preExpression) {
  if (this.numKeys === 0) return this._value;
  const ts = this._keyTimes, vs = this._keyValues;
  if (t <= ts[0]) return vs[0];
  if (t >= ts[this.numKeys - 1]) return vs[this.numKeys - 1];
  let i = 0;
  while (i < this.numKeys - 2 && ts[i + 1] < t) i++;
  const f = (t - ts[i]) / (ts[i + 1] - ts[i]);
  const a = vs[i], b = vs[i + 1];
  if (typeof a === "number") return a + (b - a) * f;
  return a.map((av, j) => av + (b[j] - av) * f);
};
Prop.prototype.keyValue = function (i) { return this._keyValues[i - 1]; };
Prop.prototype.setValueAtKey = function (i, v) { this._keyValues[i - 1] = v; };
Prop.prototype.setValueAtTime = function (t, v) {
  this._keyTimes.push(t); this._keyValues.push(v); this.numKeys++;
};
Prop.prototype.setInterpolationTypeAtKey = function () {};

function Layer(name, comp) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.threeDLayer = false;
  this.parent = null;
  this.inPoint = 0;
  this.outPoint = 5;
  this.startTime = 0;
  this._rect = { left: 0, top: 0, width: 100, height: 100 };
  this._transform = {
    // PADDED, as the scripting API reports them for 2D layers.
    "ADBE Position": new Prop([100, 100, 0]),
    "ADBE Scale": new Prop([100, 100, 100]),
    "ADBE Rotate Z": new Prop(0),
    "ADBE Opacity": new Prop(100),
    "ADBE Anchor Point": new Prop([0, 0, 0])
  };
}
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
// Faithful to AE 2026 (measured 2026-08-29): the call needs BOTH
// arguments, and the time it takes is the layer's own source time, not
// comp time. This stub only has one rect, but it records what it was
// asked for so a caller that hands over comp time is caught -- see
// tests/test-get-bounds.js for the rect-over-time version.
Layer.prototype.sourceRectAtTime = function (t, extents) {
  if (arguments.length < 2) {
    throw new Error("After Effects error: Unable to call " +
                    "sourceRectAtTime because the call requires 2 " +
                    "parameters.");
  }
  this.rectCalls = this.rectCalls || [];
  this.rectCalls.push(t);
  return this._rect;
};
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
const KeyframeInterpolationType = { BEZIER: "bezier" };
function KeyframeEase(speed, influence) {
  this.speed = speed; this.influence = influence;
}

const comp = new Comp("Anchors");
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));

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
function near(a, b, eps) { return Math.abs(a - b) < (eps || 0.001); }
function fresh(name) {
  const l = new Layer(name, comp);
  comp._layers.push(l);
  return l;
}
const T = l => l._transform;

// 1. Plain 2D layer: anchor moves to content centre, position compensates
//    by exactly the same delta so nothing appears to move.
let L = fresh("plain");
let r = call("center_anchor_point", { layer: "plain" });
assert(r.ok, "plain: succeeds (" + (r.error || "") + ")");
assert(near(T(L)["ADBE Anchor Point"].value[0], 50) &&
       near(T(L)["ADBE Anchor Point"].value[1], 50),
       "plain: anchor centred on content -> [50,50]");
assert(near(T(L)["ADBE Position"].value[0], 150) &&
       near(T(L)["ADBE Position"].value[1], 150),
       "plain: position compensated -> [150,150] (got " +
       T(L)["ADBE Position"].value + ")");
assert(T(L)["ADBE Anchor Point"].value.length === 3,
       "plain: padded 3-component value written back, as AE expects");

// 2. Rotation must rotate the compensation delta, not just translate it.
//    90 degrees turns a (+50,+50) layer-space shift into (-50,+50).
L = fresh("rotated");
T(L)["ADBE Rotate Z"]._value = 90;
r = call("center_anchor_point", { layer: "rotated" });
assert(r.ok && near(T(L)["ADBE Position"].value[0], 50) &&
       near(T(L)["ADBE Position"].value[1], 150),
       "rotated 90deg: compensation rotates -> [50,150] (got " +
       T(L)["ADBE Position"].value + ")");

// 3. Scale multiplies the delta: 200% turns (+50,+50) into (+100,+100).
L = fresh("scaled");
T(L)["ADBE Scale"]._value = [200, 200, 100];
r = call("center_anchor_point", { layer: "scaled" });
assert(r.ok && near(T(L)["ADBE Position"].value[0], 200) &&
       near(T(L)["ADBE Position"].value[1], 200),
       "scaled 200%: compensation scales -> [200,200] (got " +
       T(L)["ADBE Position"].value + ")");

// 4. Rotation AND scale compose, in that order (scale first, then rotate).
L = fresh("both");
T(L)["ADBE Scale"]._value = [200, 200, 100];
T(L)["ADBE Rotate Z"]._value = 90;
r = call("center_anchor_point", { layer: "both" });
assert(r.ok && near(T(L)["ADBE Position"].value[0], 0) &&
       near(T(L)["ADBE Position"].value[1], 200),
       "scaled+rotated: composes -> [0,200] (got " +
       T(L)["ADBE Position"].value + ")");

// 5. THE BUG. An animated Position cannot take setValue -- AE throws.
//    Every key must shift by the delta so the whole animation moves with
//    the anchor instead of one time being right and the rest wrong.
L = fresh("animated");
const posA = T(L)["ADBE Position"];
posA.numKeys = 2;
posA._keyTimes = [0, 1];
posA._keyValues = [[0, 0, 0], [100, 100, 0]];
r = call("center_anchor_point", { layer: "animated" });
assert(r.ok, "animated: succeeds instead of throwing AE's setValue error (" +
       (r.error || "") + ")");
assert(near(posA._keyValues[0][0], 50) && near(posA._keyValues[0][1], 50) &&
       near(posA._keyValues[1][0], 150) && near(posA._keyValues[1][1], 150),
       "animated: EVERY position key offset by the delta (got " +
       JSON.stringify(posA._keyValues) + ")");
assert(posA.setValueCalls === 0,
       "animated: never calls setValue on a keyframed property");
assert(/keyframes? offset/.test((r.data && r.data.note) || ""),
       "animated: note says the keys were offset (got: " + ((r.data && r.data.note) || "") + ")");

// 6. An animated ANCHOR has no single value to centre. Grounded error,
//    naming the count, rather than AE's raw throw.
L = fresh("animAnchor");
const apB = T(L)["ADBE Anchor Point"];
apB.numKeys = 3;
apB._keyTimes = [0, 1, 2];
apB._keyValues = [[0, 0, 0], [10, 10, 0], [20, 20, 0]];
r = call("center_anchor_point", { layer: "animAnchor" });
assert(!r.ok, "animated anchor: refuses rather than throwing");
assert(/animated/i.test(r.error || "") && /3/.test(r.error || ""),
       "animated anchor: error names the keyframe count (got: " +
       (r.error || "") + ")");
assert(near(T(L)["ADBE Position"].value[0], 100),
       "animated anchor: position left untouched by the refusal");

// 7. A driven Position accepts the write but never shows it. Say so.
L = fresh("driven");
T(L)["ADBE Position"].expressionEnabled = true;
r = call("center_anchor_point", { layer: "driven" });
assert(r.ok && /WARNING/.test((r.data && r.data.note) || "") &&
       /expression/i.test((r.data && r.data.note) || ""),
       "expression-driven position: warns the compensation is overridden " +
       "(got: " + ((r.data && r.data.note) || "") + ")");

// 8. Opting out leaves position alone.
L = fresh("noPreserve");
r = call("center_anchor_point",
         { layer: "noPreserve", preservePosition: false });
assert(r.ok && near(T(L)["ADBE Position"].value[0], 100) &&
       near(T(L)["ADBE Position"].value[1], 100),
       "preservePosition:false leaves position at [100,100]");

// 9. 3D layers are documented as uncompensated; the note must say so
//    rather than silently doing nothing.
L = fresh("threeD");
L.threeDLayer = true;
r = call("center_anchor_point", { layer: "threeD" });
assert(r.ok && near(T(L)["ADBE Position"].value[0], 100) &&
       /3D/.test((r.data && r.data.note) || ""),
       "3D layer: position untouched and the note says why (got: " +
       ((r.data && r.data.note) || "") + ")");

// 11. THE SECOND BUG, found in real AE. Scale and Rotation can be
//     animated TOO, which makes the compensation delta time-dependent.
//     The old code took ONE delta at the current time and applied it to
//     every Position key, so the layer sat still at that time and drifted
//     everywhere else (measured at up to 37px in AE 2026 via toComp).
//     Scale 100% -> 200% doubles the delta at the second key.
L = fresh("animScale");
let posK = T(L)["ADBE Position"];
posK.numKeys = 2;
posK._keyTimes = [0, 1];
posK._keyValues = [[0, 0, 0], [100, 100, 0]];
let sclK = T(L)["ADBE Scale"];
sclK.numKeys = 2;
sclK._keyTimes = [0, 1];
sclK._keyValues = [[100, 100, 100], [200, 200, 100]];
r = call("center_anchor_point", { layer: "animScale" });
assert(r.ok, "animated scale: succeeds (" + (r.error || "") + ")");
assert(near(posK._keyValues[0][0], 50) && near(posK._keyValues[0][1], 50),
       "animated scale: key at t=0 uses scale 100% -> [50,50] (got " +
       posK._keyValues[0] + ")");
assert(near(posK._keyValues[1][0], 200) && near(posK._keyValues[1][1], 200),
       "animated scale: key at t=1 uses scale 200% -> [200,200], NOT the " +
       "t=0 delta (got " + posK._keyValues[1] + ")");

// 12. Same for an animated Rotation: 0 -> 90 degrees turns the (+50,+50)
//     layer-space shift into (-50,+50) at the second key only.
L = fresh("animRot");
posK = T(L)["ADBE Position"];
posK.numKeys = 2;
posK._keyTimes = [0, 1];
posK._keyValues = [[0, 0, 0], [100, 100, 0]];
const rotK = T(L)["ADBE Rotate Z"];
rotK.numKeys = 2;
rotK._keyTimes = [0, 1];
rotK._keyValues = [0, 90];
r = call("center_anchor_point", { layer: "animRot" });
assert(r.ok && near(posK._keyValues[0][0], 50) &&
       near(posK._keyValues[0][1], 50),
       "animated rotation: key at t=0 unrotated -> [50,50] (got " +
       posK._keyValues[0] + ")");
assert(near(posK._keyValues[1][0], 50) && near(posK._keyValues[1][1], 150),
       "animated rotation: key at t=1 rotated 90deg -> [50,150] (got " +
       posK._keyValues[1] + ")");
assert(/exact at the Position keyframes/.test((r.data && r.data.note) || ""),
       "animated rig: note admits the in-between drift it cannot remove " +
       "(got: " + ((r.data && r.data.note) || "") + ")");

// 13. Animated rig but a STATIC Position: no single value can hold the
//     layer still, so the note must warn instead of claiming it did.
L = fresh("rigNoPosKeys");
const sclR = T(L)["ADBE Scale"];
sclR.numKeys = 2;
sclR._keyTimes = [0, 1];
sclR._keyValues = [[100, 100, 100], [200, 200, 100]];
r = call("center_anchor_point", { layer: "rigNoPosKeys" });
assert(r.ok && /WARNING/.test((r.data && r.data.note) || "") &&
       /drifts/.test((r.data && r.data.note) || ""),
       "animated rig + static position: warns it holds at one time only " +
       "(got: " + ((r.data && r.data.note) || "") + ")");

// 14. A rig can also be an EXPRESSION, which has no keyframes at all --
//     the same time-dependence, invisible to a numKeys check.
L = fresh("drivenScale");
T(L)["ADBE Scale"].expressionEnabled = true;
r = call("center_anchor_point", { layer: "drivenScale" });
assert(r.ok && /WARNING/.test((r.data && r.data.note) || ""),
       "expression-driven scale counts as animated too (got: " +
       ((r.data && r.data.note) || "") + ")");

// 15. Stub fidelity for the new path: valueAtTime must return each key's
//     own value, or cases 11-12 would pass for the wrong reason.
const vp = new Prop(0);
vp.numKeys = 2; vp._keyTimes = [0, 1]; vp._keyValues = [10, 20];
assert(vp.valueAtTime(0, false) === 10 && vp.valueAtTime(1, false) === 20 &&
       near(vp.valueAtTime(0.5, false), 15),
       "stub fidelity: valueAtTime is exact at keys and interpolates between");

// 16. The stub itself must be faithful, or every assertion above is
//     theatre: prove setValue really does throw on a keyed property.
let threw = false;
const probe = new Prop([0, 0, 0]);
probe.numKeys = 1;
probe._keyValues = [[0, 0, 0]];
try { probe.setValue([1, 1, 1]); } catch (e) { threw = true; }
assert(threw, "stub fidelity: setValue throws on a keyframed property");

if (process.exitCode) console.error("\nTESTS FAILED");
else console.log("\nALL TESTS PASSED");
