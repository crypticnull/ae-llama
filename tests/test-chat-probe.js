// Regression test: the CHAT PROBE's own verdicts.
//
// scripts/chat-probe.js is the only thing that tests the model's half of
// the product, and it takes ten minutes, a running After Effects and a
// loaded 7B to say anything. That is fine for a field run and useless as
// a gate — a verdict that silently accepts a broken result is exactly the
// bug class this project keeps hitting (the stagger step passed a
// half-frame stagger for a week because it only asked "are the start
// times DISTINCT?").
//
// So the two things the probe grew for the "second turn / one Ctrl+Z"
// checklist gap are pinned here, with no AE and no model:
//
//  1. The verdict functions, against synthetic comp states — including
//     the near-misses a careless check would wave through (recoloured by
//     deleting and re-adding layers, blue everywhere except one square,
//     parenting silently lost).
//  2. The ExtendScript the probe generates (READ_COMP, SIG_FN, undoProbe)
//     RUN against a stubbed AE with a real undo stack. A typo in those
//     strings is otherwise only discoverable ten minutes into a field
//     run, and the undo loop has a safety property worth pinning: it must
//     never press Ctrl+Z more times than its cap, because the probe runs
//     against the user's live project.
"use strict";

// The probe mirrors main.js at load: it seeds the bundled workflow
// templates into the data root. On a machine with neither APPDATA nor
// USERPROFILE (Linux CI, the remote session) settings.js's fallback
// chain lands on the EXTENSION path, so the seed appeared INSIDE the
// repo as extension/AE-Llama — working-tree pollution a packager run
// from the same checkout would ship. Give the fallback a disposable
// root before the probe loads.
if (!process.env.APPDATA && !process.env.USERPROFILE) {
  const osX = require("os");
  const fsX = require("fs");
  const pathX = require("path");
  process.env.APPDATA =
    fsX.mkdtempSync(pathX.join(osX.tmpdir(), "aell-data-"));
}

const probe = require("../scripts/chat-probe.js");
const { STEPS, squares, undoProbe, SIG_FN, READ_COMP } = probe;

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

function stepByTitle(title) {
  const s = STEPS.filter(x => x.title === title)[0];
  if (!s) throw new Error("no probe step called " + title);
  return s;
}

// ------------------------------------------------- synthetic comp states

let uid = 0;
function square(over) {
  uid++;
  const row = {
    index: uid, name: "Red Square " + uid, parent: null, matte: 0,
    masks: 0, text: null, effects: 0, opacityKeys: 0, opacityKeyTimes: [],
    position: [100 * uid, 540, 0], startTime: 0, inPoint: 0,
    solidColor: [1, 0, 0], effectNames: [], effectColors: [],
    scale: [100, 100, 100], rotation: 0, isText: false, isShape: false,
    isNull: false, isSolid: true,
    // What READ_COMP grew for the trigger-layer steps (14 onward). A
    // 200x200 solid: anchor in its middle, fully opaque, no masks, no
    // expressions, linear keys if any.
    matteLayer: null, matteLayerKnown: true, isPrecomp: false,
    anchorPoint: [100, 100, 0],
    opacity: 100, sourceRect: { left: 0, top: 0, width: 200, height: 200 },
    layerWidth: 200, layerHeight: 200, maskBoxes: [], maskModes: [],
    maskInverted: [], maskFeather: [], maskRound: [],
    // The two halves of "white, 120 pixels" the text step used not to
    // read. null is what a layer that is not text reports, and also what
    // an AE that would not hand the value over reports — the check has
    // to tell "wrong" from "unreadable".
    fontSize: null, fillColor: null,
    opacityKeyEased: [], expressions: {}, textAnimators: 0
  };
  for (const k in over) row[k] = over[k];
  return row;
}
/** Any non-solid layer (text, shape, null, precomp) in the same shape. */
function layer(over) {
  return square(Object.assign({ isSolid: false, solidColor: null }, over));
}
function comp(layers) {
  return { found: true, name: "Probe Room", width: 1920, height: 1080,
           duration: 6, frameRate: 30, layers: layers };
}
function nine(over) {
  uid = 0;
  const out = [];
  for (let i = 0; i < 9; i++) out.push(square(over));
  return out;
}

// ------------------------------------------- 1. "a second turn refers back"

const back = stepByTitle("a second turn that refers back");

{
  const before = comp(nine());
  const after = comp(nine({ solidColor: [0, 0.2, 1] }));
  assert(back.check(after, { before: before }) === null,
         "nine blue solids after nine red ones is a pass");
}
{
  // No tool changes a solid's colour, so a Fill/Tint effect is a
  // legitimate answer and the verdict has to see it.
  const before = comp(nine());
  const after = comp(nine({ effectNames: ["Fill"],
                            effectColors: [[0.1, 0.15, 0.95]] }));
  assert(back.check(after, { before: before }) === null,
         "a blue Fill effect counts as blue");
}
{
  const before = comp(nine());
  const after = comp(nine());
  const v = back.check(after, { before: before });
  assert(/0 of 9|still not blue/.test(v || ""),
         "nothing recoloured is a fail that says what colour they are");
}
{
  // The near-miss: eight done, one missed. A "some layer is blue" check
  // would call this a pass.
  const before = comp(nine());
  const layers = nine({ solidColor: [0, 0.2, 1] });
  layers[4].solidColor = [1, 0, 0];
  const v = back.check(comp(layers), { before: before });
  assert(/8 of 9/.test(v || ""), "eight of nine blue is a fail (got: " +
         v + ")");
}
{
  // Recoloured by deleting and re-adding — the count gives it away.
  const before = comp(nine());
  const after = comp(nine({ solidColor: [0, 0.2, 1] }).slice(0, 7));
  const v = back.check(after, { before: before });
  assert(/9 squares before/.test(v || ""),
         "losing layers on the way to blue is a fail");
}
{
  const before = comp(nine());
  const after = comp(nine({ solidColor: [0, 0.2, 1] })
    .concat([square({ solidColor: [0, 0.2, 1] })]));
  assert(back.check(after, { before: before }) !== null,
         "gaining a tenth square on the way to blue is a fail");
}
{
  // Blue but destructive: the parenting from the previous turn is gone.
  uid = 0;
  const before = comp(nine({ parent: "Rig" }));
  uid = 0;
  const after = comp(nine({ parent: null, solidColor: [0, 0.2, 1] }));
  const v = back.check(after, { before: before });
  assert(/lost the parent/.test(v || ""),
         "blue squares that lost their parent is a fail (got: " + v + ")");
}
{
  // Blue is blue, not "has some blue in it": a purple-ish grey must not
  // pass, or the step never fails.
  const before = comp(nine());
  const after = comp(nine({ solidColor: [0.5, 0.5, 0.55] }));
  assert(back.check(after, { before: before }) !== null,
         "a barely-blue grey is not blue");
}
{
  // The step must survive being run on its own (--steps 9) with no
  // before-state to compare against.
  const after = comp(nine({ solidColor: [0, 0.2, 1] }));
  assert(back.check(after, { before: null }) === null,
         "with no before-state it still judges the colour");
}

// -------------------------------------------- 2. "one Ctrl+Z per command"

const undoStep = stepByTitle("one Ctrl+Z for one chat command");
const anyComp = comp(nine());

assert(undoStep.undo === true,
       "the undo step is flagged so the runner measures undo for it");
assert(undoStep.check(anyComp,
  { toolRounds: 1, undo: { changed: true, undos: 1, cap: 3 } }) === null,
  "one round, one Ctrl+Z is a pass");
assert(undoStep.check(anyComp,
  { toolRounds: 2, undo: { changed: true, undos: 2, cap: 4 } }) === null,
  "two model rounds costing two Ctrl+Z is the host contract, not a bug");
{
  // The regression this step exists for: a run whose undo group leaked,
  // so one tool round cost several Ctrl+Z.
  const v = undoStep.check(anyComp,
    { toolRounds: 1, undo: { changed: true, undos: 3, cap: 5 } });
  assert(/3 Ctrl\+Z but only ran 1 tool round/.test(v || ""),
         "three undos for one tool round is a fail (got: " + v + ")");
}
{
  const v = undoStep.check(anyComp,
    { toolRounds: 2, undo: { changed: true, undos: -1, tried: 2, cap: 2 } });
  assert(/never got back/.test(v || ""),
         "not restored within the cap is a fail");
}
{
  const v = undoStep.check(anyComp,
    { toolRounds: 0, undo: { changed: false, undos: 0, cap: 0 } });
  assert(/nothing to undo/.test(v || ""),
         "a command that changed nothing cannot pass the undo step");
}
{
  const v = undoStep.check(anyComp,
    { toolRounds: 1, undo: { error: "AE did not answer" } });
  assert(/could not measure undo/.test(v || ""),
         "a failed measurement is a fail, not a pass");
}
assert(undoStep.check(anyComp, { toolRounds: 1, undo: null }) !== null,
       "no measurement at all is a fail");

// --------------------------------------- 3. the generated ExtendScript, run
//
// A stubbed AE with an undo STACK: every mutation pushes a snapshot,
// app.executeCommand(16) pops one. Enough object model for READ_COMP and
// SIG_FN to walk it exactly as they walk the real thing.

function SolidSource() {}
function CompItem() {}
function FootageItem() {}
function TextLayer() {}
function ShapeLayer() {}
const PropertyValueType = { COLOR: 6618, OneD: 6417 };
// AE's enum values (KeyframeInterpolationType.LINEAR is 6612, BEZIER
// 6613, HOLD 6614); the stub only needs them to be distinct.
const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
const MaskMode = { NONE: 6412, ADD: 6413, SUBTRACT: 6414, INTERSECT: 6415 };

function propGroup(map) {
  return {
    numProperties: map.__count === undefined
      ? Object.keys(map).length : map.__count,
    property(name) {
      if (typeof name === "number") return map.__list[name - 1];
      if (!(name in map)) throw new Error("no property " + name);
      return map[name];
    }
  };
}

function buildLayer(spec, index) {
  const solid = spec.solid || null;
  const L = {
    name: spec.name, index: index,
    parent: spec.parent ? { name: spec.parent } : null,
    // Measured in AE 2026: an unmatted layer reads NO_TRACK_MATTE 5012,
    // not 0, and ALPHA is 5013 — the constant the probe used to treat as
    // "no matte". Both directions were wrong, so both are pinned here.
    trackMatteType: spec.matte ||
      (spec.matteLayer ? 5013 : 5012),
    // AE 23+: the matte is a layer reference, not just a type.
    trackMatteLayer: spec.matteLayer ? { name: spec.matteLayer } : null,
    inPoint: spec.inPoint || 0, outPoint: spec.outPoint || 6,
    startTime: spec.startTime || 0,
    nullLayer: !!spec.isNull,
    width: spec.width || 100, height: spec.height || 100,
    source: spec.precomp
      ? Object.assign(new CompItem(), { name: spec.precomp })
      : solid
        ? { mainSource: Object.assign(new SolidSource(),
                                      { color: solid.slice(0) }) }
        : null
  };
  L.sourceRectAtTime = function () {
    const r = spec.rect || [0, 0, L.width, L.height];
    return { left: r[0], top: r[1], width: r[2], height: r[3] };
  };
  // An expression lives on the property with its enabled switch; a
  // property without one reads as "" / false exactly as in AE.
  const expressions = spec.expressions || {};
  function withExpr(key, prop) {
    prop.expression = expressions[key] || "";
    prop.expressionEnabled = !!expressions[key];
    return prop;
  }
  const effectList = (spec.effects || []).map(function (fx) {
    const params = (fx.colors || []).map(function (c) {
      return { propertyValueType: PropertyValueType.COLOR,
               value: c.slice(0) };
    });
    return { name: fx.name, numProperties: params.length,
             property(i) { return params[i - 1]; } };
  });
  const eased = spec.eased || [];
  function interp(k) {
    return eased[k - 1] ? KeyframeInterpolationType.BEZIER
                        : KeyframeInterpolationType.LINEAR;
  }
  const transform = propGroup({
    "ADBE Position": withExpr("position",
      { value: (spec.pos || [0, 0, 0]).slice(0) }),
    "ADBE Scale": withExpr("scale",
      { value: (spec.scale || [100, 100, 100]).slice(0) }),
    "ADBE Rotate Z": withExpr("rotation", { value: spec.rot || 0 }),
    "ADBE Anchor Point": { value: (spec.anchor || [0, 0, 0]).slice(0) },
    "ADBE Opacity": withExpr("opacity", {
      value: spec.opacity === undefined ? 100 : spec.opacity,
      numKeys: spec.keys || 0,
      keyTime(k) { return (spec.keyTimes || [])[k - 1]; },
      keyInInterpolationType: interp,
      keyOutInterpolationType: interp })
  });
  // Masks as rectangles [x, y, w, h] in layer space; a bare `masks`
  // count (the older specs) gets full-layer rectangles.
  const maskRects = (spec.maskRects || []).slice(0);
  const maskCount = spec.masks !== undefined ? spec.masks : maskRects.length;
  while (maskRects.length < maskCount) {
    maskRects.push([0, 0, L.width, L.height]);
  }
  const groups = {
    "ADBE Transform Group": transform,
    "ADBE Effect Parade": { numProperties: effectList.length,
                            property(i) { return effectList[i - 1]; } },
    "ADBE Mask Parade": {
      numProperties: maskCount,
      property(i) {
        const r = maskRects[i - 1];
        const mode = (spec.maskModes || [])[i - 1] || "add";
        // An ellipse mask carries bezier tangents; a rectangle's are all
        // zero. That is the ONLY thing separating "an oval mask" from "a
        // box the same size", so the stub has to model both — modelled
        // exactly the way hostscript's add_mask builds them.
        const oval = !!(spec.maskOval || [])[i - 1];
        const kx = oval ? (r[2] / 2) * 0.5523 : 0;
        const ky = oval ? (r[3] / 2) * 0.5523 : 0;
        const feather = (spec.maskFeather || [])[i - 1];
        return {
          maskMode: mode === "subtract" ? MaskMode.SUBTRACT
                  : mode === "add" ? MaskMode.ADD : MaskMode.INTERSECT,
          inverted: !!(spec.maskInverted || [])[i - 1],
          property(name) {
            if (name === "ADBE Mask Feather") {
              if (feather === undefined) throw new Error("no feather");
              return { value: [feather, feather] };
            }
            if (name !== "ADBE Mask Shape") throw new Error("no " + name);
            return { value: {
              vertices: oval
                ? [[r[0] + r[2] / 2, r[1]], [r[0] + r[2], r[1] + r[3] / 2],
                   [r[0] + r[2] / 2, r[1] + r[3]], [r[0], r[1] + r[3] / 2]]
                : [[r[0], r[1]], [r[0] + r[2], r[1]],
                   [r[0] + r[2], r[1] + r[3]], [r[0], r[1] + r[3]]],
              inTangents: [[-kx, 0], [0, -ky], [kx, 0], [0, ky]],
              outTangents: [[kx, 0], [0, ky], [-kx, 0], [0, -ky]] } };
          } };
      }
    }
  };
  if (spec.text !== undefined) {
    // A real TextDocument carries the size and the fill beside the
    // string. applyFill false is AE's "this text has no fill", and
    // reading fillColor then THROWS — modelled, because READ_COMP reads
    // the two in separate try blocks for exactly that reason.
    const doc = { text: spec.text };
    if (spec.fontSize !== undefined) doc.fontSize = spec.fontSize;
    if (spec.applyFill === false) {
      doc.applyFill = false;
      Object.defineProperty(doc, "fillColor",
        { get() { throw new Error("no fill on this text"); } });
    } else if (spec.fillColor !== undefined) {
      doc.fillColor = spec.fillColor.slice(0);
    }
    groups["Source Text"] = { value: doc };
    groups["ADBE Text Properties"] = propGroup({
      "ADBE Text Animators": { numProperties: spec.animators || 0 } });
  }
  L.property = function (name) {
    if (!(name in groups)) throw new Error("no group " + name);
    return groups[name];
  };
  if (spec.isText) Object.setPrototypeOf(L, TextLayer.prototype);
  if (spec.isShape) Object.setPrototypeOf(L, ShapeLayer.prototype);
  return L;
}

const world = { stack: [], undos: 0 };
function setLayers(specs) { world.stack.push(JSON.parse(JSON.stringify(specs))); }
function currentSpecs() { return world.stack[world.stack.length - 1]; }

