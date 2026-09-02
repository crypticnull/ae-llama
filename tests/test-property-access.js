// Regression test: universal property access (list/get/set property,
// keyframes, track matte, parenting, effect catalog) against a stubbed AE
// object model with a real property tree.
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
Object.defineProperty(PGroup.prototype, "numProperties", {
  get() { return this._children.length; }
});
// An ExtendScript Property reference is a PATH (layer + property indexes),
// not a handle on an object, so anything that shifts those indexes rots
// every reference already handed out. Measured in AE 2026 by
// scripts/verb-semantics-probe.jsx: remove effect 1 of three and the refs
// grabbed for effects 2 AND 3 beforehand both answer "Object is invalid"
// — the removed object is not the only casualty, and it is not merely a
// later-sibling rule. Re-fetching through property() hands back a live
// reference to the same property, which is why aeRevalidate exists: this
// models the PATH going stale, not the property disappearing.
//
// A host that grabs siblings, removes one, then reads the others (to
// report what is left) succeeds against a stub without this and throws a
// raw "Object is invalid" at a user in real AE, from inside a tool that
// had already done its work. remove_effect flattens its `others` to
// strings BEFORE the removal for exactly this reason.
function aeInvalidate(node, dead) {
  if (dead) node._dead = true;
  if (node._invalid) return;
  node._invalid = true;
  node._realName = node.name;
  node._realMatch = node.matchName;
  const boom = { configurable: true,
    get() { throw new Error("After Effects error: Object is invalid"); } };
  Object.defineProperty(node, "name", boom);
  Object.defineProperty(node, "matchName", boom);
  (node._children || []).forEach((c) => aeInvalidate(c, dead));
}
function aeRevalidate(node) {
  if (!node || !node._invalid || node._dead) return node;
  node._invalid = false;
  Object.defineProperty(node, "name", { configurable: true, writable: true,
    enumerable: true, value: node._realName });
  Object.defineProperty(node, "matchName", { configurable: true,
    writable: true, enumerable: true, value: node._realMatch });
  return node;
}
// PropertyBase.remove(), as AE does it for an indexed group's child: the
// siblings close up (their propertyIndex shifts), the removed object is
// invalidated for good, and every surviving sibling's outstanding
// reference goes stale until it is fetched again. Survivors keep their
// NAMES through all of it — AE never renumbers "Gaussian Blur 2" down to
// "Gaussian Blur" when the first one goes (measured with the same probe).
PGroup.prototype.remove = function () {
  if (!this._parent) throw new Error("After Effects error: Object is invalid");
  const sib = this._parent._children;
  sib.splice(sib.indexOf(this), 1);
  this._parent = null;
  aeInvalidate(this, true);
  sib.forEach((s) => aeInvalidate(s, false));
};
PGroup.prototype.property = function (ref) {
  if (typeof ref === "number") {
    return aeRevalidate(this._children[ref - 1]) || null;
  }
  return aeRevalidate(this._children.find((c) =>
    (c._invalid ? c._realName : c.name) === ref ||
    (c._invalid ? c._realMatch : c.matchName) === ref ||
    (c._aliases || []).indexOf(ref) !== -1)) || null;
};
// What addProperty("ADBE Slider Control") really hands back: a GROUP whose
// single child is the value, matchName'd "<class>-0001". add_control writes
// through property(1), and "effects/<name>" reads back the CHILD's
// matchName — a stub returning a bare property would hide both.
const CONTROL_LEAF = {
  "ADBE Slider Control": ["Slider", 0],
  "ADBE Angle Control": ["Angle", 0],
  "ADBE Checkbox Control": ["Checkbox", 0],
  "ADBE Color Control": ["Color", [0, 0, 0, 1]],
  "ADBE Point Control": ["Point", [0, 0]]
};
PGroup.prototype.addProperty = function (matchName) {
  const spec = CONTROL_LEAF[matchName];
  if (!spec) throw new Error("Cannot add property " + matchName);
  const g = new PGroup(spec[0] + " Control", matchName);
  g.add(new Prop(spec[0], matchName + "-0001", spec[1]));
  this.add(g);
  return g;
};
// AE answers canAddProperty(false) for anything not installed — it does
// not throw — which is the branch apply_effect's grounded refusal rides.
PGroup.prototype.canAddProperty = function (matchName) {
  return !!CONTROL_LEAF[matchName];
};

function Prop(name, matchName, value) {
  this.name = name;
  this.matchName = matchName || name;
  this._value = value;
  this.expression = "";
  this.expressionError = "";
  this.canSetExpression = true;
  this._keys = [];   // sorted [{time, value}]
}
Object.defineProperty(Prop.prototype, "value", {
  get() { return this._value; }
});
Object.defineProperty(Prop.prototype, "expressionEnabled", {
  get() { return this.expression !== ""; }
});
Prop.prototype.setValue = function (v) { this._value = v; };
Prop.prototype.setValueAtTime = function (t, v) {
  const hit = this._keys.find(k => Math.abs(k.time - t) < 1e-9);
  if (hit) { hit.value = v; return; }
  this._keys.push({ time: t, value: v });
  this._keys.sort((a, b) => a.time - b.time);
};
Object.defineProperty(Prop.prototype, "numKeys", {
  get() { return this._keys.length; }
});
Prop.prototype.keyTime = function (i) { return this._keys[i - 1].time; };
Prop.prototype.keyValue = function (i) { return this._keys[i - 1].value; };
Prop.prototype.removeKey = function (i) { this._keys.splice(i - 1, 1); };

// Measured in AE 2026: EVERY layer carries all eleven Layer Styles
// whether or not one was ever applied, and each reports enabled=false,
// active=false, canSetEnabled=false, elided=false either way -- there is
// no flag separating an applied style from a latent one. On a plain solid
// that is ten extra "Opacity" properties and seven extra "Color"s, which
// is exactly what a naive name search would trip over.
const LAYER_STYLES = [
  ["Blending Options", "ADBE Blend Options Group", []],
  ["Drop Shadow", "dropShadow/enabled", ["Color", "Opacity", "Size"]],
  ["Inner Shadow", "innerShadow/enabled", ["Color", "Opacity", "Size"]],
  ["Outer Glow", "outerGlow/enabled", ["Color", "Opacity", "Size"]],
  ["Inner Glow", "innerGlow/enabled", ["Color", "Opacity", "Size"]],
  ["Bevel and Emboss", "bevelEmboss/enabled", ["Size"]],
  ["Satin", "chromeFX/enabled", ["Color", "Opacity", "Size"]],
  ["Color Overlay", "solidFill/enabled", ["Color", "Opacity"]],
  ["Gradient Overlay", "gradientFill/enabled", ["Opacity", "Scale"]],
  ["Pattern Overlay", "patternFill/enabled", ["Opacity", "Scale"]],
  ["Stroke", "frameFX/enabled", ["Color", "Opacity", "Size", "Position"]]
];
function layerStylesGroup() {
  const g = new PGroup("Layer Styles", "ADBE Layer Styles");
  for (const [nm, mn, kids] of LAYER_STYLES) {
    const st = new PGroup(nm, mn);
    st.enabled = false;
    st.active = false;
    st.canSetEnabled = false;
    st.elided = false;
    for (const k of kids) st.add(new Prop(k, mn + "/" + k, 0));
    g.add(st);
  }
  return g;
}

// The fourteen Light Options AE gives EVERY light, in AE 2026 order and
// with the matchNames the field probe read back -- "Radius" really is
// "ADBE Light Falloff Start".
const LIGHT_OPTS = [
  ["Source", "ADBE Light Env Atom"],
  ["Background Visible", "ADBE Light Backgd Visible"],
  ["Background Opacity", "ADBE Light Backgd Opacity"],
  ["Background Blur", "ADBE Light Backgd Blur"],
  ["Intensity", "ADBE Light Intensity"],
  ["Color", "ADBE Light Color"],
  ["Cone Angle", "ADBE Light Cone Angle"],
  ["Cone Feather", "ADBE Light Cone Feather 2"],
  ["Falloff", "ADBE Light Falloff Type"],
  ["Radius", "ADBE Light Falloff Start"],
  ["Falloff Distance", "ADBE Light Falloff Distance"],
  ["Casts Shadows", "ADBE Casts Shadows"],
  ["Shadow Darkness", "ADBE Light Shadow Darkness"],
  ["Shadow Diffusion", "ADBE Light Shadow Diffusion"]
];

