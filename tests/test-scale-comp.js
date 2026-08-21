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
  // Everything a keyframe carries BESIDES its value. setValueAtKey moves
  // the value and leaves all of this behind, still in the old comp's
  // units -- which is exactly how a curved path survived a resize with
  // full-size handles.
  this._inTan = [];
  this._outTan = [];
  this._autoBez = [];
  this._inEase = [];
  this._outEase = [];
  this._inType = [];
  this._outType = [];
  this.isSpatial = false;
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
// setValueAtKey writes ONLY the value: tangents, eases and interpolation
// types are left exactly as they were. Verified in real AE 2026.
Prop.prototype.setValueAtKey = function (i, v) { this._keyValues[i - 1] = v; };

/* Add a keyframe with everything it carries. Defaults match AE's: a
 * spatial key comes out auto-bezier, a temporal one linear with no ease. */
Prop.prototype.addKey = function (time, value, opts) {
  const o = opts || {};
  const n = this.numKeys;
  this._keyTimes[n] = time;
  this._keyValues[n] = value;
  this._inTan[n] = o.inTan || [0, 0, 0];
  this._outTan[n] = o.outTan || [0, 0, 0];
  this._autoBez[n] = o.autoBez !== false;
  const dims = this.isSpatial ? 1
    : (Array.isArray(value) ? value.length : 1);
  // A side nobody has eased reports speed 0 AND influence 0 -- the value
  // its own constructor rejects. Built directly, not via KeyframeEase,
  // exactly as AE reports it.
  const mk = (sp, infl) => {
    const arr = [];
    for (let d = 0; d < dims; d++) {
      arr.push({ speed: sp, influence: sp ? (infl || 33) : 0 });
    }
    return arr;
  };
  this._inEase[n] = mk(o.inSpeed || 0, o.inInfluence);
  this._outEase[n] = mk(o.outSpeed || 0, o.outInfluence);
  this._inType[n] = o.inType || KeyframeInterpolationType.LINEAR;
  this._outType[n] = o.outType || KeyframeInterpolationType.LINEAR;
  this.numKeys = n + 1;
  return this;
};
Prop.prototype.keySpatialAutoBezier = function (i) {
  return this._autoBez[i - 1];
};
Prop.prototype.keyInSpatialTangent = function (i) { return this._inTan[i - 1]; };
Prop.prototype.keyOutSpatialTangent = function (i) { return this._outTan[i - 1]; };
Prop.prototype.setSpatialTangentsAtKey = function (i, tin, tout) {
  if (!this.isSpatial) {
    throw new Error("After Effects error: property is not spatial.");
  }
  this._inTan[i - 1] = tin;
  this._outTan[i - 1] = tout;
  // Handing AE explicit handles switches auto-bezier OFF.
  this._autoBez[i - 1] = false;
};
Prop.prototype.keyInTemporalEase = function (i) { return this._inEase[i - 1]; };
Prop.prototype.keyOutTemporalEase = function (i) { return this._outEase[i - 1]; };
Prop.prototype.setTemporalEaseAtKey = function (i, ein, eout) {
  // The padded-dims rule, with AE's own refusal: 1 ease for a SPATIAL
  // property, one per PADDED scripting component for everything else --
  // so Scale on a 2D layer demands 3, not 2.
  const v = this._keyValues[i - 1];
  const need = this.isSpatial ? 1 : (Array.isArray(v) ? v.length : 1);
  if (ein.length !== need || eout.length !== need) {
    throw new Error("After Effects error: Unable to call " +
      "“setTemporalEaseAtKey” because of parameter 2. " +
      "Value array does not have " + need + " elements.");
  }
  this._inEase[i - 1] = ein;
  this._outEase[i - 1] = eout;
  // Real AE 2026: writing an ease flips BOTH sides of the key to bezier,
  // even a HOLD one. Anything that touches ease must put the types back.
  this._inType[i - 1] = KeyframeInterpolationType.BEZIER;
  this._outType[i - 1] = KeyframeInterpolationType.BEZIER;
};
Prop.prototype.keyInInterpolationType = function (i) { return this._inType[i - 1]; };
Prop.prototype.keyOutInterpolationType = function (i) { return this._outType[i - 1]; };
Prop.prototype.setInterpolationTypeAtKey = function (i, tin, tout) {
  this._inType[i - 1] = tin;
  this._outType[i - 1] = tout;
};

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function SolidSource() {}
function AVLayer() {}
function CameraLayer() {} function LightLayer() {}
const ParagraphJustification = {};
const KeyframeInterpolationType = { BEZIER: "bezier", LINEAR: "linear",
                                   HOLD: "hold" };
const AutoOrientType = { CAMERA_OR_POINT_OF_INTEREST: 4214,
                         NO_AUTO_ORIENT: 4212 };
