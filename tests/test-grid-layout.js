// Regression test: grid_layout against a stubbed AE object model.
// Covers: selection-driven layout, centered offsets, slider rig creation,
// idempotent re-run (same null/sliders reused), explicit columns, 3D z
// preservation, and control-null exclusion from its own grid.
"use strict";
const fs = require("fs");

// ---------------------------------------------------------------- AE stubs

function Prop(value) {
  this._value = value;
  this.expression = "";
  this.expressionError = "";
  this.canSetExpression = true;
}
Object.defineProperty(Prop.prototype, "value", {
  get() { return this._value; }
});
Prop.prototype.setValue = function (v) { this._value = v; };

function Effect(matchName) {
  this.matchName = matchName;
  this.name = matchName;
  this._params = [new Prop(0)];
}
Effect.prototype.property = function (ref) {
  if (typeof ref === "number") return this._params[ref - 1];
  return null;
};

function EffectParade() { this._fx = []; }
EffectParade.prototype.addProperty = function (matchName) {
  const fx = new Effect(matchName);
  this._fx.push(fx);
  return fx;
};
EffectParade.prototype.property = function (name) {
  return this._fx.find(f => f.name === name) || null;
};
Object.defineProperty(EffectParade.prototype, "numProperties", {
  get() { return this._fx.length; }
});

let LAYER_SEQ = 0;
function Layer(name, comp, pos) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.threeDLayer = false;      // the real 3D switch
  this.index = ++LAYER_SEQ;      // reassigned by comp
  // FAITHFUL TO REAL AE: the scripting API pads a 2D layer's Position to
  // THREE components ([x, y, 0]) — value.length is NOT a 3D test. This
  // padding is exactly what broke every grid rig in the field.
  const p = pos || [0, 0];
  this._transform = {
    "ADBE Position": new Prop(p.length > 2 ? p : [p[0], p[1], 0]),
    "ADBE Scale": new Prop([100, 100, 100]),
    "ADBE Rotate Z": new Prop(0),
    "ADBE Opacity": new Prop(100),
    "ADBE Anchor Point": new Prop([0, 0, 0])
  };
  this._effects = new EffectParade();
}
Layer.prototype.property = function (name) {
  if (name === "ADBE Transform Group") {
    const t = this._transform;
    return { property(n) { return t[n]; } };
  }
  if (name === "ADBE Effect Parade") return this._effects;
  return null;
};

function Comp(name, w, h) {
  this.name = name;
  this.width = w;
  this.height = h;
  this.duration = 10;
  this.time = 0;
  this._layers = [];
  const self = this;
  this.layers = {
    addNull() {
      const l = new Layer("Null " + (self._layers.length + 1), self,
                          [w / 2, h / 2]);
      l.nullLayer = true;   // AE marks nulls; the all-layers fallback skips them
      // Real AE selects the new layer and deselects everything else.
      self._layers.forEach(x => { x.selected = false; });
      l.selected = true;
      self._layers.unshift(l);
      self._reindex();
      return l;
    }
  };
}
Comp.prototype._reindex = function () {
  this._layers.forEach((l, i) => { l.index = i + 1; });
};
Comp.prototype.layer = function (ref) {
  if (typeof ref === "number") {
    const l = this._layers[ref - 1];
    if (!l) throw new Error("no layer " + ref);
    return l;
  }
  const l = this._layers.find(x => x.name === ref);
  if (!l) throw new Error("no layer " + ref);
  return l;
};
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { return this._layers.length; }
});
Object.defineProperty(Comp.prototype, "selectedLayers", {
  get() { return this._layers.filter(l => l.selected); }
});

// classes referenced by the hostscript at parse/dispatch time
function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};

const comp = new Comp("Grid Comp", 1920, 1080);
const project = {
  rootFolder: { name: "(root)" },
  numItems: 0,
  item() { return null; },
  items: {},
  activeItem: comp
};
// grid_layout resolves the active comp via AELL_resolveComp(undefined),
// which requires activeItem instanceof CompItem — patch the check by
// making our comp an instance.
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));

const app = { project, beginUndoGroup() {}, endUndoGroup() {} };
const $ = { global: {} };

// five tiles + one unselected bystander
const tiles = [];
for (let i = 1; i <= 5; i++) {
  const l = new Layer("Tile " + i, comp, [100 * i, 100]);
  l.selected = true;
  comp._layers.push(l);
  tiles.push(l);
}
const bystander = new Layer("Background", comp, [960, 540]);
comp._layers.push(bystander);
comp._reindex();

eval(fs.readFileSync(require("path").join(
  __dirname, "..", "extension", "jsx", "hostscript.jsx"), "utf8"));

function call(tool, args) {
  return JSON.parse($.global.AELL_call(tool, JSON.stringify(args)));
}
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// 1. selection-driven grid
const r = call("grid_layout", {});
assert(r.ok, "grid_layout on selection succeeds: " + (r.error || ""));
assert(r.data.columns === 3 && r.data.rows === 2,
       "5 layers -> 3x2 grid (got " + r.data.columns + "x" + r.data.rows + ")");
assert(r.data.control === "GRID CTRL", "control null created");

