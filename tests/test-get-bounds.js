// Regression test: get_bounds, against a stub that models what real AE
// 2026 was measured doing (probes in WORKPLAN-LOG 2026-08-29).
//
// STUB FIDELITY — the three rules that make this test worth anything:
//   1. sourceRectAtTime's argument is the layer's own SOURCE time, NOT
//      comp time: it is unshifted by startTime and unscaled by stretch,
//      while every property time (keyTime/valueAtTime) IS comp time.
//      A stub that ignored its time argument would let the old
//      comp.time-straight-through bug pass.
//   2. It takes TWO arguments and AE throws when given fewer.
//   3. Cameras and lights have no sourceRectAtTime at all (typeof
//      undefined), so the tool must refuse them rather than throw.
// Values are PADDED to 3 components for 2D layers, as the scripting API
// reports them (CLAUDE.md).
"use strict";
const fs = require("fs");
const path = require("path");

function Prop(value) {
  this._value = value;
  this.expression = "";
  this.expressionEnabled = false;
  this.numKeys = 0;
  this._keyTimes = [];
  this._keyValues = [];
}
Object.defineProperty(Prop.prototype, "value", {
  get() { return this.numKeys > 0 ? this._keyValues[0] : this._value; }
});
Prop.prototype.setValue = function (v) { this._value = v; };
Prop.prototype.keyTime = function (i) { return this._keyTimes[i - 1]; };
Prop.prototype.keyValue = function (i) { return this._keyValues[i - 1]; };
Prop.prototype.setValueAtTime = function (t, v) {
  this._keyTimes.push(t); this._keyValues.push(v); this.numKeys++;
};
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

function Layer(name, comp) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.threeDLayer = false;
  this.parent = null;
  this.startTime = 0;
  this.stretch = 100;
  this.inPoint = 0;
  this.outPoint = 5;
  // Rects keyed by SOURCE time: [t, rect] pairs, held before the first.
  this._rects = [[0, { left: 0, top: 0, width: 200, height: 100 }]];
  this._extentsPad = 0;
  this.rectCalls = [];
  this._transform = {
    "ADBE Position": new Prop([0, 0, 0]),
    "ADBE Scale": new Prop([100, 100, 100]),
    "ADBE Rotate Z": new Prop(0),
    "ADBE Opacity": new Prop(100),
    "ADBE Anchor Point": new Prop([0, 0, 0])
  };
}
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
Layer.prototype.sourceRectAtTime = function (t, extents) {
  if (arguments.length < 2) {
    // Faithful to AE 2026, measured: "the call requires 2 parameters".
    throw new Error("After Effects error: Unable to call " +
                    "sourceRectAtTime because the call requires 2 " +
                    "parameters.");
  }
  this.rectCalls.push(t);
  let r = this._rects[0][1];
  for (const pair of this._rects) if (t >= pair[0]) r = pair[1];
  if (!extents || !this._extentsPad) return r;
  const p = this._extentsPad;
  return { left: r.left - p, top: r.top - p,
           width: r.width + 2 * p, height: r.height + 2 * p };
};
Layer.prototype.property = function (name) {
  if (name === "ADBE Transform Group") {
    const t = this._transform;
    return { property(n) { return t[n]; } };
  }
  return null;
};

function BlindLayer(name, comp) {   // camera / light: no bounds at all
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.threeDLayer = true;
  this.parent = null;
  this.startTime = 0;
  this.stretch = 100;
  this._transform = { "ADBE Position": new Prop([100, 100, 0]) };
}
Object.defineProperty(BlindLayer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
BlindLayer.prototype.property = Layer.prototype.property;

function Comp(name) {
  this.name = name; this._layers = []; this.time = 0;
  this.width = 1000; this.height = 800;
  this.frameRate = 30; this.duration = 10;
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
const KeyframeInterpolationType = { BEZIER: "bezier" };
function KeyframeEase(speed, influence) {
  this.speed = speed; this.influence = influence;
}

const comp = new Comp("Bounds");
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));

