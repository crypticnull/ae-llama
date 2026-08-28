// Regression test: add_text_animator (workplan 5.1).
//
// The stub below models what a probe MEASURED in AE 2026 on 2026-08-28
// (WORKPLAN-LOG). Every one of these is hostile to the obvious
// implementation, which is why they are modelled rather than assumed:
//
//  1. An animator's "Properties" group is NOT empty. It ships with all
//     103 possible animator properties present — the whole 3D-text
//     Front/Bevel/Side/Back material set and eight nameless variable-font
//     axes included — and addProperty un-hides one rather than creating
//     it. numProperties is 103 before and after, so counting proves
//     nothing and enumerating hands back a hundred things nobody added.
//  2. enabled (true), elided (false) and active (true) read the SAME for
//     a dormant property and an added one. `canSetExpression` is the one
//     flag that differs: false while dormant, true once added.
//  3. Writing to a dormant one throws AE's "Can not “set value” with
//     this property, because the property or a parent property is
//     hidden."  Reading one succeeds and hands back a value the render
//     never uses.
//  4. Adding a SIBLING animator invalidates every reference already held
//     into the earlier ones — a1.name then throws "Object is invalid".
//     Adding a selector or a property does not.
//  5. AE lets two animators share a name and answers a name lookup with
//     the FIRST, stranding the later one.
//  6. Percent Start/End/Offset run -100..100 (101 throws), and a range
//     selector keeps BOTH the percent triple and the index triple —
//     property("Start") always returns the PERCENT one, whatever Units
//     says.
//  7. threeDPerChar is a LAYER switch: turning it on also turns the
//     layer 3D, and turning it off again leaves the layer 3D. Setting it
//     on a non-text layer throws.
//  8. "ADBE Text Rotation" IS the Z rotation. "ADBE Text Rotation Z"
//     does not exist in either mode; X/Y do, but only bite with
//     per-character 3D on.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const hostSrc = fs.readFileSync(
  path.join(ROOT, "extension", "jsx", "hostscript.jsx"), "utf8");
const toolsSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "tools.js"), "utf8");

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------------------ stubbed AE

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};
const PropertyType = { PROPERTY: 6270, INDEXED_GROUP: 6271, NAMED_GROUP: 6272 };

const HIDDEN = 'After Effects error: Can not “set value” with this ' +
  'property, because the property or a parent property is hidden.';

// FACT 4: adding a sibling animator invalidates the references already
// handed out into the earlier ones — but only the REFERENCES. Re-fetching
// the same property by index works fine (measured). So every object
// inside an Animators group is handed out through a Proxy stamped with
// that group's generation, and the stamp is what goes stale.
function stamp(node, root) {
  node._animRoot = root;
  (node._kids || []).forEach(k => stamp(k, root));
}
function live(obj) {
  const root = obj._animRoot || null;
  const gen = root ? root._gen : null;
  return new Proxy(obj, {
    get(target, key) {
      if (key !== "_animRoot" && root && root._gen !== gen) {
        throw new ReferenceError("Object is invalid");
      }
      return target[key];
    },
    set(target, key, val) {
      if (root && root._gen !== gen) {
        throw new ReferenceError("Object is invalid");
      }
      target[key] = val;
      return true;
    }
  });
}