function Layer(name, comp, kind, box) {
  this.name = name;
  this.comp = comp;
  this.kind = kind || "solid";
  classify(this);
  // How big is this layer, as AE really answers it (measured AE 2026,
  // scripts/layer-size-probe.jsx). `.width`/`.height` are NOT the layer's
  // size: a TEXT layer and a SHAPE layer both report the COMP's
  // dimensions — 1920x1080 for a 147x28 "HELLO" — and a camera and a
  // light have neither property. Only a layer with a SOURCE reports its
  // own, and there the box starts at 0,0. For the sourceless ones the
  // honest box is sourceRectAtTime's, whose origin is the text BASELINE
  // (that "HELLO" measured left 3.487, top -49.568), so a caller reading
  // [0, 0, w, h] there is looking below the glyphs.
  if (this.kind !== "camera" && this.kind !== "light") {
    if (this.kind === "text" || this.kind === "shape") {
      this.width = comp.width;            // the lie, on purpose
      this.height = comp.height;
      this._rect = box || { top: 0, left: 0, width: 0, height: 0 };
    } else {
      const b = box || { top: 0, left: 0,
                         width: comp.width, height: comp.height };
      this.width = b.width;
      this.height = b.height;
      this.source = { width: b.width, height: b.height };
      this._rect = { top: 0, left: 0, width: b.width, height: b.height };
    }
    this.sourceRectAtTime = function () { return this._rect; };
  }
  // A fresh AV layer reads NO_TRACK_MATTE (5012), not 0. A camera or a
  // light carries NEITHER property until something writes one — which is
  // exactly how the legacy branch's phantom matte used to hide.
  if (this.kind !== "camera" && this.kind !== "light") {
    this.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
    this.trackMatteLayer = null;
  }
  this.selected = false;
  this._parentRef = null;
  this._compensated = false;
  this._jumped = false;
  this.inPoint = 0;
  this._root = new PGroup("(layer)", "(layer)");
  const t = new PGroup("Transform", "ADBE Transform Group");
  // Padded to three components even on a 2D layer: that is what the
  // SCRIPTING API hands back (the EXPRESSION engine sees two), and the
  // stub says so because half the 3D-only bugs live in that third slot.
  t.add(new Prop("Position", "ADBE Position", [100, 100, 0]));
  t.add(new Prop("Scale", "ADBE Scale", [100, 100, 100]));
  t.add(new Prop("Rotation", "ADBE Rotate Z", 0));
  t.add(new Prop("Opacity", "ADBE Opacity", 100));
  t.add(new Prop("Anchor Point", "ADBE Anchor Point", [0, 0, 0]));
  // Measured in AE 2026 (WORKPLAN-LOG 2026-08-28): a 2D layer's Transform
  // group already carries Z Position, Orientation and both extra
  // rotations. The tree holds the same twelve properties whatever
  // threeDLayer says, so nothing may infer 3D-ness from it.
  t.add(new Prop("Z Position", "ADBE Position_2", 0));
  t.add(new Prop("Orientation", "ADBE Orientation", [0, 0, 0]));
  t.add(new Prop("X Rotation", "ADBE Rotate X", 0));
  t.add(new Prop("Y Rotation", "ADBE Rotate Y", 0));
  this._3d = false;
  const fx = new PGroup("Effects", "ADBE Effect Parade");
  const blur = new PGroup("Gaussian Blur", "ADBE Gaussian Blur 2");
  blur.add(new Prop("Blurriness", "ADBE Gaussian Blur 2-0001", 0));
  fx.add(blur);
  // a renamed Slider Control, like the grid rig's spacing controls
  const slider = new PGroup("Grid X Spacing", "ADBE Slider Control");
  slider.add(new Prop("Slider", "ADBE Slider Control-0001", 10));
  fx.add(slider);
  this._root.add(t);
  if (this.kind === "light") {
    // A light has no Effects, no Contents and no Layer Styles: the field
    // probe walked one to depth 3 and found 29 nodes total.
    this._root._children.length = 0;
    this._root.add(t);
    const lo = new PGroup("Light Options", "ADBE Light Options Group");
    for (const [nm, mn] of LIGHT_OPTS) {
      lo.add(new Prop(nm, mn, nm === "Radius" ? 300
        : nm === "Falloff Distance" ? 400
        : nm === "Shadow Diffusion" ? 60 : 100));
    }
    this._root.add(lo);
    return;
  }
  this._root.add(fx);
  if (this.kind === "shape") {
    // Contents/Group 1/Contents/Rectangle Path 1/Size -- the real depth
    // AE puts a rectangle's Size at, five levels down and BELOW the
    // depth the Layer Styles copies of "Size" sit at.
    const contents = new PGroup("Contents", "ADBE Root Vectors Group");
    const grp = new PGroup("Group 1", "ADBE Vector Group");
    const inner = new PGroup("Contents", "ADBE Vectors Group");
    const rect = new PGroup("Rectangle Path 1", "ADBE Vector Shape - Rect");
    rect.add(new Prop("Size", "ADBE Vector Rect Size", [200, 100]));
    inner.add(rect);
    grp.add(inner);
    contents.add(grp);
    this._root.add(contents);
  }
  this._root.add(layerStylesGroup());
}

// AE's layer-level name shortcut is a FIXED list, not a search, and the
// line it draws is arbitrary. Measured name by name in AE 2026: a light
// answers Intensity, Color, Cone Angle, Cone Feather, Casts Shadows,
// Shadow Darkness AND Shadow Diffusion -- but NOT Falloff, Radius or
// Falloff Distance, the three options AE added with falloff, which live
// in the very same group. A camera answers every one of its options. A
// solid answers Accepts Lights and Casts Shadows but NOT its own effect's
// Blurriness, and a shape layer answers Contents but not Group 1,
// Rectangle Path 1 or Size. That split is the whole reason the deep
// search exists, so the stub reproduces it name for name instead of
// resolving everything.
const AE_LAYER_SHORTCUT = ["Position", "Scale", "Rotation", "Opacity",
  "Anchor Point", "Z Position", "Orientation", "X Rotation", "Y Rotation",
  "Zoom", "Focus Distance", "Aperture", "Blur Level", "Depth of Field",
  "Iris Shape", "Intensity", "Color", "Cone Angle", "Cone Feather",
  "Casts Shadows", "Shadow Darkness", "Shadow Diffusion", "Accepts Lights",
  "Source Text", "Marker", "Time Remap"];
Object.defineProperty(Layer.prototype, "numProperties", {
  get() { return this._root._children.length; }
});
Layer.prototype.property = function (ref) {
  const direct = this._root.property(ref);
  if (direct) return direct;
  if (typeof ref !== "string" ||
      AE_LAYER_SHORTCUT.indexOf(ref) === -1) return null;
  for (const g of this._root._children) {
    const hit = g.property(ref);
    if (hit) return hit;
  }
  return null;
};
// The one thing the 3D switch really changes about the tree: AE RENAMES
// ADBE Rotate Z from "Rotation" to "Z Rotation". Measured in AE 2026
// (WORKPLAN-LOG 2026-08-28), including the asymmetry: a 3D layer still
// answers to the OLD name, but a 2D layer has never heard of the new one.
// So a path written while the layer was 2D survives the switch and one
// written while it was 3D does not survive the switch back.
Object.defineProperty(Layer.prototype, "threeDLayer", {
  get() { return this._3d; },
  set(v) {
    this._3d = !!v;
    const t = this._root.property("ADBE Transform Group");
    const rz = t && t.property("ADBE Rotate Z");
    if (!rz) return;
    rz.name = this._3d ? "Z Rotation" : "Rotation";
    rz._aliases = this._3d ? ["Rotation"] : [];
    if (this._3d) return;
    // Going back to 2D is DESTRUCTIVE, and AE reports none of it: the Z
    // of Position and Anchor Point is zeroed, Scale Z snaps back to 100
    // and Orientation / X Rotation / Y Rotation are cleared -- keyframe
    // values included -- and turning 3D on again does not restore them.
    // Measured in AE 2026 (WORKPLAN-LOG 2026-08-28); Z Rotation is the
    // one that survives.
    const flatten = (mn, zOnly, keep) => {
      const p = t.property(mn);
      if (!p) return;
      const hit = (v) => {
        if (typeof v === "number") return zOnly ? v : keep;
        const out = v.slice();
        if (zOnly) { if (out.length > 2) out[2] = keep; }
        else { for (let i = 0; i < out.length; i++) out[i] = keep; }
        return out;
      };
      p._value = hit(p._value);
      for (const k of p._keys) k.value = hit(k.value);
    };
    flatten("ADBE Position", true, 0);
    flatten("ADBE Anchor Point", true, 0);
    flatten("ADBE Scale", true, 100);
    flatten("ADBE Orientation", false, 0);
    flatten("ADBE Rotate X", false, 0);
    flatten("ADBE Rotate Y", false, 0);
  }
});
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
// The two ways AE sets a parent are NOT interchangeable, and the tool
// shipped with them swapped (measured 2026-08-29): `.parent =` is the
// pick-whip, which REWRITES the child's transform so nothing moves on
// screen, while setParentWithJump keeps the numbers and lets the layer
// jump. The arithmetic is exercised in tests/test-layer-parent.js; what
// this stub has to preserve is that they are two different calls, so a
// tool that picks the wrong one cannot pass here either.
Object.defineProperty(Layer.prototype, "parent", {
  get() { return this._parentRef; },
  set(p) {
    this._parentRef = p || null;
    this._compensated = true;
  }
});
Layer.prototype.setParentWithJump = function (p) {
  this._parentRef = p || null;
  this._jumped = true;
};
// Measured in AE 2026 (WORKPLAN 1c), and the asymmetry is the whole
// point: setTrackMatte writes BOTH properties, removeTrackMatte clears
// only trackMatteLayer and LEAVES trackMatteType at the type it just
// removed. A stub that reset both would let a type-only "has a matte"
// read pass here and lie in the field.
Layer.prototype.setTrackMatte = function (m, t) {
  this.trackMatteLayer = m;
  this.trackMatteType = t;
};
Layer.prototype.removeTrackMatte = function () {
  this.trackMatteLayer = null;
};
// EVERY AE layer has moveBefore — cameras and lights included — and
// `layer.trackMatteType = X` is a plain assignment that never throws on
// one either (measured: a camera reads back 5015 for LUMA). Both are
// modelled because together they are how set_track_matte's legacy
// branch reordered the user's stack and then reported a matte AE had
// not made; a stub without moveBefore turns that silent lie into a
// TypeError and stops testing the real failure.
Layer.prototype.moveBefore = function (other) {
  const ls = this.comp._layers;
  ls.splice(ls.indexOf(this), 1);
  ls.splice(ls.indexOf(other), 0, this);
};