function addLayer(name, ctor) {
  const l = new (ctor || Layer)(name, comp);
  if (ctor === BlindLayer) {
    Object.setPrototypeOf(l, Object.create(CameraLayer.prototype,
      Object.getOwnPropertyDescriptors(BlindLayer.prototype)));
  } else {
    Object.setPrototypeOf(l, Object.create(AVLayer.prototype,
      Object.getOwnPropertyDescriptors(Layer.prototype)));
  }
  comp._layers.push(l);
  return l;
}

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

console.log("== STUB FIDELITY (the stub must behave like AE, first) ==");
const fid = addLayer("fidelity");
let threw = false;
try { fid.sourceRectAtTime(0); } catch (e) { threw = true; }
assert(threw, "stub: sourceRectAtTime with one argument throws, as AE does");
assert(typeof (new BlindLayer("c", comp)).sourceRectAtTime === "undefined",
       "stub: a camera/light layer has no sourceRectAtTime at all");
fid._rects = [[0, { left: 0, top: 0, width: 10, height: 10 }],
              [2, { left: 0, top: 0, width: 500, height: 10 }]];
fid.startTime = 1;
fid.stretch = 200;
assert(fid.sourceRectAtTime(2, false).width === 500,
       "stub: the rect is keyed by SOURCE time, ignoring startTime/stretch");

console.log("");
console.log("== a plain solid ==");
const solid = addLayer("solid");
solid._transform["ADBE Position"].setValue([500, 400, 0]);
solid._transform["ADBE Anchor Point"].setValue([0, 0, 0]);
let r = call("get_bounds", { layer: "solid" });
assert(r.ok, "get_bounds on a solid succeeds");
assert(r.data.source.width === 200 && r.data.source.height === 100,
       "source rect is the layer's own 200x100");
assert(r.data.source.centerX === 100 && r.data.source.centerY === 50,
       "source centre is reported");
assert(r.data.comp.left === 500 && r.data.comp.top === 400,
       "comp box starts at the position when the anchor is [0,0]");
assert(r.data.comp.width === 200 && r.data.comp.height === 100,
       "an unrotated, unscaled layer's comp box matches its source size");
assert(r.data.inFrame === "fully", "a layer inside the frame reads fully");
assert(!r.data.outsideBy, "nothing overflows, so no outsideBy is reported");
assert(r.data.corners.length === 4 &&
       r.data.corners[2][0] === 700 && r.data.corners[2][1] === 500,
       "four comp-space corners, bottom-right at 700,500");
assert(r.data.compSize[0] === 1000 && r.data.compSize[1] === 800,
       "the comp's own size comes back for comparison");

console.log("");
console.log("== scale, rotation and the anchor ==");
solid._transform["ADBE Anchor Point"].setValue([100, 50, 0]);
r = call("get_bounds", { layer: "solid" });
assert(r.data.comp.centerX === 500 && r.data.comp.centerY === 400,
       "a centred anchor puts the comp box's centre on Position");
solid._transform["ADBE Scale"].setValue([200, 50, 100]);
r = call("get_bounds", { layer: "solid" });
assert(r.data.comp.width === 400 && r.data.comp.height === 50,
       "scale is applied to the comp box (200% x, 50% y)");
assert(r.data.source.width === 200,
       "...and the SOURCE rect is untouched by the transform, as in AE");
solid._transform["ADBE Rotate Z"].setValue(90);
r = call("get_bounds", { layer: "solid" });
assert(near(r.data.comp.width, 50) && near(r.data.comp.height, 400),
       "a 90-degree rotation swaps the axis-aligned box");
assert(r.data.rotated === 90 && /axis-aligned box AROUND it/.test(
       r.data.rotatedNote || ""),
       "a rotated layer says its comp box is not its own size");
solid._transform["ADBE Rotate Z"].setValue(0);
solid._transform["ADBE Scale"].setValue([100, 100, 100]);

console.log("");
console.log("== parenting ==");
const kid = addLayer("kid");
kid._rects = [[0, { left: 0, top: 0, width: 50, height: 50 }]];
kid._transform["ADBE Anchor Point"].setValue([0, 0, 0]);
kid._transform["ADBE Position"].setValue([0, 0, 0]);
kid.parent = solid;
r = call("get_bounds", { layer: "kid" });
assert(r.data.comp.left === 500 && r.data.comp.top === 400,
       "a child's box is measured through its parent's transform");
