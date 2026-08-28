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
  callHostBatch: "main.js only hands it to SelfTest, not to its round loop"
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
  Settings: "settings.js", Tiers: "tiers.js", Tools: "tools.js"
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

console.log(failed ? "\n" + failed + " assertion(s) failed"
                   : "\nall chat-probe verdict tests passed");
