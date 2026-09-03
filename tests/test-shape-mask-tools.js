// Regression test: Phase C — mask editing/animation and shape-layer
// contents against a stubbed AE object model.
"use strict";
const fs = require("fs");
const path = require("path");

function PGroup(name, matchName) {
  this.name = name;
  this.matchName = matchName || name;
  this._children = [];
}
PGroup.prototype.add = function (c) {
  c._parent = this;
  this._children.push(c);
  return c;
};
// Where an item sits in its parent's list. Shape contents are a STACK --
// a repeater/trim/offset acts on what is ABOVE it and addProperty always
// appends BELOW -- so the index is the only thing that says whether a
// filter does anything at all.
function propertyIndexGetter() {
  return this._parent ? this._parent._children.indexOf(this) + 1 : 0;
}
Object.defineProperty(PGroup.prototype, "propertyIndex",
                      { get: propertyIndexGetter });
Object.defineProperty(PGroup.prototype, "numProperties", {
  get() { return this._children.length; }
});
PGroup.prototype.property = function (ref) {
  if (typeof ref === "number") return this._children[ref - 1] || null;
  return this._children.find(c => c.name === ref || c.matchName === ref) ||
         null;
};
// PropertyBase.remove() for an indexed group's child (a mask in the Mask
// Parade): the siblings close up, and the removed object is INVALIDATED
// — AE throws "Object is invalid" on every later read of it. The host
// has to read the mask's name BEFORE removing it, and this is what
// catches a host that does not.
PGroup.prototype.remove = function () {
  if (!this._parent) throw new Error("After Effects error: Object is invalid");
  const sib = this._parent._children;
  sib.splice(sib.indexOf(this), 1);
  this._parent = null;
  Object.defineProperty(this, "name", {
    get() { throw new Error("After Effects error: Object is invalid"); }
  });
};

function Prop(name, matchName, value, min, max) {
  this.name = name;
  this.matchName = matchName || name;
  this._value = value;
  this.expression = "";
  this.expressionError = "";
  this.canSetExpression = true;
  this._keys = [];
  this.hasMin = typeof min === "number";
  this.hasMax = typeof max === "number";
  if (this.hasMin) this.minValue = min;
  if (this.hasMax) this.maxValue = max;
}
Object.defineProperty(Prop.prototype, "propertyIndex",
                      { get: propertyIndexGetter });
Object.defineProperty(Prop.prototype, "value", {
  get() { return this._value; }
});
Prop.prototype.setValue = function (v) {
  // AE's own out-of-range wording, measured on a repeater in AE 2026:
  // Copies -1 and Composite 3 both come back naming the range.
  if (typeof v === "number" && this.hasMin && v < this.minValue) {
    throw new Error("After Effects error: Unable to call “setValue” " +
      "because of parameter 1. Value " + v + " is less-than-" +
      this.minValue + ".");
  }
  if (typeof v === "number" && this.hasMax && v > this.maxValue) {
    throw new Error("After Effects error: Unable to call “setValue” " +
      "because of parameter 1. Value " + v + " out of range " +
      this.minValue + " to " + this.maxValue + ".");
  }
  if (this._keys.length) {
    // AE refuses a static write on top of keyframes; the host is expected
    // to say so itself rather than let this surface as a raw AE message.
    throw new Error("Cannot set a value on a property with keyframes");
  }
  this._value = v;
};
// Warnings AE queues and shows AFTER the script returns. Real AE puts up a
// MODAL for these and DISABLES its main window, so every later tool call is
// swallowed while the process still reports as healthy -- one bad mask call
// ends a panel session. A test that leaves anything here has driven AE into
// that state, so the suite treats a non-empty list as a failure.
const AE_MODALS = [];
Prop.prototype.setValueAtTime = function (t, v) {
  // "Preserve Constant Vertex and Feather Count" (General preferences, ON
  // by default): a Shape written with a different point count than the keys
  // already on this property is NOT rejected. AE keeps the mismatch, stops
  // interpolating, and queues the modal above. Measured in AE 2026.
  if (v && Array.isArray(v.vertices) && this._keys.length &&
      Array.isArray(this._keys[0].value && this._keys[0].value.vertices) &&
      this._keys[0].value.vertices.length !== v.vertices.length) {
    AE_MODALS.push("After Effects warning: deleting points or feathers " +
      "from an animated mask path deletes them from all keyframes for " +
      "that shape unless you turn off the Preserve Constant Vertex and " +
      "Feather Count option in the General Preferences dialog box.");
  }
  const hit = this._keys.find(k => Math.abs(k.time - t) < 1e-9);
  if (hit) { hit.value = v; return; }
  this._keys.push({ time: t, value: v });
  this._keys.sort((a, b) => a.time - b.time);
};
// Reading the shape BETWEEN keys is the only way to tell an animation from
// a pop -- numKeys reads 2 either way, which is exactly how the mismatched
// -count bug shipped.
Prop.prototype.valueAtTime = function (t) {
  const ks = this._keys;
  if (!ks.length) return this._value;
  if (t <= ks[0].time) return ks[0].value;
  if (t >= ks[ks.length - 1].time) return ks[ks.length - 1].value;
  let i = 0;
  while (i < ks.length - 1 && ks[i + 1].time <= t) i++;
  const a = ks[i].value, b = ks[i + 1].value;
  const u = (t - ks[i].time) / (ks[i + 1].time - ks[i].time);
  if (a && Array.isArray(a.vertices)) {
    // Different point counts do not interpolate: AE holds and then pops to
    // the later shape (measured -- every sampled frame after a 3-point key
    // already read the 5-point shape).
    if (a.vertices.length !== b.vertices.length) return b;
    const out = new Shape();
    out.closed = a.closed;
    out.vertices = a.vertices.map((v, j) =>
      [v[0] + (b.vertices[j][0] - v[0]) * u,
       v[1] + (b.vertices[j][1] - v[1]) * u]);
    return out;
  }
  if (typeof a === "number") return a + (b - a) * u;
  return a;
};
Object.defineProperty(Prop.prototype, "numKeys", {
  get() { return this._keys.length; }
});
Prop.prototype.keyTime = function (i) { return this._keys[i - 1].time; };
Prop.prototype.keyValue = function (i) { return this._keys[i - 1].value; };
Prop.prototype.removeKey = function (i) { this._keys.splice(i - 1, 1); };