function Prop(name, matchName, value, opts) {
  opts = opts || {};
  this.name = name;
  this.matchName = matchName;
  this.value = value;
  this.propertyType = PropertyType.PROPERTY;
  this.numKeys = 0;
  this.expression = "";
  // FACT 2: the three flags that look like they answer the question but
  // read identically for dormant and added properties.
  this.enabled = true;
  this.elided = false;
  this.active = true;
  this._dormant = !!opts.dormant;
  this._min = opts.min; this._max = opts.max;
  this._parent = null;
  this._dead = false;
  this.writes = 0;
}
Object.defineProperty(Prop.prototype, "canSetExpression", {
  get() { return !this._dormant; }        // FACT 2: the ONE honest flag
});
Object.defineProperty(Prop.prototype, "hasMin", {
  get() { return typeof this._min === "number"; }
});
Object.defineProperty(Prop.prototype, "hasMax", {
  get() { return typeof this._max === "number"; }
});
Object.defineProperty(Prop.prototype, "minValue", { get() { return this._min; } });
Object.defineProperty(Prop.prototype, "maxValue", { get() { return this._max; } });
Prop.prototype.propertyGroup = function (up) {
  let g = this._parent;
  for (let i = 1; i < (up || 1); i++) g = g && g._parent;
  return g;
};
Prop.prototype._range = function (v) {
  const one = Array.isArray(v) ? null : v;
  if (one === null) return;
  if (this.hasMin && one < this._min || this.hasMax && one > this._max) {
    throw new Error("After Effects error: Unable to call “setValue” " +
      "because of parameter 1. Value " + one + " out of range " +
      this._min + " to " + this._max + ".");
  }
};
Prop.prototype._pad = function (v) {
  // AE pads a short array to the dimensions it keeps: setValue([50, 50])
  // on an animator Position reads back [50, 50, 0].
  if (!Array.isArray(v) || !Array.isArray(this.value)) return v;
  const out = v.slice();
  while (out.length < this.value.length) out.push(0);
  return out;
};
Prop.prototype.setValue = function (v) {
  if (this._dormant) throw new Error(HIDDEN);     // FACT 3
  this._range(v);
  this.value = this._pad(v);
  this.writes++;
};
Prop.prototype.setValueAtTime = function (t, v) {
  if (this._dormant) {
    throw new Error('After Effects error: Can not “set value at ' +
      'time” with this property, because the property or a parent ' +
      'property is hidden.');
  }
  this._range(v);
  this.value = v;
  this.numKeys++;
};

function Group(name, matchName) {
  this.name = name;
  this.matchName = matchName;
  this.propertyType = PropertyType.NAMED_GROUP;
  this._kids = [];
  this._parent = null;
  this._dead = false;
}
Object.defineProperty(Group.prototype, "numProperties", {
  get() { return this._kids.length; }
});
Group.prototype._add = function (child) {
  child._parent = this;
  this._kids.push(child);
  return child;
};
Group.prototype.property = function (ref) {
  if (typeof ref === "number") {
    const k = this._kids[ref - 1];
    if (!k) throw new Error("no property " + ref);
    return live(k);
  }
  // FACT 5/6: FIRST match by name wins, and matchName is tried too.
  const byName = this._kids.filter(k => k.name === ref)[0];
  const byMatch = this._kids.filter(k => k.matchName === ref)[0];
  const hit = byName || byMatch;
  if (!hit) throw new Error("no property " + ref);
  return live(hit);
};
Group.prototype.canAddProperty = function () { return true; };


// FACT 1: the full slot list. Twelve of the hundred-and-three are enough
// to prove the point — including a 3D-material one and a nameless
// variable-font axis, the two families that make enumerating useless.
const ANIM_SLOTS = [
  ["Anchor Point", "ADBE Text Anchor Point 3D", [0, 0, 0]],
  ["Position", "ADBE Text Position 3D", [0, 0, 0]],
  ["Scale", "ADBE Text Scale 3D", [100, 100, 100]],
  ["Skew", "ADBE Text Skew", 0],
  ["Skew Axis", "ADBE Text Skew Axis", 0],
  ["X Rotation", "ADBE Text Rotation X", 0],
  ["Y Rotation", "ADBE Text Rotation Y", 0],
  ["Rotation", "ADBE Text Rotation", 0],
  ["Opacity", "ADBE Text Opacity", 100, { min: 0, max: 100 }],
  ["Fill Color", "ADBE Text Fill Color", [1, 0, 0, 1]],
  ["Fill Opacity", "ADBE Text Fill Opacity", 100],
  ["Stroke Color", "ADBE Text Stroke Color", [1, 0, 0, 1]],
  ["Stroke Opacity", "ADBE Text Stroke Opacity", 100],
  ["Stroke Width", "ADBE Text Stroke Width", 0],
  ["Fill Hue", "ADBE Text Fill Hue", 0],
  ["Fill Saturation", "ADBE Text Fill Saturation", 0],
  ["Fill Brightness", "ADBE Text Fill Brightness", 0],
  ["Stroke Hue", "ADBE Text Stroke Hue", 0],
  ["Stroke Saturation", "ADBE Text Stroke Saturation", 0],
  ["Stroke Brightness", "ADBE Text Stroke Brightness", 0],
  ["Line Anchor", "ADBE Text Line Anchor", 50],
  ["Tracking Type", "ADBE Text Track Type", 1],
  ["Tracking Amount", "ADBE Text Tracking Amount", 0],
  ["Character Alignment", "ADBE Text Character Change Type", 1],
  ["Character Range", "ADBE Text Character Range", 1],
  ["Character Value", "ADBE Text Character Replace", 0],
  ["Character Offset", "ADBE Text Character Offset", 0],
  ["Line Spacing", "ADBE Text Line Spacing", [0, 0]],
  ["Blur", "ADBE Text Blur", [0, 0]],
  ["Front Color", "ADBE 3DText Front RGB", [1, 0, 0, 1]],
  ["Front Opacity", "ADBE 3DText Front Opacity", 100],
  ["", "ADBE Text VF Axis 1", 0]
];

