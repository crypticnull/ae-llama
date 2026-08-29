// Regression test: audio_to_keyframes.
//
// The tool is a thin wrapper around ONE menu command, and every line of
// it exists because of something that command does not do. All of the
// following was measured against real AE 2026 before the tool was
// written, and the stub below models it rather than the tool:
//
//  1. `app.findMenuCommandId("Convert Audio to Keyframes")` = 4218.
//     "Convert Audio To Keyframes" (capital To) and the same string with
//     an ellipsis both return 0, so the name is not a guess to be tidied.
//  2. It converts the ACTIVE comp. Opening a different comp in the
//     viewer and running it created NOTHING in the comp we wanted.
//  3. It ignores the SELECTION entirely: with only a silent solid
//     selected it still measured the whole comp mix (peak 56.53, the
//     same figure as with nothing selected).
//  4. A MUTED layer contributes an all-zero curve — which is what makes
//     per-layer isolation possible at all: mute the others, convert,
//     un-mute. Measured both ways round (A-only and B-only) on two
//     copies of the same beat offset by 2s.
//  5. It is bounded by the WORK AREA. Work area 0.5..1.5 on a 4s/24fps
//     comp gave 25 keys from 0.5 to 1.5, not 97 from 0 to 4.
//  6. With no audio-capable layer it does nothing at all: no layer, no
//     exception, no dialog. Silence is the ONLY signal, which is why the
//     tool refuses before calling rather than after.
//  7. It never uniques the null's name. Running it twice leaves two
//     layers both called "Audio Amplitude".
//  8. It leaves NOTHING selected afterwards, and drops the null next to
//     whatever was selected when it ran (index 1 with no selection,
//     index 2 under a selected top layer).
//  9. The null carries three Slider Controls in the order Left Channel,
//     Right Channel, Both Channels; the slider inside each is called
//     "Slider" (matchName "ADBE Slider Control-0001") and its keys are
//     LINEAR, one per frame.
// 10. `layer.id` is a plain unique number, so "which layer is new" is
//     answerable without guessing at names.
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
function LightLayer() {} function AVLayer() {}
const ParagraphJustification = {};
const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };

let nextId = 4200;

function Prop(name, matchName) {
  this.name = name;
  this.matchName = matchName;
  this._keys = [];              // {t, v}
}
Object.defineProperty(Prop.prototype, "numKeys", {
  get() { return this._keys.length; }
});
Prop.prototype.keyTime = function (k) { return this._keys[k - 1].t; };
Prop.prototype.keyValue = function (k) { return this._keys[k - 1].v; };
Prop.prototype.keyInInterpolationType = function () {
  return KeyframeInterpolationType.LINEAR;
};

function Group(name, matchName) {
  this.name = name;
  this.matchName = matchName;
  this._props = [];
}
Object.defineProperty(Group.prototype, "numProperties", {
  get() { return this._props.length; }
});
Group.prototype.property = function (ref) {
  const p = typeof ref === "number" ? this._props[ref - 1]
    : this._props.filter(x => x.name === ref || x.matchName === ref)[0];
  if (!p) throw new Error("no property " + ref);
  return p;
};

// `beat` is the stub's stand-in for a waveform: a function of time
// returning amplitude. null = the layer carries no audio at all.
function Layer(name, comp, beat) {
  this.name = name;
  this.comp = comp;
  this.beat = beat || null;
  this.hasAudio = !!beat;
  this.audioEnabled = true;
  this.enabled = true;
  this.selected = false;
  this.nullLayer = false;
  this.startTime = 0;
  this.id = ++nextId;
  this._groups = { "ADBE Effect Parade": new Group("Effects", "ADBE Effect Parade") };
}
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
// FACT 4 lives here: audioActive is what AE reports for "audible AT THE
// CURRENT TIME", so a layer whose audio starts later reads false even
// when it is perfectly un-muted. The tool must not use it.
Object.defineProperty(Layer.prototype, "audioActive", {
  get() {
    return this.hasAudio && this.audioEnabled && this.enabled &&
           this.startTime <= this.comp._time;
  }
});
Layer.prototype.property = function (ref) {
  const g = this._groups[ref];
  if (!g) throw new Error("no group " + ref);
  return g;
};
Layer.prototype.remove = function () {
  const k = this.comp._layers.indexOf(this);
  if (k >= 0) this.comp._layers.splice(k, 1);
};