let compIds = 0;
function Comp(name) {
  this.name = name;
  this.id = ++compIds;
  this._layers = [];
  this.time = 0;
  this.width = 1920;
  this.height = 1080;
  this.duration = 10;
  this.frameRate = 30;
  // get_comp_details reports these, so a comp without them is not a comp
  // this stub can read back through the tool the panel actually calls.
  this.resolutionFactor = [1, 1];
  this.workAreaStart = 0;
  this.workAreaDuration = 10;
  this.parentFolder = { name: "(root)" };   // every real comp has one
  const self = this;
  this.layers = {
    addSolid(color, nm, w, h, ar, dur) {
      const l = new Layer(nm, self);
      l._solid = { color, w, h, dur };
      self._layers.unshift(l);
      return l;
    }
  };
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
// AE names the copy itself; duplicate_comp only renames it afterwards.
// The copy lands in the SOURCE'S OWN folder with the source's layers
// (measured 2026-08-29) — every real comp has a parentFolder, so the
// stub gives it one rather than letting the tool read undefined.
Comp.prototype.duplicate = function () {
  const c = new Comp(this.name + " 2");
  c.width = this.width;
  c.height = this.height;
  c.duration = this.duration;
  c.parentFolder = this.parentFolder;
  for (const l of this._layers) {
    const copy = new Layer(l.name, c, l.kind);
    copy.source = l.source;          // SHARED, never copied
    c._layers.push(copy);
  }
  return c;
};

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}

// AE's LAYER CLASSES, measured in AE 2026 (WORKPLAN-LOG 2026-09-01)
// because a classless stub cannot see the bug it hid: a CameraLayer and
// a LightLayer carry no setTrackMatte / removeTrackMatte AT ALL
// (typeof === "undefined"), while a solid, a text layer and a shape
// layer do. With every stub layer classless, set_track_matte's legacy
// branch "succeeded" on a camera here exactly as it did in real AE.
//
// The classes are FLAT and deliberately so: measured in ExtendScript,
// `instanceof AVLayer` is FALSE for a TextLayer AND for a ShapeLayer,
// not just for a camera and a light — only the plain solid answers
// true. A first cut at the fix keyed the refusal off `instanceof
// AVLayer` and locked text and shape layers out of mattes entirely; a
// stub that chained TextLayer to AVLayer would have called that fix
// green. Layer.prototype's own descriptors are copied onto a per-kind
// proto so the instance keeps every stub method while its CLASS
// changes.
const LAYER_CLASS = { camera: CameraLayer, light: LightLayer,
                      text: TextLayer, shape: ShapeLayer };
function classify(layer) {
  const K = LAYER_CLASS[layer.kind] || AVLayer;
  const proto = Object.create(K.prototype,
    Object.getOwnPropertyDescriptors(Layer.prototype));
  if (K === CameraLayer || K === LightLayer) {
    delete proto.setTrackMatte;
    delete proto.removeTrackMatte;
  }
  Object.setPrototypeOf(layer, proto);
}
const ParagraphJustification = {};
// The real numbers, measured in AE 2026 — an unmatted layer reads 5012,
// NOT 0, and NO_TRACK_MATTE is 5012 rather than the 5013 the probe used
// to assume (5013 is ALPHA). Anything that decides "is there a matte"
// from this number is wrong twice over; see removeTrackMatte above.
const TrackMatteType = {
  NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014,
  LUMA: 5015, LUMA_INVERTED: 5016
};

const comp = new Comp("Props");
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
const A = new Layer("A", comp);
const B = new Layer("B", comp);
const CTRL = new Layer("CTRL", comp);
comp._layers.push(A, B, CTRL);

const project = { rootFolder: { name: "(root)" }, numItems: 0,
                  item() { return null; }, items: {}, activeItem: comp };
const app = {
  project,
  beginUndoGroup() {}, endUndoGroup() {},
  effects: [
    { displayName: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2",
      category: "Blur & Sharpen" },
    { displayName: "Glow", matchName: "ADBE Glo2", category: "Stylize" },
    { displayName: "Curves", matchName: "ADBE Pro Levels2",
      category: "Color Correction" }
  ]
};
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

// 1. discovery: the real tree comes back with paths and values
let r = call("list_properties", { layer: "A" });
assert(r.ok, "list_properties succeeds: " + (r.error || ""));
const paths = r.data.properties.map(p => p.path);
assert(paths.includes("Transform/Position") &&
       paths.includes("Effects/Gaussian Blur"),
       "tree includes Transform/Position and Effects/Gaussian Blur");
const posEntry = r.data.properties.find(p => p.path === "Transform/Position");
assert(posEntry.kind === "prop" && posEntry.matchName === "ADBE Position" &&
       JSON.stringify(posEntry.value) === "[100,100,0]",
       "Position entry carries kind/matchName/value");

// 2. narrowing by path + grounded error on a bad segment
r = call("list_properties", { layer: "A", path: "effects/Gaussian Blur" });
assert(r.ok && r.data.properties.some(p => /Blurriness/.test(p.path)),
       "path narrowing reaches effect params");
r = call("get_property", { layer: "A", property: "effects/Gaussian Blr/x" });
assert(!r.ok && /not found under/.test(r.error) &&
       /Gaussian Blur/.test(r.error),
       "bad segment -> grounded error listing real children");

// 3. get_property reads value, keys, expression
r = call("get_property", { layer: "A",
                           property: "effects/Gaussian Blur/Blurriness" });
assert(r.ok && r.data.value === 0 && r.data.numKeys === 0,
       "get_property reads an effect param by path");
r = call("get_property", { layer: "A", property: "transform" });
assert(!r.ok && /GROUP/.test(r.error),
       "get_property on a group points to list_properties");

// 4. set_property writes by path and by friendly name
r = call("set_property", { layer: "A",
                           property: "Effects/Gaussian Blur/Blurriness",
                           value: 25 });
assert(r.ok &&
       A.property("Effects").property("Gaussian Blur")
        .property("Blurriness").value === 25,
       "set_property writes an effect param");
r = call("set_property", { layer: "A", property: "position",
                           value: [300, 400] });
assert(r.ok && JSON.stringify(
         A.property("Transform").property("Position").value) === "[300,400]",
       "friendly names still resolve");

// 5. keyframing: atTime, batch set, remove
r = call("set_property", { layer: "A", property: "opacity", value: 0,
                           atTime: 1 });
assert(r.ok && r.data.keyframed && r.data.numKeys === 1,
       "set_property atTime creates a keyframe");
r = call("set_keyframes", { layer: "A", property: "opacity",
  keys: [{ time: 2, value: 100 }, { time: 3, value: 50 }] });
assert(r.ok && r.data.keysSet === 2 && r.data.numKeys === 3,
       "set_keyframes batches keys (3 total)");
r = call("remove_keyframes", { layer: "A", property: "opacity",
                               times: [2.01] });
assert(r.ok && r.data.removed === 1 && r.data.remaining === 2,
       "remove_keyframes removes the nearest key to a time");
r = call("remove_keyframes", { layer: "A", property: "opacity" });
assert(r.ok && r.data.removed === 2 && r.data.remaining === 0,
       "remove_keyframes with no times clears them all");

// 6. parenting with visual-position preservation + selection default
r = call("set_layer_parent", { layers: ["A", "B"], parent: "CTRL" });
assert(r.ok && A.parent === CTRL && B.parent === CTRL,
       "multi-layer parenting links both layers");
assert(A._compensated && B._compensated && !A._jumped && !B._jumped,
       "...by default through the compensating call, never the jumping one");
r = call("set_layer_parent", { layer: "B", parent: "CTRL",
                               keepPosition: false });
assert(r.ok && B._jumped, "keepPosition:false is the jumping call");
r = call("set_layer_parent", { layer: "A", parent: "none" });
assert(r.ok && A.parent === null, "'none' unparents");
r = call("set_layer_parent", { layers: ["CTRL"], parent: "CTRL" });
assert(!r.ok || /is the parent/.test(r.data.skipped || ""),
       "self-parenting skipped with a reason");

// 7. track mattes
r = call("set_track_matte", { layer: "A", matteLayer: "B", mode: "luma" });
assert(r.ok && A.trackMatteLayer === B &&
       A.trackMatteType === TrackMatteType.LUMA,
       "set_track_matte wires luma matte via setTrackMatte");
r = call("set_track_matte", { layer: "A", mode: "none" });
assert(r.ok && A.trackMatteLayer === null, "mode none removes the matte");
assert(r.data.was === "B", "…and the receipt names what it removed: " +
       JSON.stringify(r.data));
// The measurement this whole block exists for: AE does NOT reset the
// type on removal. Anything reading trackMatteType to answer "does this
// layer have a matte" says yes here, forever, for a matte that is gone.
assert(A.trackMatteType === TrackMatteType.LUMA,
       "AE leaves trackMatteType at the removed type (" +
       A.trackMatteType + ")");
r = call("set_track_matte", { layer: "A", mode: "none" });
assert(!r.ok && /'A' has no track matte to remove/.test(r.error) &&
       /get_comp_details/.test(r.error),
       "…so a second removal is REFUSED, not reported as 'removed': " +
       (r.ok ? JSON.stringify(r.data) : r.error));

// The matte has to be VISIBLE, or set_track_matte's receipt is the only
// evidence it ever landed — which is how a matte AE never made read
// exactly like one it did.
function rowOf(name) {
  const d = call("get_comp_details", { limit: 0 });
  assert(d.ok, "get_comp_details answered: " + (d.ok ? "" : d.error));
  return d.data.layers.filter(l => l.name === name)[0] || null;
}
assert(!rowOf("A").matte,
       "an unmatted layer reports no matte even though trackMatteType " +
       "still reads " + A.trackMatteType);
call("set_track_matte", { layer: "A", matteLayer: "B", mode: "alpha" });
assert(rowOf("A").matte === "B" && rowOf("A").matteMode === "alpha",
       "get_comp_details names the matte layer and its mode: " +
       JSON.stringify(rowOf("A")));
assert(!rowOf("B").matte, "…and only on the layer that has one");
call("set_track_matte", { layer: "A", mode: "none" });
assert(!rowOf("A").matte,
       "…and it goes away when the matte does: " +
       JSON.stringify(rowOf("A")));