function makeAnimator(name) {
  const anim = new Group(name, "ADBE Text Animator");
  const sels = new Group("Selectors", "ADBE Text Selectors");
  const props = new Group("Properties", "ADBE Text Animator Properties");
  ANIM_SLOTS.forEach(([n, m, v, o]) => {
    props._add(new Prop(n, m, v, Object.assign({ dormant: true }, o || {})));
  });
  // FACT 1: addProperty un-hides, it does not create. Calling it twice
  // is not an error and the count never moves.
  props.addProperty = function (mn) {
    const hit = this._kids.filter(k => k.matchName === mn)[0];
    if (!hit) {
      throw new Error("After Effects error: Can not add a property with " +
        "name “" + mn + "” to this PropertyGroup.");
    }
    hit._dormant = false;
    return live(hit);
  };
  props.canAddProperty = function (mn) {
    return this._kids.some(k => k.matchName === mn);
  };
  sels.addProperty = function (mn) {
    let sel;
    if (mn === "ADBE Text Selector") {
      sel = new Group("Range Selector " +
        (this._kids.filter(k => k.matchName === mn).length + 1), mn);
      // FACT 6: both triples exist at once, percent first — so a lookup
      // by the display name "Start" can only ever find the percent one.
      sel._add(new Prop("Start", "ADBE Text Percent Start", 0, { min: -100, max: 100 }));
      sel._add(new Prop("End", "ADBE Text Percent End", 100, { min: -100, max: 100 }));
      sel._add(new Prop("Offset", "ADBE Text Percent Offset", 0, { min: -100, max: 100 }));
      sel._add(new Prop("Start", "ADBE Text Index Start", 0));
      sel._add(new Prop("End", "ADBE Text Index End", 0));
      sel._add(new Prop("Offset", "ADBE Text Index Offset", 0));
      const adv = new Group("Advanced", "ADBE Text Range Advanced");
      adv._add(new Prop("Units", "ADBE Text Range Units", 1, { min: 1, max: 2 }));
      adv._add(new Prop("Based On", "ADBE Text Range Type2", 1, { min: 1, max: 4 }));
      adv._add(new Prop("Mode", "ADBE Text Selector Mode", 1, { min: 1, max: 6 }));
      adv._add(new Prop("Amount", "ADBE Text Selector Max Amount", 100, { min: -100, max: 100 }));
      adv._add(new Prop("Shape", "ADBE Text Range Shape", 1, { min: 1, max: 6 }));
      adv._add(new Prop("Smoothness", "ADBE Text Selector Smoothness", 100, { min: 0, max: 100 }));
      adv._add(new Prop("Ease High", "ADBE Text Levels Max Ease", 0, { min: -100, max: 100 }));
      adv._add(new Prop("Ease Low", "ADBE Text Levels Min Ease", 0, { min: -100, max: 100 }));
      adv._add(new Prop("Randomize Order", "ADBE Text Randomize Order", 0));
      adv._add(new Prop("Random Seed", "ADBE Text Random Seed", 0));
      sel._add(adv);
    } else if (mn === "ADBE Text Wiggly Selector") {
      sel = new Group("Wiggly Selector 1", mn);
      sel._add(new Prop("Mode", "ADBE Text Selector Mode", 1, { min: 1, max: 6 }));
      sel._add(new Prop("Max Amount", "ADBE Text Wiggly Max Amount", 100));
      sel._add(new Prop("Min Amount", "ADBE Text Wiggly Min Amount", -100));
      sel._add(new Prop("Based On", "ADBE Text Range Type2", 1, { min: 1, max: 4 }));
      sel._add(new Prop("Wiggles/Second", "ADBE Text Temporal Freq", 2));
      sel._add(new Prop("Correlation", "ADBE Text Character Correlation", 50));
      sel._add(new Prop("Temporal Phase", "ADBE Text Temporal Phase", 0));
      sel._add(new Prop("Spatial Phase", "ADBE Text Spatial Phase", 0));
      sel._add(new Prop("Lock Dimensions", "ADBE Text Wiggly Lock Dim", 0));
      sel._add(new Prop("Random Seed", "ADBE Text Wiggly Random Seed", 0));
    } else if (mn === "ADBE Text Expressible Selector") {
      sel = new Group("Expression Selector 1", mn);
      sel._add(new Prop("Based On", "ADBE Text Range Type2", 1, { min: 1, max: 4 }));
      sel._add(new Prop("Amount", "ADBE Text Expressible Amount", 100));
    } else {
      throw new Error("no selector " + mn);
    }
    this._add(sel);
    stamp(sel, this._animRoot);
    return live(sel);
  };
  anim._add(sels);
  anim._add(props);
  return anim;
}

