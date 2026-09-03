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

// The tools come out through $.global.AELL_call as always; the two mask
// READERS come out by name because what they answer is the thing under
// test in section 6f — a receipt only shows the reading through a
// sentence, and "all" and "none" can produce the same sentence.
// (tests/test-light.js has used this shape since 0.9.x.)
const host = eval(fs.readFileSync(path.join(__dirname, "..", "extension",
                                "jsx", "hostscript.jsx"), "utf8") +
  ";\n({ AELL_paradeShows: AELL_paradeShows, AELL_maskRegion: AELL_maskRegion })");
const { AELL_paradeShows, AELL_maskRegion } = host;

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

// 9b. ZERO masks is its own answer (real AE, chat probe 2026-09-03).
//
// AELL_findMask's roster branch used to answer a MASKLESS layer with
// "(several masks - pass {mask: name|index}). Masks here: (none -
// add_mask creates one)". Both halves did harm and in opposite
// directions: the first is false where it matters most (there are no
// masks, and it reads as "there are, name one"), and the second is an
// INSTRUCTION the small model obeys. Measured: "Soften the background a
// touch." and "sofetn the backgrond layer a touch" both called
// set_mask {layer: "BG", feather: 10}, read that tail, and went on to
// add_mask - a full-frame feathered mask that softens nothing, graded
// HARM twice over. A feather on a maskless layer is the one ask a mask
// cannot answer, so it is sent to apply_effect and add_mask is NOT
// offered (remove_effect's door-closing shape, 0.11.13). Every other
// edit still names add_mask - there the caller does want a mask.
assert(footage.property("ADBE Mask Parade").numProperties === 0,
       "9b starts from a maskless layer");
r = call("set_mask", { layer: "Footage", feather: 10 });
assert(!r.ok, "set_mask {feather} on a maskless layer is refused: " +
       JSON.stringify(r.ok ? r.data : ""));
assert(!/several masks/.test(r.error),
       "...and never claims 'several masks' on a layer that has none: " +
       r.error);
assert(!/add_mask/.test(r.error),
       "...and does NOT offer add_mask - that tail is what the model " +
       "obeyed into the HARM: " + r.error);
assert(/has no masks/.test(r.error) && /feather softens a mask EDGE/.test(r.error),
       "...it says the layer has none and what a feather actually does: " +
       r.error);
assert(/apply_effect/.test(r.error) && /Gaussian Blur/.test(r.error) &&
       /"Footage"/.test(r.error),
       "...and hands back a paste-ready apply_effect naming THIS layer: " +
       r.error);
assert(footage.property("ADBE Mask Parade").numProperties === 0,
       "...and the refusal wrote nothing");
// A feather in ARRAY form ([x, y]) is the same ask.
r = call("set_mask", { layer: "Footage", feather: [10, 10] });
assert(!r.ok && /Gaussian Blur/.test(r.error),
       "feather: [x, y] is the same ask: " + r.error);
// Any OTHER edit means the caller really does want a mask.
r = call("set_mask", { layer: "Footage", opacity: 50 });
assert(!r.ok && /has no masks/.test(r.error) && /add_mask creates one/.test(r.error) &&
       !/Gaussian Blur/.test(r.error),
       "a non-feather edit still points at add_mask, not at a blur: " +
       r.error);
r = call("set_mask", { layer: "Footage", feather: 10, mode: "subtract" });
assert(!r.ok && /add_mask creates one/.test(r.error) &&
       !/Gaussian Blur/.test(r.error),
       "feather PLUS a real mask edit wants a mask, so add_mask: " + r.error);
// A named miss on a maskless layer is still the feather answer - there is
// no roster to print and "Masks here: " with nothing after it is the same
// falsehood in a quieter voice.
r = call("set_mask", { layer: "Footage", mask: "Nope", feather: 10 });
assert(!r.ok && /Gaussian Blur/.test(r.error) && !/Masks here/.test(r.error),
       "a named miss on a maskless layer answers the same way: " + r.error);
// set_mask_path goes through the same resolver and gets the truth too.
r = call("set_mask_path", { layer: "Footage",
                            vertices: [[0, 0], [10, 0], [10, 10]] });
assert(!r.ok && /has no masks/.test(r.error) && !/several masks/.test(r.error),
       "set_mask_path shares the resolver, so it shares the fix: " + r.error);
// The n > 0 path is untouched: "several masks" is TRUE with two of them,
// and the roster is real.
r = call("add_mask", { layer: "Footage", name: "One", shape: "rectangle" });
assert(r.ok, "9b rebuilds a mask: " + (r.error || ""));
r = call("add_mask", { layer: "Footage", name: "Two", shape: "rectangle" });
assert(r.ok, "9b rebuilds a second mask: " + (r.error || ""));
r = call("set_mask", { layer: "Footage", feather: 10 });
assert(!r.ok && /several masks/.test(r.error) && /Masks here: One, Two/.test(r.error),
       "with two masks and no ref, 'several masks' is true and the " +
       "roster is real: " + r.error);
r = call("delete_mask", { layer: "Footage", mask: "Two" });
assert(r.ok, "9b tidies: " + (r.error || ""));
r = call("delete_mask", { layer: "Footage", mask: "One" });
assert(r.ok && footage.property("ADBE Mask Parade").numProperties === 0,
       "9b leaves the layer as it found it: " + (r.error || ""));

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
// Beta already carries 'Half' and 'Over', which hide part of it — so
// this default-region mask is not the harmless placeholder it is on a
// bare layer: it covers the whole layer under mode 'add', and measured
// (scripts/mask-above-probe.js) that switches every mask above it off,
// taking the layer from mean alpha 0.429 back to 1.0. The old assertion
// here required SILENCE for that, on the reasoning that the tool's own
// default should never be nagged about — true of a bare layer, and the
// exact blindness this pass closes.
assert(/every pixel of it shows again/.test(r.data.warning || "") &&
       /stop hiding anything/.test(r.data.warning || ""),
       "…and the same default over masks that WERE hiding something says " +
       "they have stopped: " + JSON.stringify(r.data));
assert(!/cuts nothing away/.test(r.data.warning || ""),
       "…and does not fall back to the half-true sentence, which is about " +
       "the new mask and not about the two it just switched off: " +
       r.data.warning);
betaMasks._children.length = 0;
r = call("add_mask", { layer: "Beta", name: "WholeBare", shape: "rectangle" });
assert(r.ok && !r.data.warning,
       "…while on a BARE layer the same call is exactly the placeholder " +
       "add_mask + set_mask_path opens with, and stays silent: " +
       JSON.stringify(r.ok ? r.data : r.error));
betaMasks._children.length = 0;

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

// A feather on a real region is the vignette the rules send here. Silent.
r = call("add_mask", { layer: "Beta", name: "Vignette", shape: "ellipse",
                       bounds: [10, 10, 80, 80], feather: 20 });
assert(r.ok && !r.data.warning,
       "a feathered mask that DOES cut something away is left alone — " +
       "that is the vignette the rules route here: " +
       JSON.stringify(r.ok ? r.data : r.error));

// ---------------------------------------------------------------------
// 6c. The other end of full coverage: the mask that ERASES the layer.
//
// This block replaces two assertions that pinned the defect. They read
// "an INVERTED full-layer mask hides everything — no warning" and "…and
// so does a SUBTRACT one", i.e. they knew the layer disappeared and
// required the receipt to say nothing about it, because the coversAll
// branch was one-sided towards "cuts nothing away". A layer vanishing on
// an `ok` is the expensive direction of the same mistake.
//
// Every verdict below is measured in real AE 26.3x87 by
// scripts/mask-erase-probe.js, which reads the layer's alpha at nine
// points through sampleImage(postEffect) — not inferred from AE's docs.
// With the region covering the whole layer, only 'subtract' empties it;
// 'inverted' makes the region worth NOTHING instead, and then
// 'intersect'/'darken' empty the layer whatever is above them while
// 'add'/'lighten'/'difference' empty it only when there is nothing above
// to keep. That last distinction is the reason "does this layer already
// have masks" is read before the new one is appended.
const solo = new Layer("Solo", comp, false, { width: 100, height: 100 });
comp._layers.push(solo);
const soloMasks = solo.property("ADBE Mask Parade");

// The call that was filed, verbatim in shape: the whole layer, subtract,
// a big feather. Real AE reads alpha 0 through the middle of it.
r = call("add_mask", { layer: "Solo", name: "Wipe", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "subtract",
                       feather: 100 });
