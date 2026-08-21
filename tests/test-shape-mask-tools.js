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
PGroup.prototype.add = function (c) { this._children.push(c); return c; };
Object.defineProperty(PGroup.prototype, "numProperties", {
  get() { return this._children.length; }
});
PGroup.prototype.property = function (ref) {
  if (typeof ref === "number") return this._children[ref - 1] || null;
  return this._children.find(c => c.name === ref || c.matchName === ref) ||
         null;
};

function Prop(name, matchName, value) {
  this.name = name;
  this.matchName = matchName || name;
  this._value = value;
  this.expression = "";
  this.expressionError = "";
  this.canSetExpression = true;
  this._keys = [];
}
Object.defineProperty(Prop.prototype, "value", {
  get() { return this._value; }
});
Prop.prototype.setValue = function (v) {
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
  "ADBE Vector Group"() {
    const g = new PGroup("Group 1", "ADBE Vector Group");
    g.add(new PGroup("Contents", "ADBE Vectors Group"));
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
  "ADBE Vector Filter - Repeater"() {
    const g = new PGroup("Repeater 1", "ADBE Vector Filter - Repeater");
    g.add(new Prop("Copies", "ADBE Vector Repeater Copies", 3));
    const t = new PGroup("Transform", "ADBE Vector Repeater Transform");
    t.add(new Prop("Position", "ADBE Vector Repeater Position", [100, 0]));
    g.add(t);
    return g;
  }
};
PGroup.prototype.canAddProperty = function (mn) { return !!REGISTRY[mn]; };
PGroup.prototype.addProperty = function (mn) {
  const f = REGISTRY[mn];
  if (!f) throw new Error("cannot add " + mn);
  return this.add(f());
};

function Layer(name, comp, isShape) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
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

assert(AE_MODALS.length === 0,
       "no tool call left After Effects behind a modal dialog: " +
       AE_MODALS.join(" | "));

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