// The layer's own SIZE has to be visible here too, for the same reason
// the matte does. add_mask's doc says "sizes from get_comp_details,
// never guessed" and this result carried no layer size at all — so four
// separate phrasings of "hide half of Beta" masked a 100x100 layer with
// [0, 540, 1920.0001, 540], the comp's dimensions halved, and AE took it
// silently. The model was obeying: 1920x1080 was the only size it had.
const SMALL = new Layer("Beta", comp, "solid", { width: 100, height: 100 });
comp._layers.push(SMALL);
assert(rowOf("Beta").width === 100 && rowOf("Beta").height === 100,
       "a layer smaller than the comp reports its OWN size: " +
       JSON.stringify(rowOf("Beta")));
assert(!("width" in rowOf("A")) && !("height" in rowOf("A")),
       "a full-frame layer reports none — absent means the comp's size, " +
       "which is in the same result: " + JSON.stringify(rowOf("A")));

// A text layer is where .width/.height cannot be believed at all, and
// where the origin is not 0,0 either.
const TXT = new Layer("HELLO", comp, "text",
  { left: 3.487, top: -49.568, width: 146.671, height: 28.017 });
comp._layers.push(TXT);
assert(TXT.width === 1920,
       "stub: AE reports the COMP's width for a text layer (measured)");
assert(rowOf("HELLO").width === 146.671 && rowOf("HELLO").height === 28.017,
       "…and the row reports the MEASURED box instead: " +
       JSON.stringify(rowOf("HELLO")));
assert(rowOf("HELLO").left === 3.487 && rowOf("HELLO").top === -49.568,
       "…with the baseline origin, so [0, 0, w, h] is visibly not it: " +
       JSON.stringify(rowOf("HELLO")));
assert(!("left" in rowOf("Beta")) && !("top" in rowOf("Beta")),
       "…and a layer whose origin IS 0,0 pays nothing for those two: " +
       JSON.stringify(rowOf("Beta")));

// An empty shape layer measures 0x0 and a camera has no size at all:
// neither may be reported as a box, and neither may throw.
const EMPTY = new Layer("Empty Shape", comp, "shape");
comp._layers.push(EMPTY);
assert(!("width" in rowOf("Empty Shape")),
       "a layer with nothing to measure reports no size: " +
       JSON.stringify(rowOf("Empty Shape")));
comp._layers.pop(); comp._layers.pop(); comp._layers.pop();

r = call("set_track_matte", { layer: "A", matteLayer: "A", mode: "alpha" });
assert(!r.ok && /matte itself/.test(r.error), "self-matte refused");
r = call("set_track_matte", { layer: "A", mode: "alpha" });
assert(!r.ok && /matteLayer/.test(r.error), "missing matteLayer refused");

// 8. installed-effect catalog with filter + paging metadata
r = call("list_effects", {});
assert(r.ok && r.data.total === 3 && r.data.effects.length === 3,
       "list_effects returns the full catalog");
r = call("list_effects", { filter: "color" });
assert(r.ok && r.data.total === 1 && r.data.effects[0].name === "Curves",
       "filter matches category text");

// 9. selection default on the universal tools
comp._layers.forEach(l => { l.selected = false; });
B.selected = true;
r = call("get_property", { property: "opacity" });
assert(r.ok && r.data.layer === "B",
       "omitted layer resolves to the selection");

// 10. batch keyframes: ONE call, many layers, per-layer inPoint offsets
A.inPoint = 0;
B.inPoint = 0.5;
r = call("set_keyframes", { layers: ["A", "B"], property: "opacity",
  keys: [{ time: 0, value: 0 }, { time: 1, value: 100 }],
  relativeTo: "inPoint" });
assert(r.ok && r.data.layers === 2 && r.data.keysSet === 4,
       "one set_keyframes call animates both layers: " + (r.error || ""));
const aOp = A.property("Transform").property("Opacity");
const bOp = B.property("Transform").property("Opacity");
assert(aOp.keyTime(1) === 0 && aOp.keyTime(2) === 1,
       "layer A keys land at its own start (0, 1)");
assert(bOp.keyTime(1) === 0.5 && bOp.keyTime(2) === 1.5,
       "layer B keys ride its inPoint (0.5, 1.5) — stagger preserved");

// selection default targets the whole multi-selection
comp._layers.forEach(l => { l.selected = false; });
A.selected = true;
B.selected = true;
r = call("remove_keyframes", { property: "opacity" });
assert(r.ok && r.data.layers === 2 && r.data.removed === 4,
       "batch remove clears keys on the whole selection");

// 10b. a selection that is ONLY a control null refuses batch animation
// (the field failure: GRID CTRL selected while inspecting sliders got
// scale/rotation keyframes meant for the squares)
CTRL.nullLayer = true;
comp._layers.forEach(l => { l.selected = false; });
CTRL.selected = true;
r = call("set_keyframes", { property: "opacity",
  keys: [{ time: 0, value: 0 }, { time: 1, value: 100 }] });
assert(!r.ok && /control null/i.test(r.error) && /CTRL/.test(r.error),
       "null-only selection refused with guidance: " +
       (r.error || "").slice(0, 80));
r = call("set_keyframes", { layer: "CTRL", property: "opacity",
  keys: [{ time: 0, value: 0 }, { time: 1, value: 100 }] });
assert(r.ok && r.data.keysSet === 2,
       "explicitly naming the null still animates it");
call("remove_keyframes", { layer: "CTRL", property: "opacity" });

// 11. a path landing on a single-value control effect auto-descends to
// its value ("Effects/Grid X Spacing" means the slider, not the group)
r = call("get_property", { layer: "A", property: "effects/Grid X Spacing" });
assert(r.ok && r.data.value === 10,
       "control-effect path reads the slider value: " + (r.error || ""));
r = call("set_property", { layer: "A", property: "Effects/Grid X Spacing",
                           value: 42 });
assert(r.ok && A.property("Effects").property("Grid X Spacing")
         .property("Slider").value === 42,
       "control-effect path writes the slider value");
r = call("get_property", { layer: "A", property: "transform" });
assert(!r.ok && /GROUP/.test(r.error),
       "multi-property groups still refuse with the list_properties hint");

// set_property with a layers ARRAY is a batch ask — redirect, don't
// silently set one layer and claim success (field-observed: the model
// reached for this form twice in one probe run).
r = call("set_property", { layers: ["A", "B"], property: "Opacity",
                           value: 50 });
assert(!r.ok, "set_property refuses a layers array");
assert(/for_each_layer/.test(r.error || ""),
       "and the refusal names the tool that DOES batches: " + r.error);

// 12. rigging: add_control, the presets that ride it, keyframes by hand,
// and set_layer_3d. All four shipped with no stubbed test at all until
// the suite grew real-AE steps for them (WORKPLAN item 3, 2026-08-28).
r = call("add_control", { layer: "A", type: "slider", name: "Amp",
                          value: 40 });
assert(r.ok && r.data.control === "Amp" && /link_property/.test(r.data.hint),
       "add_control names the control and hands over the link call: " +
       (r.error || ""));
r = call("get_property", { layer: "A", property: "effects/Amp" });
assert(r.ok && r.data.value === 40 &&
       r.data.matchName === "ADBE Slider Control-0001",
       "the control reads back through its VALUE property: " +
       (r.error || r.data.matchName));
r = call("add_control", { layer: "A", type: "point", name: "Where",
                          value: [10, 20] });
assert(r.ok, "a point control takes a two-component value: " + (r.error || ""));
r = call("get_property", { layer: "A", property: "effects/Where" });
assert(r.ok && JSON.stringify(r.data.value) === "[10,20]",
       "and reads back as [10, 20]");
r = call("add_control", { layer: "A", type: "spinner", name: "Nope" });
assert(!r.ok && /slider, angle, checkbox, color or point/.test(r.error),
       "an unknown control type lists the real ones: " + r.error);
r = call("add_control", { layer: "A", type: "slider" });
assert(!r.ok && /'name' is required/.test(r.error),
       "a control with no name is refused");

// The generated expression must be the inline chained pickwhip form —
// a stored Property reference breaks the moment a layer is renamed.
r = call("apply_expression_preset", { layer: "A", property: "position",
  preset: "wiggle", frequency: 3,
  ampControl: { layer: "A", effect: "Amp" } });
assert(r.ok && r.data.expression ===
         'wiggle(3, thisComp.layer("A").effect("Amp")(1));',
       "wiggle is driven by the control, inline: " +
       (r.error || r.data.expression));
assert(A.property("Transform").property("Position").expression ===
       r.data.expression, "and AE really carries it");
r = call("apply_expression_preset", { layer: "A", property: "rotation",
  preset: "wiggle", ampControl: { layer: "A", effect: "Absent" } });
assert(!r.ok && /add_control first/.test(r.error),
       "a control that is not there sends you to add_control: " + r.error);
r = call("apply_expression_preset", { layer: "A", property: "rotation",
                                      preset: "bounce" });
assert(!r.ok &&
       /wiggle, loop_cycle, loop_pingpong, loop_offset, time_linear/
         .test(r.error),
       "an unknown preset lists the five that exist: " + r.error);
r = call("apply_expression_preset", { layer: "A", property: "position",
                                      preset: "time_linear" });
assert(!r.ok && /link_property/.test(r.error),
       "time_linear refuses an ARRAY property with a route out: " + r.error);
call("set_expression", { layer: "A", property: "position", expression: "" });