// AE's constructor REFUSES an influence outside 0.1..100 -- including
// the 0 it hands back on the untouched side of a keyframe. Rebuilding an
// ease from what AE just reported therefore throws, which is how eased
// motion survived a resize at the OLD comp's speed.
function KeyframeEase(s, i) {
  if (!(i >= 0.1 && i <= 100)) {
    throw new Error("After Effects error: Unable to call " +
      "“Constructor” because of parameter 2. Value " + i +
      " out of range 0.1 to 100.");
  }
  this.speed = s;
  this.influence = i;
}

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

// A user-shaped motion path: three Position keys, explicit (non-auto)
// spatial handles on the middle one, and an ease with a real speed. Every
// KEY VALUE scales correctly even without the fix -- the damage is
// entirely BETWEEN the keys, which is why keyValue() assertions alone
// missed it. Real AE 2026, 800x600 halved: 37px off course mid-key.
const curved = new Layer("curved", comp);
const cp = curved._transform["ADBE Position"];
cp.isSpatial = true;
// The ease shape apply_keyframe_ease actually leaves behind: only the
// sides FACING the eased pair carry a speed, so key 1's in-side and
// key 3's out-side read back as influence 0 -- the value AE's own
// KeyframeEase constructor refuses.
cp.addKey(0, [0, 0, 0], { outSpeed: 600, outInfluence: 30,
                          outType: KeyframeInterpolationType.BEZIER })
  .addKey(1, [1920, 2160, 0], { autoBez: false, inTan: [-400, 0, 0],
                                outTan: [400, 0, 0],
                                inSpeed: 600, inInfluence: 30,
                                outSpeed: 600, outInfluence: 30,
                                inType: KeyframeInterpolationType.BEZIER,
                                outType: KeyframeInterpolationType.BEZIER })
  .addKey(2, [3840, 0, 0], { inSpeed: 600, inInfluence: 30,
                             inType: KeyframeInterpolationType.BEZIER });
// Auto-bezier handles are AE's to recompute from the scaled values --
// touching them would only switch auto off.
cp._autoBez[0] = true;

// HOLD and LINEAR sides must survive: writing an ease flips them to
// bezier in real AE, which would turn stepped animation into a slide.
const held = new Layer("held", comp);
const hp = held._transform["ADBE Position"];
hp.isSpatial = true;
hp.addKey(0, [200, 200, 0], { inType: KeyframeInterpolationType.LINEAR,
                              outType: KeyframeInterpolationType.HOLD })
  .addKey(1, [1000, 1000, 0], { inType: KeyframeInterpolationType.HOLD,
                                outType: KeyframeInterpolationType.LINEAR });

// Keyed SCALE: not spatial, so its ease array must be PADDED to 3 even
// though the layer is 2D. A wrong length is refused by AE outright, and
// the layer would land in layersSkipped.
const grown = new Layer("grown", comp);
const gs = grown._transform["ADBE Scale"];
gs.addKey(0, [100, 100, 100], { inSpeed: 40, outSpeed: 40,
                                inType: KeyframeInterpolationType.BEZIER,
                                outType: KeyframeInterpolationType.BEZIER })
  .addKey(1, [200, 200, 100]);

// A camera parented to a null -- the standard rig. Zoom lives in Camera
// Options, so NOTHING about it is inherited: it kept its old pixel zoom
// and silently re-framed the shot.
const camKid = new Cam("Camera Rigged", comp);
camKid.parent = mid;

comp._layers.push(mid, corner, cam, cam1, rigged, child, locked,
                  curved, held, grown, camKid);

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

// ---- keyframed content: the interpolation has to scale too -----------
// Values at the keys were always right; the path BETWEEN them was not.
assert(near(cp.keyValue(1)[0], 0) && near(cp.keyValue(3)[0], 1920),
       "keyed Position values scale (got " + cp.keyValue(3) + ")");
assert(near(cp.keyInSpatialTangent(2)[0], -200) &&
       near(cp.keyOutSpatialTangent(2)[0], 200),
       "spatial tangents scale with the path, so a curve keeps its shape " +
       "(got " + cp.keyInSpatialTangent(2) + " / " +
       cp.keyOutSpatialTangent(2) + ")");
assert(cp.keySpatialAutoBezier(2) === false,
       "an explicitly shaped key stays explicitly shaped");
assert(cp.keySpatialAutoBezier(1) === true &&
       near(cp.keyInSpatialTangent(1)[0], 0),
       "an AUTO-bezier key is left for AE to recompute, not switched off");
assert(near(cp.keyOutTemporalEase(1)[0].speed, 300),
       "an eased key whose OTHER side reads influence 0 still rescales " +
       "-- rebuilding that side is what AE refuses (got " +
       cp.keyOutTemporalEase(1)[0].speed + ")");