const stubComp = new CompItem();
stubComp.name = "Probe Room";
stubComp.width = 1920;
stubComp.height = 1080;
stubComp.duration = 6;
stubComp.frameRate = 30;
stubComp.layer = function (i) { return buildLayer(currentSpecs()[i - 1], i); };
Object.defineProperty(stubComp, "numLayers",
  { get() { return currentSpecs().length; } });
const app = {
  project: {
    get numItems() { return 1; },
    item(i) { return stubComp; }
  },
  executeCommand(id) {
    world.undos++;
    if (id !== 16) throw new Error("stub only knows Undo (16), got " + id);
    if (world.stack.length > 1) world.stack.pop();
  }
};

/** Run one of the probe's generated ExtendScript bodies in the stub. */
function runJsx(body) {
  // eslint-disable-next-line no-eval
  return eval("(function () {" + body + "})()");
}

const BASE = [
  { name: "Red Square 1", pos: [660, 400, 0], solid: [1, 0, 0] },
  { name: "Red Square 2", pos: [960, 400, 0], solid: [1, 0, 0],
    parent: "Rig", effects: [{ name: "Fill", colors: [[0, 0, 1]] }],
    // The trigger-layer fields, all on one layer: a half-height mask, a
    // two-key fade with the first pair eased, a wiggle on position, an
    // anchor in the middle, HELLO as its matte.
    width: 200, height: 200, maskRects: [[0, 0, 200, 100]],
    maskModes: ["subtract"], maskInverted: [true], maskFeather: [0],
    keys: 2, keyTimes: [0, 1], eased: [true, false],
    anchor: [100, 100, 0], opacity: 80,
    expressions: { position: "wiggle(2, 30)" }, matteLayer: "HELLO" },
  { name: "HELLO", pos: [960, 200, 0], isText: true, text: "HELLO",
    rect: [2, -86, 350, 90], animators: 2, fontSize: 120,
    fillColor: [1, 1, 1], masks: 1, maskRects: [[-20, -100, 400, 130]],
    maskOval: [true], maskFeather: [20] },
  { name: "Squares", pos: [960, 540, 0], precomp: "Squares" }
];

setLayers(BASE);

{
  const state = runJsx(READ_COMP);
  assert(state.found === true && state.layers.length === 4,
         "READ_COMP walks the comp");
  // The fields the trigger-layer verdicts read, pinned against the stub
  // so a typo in the ExtendScript is caught here and not ten minutes
  // into a field run.
  const sq2 = state.layers[1];
  assert(JSON.stringify(sq2.maskBoxes) === "[[0,0,200,100]]" &&
         sq2.layerWidth === 200 && sq2.layerHeight === 200,
         "READ_COMP reports mask bounding boxes and the layer size");
  assert(JSON.stringify(sq2.maskModes) === '["subtract"]' &&
         JSON.stringify(sq2.maskInverted) === "[true]",
         "READ_COMP reports each mask's mode and inverted switch");
  assert(JSON.stringify(sq2.opacityKeyEased) === "[true,false]",
         "READ_COMP reports which opacity keys are eased (BEZIER)");
  assert(sq2.expressions.position === "wiggle(2, 30)" &&
         !("scale" in sq2.expressions),
         "READ_COMP reports enabled transform expressions only");
  assert(JSON.stringify(sq2.anchorPoint) === "[100,100,0]" &&
         sq2.opacity === 80 && sq2.matteLayer === "HELLO",
         "READ_COMP reports anchor point, opacity and the matte layer");
  assert(state.layers[2].sourceRect.left === 2 &&
         state.layers[2].sourceRect.width === 350 &&
         state.layers[2].textAnimators === 2,
         "READ_COMP reports a text layer's source rect and animator count");
  assert(state.layers[3].isPrecomp === true && state.layers[0].isPrecomp === false,
         "READ_COMP tells a precomp layer from a solid");
  assert(JSON.stringify(state.layers[0].solidColor) === "[1,0,0]",
         "READ_COMP reports a solid's source colour (the recolour check " +
         "has nothing to read without it)");
  assert(JSON.stringify(state.layers[1].effectNames) === '["Fill"]' &&
         JSON.stringify(state.layers[1].effectColors) === "[[0,0,1]]",
         "READ_COMP reports effect names and their colours");
  assert(state.layers[2].text === "HELLO" && state.layers[2].isText === true,
         "READ_COMP still reads text layers");
  // What the tightened text/mask verdicts read. The oval is the one
  // that cannot be faked: an ellipse mask and a rectangle mask have the
  // SAME bounding box, so without the tangents "put an oval mask on it"
  // has no fingerprint at all.
  assert(state.layers[2].fontSize === 120 &&
         JSON.stringify(state.layers[2].fillColor) === "[1,1,1]",
         "READ_COMP reports a text layer's size and fill colour");
  assert(JSON.stringify(state.layers[2].maskRound) === "[true]" &&
         JSON.stringify(state.layers[2].maskFeather) === "[20]",
         "READ_COMP tells an oval mask from a box, and reads its feather");
  assert(JSON.stringify(state.layers[1].maskRound) === "[false]" &&
         JSON.stringify(state.layers[1].maskFeather) === "[0]",
         "a rectangular mask reads round=false, feather 0");
  assert(state.layers[0].fontSize === null &&
         state.layers[0].fillColor === null,
         "a solid reports no font size and no fill colour");
  assert(state.layers[1].parent === "Rig" && state.layers[1].masks === 1,
         "READ_COMP still reads parenting and masks");
  // The verdicts must be able to run on what the reader actually returns —
  // a field mismatch between the two is invisible in either half alone.
  assert(squares(state).length === 2, "squares() sees the two solids");
  assert(typeof back.check(state, { before: state }) === "string",
         "the recolour verdict runs on a real READ_COMP result");
}

{
  const sig = runJsx(SIG_FN + " return sig();");
  assert(typeof sig === "string" && /Red Square 1/.test(sig),
         "SIG_FN builds a signature");
  assert(/\|c1,0,0/.test(sig), "the signature carries solid colour");
  assert(/\|fRig/.test(sig), "the signature carries parenting");
  assert(/\|xHELLO/.test(sig), "the signature carries source text");
  const same = runJsx(SIG_FN + " return sig();");
  assert(same === sig, "the signature is stable when nothing changed");
}

// --- the undo loop itself -------------------------------------------

function reset(specs) {
  world.stack = [];
  world.undos = 0;
  setLayers(specs || BASE);
}

function mutate(fn) {
  const next = JSON.parse(JSON.stringify(currentSpecs()));
  fn(next);
  setLayers(next);
}

{
  reset();
  const before = runJsx(SIG_FN + " return sig();");
  mutate(s => s.push({ name: "Dot", pos: [960, 540, 0], solid: [1, 1, 1] }));
  mutate(s => { s[s.length - 1].effects = [{ name: "Drop Shadow" }]; });
  mutate(s => { s[s.length - 1].keys = 2; });
  const res = runJsx(undoProbe(before, 4));
  assert(res.changed === true, "the probe sees that the round changed the comp");
  assert(res.undos === 3, "three script runs take three undos (got " +
         res.undos + ")");
  assert(world.undos === 3, "and it stopped pressing Ctrl+Z the moment it " +
         "matched (pressed " + world.undos + ")");
}
{
  reset();
  const before = runJsx(SIG_FN + " return sig();");
  mutate(s => { s[0].pos = [10, 10, 0]; });
  const res = runJsx(undoProbe(before, 6));
  assert(res.undos === 1 && world.undos === 1,
         "one fused run costs exactly one Ctrl+Z");
}
{
  reset();
  const before = runJsx(SIG_FN + " return sig();");
  const res = runJsx(undoProbe(before, 3));
  assert(res.changed === false && res.undos === 0 && world.undos === 0,
         "a command that changed nothing presses Ctrl+Z zero times");
}
{
  // THE safety property. The probe runs against the user's live project,
  // so a cap of N means at most N undos — never a fixed 8 that eats their
  // own edits when the round only made one.
  reset();
  const before = runJsx(SIG_FN + " return sig();");
  mutate(s => { s[0].pos = [10, 10, 0]; });
  mutate(s => { s[1].rot = 45; });
  mutate(s => { s[2].text = "BYE"; });
  const res = runJsx(undoProbe(before, 1));
  assert(res.undos === -1, "it reports failure rather than a false pass");
  assert(world.undos === 1, "it pressed Ctrl+Z exactly once, its cap (was " +
         world.undos + ")");
  assert(typeof res.sample === "string" && res.sample.length > 0,
         "and it hands back what the comp looked like instead");
}
{
  reset();
  const before = runJsx(SIG_FN + " return sig();");
  mutate(s => { s[0].pos = [10, 10, 0]; });
  const res = runJsx(undoProbe(before, 0));
  assert(world.undos === 0,
         "a cap of zero presses nothing at all (the probe made no runs)");
  assert(res.undos === -1 || res.changed === false,
         "and says so rather than claiming success");
}
{
  // A cap must be a NUMBER in the generated source, not a template hole.
  const src = undoProbe("x", 3);
  assert(/var cap = 3;/.test(src), "the cap is baked into the script");
  assert(!/<= 8/.test(src), "no hard-coded 8 survives in the loop");
  assert(/executeCommand\(16\)/.test(src), "16 is AE's Undo command id");
}

// --------------------------------------------------------------- summary

const titles = STEPS.map(s => s.title);
/*
 * ORDER, not position. These used to be `indexOf(...) === 8` and `=== 9`,
 * which is the pin the 2026-08-30 audit named: inserting one step
 * anywhere earlier broke assertions that had nothing to do with the new
 * step, so the suite discouraged the very thing the paraphrase matrix
 * needs (steps growing). What is actually load-bearing is that a step
 * comes AFTER the steps that build what it names.
 */
function stepOrder(title) {
  const i = titles.indexOf(title);
  if (i === -1) throw new Error("no probe step called " + title);
  return i;
}
function assertAfter(later, earlier) {
  assert(stepOrder(later) > stepOrder(earlier),
         "'" + later + "' runs after '" + earlier + "'");
}
assertAfter("a second turn that refers back", "grid layout");
assertAfter("one Ctrl+Z for one chat command", "create a comp");
assert(stepOrder("a second turn that refers back") ===
       stepOrder("parenting") + 1,
       "the refer-back step follows its antecedent turn directly — its " +
       "pronoun resolves against the sentence before it, and nothing " +
       "else may be typed in between");
assert(STEPS.filter(s => typeof s.say !== "string" ||
                         typeof s.check !== "function").length === 0,
       "every step still has a sentence and a verdict");

// ------------------------ 3. "the model re-plans after a rolled-back round"

const replan = stepByTitle("the model re-plans after a round is rolled back");
{
  uid = 0;
  const ok = comp([square({ name: "Beta", solidColor: [1, 0.5, 0] })]);
  assert(replan.check(ok, { rolledBack: 1 }) === null,
         "exactly one Beta after a rollback is the right answer");
}
{
  uid = 0;
  const debris = comp([square({ name: "Beta" }), square({ name: "Beta 2" })]);
  const v = replan.check(debris, { rolledBack: 1 });
  assert(v && /2 layers called Beta/.test(v),
         "two Betas is the ten-squares bug and fails: " + v);
}
{
  const nothing = comp([]);
  const v = replan.check(nothing, { rolledBack: 1 });
  assert(v && /never redid the half that WAS achievable/.test(v),
         "rolling back and then giving up fails too — the user got " +
         "nothing: " + v);
  const v2 = replan.check(nothing, { rolledBack: 0 });
  assert(v2 && /never made the solid/.test(v2),
         "and says something different when no rollback was involved");
}
{
  uid = 0;
  const conjured = comp([square({ name: "Beta" }), square({ name: "Ghost" })]);
  const v = replan.check(conjured, { rolledBack: 1 });
  assert(v && /invented a layer called Ghost/.test(v),
         "inventing the missing layer to make the error go away fails: " + v);
}

// -------------------------------------- 2b. the two ComfyUI steps
//
// These are the first verdicts in the probe that judge a PANEL-side tool,
// so they read ctx.tools instead of the comp — and that is exactly where
// a lazy check would wave a failure through, because comfy_generate can
// come back ok:true having written nothing a user could see. Every
// stage between "the model called the tool" and "a real file is in the
// project" is pinned below with the near-miss that skips it.

const ready = stepByTitle("the image generator answers when asked");

{
  const v = ready.check(comp([]), { tools: [], replies: ["Yes, all set!"] });
  assert(v && /never|without calling/.test(v),
         "answering ABOUT ComfyUI without asking it anything fails: " + v);
}
{
  const v = ready.check(comp([]), {
    tools: [{ tool: "get_project_info", ok: true }], replies: [] });
  assert(v && /get_project_info/.test(v),
         "and the failure names what it ran instead: " + v);
}
{
  const ctx = { tools: [{ tool: "comfy_status", ok: true,
    data: { online: false, url: "http://127.0.0.1:8188",
            hint: "Start ComfyUI" } }], replies: [] };
  const v = ready.check(comp([]), ctx);
  assert(v && /not answering/.test(v),
         "an offline backend fails even though the tool call succeeded: " + v);
}
{
  const ctx = { tools: [{ tool: "comfy_list_workflows", ok: true,
    data: { workflows: [] } }], replies: [] };
  assert(/came back empty/.test(ready.check(comp([]), ctx) || ""),
         "an empty workflow list fails");
}
{
  // The tool doc promises the hidden backend boots itself, so this reply
  // is the product breaking a promise no comp state can show.
  const ctx = { tools: [{ tool: "comfy_status", ok: true,
    data: { online: true, running: 0, pending: 0 } }],
    replies: ["Please launch ComfyUI first, then ask me again."] };
  const v = ready.check(comp([]), ctx);
  assert(v && /start ComfyUI by hand/.test(v),
         "telling the user to launch it by hand fails: " + v);
}
{
  // The other half of that check, and the reason it is not a bare
  // /(start|launch|run).*comfy/: the true answers contain those words
  // too, and a step that fails on them fails every night.
  const online = { tool: "comfy_status", ok: true,
    data: { online: true, running: 0, pending: 0 } };
  assert(ready.check(comp([]), { tools: [online],
    replies: ["ComfyUI is running with nothing queued."] }) === null,
    "\"ComfyUI is running\" is not an instruction to run it");
  assert(ready.check(comp([]), { tools: [online],
    replies: ["You never have to launch ComfyUI — it boots itself."] })
      === null,
    "and neither is saying the user does NOT have to launch it");
}
{
  const ctx = { tools: [
    { tool: "comfy_status", ok: true,
      data: { online: true, running: 0, pending: 0 } },
    { tool: "comfy_list_workflows", ok: true,
      data: { workflows: ["AE_LLAMA_KREA2_V1"] } }],
    replies: ["The generator is online and can make images."] };
  assert(ready.check(comp([]), ctx) === null,
         "online + a workflow list + no hand-holding is a pass");
}

const picture = stepByTitle("generate a picture and bring it in");

// A real file the verdict can stat, and one that only claims to exist.
const os2 = require("os");
const fsC = require("fs");
const pathC = require("path");
const realPng = pathC.join(os2.tmpdir(),
  "aell-probe-test-" + process.pid + ".png");
fsC.writeFileSync(realPng, Buffer.alloc(4096, 7));
const ghostPng = realPng.replace(/\.png$/, "-missing.png");
const emptyPng = realPng.replace(/\.png$/, "-empty.png");
fsC.writeFileSync(emptyPng, Buffer.alloc(0));

function withFootage(layers, footage) {
  const c = comp(layers);
  c.footage = footage || [];
  return c;
}
function genOk(files) {
  return { tool: "comfy_generate", ok: true,
           data: { files: files, imported: files.map((f, i) =>
             ({ name: pathC.basename(f), id: 100 + i })) } };
}