// A missing 'property' was the one refusal in the host that told the
// model NOTHING back: the string "Missing 'property'", no list of what
// it could have said, no sign of what this layer carries. Measured with
// the real model (chat-probe step 23, all four phrasings of "keep it
// drifting"): every run omitted 'property' on its first
// apply_expression_preset, two gave up on the bare error, and one lost
// the whole round to a rollback and then re-sent every command EXCEPT
// the one that had failed — leaving a null rig wired to Beta and no
// wiggle anywhere. Grounded errors are how the small local model
// self-corrects (CLAUDE.md), so the refusal now names the transform
// words, the layer's OWN effects (the only way to spell
// effect.<Effect>.<Param>) and whatever is already keyframed.
r = call("apply_expression_preset", { layer: "A", preset: "wiggle" });
assert(!r.ok && /Missing 'property'/.test(r.error) &&
       /position, scale, rotation, opacity or anchorPoint/.test(r.error),
       "a missing 'property' lists the transform words: " + r.error);
assert(!r.ok && /'position' is the drift\/float\/hover one/.test(r.error),
       "…and the wiggle preset says which one it meant: " + r.error);
assert(/effect\.<Effect>\.<Param>[\s\S]{0,60}Gaussian Blur/.test(r.error),
       "…and the layer's real effects, so the effect form is spellable: " +
       r.error);
assert(A.property("Transform").property("Position").expression === "",
       "…and nothing was applied");
r = call("apply_expression_preset", { layer: "A", preset: "loop_cycle" });
assert(!r.ok && /the property that HAS the keyframes/.test(r.error),
       "a loop preset asks for the keyframed property instead: " + r.error);
r = call("apply_expression_preset", { layer: "A", preset: "time_linear" });
assert(!r.ok && /scalar property/.test(r.error),
       "time_linear asks for a scalar one: " + r.error);
// The keyed half is what a loop_* caller actually needs, so it has to be
// read off the layer rather than guessed.
call("add_keyframe", { layer: "A", property: "rotation", time: 0, value: 0 });
r = call("apply_expression_preset", { layer: "A", preset: "loop_cycle" });
assert(!r.ok && /Already keyframed here: rotation/.test(r.error),
       "…and the refusal names the property that has keys: " + r.error);
call("remove_keyframes", { layer: "A", property: "rotation" });
r = call("apply_expression_preset", { layer: "A", preset: "loop_cycle" });
assert(!r.ok && !/Already keyframed/.test(r.error),
       "…and stops saying so once the keys are gone: " + r.error);
// Every tool that resolves a property shares the refusal, including the
// path-aware resolver behind set_expression / get_property.
r = call("set_expression", { layer: "A", expression: "wiggle(2, 30)" });
assert(!r.ok && /Missing 'property'/.test(r.error) &&
       /position, scale, rotation, opacity or anchorPoint/.test(r.error),
       "the path-aware resolver grounds it too: " + r.error);
r = call("get_property", { layer: "A" });
assert(!r.ok && /Missing 'property'/.test(r.error) &&
       /On 'A'/.test(r.error),
       "…and it names the layer it is talking about: " + r.error);

// add_keyframe / remove_keyframes: the 50 ms nearest-key tolerance is the
// whole contract of removing BY TIME, and nothing tested it.
r = call("add_keyframe", { layer: "B", property: "rotation", value: 45 });
assert(!r.ok && /'time'/.test(r.error),
       "add_keyframe without a time is refused: " + r.error);
[0, 1, 2].forEach((t, i) => {
  r = call("add_keyframe", { layer: "B", property: "rotation", time: t,
                             value: t * 90 });
  assert(r.ok && r.data.numKeys === i + 1,
         "add_keyframe " + (i + 1) + " counts its keys: " + (r.error || ""));
});
r = call("remove_keyframes", { layer: "B", property: "rotation",
                               times: [1.02] });
assert(r.ok && r.data.removed === 1 && r.data.remaining === 2,
       "a time within 50 ms takes the key it meant: " +
       (r.error || r.data.removed));
r = call("remove_keyframes", { layer: "B", property: "rotation",
                               times: [1.5] });
assert(r.ok && r.data.removed === 0 && r.data.remaining === 2,
       "a time that matches nothing removes nothing (no nearest-wins)");
const bRot = B.property("Transform").property("Rotation");
assert(bRot.keyTime(1) === 0 && bRot.keyTime(2) === 2,
       "the OUTER keys are the two that survived");
r = call("remove_keyframes", { layer: "B", property: "rotation" });
assert(r.ok && r.data.removed === 2 && r.data.remaining === 0,
       "and no times at all clears the property");

// set_layer_3d, and the trap underneath it: the property tree is the same
// either way, so threeDLayer is the ONLY answer to "is this layer 3D".
const tree2d = call("list_properties", { layer: "A", path: "transform" });
assert(tree2d.ok &&
       tree2d.data.properties.some(p => /Z Position/.test(p.path)),
       "a 2D layer already advertises Z Position");
r = call("set_layer_3d", { layer: "A", enabled: true });
assert(r.ok && r.data.threeD === true && A.threeDLayer === true,
       "set_layer_3d turns the layer 3D: " + (r.error || ""));
const tree3d = call("list_properties", { layer: "A", path: "transform" });
assert(JSON.stringify(tree3d.data.properties.map(p => p.matchName)) ===
       JSON.stringify(tree2d.data.properties.map(p => p.matchName)),
       "the 3D tree holds the same properties, matchName for matchName");
const renamed = tree3d.data.properties
  .map((p, i) => [tree2d.data.properties[i].path, p.path])
  .filter(([was, now]) => was !== now);
assert(renamed.length === 1 &&
       renamed[0].join(" -> ") ===
         "transform/Rotation -> transform/Z Rotation",
       "exactly one display name moves: Rotation -> Z Rotation (" +
       renamed.map(x => x.join(" -> ")).join(", ") + ")");
// The consequence, and the direction it runs in: a 3D layer answers to
// BOTH names, so a path written while the layer was 2D keeps working.
r = call("get_property", { layer: "A", property: "transform/Z Rotation" });
assert(r.ok && r.data.matchName === "ADBE Rotate Z",
       "the new display name resolves on a 3D layer: " + (r.error || ""));
r = call("get_property", { layer: "A", property: "transform/Rotation" });
assert(r.ok && r.data.matchName === "ADBE Rotate Z",
       "and so does the old one — AE keeps it: " + (r.error || ""));
r = call("get_property", { layer: "A", property: "rotation" });
assert(r.ok && r.data.matchName === "ADBE Rotate Z",
       "the friendly alias lands on ADBE Rotate Z: " + (r.error || ""));
// Turning 3D back off throws values away and AE says nothing about it.
// The tool reads them BEFORE the write and names what it is losing: a
// static Z, a Z that only exists on a KEYFRAME (a layer sitting at Z 0
// right now can still animate to 500), and the 3D-only rotations. It
// does not refuse and does not restore -- the user asked for 2D.
const aT = A.property("ADBE Transform Group");
aT.property("ADBE Anchor Point").setValue([10, 20, -150]);
aT.property("ADBE Orientation").setValue([0, 0, 33]);
aT.property("ADBE Rotate X").setValue(44);
aT.property("ADBE Position").setValueAtTime(0, [100, 100, 0]);
aT.property("ADBE Position").setValueAtTime(1, [100, 100, 500]);
// ...with an expression on Position too, which is the ordering trap real
// AE caught: a rigged layer evaluates to wiggle noise, so an
// expression-before-keyframes read reports that noise as the loss and
// never mentions the 500 waiting on the next key.
aT.property("ADBE Position").expression = "wiggle(2, 20)";
r = call("set_layer_3d", { layer: "A", enabled: false });
aT.property("ADBE Position").expression = "";
assert(r.ok && r.data.threeD === false && A.threeDLayer === false,
       "and back off again");
assert(r.data.discarded &&
       r.data.discarded.join("; ") ===
         "Position Z on 1 of 2 keyframes (largest 500); " +
         "Anchor Point Z -150; Orientation 33; X Rotation 44",
       "the switch names every 3D-only value it discarded: " +
       ((r.data.discarded || ["(nothing)"]).join("; ")));
assert(aT.property("ADBE Anchor Point").value[2] === 0 &&
       aT.property("ADBE Position").keyValue(2)[2] === 0 &&
       aT.property("ADBE Rotate X").value === 0,
       "and the loss is real, keyframes included");
r = call("set_layer_3d", { layer: "A", enabled: true });
assert(r.ok && !r.data.discarded,
       "turning 3D back ON discards nothing (and restores nothing)");
assert(aT.property("ADBE Anchor Point").value[2] === 0,
       "the Z really is gone for good, not stashed by AE");
r = call("set_layer_3d", { layer: "A", enabled: false });
assert(r.ok && !r.data.discarded,
       "a switch with nothing left to lose reports no loss: " +
       ((r.data.discarded || []).join("; ")));
// Scale is the odd one: AE resets its Z to 100, not to 0, so 100 is
// what "nothing lost" looks like there.
A.threeDLayer = true;
aT.property("ADBE Scale").setValue([50, 60, 70]);
r = call("set_layer_3d", { layer: "A", enabled: false });
assert(r.ok && r.data.discarded &&
       r.data.discarded.join("; ") === "Scale Z 70",
       "Scale Z counts as lost against 100, not 0: " +
       ((r.data.discarded || ["(nothing)"]).join("; ")));
assert(aT.property("ADBE Scale").value[2] === 100,
       "and AE parks Scale Z back at 100");
// An expression-driven Z is a loss too -- the expression survives the
// switch, the third dimension it was writing into does not.
A.threeDLayer = true;
aT.property("ADBE Position").removeKey(2);
aT.property("ADBE Position").removeKey(1);
aT.property("ADBE Position").setValue([100, 100, 250]);
aT.property("ADBE Position").expression = "value";
r = call("set_layer_3d", { layer: "A", enabled: false });
aT.property("ADBE Position").expression = "";
assert(r.ok && r.data.discarded &&
       r.data.discarded[0] ===
         "Position Z (expression-driven, currently 250)",
       "an expression-driven Z is reported as one: " +
       ((r.data.discarded || ["(nothing)"]).join("; ")));