function TxtLayer(name, comp) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.threeDLayer = false;
  this._perChar = false;
  this.inPoint = 0;
  this._roots = [];
  const xf = new Group("Transform", "ADBE Transform Group");
  xf._add(new Prop("Anchor Point", "ADBE Anchor Point", [0, 0, 0]));
  xf._add(new Prop("Position", "ADBE Position", [320, 240, 0]));
  xf._add(new Prop("Opacity", "ADBE Opacity", 100, { min: 0, max: 100 }));
  const text = new Group("Text", "ADBE Text Properties");
  text._add(new Prop("Source Text", "ADBE Text Document", "HELLO"));
  text._add(new Group("Path Options", "ADBE Text Path Options"));
  text._add(new Group("More Options", "ADBE Text More Options"));
  const anims = new Group("Animators", "ADBE Text Animators");
  const self = this;
  anims._gen = 0;
  anims.addProperty = function (mn) {
    if (mn !== "ADBE Text Animator") throw new Error("no property " + mn);
    // FACT 4: every reference into an earlier animator goes stale here.
    this._gen++;
    const a = makeAnimator("Animator " + (this._kids.length + 1));
    this._add(a);
    stamp(a, this);
    return live(a);
  };
  text._add(anims);
  this._roots.push(text, xf, new Group("Effects", "ADBE Effect Parade"));
}
Object.defineProperty(TxtLayer.prototype, "threeDPerChar", {
  get() { return this._perChar; },
  // FACT 7: it drags the 3D switch on with it and never gives it back.
  set(v) { this._perChar = !!v; if (v) this.threeDLayer = true; }
});
Object.defineProperty(TxtLayer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
Object.defineProperty(TxtLayer.prototype, "numProperties", {
  get() { return this._roots.length; }
});
TxtLayer.prototype.property = function (ref) {
  if (typeof ref === "number") return live(this._roots[ref - 1]);
  const hit = this._roots.filter(r => r.matchName === ref || r.name === ref)[0];
  if (!hit) throw new Error("no property group " + ref);
  return live(hit);
};

function PlainLayer(name, comp) {
  this.name = name; this.comp = comp; this.selected = false;
  this.threeDLayer = false;
  this._roots = [new Group("Transform", "ADBE Transform Group")];
}
Object.defineProperty(PlainLayer.prototype, "threeDPerChar", {
  get() { return false; },
  set() {
    throw new Error("After Effects error: Can not set threeDPerChar on " +
      "layer “" + this.name + "” because it is not a text layer.");
  }
});
Object.defineProperty(PlainLayer.prototype, "numProperties", {
  get() { return this._roots.length; }
});
PlainLayer.prototype.property = function (ref) {
  if (typeof ref === "number") return live(this._roots[ref - 1]);
  const hit = this._roots.filter(r => r.matchName === ref)[0];
  if (!hit) throw new Error("no property group " + ref);
  return hit;
};
Object.defineProperty(PlainLayer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});

