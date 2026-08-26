// Regression test: add_light.
//
// Lights were the last uncovered thing in workplan item 2 — there was no
// add_light tool at all, so nothing about them could be exercised. The
// stub below models what was MEASURED in AE 2026 (probe, WORKPLAN-LOG
// 2026-08-26), and the measurements are hostile to the obvious
// implementation:
//
//  1. `canSetValue` is FALSE on every Light Options property and every
//     light transform property, INCLUDING the ones that write fine, and
//     `elided` is false everywhere too. A tool that gated on either
//     would refuse EVERY light option. The stub reproduces that: it
//     reports canSetValue false while still accepting legal writes.
//  2. The Light Options group carries all 14 properties on every type —
//     it never shrinks — so enumerating it proves nothing. The stub
//     hands out all 14 whatever the type is.
//  3. Hiddenness is per-TYPE and only discoverable by attempting the
//     write. Measured matrix (accepted / throws):
//       intensity, color       — all five types
//       coneAngle, coneFeather — spot only
//       falloff, radius, falloffDistance,
//       castsShadows, shadowDarkness  — parallel, spot, point
//       shadowDiffusion        — spot, point
//       Background Visible/Opacity/Blur — no type (environment-only UI)
//       Position               — parallel, spot, point
//       Point of Interest      — parallel, spot
//       ambient + environment accept NO transform property at all
//  4. Falloff GATES its own two: Radius exists only while Falloff is
//     smooth(2) or inverseSquareClamped(3), Falloff Distance only while
//     it is smooth(2). So Falloff must be written FIRST.
//  5. AE 2026 has FIVE light types — LightType.ENVIRONMENT (4416) is not
//     in the four that training knows about.
//  6. NO_AUTO_ORIENT hides the Point of Interest on a light exactly as
//     it does on a camera, so it must be set before the POI write.
//  7. addLight(name, center) puts `center` into the POINT OF INTEREST,
//     not Position. A fresh 800x600 light read back POI [400,300,0] and
//     Position [0,0,-555.556] — AEs own default, nowhere near the centre
//     it was handed. The first stub here assumed center became Position;
//     real AE said otherwise, so it is modelled the measured way.
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

const LightType = { PARALLEL: 4412, SPOT: 4413, POINT: 4414,
                    AMBIENT: 4415, ENVIRONMENT: 4416 };
const AutoOrientType = { ALONG_PATH: 4213, CAMERA_OR_POINT_OF_INTEREST: 4214,
                         CHARACTERS_TOWARD_CAMERA: 4215, NO_AUTO_ORIENT: 4212 };
const KIND_OF = { 4412: "parallel", 4413: "spot", 4414: "point",
                  4415: "ambient", 4416: "environment" };

// FACT 3, the measured matrix. "" = no type accepts it.
const OPT_ON = {
  "ADBE Light Env Atom":         "",
  "ADBE Light Backgd Visible":   "",
  "ADBE Light Backgd Opacity":   "",
  "ADBE Light Backgd Blur":      "",
  "ADBE Light Intensity":        "parallel spot point ambient environment",
  "ADBE Light Color":            "parallel spot point ambient environment",
  "ADBE Light Cone Angle":       "spot",
  "ADBE Light Cone Feather 2":   "spot",
  "ADBE Light Falloff Type":     "parallel spot point",
  "ADBE Light Falloff Start":    "parallel spot point",
  "ADBE Light Falloff Distance": "parallel spot point",
  "ADBE Casts Shadows":          "parallel spot point",
  "ADBE Light Shadow Darkness":  "parallel spot point",
  "ADBE Light Shadow Diffusion": "spot point"
};
const XFORM_ON = {
  "ADBE Position":     "parallel spot point",
  "ADBE Anchor Point": "parallel spot"
};
const OPT_NAME = {
  "ADBE Light Intensity": "Intensity", "ADBE Light Color": "Color",
  "ADBE Light Cone Angle": "Cone Angle",
  "ADBE Light Cone Feather 2": "Cone Feather",
  "ADBE Light Falloff Type": "Falloff",
  "ADBE Light Falloff Start": "Radius",
  "ADBE Light Falloff Distance": "Falloff Distance",
  "ADBE Casts Shadows": "Casts Shadows",
  "ADBE Light Shadow Darkness": "Shadow Darkness",
  "ADBE Light Shadow Diffusion": "Shadow Diffusion"
};
const HIDDEN_MSG = "After Effects error: Can not “set value” with " +
  "this property, because the property or a parent property is hidden.";