solid._transform["ADBE Scale"].setValue([200, 200, 100]);
r = call("get_bounds", { layer: "kid" });
assert(r.data.comp.width === 100 && r.data.comp.height === 100,
       "the PARENT's scale scales the child's box too");
solid._transform["ADBE Rotate Z"].setValue(90);
r = call("get_bounds", { layer: "kid" });
assert(near(r.data.comp.left, 400) && near(r.data.comp.top, 400),
       "the parent's rotation rotates the child about the parent's anchor");
assert(!r.data.rotated,
       "the child itself is not rotated, so no rotated note on IT");
solid._transform["ADBE Rotate Z"].setValue(0);
solid._transform["ADBE Scale"].setValue([100, 100, 100]);
kid.parent = null;

console.log("");
console.log("== the frame test ==");
const edge = addLayer("edge");
edge._rects = [[0, { left: 0, top: 0, width: 400, height: 200 }]];
edge._transform["ADBE Anchor Point"].setValue([0, 0, 0]);
edge._transform["ADBE Position"].setValue([-100, 700, 0]);
r = call("get_bounds", { layer: "edge" });
assert(r.data.inFrame === "partly", "a layer crossing the edge reads partly");
assert(r.data.outsideBy.left === 100 && r.data.outsideBy.bottom === 100,
       "outsideBy names each side and by how many pixels");
assert(!r.data.outsideBy.right && !r.data.outsideBy.top,
       "sides that are inside are not listed");
edge._transform["ADBE Position"].setValue([2000, 400, 0]);
r = call("get_bounds", { layer: "edge" });
assert(r.data.inFrame === "outside",
       "a layer entirely past the right edge reads outside");
assert(r.data.outsideBy.right === 1400, "…and says how far past");

console.log("");
console.log("== TIME: the source-time trap ==");
const anim = addLayer("anim");
anim._rects = [[0, { left: 0, top: 0, width: 10, height: 20 }],
               [2, { left: 0, top: 0, width: 600, height: 20 }]];
anim._transform["ADBE Anchor Point"].setValue([0, 0, 0]);
anim.rectCalls = [];
r = call("get_bounds", { layer: "anim", time: 3 });
assert(r.data.source.width === 600,
       "an unshifted layer measures at the time asked for");
assert(anim.rectCalls[0] === 3, "…which is passed straight through");
assert(r.data.time === 3, "the comp time used comes back in the result");
assert(!r.data.sourceTime,
       "no sourceTime field when the two times are the same");

anim.startTime = 2;
anim.rectCalls = [];
r = call("get_bounds", { layer: "anim", time: 3 });
assert(anim.rectCalls[0] === 1,
       "a layer that starts at 2s is measured at SOURCE time 1, not 3");
assert(r.data.source.width === 10,
       "…so it reports the narrow rect the viewer is actually showing");
assert(r.data.sourceTime === 1 && /source time/.test(r.data.timeNote || ""),
       "the result says which source time it measured and why");

anim.startTime = 0;
anim.stretch = 200;
anim.rectCalls = [];
r = call("get_bounds", { layer: "anim", time: 3 });
assert(anim.rectCalls[0] === 1.5,
       "time stretch scales the source time (comp 3s at 200% = source 1.5s)");
assert(r.data.source.width === 10, "…and the rect follows the stretch");
anim.stretch = 100;

anim.rectCalls = [];
comp.time = 2.5;
r = call("get_bounds", { layer: "anim" });
assert(anim.rectCalls[0] === 2.5,
       "with no time argument the comp's current time is used");
comp.time = 0;

console.log("");
console.log("== extents ==");
const stroked = addLayer("stroked");
stroked._rects = [[0, { left: -150, top: -75, width: 300, height: 150 }]];
stroked._extentsPad = 100;
r = call("get_bounds", { layer: "stroked" });
assert(r.data.source.width === 300 && r.data.extents === false,
       "extents defaults to false — the stroke is not counted");