// factory registry mimicking AE's addProperty for the match names we use
let maskCount = 0;
const REGISTRY = {
  "ADBE Mask Atom"() {
    const g = new PGroup("Mask " + (++maskCount), "ADBE Mask Atom");
    g.maskMode = 6501;
    g.inverted = false;
    g.add(new Prop("Mask Path", "ADBE Mask Shape", null));
    g.add(new Prop("Mask Feather", "ADBE Mask Feather", [0, 0]));
    g.add(new Prop("Mask Opacity", "ADBE Mask Opacity", 100));
    g.add(new Prop("Mask Expansion", "ADBE Mask Offset", 0));
    return g;
  },
  // A shape group's four real rows, measured in AE 2026. The items the
  // timeline shows under the group are NOT its children: they hang off
  // the nested "Contents" group, and its own "Transform" sits beside it.
  // Both halves matter -- the path everybody writes has to reach into
  // Contents, and a genuine "Transform" child has to keep winning.
  "ADBE Vector Group"() {
    const g = new PGroup("Group 1", "ADBE Vector Group");
    g.add(new Prop("Blend Mode", "ADBE Vector Blend Mode", 1));
    g.add(new PGroup("Contents", "ADBE Vectors Group"));
    const t = new PGroup("Transform", "ADBE Vector Transform Group");
    t.add(new Prop("Anchor Point", "ADBE Vector Anchor", [0, 0]));
    t.add(new Prop("Position", "ADBE Vector Position", [0, 0]));
    t.add(new Prop("Rotation", "ADBE Vector Rotation", 0));
    g.add(t);
    return g;
  },
  "ADBE Vector Shape - Rect"() {
    const g = new PGroup("Rectangle Path 1", "ADBE Vector Shape - Rect");
    g.add(new Prop("Size", "ADBE Vector Rect Size", [100, 100]));
    g.add(new Prop("Position", "ADBE Vector Rect Position", [0, 0]));
    g.add(new Prop("Roundness", "ADBE Vector Rect Roundness", 0));
    return g;
  },
  "ADBE Vector Shape - Star"() {
    const g = new PGroup("Polystar Path 1", "ADBE Vector Shape - Star");
    g.add(new Prop("Type", "ADBE Vector Star Type", 1));
    g.add(new Prop("Points", "ADBE Vector Star Points", 5));
    g.add(new Prop("Outer Radius", "ADBE Vector Star Outer Radius", 100));
    return g;
  },
  "ADBE Vector Graphic - Fill"() {
    const g = new PGroup("Fill 1", "ADBE Vector Graphic - Fill");
    g.add(new Prop("Color", "ADBE Vector Fill Color", [1, 1, 1, 1]));
    g.add(new Prop("Opacity", "ADBE Vector Fill Opacity", 100));
    return g;
  },
  "ADBE Vector Filter - Trim"() {
    const g = new PGroup("Trim Paths 1", "ADBE Vector Filter - Trim");
    g.add(new Prop("Start", "ADBE Vector Trim Start", 0));
    g.add(new Prop("End", "ADBE Vector Trim End", 100));
    g.add(new Prop("Offset", "ADBE Vector Trim Offset", 0));
    return g;
  },
  // Measured in AE 2026: Copies defaults to 1 with a floor of 0 and no
  // ceiling (1.5 is accepted), Composite's matchName is "...Repeater
  // Order" and its range is 1..2, and the six offsets live one level down
  // in the Transform block.
  "ADBE Vector Filter - Repeater"() {
    const g = new PGroup("Repeater 1", "ADBE Vector Filter - Repeater");
    g.add(new Prop("Copies", "ADBE Vector Repeater Copies", 1, 0));
    g.add(new Prop("Offset", "ADBE Vector Repeater Offset", 0));
    g.add(new Prop("Composite", "ADBE Vector Repeater Order", 1, 1, 2));
    const t = new PGroup("Transform", "ADBE Vector Repeater Transform");
    t.add(new Prop("Anchor Point", "ADBE Vector Repeater Anchor", [0, 0]));
    t.add(new Prop("Position", "ADBE Vector Repeater Position", [0, 0]));
    t.add(new Prop("Scale", "ADBE Vector Repeater Scale", [100, 100]));
    t.add(new Prop("Rotation", "ADBE Vector Repeater Rotation", 0));
    t.add(new Prop("Start Opacity",
                   "ADBE Vector Repeater Opacity 1", 100, 0, 100));
    t.add(new Prop("End Opacity",
                   "ADBE Vector Repeater Opacity 2", 100, 0, 100));
    g.add(t);
    return g;
  },
  "ADBE Vector Graphic - Stroke"() {
    const g = new PGroup("Stroke 1", "ADBE Vector Graphic - Stroke");
    g.add(new Prop("Color", "ADBE Vector Stroke Color", [1, 1, 1, 1]));
    g.add(new Prop("Stroke Width", "ADBE Vector Stroke Width", 2));
    return g;
  }
};
PGroup.prototype.canAddProperty = function (mn) { return !!REGISTRY[mn]; };
PGroup.prototype.addProperty = function (mn) {
  const f = REGISTRY[mn];
  if (!f) throw new Error("cannot add " + mn);
  return this.add(f());
};