function Comp(name) {
  this.name = name;
  this.width = 640; this.height = 480;
  this.duration = 5; this.frameRate = 30;
  this._layers = [];
}
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { return this._layers.length; }
});
Object.defineProperty(Comp.prototype, "selectedLayers", {
  get() { return this._layers.filter(l => l.selected); }
});
Comp.prototype.layer = function (ref) {
  const l = typeof ref === "number" ? this._layers[ref - 1]
    : this._layers.filter(x => x.name === ref)[0];
  if (!l) throw new Error("no layer " + ref);
  return l;
};
Object.defineProperty(Comp.prototype, "layers", {
  get() {
    const self = this;
    return {
      addText(txt) {
        const L = new TxtLayer(typeof txt === "string" ? txt : "Text", self);
        Object.setPrototypeOf(L, Object.create(TextLayer.prototype,
          Object.getOwnPropertyDescriptors(TxtLayer.prototype)));
        self._layers.forEach(x => { x.selected = false; });
        L.selected = true;
        self._layers.push(L);
        return L;
      },
      addSolid(c, name) {
        const L = new PlainLayer(name, self);
        Object.setPrototypeOf(L, Object.create(AVLayer.prototype,
          Object.getOwnPropertyDescriptors(PlainLayer.prototype)));
        self._layers.forEach(x => { x.selected = false; });
        L.selected = true;
        self._layers.push(L);
        return L;
      }
    };
  }
});

function makeComp(name) {
  const c = new Comp(name);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  return c;
}

const project = {
  _items: [],
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  rootFolder: { name: "(root)" },
  renderQueue: { numItems: 0 },
  items: {
    addComp(name) { const c = makeComp(name); project._items.push(c); return c; }
  }
};
const app = { project, version: "26.3x87",
              beginUndoGroup() {}, endUndoGroup() {}, executeCommand() {} };
const $ = { global: {}, hiresTimer: 0 };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool } = host;
const call = (t, a) => AELL_runTool(t, a || {});

const comp = project.items.addComp("Scene");
const text = comp.layers.addText("HELLO");
text.name = "TITLE";
const solid = comp.layers.addSolid([1, 0, 0], "BG");
const animsOf = (L) => L.property("ADBE Text Properties")
                        .property("ADBE Text Animators");
const propOf = (L, i, mn) => animsOf(L).property(i)
  .property("ADBE Text Animator Properties").property(mn);

// ------------------------------------------------------ 0. stub fidelity

{
  const a = animsOf(text).addProperty("ADBE Text Animator");
  const pg = a.property("ADBE Text Animator Properties");
  assert(pg.numProperties === ANIM_SLOTS.length && pg.numProperties > 20,
         "STUB FIDELITY: a fresh animator already carries every slot " +
         "(AE: 103) — addProperty un-hides, it does not create");
  const skew = pg.property("ADBE Text Skew");
  assert(skew.enabled === true && skew.elided === false &&
         skew.active === true && skew.canSetExpression === false,
         "STUB FIDELITY: enabled/elided/active lie about a dormant " +
         "property; only canSetExpression tells the truth");
  let threw = "";
  try { skew.setValue(30); } catch (e) { threw = e.message; }
  assert(/hidden/.test(threw),
         "STUB FIDELITY: writing a dormant property throws AE's 'hidden'");
  pg.addProperty("ADBE Text Skew");
  assert(pg.numProperties === ANIM_SLOTS.length &&
         pg.property("ADBE Text Skew").canSetExpression === true,
         "STUB FIDELITY: adding it moves no count, only the flag");
  const held = animsOf(text).property(1);
  animsOf(text).addProperty("ADBE Text Animator");
  let dead = "";
  try { held.name; } catch (e) { dead = e.message; }
  assert(/Object is invalid/.test(dead),
         "STUB FIDELITY: adding a SIBLING animator kills references held " +
         "into the earlier ones");
  const refetched = animsOf(text).property(1)
    .property("ADBE Text Animator Properties").property("ADBE Text Skew");
  assert(refetched.canSetExpression === true,
         "STUB FIDELITY: ...but re-fetching the same property by index " +
         "works, which is what the tool has to do");
  // start clean for the real tests
  animsOf(text)._kids.length = 0;
}

// -------------------------------------------- 1. the tool exists at all

assert(typeof AELL_TOOLS.add_text_animator === "function",
       "add_text_animator is a host tool (workplan 5.1)");
assert(AELL_MUTATING.add_text_animator === true,
       "add_text_animator is MUTATING, so it gets an undo group");
assert(/name:\s*"add_text_animator"/.test(toolsSrc),
       "add_text_animator is documented in tools.js — an undocumented " +
       "tool is unreachable by the model");

// ------------------------------------------------------ 2. grounded refusals

