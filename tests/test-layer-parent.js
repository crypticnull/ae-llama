// Regression test: set_layer_parent, against a stub that models what real
// AE 2026 was measured doing (probe in WORKPLAN-LOG 2026-08-29).
//
// STUB FIDELITY — the whole point of this file. The tool shipped with its
// two AE calls swapped, and no stub anywhere modelled the difference, so
// nothing could catch it:
//   1. `layer.parent = p` is the PICK-WHIP. AE REWRITES the child's
//      Position/Scale/Rotation — and every keyframe on them — into the
//      parent's space, so the picture does not move and the numbers do.
//   2. `layer.setParentWithJump(p)` leaves every value alone, so the
//      layer JUMPS by the parent's transform.
//   3. Both rules hold for UNPARENTING (parent = null) as well.
// A stub whose `parent` setter did nothing would let the inverted tool
// pass, so the setter here does the real compensation arithmetic and the
// tests assert on where the layer ENDS UP, not on which call was made.
//
// Values are PADDED to 3 components for 2D layers (CLAUDE.md).
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

function Layer(name, comp) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.threeDLayer = false;
  this._parent = null;
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
Layer.prototype.property = function (name) {
  if (name === "ADBE Transform Group") {
    const t = this._transform;
    return { property(n) { return t[n] || null; } };
  }
  return null;
};
Layer.prototype._pos = function () {
  return this._transform["ADBE Position"].value;
};
// Where this layer's own coordinate origin sits in COMP space, walking
// the whole parent chain. Ancestor rotation/scale are left out on
// purpose — plain offsets are enough to tell "moved" from "did not".
Layer.prototype._originInComp = function () {
  const a = this._transform["ADBE Anchor Point"].value;
  const p = this._pos();
  let x = p[0] - a[0], y = p[1] - a[1], z = (p[2] || 0) - (a[2] || 0);
  let par = this._parent;
  while (par) {
    const pa = par._transform["ADBE Anchor Point"].value;
    const pp = par._pos();
    x += pp[0] - pa[0]; y += pp[1] - pa[1]; z += (pp[2] || 0) - (pa[2] || 0);
    par = par._parent;
  }
  return [x, y, z];
};
// The origin of whatever this layer is parented to, in comp space —
// [0,0,0] when it is parented to nothing.
Layer.prototype._parentOrigin = function () {
  return this._parent ? this._parent._originInComp() : [0, 0, 0];
};

// THE fidelity rule. `.parent = p` compensates; the stub does the same
// arithmetic AE was measured doing, on the current value AND on keys.
Object.defineProperty(Layer.prototype, "parent", {
  get() { return this._parent; },
  set(next) {
    const was = this._parentOrigin();
    this._parent = next || null;
    const now = this._parentOrigin();
    const d = [was[0] - now[0], was[1] - now[1], was[2] - now[2]];
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) return;
    const pos = this._transform["ADBE Position"];
    const shift = v => [v[0] + d[0], v[1] + d[1], (v[2] || 0) + d[2]];
    pos._value = shift(pos._value);
    for (let i = 0; i < pos.numKeys; i++) {
      pos._keyValues[i] = shift(pos._keyValues[i]);
    }
  }
});
// The other call: values untouched, so the layer moves on screen.
Layer.prototype.setParentWithJump = function (next) {
  this._parent = next || null;
};

// A layer type that predates setParentWithJump — the tool must refuse
// keepPosition:false on it rather than silently doing the opposite.
function OldLayer(name, comp) { Layer.call(this, name, comp); }
OldLayer.prototype = Object.create(Layer.prototype);
OldLayer.prototype.constructor = OldLayer;
OldLayer.prototype.setParentWithJump = undefined;

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

const comp = new Comp("Parenting");
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));