function Comp(name, dur, fps) {
  this.name = name;
  this.width = 640; this.height = 480;
  this.duration = dur; this.frameRate = fps;
  this.workAreaStart = 0;
  this.workAreaDuration = dur;
  this._time = 0;
  this._layers = [];
  this.id = ++nextId;
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
Comp.prototype.openInViewer = function () { project._active = this; };

function makeComp(name, dur, fps) {
  const c = new Comp(name, dur, fps);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  project._items.push(c);
  return c;
}

const project = {
  _items: [],
  _active: null,
  get numItems() { return this._items.length; },
  get activeItem() { return this._active; },
  item(i) { return this._items[i - 1]; },
  rootFolder: { name: "(root)" },
  renderQueue: { numItems: 0 },
  items: { addComp: (n, w, h, p, d, f) => makeComp(n, d, f) }
};

// ------------------------------------------- AE's own converter, modelled

let commandRuns = 0;
let lastCommandId = null;

function convertAudioToKeyframes() {
  const comp = project._active;
  if (!(comp instanceof CompItem)) return;          // FACT 2 + FACT 6
  const carriers = comp._layers.filter(l => l.hasAudio);
  if (carriers.length === 0) return;                // FACT 6: silence
  const audible = carriers.filter(l => l.audioEnabled && l.enabled);

  const start = comp.workAreaStart;                  // FACT 5
  const end = start + comp.workAreaDuration;
  const step = 1 / comp.frameRate;
  const times = [];
  for (let t = start; t <= end + 1e-9; t += step) times.push(Math.round(t * 1e6) / 1e6);

  const nul = new Layer("Audio Amplitude", comp, null);   // FACT 7: verbatim
  nul.nullLayer = true;
  const parade = nul._groups["ADBE Effect Parade"];
  ["Left Channel", "Right Channel", "Both Channels"].forEach(nm => {  // FACT 9
    const fx = new Group(nm, "ADBE Slider Control");
    const sl = new Prop("Slider", "ADBE Slider Control-0001");
    times.forEach(t => {
      let v = 0;
      // FACT 3: the whole MIX, never the selection.
      // FACT 4: a muted layer contributes exactly nothing.
      audible.forEach(l => { v = Math.max(v, l.beat(t)); });
      sl._keys.push({ t, v });
    });
    fx._props.push(sl);
    parade._props.push(fx);
  });

  // FACT 8: dropped under the topmost selected layer, else at the top;
  // and nothing is left selected.
  const sel = comp._layers.filter(l => l.selected);
  const at = sel.length ? comp._layers.indexOf(sel[0]) + 1 : 0;
  comp._layers.splice(at, 0, nul);
  comp._layers.forEach(l => { l.selected = false; });
}

const app = {
  project,
  version: "26.3x87",
  beginUndoGroup() {}, endUndoGroup() {},
  findMenuCommandId(name) {
    // FACT 1: the exact string, and only the exact string.
    return name === "Convert Audio to Keyframes" ? 4218 : 0;
  },
  executeCommand(id) {
    commandRuns++; lastCommandId = id;
    if (id === 4218) convertAudioToKeyframes();
  }
};
const $ = { global: {}, hiresTimer: 0 };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool } = host;
const call = (t, a) => AELL_runTool(t, a || {});

const nullsIn = c => c._layers.filter(l => l.nullLayer).map(l => l.name);
const sliderOf = (c, name, fx) =>
  c.layer(name).property("ADBE Effect Parade").property(fx || "Both Channels")
   .property(1);

// --------------------------------------------------- STUB FIDELITY first

{
  const c = makeComp("Fidelity", 4, 24);
  c._layers.push(new Layer("solid", c, null));
  const a = new Layer("beat.wav", c, t => (t % 0.5 < 0.08 ? 56.53 : 0));
  c._layers.push(a);
  c.openInViewer();
  app.executeCommand(4218);
  assert(nullsIn(c).length === 1 && nullsIn(c)[0] === "Audio Amplitude",
         "STUB FIDELITY: the command makes one null called 'Audio Amplitude'");
  assert(sliderOf(c, "Audio Amplitude").numKeys === 97,
         "STUB FIDELITY: 4s at 24fps = 97 keys, one per frame");
  app.executeCommand(4218);
  assert(nullsIn(c).join("|") === "Audio Amplitude|Audio Amplitude",
         "STUB FIDELITY: a second run makes a SECOND 'Audio Amplitude'");
  assert(app.findMenuCommandId("Convert Audio To Keyframes") === 0,
         "STUB FIDELITY: the capital-To spelling resolves to 0");
  assert(a.audioActive === true && (a.startTime = 2, a.audioActive === false),
         "STUB FIDELITY: audioActive is TIME-dependent (false before the audio starts)");
  a.startTime = 0;
}