// `box` is how big this layer really is, and `kind` is how AE will LIE
// about it. Measured in AE 2026 (scripts/layer-size-probe.jsx):
//
//   sourced (solid/footage/precomp/null)  .width/.height = the source's
//       size, and sourceRectAtTime starts at 0,0 — the box IS the size
//   text / shape                          .width/.height = the COMP's
//       dimensions (1920x1080 for a 147x28 "HELLO"), and the only honest
//       box is sourceRectAtTime's, whose origin is the text BASELINE:
//       "HELLO" measured left 3.487, top -49.568
//   camera / light                        neither property exists
//
// Without this, add_mask cannot tell a mask aimed at the layer from one
// aimed at the comp — which is how four phrasings of "hide half of Beta"
// all masked a 100x100 layer with 1920x1080 and were answered `ok`.
function Layer(name, comp, isShape, box, kind) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this._kind = kind || (isShape ? "shape" : "sourced");
  if (this._kind === "sourced") {
    const b = box || { left: 0, top: 0, width: comp.width, height: comp.height };
    this.width = b.width;
    this.height = b.height;
    this.source = { width: b.width, height: b.height };
    this._rect = { top: 0, left: 0, width: b.width, height: b.height };
  } else if (this._kind !== "camera" && this._kind !== "light") {
    // The lie, on purpose: a text or shape layer answers with the comp.
    this.width = comp.width;
    this.height = comp.height;
    this._rect = box
      ? { top: box.top, left: box.left, width: box.width, height: box.height }
      : { top: 0, left: 0, width: 0, height: 0 };
  }
  if (this._kind !== "camera" && this._kind !== "light") {
    this.sourceRectAtTime = function () { return this._rect; };
  }
  this._root = new PGroup("(layer)", "(layer)");
  const t = new PGroup("Transform", "ADBE Transform Group");
  t.add(new Prop("Position", "ADBE Position", [100, 100]));
  t.add(new Prop("Opacity", "ADBE Opacity", 100));
  this._root.add(t);
  this._root.add(new PGroup("Masks", "ADBE Mask Parade"));
  if (isShape) {
    this._root.add(new PGroup("Contents", "ADBE Root Vectors Group"));
  }
}
Object.defineProperty(Layer.prototype, "numProperties", {
  get() { return this._root._children.length; }
});
Layer.prototype.property = function (ref) { return this._root.property(ref); };
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});

function Comp(name) {
  this.name = name;
  this._layers = [];
  this.time = 0;
  this.width = 1920;
  this.height = 1080;
  this.duration = 10;
  // A comp with no frame rate is why off-grid keyframe times were
  // invisible to CI: AE stores whatever fraction of a second it is handed,
  // and the shape asked for is then never on a rendered frame.
  this.frameRate = 30;
  this.frameDuration = 1 / 30;
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
function Shape() {
  this.closed = false;
  this.vertices = [];
  this.inTangents = [];
  this.outTangents = [];
}
const MaskMode = { NONE: 6500, ADD: 6501, SUBTRACT: 6502, INTERSECT: 6503,
                   LIGHTEN: 6504, DARKEN: 6505, DIFFERENCE: 6506 };

const comp = new Comp("MaskShapes");
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
const footage = new Layer("Footage", comp, false);
const shapeL = new Layer("Shapes", comp, true);
comp._layers.push(footage, shapeL);

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

// 1. mask lifecycle: create, edit, animate
let r = call("add_mask", { layer: "Footage", shape: "rectangle",
                           bounds: [0, 0, 400, 300] });
assert(r.ok, "add_mask succeeds: " + (r.error || ""));
const mask = footage.property("Masks").property(1);
r = call("set_mask", { layer: "Footage", mode: "subtract", feather: 12,
                       expansion: -5, opacity: 80, inverted: true,
                       name: "Cutout" });
assert(r.ok, "set_mask edits the only mask without naming it: " +
       (r.error || ""));
assert(mask.maskMode === MaskMode.SUBTRACT && mask.inverted === true &&
       mask.name === "Cutout",
       "mode/inverted/name applied");
assert(JSON.stringify(mask.property("Mask Feather").value) === "[12,12]" &&
       mask.property("Mask Expansion").value === -5 &&
       mask.property("Mask Opacity").value === 80,
       "feather broadcast to [x,y], expansion, opacity applied");

// replace the path, then animate it
r = call("set_mask_path", { layer: "Footage", mask: "Cutout",
  vertices: [[0, 0], [500, 0], [500, 400], [0, 400]] });
assert(r.ok && mask.property("Mask Path").value.vertices.length === 4,
       "set_mask_path replaces the static path");
r = call("set_mask_path", { layer: "Footage", mask: "Cutout", keys: [
  { time: 0, vertices: [[0, 0], [100, 0], [100, 100]] },
  { time: 1, vertices: [[0, 0], [300, 0], [300, 300]] }
] });
assert(r.ok && r.data.keysSet === 2 &&
       mask.property("Mask Path").numKeys === 2,
       "keys animate the mask path (2 keyframes)");
assert(mask.property("Mask Path").keyValue(2).vertices[1][0] === 300,
       "keyframed shapes carry their own vertices");

// 1b. the mask has to ANIMATE, not just carry keyframes
const mpath = mask.property("Mask Path");
assert(mpath.valueAtTime(0.5).vertices[1][0] === 200,
       "mask path interpolates between keys (x=200 halfway from 100 to 300)");
assert(r.data.points === 3 && JSON.stringify(r.data.keyTimes) === "[0,1]" &&
       JSON.stringify(r.data.keyFrames) === "[0,30]",
       "result names the point count and where the keys landed");

// keys off the frame grid land on frames, and say that they moved
const off = new Layer("Off Grid", comp, false);
comp._layers.push(off);
call("add_mask", { layer: "Off Grid", shape: "rectangle" });
r = call("set_mask_path", { layer: "Off Grid", keys: [
  { time: 0.34, vertices: [[0, 0], [100, 0], [100, 100]] },
  { time: 0.71, vertices: [[0, 0], [200, 0], [200, 200]] }
] });
const offPath = off.property("Masks").property(1).property("Mask Path");
assert(r.ok && r.data.snappedToFrames === 2 &&
       JSON.stringify(r.data.keyFrames) === "[10,21]",
       "off-grid key times snap to whole frames and are reported: " +
       (r.error || JSON.stringify(r.data.keyFrames)));
assert(Math.abs(offPath.keyTime(2) - 21 / 30) < 1e-9 &&
       offPath.valueAtTime(21 / 30).vertices[1][0] === 200,
       "the shape asked for is now ON a rendered frame (frame 21 = 200px)");

// mismatched point counts: refused, nothing written, no AE modal queued
const mixL = new Layer("Mixed", comp, false);
comp._layers.push(mixL);
call("add_mask", { layer: "Mixed", shape: "rectangle" });
r = call("set_mask_path", { layer: "Mixed", keys: [
  { time: 0, vertices: [[0, 0], [100, 0], [100, 100]] },
  { time: 1, vertices: [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]] }
] });
const mixPath = mixL.property("Masks").property(1).property("Mask Path");
assert(!r.ok && /same number of points/.test(r.error) &&
       /keys\[1\] has 5 but keys\[0\] has 3/.test(r.error),
       "mixed point counts refused, naming both counts: " + r.error);
