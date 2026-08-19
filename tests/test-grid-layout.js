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
  this.index = ++LAYER_SEQ;      // reassigned by comp
  this._transform = {
    "ADBE Position": new Prop(pos || [0, 0]),
    "ADBE Scale": new Prop([100, 100]),
    "ADBE Rotate Z": new Prop(0),
    "ADBE Opacity": new Prop(100),
    "ADBE Anchor Point": new Prop([0, 0])
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
       ctrl._effects.property("Grid Y Spacing"), "both spacing sliders exist");
assert(ctrl._effects.property("Grid X Spacing")._params[0].value ===
       Math.round(1920 / 4), "default X spacing = width/(cols+1)");

// 2. expressions: centered offsets, correct slider refs, bystander untouched
const e1 = tiles[0]._transform["ADBE Position"].expression;
assert(/\(-1\) \* sx/.test(e1) && /\(-0\.5\) \* sy/.test(e1),
       "tile 1 gets centered offsets (-1, -0.5)");
const e4 = tiles[3]._transform["ADBE Position"].expression;
assert(/\(-1\) \* sx/.test(e4) && /\(0\.5\) \* sy/.test(e4),
       "tile 4 wraps to row 2 col 0 (-1, 0.5)");
const e5 = tiles[4]._transform["ADBE Position"].expression;
assert(/\(0\) \* sx/.test(e5) && /\(0\.5\) \* sy/.test(e5),
       "tile 5 sits at row 2 col 1 (0, 0.5)");
assert(/effect\("Grid X Spacing"\)\(1\)/.test(e1) &&
       /thisComp\.layer\("GRID CTRL"\)/.test(e1),
       "expression references the null's sliders");
// The JS expression engine returns Property objects from these lookups;
// without .value, o[0]/sx come back undefined and AE disables the rig.
assert(/transform\.position\.value/.test(e1) &&
       /effect\("Grid X Spacing"\)\(1\)\.value/.test(e1) &&
       /effect\("Grid Y Spacing"\)\(1\)\.value/.test(e1),
       "stored references resolve with .value (JS-engine safe)");
assert(bystander._transform["ADBE Position"].expression === "",
       "unselected layer untouched");

// 3. idempotent re-run: same rig reused, no duplicate sliders
tiles.forEach(t => { t.selected = true; });
ctrl.selected = true;   // user sloppily selects the ctrl too
const r2 = call("grid_layout", {});
assert(r2.ok && r2.data.control === "GRID CTRL", "re-run reuses the rig");
assert(ctrl._effects.numProperties === 2, "no duplicate sliders after re-run");
assert(!r2.data.placed.some(p => p.layer === "GRID CTRL"),
       "control null never grids itself");

// 4. explicit columns + explicit layers
const r3 = call("grid_layout", { layers: ["Tile 1", "Tile 2", "Tile 3"],
                                 columns: 3, controlLayer: "ROW CTRL" });
assert(r3.ok && r3.data.rows === 1 && r3.data.columns === 3,
       "explicit columns=3 with 3 layers -> single row");
assert(comp._layers.some(l => l.name === "ROW CTRL"),
       "custom-named control null created");

// 5. 3D position keeps z
const l3d = new Layer("Cube", comp, [10, 20, 30]);
comp._layers.push(l3d);
comp._reindex();
const r4 = call("grid_layout", { layers: ["Tile 1", "Cube"], columns: 2 });
assert(r4.ok, "3D layer grid succeeds");
assert(/value\[2\]/.test(l3d._transform["ADBE Position"].expression),
       "3D layer expression preserves z via value[2]");

// 6. selection empty -> clear error
comp._layers.forEach(l => { l.selected = false; });
const r5 = call("grid_layout", {});
assert(!r5.ok && /No layers selected/.test(r5.error),
       "empty selection returns actionable error");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