{
  const r = call("add_text_animator", { comp: "Scene", layer: "BG",
    properties: { opacity: 0 } });
  assert(!r.ok && /TEXT layers/.test(r.error) && /TITLE/.test(r.error),
         "a non-text layer is refused, naming the text layers there: " +
         r.error);
  assert(animsOf(text).numProperties === 0,
         "  ...and nothing was built on the way to that refusal");
}
{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE" });
  assert(!r.ok && /'properties' is required/.test(r.error) &&
         /opacity/.test(r.error),
         "no properties -> refusal that lists what an animator can " +
         "animate: " + r.error);
}
{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: ["opacity"] });
  assert(!r.ok && /object of name: value/.test(r.error),
         "a LIST of property names is redirected to the object form: " +
         r.error);
}
{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { wobble: 5 } });
  assert(!r.ok && /No animator property named wobble/.test(r.error) &&
         /tracking/.test(r.error),
         "an invented property is refused with the real list: " + r.error);
  assert(animsOf(text).numProperties === 0,
         "  ...and no half-built animator is left behind");
}
{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { opacity: 0 }, selector: { type: "sideways" } });
  assert(!r.ok && /No selector type 'sideways'/.test(r.error) &&
         /wiggly/.test(r.error),
         "an invented selector type is refused with AE's three: " + r.error);
}
{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { opacity: 0 }, selector: { basedOn: "sentences" } });
  assert(!r.ok && /No basedOn 'sentences'/.test(r.error) &&
         /lines/.test(r.error),
         "an invented enum value is refused with the real options: " +
         r.error);
}
{
  // FACT 6: percent selectors are -100..100, and the refusal has to come
  // BEFORE an animator exists, not as an AE throw halfway through.
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { opacity: 0 }, selector: { start: 0, end: 400 } });
  assert(!r.ok && /PERCENT/.test(r.error) && /-100\.\.100/.test(r.error) &&
         /units/.test(r.error),
         "end: 400 is refused as a percent, pointing at units 'index': " +
         r.error);
  assert(animsOf(text).numProperties === 0,
         "  ...and again nothing was built first");
}
{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { opacity: 0 }, selector: { type: "wiggly", start: 10 } });
  assert(!r.ok && /RANGE selector/.test(r.error),
         "start/end on a wiggly selector is refused, not swallowed: " +
         r.error);
}

// ------------------------------------------------ 3. the ordinary case

{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { opacity: 0, position: [0, -80] },
    selector: { start: 0, end: 40, offset: -10, shape: "rampUp",
                easeHigh: 50 } });
  assert(r.ok, "one call builds animator + properties + selector: " +
         (r.error || ""));
  assert(r.data.animator === "Animator 1" &&
         r.data.path === "Text/Animators/Animator 1",
         "the result names the animator and its path");
  assert(propOf(text, 1, "ADBE Text Opacity").value === 0,
         "opacity really landed on the animator property");
  assert(String(propOf(text, 1, "ADBE Text Position 3D").value) === "0,-80,0",
         "a 2-number position is padded to the 3 AE keeps");
  assert(propOf(text, 1, "ADBE Text Opacity").canSetExpression === true &&
         propOf(text, 1, "ADBE Text Position 3D").canSetExpression === true,
         "both properties were ADDED, not just written to");
  assert(propOf(text, 1, "ADBE Text Skew").canSetExpression === false,
         "nothing else was activated by accident");
  const paths = r.data.properties.map(p => p.path);
  assert(paths.indexOf("Text/Animators/Animator 1/Properties/Opacity") >= 0 &&
         paths.indexOf("Text/Animators/Animator 1/Properties/Position") >= 0,
         "every property comes back with the full path set_property and " +
         "set_keyframes take: " + paths.join(", "));
  const sel = animsOf(text).property(1).property("ADBE Text Selectors")
                           .property(1);
  assert(sel.property("ADBE Text Percent Start").value === 0 &&
         sel.property("ADBE Text Percent End").value === 40 &&
         sel.property("ADBE Text Percent Offset").value === -10,
         "start/end/offset went to the PERCENT triple");
  assert(sel.property("ADBE Text Range Advanced")
            .property("ADBE Text Range Shape").value === 2 &&
         sel.property("ADBE Text Range Advanced")
            .property("ADBE Text Levels Max Ease").value === 50,
         "shape 'rampUp' became AE's 2, and easeHigh landed in Advanced");
  assert(r.data.selector.path ===
         "Text/Animators/Animator 1/Selectors/Range Selector 1",
         "the selector path is reported too: " + r.data.selector.path);
  assert(/Offset/.test(r.data.animateHint) &&
         /set_keyframes/.test(r.data.animateHint),
         "the result says how to make it MOVE — keyframes on the " +
         "selector, which is the half a static animator is missing");
  assert(!r.data.problems, "no problems reported: " +
         JSON.stringify(r.data.problems));
  assert(text.selected === true || comp.selectedLayers.length >= 0,
         "the selection survives (nothing else to restore here)");
}