const ctrl = comp.layer("GRID CTRL");
assert(ctrl._effects.property("Grid X Spacing") &&
       ctrl._effects.property("Grid Y Spacing") &&
       ctrl._effects.property("Grid Columns"),
       "spacing + columns sliders exist");
assert(ctrl._effects.property("Grid X Spacing")._params[0].value ===
       Math.round(1920 / 4), "default X spacing = width/(cols+1)");
assert(ctrl._effects.property("Grid Columns")._params[0].value === 3,
       "columns slider initialized to the layout's column count");

// 2. expressions: per-layer order baked in, columns driven by the slider,
// bystander untouched
const e1 = tiles[0]._transform["ADBE Position"].expression;
assert(/var col = 0 % cols/.test(e1) && /Math\.floor\(0 \/ cols\)/.test(e1),
       "tile 1 bakes order index 0");
const e4 = tiles[3]._transform["ADBE Position"].expression;
assert(/var col = 3 % cols/.test(e4),
       "tile 4 bakes order index 3");
const e5 = tiles[4]._transform["ADBE Position"].expression;
assert(/var col = 4 % cols/.test(e5),
       "tile 5 bakes order index 4");
assert(/Math\.ceil\(5 \/ cols\)/.test(e1) && /Math\.min\(5,/.test(e1),
       "total layer count (5) baked for row math and the columns clamp");
assert(/effect\("Grid X Spacing"\)\(1\)/.test(e1) &&
       /effect\("Grid Y Spacing"\)\(1\)/.test(e1) &&
       /effect\("Grid Columns"\)\(1\)/.test(e1) &&
       /thisComp\.layer\("GRID CTRL"\)/.test(e1),
       "expression references all three sliders on the null");
// Vars may hold plain numbers only; every layer/effect lookup must stay
// inline-chained (pickwhip-classic) and never use .value.
assert(e1.indexOf(".value") === -1 &&
       /transform\.position\[0\]/.test(e1) &&
       /transform\.position\[1\]/.test(e1) &&
       !/var \w+ = thisComp/.test(e1),
       "lookups inline-chained; vars carry numbers only");
assert(bystander._transform["ADBE Position"].expression === "",
       "unselected layer untouched");

// 3. idempotent re-run: same rig reused, no duplicate sliders
tiles.forEach(t => { t.selected = true; });
ctrl.selected = true;   // user sloppily selects the ctrl too
const r2 = call("grid_layout", {});
assert(r2.ok && r2.data.control === "GRID CTRL", "re-run reuses the rig");
assert(ctrl._effects.numProperties === 3, "no duplicate sliders after re-run");
const r2b = call("grid_layout", { columns: 5 });
assert(r2b.ok &&
       ctrl._effects.property("Grid Columns")._params[0].value === 5,
       "explicit columns on re-run updates the Columns slider");
assert(!r2.data.placed.some(p => p.layer === "GRID CTRL"),
       "control null never grids itself");

// 4. explicit columns + explicit layers
const r3 = call("grid_layout", { layers: ["Tile 1", "Tile 2", "Tile 3"],
                                 columns: 3, controlLayer: "ROW CTRL" });
assert(r3.ok && r3.data.rows === 1 && r3.data.columns === 3,
       "explicit columns=3 with 3 layers -> single row");
assert(comp._layers.some(l => l.name === "ROW CTRL"),
       "custom-named control null created");

// 5. 2D layers must NEVER get value[2] (their expression value is 2D even
// though scripting reports [x, y, 0]); real 3D layers keep z.
assert(!/value\[2\]/.test(e1),
       "2D layer expression has no value[2] despite the padded API value");
const l3d = new Layer("Cube", comp, [10, 20, 30]);
l3d.threeDLayer = true;
comp._layers.push(l3d);
comp._reindex();
const r4 = call("grid_layout", { layers: ["Tile 1", "Cube"], columns: 2 });
assert(r4.ok, "3D layer grid succeeds");
assert(/value\[2\]/.test(l3d._transform["ADBE Position"].expression),
       "3D layer expression preserves z via value[2]");
assert(!/value\[2\]/.test(tiles[0]._transform["ADBE Position"].expression),
       "2D layer in the same grid still gets no value[2]");

// 6. selection empty -> "all layers" fallback grids every content layer
// (nulls like the two control layers are excluded automatically)
comp._layers.forEach(l => { l.selected = false; });
const r5 = call("grid_layout", {});
assert(r5.ok, "empty selection grids all content layers: " +
       (r5.error || ""));
assert(!r5.data.placed.some(p => /CTRL/.test(p.layer)),
       "control nulls excluded from the all-layers grid");
assert(r5.data.placed.length === 7,
       "all 7 content layers gridded (5 tiles + Background + Cube), got " +
       r5.data.placed.length);

// 7. creating layers must not destroy the user's selection
tiles.forEach(t => { t.selected = true; });
const r6 = call("add_null", { name: "SEL TEST" });
assert(r6.ok, "add_null succeeds");
assert(comp.selectedLayers.length === 5 &&
       comp.selectedLayers.every(l => /^Tile /.test(l.name)),
       "selection preserved across add_null (got " +
       comp.selectedLayers.map(l => l.name).join(", ") + ")");
assert(!comp.layer("SEL TEST").selected, "the new null is not selected");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