// Layers must be instanceof AVLayer for the host's type checks, so the
// prototype is rebuilt on AVLayer. Descriptors are collected down the
// WHOLE chain (base first, so a subclass wins) — taking only own
// descriptors would drop the inherited `parent` accessor and leave the
// stub answering `undefined` where AE answers null.
function addLayer(name, ctor) {
  const C = ctor || Layer;
  const l = new C(name, comp);
  const chain = [];
  for (let p = C.prototype; p && p !== Object.prototype;
       p = Object.getPrototypeOf(p)) {
    chain.unshift(Object.getOwnPropertyDescriptors(p));
  }
  const proto = Object.create(AVLayer.prototype);
  for (const d of chain) Object.defineProperties(proto, d);
  Object.setPrototypeOf(l, proto);
  comp._layers.push(l);
  return l;
}
function place(l, x, y) {
  l._transform["ADBE Position"].setValue([x, y, 0]);
  return l;
}
function posOf(l) { return l._transform["ADBE Position"].value; }
// Where the layer actually DRAWS: its origin in comp space. This is the
// number that must not change when a link preserves visual position.
function screenOf(l) { return l._originInComp(); }

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
{
  const p = place(addLayer("fid parent"), 100, 100);
  const c = place(addLayer("fid child"), 400, 300);
  c.parent = p;
  assert(posOf(c)[0] === 300 && posOf(c)[1] === 200,
         "stub: `.parent =` rewrites the child's Position (400,300 -> 300,200)");
  assert(near(screenOf(c)[0], 400) && near(screenOf(c)[1], 300),
         "stub: ...so the child has NOT moved on screen");
  const c2 = place(addLayer("fid jump"), 400, 300);
  c2.setParentWithJump(p);
  assert(posOf(c2)[0] === 400 && posOf(c2)[1] === 300,
         "stub: setParentWithJump leaves Position alone...");
  assert(near(screenOf(c2)[0], 500) && near(screenOf(c2)[1], 400),
         "stub: ...so the child DOES jump by the parent's transform");
  const c3 = place(addLayer("fid unpar"), 400, 300);
  c3.parent = p;
  c3.parent = null;
  assert(posOf(c3)[0] === 400 && posOf(c3)[1] === 300,
         "stub: unparenting with `.parent = null` restores comp-space values");
  assert(typeof (new OldLayer("old", comp)).setParentWithJump === "undefined",
         "stub: a layer without setParentWithJump models an older AE");
}

console.log("");
console.log("== the default keeps the layer STILL (the shipped bug) ==");
const par = place(addLayer("Null 1"), 300, 200);
const kid = place(addLayer("Kid"), 500, 400);
const before = screenOf(kid);
let r = call("set_layer_parent", { layer: "Kid", parent: "Null 1" });
assert(r.ok, "set_layer_parent succeeds");
assert(kid.parent === par, "the link was made");
assert(near(screenOf(kid)[0], before[0]) && near(screenOf(kid)[1], before[1]),
       "by default the layer does not move on screen — 500,400 stays 500,400");
assert(posOf(kid)[0] === 200 && posOf(kid)[1] === 200,
       "...because AE rewrote Position into the parent's space (200,200)");
assert(r.data.keepPosition === true, "the result reports keepPosition true");
assert(/rewrote/.test(r.data.note) && /Position/.test(r.data.note),
       "the note says the VALUES changed, not just that nothing moved: " +
       r.data.note);
assert(r.data.note !== "Visual positions preserved",
       "the old blanket note is gone");

console.log("");
console.log("== keepPosition:false is the one that jumps ==");
const kid2 = place(addLayer("Kid 2"), 500, 400);
r = call("set_layer_parent", { layer: "Kid 2", parent: "Null 1",
                               keepPosition: false });
assert(r.ok && kid2.parent === par, "the link was made");
assert(posOf(kid2)[0] === 500 && posOf(kid2)[1] === 400,
       "the values were left exactly as they were");
assert(near(screenOf(kid2)[0], 800) && near(screenOf(kid2)[1], 600),
       "...so the layer jumped by the parent's transform, as asked");
assert(r.data.keepPosition === false, "the result reports keepPosition false");
assert(/JUMPED/.test(r.data.note),
       "the note admits the jump: " + r.data.note);

console.log("");
console.log("== unparenting obeys the same rule ==");
r = call("set_layer_parent", { layer: "Kid", parent: null });
assert(r.ok && kid.parent === null, "the parent was cleared");
assert(posOf(kid)[0] === 500 && posOf(kid)[1] === 400,
       "unparenting by default restores comp-space values, so nothing moves");
assert(r.data.parent === "(none)", "the result names no parent");
assert(/Unparented/.test(r.data.note) && /comp space/.test(r.data.note),
       "the note is about unparenting, not about a parent: " + r.data.note);
r = call("set_layer_parent", { layer: "Kid 2", parent: "none",
                               keepPosition: false });