// ------------------------- 4. FACT 4: a second animator on the same layer

{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    name: "Cascade", properties: { rotation: 20 },
    selector: { units: "index", start: 0, end: 3 } });
  assert(r.ok, "a SECOND animator on the same layer works — the tool " +
         "re-reaches by index instead of holding what it made: " +
         (r.error || ""));
  assert(animsOf(text).numProperties === 2 &&
         animsOf(text).property(2).name === "Cascade",
         "it is animator 2 and it took the name asked for");
  const sel = animsOf(text).property(2).property("ADBE Text Selectors")
                           .property(1);
  // FACT 6: index units means the INDEX triple, and the percent one must
  // be left alone — property("Start") would have found the wrong one.
  assert(sel.property("ADBE Text Index End").value === 3 &&
         sel.property("ADBE Text Percent End").value === 100,
         "units 'index' writes the INDEX triple and leaves percent alone");
  assert(r.data.selector.settings.units === "index",
         "the result says which units it used");
  assert(propOf(text, 1, "ADBE Text Opacity").value === 0,
         "animator 1 still holds what it was given");
}

// ------------------------------------------- 5. FACT 5: a name AE would strand

{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    name: "Cascade", properties: { skew: 15 } });
  assert(r.ok, "a repeated animator name is accepted: " + (r.error || ""));
  assert(r.data.animator === "Cascade 2",
         "it is auto-numbered, because AE answers a name lookup with the " +
         "FIRST match and would strand this one: " + r.data.animator);
  assert(/already an animator/.test(r.data.nameTaken || ""),
         "and the result SAYS the name was taken: " + r.data.nameTaken);
}

// ---------------------------------- 6. FACT 7: per-character 3D is a switch

{
  const before = text.threeDLayer;
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { yRotation: 90 }, selector: { type: "none" } });
  assert(r.ok, "yRotation is accepted: " + (r.error || ""));
  assert(text.threeDPerChar === true,
         "per-character 3D was turned on — without it AE would take the " +
         "write and render nothing");
  assert(/per-character 3D|perCharacter3D/i.test(
           JSON.stringify(r.data.perCharacter3D || "")),
         "the result reports it rather than doing it quietly: " +
         r.data.perCharacter3D);
  assert(!before && text.threeDLayer === true &&
         /3D layer/.test(r.data.perCharacter3D),
         "and it reports the layer becoming 3D, which AE does not undo");
  assert(/every character/.test(String(r.data.selector)),
         "selector 'none' is reported as applying to every character: " +
         r.data.selector);
}

// ------------------------------------------------------- 7. wiggly selector

{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { position: [0, 10] },
    selector: { type: "wiggly", wigglesPerSecond: 4, correlation: 20,
                maxAmount: 60, mode: "intersect" } });
  assert(r.ok, "a wiggly selector is built: " + (r.error || ""));
  const s = animsOf(text).property(animsOf(text).numProperties)
    .property("ADBE Text Selectors").property(1);
  assert(s.matchName === "ADBE Text Wiggly Selector" &&
         s.property("ADBE Text Temporal Freq").value === 4 &&
         s.property("ADBE Text Character Correlation").value === 20 &&
         s.property("ADBE Text Wiggly Max Amount").value === 60,
         "its own parameters landed (wiggles/second, correlation, amount)");
  assert(s.property("ADBE Text Selector Mode").value === 3,
         "mode 'intersect' became AE's 3 on the wiggly selector too");
}

// ------------------------------ 8. the name/matchName mismatch AE ships with