assert(/POP/.test(r.error) && /modal/.test(r.error) &&
       /repeat a vertex/.test(r.error),
       "the refusal explains the pop, the modal, and the way out");
assert(mixPath.numKeys === 0,
       "a refused batch writes NOTHING (numKeys " + mixPath.numKeys + ")");
assert(AE_MODALS.length === 0,
       "no AE modal was queued: " + AE_MODALS.join(" | "));

// the stub really can catch this: driving AE the old way DOES queue one
mixPath.setValueAtTime(0, { vertices: [[0, 0], [1, 0], [1, 1]] });
mixPath.setValueAtTime(1, { vertices: [[0, 0], [1, 0], [1, 1], [0, 1]] });
assert(AE_MODALS.length === 1 && /Preserve Constant Vertex/.test(AE_MODALS[0]),
       "stub fidelity: an unguarded mismatched write queues AE's modal");
assert(mixPath.valueAtTime(0.5).vertices.length === 4,
       "stub fidelity: mismatched keys hold and POP, they do not tween");
while (mixPath.numKeys) mixPath.removeKey(1);
AE_MODALS.length = 0;

// adding a mismatched key to an already-animated path is the same trap
r = call("set_mask_path", { layer: "Footage", mask: "Cutout", atTime: 2,
  vertices: [[0, 0], [10, 0], [10, 10], [0, 10]] });
assert(!r.ok && /this shape has 4 but the existing keys have 3/.test(r.error) &&
       /remove_keyframes/.test(r.error),
       "atTime against existing keys refused, and points at the way out: " +
       r.error);
assert(mpath.numKeys === 2 && AE_MODALS.length === 0,
       "the existing animation is untouched by the refusal");

// a bad key in the MIDDLE must not leave the first one written
r = call("set_mask_path", { layer: "Mixed", keys: [
  { time: 0, vertices: [[0, 0], [100, 0], [100, 100]] },
  { time: 0.5, vertices: [[0, 0], [100, 0]] },
  { time: 1, vertices: [[0, 0], [200, 0], [200, 200]] }
] });
assert(!r.ok && /keys\[1\]: 'vertices'/.test(r.error) &&
       mixPath.numKeys === 0,
       "validation happens before any write: " + r.error);

// two times that snap onto the same frame would silently overwrite
r = call("set_mask_path", { layer: "Mixed", keys: [
  { time: 0, vertices: [[0, 0], [100, 0], [100, 100]] },
  { time: 0.5, vertices: [[0, 0], [150, 0], [150, 150]] },
  { time: 0.51, vertices: [[0, 0], [200, 0], [200, 200]] }
] });
assert(!r.ok && /both land on the same frame/.test(r.error) &&
       /frame 15/.test(r.error) && mixPath.numKeys === 0,
       "colliding key times refused instead of one key vanishing: " + r.error);

// one tangent per point, or AE gets a corrupt path
r = call("set_mask_path", { layer: "Mixed", keys: [
  { time: 0, vertices: [[0, 0], [100, 0], [100, 100]],
    inTangents: [[-10, 0], [0, -10]] },
  { time: 1, vertices: [[0, 0], [200, 0], [200, 200]] }
] });
assert(!r.ok && /'inTangents' has 2 entries but 'vertices' has 3/
         .test(r.error) && mixPath.numKeys === 0,
       "short tangent list refused: " + r.error);

// keys that all hold the same shape are not an animation
r = call("set_mask_path", { layer: "Mixed", keys: [
  { time: 0, vertices: [[0, 0], [100, 0], [100, 100]] },
  { time: 1, vertices: [[0, 0], [100, 0], [100, 100]] }
] });
assert(r.ok && r.data.stillFrame === true &&
       /will not move/.test(r.data.note),
       "identical keys reported as a still, not as an animation");

// a static path on top of keyframes: named, not an AE exception
r = call("set_mask_path", { layer: "Mixed",
  vertices: [[0, 0], [50, 0], [50, 50]] });
assert(!r.ok && /already animated \(2 keyframes\)/.test(r.error) &&
       /Pass 'atTime'/.test(r.error),
       "static write over an animated path refused in the tool's own words: " +
       r.error);

// grounded errors
r = call("set_mask", { layer: "Footage", mask: "Nope", feather: 1 });
assert(!r.ok && /Masks here: Cutout/.test(r.error),
       "missing mask error lists real masks");