// The other direction is where it bites: "Z Rotation" is not a name a 2D
// layer has ever had, so a path written while it was 3D now refuses --
// grounded, listing what the tree really holds.
r = call("get_property", { layer: "A", property: "transform/Z Rotation" });
assert(!r.ok && /Rotation/.test(r.error),
       "back in 2D the 3D-era name is refused with the real children: " +
       (r.error || "(it resolved!)"));

// duplicate_comp: AE names the copy, the tool renames it and says where
// it came from.
r = call("duplicate_comp", { name: "Props Copy" });
assert(r.ok && r.data.name === "Props Copy" &&
       r.data.duplicatedFrom === "Props" && typeof r.data.id === "number",
       "duplicate_comp reports the copy and its source: " + (r.error || ""));

// ---------------------------------------------------------------- deep
// search: a bare name AE's layer-level shortcut cannot see (WORKPLAN
// item 2 follow-up -- get_property could not reach a light's Radius).
const LIT = new Layer("Key", comp, "light");
const SHP = new Layer("Box", comp, "shape");
comp._layers.push(LIT, SHP);

// Stub fidelity first: if these ever start resolving on their own, the
// tests below stop testing the search and start testing nothing.
assert(LIT.property("Radius") === null &&
       LIT.property("Falloff Distance") === null,
       "stub fidelity: AE's layer shortcut does NOT reach a light's " +
       "Radius or Falloff Distance");
assert(LIT.property("Intensity") && LIT.property("Color") &&
       LIT.property("Cone Angle") && LIT.property("Shadow Diffusion") &&
       LIT.property("Intensity").matchName === "ADBE Light Intensity",
       "stub fidelity: it DOES reach Intensity, Color, Cone Angle and " +
       "Shadow Diffusion -- same group, arbitrary line");
assert(LIT.property("Falloff") === null,
       "stub fidelity: the three unreachable ones are exactly the " +
       "falloff-era additions");
assert(A.property("Blurriness") === null && SHP.property("Size") === null,
       "stub fidelity: nor an effect param, nor a shape's Size");
const style1 = A.property("ADBE Layer Styles").property("Drop Shadow");
assert(style1 && style1.enabled === false && style1.active === false &&
       style1.canSetEnabled === false && style1.elided === false,
       "stub fidelity: an unapplied layer style is indistinguishable " +
       "from an applied one");

r = call("get_property", { layer: "Key", property: "Radius" });
assert(r.ok && r.data.value === 300 &&
       r.data.matchName === "ADBE Light Falloff Start",
       "a bare 'Radius' now reaches the light option: " + (r.error || ""));
assert(r.ok && r.data.resolvedPath === "Light Options/Radius",
       "and the result NAMES the path it had to hunt for: " +
       (r.data ? r.data.resolvedPath : r.error));
r = call("get_property", { layer: "Key", property: "Falloff Distance" });
assert(r.ok && r.data.value === 400, "'Falloff Distance' too");
r = call("get_property", { layer: "Key",
                           property: "ADBE Light Shadow Diffusion" });
assert(r.ok && r.data.value === 60,
       "a bare matchName resolves the same way: " + (r.error || ""));

// The group path still works and still reports NO resolvedPath -- the
// field only appears when the search actually did the finding.
r = call("get_property", { layer: "Key", property: "light/Radius" });
assert(r.ok && r.data.value === 300 &&
       typeof r.data.resolvedPath === "undefined",
       "the documented group path is untouched and claims no hunt");
r = call("get_property", { layer: "A", property: "opacity" });
assert(r.ok && typeof r.data.resolvedPath === "undefined",
       "nor does a friendly name");

// Rank, not depth: "Size" exists at depth 3 under seven Layer Styles
// nobody applied and at depth 5 under Contents. The shallow ones must
// lose.
r = call("get_property", { layer: "Box", property: "Size" });
assert(r.ok && r.data.resolvedPath ===
         "Contents/Group 1/Contents/Rectangle Path 1/Size",
       "a shape's Size beats seven Layer Styles copies of the name: " +
       (r.ok ? r.data.resolvedPath : r.error));
assert(r.ok && r.data.alsoMatched && r.data.alsoMatched.length === 3 &&
       /Layer Styles/.test(r.data.alsoMatched[0]),
       "and the losers are named, not swallowed: " +
       JSON.stringify(r.data && r.data.alsoMatched));
// Transform wins over Layer Styles for the same reason, via the shortcut
// AE itself provides -- no search, no report.
r = call("get_property", { layer: "Box", property: "Opacity" });
assert(r.ok && r.data.value === 100 &&
       typeof r.data.resolvedPath === "undefined",
       "'Opacity' still means the Transform one");

// An effect param by bare name, and by a path whose HEAD the layer
// cannot see either.
r = call("get_property", { layer: "A", property: "Blurriness" });
assert(r.ok && r.data.resolvedPath === "Effects/Gaussian Blur/Blurriness",
       "a bare effect param resolves: " +
       (r.ok ? r.data.resolvedPath : r.error));
r = call("get_property", { layer: "A",
                           property: "Gaussian Blur/Blurriness" });
assert(r.ok && r.data.resolvedPath === "Effects/Gaussian Blur/Blurriness",
       "so does a path starting at the effect: " +
       (r.ok ? r.data.resolvedPath : r.error));

// Writing through the search, and the write really landing.
r = call("set_property", { layer: "Key", property: "Radius", value: 150 });
assert(r.ok && r.data.resolvedPath === "Light Options/Radius" &&
       LIT.property("ADBE Light Options Group")
          .property("ADBE Light Falloff Start").value === 150,
       "set_property writes through the search and says where: " +
       (r.error || ""));

// A tie is never guessed between. Two effects with a same-named param sit
// at equal rank and equal depth: that is a refusal listing both.
const fxA = A.property("ADBE Effect Parade");
const g1 = new PGroup("Tint", "ADBE Tint");
g1.add(new Prop("Amount", "ADBE Tint-0001", 0));
const g2 = new PGroup("Fill", "ADBE Fill");
g2.add(new Prop("Amount", "ADBE Fill-0001", 0));
fxA.add(g1); fxA.add(g2);
r = call("get_property", { layer: "A", property: "Amount" });
assert(!r.ok && /ambiguous/.test(r.error) &&
       /Effects\/Tint\/Amount/.test(r.error) &&
       /Effects\/Fill\/Amount/.test(r.error),
       "an equal tie is refused with both real paths: " +
       (r.error || "(it picked one!)"));
r = call("set_property", { layer: "A", property: "Amount", value: 5 });
assert(!r.ok && /ambiguous/.test(r.error) &&
       g1.property("Amount").value === 0 && g2.property("Amount").value === 0,
       "and a WRITE to an ambiguous name changes nothing");

// Nothing found: the old grounded error survives and grows the search.
r = call("get_property", { layer: "Key", property: "Blurriness" });
assert(!r.ok && /searched the whole tree/.test(r.error) &&
       /Children here/.test(r.error),
       "a name that is nowhere keeps the grounded error and adds the " +
       "search: " + (r.error || ""));
r = call("get_property", { layer: "Key", property: "Falloff" });
assert(r.ok && r.data.matchName === "ADBE Light Falloff Type",
       "an exact name still beats the longer ones containing it");
r = call("get_property", { layer: "Key", property: "Diffusion" });
assert(!r.ok && /Names containing it/.test(r.error) &&
       /Shadow Diffusion/.test(r.error),
       "a near miss names the real neighbours: " + (r.error || ""));

// ------------------------------------- grounded effect errors (audit 0.11)
// The three bare paths: "Effect not available", "Effect not found on
// layer" and "Parameter not found" each said only that, leaving the
// small model nothing to retry from.

r = call("apply_effect", { layer: "A", effect: "CC Particle World" });
assert(!r.ok && /Effect not available: CC Particle World/.test(r.error),
       "apply_effect still names the effect that missed");
assert(/display name nor a matchName/.test(r.error),
       "and says what the lookup tried: " + r.error.slice(0, 100));
assert(/list_effects \{filter: "cc"\}/.test(r.error),
       "and points to list_effects WITH its filter arg: " +
       r.error.slice(90, 220));
assert(/Effects already on 'A'/.test(r.error) &&
       /Gaussian Blur/.test(r.error) && /set_effect_param/.test(r.error),
       "and lists the layer's real effects so 'wrong tool' is " +
       "distinguishable from 'not installed'");

r = call("set_effect_param", { layer: "A", effect: "Glow",
                               param: "Threshold" });
assert(!r.ok && /Effect not found on layer: Glow/.test(r.error),
       "set_effect_param still names the effect that missed");
assert(/Effects on 'A':/.test(r.error) && /Gaussian Blur/.test(r.error) &&
       /Grid X Spacing/.test(r.error),
       "and lists what the layer really carries: " + r.error.slice(0, 140));
assert(/apply_effect/.test(r.error),
       "and names the tool that adds a missing one");

r = call("set_effect_param", { layer: "A", effect: "Gaussian Blur",
                               param: "Radius" });
assert(!r.ok && /Parameter not found: Radius/.test(r.error),
       "a bad param is still named");
assert(/'Gaussian Blur' has: Blurriness/.test(r.error),
       "and the effect's real parameters are listed: " +
       r.error.slice(0, 120));
assert(/list_properties/.test(r.error) &&
       /effects\/Gaussian Blur/.test(r.error),
       "and the lister that shows types/values is named with its path");

// ------------------------------- set_track_matte wraps AE's raw message
// AE's throw alone ("Object is invalid" and friends) tells the model
// nothing about mattes; the wrap keeps the raw text and adds the
// constraints it cannot guess.