assert(r.ok, "the erasing mask still LANDS — an animated reveal opens " +
       "with exactly this, so it is a warning and not a refusal: " +
       (r.error || ""));
assert(/hides ALL of 'Solo'/.test(r.data.warning || ""),
       "…and the receipt says the layer is gone: " + JSON.stringify(r.data));
assert(/subtract' mask over the whole layer cuts every pixel away/
         .test(r.data.warning || ""),
       "…naming which of the mask's settings did it: " + r.data.warning);
assert(/soft fringe/.test(r.data.warning || "") &&
       /does not blur the picture/.test(r.data.warning || "") &&
       /Gaussian Blur/.test(r.data.warning || ""),
       "…and, because a feather is what a 'soften it' ask reaches for, " +
       "says the feather only fades the CUT edge and names the call that " +
       "does blur: " + r.data.warning);
assert(/CUT AWAY/.test(r.data.warning || "") && /mode 'add'/.test(r.data.warning || ""),
       "…and offers both ways out: " + r.data.warning);
assert(!!soloMasks.property("Wipe"),
       "…and the mask it warns about was really created");
soloMasks._children.length = 0;

// Unlike "cuts nothing away", this fires even when the caller named no
// region at all: the tool's own default region IS the whole layer, so
// `add_mask {mode: 'subtract'}` erases the layer without being asked to.
r = call("add_mask", { layer: "Solo", name: "Default", mode: "subtract" });
assert(r.ok && /hides ALL of 'Solo'/.test(r.data.warning || "") &&
       !/fringe/.test(r.data.warning || ""),
       "the DEFAULT region under 'subtract' erases the layer too, and is " +
       "warned about even though nobody passed bounds: " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// 'inverted' turns full coverage into no coverage, so a plain add mask
// becomes an eraser — but only while it is alone (measured).
r = call("add_mask", { layer: "Solo", name: "Inv", shape: "rectangle",
                       bounds: [0, 0, 100, 100], inverted: true });
assert(r.ok && /hides ALL of 'Solo'/.test(r.data.warning || "") &&
       /inverted' turns a mask covering the whole layer/
         .test(r.data.warning || "") &&
       /Drop 'inverted'/.test(r.data.warning || ""),
       "an INVERTED full-layer mask empties the layer, and the warning " +
       "blames the flag that did it: " + JSON.stringify(r.ok ? r.data : r.error));

// …and now it is NOT alone. Measured: over an existing add mask, an
// inverted full-coverage add leaves exactly what that mask kept — so the
// ERASURE warning must not fire (a false alarm on a legitimate
// multi-mask build is how a warning stops being read), but the call is
// still a provable no-op and gets the third receipt instead.
//
// "Over an existing add mask" is the rig that was MEASURED — one mask on
// the left half, i.e. a layer that still shows something. 'Inv' emptied
// it, and a mask above that keeps NOTHING is a different world with its
// own right answer (below), so the eraser comes off first.
soloMasks._children.length = 0;
r = call("add_mask", { layer: "Solo", name: "Keep", shape: "rectangle",
                       bounds: [0, 0, 50, 100] });
assert(r.ok && !r.data.warning,
       "the measured base — one add mask on the left half — lands with " +
       "nothing to say: " + JSON.stringify(r.ok ? r.data : r.error));
r = call("add_mask", { layer: "Solo", name: "Inv2", shape: "rectangle",
                       bounds: [0, 0, 100, 100], inverted: true });
assert(r.ok && !/hides ALL of/.test(r.data.warning || ""),
       "…but with a mask already above it, the same call keeps whatever " +
       "that mask kept, so it is NOT called an erasure: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(/changes nothing on 'Solo'/.test(r.data.warning || "") &&
       /leaves the mask above it exactly as it was/.test(r.data.warning || ""),
       "…it is called what it is — a no-op — and the reason names what " +
       "is above it: " + JSON.stringify(r.data));

// 'subtract' does not care what is above it — measured ERASED with the
// left-half add mask still in place.
r = call("add_mask", { layer: "Solo", name: "Sub2", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "subtract" });
assert(r.ok && /hides ALL of 'Solo'/.test(r.data.warning || ""),
       "'subtract' empties the layer whatever else is masked on it: " +
       JSON.stringify(r.ok ? r.data : r.error));
// …but not over a layer that already shows NOTHING. The old table said
// "always" there too, which is a sentence about the wrong mask: this one
// took nothing, because there was nothing left to take.
r = call("add_mask", { layer: "Solo", name: "Sub3", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "subtract" });
assert(r.ok && !/hides ALL of/.test(r.data.warning || ""),
       "…except over masks that already hide everything, where blaming " +
       "this mask would be false: " + JSON.stringify(r.ok ? r.data : r.error));
assert(/changes nothing on 'Solo'/.test(r.data.warning || "") &&
       /already on it hide all of it/.test(r.data.warning || ""),
       "…and it names the masks that ARE hiding it: " +
       JSON.stringify(r.data));
// …and so do the two inverted modes that intersect down to nothing.
soloMasks._children.length = 0;
call("add_mask", { layer: "Solo", name: "Keep2", shape: "rectangle",
                   bounds: [0, 0, 50, 100] });
r = call("add_mask", { layer: "Solo", name: "Int", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "intersect",
                       inverted: true });
assert(r.ok && /hides ALL of 'Solo'/.test(r.data.warning || ""),
       "an inverted 'intersect' keeps nothing, whatever is above it: " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;
call("add_mask", { layer: "Solo", name: "Keep3", shape: "rectangle",
                   bounds: [0, 0, 50, 100] });
r = call("add_mask", { layer: "Solo", name: "Dark", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "darken",
                       inverted: true });
assert(r.ok && /hides ALL of 'Solo'/.test(r.data.warning || ""),
       "…and so does an inverted 'darken': " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// ---------------------------------------------------------------------
// 6d. The THIRD outcome of full coverage: the mask that changes NOTHING.
//
// This block replaces two more assertions that pinned a defect. They
// read "an inverted 'subtract' at full coverage subtracts nothing — no
// erasure warning" and "…and a plain 'intersect' over the whole layer
// keeps all of it", and both asserted `!r.data.warning` — i.e. they knew
// the call did nothing at all and required the receipt to say so with a
// bare ok. Not being an erasure is not the same as being worth nothing
// to say; a tool reporting success for a call that changed nothing is
// the silent-lie shape, and it is the harder one to catch because the
// screen does not change either.
//
// Every verdict below is the same measured run (mask-erase-probe.js,
// AE 26.3x87), read from its OTHER end: alone against a baseline mean
// alpha of 1.0, and added second over a left-half add mask against a
// baseline of 0.333.
r = call("add_mask", { layer: "Solo", name: "SubInv", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "subtract",
                       inverted: true });
assert(r.ok && !/hides ALL of/.test(r.data.warning || ""),
       "an inverted 'subtract' at full coverage subtracts nothing, so it " +
       "is not an erasure: " + JSON.stringify(r.ok ? r.data : r.error));
assert(/changes nothing on 'Solo'/.test(r.data.warning || "") &&
       /100x100/.test(r.data.warning || ""),
       "…and the receipt says the call did nothing, naming the layer and " +
       "its real size: " + JSON.stringify(r.data));
assert(/covering NONE of it, so 'subtract' takes nothing away/
         .test(r.data.warning || ""),
       "…blaming the setting that did it, not the mode alone: " +
       r.data.warning);
assert(/part you want to KEEP/.test(r.data.warning || ""),
       "…and pointing at the argument that fixes it — an inverted " +
       "subtract KEEPS the region it is given: " + r.data.warning);
assert(!!soloMasks.property("SubInv"),
       "…and the mask it warns about was really created");
soloMasks._children.length = 0;
r = call("add_mask", { layer: "Solo", name: "IntPlain", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "intersect" });
assert(r.ok && /changes nothing on 'Solo'/.test(r.data.warning || "") &&
       /'intersect' over the whole layer keeps everything that already showed/
         .test(r.data.warning || ""),
       "…and a plain 'intersect' over the whole layer keeps all of it — " +
       "measured identical to the mask above it, and identical to no " +
       "mask at all: " + JSON.stringify(r.ok ? r.data : r.error));
assert(!/inverted/.test(r.data.warning || ""),
       "…and does not blame a flag that was never passed: " +
       r.data.warning);
soloMasks._children.length = 0;
// 'darken' is the other always-a-no-op mode at full coverage, and the
// reason it is worth a row of its own is that its INVERTED twin erases
// the layer — the two sit one flag apart.
r = call("add_mask", { layer: "Solo", name: "DarkPlain", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "darken" });
assert(r.ok && /changes nothing on 'Solo'/.test(r.data.warning || ""),
       "a plain 'darken' over the whole layer changes nothing either: " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;
// 'difference' is the one eff-all mode whose no-op depends on being
// ALONE: measured mean 1.0 alone, but 0.667 over a left-half add mask,
// because it inverts what that mask kept. So it warns alone…
r = call("add_mask", { layer: "Solo", name: "DiffAlone", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "difference" });
assert(r.ok && /changes nothing on 'Solo'/.test(r.data.warning || ""),
       "a lone full-coverage 'difference' keeps every pixel: " +
       JSON.stringify(r.ok ? r.data : r.error));
// …and what it does once there is a mask above it to invert depends on
// what THAT mask shows, which is the whole of this pass. Measured
// (mask-above-probe.js): over a mask showing every pixel it leaves NONE,
// alpha 1.0 -> 0.0 — and this assertion used to require silence for it,
// because neither table could see the base and the erasure question was
// filed open.
r = call("add_mask", { layer: "Solo", name: "DiffSecond", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "difference" });
assert(/hides ALL of 'Solo'/.test(r.data.warning || ""),
       "…and over a mask that was showing every pixel, the same call " +
       "empties the layer and now says so: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(/'difference' over the whole layer INVERTS/.test(r.data.warning || "") &&
       /showing every pixel/.test(r.data.warning || ""),
       "…naming what it inverted, not blaming a 'subtract' nobody " +
       "passed: " + r.data.warning);
soloMasks._children.length = 0;
// The other half of the same measurement, and the reason this is a
// warning and not a refusal: over a mask that keeps HALF, 'difference'
// inverts that half (0.429 -> 0.571). It really works, so nothing is
// said — the one-sidedness checked from its quiet side.
call("add_mask", { layer: "Solo", name: "KeepD", shape: "rectangle",
                   bounds: [0, 0, 50, 100] });
r = call("add_mask", { layer: "Solo", name: "DiffHalf", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "difference" });
assert(r.ok && !r.data.warning,
       "…while over a mask that keeps half, it inverts that half and is " +
       "left alone: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;
// And the mirror of the erasure: a full-coverage ADD over masks that
// were hiding something switches them all off (0.429 -> 1.0). The old
// receipt said "cuts nothing away — every pixel of it still shows",
// which is true of the new mask and silent about the ones that stopped.
call("add_mask", { layer: "Solo", name: "KeepU", shape: "rectangle",
                   bounds: [0, 0, 50, 100] });
r = call("add_mask", { layer: "Solo", name: "Undo", shape: "rectangle",
                       bounds: [0, 0, 100, 100] });
assert(!/cuts nothing away/.test(r.data.warning || ""),
       "a full-coverage add over a mask that was hiding something is not " +
       "'cuts nothing away': " + JSON.stringify(r.ok ? r.data : r.error));
assert(/every pixel of it shows again/.test(r.data.warning || "") &&
       /the mask already on it stops hiding anything/
         .test(r.data.warning || ""),
       "…it says the masking stopped, and how many masks it stopped: " +
       JSON.stringify(r.data));
soloMasks._children.length = 0;
// An ellipse bounds the layer with its four vertices and still leaves
// the corners, so "every pixel shows again" would be false — the one
// place this warning is deliberately blind.
call("add_mask", { layer: "Solo", name: "KeepE", shape: "rectangle",
                   bounds: [0, 0, 50, 100] });
r = call("add_mask", { layer: "Solo", name: "UndoE", shape: "ellipse",
                       bounds: [0, 0, 100, 100] });
assert(r.ok && !/shows again/.test(r.data.warning || ""),
       "…and an ELLIPSE over the same mask does not claim it: it leaves " +
       "the corners: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// What the parade SHOWS, not how many masks are in it. Two add masks on
// opposite halves show every pixel between them, and measured they behave
// exactly like one mask that covers the layer: a 'difference' over them
// empties it. A rule that looked for "one mask covering all" would miss
// this and let the layer go blank in silence.
call("add_mask", { layer: "Solo", name: "HalfL", shape: "rectangle",
                   bounds: [0, 0, 50, 100] });
call("add_mask", { layer: "Solo", name: "HalfR", shape: "rectangle",
                   bounds: [50, 0, 50, 100] });
r = call("add_mask", { layer: "Solo", name: "DiffTwo", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "difference" });
assert(/hides ALL of 'Solo'/.test(r.data.warning || "") &&
       /2 masks already on it show/.test(r.data.warning || ""),
       "two half masks between them show everything, so a 'difference' " +
       "over them empties the layer and the receipt counts them: " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// A parade this cannot READ has to fail quiet in one direction and loud
// in the other. A feather hides by degrees, so "all / some / none" cannot
// describe it and the reading is abandoned — but "a full-coverage
// subtract leaves the layer blank" is true whatever the feather did.
call("add_mask", { layer: "Solo", name: "Soft", shape: "rectangle",
                   bounds: [0, 0, 50, 100], feather: 20 });
r = call("add_mask", { layer: "Solo", name: "BlindAdd", shape: "rectangle",
                       bounds: [0, 0, 100, 100] });
assert(!/shows again/.test(r.data.warning || ""),
       "an unreadable parade is never claimed to have stopped working: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(/cuts nothing away/.test(r.data.warning || ""),
       "…and the wider sentence, which is true whatever it showed, still " +
       "arrives: " + JSON.stringify(r.data));
r = call("add_mask", { layer: "Solo", name: "BlindSub", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "subtract" });
assert(/hides ALL of 'Solo'/.test(r.data.warning || ""),
       "…and a layer that comes out blank is still said to be blank, " +
       "readable parade or not: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// A 'none' mask is a path carrier and does not composite, so it neither
// hides anything nor stops the parade being read — its own shape does
// not even have to be readable.
call("add_mask", { layer: "Solo", name: "Carrier", shape: "ellipse",
                   bounds: [10, 10, 30, 30], mode: "none" });
r = call("add_mask", { layer: "Solo", name: "AfterCarrier",
                       shape: "rectangle", bounds: [0, 0, 100, 100],
                       mode: "difference" });
assert(/changes nothing on 'Solo'/.test(r.data.warning || ""),
       "a path carrier leaves the layer as good as unmasked, so the mask " +
       "after it is read against a bare layer: " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// The "misses it completely" refusal, over a layer that HAS masks.
// Measured this pass and it moved the row: an off-layer 'intersect'
// empties a bare layer and leaves a masked one exactly as it was, where
// the old table said "hide the whole layer" for both.
r = call("add_mask", { layer: "Solo", shape: "rectangle", mode: "intersect",
                       bounds: [0, 540, 1920, 540] });
assert(!r.ok && /misses 'Solo' completely, so it would hide the whole layer/
         .test(r.error),
       "a lone off-layer intersect really does empty the layer: " +
       (r.ok ? JSON.stringify(r.data) : r.error));
call("add_mask", { layer: "Solo", name: "KeepM", shape: "rectangle",
                   bounds: [0, 0, 50, 100] });
r = call("add_mask", { layer: "Solo", shape: "rectangle", mode: "intersect",
                       bounds: [0, 540, 1920, 540] });
assert(!r.ok && /misses 'Solo' completely, so it would change nothing/
         .test(r.error),
       "…but over a mask that keeps something it changes nothing, and " +
       "the refusal's REASON is all the model gets to act on: " +
       (r.ok ? JSON.stringify(r.data) : r.error));
soloMasks._children.length = 0;
// mode 'none' is deliberately OUT of the table: it changes nothing at
// any region, so full coverage is not what makes it a no-op, and a
// 'none' mask is a path carrier (Stroke, Scribble, a path expression)
// that this must not nag about.
r = call("add_mask", { layer: "Solo", name: "NoneMask", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "none" });
assert(r.ok && !r.data.warning,
       "a 'none' mask is left alone — it is a path carrier, not a " +
       "mistake: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;
// The no-op warning waits to be ASKED, exactly like "cuts nothing away"
// and unlike the erasure warning. With no bounds the region is this
// tool's own default, which is the add_mask + set_mask_path placeholder.
r = call("add_mask", { layer: "Solo", name: "SubInvDefault",
                       mode: "subtract", inverted: true });
assert(r.ok && !r.data.warning,
       "the tool's OWN default region is never called a no-op — a " +
       "vanished layer is expensive, a no-op is cheap, and that " +
       "asymmetry is deliberate: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;
// A partly covering mask under the same mode really does something.
r = call("add_mask", { layer: "Solo", name: "SubInvHalf", shape: "rectangle",
                       bounds: [0, 0, 100, 50], mode: "subtract",
                       inverted: true });
assert(r.ok && !r.data.warning,
       "an inverted subtract over HALF the layer keeps that half — " +
       "nothing to warn about: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;
// A feather cannot rescue a no-op, and "soften it" is the ask that
// produces one — so the way to actually blur is named, the same way the
// erasure and "cuts nothing away" warnings name it.
r = call("add_mask", { layer: "Solo", name: "SubInvSoft", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "subtract",
                       inverted: true, feather: 40 });
assert(r.ok && /changes nothing on 'Solo'/.test(r.data.warning || "") &&
       /no cut edge to fade/.test(r.data.warning || "") &&
       /Gaussian Blur/.test(r.data.warning || ""),
       "a feather on a no-op mask fades nothing, and the receipt names " +
       "the call that does blur: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;
// 'lighten' joins 'add' in the WIDER sentence, on a measurement: over
// the whole layer both read mean alpha 1.0 alone AND added second, so
// "every pixel of it still shows" is true either way.
r = call("add_mask", { layer: "Solo", name: "LightAll", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "lighten" });
assert(r.ok && /covers all of 'Solo'/.test(r.data.warning || "") &&
       /every pixel of it still shows/.test(r.data.warning || ""),
       "a full-coverage 'lighten' gets the same receipt as 'add': " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// A subtract mask over PART of the layer is the ordinary hole. Silent.
r = call("add_mask", { layer: "Solo", name: "Hole", shape: "ellipse",
                       bounds: [20, 20, 40, 40], mode: "subtract" });
assert(r.ok && !r.data.warning,
       "a subtract mask that cuts a real hole is left alone: " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// The two REFUSALS either side of this carried the same additive
// assumption in their reasons, and a refusal's reason is the whole of
// what the model gets to act on.
r = call("add_mask", { layer: "Solo", shape: "rectangle", mode: "subtract",
                       bounds: [0, 0, 1920, 1080] });
assert(!r.ok && /covers ALL of 'Solo', so it hides the WHOLE layer/
         .test(r.error),
       "a comp-sized SUBTRACT is not 'hides nothing' — it hides " +
       "everything, and the refusal now says so: " +
       (r.ok ? JSON.stringify(r.data) : r.error));
assert(/To cut away only the top half/.test(r.error),
       "…and the worked example is cut-shaped, not show-shaped, so " +
       "following it does what the caller asked: " + r.error);
r = call("add_mask", { layer: "Solo", shape: "rectangle",
                       bounds: [0, 0, 1920, 1080] });
assert(!r.ok && /so it hides nothing/.test(r.error) &&
       /To show only the top half/.test(r.error),
       "…while the same bounds under the default 'add' keep the old " +
       "wording, which was right for them: " +
       (r.ok ? JSON.stringify(r.data) : r.error));

// ---------------------------------------------------------------------
// 6e. An ELLIPSE is not its bounding box.
//
// Every sentence above this one used to read coverage off
// AELL_boxOfPoints(shape.vertices) — the BOX of the four points an
// ellipse is drawn from — so an ellipse at the tool's own default region
// was treated as covering every pixel of the layer. Measured
// 2026-09-03 (scripts/mask-ellipse-probe.js, AE 26.3x87), with the
// rectangle twin built from the identical numbers:
//
//   mode                  ellipse corners/mids   rectangle corners/mids
//   add                         0 / 1                   1 / 1
//   subtract                    1 / 0                   0 / 0
//   add + inverted              1 / 0                   0 / 0
//   subtract + inverted         0 / 1                   1 / 1
//
// — opposite at the corners in all twelve compositing rows, and an 11x9
// grid reads 0.202 of the layer still showing under a full-box ellipse
// 'subtract' where the rectangle leaves 0.000. So "hides ALL", "cuts
// nothing away" and "changes nothing" were each false about an ellipse,
// and each in the direction that reads as reassurance.
soloMasks._children.length = 0;
r = call("add_mask", { layer: "Solo", name: "EllSub", shape: "ellipse",
                       mode: "subtract" });
assert(r.ok && !/hides ALL of 'Solo'/.test(r.data.warning || ""),
       "an ellipse 'subtract' at the default region does NOT hide all of " +
       "the layer — the corners read alpha 1: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(/hides all of 'Solo' EXCEPT the four corners/
         .test(r.data.warning || "") &&
       /about a fifth/.test(r.data.warning || ""),
       "…and silence would be worse than the old lie: what the caller " +
       "gets is a layer showing four corner slivers, so the receipt says " +
       "so, with the measured share: " + JSON.stringify(r.data));
assert(/shape 'rectangle'/.test(r.data.warning || "") &&
       /bounds/.test(r.data.warning || ""),
       "…and it names both ways out — a real region, or the shape that " +
       "really does take the whole layer: " + r.data.warning);
soloMasks._children.length = 0;
r = call("add_mask", { layer: "Solo", name: "RectSub", shape: "rectangle",
                       mode: "subtract" });
assert(/hides ALL of 'Solo'/.test(r.data.warning || ""),
       "…while the RECTANGLE twin of that call is untouched: it really " +
       "does empty the layer: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// The mirror row: an ellipse 'add' over the whole box CUTS the corners
// away (measured 0 at all four), so "cuts nothing away — every pixel of
// it still shows" was false. Nothing replaces it: an ellipse that keeps
// the middle of the layer is a spotlight, which is what an ellipse mask
// is FOR, and 0.11.21 already settled that there is nothing provable to
// say about one.
r = call("add_mask", { layer: "Solo", name: "EllAdd", shape: "ellipse",
                       bounds: [0, 0, 100, 100] });
assert(r.ok && !/cuts nothing away/.test(r.data.warning || ""),
       "an ellipse 'add' over the whole box cuts the corners away, so " +
       "'cuts nothing away' is false: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(!r.data.warning,
       "…and an ellipse keeping the middle is a spotlight, not a " +
       "mistake — nothing provable to say: " + JSON.stringify(r.data));
soloMasks._children.length = 0;

// The third sentence, same shape of error: an inverted 'subtract' over
// the whole box takes the corners away (measured 0), so it is not the
// no-op its rectangle twin is.
r = call("add_mask", { layer: "Solo", name: "EllSubInv", shape: "ellipse",
                       bounds: [0, 0, 100, 100], mode: "subtract",
                       inverted: true });
assert(r.ok && !/changes nothing/.test(r.data.warning || ""),
       "an inverted ellipse 'subtract' cuts the corners, so it did not " +
       "change nothing: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// The other call that would empty the layer as a rectangle: inverted
// 'add'. Measured corners 1, mids 0 — the same four slivers.
r = call("add_mask", { layer: "Solo", name: "EllAddInv", shape: "ellipse",
                       bounds: [0, 0, 100, 100], inverted: true });
assert(/hides all of 'Solo' EXCEPT the four corners/
         .test(r.data.warning || ""),
       "an inverted ellipse 'add' leaves the same four slivers and is " +
       "named the same way: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// The feather is named here for the reason it is named in all three
// neighbours: a feather is what a "soften it" ask reaches for.
r = call("add_mask", { layer: "Solo", name: "EllSoft", shape: "ellipse",
                       mode: "subtract", feather: 50 });
assert(/EXCEPT the four corners/.test(r.data.warning || "") &&
       /does not blur the picture/.test(r.data.warning || "") &&
       /Gaussian Blur/.test(r.data.warning || ""),
       "…and a feather on it fades the CUT edge, not the picture: " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// The corner sentence is gated on the layer having no compositing mask
// yet, and that gate is a measurement: over one add mask on the left
// half the same call reads corners 0.5 — only the two corners that mask
// was showing survive — so "except its four corners" would be false.
call("add_mask", { layer: "Solo", name: "HalfL", shape: "rectangle",
                   bounds: [0, 0, 50, 100] });
r = call("add_mask", { layer: "Solo", name: "EllOver", shape: "ellipse",
                       mode: "subtract" });
assert(r.ok && !/four corners/.test(r.data.warning || ""),
       "over a mask that already hides half the layer, only two corners " +
       "survive — so the sentence goes quiet rather than guessing: " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// The comp-coordinates REFUSAL carried the same reading in its reason.
// A comp-sized ellipse over a 100x100 layer does not cover it (measured:
// the near corner is outside it, the far corner inside) and can even
// miss it entirely, so the refusal keeps the coordinates — which are the
// diagnosis — and drops the claim.
r = call("add_mask", { layer: "Solo", shape: "ellipse", mode: "subtract",
                       bounds: [0, 0, 1920, 1080] });
assert(!r.ok && !/covers ALL of 'Solo'/.test(r.error),
       "a comp-sized ELLIPSE does not cover the layer, so the refusal " +
       "may not say it does: " + (r.ok ? JSON.stringify(r.data) : r.error));
assert(/is far bigger than 'Solo'/.test(r.error) &&
       /middle of its own bounds/.test(r.error),
       "…it says what IS true of it: " + r.error);
assert(/Mask coordinates are in LAYER space/.test(r.error) &&
       /To cut away only the top half/.test(r.error),
       "…and keeps the diagnosis and the mode-shaped worked example, " +
       "which are what the model acts on: " + r.error);
// …and an ellipse big enough to really contain the layer box gets the
// coverage sentence back. It is not hardcoded to "an ellipse never
// covers": here every corner of the layer is inside it.
r = call("add_mask", { layer: "Solo", shape: "ellipse", mode: "subtract",
                       bounds: [-71, -71, 242, 242] });
assert(!r.ok && /covers ALL of 'Solo', so it hides the WHOLE layer/
         .test(r.error),
       "an ellipse whose four corner-tests all pass really does cover " +
       "the layer: " + (r.ok ? JSON.stringify(r.data) : r.error));

// The same hole was open for a custom polygon, and closes the same way:
// a triangle has the layer's bounding box and covers half of it.
r = call("add_mask", { layer: "Solo", name: "Tri", shape: "custom",
                       vertices: [[0, 0], [100, 0], [100, 100]] });
assert(r.ok && !/covers all of 'Solo'/.test(r.data.warning || ""),
       "a triangle with the layer's bounding box does not cover the " +
       "layer: " + JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;
// …while the field's own four-corner call — row 35, 2026-09-02 — still
// gets the sentence it was fixed for. This is the boundary the custom
// rule is drawn at.
r = call("add_mask", { layer: "Solo", name: "Quad", shape: "custom",
                       vertices: [[0, 0], [100, 0], [100, 100], [0, 100]],
                       feather: 50 });
assert(r.ok && /covers all of 'Solo'/.test(r.data.warning || "") &&
       /OUTER EDGE/.test(r.data.warning || ""),
       "…and four points that really are the corners still do: " +
       JSON.stringify(r.ok ? r.data : r.error));
soloMasks._children.length = 0;

// Same correction on the "misses it completely" refusal: measured, a
// lone subtract region the layer never touches subtracts NOTHING.
r = call("add_mask", { layer: "Solo", shape: "rectangle", mode: "subtract",
                       bounds: [0, 540, 1920, 540] });
assert(!r.ok && /misses 'Solo' completely, so it would change nothing/
         .test(r.error),
       "an off-layer SUBTRACT would change nothing, not hide everything: " +
       (r.ok ? JSON.stringify(r.data) : r.error));
r = call("add_mask", { layer: "Solo", shape: "rectangle",
                       bounds: [0, 540, 1920, 540] });
assert(!r.ok && /misses 'Solo' completely, so it would hide the whole layer/
         .test(r.error),
       "…where an off-layer ADD really would hide the whole layer: " +
       (r.ok ? JSON.stringify(r.data) : r.error));
assert(soloMasks.numProperties === 0,
       "and every one of those refusals wrote NOTHING (" +
       soloMasks.numProperties + ")");

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

// 6f. A mask's OPACITY is a mask property, and so is its EXPANSION.
//
// Neither was read anywhere. Opacity made AELL_maskRegion bail, so a
// parade with one opacity-0 mask in it went unreadable and add_mask's
// four sentences went quiet; expansion was not read at all, so the rect
// this returned for an expanded mask was a claim about pixels AE
// disagrees with. And set_mask writes BOTH and had never said a word
// about either.
//
// Every row below is a measured one: scripts/mask-opacity-probe.js, AE
// 26.3x87, layer alpha through sampleImage(postEffect), rows scaled from
// the probe's 400x300 layer to this fixture's 100x100.
//
//   ALONE, every compositing mode at opacity 0 empties the layer — add,
//   subtract, intersect, lighten, darken, difference, at a region worth
//   everything / half / nothing, inverted too. The lone 'subtract' row is
//   the one that makes this its own rule: "its region is worth nothing"
//   predicts the layer stays WHOLE there, and it measures EMPTY.
//
//   FURTHER UP the parade it behaves exactly as a region worth nothing:
//   over an add mask on the left half, a second add at opacity 0 leaves
//   0.429 unchanged, an off-layer subtract leaves 0.429, a full-coverage
//   difference leaves 0.429, and intersect/darken EMPTY the layer.
//
//   INVERSION does not apply to it (an inverted full-coverage subtract at
//   opacity 0 leaves the half base at 0.429), and a 'none'-mode mask is
//   unaffected by opacity at all — it never composites.
const opMasks = solo.property("ADBE Mask Parade");
opMasks._children.length = 0;
const SOLO_BOX = { left: 0, top: 0, width: 100, height: 100 };
// Bounds worth NOTHING: clear of the layer on both axes, where the probe
// put its off-layer masks.
const OFF_BOX = [200, 200, 50, 50];
function opMask(spec) {
  const m = opMasks.addProperty("ADBE Mask Atom");
  const b = spec.bounds || [0, 0, 100, 100];
  const s = new Shape();
  s.closed = true;
  s.vertices = [[b[0], b[1]], [b[0] + b[2], b[1]],
                [b[0] + b[2], b[1] + b[3]], [b[0], b[1] + b[3]]];
  m.property("ADBE Mask Shape").setValue(s);
  m.maskMode = MaskMode[(spec.mode || "add").toUpperCase()];
  m.inverted = !!spec.inverted;
  if (typeof spec.opacity === "number") {
    m.property("ADBE Mask Opacity").setValue(spec.opacity);
  }
  if (typeof spec.expansion === "number") {
    m.property("ADBE Mask Offset").setValue(spec.expansion);
  }
  if (typeof spec.feather === "number") {
    m.property("ADBE Mask Feather").setValue([spec.feather, spec.feather]);
  }
  if (spec.name) m.name = spec.name;
  return m;
}
function paradeReads(specs) {
  opMasks._children.length = 0;
  specs.forEach(opMask);
  return AELL_paradeShows(opMasks, SOLO_BOX);
}
const HALF = [0, 0, 50, 100];
// The 13 measured parades, each next to the alpha it was read against.
[
  { want: "none", alpha: "EMPTY (lone, every mode)",
    specs: [{ mode: "add", opacity: 0 }] },
  { want: "none", alpha: "EMPTY (a lone subtract at 0 too)",
    specs: [{ mode: "subtract", opacity: 0 }] },
  { want: "none", alpha: "EMPTY (region half, still empty)",
    specs: [{ mode: "add", bounds: HALF, opacity: 0 }] },
  { want: "none", alpha: "EMPTY (inverted, still empty)",
    specs: [{ mode: "add", opacity: 0, inverted: true }] },
  { want: "all", alpha: "1.0 — a LATER opacity-0 mask contributes nothing",
    specs: [{ mode: "add" }, { mode: "add", opacity: 0 }] },
  { want: "some", alpha: "0.429 unchanged",
    specs: [{ mode: "add", bounds: HALF },
            { mode: "add", bounds: HALF, opacity: 0 }] },
  { want: "some", alpha: "0.429 — an off-layer subtract at 0",
    specs: [{ mode: "add", bounds: HALF },
            { mode: "subtract", bounds: OFF_BOX, opacity: 0 }] },
  { want: "none", alpha: "EMPTY — intersect against a zero-alpha mask",
    specs: [{ mode: "add" }, { mode: "intersect", opacity: 0 }] },
  { want: "none", alpha: "EMPTY — darken, the same",
    specs: [{ mode: "add" }, { mode: "darken", opacity: 0 }] },
  { want: "all", alpha: "1.0 — difference at 0 inverts nothing",
    specs: [{ mode: "add" }, { mode: "difference", opacity: 0 }] },
  { want: "some", alpha: "0.429 — inversion is NOT applied at opacity 0",
    specs: [{ mode: "add", bounds: HALF },
            { mode: "subtract", opacity: 0, inverted: true }] },
  { want: "some", alpha: "0.429 — a 'none' carrier ignores opacity",
    specs: [{ mode: "add", bounds: HALF },
            { mode: "none", opacity: 0 }] },
  { want: "all", alpha: "1.0 — opacity 0 first, then a real add",
    specs: [{ mode: "add", opacity: 0 }, { mode: "add" }] }
].forEach((row) => {
  const got = paradeReads(row.specs);
  assert(got === row.want,
         "opacity-0 parade reads '" + row.want + "' (" + row.alpha + "), " +
         "got '" + got + "': " + JSON.stringify(row.specs));
});
// A PART opacity is a degree, and "all / some / none" cannot say a degree
// — measured 0.502 for a full-coverage add at opacity 50. So it is the
// one opacity that still makes the parade unreadable.
assert(paradeReads([{ mode: "add", opacity: 50 }]) === "",
       "a part-opacity mask is still unreadable — the layer is FADED, " +
       "which is not all, some or none");
// EXPANSION was never read at all, and it moves the edge: measured, an
// add mask over the left half reads 0.429 at expansion 0, 0.571 at +25
// and 1.0 at +300. So the shape alone was a lie in the reader's mouth.
assert(paradeReads([{ mode: "add", bounds: HALF, expansion: 25 }]) === "",
       "an EXPANDED mask is unreadable, not 'some' — expansion moves the " +
       "edge the shape does not know about");
assert(paradeReads([{ mode: "add", bounds: HALF }]) === "some",
       "…and expansion 0 is the ordinary readable case");
// The animated twins of both, for the same reason the shape and feather
// have them: a keyframed opacity is a different answer at every frame.
const animOp = paradeReads([{ mode: "add", opacity: 0 }]) === "none";
assert(animOp, "…and a static opacity-0 mask reads before the animated " +
       "check below changes it");
opMasks._children.length = 0;
const keyedOp = opMask({ mode: "add", opacity: 0 });
keyedOp.property("ADBE Mask Opacity").setValueAtTime(0, 0);
keyedOp.property("ADBE Mask Opacity").setValueAtTime(1, 100);
assert(AELL_paradeShows(opMasks, SOLO_BOX) === "",
       "a KEYFRAMED mask opacity is unreadable — it is a different " +
       "answer at every frame");
opMasks._children.length = 0;
const keyedExp = opMask({ mode: "add" });
keyedExp.property("ADBE Mask Offset").setValueAtTime(0, 0);
keyedExp.property("ADBE Mask Offset").setValueAtTime(1, 40);
assert(AELL_paradeShows(opMasks, SOLO_BOX) === "",
       "…and so is a keyframed EXPANSION");

// 6h. ONE ELLIPSE in the parade. Until 0.11.35 an ellipse anywhere in a
// layer's masks made the reader return "" and every sentence add_mask,
// set_mask and delete_mask build on it went quiet — an ellipse is not a
// degree the way a feather is, it is exact algebra, and it was costing
// three tools their voice.
//
// Every row is measured: scripts/mask-parade-ellipse-probe.js, AE
// 26.3x87, layer alpha through sampleImage(postEffect) plus a 21x15 area
// grid, rows scaled from the probe's 400x300 layer to this fixture's
// 100x100. All fourteen readable rows agreed with the picture.
const ELL_HALF = [0, 0, 50, 100];
// The ellipse EXACTLY as add_mask builds it — same vertices, same 0.5523
// handles. A stub that drew it any other way would prove nothing about
// the shape the tool actually writes.
function ellMask(spec) {
  const m = opMasks.addProperty("ADBE Mask Atom");
  const b = spec.bounds || [0, 0, 100, 100];
  const k = typeof spec.kappa === "number" ? spec.kappa : 0.5523;
  const rx = b[2] / 2, ry = b[3] / 2;
  const cx = b[0] + rx, cy = b[1] + ry;
  const kx = rx * k, ky = ry * k;
  const s = new Shape();
  s.closed = true;
  s.vertices = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
  s.inTangents = [[-kx, 0], [0, -ky], [kx, 0], [0, ky]];
  s.outTangents = [[kx, 0], [0, ky], [-kx, 0], [0, -ky]];
  m.property("ADBE Mask Shape").setValue(s);
  m.maskMode = MaskMode[(spec.mode || "add").toUpperCase()];
  m.inverted = !!spec.inverted;
  if (typeof spec.opacity === "number") {
    m.property("ADBE Mask Opacity").setValue(spec.opacity);
  }
  if (typeof spec.feather === "number") {
    m.property("ADBE Mask Feather").setValue([spec.feather, spec.feather]);
  }
  return m;
}
function mixedReads(specs) {
  opMasks._children.length = 0;
  specs.forEach((s) => (s.ellipse ? ellMask(s) : opMask(s)));
  return AELL_paradeShows(opMasks, SOLO_BOX);
}
const E = (o) => Object.assign({ ellipse: true }, o);
[
  { row: "E1", want: "some", alpha: "0.784 showing — pi/4 in the middle, " +
    "the four corners gone",
    specs: [E({ mode: "add" })] },
  { row: "E2", want: "some", alpha: "0.216 — the subtract twin, corners only",
    specs: [E({ mode: "subtract" })] },
  { row: "E3", want: "some", alpha: "0.216 — inverted, the same corners",
    specs: [E({ mode: "add", inverted: true })] },
  { row: "E4", want: "all", alpha: "1.0 — a full rect add UNION an ellipse " +
    "add: both branches of every split cell show",
    specs: [{ mode: "add" }, E({ mode: "add" })] },
  { row: "E5", want: "none", alpha: "0 — an ellipse add then a full-coverage " +
    "rect subtract: both branches gone",
    specs: [E({ mode: "add" }), { mode: "subtract" }] },
  { row: "E6", want: "some", alpha: "0.892 — an ellipse add over a half add",
    specs: [{ mode: "add", bounds: ELL_HALF }, E({ mode: "add" })] },
  { row: "E7", want: "some", alpha: "0.416 — a half subtract under it",
    specs: [E({ mode: "add" }), { mode: "subtract", bounds: ELL_HALF }] },
  { row: "E8", want: "some", alpha: "0.784 — an ellipse INTERSECT over a " +
    "full add",
    specs: [{ mode: "add" }, E({ mode: "intersect" })] },
  { row: "E9", want: "all", alpha: "1.0 — an OFF-LAYER ellipse subtract " +
    "takes nothing from a full add",
    specs: [{ mode: "add" }, E({ mode: "subtract", bounds: OFF_BOX })] },
  { row: "E10", want: "none", alpha: "0 — an off-layer ellipse ADD keeps " +
    "nothing",
    specs: [E({ mode: "add", bounds: OFF_BOX })] },
  { row: "E11", want: "some", alpha: "0.394 — an ellipse inscribed in the " +
    "LEFT HALF, where the half's edge is TANGENT to it",
    specs: [E({ mode: "add", bounds: ELL_HALF })] },
  { row: "E12", want: "some", alpha: "0.784 — a lone ellipse 'difference'",
    specs: [E({ mode: "difference" })] },
  { row: "E13", want: "none", alpha: "0 — opacity 0 answers without reading " +
    "the shape at all, so an ellipse there costs nothing",
    specs: [E({ mode: "add", opacity: 0 })] },
  { row: "E14", want: "some", alpha: "0.476 — a 'none'-mode ellipse is a " +
    "path CARRIER and never composites",
    specs: [{ mode: "add", bounds: ELL_HALF }, E({ mode: "none" })] }
].forEach((r) => {
  const got = mixedReads(r.specs);
  assert(got === r.want,
         r.row + ": an ellipse parade reads '" + r.want + "' (" + r.alpha +
         "), got '" + (got || "(silent)") + "'");
});
// …and the three rows the reader must go on refusing. Each was measured
// 'some' in AE, so each is a picture it could have got RIGHT by accident
// — silence is the answer because the reading is not proved, not because
// the layer is unremarkable.
assert(mixedReads([E({ mode: "add" }), E({ mode: "subtract",
                                           bounds: ELL_HALF })]) === "",
       "X1: TWO ellipses stay unreadable — one is exact, two would need " +
       "the reader to prove a cell can be inside both at once");
assert(mixedReads([E({ mode: "add", feather: 40 })]) === "",
       "X2: a FEATHERED ellipse stays unreadable — a feather hides by " +
       "degrees and all/some/none cannot say a degree");
assert(mixedReads([E({ mode: "add", opacity: 50 })]) === "",
       "X3: a PART-opacity ellipse stays unreadable");
// The detector answers for the shape add_mask WRITES and for nothing that
// merely looks like it. A handle dragged off the standard kappa is not
// proved to be an ellipse, and the tangent case below is what forced
// AELL_ellipseVsCell's exact bounding-box test: a rect edge lined up with
// the ellipse's own extreme touches it at a single point, which the
// radius test alone can only call ambiguous.
assert(mixedReads([E({ mode: "add", kappa: 0.75 })]) === "",
       "a dragged handle (kappa 0.75) is not an ellipse this may claim " +
       "about — it reads silent, not 'some'");
assert(mixedReads([E({ mode: "add", kappa: 0.5523 })]) === "some",
       "…and the kappa add_mask itself writes reads");
assert(mixedReads([{ mode: "add", bounds: ELL_HALF },
                   E({ mode: "add", bounds: ELL_HALF })]) === "some",
       "a rect edge TANGENT to the ellipse still reads — the cell right " +
       "of the tangent is provably outside it, not ambiguous");
opMasks._children.length = 0;
const ellDiamond = opMask({ mode: "add" });
const dia = new Shape();
dia.closed = true;
dia.vertices = [[50, 0], [100, 50], [50, 100], [0, 50]];
ellDiamond.property("ADBE Mask Shape").setValue(dia);
assert(AELL_paradeShows(opMasks, SOLO_BOX) === "",
       "a DIAMOND has the ellipse's four vertices and no handles at all — " +
       "it is neither shape and stays unreadable");
// The one place the algebra and AE part company, and it is not about a
// region: measured (the off-layer INTERSECT step in selftest.js), AE
// drops a mask lying wholly outside the layer once something else
// composites, where "its region is worth nothing" says intersect and
// darken EMPTY the layer. Alone it does not drop — and every other mode
// reads the same either way.
assert(mixedReads([{ mode: "add" },
                   { mode: "intersect", bounds: OFF_BOX }]) === "",
       "an off-layer INTERSECT with company is unreadable, not 'none' — " +
       "AE drops it and the layer is untouched");
assert(mixedReads([{ mode: "add" },
                   { mode: "darken", bounds: OFF_BOX }]) === "",
       "…and its 'darken' twin, the other mode the two readings differ on");
assert(mixedReads([{ mode: "intersect", bounds: OFF_BOX }]) === "none",
       "…but ALONE it does not drop: measured, it empties the layer");
assert(mixedReads([{ mode: "add" },
                   { mode: "subtract", bounds: OFF_BOX }]) === "all",
       "…and an off-layer SUBTRACT reads the same whether AE drops it or " +
       "not, so it still answers");

// The write half: set_mask has never said a word about what its edits do
// to the picture, and it owns the one mask property nothing read back.
opMasks._children.length = 0;
opMask({ mode: "add" });
opMasks.property(1).name = "Keeper";
r = call("set_mask", { layer: "Solo", opacity: 0 });
assert(r.ok && /Nothing of 'Solo' shows now/.test(r.data.warning || ""),
       "set_mask {opacity: 0} on the only mask empties the layer " +
       "(measured alpha 1.0 -> 0.0) and used to answer a bare ok: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(/not an off switch/.test(r.data.warning || "") &&
       /mode: "none"/.test(r.data.warning || ""),
       "…and it says why opacity 0 is not the off switch it reads like, " +
       "naming the setting that IS one — measured: a 'none' mask leaves " +
       "every pixel showing at any opacity: " + r.data.warning);
assert(/opacity 100/.test(r.data.warning || ""),
       "…and the way back: " + r.data.warning);
assert(opMasks.property("Keeper").property("ADBE Mask Opacity").value === 0,
       "…and it WARNS, it does not refuse: the edit was really written");
// The same call over a mask that was only hiding part of the layer is the
// same erasure — measured 0.429 -> 0.
opMasks._children.length = 0;
opMask({ mode: "add", bounds: HALF });
r = call("set_mask", { layer: "Solo", opacity: 0 });
assert(r.ok && /Nothing of 'Solo' shows now/.test(r.data.warning || ""),
       "…and over a half-covering mask too (measured 0.429 -> 0): " +
       JSON.stringify(r.ok ? r.data : r.error));
// A PART opacity is a real, ordinary edit and the layer is faded, not
// gone: nothing provable to say in all/some/none, so nothing said.
opMasks._children.length = 0;
opMask({ mode: "add" });
r = call("set_mask", { layer: "Solo", opacity: 50 });
assert(r.ok && !r.data.warning,
       "set_mask {opacity: 50} fades the layer (measured 0.502) — that " +
       "is what was asked for and it is not all/some/none: " +
       JSON.stringify(r.data));
// …and coming BACK from a part opacity says nothing either, which is the
// honest end of the same narrowness: the picture before the edit was a
// faded one, and no reading of it exists to compare against.
r = call("set_mask", { layer: "Solo", opacity: 100 });
assert(r.ok && !r.data.warning,
       "50 -> 100 is silent: the BEFORE picture was unreadable, so there " +
       "is nothing to say it changed from: " + JSON.stringify(r.data));
// An edit that changes nothing says so, the same way add_mask's no-op
// does. Measured: opacity 100 on a mask already at 100, alpha 1.0 -> 1.0.
opMasks._children.length = 0;
opMask({ mode: "add" });
r = call("set_mask", { layer: "Solo", opacity: 100 });
assert(r.ok && /changed nothing on 'Solo'/.test(r.data.warning || "") &&
       /already showed/.test(r.data.warning || ""),
       "an edit that moves no pixels says so: " +
       JSON.stringify(r.ok ? r.data : r.error));
// The before/after reading is not about opacity — it catches the MODE
// change that empties a layer too (measured 1.0 -> 0.0), and there the
// opacity sentence would be nonsense.
opMasks._children.length = 0;
opMask({ mode: "add" });
opMasks.property(1).name = "Flip";
r = call("set_mask", { layer: "Solo", mode: "subtract" });
assert(r.ok && /Nothing of 'Solo' shows now/.test(r.data.warning || "") &&
       /mode=subtract/.test(r.data.warning || ""),
       "a MODE change that empties the layer is the same silence, and " +
       "the same fix catches it: " + JSON.stringify(r.ok ? r.data : r.error));
assert(!/off switch/.test(r.data.warning || "") &&
       /delete_mask \{mask: "Flip"\}/.test(r.data.warning || ""),
       "…with the way out that fits THIS edit, not the opacity one: " +
       r.data.warning);
// The mirror: an edit that switches the masking off. Measured — a later
// mask at opacity 0 takes nothing away, so a subtract over an add that
// keeps everything hands the whole layer back.
opMasks._children.length = 0;
opMask({ mode: "add" });
opMask({ mode: "subtract", bounds: HALF });
opMasks.property(2).name = "Cut";
r = call("set_mask", { layer: "Solo", mask: "Cut", opacity: 0 });
assert(r.ok && /Every pixel of 'Solo' shows again/.test(r.data.warning || ""),
       "an edit that stops the masking working says THAT, not 'nothing " +
       "shows': " + JSON.stringify(r.ok ? r.data : r.error));
// A rename moves no pixels, so "that changed nothing" about one is noise.
opMasks._children.length = 0;
opMask({ mode: "add" });
r = call("set_mask", { layer: "Solo", name: "Renamed" });
assert(r.ok && !r.data.warning,
       "a rename is not a claim about pixels — no no-op warning: " +
       JSON.stringify(r.data));
// And the boundary that stops the erasure warning inventing a change: a
// layer whose masks already showed nothing has nothing left to lose.
opMasks._children.length = 0;
opMask({ mode: "add", bounds: OFF_BOX });
r = call("set_mask", { layer: "Solo", mode: "add" });
assert(r.ok && !/Nothing of 'Solo' shows now/.test(r.data.warning || "") &&
       /already masked out completely/.test(r.data.warning || ""),
       "a layer that already showed nothing is not erased again: " +
       JSON.stringify(r.ok ? r.data : r.error));

// What the READER's new eyes buy add_mask, which is where the silence
// used to land: measured, add_mask over a parade holding one opacity-0
// mask went from saying nothing at all to naming the right outcome.
opMasks._children.length = 0;
opMask({ mode: "add", opacity: 0 });
r = call("add_mask", { layer: "Solo", name: "DiffOver0", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "difference" });
assert(r.ok && /every pixel of it shows again/.test(r.data.warning || ""),
       "a full-coverage 'difference' over an opacity-0 mask hands the " +
       "layer back (measured 0 -> 1.0) and used to say nothing: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(/INVERTS what it shows/.test(r.data.warning || ""),
       "…and with ONE mask above it, the clause agrees with itself: " +
       r.data.warning);
opMasks._children.length = 0;
opMask({ mode: "add", bounds: HALF, opacity: 0 });
r = call("add_mask", { layer: "Solo", name: "AddOver0", shape: "rectangle",
                       bounds: [0, 0, 100, 100], mode: "add" });
assert(r.ok && /every pixel of it shows again/.test(r.data.warning || ""),
       "…and so does a full-coverage 'add' (measured 0 -> 1.0): " +
       JSON.stringify(r.ok ? r.data : r.error));
// The other direction, and the row where the old silence was actually a
// WRONG sentence: with the parade unreadable, add_mask fell back to what
// every reading agrees on and said this subtract "hides ALL … cuts every
// pixel away". The layer was already empty (measured 0 -> 0) — this mask
// is not the reason for anything.
opMasks._children.length = 0;
opMask({ mode: "add", opacity: 0 });
r = call("add_mask", { layer: "Solo", name: "SubOver0", shape: "rectangle",
                       mode: "subtract" });
assert(r.ok && !/hides ALL of 'Solo'/.test(r.data.warning || ""),
       "a subtract over a layer whose masks already hide everything does " +
       "not get to claim the erasure: " +
       JSON.stringify(r.ok ? r.data : r.error));
opMasks._children.length = 0;

// 6g. REMOVING a mask is a claim about pixels too.
//
// set_mask learned to read the picture before and after its own edit;
// delete_mask kept exactly the same blindness, and its receipt
// ({layer, removed, remainingMasks}) can never answer the question —
// measured, the row where the layer is EMPTIED and one of the rows where
// it is HANDED BACK both leave precisely one mask on the layer.
//
// Every row below is measured: scripts/mask-delete-probe.js, AE 26.3x87,
// layer alpha through sampleImage(postEffect), rows scaled from the
// probe's 400x300 layer to this fixture's 100x100.
const BANDL = [0, 0, 25, 100], BANDR = [50, 0, 25, 100];
function deleteFrom(specs, target) {
  opMasks._children.length = 0;
  specs.forEach(opMask);
  return call("delete_mask", { layer: "Solo", mask: target });
}
// The layer is GONE and the old receipt was a bare ok. Measured
// 0.429 -> 0: the 'add' window above a full-coverage subtract was the
// only thing letting the layer through.
r = deleteFrom([{ mode: "subtract", name: "Cut" },
                { mode: "add", bounds: HALF, name: "Win" }], "Win");
assert(r.ok && /Nothing of 'Solo' shows now/.test(r.data.warning || ""),
       "deleting the window above a full subtract EMPTIES the layer " +
       "(measured 0.429 -> 0) and used to answer a bare ok: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(/\(Cut\)/.test(r.data.warning || ""),
       "…naming what is hiding the layer now: " + r.data.warning);
assert(/Ctrl\+Z/.test(r.data.warning || "") &&
       /set_mask \{mask: "Cut", mode: "none"\}/.test(r.data.warning || ""),
       "…with the way back and a switch that is a TOOL call, since " +
       "nothing here can undo: " + r.data.warning);
assert(opMasks.numProperties === 1 && opMasks.property(1).name === "Cut",
       "…and it WARNS, it does not refuse: the mask really went");
// The other direction, with a mask left behind — the surprising half.
// Measured 0 -> 1.0.
r = deleteFrom([{ mode: "add", name: "Keep" },
                { mode: "subtract", name: "Cut" }], "Cut");
assert(r.ok && /Every pixel of 'Solo' shows again/.test(r.data.warning || ""),
       "deleting the subtract hands the layer back (measured 0 -> 1.0): " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(/\(Keep\)/.test(r.data.warning || ""),
       "…naming the mask that stayed and now hides nothing: " +
       r.data.warning);
// Measured 0.571 -> 1.0: a PART subtract is the same sentence.
r = deleteFrom([{ mode: "add", name: "Keep" },
                { mode: "subtract", bounds: HALF, name: "Cut" }], "Cut");
assert(r.ok && /Every pixel of 'Solo' shows again/.test(r.data.warning || ""),
       "…and so does deleting a PART subtract (measured 0.571 -> 1.0): " +
       JSON.stringify(r.ok ? r.data : r.error));
// The row remainingMasks could never answer: a mask REMAINS, and it is a
// 'none' carrier that never composited. Measured 0.429 -> 1.0.
r = deleteFrom([{ mode: "add", bounds: HALF, name: "One" },
                { mode: "none", name: "Path" }], "One");
assert(r.ok && /Every pixel of 'Solo' shows again/.test(r.data.warning || "") &&
       /\(Path\)/.test(r.data.warning || ""),
       "deleting the last COMPOSITING mask reveals the layer even though " +
       "a mask remains (measured 0.429 -> 1.0): " +
       JSON.stringify(r.ok ? r.data : r.error));
// Deleting a layer's LAST mask and getting the whole layer back is the
// tool working — remainingMasks: [] already says it, and a warning on
// every ordinary delete is noise on the tool working. Measured
// 0.429 -> 1.0, the same picture change as the row above.
r = deleteFrom([{ mode: "add", bounds: HALF, name: "One" }], "One");
assert(r.ok && !r.data.warning && r.data.remainingMasks.length === 0,
       "the ordinary delete — a layer's only mask — stays quiet: " +
       JSON.stringify(r.ok ? r.data : r.error));
// "some" is never compared to "some": both readings are exact about which
// pixels show, the coarse word is not. Measured 0.286 -> 0.143.
r = deleteFrom([{ mode: "add", bounds: BANDL, name: "One" },
                { mode: "add", bounds: BANDR, name: "Two" }], "Two");
assert(r.ok && !r.data.warning,
       "deleting one of two separate bands leaves part of the layer " +
       "showing either way, and 'some' -> 'some' is not a claim: " +
       JSON.stringify(r.ok ? r.data : r.error));
// A no-op delete: the mask was not affecting the picture. Measured
// 1.0 -> 1.0 for a redundant duplicate, and this is also where "nothing
// composites" must read as the same picture as "everything shows" —
// otherwise deleting a lone full-coverage add reads as a change.
r = deleteFrom([{ mode: "add", name: "A1" },
                { mode: "add", name: "A2" }], "A2");
assert(r.ok && /changed nothing about what 'Solo' shows/.test(r.data.warning || "") &&
       /showed before 'A2' went/.test(r.data.warning || ""),
       "a redundant duplicate says it moved no pixels (measured " +
       "1.0 -> 1.0): " + JSON.stringify(r.ok ? r.data : r.error));
r = deleteFrom([{ mode: "add", name: "Only" }], "Only");
assert(r.ok && /changed nothing about what 'Solo' shows/.test(r.data.warning || ""),
       "…and so does taking the only full-coverage add off a layer that " +
       "keeps showing every pixel — 'nothing composites' is not a " +
       "different picture from 'everything shows' after a REMOVAL: " +
       JSON.stringify(r.ok ? r.data : r.error));
// The sentence a caller needs most: I deleted the mask and the layer is
// STILL gone. Measured EMPTY -> EMPTY.
r = deleteFrom([{ mode: "subtract", name: "CutA" },
                { mode: "subtract", name: "CutB" }], "CutB");
assert(r.ok && /already masked out completely and still is/.test(r.data.warning || ""),
       "deleting one of two full subtracts does NOT bring the layer back " +
       "(measured EMPTY -> EMPTY) and says so: " +
       JSON.stringify(r.ok ? r.data : r.error));
// And the narrowness that keeps all of it honest: a feather on a survivor
// hides by degrees, so there is no reading to compare and nothing is
// said. Measured 0 -> 0.991 — near-white, and NOT the 1.0 an "all"
// reading would have claimed.
r = deleteFrom([{ mode: "add", feather: 10, name: "Soft" },
                { mode: "subtract", name: "Cut" }], "Cut");
assert(r.ok && !r.data.warning,
       "a feathered survivor makes the parade unreadable, and an " +
       "unreadable picture is not judged (measured 0 -> 0.991, which is " +
       "not 'all' either): " + JSON.stringify(r.ok ? r.data : r.error));
opMasks._children.length = 0;

assert(AE_MODALS.length === 0,
       "no tool call left After Effects behind a modal dialog: " +
       AE_MODALS.join(" | "));

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