function accepts(list, kind) {
  return (" " + list + " ").indexOf(" " + kind + " ") >= 0;
}

// One property. FACT 1: canSetValue is false even when setValue works.
function LightProp(light, matchName, initial, gate) {
  this.matchName = matchName;
  this.name = OPT_NAME[matchName] || matchName;
  this.value = initial;
  this.canSetValue = false;     // <- the lie, reproduced deliberately
  this.elided = false;          // <- the other lie
  this._light = light;
  this._gate = gate;
  this.writes = 0;
}
LightProp.prototype.setValue = function (v) {
  if (!this._gate()) throw new Error(HIDDEN_MSG);
  this.value = v;
  this.writes++;
};

function Light(name, comp, center) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.lightType = LightType.SPOT;              // FACT: default is SPOT
  this.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
  const self = this;
  const kind = () => KIND_OF[self.lightType];

  // FACT 2: all 14 exist on every type; the group never shrinks.
  this._opts = {};
  const defaults = {
    "ADBE Light Intensity": 100, "ADBE Light Color": [1, 1, 1, 1],
    "ADBE Light Cone Angle": 90, "ADBE Light Cone Feather 2": 50,
    "ADBE Light Falloff Type": 1, "ADBE Light Falloff Start": 500,
    "ADBE Light Falloff Distance": 500, "ADBE Casts Shadows": 0,
    "ADBE Light Shadow Darkness": 100, "ADBE Light Shadow Diffusion": 0,
    "ADBE Light Env Atom": null, "ADBE Light Backgd Visible": 0,
    "ADBE Light Backgd Opacity": 100, "ADBE Light Backgd Blur": 0
  };
  Object.keys(OPT_ON).forEach(mn => {
    self._opts[mn] = new LightProp(self, mn, defaults[mn], function () {
      if (!accepts(OPT_ON[mn], kind())) return false;
      // FACT 4: Falloff gates its own two.
      const ft = self._opts["ADBE Light Falloff Type"].value;
      if (mn === "ADBE Light Falloff Start") return ft === 2 || ft === 3;
      if (mn === "ADBE Light Falloff Distance") return ft === 2;
      return true;
    });
  });

  // FACT 7: center lands in the POI. Position gets AEs own default,
  // which is NOT the centre (measured on an 800x600 comp).
  this._xform = {};
  const xdef = { "ADBE Position": [0, 0, -555.556],
                 "ADBE Anchor Point": [center[0], center[1], 0] };
  Object.keys(XFORM_ON).forEach(mn => {
    self._xform[mn] = new LightProp(self, mn, xdef[mn], function () {
      if (!accepts(XFORM_ON[mn], kind())) return false;
      // FACT 6: a one-node light has no Point of Interest.
      if (mn === "ADBE Anchor Point" &&
          self.autoOrient === AutoOrientType.NO_AUTO_ORIENT) return false;
      return true;
    });
  });
}
Object.defineProperty(Light.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
Light.prototype.property = function (mn) {
  const self = this;
  if (mn === "ADBE Light Options Group") {
    return { numProperties: Object.keys(OPT_ON).length,
             property: k => typeof k === "number"
               ? self._opts[Object.keys(OPT_ON)[k - 1]] : self._opts[k] };
  }
  if (mn === "ADBE Transform Group") {
    return { property: k => {
      if (!self._xform[k]) throw new Error("no property " + k);
      return self._xform[k];
    } };
  }
  throw new Error("no property group " + mn);
};

function Comp(name) {
  this.name = name;
  this.width = 800; this.height = 600;
  this.duration = 5; this.frameRate = 24;
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
      // FACT: addLight requires BOTH arguments; one throws in real AE.
      addLight(name, center) {
        if (arguments.length < 2) {
          throw new Error("After Effects error: Unable to call " +
            "“addLight” because the call requires 2 parameters.");
        }
        const L = new Light(name, self, center);
        Object.setPrototypeOf(L, Object.create(LightLayer.prototype,
          Object.getOwnPropertyDescriptors(Light.prototype)));
        self._layers.forEach(x => { x.selected = false; });
        L.selected = true;             // adding a layer steals selection
        self._layers.push(L);
        return L;
      },
      addNull() {
        const L = { name: "Null 1", comp: self, selected: false };
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

const comp = project.items.addComp("Room");
const lightsIn = () => comp._layers.filter(l => l instanceof LightLayer);
const optOf = (L, mn) => L.property("ADBE Light Options Group").property(mn);

// ------------------------------------------------------ 0. stub fidelity

{
  const probe = comp.layers.addLight("Fidelity", [400, 300]);
  assert(optOf(probe, "ADBE Light Intensity").canSetValue === false,
         "STUB FIDELITY: canSetValue is FALSE on a light property that " +
         "writes fine — gating on it would refuse everything");
  optOf(probe, "ADBE Light Intensity").setValue(42);
  assert(optOf(probe, "ADBE Light Intensity").value === 42,
         "  ...and the write is accepted anyway");
  assert(probe.property("ADBE Light Options Group").numProperties === 14 &&
         probe.lightType === LightType.SPOT,
         "STUB FIDELITY: 14 options on a default SPOT light");
  probe.lightType = LightType.AMBIENT;
  assert(probe.property("ADBE Light Options Group").numProperties === 14,
         "STUB FIDELITY: the group does NOT shrink for an ambient light");
  let threw = false;
  try { optOf(probe, "ADBE Light Cone Angle").setValue(30); }
  catch (e) { threw = /hidden/.test(e.message); }
  assert(threw, "STUB FIDELITY: writing a hidden option throws AE's " +
                "'property or a parent property is hidden'");
  comp._layers.length = 0;
}

// -------------------------------------------- 1. the tool exists at all

assert(typeof AELL_TOOLS.add_light === "function",
       "add_light is a host tool (item 2's last uncovered bullet)");
assert(AELL_MUTATING.add_light === true,
       "add_light is MUTATING, so it gets an undo group");
assert(/name:\s*"add_light"/.test(toolsSrc),
       "add_light is documented in tools.js — an undocumented tool is " +
       "unreachable by the model");

// ------------------------------------------- 2. a spot light takes it all

{
  const r = call("add_light", { comp: "Room", name: "Key",
    type: "spot", position: [100, 200, -300], pointOfInterest: [10, 20, 30],
    intensity: 80, color: [1, 0.5, 0], coneAngle: 60, coneFeather: 25,
    falloff: "smooth", radius: 111, falloffDistance: 222,
    castsShadows: true, shadowDarkness: 70, shadowDiffusion: 12 });
  assert(r.ok, "a spot light accepts every option: " + (r.error || ""));
  const L = comp.layer("Key");
  assert(r.data.type === "spot" && r.data.index === L.index,
         "result reports the type and the real index");
  assert(!r.data.refused, "nothing was refused: " + r.data.refused);
  assert(optOf(L, "ADBE Light Cone Angle").value === 60 &&
         optOf(L, "ADBE Light Shadow Diffusion").value === 12,
         "spot-only options really landed");
  assert(optOf(L, "ADBE Casts Shadows").value === 1,
         "castsShadows:true became AE's 1, not a raw boolean");
  assert(String(optOf(L, "ADBE Light Color").value) === "1,0.5,0",
         "color went in as a 3-component 0-1 triple");
  assert(String(L.property("ADBE Transform Group")
                 .property("ADBE Anchor Point").value) === "10,20,30",
         "Point of Interest is the Anchor Point on a light");
  assert(/Accepts Lights/.test(r.data.note),
         "the note says what a light actually needs to be seen: " +
         r.data.note);
}

// ------------------------- 3. FACT 4: falloff is written BEFORE radius

{
  const L = comp.layer("Key");
  assert(optOf(L, "ADBE Light Falloff Start").value === 111 &&
         optOf(L, "ADBE Light Falloff Distance").value === 222,
         "radius and falloffDistance landed, so Falloff was set FIRST " +
         "(the stub's gate throws if the order is reversed)");
}

// ----------------------------- 4. radius without falloff is refused

{
  const before = lightsIn().length;
  const r = call("add_light", { comp: "Room", name: "NoFall",
                                type: "spot", radius: 300 });
  assert(!r.ok, "radius with the default falloff (none) is refused");
  assert(/falloff/i.test(r.error) && /smooth/.test(r.error),
         "and the refusal names the fix: " + r.error);
  assert(lightsIn().length === before,
         "VALIDATE BEFORE CREATE: the refusal left no half-built light");
}

// ------------- 5. falloffDistance needs smooth specifically, not just any

{
  const r = call("add_light", { comp: "Room", type: "spot",
    falloff: "inverseSquareClamped", falloffDistance: 400 });
  assert(!r.ok, "falloffDistance under inverseSquareClamped is refused " +
                "(AE hides it there; only smooth keeps it)");
  assert(/is .inverseSquareClamped./.test(r.error),
         "and echoes the falloff the way the DOCS spell it — the model " +
         "copies whatever a refusal shows it: " + r.error);
  const r2 = call("add_light", { comp: "Room", name: "Clamped",
    type: "spot", falloff: "inverseSquareClamped", radius: 400 });
  assert(r2.ok, "but radius under inverseSquareClamped is fine: " +
                (r2.error || ""));
  assert(optOf(comp.layer("Clamped"), "ADBE Light Falloff Start")
           .value === 400, "and it lands");
}

// ------------------------------ 6. per-type hiding, grounded both ways

{
  const r = call("add_light", { comp: "Room", type: "point",
                                coneAngle: 45 });
  assert(!r.ok, "a point light has no cone angle");
  assert(/\bspot\b/.test(r.error),
         "the refusal names the type that DOES take it: " + r.error);
  assert(/intensity/.test(r.error) && /shadowDiffusion/.test(r.error),
         "and lists what a point light does accept");
  assert(!/coneAngle,/.test(r.error.split("accepts:")[1] || ""),
         "without listing the one it just refused");
}

{
  const r = call("add_light", { comp: "Room", type: "parallel",
                                shadowDiffusion: 10 });
  assert(!r.ok, "a parallel light has no shadow diffusion");
  assert(/spot, point/.test(r.error),
         "naming both types that do: " + r.error);
}

// ---------------------------- 7. ambient/environment: no transform at all

{
  const r = call("add_light", { comp: "Room", type: "ambient",
                                position: [1, 2, 3] });
  assert(!r.ok, "an ambient light has no position — AE hides even that");
  assert(/parallel, spot, point/.test(r.error) &&
         /^An ambient light/.test(r.error),
         "and says which types are positionable, in English: " + r.error);

  const r2 = call("add_light", { comp: "Room", name: "Fill",
                                 type: "ambient", intensity: 30,
                                 color: [0, 0, 1] });
  assert(r2.ok, "ambient still takes intensity and color: " + (r2.error || ""));
  assert(r2.data.applied === "intensity, color",
         "and reports exactly those: " + r2.data.applied);
  const L = comp.layer("Fill");
  assert(L.lightType === LightType.AMBIENT, "the type really changed");
  assert(String(L.property("ADBE Transform Group")
                 .property("ADBE Anchor Point").value) === "400,300,0",
         "FACT 7: the centre addLight demanded landed in the POINT OF " +
         "INTEREST (hidden on an ambient light, but still set)");
  assert(String(L.property("ADBE Transform Group")
                 .property("ADBE Position").value) !== "400,300,0",
         "  ...and NOT in Position, which keeps AEs own default");
}

{
  const r = call("add_light", { comp: "Room", type: "point",
                                pointOfInterest: [1, 2, 3] });
  assert(!r.ok, "a point light has no Point of Interest");
  assert(/parallel, spot/.test(r.error) && !/\bpoint\b,/.test(r.error),
       "and 'point' does not substring-match itself out of the refusal: " +
       r.error);
}

// ------------------------------------ 8. one-node, and the ordering rule

{
  const r = call("add_light", { comp: "Room", type: "spot",
                                oneNode: true, pointOfInterest: [1, 2, 3] });
  assert(!r.ok, "oneNode plus pointOfInterest is refused, not silently " +
                "one of the two");
  const r2 = call("add_light", { comp: "Room", name: "Free", type: "spot",
                                 oneNode: true, position: [5, 6, 7] });
  assert(r2.ok, "a one-node light is buildable: " + (r2.error || ""));
  const L = comp.layer("Free");
  assert(L.autoOrient === AutoOrientType.NO_AUTO_ORIENT,
         "autoOrient really became NO_AUTO_ORIENT");
  assert(String(L.property("ADBE Transform Group")
                 .property("ADBE Position").value) === "5,6,7",
         "and Position still landed after it");
}

// ----------------------------------------- 9. type names and AE versions

{
  const r = call("add_light", { comp: "Room", type: "spotlight" });
  assert(!r.ok && /parallel, spot, point, ambient, environment/.test(r.error),
         "an unknown type lists all five AE 2026 has: " + r.error);

  const r2 = call("add_light", { comp: "Room", name: "Env",
                                 type: "environment", intensity: 50 });
  assert(r2.ok, "environment (the fifth type, new since training) works: " +
                (r2.error || ""));

  const saved = LightType.ENVIRONMENT;
  delete LightType.ENVIRONMENT;
  const r3 = call("add_light", { comp: "Room", type: "environment" });
  LightType.ENVIRONMENT = saved;
  assert(!r3.ok, "on an AE without it, environment is refused");
  assert(/parallel, spot, point, ambient/.test(r3.error) &&
         !/environment\./.test(r3.error),
         "listing only the four that build has: " + r3.error);
}

// --------------------------------- 10. defaults, selection, bad arg shapes

{
  const keep = comp.layer("Key");
  comp._layers.forEach(l => { l.selected = false; });
  keep.selected = true;
  const r = call("add_light", { comp: "Room", name: "Plain" });
  assert(r.ok && r.data.type === "spot",
         "no type given defaults to spot, the way AE's own dialog does");
  assert(r.data.applied === "(defaults only)",
         "and says so rather than claiming work: " + r.data.applied);
  assert(comp.layer("Key").selected === true &&
         comp.layer("Plain").selected === false,
         "AELL_keepSelection restored the user's selection after the add");

  const r2 = call("add_light", { comp: "Room", type: "spot",
                                 position: [1, 2] });
  assert(!r2.ok && /\[x, y, z\]/.test(r2.error),
         "a 2-component position is refused — lights are always 3D: " +
         r2.error);

  const r3 = call("add_light", { comp: "Room", type: "spot",
                                 falloff: "quadratic" });
  assert(!r3.ok && /none, smooth, inverseSquareClamped/.test(r3.error),
         "an unknown falloff lists the three AE has: " + r3.error);
}

console.log("\n" + checks + " checks, " +
            (process.exitCode ? "FAILURES ABOVE" : "all passed"));
