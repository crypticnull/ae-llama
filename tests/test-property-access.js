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
  this._keys = [];   // sorted [{time, value}]
}
Object.defineProperty(Prop.prototype, "value", {
  get() { return this._value; }
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

function Layer(name, comp) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.parent = null;
  this.inPoint = 0;
  this._root = new PGroup("(layer)", "(layer)");
  const t = new PGroup("Transform", "ADBE Transform Group");
  t.add(new Prop("Position", "ADBE Position", [100, 100]));
  t.add(new Prop("Scale", "ADBE Scale", [100, 100]));
  t.add(new Prop("Rotation", "ADBE Rotate Z", 0));
  t.add(new Prop("Opacity", "ADBE Opacity", 100));
  t.add(new Prop("Anchor Point", "ADBE Anchor Point", [0, 0]));
  const fx = new PGroup("Effects", "ADBE Effect Parade");
  const blur = new PGroup("Gaussian Blur", "ADBE Gaussian Blur 2");
  blur.add(new Prop("Blurriness", "ADBE Gaussian Blur 2-0001", 0));
  fx.add(blur);
  // a renamed Slider Control, like the grid rig's spacing controls
  const slider = new PGroup("Grid X Spacing", "ADBE Slider Control");
  slider.add(new Prop("Slider", "ADBE Slider Control-0001", 10));
  fx.add(slider);
  this._root.add(t);
  this._root.add(fx);
}
Object.defineProperty(Layer.prototype, "numProperties", {
  get() { return this._root._children.length; }
});
Layer.prototype.property = function (ref) { return this._root.property(ref); };
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

function Comp(name) {
  this.name = name;
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
       JSON.stringify(posEntry.value) === "[100,100]",
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

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