{
  const v = picture.check(withFootage([], []), {
    tools: [{ tool: "add_solid", ok: true }], replies: [] });
  assert(v && /never called comfy_generate/.test(v),
         "drawing an apple with a solid instead of generating one " +
         "fails: " + v);
}
{
  const v = picture.check(withFootage([], []), {
    tools: [{ tool: "comfy_generate", ok: false,
              error: "Unknown workflow 'apple'" }] });
  assert(v && /Unknown workflow/.test(v),
         "a failed generation reports the generator's own error: " + v);
}
{
  const v = picture.check(withFootage([], []), {
    tools: [{ tool: "comfy_generate", ok: true, data: { files: [] } }] });
  assert(v && /named no output file/.test(v),
         "ok:true with no files is not a picture: " + v);
}
{
  // The failure that actually happened once, in a different disguise:
  // SaveVideo "succeeded" and left a file Windows would not open.
  const v = picture.check(withFootage([], []), {
    tools: [genOk([emptyPng])] });
  assert(v && /none of them is a real file/.test(v),
         "a zero-byte output fails: " + v);
  const v2 = picture.check(withFootage([], []), {
    tools: [genOk([ghostPng])] });
  assert(v2 && /none of them is a real file/.test(v2),
         "and so does a file that was never written");
}
{
  const v = picture.check(withFootage([], [
    { id: 9, name: "something-else.png", path: "C:\\other\\x.png",
      width: 512, height: 512, duration: 0 }]), { tools: [genOk([realPng])] });
  assert(v && /never got imported/.test(v),
         "generated but not in the project fails, and counts what IS " +
         "there: " + v);
}
{
  // AE hands back fsName (backslashes, its own casing); ComfyUI's
  // downloader hands back what Node built. Same file, different string.
  const aeStyle = realPng.replace(/\//g, "\\").toUpperCase();
  const state = withFootage([], [{ id: 100, name: "apple.png",
    path: aeStyle, width: 1232, height: 1232, duration: 0 }]);
  assert(picture.check(state, { tools: [genOk([realPng])] }) === null,
         "in the project under a differently-cased path is a pass");
}
{
  // The comp half is REPORTED, not failed — no tool places footage in a
  // comp yet (workplan 5.8). Pinned so that stays a deliberate choice.
  const state = withFootage(
    [{ index: 1, name: "apple.png", parent: null, isSolid: false,
       isNull: false, isText: false, isShape: false, effectNames: [],
       effectColors: [], sourceFile: realPng }],
    [{ id: 100, name: "apple.png", path: realPng, width: 1232,
       height: 1232, duration: 0 }]);
  assert(picture.check(state, { tools: [genOk([realPng])] }) === null,
         "and so is the same thing WITH a layer using it");
}
try { fsC.unlinkSync(realPng); } catch (e) {}
try { fsC.unlinkSync(emptyPng); } catch (e) {}

// -------------------------------------- 2c. the refusal nobody can see
//
// WORKPLAN item 7: a generation refused for want of VRAM renders
// nothing, imports nothing and raises no dialog, so the ONLY evidence a
// user ever gets is the sentence the model writes. Every near-miss below
// is a way that sentence can be wrong while every tool behaved.

const refused = stepByTitle("a generation that cannot fit is refused, in words");

// The shipped refusal, measured in the field 2026-08-30 (32B chat model,
// vramOverrideGB 8), with the override annotation this pass added.
const REFUSAL =
  "It does not fit beside the chat model \u2014 the generation needs " +
  "~17.7 GB and the chat model holds ~20 GB of the card's 8 GB (VRAM " +
  "override). 'Pause chat during generation' is set to never, so nothing " +
  "was started. Set it to auto (settings) or stop the chat server, then " +
  "ask again.";
// What the model actually replied on that run — the pass bar is a real
// sentence a real 32B produced, not one written to fit the regex.
const RELAY =
  "It looks like there isn't enough GPU memory to generate the image " +
  "while the chat model is running. Please pause the chat during " +
  "generation or use a machine with more GPU memory. Once you've " +
  "adjusted the settings, you can try again.";

function refusalCtx(over) {
  return Object.assign({
    tools: [{ tool: "comfy_generate", ok: false, error: REFUSAL }],
    replies: [RELAY], chatState: "running" }, over || {});
}

assert(refused.settings && refused.settings.vramOverrideGB === 8 &&
       refused.settings.comfyPauseLlm === "never",
       "the step impersonates an 8 GB card with pausing turned off");
assert(refused.check({}, refusalCtx()) === null,
       "the field capture is the pass case");
{
  const v = refused.check({}, refusalCtx({ tools: [] }));
  assert(v && /never called comfy_generate/.test(v),
         "a model that never reaches the generator fails: " + v);
}
{
  // The failure the whole step exists for: the arbiter let a job through
  // that cannot fit, which on a real card is an OOM instead of a
  // sentence.
  const v = refused.check({}, refusalCtx({
    tools: [{ tool: "comfy_generate", ok: true,
              data: { files: ["C:\\gen\\mug.png"] } }] }));
  assert(v && /SUCCEEDED/.test(v),
         "a generation that RAN on an 8 GB budget with pausing off " +
         "fails: " + v);
}
{
  // A different error means the step measured nothing — the arbiter was
  // never reached — and that is not a pass either.
  const v = refused.check({}, refusalCtx({
    tools: [{ tool: "comfy_generate", ok: false,
              error: "Unknown workflow 'image-to-image'. Available: ..." }] }));
  assert(v && /never reached/.test(v),
         "a refusal about something else does not count: " + v);
}
{
  // The 0.10.9 regression guard: before that pass no shipped manifest
  // carried a sizeMB, so every refusal on every card read like this.
  const v = refused.check({}, refusalCtx({
    tools: [{ tool: "comfy_generate", ok: false, error:
      "The panel cannot verify this generation fits beside the chat " +
      "model. 'Pause chat during generation' is set to never, so nothing " +
      "was started." }] }));
  assert(v && /does not say what does not fit/.test(v),
         "a refusal with no arithmetic in it fails: " + v);
}
{
  // The defect this step found on its first field run.
  const v = refused.check({}, refusalCtx({
    tools: [{ tool: "comfy_generate", ok: false,
              error: REFUSAL.replace(" (VRAM override)", "") }] }));
  assert(v && /impersonated card size/.test(v),
         "an unlabelled fictional card size fails: " + v);
}
{
  const v = refused.check({}, refusalCtx({ chatState: "stopped" }));
  assert(v && /cost the chat model/.test(v),
         "refusing is a decision, not an eviction: " + v);
}
{
  const v = refused.check({}, refusalCtx({ replies: [] }));
  assert(v && /relayed nothing/.test(v),
         "a refusal the user never sees fails: " + v);
}
{
  const v = refused.check({}, refusalCtx({
    replies: ["Here's your image of a blue ceramic mug on a wooden table!"] }));
  assert(v && /reported SUCCESS/.test(v),
         "and hallucinating the picture is the worst case of all: " + v);
}
{
  const v = refused.check({}, refusalCtx({
    replies: ["Sorry, I couldn't do that."] }));
  assert(v && /no reason in it/.test(v),
         "declining without saying why fails: " + v);
}
{
  const v = refused.check({}, refusalCtx({
    replies: ["I can't generate that — there isn't enough VRAM free."] }));
  assert(v && /never mentions the pause setting/.test(v),
         "and so does declining without naming the setting to change: " + v);
}

// ---- the generation cleanup only ever takes back what it imported

const { sweepImports, rememberGenerated, generated } = probe;
{
  rememberGenerated("comfy_generate", { ok: true, data: {
    files: ["C:\\gen\\a.png", "C:\\gen\\a.png"],
    imported: [{ name: "a.png", id: 42 }, { name: "a.png", id: 42 }] } });
  rememberGenerated("comfy_generate", { ok: false, data: {
    files: ["C:\\gen\\never.png"], imported: [{ name: "n", id: 7 }] } });
  rememberGenerated("add_solid", { ok: true, data: { files: ["C:\\x.png"] } });
  assert(generated.itemIds.join(",") === "42",
         "only a SUCCESSFUL comfy_generate's imports are remembered, once");
  assert(generated.files.join(",") === "C:\\gen\\a.png",
         "same for the files it wrote");
  const jsx = sweepImports(generated.itemIds);
  assert(/\[42\]/.test(jsx) && /it\.id === ids\[j\]/.test(jsx),
         "and the cleanup matches by item id, never by folder");
  assert(!/comfyOutDir|generated\\\\/.test(jsx),
         "so a user's own generations in the same folder are never touched");
}

// ---- anti-drift: the probe's round loop mirrors main.js's, by hand.
//
// This is the one thing in the probe that cannot be caught by running
// it: an option main.js passes and the probe does not simply makes the
// probe test a DIFFERENT product, quietly. It happened — the rollback
// shipped armed in the panel and unarmed in the probe, so the model's
// half of it went untested while the probe still reported passes.
const fs2 = require("fs");
const path2 = require("path");
const probeSrc = fs2.readFileSync(
  path2.join(__dirname, "..", "scripts", "chat-probe.js"), "utf8");
const mainSrc = fs2.readFileSync(
  path2.join(__dirname, "..", "extension", "js", "main.js"), "utf8");

for (const opt of ["dryRun", "allowRollback"]) {
  assert(new RegExp(opt + "\\s*:").test(probeSrc),
         "the probe passes executeCommands its '" + opt + "' option");
}
assert(/rollbackBudget/.test(probeSrc) && /rollbackBudget/.test(mainSrc),
       "and carries the same one-rollback-per-sentence budget main.js has");
assert(/rolledBack/.test(probeSrc),
       "and reports a rolled-back round instead of printing it as N errors");

// The general form, so the NEXT helper main.js grows is caught too. It
// has happened twice: allowRollback, then fitHistory — each time the
// probe went on reporting passes while testing a product the panel no
// longer was.
const PANEL_ONLY = {
  callHostBatch: "main.js only hands it to SelfTest, not to its round loop",
  catalogModelStatus: "settings UI rows (gen model manager), never a " +
    "chat round — covered by test-gen-model-manager.js",
  removeCatalogWeights: "settings Remove button, never a chat round — " +
    "covered by test-gen-model-manager.js"
};
const used = src => new Set(
  (src.match(/Tools\.[a-zA-Z]+/g) || []).map(m => m.split(".")[1]));
const mainUses = used(mainSrc);
const probeUses = used(probeSrc);
const missing = [...mainUses].filter(
  n => !probeUses.has(n) && !PANEL_ONLY[n]);
assert(missing.length === 0,
       "the probe uses every Tools helper main.js's chat path does" +
       (missing.length ? " (missing: " + missing.join(", ") + " — either " +
        "mirror it in chat-probe.js or add it to PANEL_ONLY with a " +
        "reason)" : ""));
for (const n of Object.keys(PANEL_ONLY)) {
  assert(mainUses.has(n),
         "PANEL_ONLY still describes something main.js uses: " + n);
}
assert(/forceTinyContext/.test(probeSrc) && /forceTinyContext/.test(mainSrc),
       "and mirrors the reactive hard-trim retry on a context 400");

// The same drift, one level down: tools.js dispatches through panel
// MODULES, and a module the probe never loaded is not a grounded error,
// it is a ReferenceError thrown inside the dispatcher. That is what
// comfy_generate would have hit — the probe loaded settings/tiers/llama/
// tools and nothing else, so every ComfyUI tool was unreachable and no
// verdict could ever have said so.
const toolsSrc = fs2.readFileSync(
  path2.join(__dirname, "..", "extension", "js", "tools.js"), "utf8");
const MODULE_FILE = {
  Comfy: "comfy.js", Setup: "setup.js", Llama: "llama.js",
  Settings: "settings.js", Tiers: "tiers.js", Tools: "tools.js",
  Whisper: "whisper.js", Ffmpeg: "ffmpeg.js", MogrtRead: "mogrt-read.js"
};
const needed = new Set(
  (toolsSrc.match(/global\.([A-Z][A-Za-z]+)/g) || [])
    .map(m => m.split(".")[1])
    // AEBridge is the probe's own shim, not a panel file.
    .filter(n => n !== "AEBridge"));
for (const mod of [...needed].sort()) {
  const file = MODULE_FILE[mod];
  assert(!!file, "tools.js's global." + mod + " maps to a panel file " +
         "(add it to MODULE_FILE if a new module appeared)");
  if (!file) continue;
  assert(probeSrc.indexOf('loadPanelFile("' + file + '")') !== -1,
         "the probe loads " + file + ", which tools.js dispatches through");
}

// Loading it is not the same as it ARRIVING. Ten panel modules end
// `})(window)` and two end `})(this)` — identical in a browser, where
// `this` at the top of a script IS window, and not identical at all
// inside `new Function`, where it is Node's global. The plain
// `new Function("window", src)(window)` therefore published Whisper on
// globalThis while tools.js looked for it on the probe's window, and
// every whisper/ffmpeg tool answered "not available in this panel
// build". Nothing about that refusal mentions the probe, which is why
// this asserts the module LANDS rather than that the file was read.
{
  const loaderRe =
    /function loadPanelFile\(rel\) \{[\s\S]*?new Function\("window", src\)([\s\S]*?)\n\}/;
  const m = loaderRe.exec(probeSrc);
  assert(!!m, "the probe's loadPanelFile is still shaped the way this " +
         "check expects");
  assert(!!m && /\.call\(window/.test(m[1]),
         "and it binds `this` to the probe's window as well as passing " +
         "it, so a `})(this)` module lands where tools.js looks");

  const EXT2 = path2.join(__dirname, "..", "extension");
  for (const [mod, file] of Object.entries(MODULE_FILE)) {
    if (file === "tools.js") continue;   // that one is the dispatcher
    const win = { console, setTimeout, clearTimeout,
                  localStorage: { getItem: () => null, setItem: () => {},
                                  removeItem: () => {} },
                  AEBridge: { nodeRequire: require,
                              getExtensionPath: () => EXT2,
                              evalScript: () => {} } };
    win.window = win;
    const src = fs2.readFileSync(path2.join(EXT2, "js", file), "utf8");
    let threw = null;
    try { new Function("window", src).call(win, win); }
    catch (e) { threw = e; }
    assert(!threw, file + " loads the way the probe loads it" +
           (threw ? ": " + threw.message : ""));
    assert(!threw && typeof win[mod] !== "undefined",
           "and publishes global." + mod + " onto the probe's window, " +
           "which is where tools.js dispatches through");
  }
}


// ---------------------------------------- 4. the bridge wrapper AE runs
//
// Measured in real AE on 2026-08-26, and it had broken every verdict the
// probe read: ExtendScript keeps a loaded file's top-level `var` in the
// scope it was evaluated in, so hostscript's AELLJSON was NOT on $.global
// while AELL_call (assigned explicitly) was. The wrapper skipped
// re-loading the host whenever AELL_call was already there — and then the
// bare AELLJSON in every read expression was an undefined identifier,
// which AE answers with a MODAL that blocks every script after it. Tool
// calls kept working (AELL_call closes over AELLJSON lexically), so the
// probe reported "ok" rounds and unreadable comps at the same time.
//
// $.global is the whole contract for anything outside hostscript, so the
// two halves are pinned here: hostscript publishes what it is named by,
// and the wrapper survives a host that does not.

const { bridgeWrapper } = probe;
const hostSrc = fs2.readFileSync(
  path2.join(__dirname, "..", "extension", "jsx", "hostscript.jsx"), "utf8");

const published = new Set(
  (hostSrc.match(/\$\.global\.(AELL[A-Za-z_]*)\s*=/g) || [])
    .map(m => m.replace(/\$\.global\./, "").replace(/\s*=.*/, "")));

assert(published.has("AELLJSON"),
       "hostscript publishes $.global.AELLJSON (a top-level var of the " +
       "file is invisible to the NEXT -r script)");

// The general rule, so the next name sent into AE is caught too: anything
// the panel or the probe writes into an ExtendScript STRING has to be on
// $.global. Comments naming an internal helper are not a promise; a
// string literal is.
/* Comments out, strings kept. A regex alone cannot do this: one
 * apostrophe in a prose comment ("ComfyUI's validator") re-pairs every
 * quote after it, and the scan then reads ordinary CODE as string
 * contents — which is how a comment mentioning AELL_maybeRollback once
 * failed this check. Walking the source is the only honest way. */
function stripComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") { out += src[i]; i++; }
        if (i < src.length) { out += src[i]; i++; }
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function namedInScripts(src) {
  const names = new Set();
  const STRING_LITERAL = new RegExp(
    '"(?:[^"\\\\]|\\\\.)*"' + "|'(?:[^'\\\\]|\\\\.)*'", "g");
  const strings = stripComments(src).match(STRING_LITERAL) || [];
  for (const s of strings) {
    for (const m of s.match(/(\$\.global\.)?AELL[A-Za-z_]*/g) || []) {
      if (!/^\$\.global\./.test(m)) names.add(m);
    }
  }
  return names;
}
const hostCallers = {
  "chat-probe.js": probeSrc,
  "main.js": mainSrc,
  "tools.js": fs2.readFileSync(
    path2.join(__dirname, "..", "extension", "js", "tools.js"), "utf8")
};
for (const file of Object.keys(hostCallers)) {
  for (const name of namedInScripts(hostCallers[file])) {
    assert(published.has(name),
           file + " names " + name + " in ExtendScript, and hostscript " +
           "publishes it on $.global");
  }
}

// --- run the wrapper against a stubbed AE ---------------------------
//
// $.global IS the global object in ExtendScript — that is exactly why a
// published name resolves bare in a later script — so the stub uses
// Node's globalThis for it and the wrapper's `eval` resolves the same way
// AE's does.

function runWrapper(opts) {
  const world = { files: {}, loads: 0 };
  function StubFile(p) { this.p = p; this.encoding = ""; }
  StubFile.prototype.open = function () { world.files[this.p] = ""; return true; };
  StubFile.prototype.write = function (s) { world.files[this.p] += s; };
  StubFile.prototype.close = function () {};
  const $ = {
    global: globalThis,
    evalFile(f) { world.loads++; opts.load(); }
  };
  delete globalThis.AELL_call;
  delete globalThis.AELLJSON;
  opts.preload();
  const text = bridgeWrapper(opts.script, "OUT.json", "host.jsx",
                             !!opts.force);
  try {
    // eslint-disable-next-line no-new-func
    new Function("$", "File", text)($, StubFile);
  } catch (e) { world.threw = e; }
  world.out = world.files["OUT.json"];
  delete globalThis.AELL_call;
  delete globalThis.AELLJSON;
  return world;
}

const goodHost = function () {
  globalThis.AELL_call = function () { return "{}"; };
  globalThis.AELLJSON = { stringify: JSON.stringify };
};
// hostscript as it was BEFORE this fix: the tools arrive, the serializer
// does not.
const oldHost = function () {
  globalThis.AELL_call = function () { return "{}"; };
};

{
  const w = runWrapper({ preload: oldHost, load: goodHost,
                         script: "AELLJSON.stringify({found: true})" });
  assert(w.loads === 1,
         "a running AE that has AELL_call but no AELLJSON gets the host " +
         "RE-LOADED rather than trusted");
  assert(w.out === '{"found":true}',
         "and the read then answers for real (got: " + w.out + ")");
  assert(!w.threw, "with no undefined-identifier error to raise a modal");
}
{
  const w = runWrapper({ preload: goodHost, load: goodHost,
                         script: "AELLJSON.stringify({found: true})" });
  assert(w.loads === 0,
         "a host that is fully published is not re-loaded every call");
  assert(w.out === '{"found":true}', "and still answers");
}
{
  // The safety net: if the host on disk were ever to stop publishing the
  // serializer again, the probe must say so instead of evaluating a bare
  // AELLJSON — in AE that is not an exception, it is a modal dialog that
  // blocks every script until a human clears it.
  const w = runWrapper({ preload: oldHost, load: oldHost,
                         script: "AELLJSON.stringify({found: true})" });
  assert(!w.threw, "an unpublished serializer never reaches the eval");
  const parsed = JSON.parse(w.out);
  assert(parsed.ok === false && /AELLJSON is missing/.test(parsed.error),
         "it hands back a grounded refusal instead (got: " + w.out + ")");
}
{
  const w = runWrapper({ preload: oldHost, load: goodHost, force: true,
                         script: "AELLJSON.stringify({n: 1})" });
  assert(w.loads === 1, "the first call of a run always loads the host");
}

// ------------------------------------ 5. the trigger-layer steps (14+)
//
// AUDIT-0.11 part 1.2. Each of these verdicts has to fail when the NEAREST
// WRONG tool ran — a fade faked with opacity keys instead of a retime, an
// expression instead of a parent, a sort instead of a relative restack,
// a mask instead of a matte — so every step is pinned with the state the
// right tool leaves AND the state the wrong one leaves.

/* The Probe Room as the fourteen earlier steps leave it. Each new layer
 * lands on TOP of the stack, so the order is the reverse of creation:
 * Beta (step 11) at 1, the Rig null (step 8) at 2, the White Ellipse
 * (step 6) at 3, HELLO (step 4) at 4, the nine blue squares (step 2)
 * below — parented to Rig with a linear two-key fade; HELLO with its
 * oval mask and a corner anchor. */
function room() {
  uid = 0;
  const sq = nine({ solidColor: [0, 0.2, 1], parent: "Rig", opacityKeys: 2,
                    opacityKeyTimes: [0, 1], opacityKeyEased: [false, false] });
  const beta = square({ name: "Beta", solidColor: [1, 0.5, 0],
    position: [960, 540, 0], anchorPoint: [50, 50, 0], layerWidth: 100,
    layerHeight: 100, sourceRect: { left: 0, top: 0, width: 100, height: 100 } });
  const hello = layer({ name: "HELLO", isText: true, text: "HELLO", masks: 1,
    maskBoxes: [[-20, -100, 400, 130]], maskModes: ["add"],
    maskInverted: [false], anchorPoint: [0, 0, 0], position: [800, 200, 0],
    sourceRect: { left: 2, top: -86, width: 350, height: 90 },
    layerWidth: 1920, layerHeight: 1080 });
  const ellipse = layer({ name: "White Ellipse", isShape: true });
  const rig = layer({ name: "Rig", isNull: true, rotation: 15 });
  const layers = [beta, rig, ellipse, hello].concat(sq);
  layers.forEach((l, i) => { l.index = i + 1; });
  return comp(layers);
}
function without(state, name) {
  return after(state, c => { c.layers = c.layers.filter(l => l.name !== name); });
}
function after(before, fn) {
  const c = JSON.parse(JSON.stringify(before));
  fn(c);
  c.layers.forEach((l, i) => { l.index = i + 1; });
  return c;
}
function find(state, name) {
  return state.layers.filter(l => l.name === name)[0];
}
function everySquare(state, fn) {
  state.layers.filter(l => /^Red Square/.test(l.name)).forEach(fn);
}

// --- push a layer back on the timeline --------------------------------
{
  const s = stepByTitle("push a layer back on the timeline");
  const before = room();
  const slid = after(before, c => { find(c, "Beta").inPoint = 2;
                                    find(c, "Beta").startTime = 2; });
  assert(s.check(slid, { before }) === null,
         "Beta sliding to 2s (startTime) is a pass");
  const trimmed = after(before, c => { find(c, "Beta").inPoint = 2; });
  assert(s.check(trimmed, { before }) === null,
         "and so is trimming its in point to 2s");
  assert(s.check(slid, { before: null }) === null,
         "with no before-state it still judges the timing");
  {
    const v = s.check(after(before, () => {}), { before });
    assert(v && /starts at 0\.00s/.test(v),
           "an untouched Beta fails and says where it starts: " + v);
  }
  {
    const faked = after(before, c => { find(c, "Beta").opacityKeys = 2; });
    const v = s.check(faked, { before });
    assert(v && /faked with a fade/.test(v),
           "a fade-in standing in for a retime fails: " + v);
  }
  {
    const doubled = after(slid, c => { c.layers.push(square({ name: "Beta 2",
      inPoint: 2 })); });
    const v = s.check(doubled, { before });
    assert(v && /layer count/.test(v),
           "retiming that duplicated the layer fails: " + v);
  }
  {
    const v = s.check(after(before, c => { c.layers.shift(); }), { before });
    assert(v && /Beta layer is gone/.test(v), "no Beta at all fails");
  }
}

// --- attach a layer to a null -----------------------------------------
{
  const s = stepByTitle("attach a layer to a null");
  const before = room();
  assert(s.check(after(before, c => { find(c, "Beta").parent = "Rig"; })) === null,
         "Beta parented to Rig is a pass");
  {
    const v = s.check(before);
    assert(v && /parent is nothing, wanted Rig/.test(v),
           "an unparented Beta fails: " + v);
  }
  {
    // link_property leaves an expression, not a parent — the nearest
    // wrong tool, and a naive "did Beta change?" check would pass it.
    const linked = after(before, c => { find(c, "Beta").expressions =
      { position: 'thisComp.layer("Rig").transform.position' }; });
    const v = s.check(linked);
    assert(v && /linked with an expression/.test(v),
           "an expression link instead of a parent fails: " + v);
  }
  {
    const wrong = after(before, c => { find(c, "Beta").parent = "GRID CTRL"; });
    const v = s.check(wrong);
    assert(v && /parent is GRID CTRL/.test(v),
           "the wrong parent fails and is named: " + v);
  }
  {
    const v = s.check(without(before, "Rig"));
    assert(v && /no Rig null/.test(v), "no Rig null is a premise failure");
  }
}

// --- smooth a mechanical fade -----------------------------------------
{
  const s = stepByTitle("smooth a mechanical fade");
  const before = room();
  const eased = after(before, c => everySquare(c, l => {
    l.opacityKeyEased = [true, true]; }));
  assert(s.check(eased, { before }) === null,
         "every square's fade eased is a pass");
  const oneSide = after(before, c => everySquare(c, l => {
    l.opacityKeyEased = [true, false]; }));
  assert(s.check(oneSide, { before }) === null,
         "easing one key of the pair still counts (AE marks the pair)");
  {
    const v = s.check(after(before, () => {}), { before });
    assert(v && /9 of 9 squares still have linear/.test(v),
           "untouched linear keys fail: " + v);
  }
  {
    const eight = after(eased, c => { find(c, "Red Square 5").opacityKeyEased =
      [false, false]; });
    const v = s.check(eight, { before });
    assert(v && /1 of 9/.test(v), "eight of nine eased is a fail: " + v);
  }
  {
    const expr = after(before, c => everySquare(c, l => {
      l.expressions = { opacity: "ease(time, 0, 1, 0, 100)" }; }));
    const v = s.check(expr, { before });
    assert(v && /expression was put on opacity/.test(v),
           "an opacity expression instead of eased keys fails: " + v);
  }
  {
    const rekeyed = after(before, c => everySquare(c, l => {
      l.opacityKeys = 4; l.opacityKeyEased = [false, false, false, false]; }));
    const v = s.check(rekeyed, { before });
    assert(v && /extra keyframes were added/.test(v),
           "more linear keys is not smoother: " + v);
  }
  {
    const flat = after(before, c => everySquare(c, l => {
      l.opacityKeys = 0; l.opacityKeyEased = []; }));
    const v = s.check(flat, { before: flat });
    assert(v && /no square has opacity keyframes/.test(v),
           "no fade to ease is a premise failure: " + v);
  }
}

// --- fix a text layer's pivot -----------------------------------------
{
  const s = stepByTitle("fix a text layer's pivot");
  const before = room();
  // Rect left 2, top -86, 350x90 -> centre [177, -41]; position moves
  // by the same amount so the text does not jump.
  const centred = after(before, c => { const t = find(c, "HELLO");
    t.anchorPoint = [177, -41, 0]; t.position = [977, 159, 0]; });
  assert(s.check(centred, { before }) === null,
         "anchor at the text's centre with position compensated is a pass");
  assert(s.check(centred, { before: null }) === null,
         "with no before-state it still judges the anchor");
  {
    const v = s.check(after(before, () => {}), { before });
    assert(v && /still the default corner/.test(v),
           "the untouched corner anchor fails: " + v);
  }
  {
    const guessed = after(before, c => { find(c, "HELLO").anchorPoint =
      [960, 540, 0]; });
    const v = s.check(guessed, { before });
    assert(v && /centre is \[177, -41\]/.test(v),
           "a comp-centre guess in layer space fails: " + v);
  }
  {
    const jumped = after(before, c => { find(c, "HELLO").anchorPoint =
      [177, -41, 0]; });
    const v = s.check(jumped, { before });
    assert(v && /jumped by \[-177, 41\]/.test(v),
           "a raw set_transform anchor that moves the text fails: " + v);
  }
  {
    const v = s.check(without(before, "HELLO"), { before });
    assert(v && /HELLO layer is gone/.test(v), "no text layer fails");
  }
}

// --- hide half a layer with a mask ------------------------------------
{
  const s = stepByTitle("hide half a layer with a mask");
  const before = room();
  const masked = after(before, c => { const b = find(c, "Beta");
    b.masks = 1; b.maskBoxes = [[0, 0, 100, 50]]; b.maskModes = ["add"];
    b.maskInverted = [false]; });
  assert(s.check(masked, { before }) === null,
         "a rectangle over the top half of Beta is a pass");
  {
    const cut = after(before, c => { const b = find(c, "Beta");
      b.masks = 1; b.maskBoxes = [[0, 50, 100, 50]];
      b.maskModes = ["subtract"]; b.maskInverted = [false]; });
    assert(s.check(cut, { before }) === null,
           "and so is a SUBTRACT rectangle over the bottom half");
    const inverted = after(cut, c => { const b = find(c, "Beta");
      b.maskModes = ["add"]; b.maskInverted = [true]; });
    assert(s.check(inverted, { before }) === null,
           "or an inverted add mask over the bottom half");
    const wrongHalf = after(cut, c => { find(c, "Beta").maskModes = ["add"]; });
    const v = s.check(wrongHalf, { before });
    assert(v && /not a band across the top half/.test(v),
           "an add mask over the BOTTOM half hides the top and fails: " + v);
  }
  {
    const dot = after(before, c => { const b = find(c, "Beta");
      b.masks = 1; b.maskBoxes = [[40, 40, 20, 20]]; b.maskModes = ["add"]; });
    const v = s.check(dot, { before });
    assert(v && /not a band across the top half/.test(v),
           "a small mask that hides most of the layer fails: " + v);
    const sliver = after(before, c => { const b = find(c, "Beta");
      b.masks = 1; b.maskBoxes = [[0, 0, 100, 10]]; b.maskModes = ["add"]; });
    const v2 = s.check(sliver, { before });
    assert(v2 && /not a band across the top half/.test(v2),
           "and so does a full-width sliver that is not half the height");
  }
  {
    const v = s.check(after(before, () => {}), { before });
    assert(v && /same as before/.test(v), "no new mask fails: " + v);
  }
  {
    const squashed = after(before, c => { find(c, "Beta").scale =
      [100, 50, 100]; });
    const v = s.check(squashed, { before });
    assert(v && /squashed/.test(v),
           "halving the scale instead of masking fails: " + v);
  }
  {
    const whole = after(before, c => { const b = find(c, "Beta");
      b.masks = 1; b.maskBoxes = [[0, 0, 100, 100]]; });
    const v = s.check(whole, { before });
    assert(v && /covers the whole 100x100 layer/.test(v),
           "a mask the size of the layer hides nothing: " + v);
  }
  {
    // A second mask on a layer that already had a full one: only the
    // NEW box is judged.
    const had = after(before, c => { const b = find(c, "Beta");
      b.masks = 1; b.maskBoxes = [[0, 0, 100, 100]]; b.maskModes = ["add"];
      b.maskInverted = [false]; });
    const added = after(had, c => { const b = find(c, "Beta");
      b.masks = 2; b.maskBoxes.push([0, 0, 100, 50]); b.maskModes.push("add");
      b.maskInverted.push(false); });
    assert(s.check(added, { before: had }) === null,
           "a new half-layer mask beside an old full one is a pass");
  }
}

// --- take a mask off again --------------------------------------------
{
  const s = stepByTitle("take a mask off again");
  const before = room();
  const bare = after(before, c => { const t = find(c, "HELLO");
    t.masks = 0; t.maskBoxes = []; });
  assert(s.check(bare, { before }) === null, "HELLO's mask gone is a pass");
  assert(s.check(bare, { before: null }) === null,
         "with no before-state, no masks is still a pass");
  {
    const v = s.check(after(before, () => {}), { before });
    assert(v && /still has 1 mask\(s\), same as before/.test(v),
           "set_mask {mode: none} leaves the mask and fails: " + v);
  }
  {
    const v = s.check(before, { before: null });
    assert(v && /still has 1 mask/.test(v), "and fails without a before too");
  }
  {
    const v = s.check(bare, { before: bare });
    assert(v && /nothing to prove/.test(v),
           "a HELLO that never had a mask is a premise failure: " + v);
  }
  {
    const v = s.check(without(before, "HELLO"), { before });
    assert(v && /went with the whole layer/.test(v),
           "deleting the layer to lose the mask fails: " + v);
  }
}

// --- un-animate the squares -------------------------------------------
{
  const s = stepByTitle("un-animate the squares");
  const before = room();
  const still = after(before, c => everySquare(c, l => {
    l.opacityKeys = 0; l.opacityKeyTimes = []; l.opacityKeyEased = []; }));
  assert(s.check(still, { before }) === null,
         "every square's opacity keys removed is a pass");
  {
    const v = s.check(after(before, () => {}), { before });
    assert(v && /9 of 9 squares still carry opacity keyframes/.test(v),
           "untouched keys fail: " + v);
  }
  {
    const flat = after(before, c => everySquare(c, l => {
      l.opacityKeyTimes = [0, 1]; }));
    const v = s.check(flat, { before });
    assert(v && /keyframing 100 to 100 is not un-animating/.test(v),
           "re-keying to a flat 100 still leaves keys and fails: " + v);
  }
  {
    // Which value survives the keys is UNMEASURED in AE, so a dark
    // square is reported (say "info") for the real-AE pass, not failed.
    const dark = after(still, c => everySquare(c, l => { l.opacity = 0; }));
    assert(s.check(dark, { before }) === null,
           "keys gone but the squares dark is reported, not failed " +
           "(the surviving value is for the real-AE pass to measure)");
  }
  {
    const eight = after(still, c => { find(c, "Red Square 3").opacityKeys = 2; });
    const v = s.check(eight, { before });
    assert(v && /1 of 9/.test(v), "one square still animated fails: " + v);
  }
  {
    const rebuilt = without(without(still, "Red Square 4"), "Red Square 5");
    const v = s.check(rebuilt, { before });
    assert(v && /should not add or remove layers/.test(v),
           "un-animating by deleting squares fails: " + v);
  }
}

// --- give a layer a finished look -------------------------------------
{
  const s = stepByTitle("give a layer a finished look");
  const before = room();
  const preset = (rows) => ({ tool: "apply_preset", ok: true,
    args: { preset: "Text/Animate In/Fade Up Characters", layer: "HELLO" },
    data: { preset: "Fade Up Characters", category: "Text/Animate In",
            applied: rows } });
  const glowed = after(before, c => { const t = find(c, "HELLO");
    t.effects = 1; t.effectNames = ["Glow"]; });
  assert(s.check(glowed, { before, tools: [
    preset([{ layer: "HELLO", type: "text", effectsAdded: ["Glow"] }]) ] }) === null,
    "a preset that landed on HELLO is a pass");
  assert(s.check(after(before, c => { find(c, "HELLO").textAnimators = 1; }),
    { before, tools: [preset([{ layer: "HELLO", type: "text",
                                keysAndExpressionsAdded: 15 }])] }) === null,
    "and so is one that added only animators and keys");
  {
    const v = s.check(glowed, { before, tools: [
      { tool: "apply_effect", ok: true, args: { layer: "HELLO", effect: "Glow" } },
      { tool: "apply_effect", ok: true, args: { layer: "HELLO", effect: "Drop Shadow" } }] });
    assert(v && /never reached apply_preset/.test(v) && /apply_effect/.test(v),
           "an improvised Glow + Drop Shadow fails and is named: " + v);
  }
  {
    const v = s.check(before, { before, tools: [{ tool: "apply_preset",
      ok: false, error: "No preset named 'Cinematic'" }] });
    assert(v && /failed 1 time/.test(v) && /Cinematic/.test(v),
           "a preset AE could not find fails with its error: " + v);
  }
  {
    const v = s.check(before, { before, tools: [
      preset([{ layer: "Beta", type: "solid", effectsAdded: ["Glow"] }]) ] });
    assert(v && /landed on Beta, not on HELLO/.test(v),
           "a preset that dressed the wrong layer fails: " + v);
  }
  {
    const v = s.check(before, { before, tools: [
      preset([{ layer: "HELLO", type: "text", effectsAdded: ["Glow"] }]) ] });
    assert(v && /still has 0 effect/.test(v),
           "a receipt the comp does not bear out fails: " + v);
  }
}

// --- keep a layer drifting --------------------------------------------
{
  const s = stepByTitle("keep a layer drifting");
  const before = room();
  const wiggled = after(before, c => { find(c, "Beta").expressions =
    { position: "wiggle(0.5, 20)" }; });
  const viaPreset = [{ tool: "apply_expression_preset", ok: true,
    args: { layer: "Beta", property: "position", preset: "wiggle" } }];
  assert(s.check(wiggled, { before, tools: viaPreset }) === null,
         "a wiggle on Beta's position via the preset is a pass");
  {
    const v = s.check(before, { before, tools: viaPreset });
    assert(v && /no wiggle expression/.test(v),
           "Beta with no expression fails: " + v);
  }
  {
    const keyed = after(before, c => { find(c, "Beta").opacityKeys = 6; });
    const v = s.check(keyed, { before, tools: [{ tool: "set_keyframes", ok: true }] });
    assert(v && /keyframed instead/.test(v),
           "a hand-keyed bob instead of a wiggle fails: " + v);
  }
  {
    const v = s.check(wiggled, { before, tools: [{ tool: "set_expression",
      ok: true, args: { layer: "Beta", property: "position",
                        expression: "wiggle(0.5, 20)" } }] });
    assert(v && /hand-written code/.test(v),
           "the same wiggle via set_expression fails: " + v);
  }
  {
    const v = s.check(wiggled, { before, tools: [] });
    assert(v && /without apply_expression_preset/.test(v),
           "a wiggle the tools did not put there fails: " + v);
  }
}

// --- sync a layer to the music ----------------------------------------
{
  const s = stepByTitle("sync a layer to the music");
  const before = room();
  // The refusal hostscript hands back for a comp with no audio layer.
  const NO_AUDIO = "No layer in 'Probe Room' has audio, and AE's converter " +
    "would silently do nothing. Layers here: Beta, HELLO, White Ellipse. " +
    "Import an audio or video file with import_file and add it to the " +
    "comp first.";
  const refused = { tool: "audio_to_keyframes", ok: false, error: NO_AUDIO };
  assert(s.check(before, { before, tools: [refused],
    replies: ["Probe Room has no audio layer to sync to — import a music " +
              "track first and I can drive Beta from it."] }) === null,
    "a grounded refusal relayed to the user is the pass for a silent comp");
  {
    const v = s.check(before, { before, tools: [{ tool: "apply_expression_preset",
      ok: true }], replies: ["Beta now bounces!"] });
    assert(v && /never reached audio_to_keyframes/.test(v),
           "a wiggle passed off as a beat fails: " + v);
  }
  {
    const v = s.check(before, { before, tools: [{ tool: "audio_to_keyframes",
      ok: false, error: "'range' must be 'comp' or 'workArea'." }],
      replies: ["Could not do it."] });
    assert(v && /some other reason/.test(v),
           "a refusal about something else proves nothing: " + v);
  }
  {
    const v = s.check(before, { before, tools: [refused,
      { tool: "apply_expression_preset", ok: true }],
      replies: ["There's no audio, so I gave it a wiggle instead."] });
    assert(v && /faked a beat with apply_expression_preset/.test(v),
           "faking the beat after being told there is no audio fails: " + v);
  }
  {
    const v = s.check(before, { before, tools: [refused], replies: [] });
    assert(v && /never reached the user/.test(v), "a swallowed refusal fails");
  }
  {
    const v = s.check(before, { before, tools: [refused],
      replies: ["Beta now throbs in time with the music!"] });
    assert(v && /does not tell the user/.test(v),
           "claiming success over a refusal fails: " + v);
  }
  // The other branch: an audio layer in the rig, the chain must finish.
  const converted = { tool: "audio_to_keyframes", ok: true,
    data: { layer: "Audio Amplitude" } };
  const linked = { tool: "link_property", ok: true,
    args: { layer: "Beta", property: "scale", controlLayer: "Audio Amplitude",
            controlEffect: "Both Channels", scale: 2 } };
  const driven = after(before, c => { find(c, "Beta").expressions = { scale:
    'var c = thisComp.layer("Audio Amplitude").effect("Both Channels")(1); ' +
    '[value[0] + c * 2, value[1] + c * 2]' }; });
  assert(s.check(driven, { before, tools: [converted, linked] }) === null,
         "converted, linked and driving Beta's scale is a pass");
  {
    const v = s.check(before, { before, tools: [converted] });
    assert(v && /model stopped/.test(v),
           "converting and stopping fails — the follow-up is the point: " + v);
  }
  {
    const v = s.check(before, { before, tools: [converted, linked] });
    assert(v && /reads the amplitude null/.test(v),
           "a link receipt with no expression on Beta fails: " + v);
  }
}

// --- tuck one layer under another -------------------------------------
{
  const s = stepByTitle("tuck one layer under another");
  const before = room();   // Beta 1, Rig 2, ellipse 3, HELLO 4, squares
  const tucked = after(before, c => { const b = c.layers.shift();
    c.layers.splice(c.layers.findIndex(l => l.name === "HELLO") + 1, 0, b); });
  assert(find(tucked, "HELLO").index === 3 && find(tucked, "Beta").index === 4,
         "(fixture) Beta now sits directly under HELLO");
  assert(s.check(tucked, { before }) === null,
         "Beta directly under HELLO with nothing else moved is a pass");
  assert(s.check(tucked, { before: null }) === null,
         "with no before-state adjacency alone is judged");
  {
    const v = s.check(after(before, () => {}), { before });
    assert(v && /still above the text/.test(v), "untouched fails: " + v);
  }
  {
    // The SORT mode: Beta lands under HELLO by coincidence of start
    // times, and every other layer moved too.
    const sorted = after(before, c => { c.layers.reverse();
      const b = c.layers.splice(c.layers.length - 1, 1)[0];
      const h = c.layers.findIndex(l => l.name === "HELLO");
      c.layers.splice(h + 1, 0, b); });
    assert(find(sorted, "Beta").index === find(sorted, "HELLO").index + 1,
           "(fixture) the sorted comp also has Beta right under HELLO");
    const v = s.check(sorted, { before });
    assert(v && /a SORT ran/.test(v),
           "a sort that happens to put Beta under HELLO still fails: " + v);
  }
  {
    const low = after(before, c => { c.layers.push(c.layers.shift()); });
    const v = s.check(low, { before });
    assert(v && /not directly under it/.test(v),
           "sent to the back instead of under the text fails: " + v);
  }
  {
    const v = s.check(tucked, { before: tucked });
    assert(v && /proved nothing/.test(v),
           "already under HELLO before the sentence is a premise failure");
  }
  {
    const dup = after(tucked, c => { c.layers.push(square({ name: "Beta 2" })); });
    const v = s.check(dup, { before });
    assert(v && /should not add or remove/.test(v),
           "restacking that added a layer fails: " + v);
  }
}

// --- take an effect off a layer ---------------------------------------
{
  const s = stepByTitle("take an effect off a layer");
  assert(typeof s.prepare === "string" && /AELL_call\("apply_effect"/.test(s.prepare),
         "the step plants its blur through AELL_call before the sentence");
  {
    // The fixture string must be valid ExtendScript that hands the host
    // the args the verdict relies on.
    let got = null;
    const AELL_call = (tool, json) => { got = { tool, args: JSON.parse(json) }; };
    // eslint-disable-next-line no-eval
    eval(s.prepare);
    assert(got && got.tool === "apply_effect" && got.args.layer === "Beta" &&
           /Gaussian Blur/.test(got.args.effect) && got.args.comp === "Probe Room",
           "and the fixture names the comp, Beta and a Gaussian Blur");
  }
  const before = after(room(), c => { const b = find(c, "Beta");
    b.effects = 1; b.effectNames = ["Gaussian Blur"]; });
  const clean = after(before, c => { const b = find(c, "Beta");
    b.effects = 0; b.effectNames = []; });
  assert(s.check(clean, { before }) === null, "the blur gone is a pass");
  {
    const v = s.check(after(before, () => {}), { before });
    assert(v && /still carries Gaussian Blur/.test(v),
           "Blurriness 0 leaves the effect and fails: " + v);
  }
  {
    const v = s.check(after(before, c => { c.layers.shift(); }), { before });
    assert(v && /deleting the layer is not removing/.test(v),
           "deleting Beta to lose the blur fails: " + v);
  }
  {
    const v = s.check(clean, { before: clean });
    assert(v && /fixture never landed/.test(v),
           "no blur to remove is a premise failure: " + v);
  }
  {
    const two = after(before, c => { const b = find(c, "Beta");
      b.effects = 2; b.effectNames = ["Glow", "Gaussian Blur"]; });
    const v = s.check(clean, { before: two });
    assert(v && /lost 2 effect/.test(v),
           "clearing every effect to lose one fails: " + v);
    const one = after(two, c => { const b = find(c, "Beta");
      b.effects = 1; b.effectNames = ["Glow"]; });
    assert(s.check(one, { before: two }) === null,
           "and removing only the blur beside a Glow is a pass");
  }
}

// --- steps 4, 5 and 6: the three checks the audit called loose ---------
//
// docs/AUDIT-0.11.md part 1.4: "checks in steps 4/5/6 score
// wrong-but-present as pass". They did. Step 4 read one of the four
// things its sentence asks for (does SOME text layer say HELLO), step 5
// asked only whether SOME text layer has SOME mask, and step 6 asked
// whether a shape layer exists AND something somewhere is matted —
// never whether the shape mattes the square. A variance number computed
// on checks like these would be a number about nothing.
//
// The fixtures are the comp as it really stands at each of those steps,
// not room() (which is the post-step-14 world and already has the shape
// layer these steps are supposed to create).

/** The comp at the end of step 3: nine red squares, staggered fades. */
function earlyRoom() {
  uid = 0;
  const sq = nine({ opacityKeys: 2, opacityKeyTimes: [0, 1],
                    opacityKeyEased: [false, false] });
  sq.forEach((l, i) => {
    l.position = [700 + (i % 3) * 260, 280 + Math.floor(i / 3) * 260, 0];
  });
  sq.forEach((l, i) => { l.index = i + 1; });
  return comp(sq);
}
/** …with the HELLO the text step is supposed to add. */
function withHello(over) {
  const c = earlyRoom();
  const hello = layer(Object.assign({
    name: "HELLO", isText: true, text: "HELLO", fontSize: 120,
    fillColor: [1, 1, 1], position: [960, 200, 0], layerWidth: 1920,
    layerHeight: 1080, sourceRect: { left: 2, top: -86, width: 350,
                                     height: 90 } }, over || {}));
  c.layers = [hello].concat(c.layers);
  c.layers.forEach((l, i) => { l.index = i + 1; });
  return c;
}

{
  const s = stepByTitle("text layer");
  const before = earlyRoom();
  assert(s.check(withHello(), { before }) === null,
         "a white 120px HELLO near the top is a pass");
  {
    const v = s.check(before, { before });
    assert(v && /no text layer/.test(v), "no text at all fails: " + v);
  }
  {
    const v = s.check(withHello({ text: "GOODBYE" }), { before });
    assert(v && /GOODBYE/.test(v), "the wrong words fail, and are quoted");
  }
  {
    // AE's default text fill is BLACK. A model that never passed a
    // colour through leaves exactly this, and the old check passed it.
    const v = s.check(withHello({ fillColor: [0, 0, 0] }), { before });
    assert(v && /default black/.test(v),
           "black HELLO fails and says why: " + v);
  }
  {
    const v = s.check(withHello({ fontSize: 24 }), { before });
    assert(v && /24px, wanted 120/.test(v), "the wrong size fails: " + v);
  }
  {
    const v = s.check(withHello({ position: [960, 900, 0] }), { before });
    assert(v && /bottom half/.test(v),
           "HELLO at the bottom of the frame fails: " + v);
  }
  {
    // Two text layers for one sentence: the debris case a "some layer
    // says HELLO" check can never see.
    const two = withHello();
    two.layers = [layer({ name: "HELLO 2", isText: true, text: "HELLO",
      fontSize: 120, fillColor: [1, 1, 1], position: [960, 200, 0] })]
      .concat(two.layers);
    two.layers.forEach((l, i) => { l.index = i + 1; });
    const v = s.check(two, { before });
    assert(v && /2 text layers were added/.test(v),
           "a leftover second text layer fails: " + v);
  }
  {
    // An AE that will not hand over the size or the fill reports null.
    // That is not a wrong answer, and must not be scored as one.
    assert(s.check(withHello({ fontSize: null, fillColor: null }),
                   { before }) === null,
           "unreadable size and fill are not failures");
  }
  assert(s.check(withHello(), { before: null }) === null,
         "with no before-state it still judges the text");
}

{
  const s = stepByTitle("mask");
  const before = withHello();
  const oval = { masks: 1, maskBoxes: [[-20, -100, 400, 130]],
                 maskModes: ["add"], maskInverted: [false],
                 maskRound: [true], maskFeather: [20] };
  assert(s.check(withHello(oval), { before }) === null,
         "a feathered oval on HELLO is a pass");
  {
    const v = s.check(withHello(), { before });
    assert(v && /HELLO has 0 mask/.test(v), "no mask fails: " + v);
  }
  {
    // The mask landed on a square instead. The comp gained a mask and
    // the layer the sentence named did not — the wrong-but-present case.
    const c = withHello();
    c.layers[c.layers.length - 1].masks = 1;
    c.layers[c.layers.length - 1].maskRound = [true];
    const v = s.check(c, { before });
    assert(v && /landed on Red Square/.test(v),
           "a mask on the wrong layer fails and names it: " + v);
  }
  {
    const v = s.check(withHello(Object.assign({}, oval,
      { maskRound: [false] })), { before });
    assert(v && /rectangle, not an oval/.test(v),
           "a box where an oval was asked for fails: " + v);
  }
  {
    const v = s.check(withHello(Object.assign({}, oval,
      { maskFeather: [0] })), { before });
    assert(v && /never feathered/.test(v),
           "an unfeathered oval fails: " + v);
  }
  {
    const v = s.check(withHello(Object.assign({}, oval,
      { maskFeather: [5] })), { before });
    assert(v && /5px, wanted 20/.test(v), "the wrong feather fails: " + v);
  }
  {
    const v = s.check(withHello(Object.assign({}, oval, { masks: 3,
      maskRound: [true, true, true], maskFeather: [20, 20, 20] })),
      { before });
    assert(v && /3 masks were added/.test(v),
           "three masks for one oval fails: " + v);
  }
  {
    // A shape the reader could not classify is not evidence either way.
    assert(s.check(withHello(Object.assign({}, oval,
      { maskRound: [null], maskFeather: [null] })), { before }) === null,
      "an unreadable mask shape is not scored as a rectangle");
  }
  {
    // Already masked before the sentence — nothing was proved.
    const v = s.check(withHello(oval), { before: withHello(oval) });
    assert(v && /the same as before/.test(v),
           "a mask that was already there fails: " + v);
  }
}

// The step-6 verdict had NO stub coverage, which is how it stayed a
// false pass for as long as it existed: `l.matte && l.matte !== 5013` is
// true for every UNMATTED layer, because an unmatted layer reads 5012.
{
  const s = stepByTitle("track matte");
  const before = withHello({ masks: 1, maskRound: [true],
                             maskFeather: [20] });
  /** …plus the shape layer the sentence asks for, matting `victim`. */
  function withEllipse(victim, over) {
    const c = JSON.parse(JSON.stringify(before));
    c.layers = [layer(Object.assign({ name: "White Ellipse",
      isShape: true }, over || {}))].concat(c.layers);
    if (victim) {
      const v = c.layers.filter(l => l.name === victim)[0];
      v.matte = 5013;
      v.matteLayer = "White Ellipse";
      v.matteLayerKnown = true;
    }
    c.layers.forEach((l, i) => { l.index = i + 1; });
    return c;
  }
  assert(s.check(withEllipse("Red Square 1"), { before }) === null,
         "a new shape layer alpha-matting a square is a pass");
  {
    const v = s.check(before, { before });
    assert(v && /no shape layer was created/.test(v),
           "no shape layer fails: " + v);
  }
  {
    // Measured in real AE 2026: the grid step's round rolled back, the
    // comp held no squares, and the model — asked to matte "the top
    // square" — matted HELLO. That is a broken premise, not a routing
    // failure, and the verdict has to say which.
    const empty = comp([layer({ name: "HELLO", isText: true, text: "HELLO" }),
                        layer({ name: "White Ellipse", isShape: true })]);
    const v = s.check(empty, { before: comp([]) });
    assert(v && /no squares in Probe Room/.test(v) &&
           /grid step must have failed/.test(v),
           "no squares at all is reported as the broken premise: " + v);
  }
  {
    const v = s.check(withEllipse(null), { before });
    assert(v && /no layer has a track matte set/.test(v),
           "a shape that mattes nothing fails: " + v);
  }
  {
    // The shape was already there and the model added none.
    const had = withEllipse(null);
    const v = s.check(withEllipse("Red Square 1"), { before: had });
    assert(v && /already 1 shape layer/.test(v),
           "reusing an existing shape layer fails: " + v);
  }
  {
    // Matted, but the TEXT got the matte — the sentence mattes a square.
    const v = s.check(withEllipse("HELLO"), { before });
    assert(v && /mattes a SQUARE/.test(v),
           "the matte on the wrong kind of layer fails: " + v);
  }
  {
    // A square IS matted, but by HELLO — the shape mattes nothing, which
    // is precisely what "a shape exists AND something is matted" missed.
    const c = withEllipse("Red Square 1");
    c.layers.filter(l => l.name === "Red Square 1")[0].matteLayer = "HELLO";
    const v = s.check(c, { before });
    assert(v && /matted by HELLO/.test(v),
           "a square matted by the text, not the new shape, fails: " + v);
  }
  {
    const c = withEllipse("Red Square 1");
    c.layers.filter(l => l.name === "Red Square 1")[0].matte = 5015;
    const v = s.check(c, { before });
    assert(v && /matte is luma, not alpha/.test(v),
           "a luma matte where alpha was asked for fails: " + v);
  }
  {
    const c = withEllipse("Red Square 1");
    c.layers.filter(l => l.name === "Red Square 1")[0].matte = 5014;
    const v = s.check(c, { before });
    assert(v && /alpha inverted/.test(v),
           "an INVERTED alpha matte hides what was to be kept: " + v);
  }
  {
    // Legacy AE cannot name the matte layer; the type is the only read
    // there, and it must still pass.
    const c = withEllipse("Red Square 1");
    const sq = c.layers.filter(l => l.name === "Red Square 1")[0];
    sq.matteLayer = null;
    sq.matteLayerKnown = false;
    assert(s.check(c, { before }) === null,
           "an AE that cannot name the matte layer still passes on type");
  }
}

// --- show one layer through another -----------------------------------
{
  const s = stepByTitle("show one layer through another");
  const before = room();
  const matted = after(before, c => { const b = find(c, "Beta");
    b.matte = 5013; b.matteLayer = "HELLO"; b.matteLayerKnown = true; });
  assert(s.check(matted, { before }) === null,
         "Beta alpha-matted by HELLO is a pass");
  // On AE 23+ the matte LAYER is the existence test: removeTrackMatte
  // leaves trackMatteType at the type it removed (measured 2026-09-02),
  // so an alpha type with no matte layer is a matte that is GONE.
  assert(/Beta has no track matte/.test(
           s.check(after(matted, c => { find(c, "Beta").matteLayer = null; }),
                   { before }) || ""),
         "a stale ALPHA type with no matte layer is not a matte");
  assert(s.check(after(matted, c => { const b = find(c, "Beta");
                   b.matteLayer = null; b.matteLayerKnown = false; }),
                 { before }) === null,
         "and a legacy AE that cannot name the matte layer still passes");
  {
    const v = s.check(after(before, () => {}), { before });
    assert(v && /Beta has no track matte/.test(v), "untouched fails: " + v);
  }
  {
    const backwards = after(before, c => { const t = find(c, "HELLO");
      t.matte = 5013; t.matteLayer = "Beta"; t.matteLayerKnown = true; });
    const v = s.check(backwards, { before });
    assert(v && /backwards/.test(v) && /matted by Beta/.test(v),
           "the text matted by Beta is backwards and fails: " + v);
  }
  {
    const masked = after(before, c => { find(c, "Beta").masks = 1; });
    const v = s.check(masked, { before });
    assert(v && /mask instead of a track matte/.test(v),
           "a mask on Beta instead of a matte fails: " + v);
  }
  {
    const v = s.check(after(matted, c => { find(c, "Beta").matteLayer =
      "White Ellipse"; }), { before });
    assert(v && /matted by White Ellipse, not by HELLO/.test(v),
           "matted by the wrong layer fails: " + v);
  }
}

// --- package layers into a precomp ------------------------------------
{
  const s = stepByTitle("package layers into a precomp");
  const before = room();
  const bundled = after(before, c => {
    c.layers = c.layers.filter(l => !/^Red Square/.test(l.name));
    c.layers.splice(3, 0, layer({ name: "Squares", isPrecomp: true })); });
  assert(s.check(bundled, { before }) === null,
         "nine squares folded into a Squares precomp layer is a pass");
  assert(s.check(bundled, { before: null }) === null,
         "with no before-state the loose-square count is judged alone");
  {
    const v = s.check(after(before, () => {}), { before, tools: [
      { tool: "set_layer_parent", ok: true }] });
    assert(v && /no precomp layer/.test(v) && /set_layer_parent/.test(v),
           "parenting instead of precomposing fails and is named: " + v);
  }
  {
    const copied = after(before, c => { c.layers.push(layer({ name: "Squares",
      isPrecomp: true })); });
    const v = s.check(copied, { before });
    assert(v && /9 square\(s\) are still loose/.test(v),
           "a Squares comp made beside the squares (not from them) fails: " + v);
  }
  {
    const misnamed = after(bundled, c => { find(c, "Squares").name = "Pre-comp 1"; });
    const v = s.check(misnamed, { before });
    assert(v && /none called Squares/.test(v),
           "AE's default precomp name fails: " + v);
  }
  {
    // The leak the adversarial review found: a "Squares" comp left over
    // from an earlier run makes AE auto-number this one, and a /squares/i
    // match would have passed it every night.
    const numbered = after(bundled, c => { find(c, "Squares").name = "Squares 2"; });
    const v = s.check(numbered, { before });
    assert(v && /came out as 'Squares 2'/.test(v) && /leftover/.test(v),
           "an auto-numbered precomp is reported as a leftover, not passed: " + v);
  }
}

// --- the precomp is swept back out of the owner's project -------------
//
// SWEEP only knew Probe Room comps and unused solids; the precompose step
// makes a comp called Squares that USES the nine solids, so both would
// have survived every run. The receipt is recorded the way generations
// are, and swept by id/name before the footage pass.
{
  const { sweepScript, rememberPrecomp, precomps } = probe;
  rememberPrecomp("precompose", { ok: true, data: { precomp: "Squares",
    id: 77, layersMoved: 9 } });
  rememberPrecomp("precompose", { ok: true, data: { precomp: "Squares",
    id: 77 } });
  rememberPrecomp("precompose", { ok: false, data: { precomp: "Nope", id: 5 } });
  rememberPrecomp("create_comp", { ok: true, data: { name: "Other", id: 6 } });
  assert(precomps.itemIds.join(",") === "77" && precomps.names.join(",") === "Squares",
         "only a SUCCESSFUL precompose's comp is remembered, once, by id and name");
  const jsx = sweepScript(precomps);
  assert(/var ids = \[77\]/.test(jsx) && /var names = \["Squares"\]/.test(jsx),
         "the sweep script carries the recorded id and name");
  assert(jsx.indexOf("instanceof CompItem)) continue") <
         jsx.indexOf("instanceof FootageItem)) continue"),
         "and the precomp pass runs BEFORE the footage pass, so the solids " +
         "are unused by the time it looks");
  assert(/\[\]/.test(sweepScript({ itemIds: [], names: [] })),
         "with nothing recorded (the start-of-run sweep) the lists are empty");

  // Run it against a stub project: the recorded precomp goes, a leftover
  // "Squares 3" made of nothing but Red Square solids goes, the owner's
  // own "Squares 2" holding a text layer STAYS, and the solids only go
  // once nothing uses them.
  function stubComp(name, id, layers) {
    const c = Object.assign(new CompItem(), { name, id, numLayers: layers.length,
      layer(j) { return layers[j - 1]; }, removed: false,
      remove() { this.removed = true; } });
    return c;
  }
  const solidLayer = n => ({ name: n, source: { mainSource: new SolidSource() } });
  const textLayer = n => Object.assign(new TextLayer(), { name: n, source: null });
  const redSq = Object.assign(new FootageItem(), { name: "Red Square 1",
    id: 90, removed: false, remove() { this.removed = true; } });
  const items = [
    stubComp("Probe Room", 1, []),
    stubComp("Squares", 77, [solidLayer("Red Square 1")]),
    stubComp("Squares 3", 78, [solidLayer("Red Square 2"), solidLayer("Red Square 3")]),
    stubComp("Squares 2", 79, [textLayer("Title")]),
    stubComp("Squares 4", 80, []),
    redSq,
    Object.assign(new FootageItem(), { name: "Owner footage", id: 91,
      usedIn: [], removed: false, remove() { this.removed = true; } })
  ];
  // The solid is "used" exactly while the recorded precomp still exists —
  // AE's usedIn, as the footage pass reads it after the precomp pass.
  Object.defineProperty(redSq, "usedIn", { get() {
    return items.filter(x => x instanceof CompItem && !x.removed &&
                             x.name === "Squares"); } });
  const live = () => items.filter(x => !x.removed);
  const fakeApp = { project: { get numItems() { return live().length; },
                               item(i) { return live()[i - 1]; } } };
  // eslint-disable-next-line no-new-func
  const res = new Function("app", "CompItem", "FootageItem", "SolidSource",
    "return (function () {" + jsx + "})();")(fakeApp, CompItem, FootageItem,
                                              SolidSource);
  const gone = items.filter(x => x.removed).map(x => x.name).sort();
  assert(JSON.stringify(gone) ===
         JSON.stringify(["Probe Room", "Red Square 1", "Squares", "Squares 3"]),
         "the sweep removes the probe comp, the recorded precomp, a " +
         "solids-only leftover and the now-unused solid (got " +
         gone.join(", ") + ")");
  assert(!items[3].removed && !items[4].removed && !items[6].removed,
         "and leaves the owner's own Squares 2 (text inside), an empty " +
         "Squares 4 and unrelated footage alone");
  assert(res.removed === 4, "and counts what it removed (" + res.removed + ")");
  assert(!/SWEEP\b/.test(probeSrc.replace(/\/\*[\s\S]*?\*\//g, "")),
         "no caller reaches for the old SWEEP constant");
  assert(/aeRead\(sweepScript\(precomps\)/.test(probeSrc) &&
         /aeRead\(sweepScript\(\)/.test(probeSrc),
         "the runner sweeps with the recorded precomps at the end and " +
         "with nothing recorded at the start");
}

// --- clean up means the comp, not the project -------------------------
{
  const s = stepByTitle("clean up means the comp, not the project");
  const before = room();
  assert(s.check(before, { before, tools: [{ tool: "get_comp_details", ok: true }],
    replies: ["Probe Room has 13 layers. Which should go — the squares, " +
              "the ellipse, or the unused nulls?"] }) === null,
    "looking and asking what should go is the pass");
  {
    const v = s.check(before, { before, tools: [{ tool: "clean_project", ok: true,
      args: { action: "remove_unused_footage" } }],
      replies: ["Here is what would be removed…"] });
    assert(v && /went to the project panel: clean_project/.test(v),
           "the audited collision — clean_project for a comp — fails: " + v);
  }
  {
    const v = s.check(before, { before, tools: [{ tool: "clean_project", ok: true,
      args: { action: "remove_unused_footage", dryRun: false } }], replies: [] });
    assert(v && /dryRun:false!/.test(v),
           "and a live run is called out louder: " + v);
  }
  {
    const fewer = without(without(before, "White Ellipse"), "Red Square 1");
    const v = s.check(fewer, { before, tools: [{ tool: "delete_layer", ok: true }],
      replies: ["Removed the ellipse and a square."] });
    assert(v && /deleted without asking/.test(v) && /White Ellipse/.test(v),
           "deleting layers nobody named fails and names them: " + v);
  }
  {
    const v = s.check(before, { before, tools: [], replies: ["All tidy now."] });
    assert(v && /never asked/.test(v),
           "claiming a clean-up without asking or doing fails: " + v);
  }
  assert(/comp is gone/.test(s.check({ found: false, layers: [] },
                                     { before }) || ""),
         "a comp that vanished fails");
}

// --- the trigger layer behind the steps --------------------------------
//
// A step is only as good as the route it measures: if the schema cannot
// emit the tool, or no rule in the prompt names it, the step fails every
// night for a reason that is not the model's.

const NEW_STEPS = [
  "push a layer back on the timeline", "attach a layer to a null",
  "smooth a mechanical fade", "fix a text layer's pivot",
  "hide half a layer with a mask", "take a mask off again",
  "un-animate the squares", "give a layer a finished look",
  "keep a layer drifting", "sync a layer to the music",
  "tuck one layer under another", "take an effect off a layer",
  "show one layer through another", "package layers into a precomp",
  "clean up means the comp, not the project"];
// Relative order again, not slice(14): what matters is that every
// trigger-layer step exists, that they keep the order their fixtures
// need (the mask must be planted before it is taken off again), and
// that they run after the steps that build the world they name.
for (const t of NEW_STEPS) stepOrder(t);
for (let i = 1; i < NEW_STEPS.length; i++) {
  assert(stepOrder(NEW_STEPS[i]) > stepOrder(NEW_STEPS[i - 1]),
         "'" + NEW_STEPS[i] + "' still runs after '" + NEW_STEPS[i - 1] +
         "'");
}
assertAfter(NEW_STEPS[0], "the model re-plans after a round is rolled back");

const toolsWin = {};
new Function("window", toolsSrc)(toolsWin);
const ToolsMod = toolsWin.Tools;
const toolEnum = ToolsMod.RESPONSE_SCHEMA.properties.commands.items
  .properties.tool.enum;
for (const t of NEW_STEPS.map(stepByTitle)) {
  if (!t.tool) continue;
  assert(toolEnum.indexOf(t.tool) !== -1,
         "the schema can emit " + t.tool + " (step '" + t.title + "')");
}
assert(toolEnum.indexOf("remove_effect") !== -1 &&
       toolEnum.indexOf("delete_mask") !== -1,
       "remove_effect and delete_mask are in the schema enum (it is built " +
       "from TOOL_DEFS, so a TOOL_DEFS entry is what lands them)");

const prompt = ToolsMod.buildSystemPrompt("");
const rules = prompt.split("\nAvailable tools:")[0];
const RULES = [
  ["group these", "precompose"],
  ["push it back", "set_layer_timing"],
  ["stick / pin it to X", "set_layer_parent"],
  ["less robotic", "apply_keyframe_ease"],
  ["spin around its middle", "center_anchor_point"],
  ["hide the bottom half", "add_mask"],
  ["stop it moving", "remove_keyframes"],
  ["make it pop", "list_presets \\{filter\\}\\s+then apply_preset"],
  ["keep it drifting", "apply_expression_preset"],
  ["show the video through the text", "set_track_matte"],
  ["sync to the beat", "audio_to_keyframes ONCE, then[\\s\\S]{0,20}link_property"],
  ["put it behind", "STACKING:[\\s\\S]{0,10}reorder_layers RELATIVE"],
  ["send it to the back", "toBack\\|toFront: true"],
  ["underneath X in the stack", "ON SCREEN' is position[\\s\\S]{0,40}get_bounds"],
  ["stop it moving", "set_expression[\\s\\S]{0,60}removed: 0"],
  ["get rid of the blur", "remove_effect"],
  ["remove that mask", "delete_mask"],
  // Row 29 measured 2026-09-02: all four phrasings avoided
  // clean_project (that half already worked) and went straight for a
  // destructive tool instead, so the bullet now leads with the ask
  // and carries the two wrong turns it took as anti-targets.
  ["junk everywhere", "never clean_project"],
  ["sort out this COMP", "ask what should go"],
  ["a mess / junk everywhere", "no remove_keyframes or delete_layer over"]
];
for (const [phrase, tool] of RULES) {
  // A quoted-phrase bullet ("- '…") whose phrase list may wrap onto a
  // continuation line, followed within one rule's length by the tool.
  const re = new RegExp("- '[\\s\\S]{0,240}" +
                        phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                        "[\\s\\S]{0,260}" + tool);
  assert(re.test(rules), "the prompt maps '" + phrase + "' to " + tool);
}
assert(/clean up \/ tidy \/ shrink the PROJECT/.test(rules),
       "the project-panel clean-up rule now says PROJECT");
assert(/the one exception to ACT, DON'T ASK/.test(rules),
       "the ask-first clean-up rule scopes itself against ACT, DON'T ASK");
assert(/NAMES NOTHING: ask what should go and\s+return commands: \[\]/
         .test(rules),
       "...and the ask comes FIRST, before the removal tools: the old " +
       "order put the tool list ahead of it and the model read no " +
       "further (measured, row 29)");
// Phrases the review struck: bare 'under' as a STACKING word collides
// with get_bounds' on-screen 'put it under the logo'; 'freeze' is AE's
// Freeze Frame (a future retime tool), not remove_keyframes.
assert(!/'put it behind \/ under/.test(rules),
       "bare 'under' is no longer a stacking phrase");
assert(!/freeze it/.test(prompt), "'freeze it' appears nowhere in the prompt");
assert(!/value at the current time is what stays/.test(prompt),
       "the unmeasured claim about which value survives remove_keyframes is gone");

// The docs carry the same words, so a model that reads the tool list
// rather than the rules finds them too.
const defsByName = {};
for (const d of ToolsMod.TOOL_DEFS) defsByName[d.name] = d;
const DOC_WORDS = {
  precompose: "package it up", set_layer_timing: "push it back",
  set_layer_parent: "stick", apply_keyframe_ease: "less robotic",
  center_anchor_point: "spin around its middle", add_mask: "hide the bottom half",
  remove_keyframes: "stop it moving", apply_preset: "make it pop",
  apply_expression_preset: "keep it drifting",
  set_track_matte: "show the video through the text",
  audio_to_keyframes: "sync to the beat", remove_effect: "get rid of the blur",
  delete_mask: "remove that mask", clean_project: "clean up this comp",
  reorder_layers: "toBack"
};
for (const name of Object.keys(DOC_WORDS)) {
  assert(!!defsByName[name] && defsByName[name].desc.indexOf(DOC_WORDS[name]) !== -1,
         "the " + name + " doc names '" + DOC_WORDS[name] + "'");
}
for (const name of ["remove_effect", "delete_mask"]) {
  assert(defsByName[name] && defsByName[name].mutating === true &&
         /layer\?:/.test(defsByName[name].args),
         name + " is documented as mutating with an optional layer");
}
assert(/above\?: layer name, below\?: layer name, toFront\?: true, toBack\?: true — never with by\/layers/
         .test(defsByName.reorder_layers.args),
       "reorder_layers' args document the relative keys as exclusive with " +
       "by AND layers (the host refuses both)");
assert(/relative key with 'by' or 'layers' is refused/.test(defsByName.reorder_layers.desc),
       "and the doc says so too");
assert(/on-screen 'under the logo' is position/.test(defsByName.reorder_layers.desc),
       "and separates stacking from on-screen position");
// One representative phrase per doc, the full list in the rules: a doc
// that repeats the rule's whole phrase list is the duplication the
// context budget cannot afford.
for (const name of ["reorder_layers", "remove_effect", "delete_mask",
                    "set_layer_timing", "add_mask", "set_track_matte",
                    "apply_expression_preset"]) {
  const quoted = (defsByName[name].desc.match(/'[^']+'/g) || [])
    .filter(q => / \/ /.test(q));
  assert(quoted.length <= 1,
         name + "'s doc carries at most one slash-separated phrase list (" +
         quoted.length + ")");
}
{
  // Hiding PART of a layer is not a retime, and not a transform.
  //
  // Measured 2026-09-02, real AE + the real 32B, --variants on the "hide
  // half a layer with a mask" row: 2 pass / 2 miss. "Chop off the lower
  // half of Beta so only the top shows" routed to set_layer_timing (it
  // read "chop off" as the sibling of the timing rule's "trim it"), and
  // "I only want to see the top half of Beta" routed to
  // center_anchor_point + set_transform. Neither wording appeared in the
  // mask bullet, and nothing in the prompt said which tools masking is
  // NOT. Both are one bullet away, so both are pinned here: the phrases
  // AND the anti-targets. The bullet wraps across prompt lines, so the
  // phrases are matched on a flowed copy of it.
  const bullets = rules.split(/\n(?=- ')/);
  const maskRule = bullets.filter(b => /^- 'crop/.test(b))[0];
  assert(!!maskRule, "the plain-English rules still carry a crop/mask bullet");
  const flow = (maskRule || "").replace(/\s+/g, " ");
  for (const phrase of ["chop off the lower half", "hide the bottom half",
                        "only the top shows", "cut a hole", "vignette"]) {
    assert(flow.indexOf(phrase) !== -1,
           "the mask bullet still carries '" + phrase + "'");
  }
  assert(/add_mask/.test(flow), "and routes them to add_mask");
  assert(/never set_layer_timing/.test(flow),
         "and says outright that masking is never set_layer_timing (the " +
         "canonical's measured wrong turn)");
  assert(/scale/.test(flow) && /anchor/.test(flow),
         "and rules out scale and anchor too (the casual phrasing's)");
  // The bullet's growth was paid for by dropping "add_mask creates a mask
  // (rectangle/ellipse/custom points)" from the Masks section — allowed
  // ONLY because the args line, which compact mode also keeps, spells the
  // shapes out. Put the prose back and the budget breaks; drop the args
  // and the model loses the enum entirely.
  assert(/'rectangle'\|'ellipse'\|'custom'/.test(defsByName.add_mask.args),
         "add_mask's args line names the shapes the rules no longer repeat");
}
{
  // A cheap-feeling entrance is an EASING complaint, not a restaging job.
  //
  // Measured 2026-09-02, real AE + the real 32B, --variants on "smooth a
  // mechanical fade": "the squares' entrance feels cheap, fix it" reached
  // stagger_layers (and then distribute_property) twice in a row. It moved
  // nine layers in TIME and left every opacity key linear - the sentence
  // asked how the animation FEELS, and the bullet's phrase list carried
  // 'smoother / snappier / less robotic / mechanical' but nothing a user
  // says when they cannot name the curve. The neighbouring stagger phrase
  // in the SAME bullet is what it fell into, so the anti-target is pinned
  // here beside the vocabulary.
  const bullets = rules.split(/\n(?=- ')/);
  const easeRule = bullets.filter(b => /^- 'stagger with an ease'/.test(b))[0];
  assert(!!easeRule, "the rules still carry the bezier-family bullet");
  const flow = (easeRule || "").replace(/\s+/g, " ");
  for (const phrase of ["smoother", "snappier", "less robotic", "mechanical",
                        "feels cheap"]) {
    assert(flow.indexOf(phrase) !== -1,
           "the ease bullet carries '" + phrase + "'");
  }
  assert(/never stagger_layers \(that moves\s*layers in TIME\)/.test(flow) ||
         /never stagger_layers \(that moves layers in TIME\)/.test(flow),
         "and rules out stagger_layers by name, with the reason (" + flow + ")");
  // The addition was paid for by three docs that repeated a phrase list the
  // rules already carry - the rules block is never compacted, so the second
  // copy bought nothing. Put any of them back and the full prompt breaks its
  // ceiling (see tests/test-context-budget.js).
  const CUT = {
    apply_keyframe_ease: ["smoother", "on the property that HAS the keys"],
    precompose: ["group these"],
    remove_keyframes: ["un-animate it"]
  };
  for (const name of Object.keys(CUT)) {
    for (const gone of CUT[name]) {
      assert(defsByName[name].desc.indexOf(gone) === -1,
             name + "'s doc no longer repeats '" + gone + "' (the rules " +
             "block carries it, and compact mode keeps the rules)");
    }
    assert(rules.indexOf(name) !== -1,
           "...and the rules still route to " + name);
  }
  assert(/un-animate it/.test(rules),
         "'un-animate it' survives the cut - in the rules, once");
}
{
  // The audit measured set_layer_timing as the SHORTEST doc in the file.
  const shortest = ToolsMod.TOOL_DEFS.slice().sort((a, b) =>
    a.desc.length - b.desc.length)[0];
  assert(shortest.name !== "set_layer_timing",
         "set_layer_timing is no longer the shortest tool doc (that is " +
         shortest.name + " now, " + shortest.desc.length + " chars)");
}

// ------------------------------------------- a rolled-back round is EVIDENCE
//
// Measured 2026-09-02, real AE + the real 32B, doing the compact-vs-full
// routing comparison: the "sync to the music" step scored FAIL in one
// run and pass in the next on IDENTICAL model behaviour. Both times the
// model called audio_to_keyframes, the host refused it with the grounded
// "no layer has audio", and the model relayed that refusal. The only
// difference was whether the round ROLLED BACK — and the probe used to
// `return` before recording a rolled-back command, so its whole round
// was invisible to the step's check, which then said "the model never
// reached audio_to_keyframes and ran no tools at all".
//
// A verdict that flips on something the model did not do is worse than
// no verdict: in a comparison between two prompt forms it is
// indistinguishable from a routing regression.
{
  const cmd = { tool: "audio_to_keyframes", args: { comp: "Probe Room" } };
  const back = probe.toolEntry(cmd,
    { ok: false, rolledBack: true,
      error: "No layer in 'Probe Room' has audio, and AE's converter " +
             "would silently do nothing." });
  assert(back.tool === "audio_to_keyframes",
         "a rolled-back command is still recorded — the ATTEMPT is what " +
         "a routing verdict reads");
  assert(back.ok === false && back.data === null,
         "but it is never scored as applied: ok false, data null");
  assert(back.rolledBack === true,
         "and it says it was rolled back");
  assert(/no layer/i.test(back.error),
         "carrying the host's grounded error, which is what the refusal " +
         "branch of a check matches on");
  const plainFail = probe.toolEntry(cmd, { ok: false, error: "boom" });
  assert(plainFail.rolledBack === false && plainFail.error === "boom",
         "an ordinary failure is unchanged by the fix");
  const good = probe.toolEntry({ tool: "add_solid", args: {} },
                               { ok: true, data: { name: "X" } });
  assert(good.ok === true && good.data.name === "X" &&
         good.rolledBack === false,
         "and so is a success");
  // The end the bug was actually felt at: the step's own check.
  const music = stepByTitle("sync a layer to the music");
  const verdict = music.check(comp([]), {
    tools: [back],
    replies: ["There is no audio in the 'Probe Room' comp. Please import " +
              "an audio file into the composition first."]
  });
  assert(verdict === null,
         "the silent rig's honest refusal PASSES even when the round " +
         "rolled back (this returned 'never reached audio_to_keyframes " +
         "and ran no tools at all' before the fix)");
  // What the OLD loop handed the same check — an empty tools array,
  // because it returned before recording. Pinned so the delta is a
  // measured fact and not a claim in a comment.
  assert(/never reached audio_to_keyframes/.test(
           String(music.check(comp([]), { tools: [], replies: [] }))),
         "and an unrecorded round is exactly what produced the false FAIL");
  // The record has to happen in the LOOP, not just be possible: the bug
  // was a `return` placed before the push.
  assert(/round\.rolledBack\+\+;[\s\S]{0,200}round\.tools\.push\(toolEntry/
           .test(probeSrc),
         "the rolled-back branch of the round loop records the command " +
         "before it returns");
  // ...and the other direction: a rolled-back conversion must not be
  // read as a conversion that happened.
  const wouldBeOk = probe.toolEntry(cmd, { ok: true, data: { keys: 180 },
                                           rolledBack: true });
  assert(wouldBeOk.ok === false,
         "a command that succeeded and was then undone is not a success");
}

// The runner plants a step's fixture BEFORE the before-state is read, so
// the verdict compares against a comp that already has it.
assert(typeof probe.runPrepare === "function",
       "the probe exports runPrepare");
assert(/runPrepare\(step, function \(\) \{\s*aeRead\(READ_COMP, function \(before\)/
         .test(probeSrc),
       "and the runner calls it before reading the before-state");

// --- isolation: no step may ride the one before it --------------------
//
// docs/AUDIT-0.11.md part 1.4: "shared history never resets — later
// variants ride earlier successes". It is not only a variance problem.
// In the field (WORKPLAN-LOG, 0.11.7) one wrong layer name in step 2
// stayed in the conversation and poisoned six later steps, so the run
// reported six failures for one mistake.

assert(typeof probe.resetHistory === "function",
       "the probe exports resetHistory");
{
  probe.history.push({ role: "user", content: "something earlier" });
  probe.sessionNotices.ledger = true;
  probe.sessionNotices.starved = true;
  probe.resetHistory();
  assert(probe.history.length === 0, "resetHistory empties the history");
  // main.js scopes both notices to a CONVERSATION, so a new conversation
  // gets to show them again — otherwise the next step's first trim is
  // silent and the transcript stops being readable step by step.
  assert(probe.sessionNotices.ledger === false &&
         probe.sessionNotices.starved === false,
         "and puts the once-per-conversation notices back");
}

{
  const carriers = STEPS.filter(s => s.carry).map(s => s.title);
  assert(JSON.stringify(carriers) ===
           JSON.stringify(["a second turn that refers back"]),
         "exactly one step carries the previous turn's history, and it " +
         "is the one whose sentence is a pronoun: " + carriers.join(", "));
  // Every other step has to NAME what it is talking about, or clearing
  // the history breaks it. "them"/"it"/"that" with no noun after it is
  // the shape that cannot survive a fresh conversation.
  const dangling = STEPS.filter(s => !s.carry &&
    /^(?:make|do) (?:them|it|those|that)\b/i.test(s.say)).map(s => s.title);
  assert(dangling.length === 0,
         "no fresh-history step opens with a bare pronoun: " +
         dangling.join(", "));
}

{
  // The rig is only worth having if it builds everything the steps that
  // start from it name. Checked against the PLAN, so a fixture that
  // quietly stops being built is caught with no AE.
  const plan = probe.rigPlan();
  const built = plan.map(c => (c.args && c.args.name) || "")
    .filter(Boolean);
  for (const want of ["Red Square 1", "Red Square 9", "Rig", "Beta"]) {
    assert(built.indexOf(want) !== -1,
           "the rig builds " + want + " (a fromRig step names it)");
  }
  assert(plan.filter(c => c.tool === "add_text_layer" &&
                          c.args.text === "HELLO").length === 1,
         "the rig builds the HELLO text layer");
  assert(plan.filter(c => c.tool === "add_mask" &&
                          c.args.layer === "HELLO" &&
                          c.args.shape === "ellipse").length === 1,
         "and the oval mask that 'take a mask off again' removes");
  assert(plan.filter(c => c.tool === "set_keyframes" &&
                          c.args.property === "opacity").length === 9,
         "and a fade on every square, for the ease and un-animate steps");
  // Beta must be created LAST: layers land at index 1, and "Beta is
  // covering HELLO, tuck it underneath" is only true if it starts above.
  const betaAt = plan.map((c, i) => c.args && c.args.name === "Beta"
    ? i : -1).filter(i => i !== -1);
  const helloAt = plan.map((c, i) => c.tool === "add_text_layer" ? i : -1)
    .filter(i => i !== -1);
  assert(betaAt[0] > helloAt[0],
         "Beta is added after HELLO, so it starts above the text");
  // grid_layout would add a "GRID CTRL" solid and rig expressions; the
  // squares() helper filters that name out, and a rig should hold
  // nothing the sentences do not name.
  assert(plan.filter(c => c.tool === "grid_layout").length === 0,
         "the rig places the grid by hand, with no controller layer");
  const script = probe.rigScript();
  assert(/AELL_callBatch\(/.test(script),
         "the rig runs as ONE batch — one script execution, one undo group");
  assert(/res\.data && res\.data\.results/.test(script),
         "and reads AELL_callBatch's {ok, data:{results}} envelope, not " +
         "a bare array");
  assert(/failed/.test(script),
         "a rig command that failed is NAMED, not swallowed");
}

{
  const fromRig = STEPS.filter(s => s.fromRig).map(s => s.title);
  assert(JSON.stringify(fromRig) === JSON.stringify(NEW_STEPS),
         "every trigger-layer step can start from the rig, and no " +
         "world-BUILDING step claims to: " + fromRig.join(", "));
  // The world-building steps must NOT reset the comp: building it
  // through the model is their whole coverage.
  for (const t of ["create a comp", "grid layout", "text layer", "mask",
                   "track matte", "parenting"]) {
    assert(!stepByTitle(t).fromRig,
           "'" + t + "' builds the world instead of inheriting it");
  }
}

assert(/function resetWorld\(step, cb\)/.test(probeSrc) &&
       /resetWorld\(step, function \(\) \{/.test(probeSrc),
       "the runner asks resetWorld what a step may inherit, before the " +
       "step runs");
assert(/if \(!OPT\.carryHistory && !step\.carry\) resetHistory\(\);/
         .test(probeSrc),
       "history resets by DEFAULT — carrying it is the exception a step " +
       "has to ask for");
assert(/if \(!OPT\.isolate \|\| !step\.fromRig\) \{ cb\(\); return; \}/
         .test(probeSrc),
       "and the comp resets only under --isolate, and only for a step " +
       "that can start from the rig");

// ------------------------------------------------- the paraphrase matrix
//
// WORKPLAN section 8, second bullet. The matrix runs the SAME sentence
// three more ways and asks whether the product needed the magic words.
// Its whole value rests on one judgement — is a run that failed its
// check a harmless miss or a harmful one — and that judgement is made by
// compDiff/gradeRun, which are pure. So they are pinned here, with the
// near-misses a careless change detector would wave through: an
// expression that leaves the layer list untouched, a recolour, a matte
// removed, a float that only wobbled in the last decimal.

{
  const base = over => Object.assign({
    index: 1, name: "Beta", parent: null, masks: 0, effects: 0,
    opacityKeys: 0, text: null, matteLayer: null, matteLayerKnown: true,
    isPrecomp: false, textAnimators: 0, matte: 5012, rotation: 0,
    opacity: 100, inPoint: 0, startTime: 0, fontSize: null,
    position: [100, 100, 0], scale: [100, 100, 100],
    anchorPoint: [50, 50, 0], solidColor: [1, 0, 0], fillColor: null,
    effectNames: [], maskModes: [], maskInverted: [], maskRound: [],
    maskFeather: [], maskBoxes: [], opacityKeyEased: [], expressions: {}
  }, over || {});
  const comp = layers => ({ found: true, name: "Probe Room", width: 1920,
    height: 1080, duration: 6, frameRate: 30, layers: layers });
  const one = over => comp([base(over)]);
  const diff = (a, b) => probe.compDiff(a, b);

  assert(diff(one({}), one({})).length === 0,
         "compDiff: an untouched comp reads as no change at all");

  // The float noise a deep compare would report as a mutation. AE hands
  // back positions and rotations that wobble in the last decimal after a
  // round trip, and every one of those would have been a phantom HARM.
  assert(diff(one({}),
              one({ position: [100.0001, 100, 0], rotation: 0.001,
                    opacity: 100.002 })).length === 0,
         "compDiff: a float that only moved in the last decimal is not a " +
         "change");
  assert(diff(one({}), one({ position: [140, 100, 0] })).length === 1,
         "compDiff: but a layer that really moved 40px is");

  // The changes SIG_FN cannot see, because none of them alters the layer
  // list or a transform value. An expression on the wrong layer is
  // exactly the harm this matrix exists to catch, and a signature-based
  // detector would have called every one of these "nothing happened".
  assert(/expression added to position/
           .test(diff(one({}),
                      one({ expressions: { position: "wiggle(1,10)" } }))[0]),
         "compDiff: an expression appearing is a change (SIG_FN cannot " +
         "see one)");
  assert(diff(one({ expressions: { position: "wiggle(1,10)" } }),
              one({}))[0] === "Beta: expression removed from position",
         "compDiff: and an expression disappearing is too");
  assert(/opacityKeyEased/.test(diff(one({ opacityKeys: 2,
              opacityKeyEased: [false, false] }),
            one({ opacityKeys: 2, opacityKeyEased: [true, true] }))[0]),
         "compDiff: keys that got eased are a change even though the key " +
         "COUNT did not move");
  assert(/solidColor/.test(diff(one({}),
            one({ solidColor: [0, 0, 1] }))[0]),
         "compDiff: a recoloured solid is a change");

  // The matte pair. removeTrackMatte leaves trackMatteType behind (the
  // AE 2026 measurement this repo already pins), so a matte that was
  // taken off shows up as the matte LAYER going — once.
  const matted = one({ matte: 5013, matteLayer: "HELLO" });
  const unmatted = one({ matte: 5013, matteLayer: null });
  assert(diff(matted, unmatted).length === 1 &&
         /matteLayer HELLO -> none/.test(diff(matted, unmatted)[0]),
         "compDiff: a matte removed reads as the LAYER going, once");

  // Layers arriving and leaving, by name.
  const two = comp([base({}), base({ index: 2, name: "HELLO",
    isText: true, text: "HELLO" })]);
  assert(diff(one({}), two).join("") === "layer added: HELLO",
         "compDiff: a layer that appeared is named");
  assert(diff(two, one({})).join("") === "layer removed: HELLO",
         "compDiff: and one that vanished");
  assert(diff(one({}), { found: false })[0] === "THE COMP IS GONE",
         "compDiff: a sentence that deleted the whole comp is the loudest " +
         "change there is, not a harmless miss");
  // Nothing to compare against is not the same as nothing changed, but
  // it must not throw either: the world-building steps have no `before`.
  assert(diff(null, one({})).length === 0 && diff(one({}), null).length === 0,
         "compDiff: a missing state on either side is empty, never a throw");

  // --------------------------------------------------------- the grade
  assert(probe.gradeRun(null, []) === "pass" &&
         probe.gradeRun(null, ["Beta: parent none -> Rig"]) === "pass",
         "gradeRun: a satisfied check is a pass, however much moved — " +
         "doing the job IS changing the comp");
  assert(probe.gradeRun("Beta has no track matte", []) === "miss",
         "gradeRun: a failed check with an untouched comp is a harmless " +
         "miss (refused, asked, or rolled back)");
  assert(probe.gradeRun("Beta has no track matte",
           ["HELLO: matteLayer none -> Beta"]) === "harm",
         "gradeRun: a failed check that moved something anyway is HARM — " +
         "the wrong-target mutation the matrix exists to find");
}

{
  // The runs a selection expands to.
  const idx = STEPS.map((s, i) => i);
  const plain = probe.variantRuns(idx, false);
  assert(plain.length === STEPS.length &&
         plain.every(r => r.phrasing === "canonical"),
         "variantRuns: without --variants a selection is exactly the " +
         "steps it names, unchanged");
  assert(plain.every((r, i) => r.say === STEPS[i].say),
         "and every run types the step's own sentence");
  const full = probe.variantRuns(idx, true);
  const declared = STEPS.reduce((a, s) =>
    a + (s.carry ? 0 : (s.variants || []).length), 0);
  assert(full.length === STEPS.length + declared,
         "variantRuns: with --variants, one run per phrasing (" +
         full.length + " over " + STEPS.length + " steps)");
  // The canonical must come FIRST for each step: the matrix reads
  // "did the paraphrase miss where the canonical passed", and that
  // question is unanswerable if the canonical has not run yet.
  const seen = {};
  assert(full.every(r => {
    if (r.phrasing === "canonical") { seen[r.index] = true; return true; }
    return seen[r.index];
  }), "and the canonical sentence runs before its own paraphrases");
  // A pronoun cannot be rephrased without rephrasing the turn it points
  // at, so the carry step never takes variants.
  assert(STEPS.filter(s => s.carry).every(s => !(s.variants || []).length),
         "the step whose sentence is a pronoun declares no paraphrases");

  // Every variant-bearing step must be able to start from the rig, or
  // its second phrasing measures the first phrasing's leftovers. This is
  // the invariant the whole matrix rests on.
  const loose = STEPS.filter(s => (s.variants || []).length && !s.fromRig)
    .map(s => s.title);
  assert(loose.length === 0,
         "every step with paraphrases can be reset to the rig, so two " +
         "phrasings cannot contaminate each other: " + loose.join(", "));
  // ...and --variants must actually turn that reset on.
  assert(/if \(OPT\.variants\) OPT\.isolate = true;/.test(probeSrc),
         "--variants implies --isolate — a paraphrase run from an unknown " +
         "world measures the world");

  // Casual / vague / typo'd, per the workplan, and 2-3 of them.
  const KINDS = ["casual", "vague", "typo"];
  for (const s of STEPS.filter(x => (x.variants || []).length)) {
    const kinds = s.variants.map(v => v.kind);
    assert(s.variants.length >= 2 && s.variants.length <= 3,
           "'" + s.title + "' declares 2-3 paraphrases (" +
           s.variants.length + ")");
    assert(kinds.every(k => KINDS.indexOf(k) !== -1) &&
           new Set(kinds).size === kinds.length,
           "and they are distinct casual/vague/typo phrasings: " +
           kinds.join(", "));
    assert(s.variants.every(v => typeof v.say === "string" &&
                                 v.say.trim().length > 8),
           "and each one is a real sentence");
    // A paraphrase that repeats the canonical measures nothing.
    const norm = t => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    assert(s.variants.every(v => norm(v.say) !== norm(s.say)),
           "and none of them is the canonical sentence again");
  }
  // Every one of the roadmap-item-2 trigger mappings is covered: those
  // are exactly the steps that name the tool their sentence is meant to
  // reach, and a mapping with no paraphrase is a mapping still only
  // proven against its own vocabulary.
  const bare = STEPS.filter(s => s.tool && !(s.variants || []).length)
    .map(s => s.title);
  assert(bare.length === 0,
         "every step that names a target tool carries paraphrases: " +
         bare.join(", "));
}

{
  // The acceptance gate. Its exact wording is the workplan's: no variant
  // may do harm, and at most one may miss where the canonical passes.
  const row = (index, phrasing, grade, verdict) => ({
    index: index, title: "step " + index, phrasing: phrasing, grade: grade,
    verdict: verdict || null, say: "a sentence", tools: [] });
  const clean = [row(1, "canonical", "pass"), row(1, "casual", "pass"),
                 row(1, "vague", "pass"), row(1, "typo", "pass")];
  assert(probe.gradeMatrix(clean).length === 0,
         "gradeMatrix: four phrasings, four passes, nothing to report");
  const oneMiss = clean.slice(0, 3).concat([row(1, "typo", "miss", "no")]);
  assert(probe.gradeMatrix(oneMiss).length === 0,
         "gradeMatrix: ONE paraphrase missing where the canonical passed " +
         "is within the acceptance the workplan states");
  const twoMiss = clean.slice(0, 2)
    .concat([row(1, "vague", "miss", "no"), row(1, "typo", "miss", "no")]);
  assert(probe.gradeMatrix(twoMiss).length === 1 &&
         /needs magic words/.test(probe.gradeMatrix(twoMiss)[0]),
         "gradeMatrix: two of three missing is not a fluke — it is a tool " +
         "that needs magic words");
  const harmed = clean.slice(0, 3)
    .concat([row(1, "typo", "harm", "Beta has no track matte")]);
  const hp = probe.gradeMatrix(harmed);
  assert(hp.length === 1 && /^HARM/.test(hp[0]),
         "gradeMatrix: one harm fails the run even though three phrasings " +
         "of four were clean");
  // ...and harm is reported even when the canonical itself failed, so a
  // broken step cannot hide a destructive paraphrase behind it.
  const both = [row(2, "canonical", "miss", "nothing happened"),
                row(2, "casual", "harm", "the layers went")];
  const bp = probe.gradeMatrix(both);
  assert(bp.filter(p => /^HARM/.test(p)).length === 1 &&
         bp.filter(p => /CANONICAL/.test(p)).length === 1,
         "gradeMatrix: a failed canonical is reported AND still cannot " +
         "hide a harmful paraphrase behind it");
  // A group with no canonical in it must not be scored against one it
  // never ran.
  assert(probe.gradeMatrix([row(3, "casual", "miss", "no")]).length === 0,
         "gradeMatrix: a group with no canonical is not scored against " +
         "one it never ran");
}

console.log(failed ? "\n" + failed + " assertion(s) failed"
                   : "\nall chat-probe verdict tests passed");