// ------------------------------------------- 1. no audio at all: refused

{
  const c = makeComp("Silent", 4, 24);
  c._layers.push(new Layer("red square", c, null));
  c._layers.push(new Layer("title", c, null));
  const before = commandRuns;
  const r = call("audio_to_keyframes", { comp: "Silent" });
  assert(!r.ok, "a comp with no audio is refused");
  assert(/red square/.test(r.error) && /title/.test(r.error),
         "the refusal LISTS the layers that are actually there: " + r.error);
  assert(/import_file/.test(r.error),
         "the refusal names the way out (import_file)");
  assert(commandRuns === before,
         "AE's command is never even called — it would fail silently");
  assert(nullsIn(c).length === 0, "nothing was created");

  // A typo in an ARGUMENT is refused as a typo, not as a comp problem —
  // otherwise the model retries the audio it already has.
  const typo = call("audio_to_keyframes", { comp: "Silent", range: "half" });
  assert(!typo.ok && /'range'/.test(typo.error) && !/no audio/.test(typo.error),
         "a bad 'range' is refused before the comp's state is judged: " +
         typo.error);
}

// ------------------------------- 2. the happy path, whole comp, one layer

let bandComp;
{
  const c = bandComp = makeComp("Band", 4, 24);
  const solid = new Layer("stage", c, null);
  const music = new Layer("music.wav", c, t => (t % 0.5 < 0.08 ? 56.53 : 0));
  c._layers.push(solid, music);
  solid.selected = true;
  const r = call("audio_to_keyframes", { comp: "Band" });
  assert(r.ok, "the whole-comp conversion succeeds: " + (r.error || ""));
  assert(r.data.layer === "Audio Amplitude", "reports the null's name");
  assert(r.data.keyframes === 97, "reports 97 keyframes: " + r.data.keyframes);
  assert(r.data.rangeStart === 0 && Math.abs(r.data.rangeEnd - 4) < 1e-6,
         "reports the covered range 0..4");
  assert(r.data.peak === 56.53, "reports the peak amplitude: " + r.data.peak);
  assert(r.data.measured === "whole comp mix",
         "says WHAT it measured when no layer was named");
  assert(String(r.data.controlEffects) ===
         "Left Channel,Right Channel,Both Channels",
         "reports the three channel controls in AE's order: " +
         r.data.controlEffects);
  assert(/link_property/.test(r.data.next) &&
         /Both Channels/.test(r.data.next) &&
         /Audio Amplitude/.test(r.data.next),
         "hands the model the exact link_property call to make next");
  assert(!r.data.workArea && !r.data.isolated && !r.data.mutedLayersIgnored,
         "a plain comp gets no isolation/work-area caveats");

  // FACT 8 both ways: deselect first so the null lands on top, then give
  // the user's selection back.
  assert(c.layer(1).nullLayer === true,
         "the null lands at the TOP even though a layer was selected");
  assert(solid.selected === true && c.selectedLayers.length === 1,
         "the user's selection survives the command that clears it");
}

// ------------------------------------------ 3. the name is made UNIQUE

{
  const r = call("audio_to_keyframes", { comp: "Band" });
  assert(r.ok, "a second conversion in the same comp succeeds");
  assert(r.data.layer === "Audio Amplitude 2",
         "the second null is renamed, never left ambiguous: " + r.data.layer);
  assert(/already a layer/.test(r.data.nameTaken || ""),
         "and the rename is REPORTED, not silent");
  assert(nullsIn(bandComp).length === 2 &&
         nullsIn(bandComp).sort().join("|") ===
           "Audio Amplitude|Audio Amplitude 2",
         "no two layers in the comp share a name: " + nullsIn(bandComp));
  bandComp._layers = bandComp._layers.filter(l => !l.nullLayer);

  const named = call("audio_to_keyframes", { comp: "Band", name: "Beat" });
  assert(named.ok && named.data.layer === "Beat",
         "an explicit name is used as given: " + named.data.layer);
  assert(!named.data.nameTaken, "a free name reports no collision");
  bandComp._layers = bandComp._layers.filter(l => !l.nullLayer);
}

