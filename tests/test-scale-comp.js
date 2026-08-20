// Regression test: scale_comp — resize a comp AND its content, the way
// the native "Scale Composition" script does.
//
// The existing coverage in test-curve-tools.js only had plain 2D layers,
// so three things went unproven:
//   - Cameras AIM at a Point of Interest held in COMP space. Scale the
//     comp without re-centring it and the camera keeps pointing where
//     things used to be, silently re-framing the shot.
//   - An expression-driven transform ACCEPTS the write and ignores it.
//     Reporting those layers as "scaled" is a false success, and this
//     panel rigs Position with expressions routinely (grid_layout).
//   - A layer that genuinely fails was counted as "inherited", i.e. as
//     though its parent had handled it.
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
  this.locked = false;
}
Object.defineProperty(Prop.prototype, "value", {
  get() { return this.numKeys > 0 ? this._keyValues[0] : this._value; }
});
Prop.prototype.setValue = function (v) {
  if (this.numKeys > 0) {
    throw new Error("Cannot set a value on a property with keyframes.");
  }
  if (this.locked) { throw new Error("Layer is locked."); }
  if (this.hidden) {
    // Real AE 2026 wording. A hidden property still RESOLVES and still
    // reports elided=false / enabled=true, so only the write reveals it.
    throw new Error('After Effects error: Can not "set value" with this ' +
      'property, because the property or a parent property is hidden.');
  }
  this._value = v;
};
Prop.prototype.keyTime = function (i) { return this._keyTimes[i - 1]; };
Prop.prototype.keyValue = function (i) { return this._keyValues[i - 1]; };
Prop.prototype.setValueAtKey = function (i, v) { this._keyValues[i - 1] = v; };

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function SolidSource() {}
function AVLayer() {}
function CameraLayer() {} function LightLayer() {}
const ParagraphJustification = {};
const KeyframeInterpolationType = { BEZIER: "bezier" };
const AutoOrientType = { CAMERA_OR_POINT_OF_INTEREST: 4214,
                         NO_AUTO_ORIENT: 4212 };
function KeyframeEase(s, i) { this.speed = s; this.influence = i; }

function Layer(name, comp) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.threeDLayer = false;
  this.parent = null;
  this.inPoint = 0; this.outPoint = 5; this.startTime = 0;
  this._transform = {
    "ADBE Position": new Prop([960, 540, 0]),
    "ADBE Scale": new Prop([100, 100, 100]),
    "ADBE Rotate Z": new Prop(0),
    "ADBE Opacity": new Prop(100),
    "ADBE Anchor Point": new Prop([0, 0, 0])
  };
}
Layer.prototype.property = function (name) {
  if (name === "ADBE Transform Group") {
    const t = this._transform;
    return { property(n) { return t[n]; } };
  }
  return null;
};
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});

// A camera: 3D position, a Point of Interest in comp space, and zoom.
function Cam(name, comp) {
  Layer.call(this, name, comp);
  this.threeDLayer = true;
  this._transform["ADBE Position"] = new Prop([1920, 1080, -1000]);
  this._transform["ADBE Anchor Point"] = new Prop([1920, 1080, 0]); // POI
  this.zoom = new Prop(1000);
  // A camera HAS a Scale that resolves, but it is hidden and writing it
  // throws — that write used to abort the whole layer after Position had
  // already been changed, leaving the comp half scaled.
  this._transform["ADBE Scale"].hidden = true;
  this.setAutoOrient(AutoOrientType.CAMERA_OR_POINT_OF_INTEREST);
}
Cam.prototype = Object.create(Layer.prototype);
Cam.prototype.constructor = Cam;
Object.setPrototypeOf(Cam.prototype, CameraLayer.prototype);
Cam.prototype.property = Layer.prototype.property;
// One-node cameras (NO_AUTO_ORIENT) hide the Point of Interest: there is
// nothing to aim, and setValue throws.
Cam.prototype.setAutoOrient = function (mode) {
  this.autoOrient = mode;
  this._transform["ADBE Anchor Point"].hidden =
    mode !== AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
};