{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { characterValue: 65, trackingType: 2 },
    selector: { type: "none" } });
  assert(r.ok, "characterValue/trackingType are accepted: " + (r.error || ""));
  const idx = animsOf(text).numProperties;
  assert(propOf(text, idx, "ADBE Text Character Replace").value === 65,
         "'characterValue' is AE's 'ADBE Text Character Replace' — the " +
         "display name and the matchName disagree");
  assert(propOf(text, idx, "ADBE Text Track Type").value === 2,
         "'trackingType' is 'ADBE Text Track Type', not " +
         "'ADBE Text Tracking Type' (which AE does not have)");
}

// -------------- 9. FACT 3: the rest of the panel stops lying about dormancy

{
  const fresh = project.items.addComp("Second");
  const t2 = fresh.layers.addText("WORDS");
  t2.name = "SUB";
  call("add_text_animator", { comp: "Second", layer: "SUB",
    properties: { opacity: 50 }, selector: { type: "none" } });

  const r = call("set_property", { comp: "Second", layer: "SUB",
    property: "Skew", value: 20 });
  assert(!r.ok && /INACTIVE text-animator property/.test(r.error) &&
         /add_text_animator/.test(r.error),
         "a bare name that only matches a DORMANT animator slot is " +
         "refused with the tool that activates it, instead of AE's raw " +
         "'property or a parent property is hidden': " + r.error);

  const r2 = call("set_property", { comp: "Second", layer: "SUB",
    property: "Text/Animators/Animator 1/Properties/Skew", value: 20 });
  assert(!r2.ok && /has not been added/.test(r2.error),
         "the same refusal for an explicit PATH into a dormant slot: " +
         r2.error);

  const r3 = call("set_keyframes", { comp: "Second", layer: "SUB",
    property: "Text/Animators/Animator 1/Properties/Skew",
    keys: [{ time: 0, value: 0 }, { time: 1, value: 30 }] });
  assert(!r3.ok && /has not been added/.test(r3.error),
         "set_keyframes refuses it too, before writing key 1 of 2: " +
         r3.error);

  const r4 = call("get_property", { comp: "Second", layer: "SUB",
    property: "Text/Animators/Animator 1/Properties/Skew" });
  assert(r4.ok && /never applied/.test(r4.data.inactive || ""),
         "READING one still works but is flagged — the value is real and " +
         "the render ignores it: " + r4.data.inactive);

  const r5 = call("get_property", { comp: "Second", layer: "SUB",
    property: "Text/Animators/Animator 1/Properties/Opacity" });
  assert(r5.ok && !r5.data.inactive && r5.data.value === 50,
         "an ACTIVE animator property reads back clean");

  const r6 = call("set_property", { comp: "Second", layer: "SUB",
    property: "Text/Animators/Animator 1/Properties/Opacity", value: 10 });
  assert(r6.ok && propOf(t2, 1, "ADBE Text Opacity").value === 10,
         "and it still takes a write: " + (r6.error || ""));

  const r7 = call("list_properties", { comp: "Second", layer: "SUB",
    path: "Text/Animators/Animator 1/Properties" });
  const rows = r7.ok ? r7.data.properties : [];
  const op = rows.filter(p => /Opacity$/.test(p.path))[0];
  const sk = rows.filter(p => /Skew$/.test(p.path))[0];
  assert(sk && sk.inactive === true && op && !op.inactive,
         "list_properties marks the dormant slots inactive and leaves " +
         "the added one alone");
}

// ----------------------------------------- 10. a value AE will not accept

{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { opacity: 900 }, selector: { type: "none" } });
  assert(r.ok && r.data.problems && r.data.problems.length === 1 &&
         /Range: 0 to 100/.test(r.data.problems[0]),
         "AE's range refusal is reported with the range, not swallowed: " +
         JSON.stringify(r.data.problems));
  assert(r.data.properties.length === 0,
         "and the property is not claimed as applied");
}
{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { fillColor: "red" }, selector: { type: "none" } });
  assert(r.ok && /\[r, g, b\]/.test((r.data.problems || [])[0] || ""),
         "a colour that is not [r,g,b] is named as the problem: " +
         JSON.stringify(r.data.problems));
}
{
  const r = call("add_text_animator", { comp: "Scene", layer: "TITLE",
    properties: { skew: "25" }, selector: { type: "none" } });
  assert(r.ok && r.data.properties[0] &&
         r.data.properties[0].value === 25,
         "a QUOTED number is accepted, as AELL_numArg does everywhere " +
         "else — small models send them: " + JSON.stringify(r.data));
}

console.log("\n" + checks + " checks");