assert(cp.keyInTemporalEase(1)[0].influence === 0 &&
       cp.keyInTemporalEase(1)[0].speed === 0,
       "the un-eased side is passed through untouched, not invented " +
       "(got speed " + cp.keyInTemporalEase(1)[0].speed + " influence " +
       cp.keyInTemporalEase(1)[0].influence + ")");
assert(d.keyframeEasingNotScaled === undefined,
       "no easing left behind (got " +
       JSON.stringify(d.keyframeEasingNotScaled) + ")");
assert(near(cp.keyOutTemporalEase(2)[0].speed, 300),
       "temporal ease SPEED scales (units/second, so it overshoots " +
       "otherwise) -- got " + cp.keyOutTemporalEase(2)[0].speed);
assert(near(cp.keyOutTemporalEase(2)[0].influence, 30),
       "ease influence is a percentage and must NOT scale (got " +
       cp.keyOutTemporalEase(2)[0].influence + ")");

assert(hp.keyOutInterpolationType(1) === KeyframeInterpolationType.HOLD &&
       hp.keyInInterpolationType(1) === KeyframeInterpolationType.LINEAR &&
       hp.keyInInterpolationType(2) === KeyframeInterpolationType.HOLD,
       "HOLD and LINEAR keys keep their interpolation types (got " +
       hp.keyInInterpolationType(1) + "/" + hp.keyOutInterpolationType(1) +
       " " + hp.keyInInterpolationType(2) + ")");
assert(near(hp.keyValue(1)[0], 100) && near(hp.keyValue(2)[0], 500),
       "held layer's key values still scale (got " + hp.keyValue(2) + ")");

assert(near(gs.keyValue(2)[0], 100) && near(gs.keyValue(1)[0], 50),
       "keyed Scale values scale (got " + gs.keyValue(2) + ")");
assert(near(gs.keyOutTemporalEase(1)[0].speed, 20) &&
       gs.keyInTemporalEase(1).length === 3,
       "keyed Scale ease scales with the PADDED 3 dims a 2D layer needs " +
       "(got " + gs.keyInTemporalEase(1).length + " x " +
       gs.keyOutTemporalEase(1)[0].speed + ")");
assert(d.layersSkipped === undefined ||
       d.layersSkipped.join(" ").indexOf("grown") === -1,
       "keyed Scale layer not skipped over an ease-dimension refusal");

// ---- a camera parented to a null -------------------------------------
assert(near(camKid.zoom.value, 500),
       "a PARENTED camera still rescales its zoom -- zoom is not a " +
       "transform, so a parent inherits nothing of it (got " +
       camKid.zoom.value + ")");
assert(Array.isArray(d.parentedCamerasRezoomed) &&
       d.parentedCamerasRezoomed.indexOf("Camera Rigged") !== -1,
       "parented camera reported separately, not claimed as scaled (got " +
       JSON.stringify(d.parentedCamerasRezoomed) + ")");
assert(near(T(camKid)["ADBE Position"].value[2], -1000),
       "parented camera's TRANSFORM is still left to its parent (got " +
       T(camKid)["ADBE Position"].value + ")");

// Stub fidelity: the guards above are only meaningful if the stub really
// refuses these writes.
let threw = false;
const p = new Prop([0, 0, 0]);
p.locked = true;
try { p.setValue([1, 1, 1]); } catch (e) { threw = true; }
assert(threw, "stub fidelity: a locked property refuses setValue");

let easeThrew = false;
const sp = new Prop([100, 100, 100]);
sp.addKey(0, [100, 100, 100]);
try { sp.setTemporalEaseAtKey(1, [new KeyframeEase(0, 33)],
                                 [new KeyframeEase(0, 33)]); }
catch (e) { easeThrew = true; }
assert(easeThrew,
       "stub fidelity: a short ease array is refused, as AE refuses it");
let inflThrew = false;
try { new KeyframeEase(0, 0); } catch (e) { inflThrew = true; }
assert(inflThrew,
       "stub fidelity: KeyframeEase refuses influence 0, the value AE " +
       "reports for an un-eased keyframe side");
const fp = new Prop([0, 0, 0]);
fp.isSpatial = true;
fp.addKey(0, [0, 0, 0], { inType: KeyframeInterpolationType.HOLD,
                          outType: KeyframeInterpolationType.HOLD });
fp.setTemporalEaseAtKey(1, [new KeyframeEase(0, 33)],
                           [new KeyframeEase(0, 33)]);
assert(fp.keyOutInterpolationType(1) === KeyframeInterpolationType.BEZIER,
       "stub fidelity: writing an ease flips a HOLD key to bezier, as AE " +
       "does -- the reason the fix restores the types");

if (process.exitCode) console.error("\nTESTS FAILED");
else console.log("\nALL TESTS PASSED");
