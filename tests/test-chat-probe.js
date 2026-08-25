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
    isNull: false, isSolid: true
  };
  for (const k in over) row[k] = over[k];
  return row;
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
    trackMatteType: spec.matte || 0,
    inPoint: spec.inPoint || 0, outPoint: spec.outPoint || 6,
    startTime: spec.startTime || 0,
    nullLayer: !!spec.isNull,
    source: solid
      ? { mainSource: Object.assign(new SolidSource(),
                                    { color: solid.slice(0) }) }
      : null
  };
  const effectList = (spec.effects || []).map(function (fx) {
    const params = (fx.colors || []).map(function (c) {
      return { propertyValueType: PropertyValueType.COLOR,
               value: c.slice(0) };
    });
    return { name: fx.name, numProperties: params.length,
             property(i) { return params[i - 1]; } };
  });
  const transform = propGroup({
    "ADBE Position": { value: (spec.pos || [0, 0, 0]).slice(0) },
    "ADBE Scale": { value: (spec.scale || [100, 100, 100]).slice(0) },
    "ADBE Rotate Z": { value: spec.rot || 0 },
    "ADBE Opacity": { numKeys: spec.keys || 0,
                      keyTime(k) { return (spec.keyTimes || [])[k - 1]; } }
  });
  const groups = {
    "ADBE Transform Group": transform,
    "ADBE Effect Parade": { numProperties: effectList.length,
                            property(i) { return effectList[i - 1]; } },
    "ADBE Mask Parade": { numProperties: spec.masks || 0 }
  };
  if (spec.text !== undefined) {
    groups["Source Text"] = { value: { text: spec.text } };
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
    parent: "Rig", masks: 1, effects: [{ name: "Fill",
      colors: [[0, 0, 1]] }] },
  { name: "HELLO", pos: [960, 200, 0], isText: true, text: "HELLO" }
];

setLayers(BASE);

{
  const state = runJsx(READ_COMP);
  assert(state.found === true && state.layers.length === 3,
         "READ_COMP walks the comp");
  assert(JSON.stringify(state.layers[0].solidColor) === "[1,0,0]",
         "READ_COMP reports a solid's source colour (the recolour check " +
         "has nothing to read without it)");
  assert(JSON.stringify(state.layers[1].effectNames) === '["Fill"]' &&
         JSON.stringify(state.layers[1].effectColors) === "[[0,0,1]]",
         "READ_COMP reports effect names and their colours");
  assert(state.layers[2].text === "HELLO" && state.layers[2].isText === true,
         "READ_COMP still reads text layers");
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
assert(titles.indexOf("a second turn that refers back") === 8 &&
       titles.indexOf("one Ctrl+Z for one chat command") === 9,
       "the two new steps run LAST, after the comp they refer back to " +
       "has been built");
assert(STEPS.filter(s => typeof s.say !== "string" ||
                         typeof s.check !== "function").length === 0,
       "every step still has a sentence and a verdict");

console.log(failed ? "\n" + failed + " assertion(s) failed"
                   : "\nall chat-probe verdict tests passed");