assert(r.ok && kid2.parent === null,
       "'none' clears the parent as well as null does");
assert(posOf(kid2)[0] === 500 && posOf(kid2)[1] === 400,
       "keepPosition:false left the raw values, so the layer jumped back");

console.log("");
console.log("== every keyframe is rewritten, and the tool says so ==");
const keyed = place(addLayer("Keyed"), 400, 300);
const kp = keyed._transform["ADBE Position"];
kp.setValueAtTime(0, [400, 300, 0]);
kp.setValueAtTime(2, [600, 300, 0]);
r = call("set_layer_parent", { layer: "Keyed", parent: "Null 1" });
assert(r.ok, "parenting a keyframed layer succeeds");
assert(kp.keyValue(1)[0] === 100 && kp.keyValue(2)[0] === 300,
       "AE shifted BOTH keys, not just the current value");
assert(/Keyed \(2\)/.test(r.data.keyframesRewritten || ""),
       "the layer and its key count are reported: " +
       r.data.keyframesRewritten);
assert(/all 2 transform/.test(r.data.keyframesNote || ""),
       "the note spells out that the old numbers are gone: " +
       r.data.keyframesNote);
const unkeyed = place(addLayer("Unkeyed"), 400, 300);
r = call("set_layer_parent", { layer: "Unkeyed", parent: "Null 1" });
assert(r.ok && unkeyed.parent === par && !r.data.keyframesRewritten,
       "a layer with no keys gets no keyframe note at all");
const keyed2 = place(addLayer("Keyed 2"), 400, 300);
const kp2 = keyed2._transform["ADBE Position"];
kp2.setValueAtTime(0, [400, 300, 0]);
r = call("set_layer_parent", { layer: "Keyed 2", parent: "Null 1",
                               keepPosition: false });
assert(r.ok && !r.data.keyframesRewritten,
       "keepPosition:false rewrites nothing, so it reports nothing");
assert(kp2.keyValue(1)[0] === 400, "...and the key really is untouched");

console.log("");
console.log("== an AE without setParentWithJump ==");
const old = place(addLayer("Old", OldLayer), 500, 400);
r = call("set_layer_parent", { layer: "Old", parent: "Null 1",
                               keepPosition: false });
assert(r.ok, "the call still returns a result");
assert(old.parent === null,
       "the layer was NOT parented the wrong way as a consolation");
assert(/setParentWithJump/.test(r.data.skipped) &&
       /keepPosition:false/.test(r.data.skipped),
       "it is skipped with the reason and the way out: " + r.data.skipped);
r = call("set_layer_parent", { layer: "Old", parent: "Null 1" });
assert(r.ok && old.parent === par,
       "the default path needs no setParentWithJump and works");

console.log("");
console.log("== batches, selection and refusals ==");
const a = place(addLayer("Multi A"), 500, 400);
const b = place(addLayer("Multi B"), 700, 100);
r = call("set_layer_parent", { layers: ["Multi A", "Multi B"],
                               parent: "Null 1" });
assert(r.ok && a.parent === par && b.parent === par, "both layers parented");
assert(/Multi A/.test(r.data.parented) && /Multi B/.test(r.data.parented),
       "both are named in the result");
assert(posOf(a)[0] === 200 && posOf(b)[0] === 400,
       "each was compensated by its own offset, not by a shared one");
r = call("set_layer_parent", { layers: ["Null 1", "Multi A"],
                               parent: "Null 1" });
assert(r.ok && /is the parent/.test(r.data.skipped),
       "a layer asked to parent to itself is skipped, not thrown: " +
       r.data.skipped);
const sel = place(addLayer("Selected"), 500, 400);
sel.selected = true;
r = call("set_layer_parent", { parent: "Null 1" });
assert(r.ok && sel.parent === par && /Selected/.test(r.data.parented),
       "with no layer argument the selection is used");
sel.selected = false;
r = call("set_layer_parent", { layer: "nope", parent: "Null 1" });
assert(!r.ok && /Kid/.test(r.error),
       "an unknown layer is refused with the real layer names listed");
r = call("set_layer_parent", { layer: "Kid", parent: "nope" });
assert(!r.ok && /Null 1/.test(r.error),
       "an unknown PARENT is refused the same grounded way");

console.log("");
console.log(process.exitCode ? "FAILURES"
  : "all set_layer_parent checks passed");