// ------------------------------------ 4. isolating ONE layer's audio

let duoComp;
{
  const c = duoComp = makeComp("Duo", 4, 24);
  // A in the first half, B in the second — so the curve alone says which
  // layer was measured.
  const A = new Layer("kick.wav", c, t => (t < 2 && t % 0.5 < 0.08 ? 50 : 0));
  const B = new Layer("voice.wav", c, t => (t >= 2 ? 30 : 0));
  c._layers.push(A, B);

  const both = call("audio_to_keyframes", { comp: "Duo" });
  assert(both.ok && both.data.peak === 50, "the mix peaks at the louder layer");
  {
    const sl = sliderOf(c, both.data.layer);
    let late = 0;
    for (let k = 1; k <= sl.numKeys; k++) {
      if (sl.keyTime(k) >= 2) late = Math.max(late, sl.keyValue(k));
    }
    assert(late === 30, "the mix carries the second layer's audio too");
  }
  c._layers = c._layers.filter(l => !l.nullLayer);

  const solo = call("audio_to_keyframes", { comp: "Duo", layer: "kick.wav" });
  assert(solo.ok, "isolating one layer succeeds: " + (solo.error || ""));
  assert(solo.data.measured === "kick.wav", "says which layer it measured");
  assert(/voice\.wav/.test(solo.data.isolated || "") &&
         /muted for the conversion/.test(solo.data.isolated || ""),
         "and says out loud that the other layer was muted: " +
         solo.data.isolated);
  {
    const sl = sliderOf(c, solo.data.layer);
    let early = 0, late = 0;
    for (let k = 1; k <= sl.numKeys; k++) {
      if (sl.keyTime(k) < 2) early = Math.max(early, sl.keyValue(k));
      else late = Math.max(late, sl.keyValue(k));
    }
    assert(early === 50 && late === 0,
           "ONLY the named layer is in the curve (early " + early +
           ", late " + late + ")");
  }
  assert(B.audioEnabled === true && A.audioEnabled === true,
         "every mute is undone afterwards — the comp is handed back intact");
  c._layers = c._layers.filter(l => !l.nullLayer);
}

// -------------------------- 5. a throw mid-conversion still un-mutes

{
  const c = duoComp;
  const B = c.layer("voice.wav");
  const realExec = app.executeCommand;
  app.executeCommand = function () { throw new Error("AE said no"); };
  const r = call("audio_to_keyframes", { comp: "Duo", layer: "kick.wav" });
  app.executeCommand = realExec;
  assert(!r.ok && /AE said no/.test(r.error),
         "a throw from the menu command is reported, not swallowed");
  assert(B.audioEnabled === true,
         "and the layer muted for the conversion is un-muted anyway");
}

// ------------------------------------------ 6. muted layers are refused

{
  const c = makeComp("Muted", 4, 24);
  const A = new Layer("track.wav", c, t => 10);
  A.audioEnabled = false;
  c._layers.push(A);
  const before = commandRuns;
  const r = call("audio_to_keyframes", { comp: "Muted" });
  assert(!r.ok, "a comp whose only audio is muted is refused");
  assert(/track\.wav/.test(r.error) && /flat zero/.test(r.error),
         "the refusal names the muted layer and what would happen: " + r.error);
  assert(commandRuns === before, "AE is not asked to write a zero curve");

  const named = call("audio_to_keyframes", { comp: "Muted", layer: "track.wav" });
  assert(!named.ok && /muted/.test(named.error),
         "naming the muted layer is refused too: " + named.error);

  // ...but a muted layer NEXT TO an audible one is reported, not fatal.
  const B = new Layer("live.wav", c, t => 20);
  c._layers.push(B);
  const ok = call("audio_to_keyframes", { comp: "Muted" });
  assert(ok.ok, "one audible layer is enough: " + (ok.error || ""));
  assert(/track\.wav/.test(ok.data.mutedLayersIgnored || ""),
         "and the muted one is named as having contributed nothing: " +
         ok.data.mutedLayersIgnored);
}

// ------------------------------------------- 7. a layer with no audio