function Comp(name, w, h) {
  this.name = name; this._layers = []; this.time = 0;
  this.width = w; this.height = h;
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

const comp = new Comp("Shot", 3840, 2160);
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
function near(a, b, eps) { return Math.abs(a - b) < (eps || 0.01); }
const T = l => l._transform;

// Layers: a plain one at centre, one off-centre, a camera, a driven one,
// a parented child, and one that refuses writes.
const mid = new Layer("mid", comp);
mid._transform["ADBE Position"]._value = [1920, 1080, 0];  // old centre
const corner = new Layer("corner", comp);
corner._transform["ADBE Position"]._value = [0, 0, 0];
const cam = new Cam("Camera 1", comp);
// A one-node camera: no aim point, and a hidden Scale that throws. This
// combination silently half-scaled the comp in real AE 2026.
const cam1 = new Cam("Camera One-Node", comp);
cam1.setAutoOrient(AutoOrientType.NO_AUTO_ORIENT);
const rigged = new Layer("rigged", comp);
rigged._transform["ADBE Position"].expressionEnabled = true;
const child = new Layer("child", comp);
child.parent = mid;
const locked = new Layer("locked", comp);
locked._transform["ADBE Position"].locked = true;
comp._layers.push(mid, corner, cam, cam1, rigged, child, locked);

// 3840x2160 -> 1920x1080 is exactly half.
const r = call("scale_comp", { width: 1920, height: 1080 });
assert(r.ok, "succeeds (" + (r.error || "") + ")");
const d = r.data || {};
assert(d.width === 1920 && d.height === 1080, "comp resized to 1920x1080");
assert(near(d.scaleFactor, 0.5), "uniform factor 0.5 (got " +
       d.scaleFactor + ")");

// Centre stays centre; the corner halves its distance from centre.
assert(near(T(mid)["ADBE Position"].value[0], 960) &&
       near(T(mid)["ADBE Position"].value[1], 540),
       "centred layer stays centred (got " +
       T(mid)["ADBE Position"].value + ")");
assert(near(T(corner)["ADBE Position"].value[0], 0) &&
       near(T(corner)["ADBE Position"].value[1], 0),
       "corner layer stays in its corner (got " +
       T(corner)["ADBE Position"].value + ")");
assert(near(T(mid)["ADBE Scale"].value[0], 50),
       "layer scale halves (got " + T(mid)["ADBE Scale"].value + ")");

// THE CAMERA BUG: Point of Interest lives in comp space and must be
// re-centred, or the camera aims at the old world position.
assert(near(cam.zoom.value, 500),
       "camera zoom scales (got " + cam.zoom.value + ")");
assert(near(T(cam)["ADBE Position"].value[2], -500),
       "camera Z distance scales (got " +
       T(cam)["ADBE Position"].value + ")");
assert(near(T(cam)["ADBE Anchor Point"].value[0], 960) &&
       near(T(cam)["ADBE Anchor Point"].value[1], 540),
       "camera Point of Interest re-centred, so the shot keeps its aim " +
       "(got " + T(cam)["ADBE Anchor Point"].value + ")");

// A camera's Scale resolves but is hidden. Writing it threw and aborted
// the layer AFTER Position was written, so the comp came out half scaled
// with the camera reported as skipped and zoom/aim never applied.
assert(near(T(cam)["ADBE Scale"].value[0], 100),
       "camera Scale left alone (got " + T(cam)["ADBE Scale"].value + ")");
const skippedNames = (d.layersSkipped || []).join(" ");
assert(skippedNames.indexOf("Camera") === -1,
       "no camera reported as skipped (got " + (skippedNames || "none") + ")");

// A one-node camera still scales its zoom, but has no Point of Interest
// to re-centre -- skipping that is correct, not a failure.
assert(near(cam1.zoom.value, 500),
       "one-node camera zoom still scales (got " + cam1.zoom.value + ")");
assert(near(T(cam1)["ADBE Anchor Point"].value[0], 1920) &&
       near(T(cam1)["ADBE Anchor Point"].value[1], 1080),
       "one-node camera Point of Interest left untouched (got " +
       T(cam1)["ADBE Anchor Point"].value + ")");
assert(near(T(cam1)["ADBE Position"].value[2], -500),
       "one-node camera still scales past the hidden Scale (got " +
       T(cam1)["ADBE Position"].value + ")");

// Parented children inherit through the parent; they must NOT be touched
// twice or the child doubles the transform.
assert(near(T(child)["ADBE Position"].value[0], 960) &&
       near(T(child)["ADBE Scale"].value[0], 100),
       "parented child left alone (inherits through its parent)");
assert(d.layersInherited >= 1, "parented child counted as inherited");

// Expression-driven transforms accept the write and ignore it. Saying
// "scaled" for those is a false success.
assert(Array.isArray(d.expressionDriven) &&
       d.expressionDriven.indexOf("rigged") !== -1,
       "expression-driven layer named in the result (got " +
       JSON.stringify(d.expressionDriven) + ")");
assert(/WARNING/.test(d.note || "") && /expression/i.test(d.note || ""),
       "note warns that driven transforms override the write");

// A refused write must be reported, not folded into "inherited".
assert(Array.isArray(d.layersSkipped) &&
       d.layersSkipped.join(" ").indexOf("locked") !== -1,
       "locked layer reported as skipped, with a reason (got " +
       JSON.stringify(d.layersSkipped) + ")");
assert(/could NOT be scaled/.test(d.note || ""),
       "note says some layers could not be scaled");

// Stub fidelity: the guards above are only meaningful if the stub really
// refuses these writes.
let threw = false;
const p = new Prop([0, 0, 0]);
p.locked = true;
try { p.setValue([1, 1, 1]); } catch (e) { threw = true; }
assert(threw, "stub fidelity: a locked property refuses setValue");

if (process.exitCode) console.error("\nTESTS FAILED");
else console.log("\nALL TESTS PASSED");