r = call("set_mask", { layer: "Footage" });
assert(!r.ok && /Nothing to change/.test(r.error),
       "no-op set_mask refused with guidance");

// 2. shape contents: group, shapes, fill, trim, repeater
r = call("add_shape_content", { layer: "Shapes", kind: "group",
                                name: "Badge" });
assert(r.ok && r.data.added === "Badge", "group added and renamed");
r = call("add_shape_content", { layer: "Shapes", kind: "rectangle",
  group: "Badge", params: { Size: [200, 80], Roundness: 12 } });
assert(r.ok && r.data.container === "Badge",
       "rectangle added inside the group: " + (r.error || ""));
const badge = shapeL.property("Contents").property("Badge");
const rect = badge.property("Contents").property("Rectangle Path 1");
assert(JSON.stringify(rect.property("Size").value) === "[200,80]" &&
       rect.property("Roundness").value === 12,
       "params applied by display name");
r = call("add_shape_content", { layer: "Shapes", kind: "fill",
  group: "Badge", params: { Color: [1, 0, 0, 1] } });
assert(r.ok && JSON.stringify(badge.property("Contents")
         .property("Fill 1").property("Color").value) === "[1,0,0,1]",
       "fill with color added inside the group");
r = call("add_shape_content", { layer: "Shapes", kind: "trim_paths",
  group: "Badge", params: { End: 0 } });
assert(r.ok && badge.property("Contents").property("Trim Paths 1")
         .property("End").value === 0,
       "trim paths added with End=0 (wipe-on ready)");
r = call("add_shape_content", { layer: "Shapes", kind: "repeater",
  group: "Badge", params: { Copies: 6, Position: [150, 0] } });
const rep = badge.property("Contents").property("Repeater 1");
assert(r.ok && rep.property("Copies").value === 6 &&
       JSON.stringify(rep.property("Transform").property("Position").value)
         === "[150,0]",
       "repeater params reach nested Transform/Position");

// polygon flips the star type
r = call("add_shape_content", { layer: "Shapes", kind: "polygon",
                                group: "Badge" });
assert(r.ok && badge.property("Contents").property("Polystar Path 1")
         .property("Type").value === 2,
       "polygon kind sets star Type=2");

// 3. grounded failures
r = call("add_shape_content", { layer: "Footage", kind: "fill" });
assert(!r.ok && /not a SHAPE layer/.test(r.error),
       "non-shape layer refused with guidance");
r = call("add_shape_content", { layer: "Shapes", kind: "sparkles" });
assert(!r.ok && /Kinds: /.test(r.error) && /trim_paths/.test(r.error),
       "unknown kind lists the real kinds");
r = call("add_shape_content", { layer: "Shapes", kind: "rectangle",
  group: "NoSuchGroup" });
assert(!r.ok && /Groups here: Badge/.test(r.error),
       "missing group error lists real groups");
r = call("add_shape_content", { layer: "Shapes", kind: "fill",
  group: "Badge", params: { Colour: [1, 0, 0, 1] } });
assert(!r.ok && /Its params: /.test(r.error) && /Color/.test(r.error),
       "bad param name lists the item's real params");

// 4. integration: the added content is reachable via universal paths
r = call("set_property", { layer: "Shapes",
  property: "contents/Badge/Contents/Trim Paths 1/End", value: 50 });
assert(r.ok && badge.property("Contents").property("Trim Paths 1")
         .property("End").value === 50,
       "universal set_property reaches shape contents by path");

// 5. THE path everybody actually writes.
// AE's timeline draws no "Contents" row under a group, so every path in
// this project's docs, in its system prompt's trim-paths recipe and in
// add_shape_content's own returned note left that segment out -- and
// every one of them failed. The short form has to resolve.
r = call("set_property", { layer: "Shapes",
  property: "contents/Badge/Trim Paths 1/End", value: 25 });
assert(r.ok && badge.property("Contents").property("Trim Paths 1")
         .property("End").value === 25,
       "the path AE's UI implies -- no second 'Contents' -- resolves: " +
       (r.error || ""));
r = call("set_property", { layer: "Shapes",
  property: "contents/Badge/Repeater 1/Transform/Rotation", value: 60 });
assert(r.ok && badge.property("Contents").property("Repeater 1")
         .property("Transform").property("Rotation").value === 60,
       "and keeps working one level deeper, into the repeater's offsets: " +
       (r.error || ""));

// A real child called "Transform" is the GROUP's own, never the one a
// hop away inside Contents.
r = call("set_property", { layer: "Shapes",
  property: "contents/Badge/Transform/Rotation", value: 15 });
assert(r.ok && badge.property("Transform").property("Rotation").value === 15 &&
       badge.property("Contents").property("Repeater 1")
         .property("Transform").property("Rotation").value === 60,
       "a direct child still shadows the same name inside Contents");

// The note the tool hands back must be a path that WORKS -- handing the
// model a broken one is how this stayed hidden.
r = call("add_shape_content", { layer: "Shapes", kind: "group",
                                name: "Ring" });
r = call("add_shape_content", { layer: "Shapes", kind: "star",
                                group: "Ring" });
r = call("add_shape_content", { layer: "Shapes", kind: "repeater",
  group: "Ring", params: { Copies: 6, Rotation: 60 } });
assert(r.ok && !r.warning, "repeater added under a star: " + (r.error || ""));
const noted = /'([^']*)<param>'/.exec(r.data.note);
assert(noted, "the result quotes an animatable path: " + r.data.note);
const probe = call("get_property", { layer: "Shapes",
                                     property: noted[1] + "Copies" });
assert(probe.ok && probe.data.value === 6,
       "the path in the tool's own note resolves: " + noted[1] + "Copies " +
       (probe.error || ""));
const noted2 = /'([^']*Transform\/Position)'/.exec(r.data.note);
assert(noted2 && call("get_property", { layer: "Shapes",
         property: noted2[1] }).ok,
       "and so does the Transform path it points a repeater's offsets at");

