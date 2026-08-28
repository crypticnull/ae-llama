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
PGroup.prototype.add = function (c) { this._children.push(c); return c; };
Object.defineProperty(PGroup.prototype, "numProperties", {
  get() { return this._children.length; }
});
PGroup.prototype.property = function (ref) {
  if (typeof ref === "number") return this._children[ref - 1] || null;
  return this._children.find(c => c.name === ref || c.matchName === ref ||
    (c._aliases || []).indexOf(ref) !== -1) || null;
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

function Layer(name, comp, kind) {
  this.name = name;
  this.comp = comp;
  this.kind = kind || "solid";
  this.selected = false;
  this.parent = null;
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
Layer.prototype.setParentWithJump = function (p) {
  this.parent = p;
  this._jumped = true;
};
Layer.prototype.setTrackMatte = function (m, t) {
  this._matte = m;
  this._matteType = t;
};
Layer.prototype.removeTrackMatte = function () {
  this._matte = null;
  this._matteType = null;
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
Comp.prototype.duplicate = function () {
  const c = new Comp(this.name + " 2");
  c.width = this.width;
  c.height = this.height;
  c.duration = this.duration;
  return c;
};

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};
const TrackMatteType = {
  ALPHA: "alpha", ALPHA_INVERTED: "alpha_inv",
  LUMA: "luma", LUMA_INVERTED: "luma_inv", NO_TRACK_MATTE: "none"
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
assert(r.ok && A.parent === CTRL && B.parent === CTRL && A._jumped,
       "multi-layer parenting uses setParentWithJump");
r = call("set_layer_parent", { layer: "A", parent: "none" });
assert(r.ok && A.parent === null, "'none' unparents");
r = call("set_layer_parent", { layers: ["CTRL"], parent: "CTRL" });
assert(!r.ok || /is the parent/.test(r.data.skipped || ""),
       "self-parenting skipped with a reason");

// 7. track mattes
r = call("set_track_matte", { layer: "A", matteLayer: "B", mode: "luma" });
assert(r.ok && A._matte === B && A._matteType === "luma",
       "set_track_matte wires luma matte via setTrackMatte");
r = call("set_track_matte", { layer: "A", mode: "none" });
assert(r.ok && A._matte === null, "mode none removes the matte");
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

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