r = call("get_bounds", { layer: "stroked", extents: true });
assert(r.data.source.width === 500 && r.data.source.left === -250 &&
       r.data.extents === true,
       "extents:true grows the rect by the stroke, as AE does on shapes");

console.log("");
console.log("== what has no bounds ==");
const cam = addLayer("cam", BlindLayer);
r = call("get_bounds", { layer: "cam" });
assert(!r.ok, "a camera is refused rather than throwing AE's raw error");
assert(/renders no pixels/.test(r.error) && /get_property/.test(r.error),
       "…with a grounded error that names the way to read it instead");
assert(/text, shape, solid, footage, precomp, null/.test(r.error),
       "…and lists what DOES have bounds");

console.log("");
console.log("== 3D is refused a comp box, not given a wrong one ==");
const flat = addLayer("flat3d");
flat._transform["ADBE Anchor Point"].setValue([0, 0, 0]);
flat.threeDLayer = true;
r = call("get_bounds", { layer: "flat3d" });
assert(r.ok, "a 3D layer still answers");
assert(r.data.source.width === 200, "…with an exact source rect");
assert(r.data.comp === null, "…and no comp box");
assert(/3D layer/.test(r.data.compBoxUnavailable || "") &&
       /camera/.test(r.data.compBoxUnavailable || ""),
       "…and says why: the camera decides where those pixels land");
flat.threeDLayer = false;

const kid2 = addLayer("kid-of-3d");
kid2._transform["ADBE Anchor Point"].setValue([0, 0, 0]);
const par3d = addLayer("par3d");
par3d.threeDLayer = true;
kid2.parent = par3d;
r = call("get_bounds", { layer: "kid-of-3d" });
assert(r.data.comp === null && /par3d/.test(r.data.compBoxUnavailable || ""),
       "a 2D layer with a 3D PARENT is refused too, and the parent named");
kid2.parent = null;

console.log("");
console.log("== empty content ==");
const empty = addLayer("emptyshape");
empty._rects = [[0, { left: 0, top: 0, width: 0, height: 0 }]];
r = call("get_bounds", { layer: "emptyshape" });
assert(r.ok && /renders nothing/.test(r.data.empty || ""),
       "a 0x0 layer says it renders nothing instead of reporting a box");

console.log("");
console.log("== argument handling ==");
r = call("get_bounds", { layers: ["solid", "kid"] });
assert(!r.ok && /ONE layer/.test(r.error) && /once per layer/.test(r.error),
       "a {layers: [...]} batch is refused with the way to do it instead");
r = call("get_bounds", { layer: "solid", time: "1" });
assert(r.ok, "a quoted number is accepted for time (small models send them)");
r = call("get_bounds", { layer: "solid", time: "soon" });
assert(!r.ok && /must be a number/.test(r.error),
       "a non-numeric time is refused, not silently treated as 0");
r = call("get_bounds", { layer: "nope" });
assert(!r.ok && /solid/.test(r.error),
       "an unknown layer is refused with the real layer names listed");
solid.selected = true;
r = call("get_bounds", {});
assert(r.ok && r.data.layer === "solid",
       "with no layer argument the selected layer is used");
solid.selected = false;

console.log("");
console.log("== center_anchor_point measures at the same source time ==");
const ca = addLayer("ca");
ca._rects = [[0, { left: 0, top: 0, width: 10, height: 10 }],
             [2, { left: 0, top: 0, width: 400, height: 100 }]];
ca.startTime = 2;
comp.time = 3;              // layer source time 1 -> the SMALL rect
ca.rectCalls = [];
r = call("center_anchor_point", { layer: "ca" });
assert(r.ok, "center_anchor_point runs");
assert(ca.rectCalls[0] === 1,
       "it measures at source time 1, not comp time 3 (the shipped bug)");
assert(r.data.newAnchor[0] === 5 && r.data.newAnchor[1] === 5,
       "…so the anchor lands on the content AE is actually showing");
comp.time = 0;

console.log("");
console.log(process.exitCode ? "FAILURES" : "all get_bounds checks passed");