// 6. shape contents are a STACK: a filter changes what is ABOVE it, and
// every new item lands BELOW -- so a repeater added to an empty group is
// a no-op that adding the shape afterwards does NOT rescue.
call("add_shape_content", { layer: "Shapes", kind: "group", name: "Late" });
r = call("add_shape_content", { layer: "Shapes", kind: "repeater",
                                group: "Late", params: { Copies: 4 } });
assert(r.ok && r.data.warning, "a repeater with nothing above it warns: " +
       JSON.stringify(r.data));
assert(/WAS added/.test(r.data.warning) &&
       /ABOVE it/.test(r.data.warning) &&
       /will NOT fix this/.test(r.data.warning),
       "the warning says it landed, what the rule is, and that adding " +
       "the shape now does not help: " + r.data.warning);
r = call("add_shape_content", { layer: "Shapes", kind: "rectangle",
                                group: "Late" });
assert(r.ok && !r.data.warning, "a plain shape never warns");
r = call("add_shape_content", { layer: "Shapes", kind: "trim_paths",
                                group: "Late" });
assert(r.ok && !r.data.warning,
       "with geometry above it, a filter is silent");
// A fill is not geometry: it colours a path and draws nothing by itself.
call("add_shape_content", { layer: "Shapes", kind: "group", name: "Painty" });
call("add_shape_content", { layer: "Shapes", kind: "fill", group: "Painty" });
r = call("add_shape_content", { layer: "Shapes", kind: "trim_paths",
                                group: "Painty" });
assert(r.ok && r.data.warning,
       "a fill alone does not count as something to filter");

// 7. AE's own ranges, surfaced instead of swallowed
r = call("add_shape_content", { layer: "Shapes", kind: "repeater",
  group: "Late", params: { Copies: -1 } });
assert(!r.ok && /Copies/.test(r.error) && /less-than-0/.test(r.error),
       "a negative Copies is refused in AE's words: " + r.error);
r = call("add_shape_content", { layer: "Shapes", kind: "repeater",
  group: "Late", params: { Composite: 3 } });
assert(!r.ok && /range 1 to 2/.test(r.error),
       "Composite outside 1..2 is refused with the range: " + r.error);

// 8. a missing segment names what the TIMELINE shows, not the four rows
// scripting sees -- "Blend Mode, Contents, Transform" helps nobody who is
// looking at a rectangle.
r = call("set_property", { layer: "Shapes",
  property: "contents/Badge/Nope/End", value: 1 });
assert(!r.ok && /inside Contents:/.test(r.error) &&
       /Rectangle Path 1/.test(r.error),
       "a bad segment under a group lists the items inside it: " + r.error);

// 9. delete_mask (audit 0.11 item 4). "Take the mask off" had no tool;
// a reverted host answers "Unknown tool: delete_mask" to every call
// below. Footage carries the animated "Cutout" from section 1.
const maskNames = (L) => {
  const g = L.property("ADBE Mask Parade");
  const out = [];
  for (let i = 1; i <= g.numProperties; i++) out.push(g.property(i).name);
  return out.join(", ");
};
r = call("add_mask", { layer: "Footage", name: "Bottom", shape: "rectangle",
                       bounds: [0, 150, 400, 150] });
assert(r.ok && maskNames(footage) === "Cutout, Bottom",
       "a second mask to delete by index (holds: " + maskNames(footage) + ")");
r = call("delete_mask", { layer: "Footage", mask: 2 });
assert(r.ok, "delete_mask by 1-based index: " + (r.error || ""));
assert(r.ok && r.data.layer === "Footage" && r.data.removed === "Bottom" &&
       r.data.remainingMasks.join(", ") === "Cutout",
       "receipt: {layer, removed, remainingMasks} (got " +
       JSON.stringify(r.ok ? r.data : r.error) + ")");
assert(maskNames(footage) === "Cutout",
       "the parade really lost it (holds: " + maskNames(footage) + ")");
r = call("delete_mask", { layer: "Footage", mask: "Nope" });
assert(!r.ok && /Mask not found on 'Footage': Nope/.test(r.error) &&
       /Masks here: Cutout/.test(r.error),
       "a miss lists the real masks (AELL_findMask's grounding): " + r.error);
assert(maskNames(footage) === "Cutout", "…and removed nothing");
// A numeric STRING is the 1-based index the doc promises, not a name.
r = call("add_mask", { layer: "Footage", name: "Third", shape: "rectangle" });
assert(r.ok && maskNames(footage) === "Cutout, Third", "a mask at index 2");
r = call("set_mask", { layer: "Footage", mask: "2", feather: 3 });
assert(r.ok && r.data.mask === "Third",
       "mask: \"2\" resolves as index 2 (got " +
       JSON.stringify(r.ok ? r.data : r.error) + ")");
r = call("delete_mask", { layer: "Footage", mask: "2" });
assert(r.ok && r.data.removed === "Third" && maskNames(footage) === "Cutout",
       "delete_mask {mask: \"2\"} deletes the second mask: " +
       JSON.stringify(r.ok ? r.data : r.error));
// One mask and no ref: that mask, the same rule set_mask follows.
r = call("delete_mask", { layer: "Footage" });
assert(r.ok && r.data.removed === "Cutout" &&
       r.data.remainingMasks.length === 0,
       "the only mask goes without being named: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(footage.property("ADBE Mask Parade").numProperties === 0,
       "the animated mask is gone, keys and all");
r = call("delete_mask", { layer: "Footage" });
assert(!r.ok && /'Footage' has no masks/.test(r.error) &&
       /add_mask creates one/.test(r.error),
       "a layer with no masks is refused, pointing at add_mask: " + r.error);