{
  const r = call("audio_to_keyframes", { comp: "Band", layer: "stage" });
  assert(!r.ok, "naming a layer that has no audio is refused");
  assert(/music\.wav/.test(r.error),
         "the refusal lists the layers that DO have audio: " + r.error);
  assert(/whole comp mix/.test(r.error),
         "and reminds the model that omitting 'layer' is an option");
}

// --------------------------------------------------- 8. the WORK AREA

{
  const c = makeComp("Trimmed", 4, 24);
  c._layers.push(new Layer("song.wav", c, t => (t % 0.5 < 0.08 ? 40 : 0)));
  c.workAreaStart = 0.5;
  c.workAreaDuration = 1;

  const whole = call("audio_to_keyframes", { comp: "Trimmed" });
  assert(whole.ok, "the default covers the whole comp: " + (whole.error || ""));
  assert(whole.data.keyframes === 97,
         "97 keys, not the work area's 25: " + whole.data.keyframes);
  assert(/widened to the whole comp/.test(whole.data.workArea || ""),
         "and it SAYS the work area was widened: " + whole.data.workArea);
  assert(c.workAreaStart === 0.5 && c.workAreaDuration === 1,
         "the user's work area is put back exactly");
  c._layers = c._layers.filter(l => !l.nullLayer);

  const native = call("audio_to_keyframes",
                      { comp: "Trimmed", range: "workArea" });
  assert(native.ok && native.data.keyframes === 25,
         "range:'workArea' keeps AE's own behaviour: " + native.data.keyframes);
  assert(Math.abs(native.data.rangeStart - 0.5) < 1e-6 &&
         Math.abs(native.data.rangeEnd - 1.5) < 1e-6,
         "and reports the range it really covered");
  assert(/WORK AREA only/.test(native.data.workArea || ""),
         "which is stated in the result rather than left to be discovered");
  c._layers = c._layers.filter(l => !l.nullLayer);

  const bad = call("audio_to_keyframes", { comp: "Trimmed", range: "half" });
  assert(!bad.ok && /'comp'/.test(bad.error) && /workArea/.test(bad.error),
         "an unknown range is refused with the real choices: " + bad.error);

  // A comp whose work area is already the whole thing gets no caveat.
  c.workAreaStart = 0; c.workAreaDuration = 4;
  const full = call("audio_to_keyframes", { comp: "Trimmed" });
  assert(full.ok && !full.data.workArea,
         "an untrimmed work area produces no work-area note");
}

// -------------------------------- 9. it converts the comp it was ASKED for

{
  const other = makeComp("Elsewhere", 2, 24);
  other.openInViewer();
  const r = call("audio_to_keyframes", { comp: "Band" });
  assert(r.ok, "a comp that is not in the viewer still converts: " +
         (r.error || ""));
  assert(project.activeItem.name === "Band",
         "because the tool opens it first — AE converts the ACTIVE comp");
  assert(other._layers.length === 0, "nothing landed in the wrong comp");
  bandComp._layers = bandComp._layers.filter(l => !l.nullLayer);
}

// ---------------------------------------- 10. wiring: docs and undo group

{
  assert(AELL_MUTATING.audio_to_keyframes === true,
         "audio_to_keyframes is registered as MUTATING (one Ctrl+Z undoes it)");
  assert(typeof AELL_TOOLS.audio_to_keyframes === "function",
         "the tool is registered on AELL_TOOLS");
  assert(/name:\s*"audio_to_keyframes"/.test(toolsSrc),
         "the tool is DOCUMENTED in tools.js — an undocumented tool is " +
         "unreachable by the model");
  const doc = toolsSrc.split('name: "audio_to_keyframes"')[1].slice(0, 1400);
  assert(/mutating: true/.test(doc), "documented as mutating");
  assert(/link_property/.test(doc),
         "the docs point at link_property, which is what makes it useful");
  assert(/range\?/.test(doc) && /layer\?/.test(doc),
         "the docs carry the args the tool actually reads");
  assert(/work area/i.test(doc),
         "the docs warn about AE's work-area bound");
  // The exact command string is measured, not stylistic — pin it.
  assert(/"Convert Audio to Keyframes"/.test(hostSrc),
         "the host uses AE's exact menu-command spelling");
}

console.log("\n" + (process.exitCode ? "SOME TESTS FAILED"
                                     : "ALL TESTS PASSED") +
            " (" + checks + " checks)");