const rawSet = A.setTrackMatte;
A.setTrackMatte = function () {
  throw new Error("After Effects error: invalid matte layer");
};
r = call("set_track_matte", { layer: "A", matteLayer: "B", mode: "luma" });
assert(!r.ok && /AE rejected the matte: .*invalid matte layer/
         .test(r.error),
       "the raw AE message survives the wrap: " + r.error.slice(0, 80));
assert(/visual \(AV\) layers/.test(r.error) && /camera/.test(r.error),
       "and the layer-type constraint is spelled out");
assert(/alpha, alpha_inverted, luma, luma_inverted or none/.test(r.error),
       "and the valid modes ride along, matching the mode refusal");
assert(/'A' is /.test(r.error) && /'B' is /.test(r.error),
       "and both layers' actual types are reported: " +
       r.error.slice(100, 260));
A.setTrackMatte = rawSet;

// A real matte first: the removal guard added 2026-09-02 refuses before
// AE is ever called when there is nothing to remove, so without this the
// step below would measure the guard instead of AE's raw message.
call("set_track_matte", { layer: "A", matteLayer: "B", mode: "luma" });
const rawRemove = A.removeTrackMatte;
A.removeTrackMatte = function () {
  throw new Error("After Effects error: Object is invalid");
};
r = call("set_track_matte", { layer: "A", mode: "none" });
assert(!r.ok && /Could not remove the matte: .*Object is invalid/
         .test(r.error),
       "removal failure keeps AE's raw message too");
assert(/visual \(AV\) layers/.test(r.error) &&
       /get_comp_details/.test(r.error),
       "with the constraint and the tool that shows layer types: " +
       r.error.slice(0, 140));
A.removeTrackMatte = rawRemove;

// ---------------- a camera or a light NEVER takes (or makes) a matte
// The zero-silent-failure hole WORKPLAN 1b's real-AE probe found on
// 2026-09-01: a camera is not an AVLayer and has no setTrackMatte, so
// the legacy branch ran, `camera.trackMatteType = LUMA` was ACCEPTED
// without throwing (it read back 5015), and the tool reported ok for a
// matte After Effects never made — after moveBefore had already
// reordered the user's stack. Nothing threw, so the wrap above could
// not catch it: the refusal has to be by TYPE, before anything moves.
const CAM = new Layer("Cam 1", comp, "camera");
comp._layers.push(CAM);
assert(CAM instanceof CameraLayer && LIT instanceof LightLayer &&
       SHP instanceof ShapeLayer && A instanceof AVLayer,
       "stub fidelity: each layer answers its own AE class");
// The trap the first cut at this fix fell into, pinned so it cannot be
// re-set: in ExtendScript a TEXT layer and a SHAPE layer are not
// `instanceof AVLayer` either, so that predicate is not the AV test it
// reads as — it refuses two types that matte perfectly well.
assert(!(CAM instanceof AVLayer) && !(LIT instanceof AVLayer) &&
       !(SHP instanceof AVLayer),
       "stub fidelity: instanceof AVLayer is false for shape layers too");
assert(typeof CAM.setTrackMatte === "undefined" &&
       typeof CAM.removeTrackMatte === "undefined",
       "stub fidelity: a camera carries neither matte method");
assert(typeof SHP.setTrackMatte === "function",
       "stub fidelity: a shape layer does carry setTrackMatte");

const stackBefore = comp._layers.map(l => l.name).join(",");
r = call("set_track_matte", { layer: "Cam 1", matteLayer: "B",
                              mode: "luma" });