// A layer type with no Mask Parade at all (camera/light): refused by type.
const noMasks = new Layer("Cam", comp, false);
noMasks._root._children = noMasks._root._children
  .filter(c => c.matchName !== "ADBE Mask Parade");
Object.setPrototypeOf(noMasks, Object.create(CameraLayer.prototype,
  Object.getOwnPropertyDescriptors(Layer.prototype)));
comp._layers.push(noMasks);
r = call("delete_mask", { layer: "Cam", mask: 1 });
assert(!r.ok && /'Cam' is a camera layer and cannot carry masks/.test(r.error),
       "no Mask Parade: refused by layer type: " + r.error);
comp._layers.pop();
// {layer} omitted = the selection, and the selection survives the call.
comp._layers.forEach(l => { l.selected = l === off; });
r = call("delete_mask", {});
assert(r.ok && r.data.layer === "Off Grid" && r.data.removed === "Mask 2" &&
       off.property("ADBE Mask Parade").numProperties === 0,
       "no {layer}: the selected layer's only mask goes: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(comp.selectedLayers.length === 1 && comp.selectedLayers[0] === off,
       "…and Off Grid is still the selection afterwards");
comp._layers.forEach(l => { l.selected = false; });

// ---------------------------------------------------------------------
// 6. A mask has to land ON the layer it is aimed at.
//
// Measured in real AE 2026 through the chat probe: "hide half of Beta"
// reached add_mask with bounds [0, 540, 1920.0001, 540] — the COMP's
// dimensions, halved — on a 100x100 solid, in FOUR different phrasings.
// AE took it without a murmur (the probe set the same comp-sized shape
// by hand and nothing threw), the mask hid the entire layer, and the
// tool answered `ok`. The model was not guessing: add_mask's doc says
// "sizes from get_comp_details" and that result carried no layer size at
// all, so 1920x1080 was the only figure in front of it.
const beta = new Layer("Beta", comp, false, { width: 100, height: 100 });
comp._layers.push(beta);
const betaMasks = beta.property("ADBE Mask Parade");

r = call("add_mask", { layer: "Beta", shape: "rectangle",
                       bounds: [0, 540, 1920.00012207031, 540] });
assert(!r.ok, "the comp-sized mask that four phrasings produced is now " +
       "REFUSED, not answered ok: " + JSON.stringify(r.ok ? r.data : ""));
assert(/misses 'Beta' completely/.test(r.error) &&
       /100x100/.test(r.error) && /\[0, 0, 100, 100\]/.test(r.error),
       "…and the refusal names the layer's REAL size and box, the way " +
       "every other failed lookup here does: " + r.error);
assert(/LAYER space/.test(r.error) && /1920x1080/.test(r.error),
       "…and says which of the two numbers it was handed is the comp's: " +
       r.error);
assert(betaMasks.numProperties === 0,
       "a refused mask writes NOTHING (" + betaMasks.numProperties + ")");

// The stub is only worth having if it would have PASSED the old code:
// nothing in AE rejects those vertices, which is why this needed a tool.
const proof = new Shape();
proof.vertices = [[0, 540], [1920, 540], [1920, 1080], [0, 1080]];
let threw = false;
try { betaMasks.add(new PGroup("Proof", "ADBE Mask Atom")); } catch (e) { threw = true; }
assert(!threw, "AE itself takes an off-layer mask silently (measured) — " +
       "the refusal has to come from the tool, not from AE");
betaMasks._children.length = 0;

// The aimed version of the same sentence goes through, unremarked.
r = call("add_mask", { layer: "Beta", name: "Half", shape: "rectangle",
                       bounds: [0, 50, 100, 50] });
assert(r.ok && !r.data.note,
       "the same request in LAYER space is accepted with no complaint: " +
       JSON.stringify(r.ok ? r.data : r.error));

// The other half of the same field mistake: comp coordinates that happen
// to OVERLAP. "I only want to see the top half of Beta" reached add_mask
// with [0, 0, 1920.0001, 540] on the same 100x100 layer — that swallows
// the layer whole, so the mask changes nothing, and the tool said ok.
r = call("add_mask", { layer: "Beta", name: "Swallow", shape: "rectangle",
                       bounds: [0, 0, 1920.00012207031, 540] });
assert(!r.ok && /covers ALL of 'Beta'/.test(r.error) &&
       /100x100/.test(r.error),
       "a mask that SWALLOWS the layer is refused too — it hides nothing: " +
       (r.ok ? JSON.stringify(r.data) : r.error));
assert(/\[0, 0, 100, 50\]/.test(r.error),
       "…and the refusal works out the top half of THIS layer for it: " +
       r.error);

// Overhanging on one side is a mistake the tool cannot prove — part of
// the layer is still masked — so it lands with the real size attached.
r = call("add_mask", { layer: "Beta", name: "Over", shape: "rectangle",
                       bounds: [-20, 40, 80, 40] });
assert(r.ok && /past 'Beta'/.test(r.data.note || "") &&
       /100x100/.test(r.data.note || ""),
       "a mask that overhangs the layer still lands, with the real size " +
       "in the receipt: " + JSON.stringify(r.ok ? r.data : r.error));

// No bounds at all used to mean layer.width || comp.width. On Beta that
// was right by luck; on a text layer it is the comp's size.
r = call("add_mask", { layer: "Beta", name: "Whole", shape: "rectangle" });
assert(r.ok && !r.data.note,
       "default bounds are the LAYER's box, so they cannot overhang it: " +
       JSON.stringify(r.ok ? r.data : r.error));
const whole = betaMasks.property("Whole").property("ADBE Mask Shape").value;
assert(JSON.stringify(whole.vertices) === "[[0,0],[100,0],[100,100],[0,100]]",
       "…and they are 100x100, not the comp's 1920x1080: " +
       JSON.stringify(whole.vertices));
assert(!r.data.warning,
       "…and the tool's OWN default is never warned about — add_mask then " +
       "set_mask_path opens with exactly this placeholder: " +
       JSON.stringify(r.data));

// ---------------------------------------------------------------------
// 6b. A feather is not a blur.
//
// Measured in real AE 2026 through the chat probe, row 35 ("the
// background is too sharp behind the icons"): the model reached
// add_mask {shape: 'custom', vertices: the layer's own four corners,
// feather: 50} on a 1920x1080 BG, got a bare `ok`, and told the user the
// background had been softened. Nothing was softened — a mask feather
// fades the mask EDGE and never touches a pixel inside the region, so a
// region that IS the whole layer cannot blur anything.
//
// This falls between the two refusals above: it does not MISS the layer
// and it is not BIGGER than the layer on any side, so neither fires. It
// is not refused either — a full-layer feather is a real edge fade — so
// the receipt carries the warning instead.
r = call("add_mask", { layer: "Beta", name: "Soft", shape: "custom",
                       vertices: [[0, 0], [100, 0], [100, 100], [0, 100]],
                       feather: 50 });
assert(r.ok, "the field's own call still lands (it is a warning, not a " +
       "refusal): " + (r.error || ""));
assert(/covers all of 'Beta'/.test(r.data.warning || "") &&
       /100x100/.test(r.data.warning || ""),
       "…carrying a warning that names the layer and its real size: " +
       JSON.stringify(r.data));
assert(/OUTER EDGE/.test(r.data.warning || "") &&
       /does not blur the picture/.test(r.data.warning || ""),
       "…and says what the feather actually did: " + r.data.warning);
assert(/apply_effect/.test(r.data.warning || "") &&
       /Gaussian Blur/.test(r.data.warning || ""),
       "…and names the call that DOES blur the picture, the way every " +
       "other grounded message here offers a way out: " + r.data.warning);
assert(!!betaMasks.property("Soft"),
       "…and the mask it warns about was really created");

// The same coverage with no feather is the other half: a pure no-op, and
// the way out is a real region, not a blur.
r = call("add_mask", { layer: "Beta", name: "Flat", shape: "rectangle",
                       bounds: [0, 0, 100, 100] });
assert(r.ok && /covers all of 'Beta'/.test(r.data.warning || "") &&
       /still shows/.test(r.data.warning || "") &&
       /bounds/.test(r.data.warning || ""),
       "an unfeathered full-layer mask is warned about too, pointing at " +
       "bounds: " + JSON.stringify(r.ok ? r.data : r.error));
assert(!/Gaussian Blur/.test(r.data.warning || ""),
       "…and does NOT offer a blur nobody asked for: " + r.data.warning);

// One-sided, like every other verdict here: it says "cuts nothing away"
// only where that is PROVED. Inverted and subtract both cut the whole
// layer away at full coverage, which is a change, not a no-op.
r = call("add_mask", { layer: "Beta", name: "Inv", shape: "rectangle",
                       bounds: [0, 0, 100, 100], inverted: true,
                       feather: 50 });
assert(r.ok && !r.data.warning,
       "an INVERTED full-layer mask hides everything — no warning: " +
       JSON.stringify(r.ok ? r.data : r.error));
r = call("add_mask", { layer: "Beta", name: "Sub", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "subtract",
                       feather: 50 });
assert(r.ok && !r.data.warning,
       "…and so does a SUBTRACT one: " +
       JSON.stringify(r.ok ? r.data : r.error));

// A feather on a real region is the vignette the rules send here. Silent.
r = call("add_mask", { layer: "Beta", name: "Vignette", shape: "ellipse",
                       bounds: [10, 10, 80, 80], feather: 20 });
assert(r.ok && !r.data.warning,
       "a feathered mask that DOES cut something away is left alone — " +
       "that is the vignette the rules route here: " +
       JSON.stringify(r.ok ? r.data : r.error));

// A TEXT layer is the case where .width/.height cannot be used at all:
// AE answers with the comp's dimensions, and the layer's origin is the
// BASELINE, so even [0, 0, w, h] is the wrong rectangle — it sits
// entirely below the glyphs.
const hello = new Layer("HELLO", comp, false,
  { left: 3.487, top: -49.568, width: 146.671, height: 28.017 }, "text");
comp._layers.push(hello);
assert(hello.width === 1920 && hello.height === 1080,
       "stub: a text layer's .width/.height ARE the comp's (measured)");
r = call("add_mask", { layer: "HELLO", shape: "rectangle",
                       bounds: [0, 0, 1920, 540] });
assert(!r.ok && /misses 'HELLO' completely/.test(r.error) &&
       /146\.671x28\.017/.test(r.error),
       "a text layer masked from 0,0 misses it — the origin is the " +
       "baseline, and the refusal says where the layer actually is: " +
       (r.ok ? JSON.stringify(r.data) : r.error));
r = call("add_mask", { layer: "HELLO", name: "OnText", shape: "rectangle" });
const onText = hello.property("ADBE Mask Parade").property("OnText")
  .property("ADBE Mask Shape").value;
assert(r.ok && onText.vertices[0][1] === -49.568,
       "…and default bounds come from the measured box, negative top " +
       "and all: " + JSON.stringify(r.ok ? onText.vertices : r.error));

// An EMPTY shape layer measures 0x0, which is no box at all — the tool
// must not invent one and refuse on it.
const emptyShape = new Layer("Empty Shape", comp, true, null, "shape");
comp._layers.push(emptyShape);
r = call("add_mask", { layer: "Empty Shape", shape: "rectangle",
                       bounds: [0, 0, 200, 200] });
assert(r.ok && !r.data.note,
       "a layer with no measurable box is not second-guessed: " +
       JSON.stringify(r.ok ? r.data : r.error));

assert(AE_MODALS.length === 0,
       "no tool call left After Effects behind a modal dialog: " +
       AE_MODALS.join(" | "));

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