assert(!r.ok, "a camera TARGET is refused, not silently 'set': " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(/'Cam 1' is camera/.test(r.error) &&
       /cannot take a track matte/.test(r.error),
       "…naming the layer and its measured type: " + r.error);
assert(/visual \(AV\) layers/.test(r.error) &&
       /get_comp_details/.test(r.error),
       "…with the rule and the tool that shows layer types");
assert(comp._layers.map(l => l.name).join(",") === stackBefore,
       "…and NOTHING moved in the layer stack");
assert(typeof CAM.trackMatteType === "undefined",
       "…and no phantom trackMatteType was written on the camera");

r = call("set_track_matte", { layer: "Key", matteLayer: "B",
                              mode: "alpha" });
assert(!r.ok && /'Key' is light/.test(r.error),
       "a light target is refused the same way: " + r.error);

// mode:"none" lied identically — a matte that never existed reported
// "removed" — so the guard has to sit ahead of the removal branch too.
r = call("set_track_matte", { layer: "Cam 1", mode: "none" });
assert(!r.ok && /cannot take a track matte/.test(r.error),
       "removing a matte from a camera is refused, not reported removed: " +
       JSON.stringify(r.ok ? r.data : r.error));

r = call("set_track_matte", { layer: "A", matteLayer: "Cam 1",
                              mode: "alpha" });
assert(!r.ok && /matteLayer 'Cam 1' is camera/.test(r.error) &&
       /cannot BE a matte/.test(r.error),
       "a camera MATTE is refused by type before AE is asked: " + r.error);
// (the word is whatever AELL_layerType makes of this stub's source —
// what matters is that the TARGET is named and typed too, the way the
// AE-throw wrap above does it)
assert(/\(layer: 'A' is \w+\)/.test(r.error),
       "…and the target's type rides along, as the AE-throw wrap does");

// …and the guard stops exactly there. A shape layer matting a solid, and
// a shape layer BEING the matte, both still go through — the over-broad
// first cut refused both.
r = call("set_track_matte", { layer: "Box", matteLayer: "A",
                              mode: "luma" });
assert(r.ok && r.data.layer === "Box" && r.data.matte === "A",
       "a SHAPE layer still takes a matte: " +
       JSON.stringify(r.ok ? r.data : r.error));
r = call("set_track_matte", { layer: "A", matteLayer: "Box",
                              mode: "alpha_inverted" });
assert(r.ok && r.data.matte === "Box" && r.data.mode === "alpha_inverted",
       "…and still IS one: " + JSON.stringify(r.ok ? r.data : r.error));
r = call("set_track_matte", { layer: "Box", mode: "none" });
assert(r.ok && r.data.matte === "removed",
       "…and removal on a shape layer is untouched: " +
       JSON.stringify(r.ok ? r.data : r.error));
r = call("set_track_matte", { layer: "A", mode: "none" });
assert(r.ok, "…as it is on a solid");
comp._layers.splice(comp._layers.indexOf(CAM), 1);

// ------------------------------------- remove_effect (audit 0.11 item 4)
// "Take off the glow" had no tool. A reverted host answers every call
// below with "Unknown tool: remove_effect", so the first assertion is the
// whole proof; the rest pin the receipt, the first-match rule and the
// grounded refusals. A carries Gaussian Blur, Grid X Spacing, the two
// controls earlier sections added, Tint and Fill — the expectations are
// taken from the parade itself rather than from a list that would rot.
const fxNames = () => {
  const out = [];
  for (let i = 1; i <= fxA.numProperties; i++) out.push(fxA.property(i).name);
  return out.join(", ");
};
const fxBefore = fxNames();
const fxWithout = (nm) => fxBefore.split(", ").filter(n => n !== nm).join(", ");
assert(/Tint/.test(fxBefore) && /Fill/.test(fxBefore),
       "A carries Tint and Fill going in (" + fxBefore + ")");
r = call("remove_effect", { layer: "A", effect: "Tint" });
assert(r.ok, "remove_effect removes by display name: " + (r.error || ""));
assert(r.ok && r.data.layer === "A" && r.data.removed === "Tint" &&
       r.data.matchName === "ADBE Tint" &&
       r.data.remainingEffects.join(", ") === fxWithout("Tint"),
       "receipt: {layer, removed, remainingEffects} (got " +
       JSON.stringify(r.ok ? r.data : r.error) + ")");
assert(fxNames() === fxWithout("Tint"),
       "the parade really lost it (holds: " + fxNames() + ")");
assert(r.ok && r.data.alsoMatched === undefined && r.data.note === undefined,
       "a single match carries no duplicate note");

// Two copies share one matchName; AE numbers the second "Glow 2". A
// matchName call removes the FIRST and says what else matched.
const glow1 = new PGroup("Glow", "ADBE Glo2");
glow1.add(new Prop("Glow Threshold", "ADBE Glo2-0001", 60));
const glow2 = new PGroup("Glow 2", "ADBE Glo2");
glow2.add(new Prop("Glow Threshold", "ADBE Glo2-0001", 60));
fxA.add(glow1); fxA.add(glow2);
r = call("remove_effect", { layer: "A", effect: "ADBE Glo2" });
assert(r.ok && r.data.removed === "Glow" &&
       r.data.alsoMatched.join(",") === "Glow 2" &&
       /2 effects matched 'ADBE Glo2'/.test(r.data.note) &&
       /removed the first/.test(r.data.note) && /Glow 2 still/.test(r.data.note),
       "two matchName hits: the top-most goes and the receipt names the " +
       "survivor: " + JSON.stringify(r.ok ? r.data : r.error));
assert(fxNames() === fxWithout("Tint") + ", Glow 2",
       "only the first copy is gone (holds: " + fxNames() + ")");

// The model lowercases what the user said: exact wins, then case-blind.
r = call("remove_effect", { layer: "A", effect: "glow 2" });
assert(r.ok && r.data.removed === "Glow 2" &&
       r.data.remainingEffects.indexOf("Glow 2") === -1,
       "a case-insensitive display name still finds it: " +
       JSON.stringify(r.ok ? r.data : r.error));

// The two AE facts remove_effect's body leans on, measured 2026-09-02
// (scripts/verb-semantics-probe.jsx, AE 2026): survivors keep the names
// AE numbered them with, and every sibling reference held across the
// removal goes stale. The receipt has to be built from strings taken
// BEFORE the call — a host that read matches[i].name afterwards would
// throw "Object is invalid" out of a tool that had already succeeded.
const sib = new Layer("Sib", comp);
const sibFx = sib.property("ADBE Effect Parade");
sibFx._children.length = 0;
["Gaussian Blur", "Gaussian Blur 2", "Gaussian Blur 3"].forEach((n, i) => {
  const g = new PGroup(n, "ADBE Gaussian Blur 2");
  g.add(new Prop("Blurriness", "ADBE Gaussian Blur 2-0001", (i + 1) * 11));
  sibFx.add(g);
});
comp._layers.push(sib);
// By matchName, so all three match and the receipt has to name the two
// survivors — the read that would throw if it happened after remove().
r = call("remove_effect", { layer: "Sib", effect: "ADBE Gaussian Blur 2" });
assert(r.ok && r.data.removed === "Gaussian Blur" &&
       r.data.remainingEffects.join(", ") === "Gaussian Blur 2, Gaussian Blur 3",
       "survivors keep the numbers AE gave them — nothing is renumbered " +
       "down: " + JSON.stringify(r.ok ? r.data : r.error));
assert(r.ok && r.data.alsoMatched.join(",") === "Gaussian Blur 2,Gaussian Blur 3",
       "…and the receipt names them, which is only possible because the " +
       "host read those names before the removal: " +
       JSON.stringify(r.ok ? r.data.alsoMatched : r.error));
// The staleness itself, at the primitive: hold both survivors, drop one,
// and read the other with nothing re-fetching in between — which is the
// shape the host would have if `others` were built after victim.remove()
// instead of before it.
const stale = (p) => {
  try { return String(p.name); }
  catch (e) { return "THREW: " + e.message; }
};
const keptA = sibFx.property(1), keptB = sibFx.property(2);
keptA.remove();
assert(/Object is invalid/.test(stale(keptB)),
       "a sibling reference held across remove() is dead: " + stale(keptB));
assert(/Object is invalid/.test(stale(keptA)),
       "…and so is the removed one: " + stale(keptA));
assert(sibFx.property(1).name === "Gaussian Blur 3",
       "re-fetching through property() hands back a live reference again " +
       "(the PATH went stale, the property did not): " +
       sibFx.property(1).name);
comp._layers.splice(comp._layers.indexOf(sib), 1);

// Grounded refusals.
r = call("remove_effect", { layer: "A", effect: "Glow" });
assert(!r.ok && /No effect 'Glow' on 'A'/.test(r.error) &&
       r.error.indexOf("Effects here: " + fxWithout("Tint")) !== -1 &&
       /apply_effect/.test(r.error),
       "a miss lists the layer's real effects: " + r.error);
assert(fxNames() === fxWithout("Tint"),
       "…and removed nothing");
r = call("remove_effect", { layer: "A" });
assert(!r.ok && /'effect' is required/.test(r.error) &&
       /Effects on 'A': Gaussian Blur/.test(r.error),
       "a missing 'effect' arg lists what could be named: " + r.error);
const bare = new Layer("Bare", comp);
bare.property("ADBE Effect Parade")._children.length = 0;
comp._layers.push(bare);
r = call("remove_effect", { layer: "Bare", effect: "Glow" });
// It used to point at apply_effect, which is an ADD offered to a REMOVE
// caller. Measured 2026-09-02 (chat-probe row 29): the model hit this
// refusal and guessed seven MORE effect names in the same round, so the
// sentence has to close the door instead of opening another one.
assert(!r.ok && /'Bare' has no effects at all/.test(r.error) &&
       /no other effect name will match/.test(r.error) &&
       !/apply_effect/.test(r.error),
       "a layer with no effects is refused in a way that stops the " +
       "guessing, and offers no ADD to a REMOVE caller: " + r.error);
// (The stub light is not an instanceof LightLayer, so the type word is
// whatever AELL_layerType falls back to — the refusal is what matters.)
r = call("remove_effect", { layer: "Key", effect: "Glow" });
assert(!r.ok && /'Key' is a \w+ layer and cannot carry effects/.test(r.error),
       "a light (no Effect Parade at all) is refused by type: " + r.error);

// {layer} omitted = the selection, and the selection survives the call.
comp._layers.forEach(l => { l.selected = l.name === "B"; });
r = call("remove_effect", { effect: "Gaussian Blur" });
assert(r.ok && r.data.layer === "B" && r.data.removed === "Gaussian Blur",
       "no {layer}: the selected layer's effect goes: " +
       JSON.stringify(r.ok ? r.data : r.error));
assert(comp.selectedLayers.length === 1 && comp.selectedLayers[0] === B,
       "…and B is still the selection afterwards");
comp._layers.forEach(l => { l.selected = false; });
comp._layers.splice(comp._layers.indexOf(bare), 1);

// ---------------------------------------------------------------------
// 20. The carpet-bomb gate on remove_keyframes, and the refusal that
//     used to load the gun.
//
// Measured 2026-09-02 in real AE (chat-probe row 29, "Probe Room's got
// junk everywhere, tidy it"): the model called remove_keyframes with no
// targets, met the grounded "Layers here: ..." refusal, copied all
// twelve names straight back out of it into ONE call, and the tool
// answered {"layers":12,"property":"opacity","removed":18} -- ok,
// receipt, 18 keyframes nobody named gone. Two halves, both here: the
// refusal must stop handing out the roster as a target list, and a wipe
// over EVERY layer in the comp must be seen before it happens.

comp._layers.forEach(l => { l.selected = false; });
delete $.global.AELL_wipeShown;
$.global.AELL_requestSeq = 0;
$.global.AELL_newRequest();

const wipeNames = comp._layers.map(l => l.name);
wipeNames.forEach(n => {
  call("set_keyframes", { layer: n, property: "opacity",
    keys: [{ time: 0, value: 0 }, { time: 1, value: 100 }] });
});
const wipeKeys = () => comp._layers.reduce((n, l) =>
  n + l.property("Transform").property("Opacity").numKeys, 0);
const keysBefore = wipeKeys();
assert(keysBefore === wipeNames.length * 2,
       "every layer in the stub comp starts with two opacity keys (" +
       keysBefore + ")");

// (a) the no-targets refusal names the layers -- it must, the model
//     cannot select -- but it no longer reads as "pass them all".
r = call("remove_keyframes", { property: "opacity" });
assert(!r.ok && /ONLY the layers the user named/.test(r.error) &&
       /ASK which ones/.test(r.error) &&
       /deletes animation/.test(r.error),
       "a destructive no-targets refusal says whose names to pass, and " +
       "to ask when there are none: " + r.error);
assert(/Layers here: /.test(r.error) &&
       /With opacity keyframes: /.test(r.error),
       "...and is still grounded in what exists: " + r.error);

// (b) naming every layer in the comp is refused, and the refusal IS the
//     preview -- with a question in it, because "clean it up" has no
//     answer inside the project.
r = call("remove_keyframes", { layers: wipeNames, property: "opacity" });
assert(!r.ok && /refused to wipe every layer/.test(r.error),
       "a wipe across the whole comp is refused: " +
       (r.ok ? "IT RAN" : r.error));
assert(/nothing has been previewed yet/.test(r.error),
       "and says why: " + r.error);
assert(new RegExp("delete " + keysBefore + " opacity keyframe\\(s\\) from " +
                  wipeNames.length + " layer\\(s\\)").test(r.error),
       "the refusal counts exactly what would go: " + r.error);
assert(/ask the user WHICH/.test(r.error),
       "and asks which, rather than offering to do it all: " + r.error);
assert(wipeKeys() === keysBefore, "nothing was removed");

// A retry inside the SAME reply is refused too -- nobody has seen it.
r = call("remove_keyframes", { layers: wipeNames, property: "opacity" });
assert(!r.ok && /THIS same reply/.test(r.error),
       "a retry in the same reply is refused: " + r.error);
assert(wipeKeys() === keysBefore, "still nothing removed");

// The next user request has the preview behind it, so it goes through:
// this gates a guess, it does not forbid the action.
$.global.AELL_newRequest();
r = call("remove_keyframes", { layers: wipeNames, property: "opacity" });
assert(r.ok && r.data.removed === keysBefore,
       "the NEXT request wipes them: " + (r.ok ? r.data.removed : r.error));
assert(wipeKeys() === 0, "and the keys really went");

// Narrowness, three ways: a named SUBSET is never gated, a full-comp
// wipe with nothing to lose is not gated (a refusal about a no-op is
// noise), and {times} names its own keys, so it is not a guess.
delete $.global.AELL_wipeShown;
$.global.AELL_newRequest();
call("set_keyframes", { layers: wipeNames, property: "opacity",
  keys: [{ time: 0, value: 0 }, { time: 1, value: 100 }] });
r = call("remove_keyframes", { layers: wipeNames.slice(0, 2),
                               property: "opacity" });
assert(r.ok && r.data.removed === 4,
       "two named layers out of " + wipeNames.length + " are not gated: " +
       (r.ok ? r.data.removed : r.error));
$.global.AELL_newRequest();
r = call("remove_keyframes", { layers: wipeNames, property: "rotation" });
assert(r.ok && r.data.removed === 0,
       "a whole-comp wipe with no keys to lose is not gated: " +
       (r.ok ? "ok" : r.error));
$.global.AELL_newRequest();
delete $.global.AELL_wipeShown;
r = call("remove_keyframes", { layers: wipeNames, property: "opacity",
                               times: [0] });
assert(r.ok && r.data.removed > 0,
       "{times} names the keys it takes, so it is not gated: " +
       (r.ok ? r.data.removed : r.error));
$.global.AELL_newRequest();
call("remove_keyframes", { layers: wipeNames, property: "opacity" });
$.global.AELL_newRequest();
call("remove_keyframes", { layers: wipeNames, property: "opacity" });
comp._layers.forEach(l => { l.selected = false; });

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
