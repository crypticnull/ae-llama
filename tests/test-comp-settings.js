// Regression test: set_comp_setting reaching the WORK AREA and the comp
// RESOLUTION (the two settings the self-test suite could not touch, so
// audio_to_keyframes' range:'workArea' and snapshot_frame's resolution
// override were proven by stubs alone).
//
// Every rule the stub below enforces was measured against real AE 2026
// (logs/probe-cs.txt), because AE does NOT behave the way a setter
// usually does:
//
//  1. A work-area write SNAPS to the comp's frame grid, silently. On a
//     24 fps comp, 0.333s reads back as exactly 8 frames (0.33333s) and
//     1.7s as 41 frames (1.70833s).
//  2. An out-of-range work-area write THROWS — it does not clamp:
//     "Unable to set workAreaDuration. Value 99 out of range 0.04 to 4."
//  3. The legal range for workAreaDuration is computed from the CURRENT
//     start, so widening from a late start throws ("out of range 0.04 to
//     1" with the start at 3s) unless the START is written FIRST.
//  4. A workAreaStart write does NOT throw when the current duration
//     overhangs the comp: it shortens the duration instead (start 3.9 on
//     a 4s comp with a 4s work area came back start 3.91667 dur 0.08333).
//  5. workAreaStart is legal from 0 to comp.duration - one frame;
//     workAreaDuration from one frame to comp.duration - start. Zero and
//     negatives throw.
//  6. Shortening comp.duration drags the work area in with it, silently.
//  7. resolutionFactor is [x, y] whole numbers 1..99. A bare number, a
//     one-element array, a fraction, 0 and -1 all throw. A NON-UNIFORM
//     pair ([1, 3]) is legal.
//  8. Layer outPoints survive a comp shortened and restored.
//  9. And the one that cost a real bug: a workAreaStart write that lands
//     exactly on the work area's own current END comes back ONE FRAME
//     EARLY and one frame LONG. On a 3s/24fps comp, [0..24] frames with
//     workAreaStart = 1s gives [23..48], silently, while the same write
//     from any other state is exact. Widening to the whole comp first
//     makes every target exact - which is why the tool does.
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
function near(a, b) { return Math.abs(Number(a) - Number(b)) < 0.0005; }

// ------------------------------------------------------------ stubbed AE

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};

function snap(t, fd) { return Math.round(Number(t) / fd) * fd; }
function r2(n) { return Math.round(Number(n) * 100) / 100; }

function Comp(name, w, h, dur, fps) {
  this.name = name;
  this.width = w;
  this.height = h;
  this.pixelAspect = 1;
  this.bgColor = [0, 0, 0];
  this.numLayers = 0;
  this._fps = fps;
  this._dur = dur;
  this._waStart = 0;
  this._waDur = dur;
  this._rf = [1, 1];
  this.layers = { addSolid: () => { this.numLayers++; return {}; } };
}
Object.setPrototypeOf(Comp.prototype, CompItem.prototype);
Object.defineProperty(Comp.prototype, "frameRate", {
  get() { return this._fps; },
  set(v) { this._fps = Number(v); }
});
Object.defineProperty(Comp.prototype, "frameDuration", {
  get() { return 1 / this._fps; }
});
Object.defineProperty(Comp.prototype, "duration", {
  get() { return this._dur; },
  set(v) {
    this._dur = Number(v);
    // FACT 6: the work area comes along quietly.
    if (this._waStart > this._dur - this.frameDuration) {
      this._waStart = Math.max(0, snap(this._dur - this.frameDuration,
                                       this.frameDuration));
    }
    if (this._waStart + this._waDur > this._dur) {
      this._waDur = this._dur - this._waStart;
    }
  }
});
Object.defineProperty(Comp.prototype, "workAreaStart", {
  get() { return this._waStart; },
  set(v) {
    const fd = this.frameDuration;
    const hi = this._dur - fd;
    if (!(Number(v) >= 0) || Number(v) > hi + 1e-9) {      // FACT 2 + 5
      throw new Error("After Effects error: Unable to set " +
        "“workAreaStart”. Value " + v + " out of range 0 to " +
        r2(hi) + ".");
    }
    const s = snap(v, fd);                                  // FACT 1
    // FACT 9: a start written onto the work area's own current END comes
    // back one frame EARLY and one frame LONG.
    const end = this._waStart + this._waDur;
    if (Math.abs(s - end) < fd / 2) {
      this._waStart = s - fd;
      this._waDur = this._waDur + fd;
      return;
    }
    this._waStart = s;
    // FACT 4: an overhanging duration is shortened, not refused.
    if (this._waStart + this._waDur > this._dur) {
      this._waDur = snap(this._dur - this._waStart, fd);
    }
  }
});
Object.defineProperty(Comp.prototype, "workAreaDuration", {
  get() { return this._waDur; },
  set(v) {
    const fd = this.frameDuration;
    const hi = this._dur - this._waStart;                   // FACT 3
    if (!(Number(v) >= fd - 1e-9) || Number(v) > hi + 1e-9) {
      throw new Error("After Effects error: Unable to set " +
        "“workAreaDuration”. Value " + v + " out of range " +
        r2(fd) + " to " + r2(hi) + ".");
    }
    this._waDur = snap(v, fd);                              // FACT 1
  }
});
Object.defineProperty(Comp.prototype, "resolutionFactor", {
  get() { return [this._rf[0], this._rf[1]]; },
  set(v) {                                                  // FACT 7
    if (!Array.isArray(v)) {
      throw new Error("After Effects error: Unable to set " +
        "“resolutionFactor”. Value is not an array.");
    }
    if (v.length !== 2) {
      throw new Error("After Effects error: Unable to set " +
        "“resolutionFactor”. Given resolutionFactor does not " +
        "have 2 values.");
    }
    for (let i = 0; i < 2; i++) {
      if (Math.floor(v[i]) !== v[i]) {
        throw new Error("After Effects error: Unable to set " +
          "“resolutionFactor”. Value “" + v[i] +
          "” of element " + i + " in the resolutionFactor is not a " +
          "valid int.");
      }
      if (v[i] < 1 || v[i] > 99) {
        throw new Error("After Effects error: Unable to set " +
          "“resolutionFactor”. Value “" + v[i] +
          "” of element " + i + " in the resolutionFactor is not " +
          "between 1 and 99.");
      }
    }
    this._rf = [v[0], v[1]];
  }
});

const project = {
  _items: [],
  activeItem: null,
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  items: {
    addComp(name, w, h, par, dur, fps) {
      const c = new Comp(name, w, h, dur, fps);
      project._items.push(c);
      return c;
    }
  }
};
const app = {
  project: project, version: "26.3x87",
  beginUndoGroup() {}, endUndoGroup() {}, executeCommand() {},
  findMenuCommandId() { return 0; },
  beginSuppressDialogs() {}, endSuppressDialogs() {}
};
const $ = { global: {}, hiresTimer: 0, sleep() {} };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool, " +
  "AELL_NO_UNDO_GROUP: AELL_NO_UNDO_GROUP })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool, AELL_NO_UNDO_GROUP } = host;
const call = (t, a) => AELL_runTool(t, a || {});

const shot = project.items.addComp("Shot", 640, 480, 1, 4, 24);
project.activeItem = shot;
shot.layers.addSolid();
const FD = 1 / 24;

// ------------------------------------------------ 1. the stub is faithful
//
// Drive the raw API first: a stub that quietly stopped modelling AE's
// refusals would let the tool pass on a technicality.
{
  shot.workAreaStart = 0.333;
  assert(near(shot.workAreaStart, 8 * FD),
         "STUB FIDELITY: 0.333s snaps to frame 8 (FACT 1)");
  shot.workAreaStart = 0;
  shot.workAreaDuration = 4;

  let threw = "";
  try { shot.workAreaDuration = 99; } catch (e) { threw = String(e); }
  assert(/out of range 0.04 to 4/.test(threw),
         "STUB FIDELITY: an over-long work area THROWS, it does not clamp " +
         "(FACT 2)");

  threw = "";
  try { shot.workAreaDuration = 0; } catch (e) { threw = String(e); }
  assert(/out of range/.test(threw),
         "STUB FIDELITY: a zero-length work area throws (FACT 5)");

  shot.workAreaStart = 3;
  shot.workAreaDuration = 1;
  threw = "";
  try { shot.workAreaDuration = 4; } catch (e) { threw = String(e); }
  assert(/out of range 0.04 to 1/.test(threw),
         "STUB FIDELITY: duration is ranged against the CURRENT start, so " +
         "duration-before-start throws (FACT 3)");

  shot.workAreaStart = 0;
  shot.workAreaDuration = 4;
  shot.workAreaStart = 3.9;
  assert(near(shot.workAreaStart, 3.91667) &&
         near(shot.workAreaDuration, 2 * FD),
         "STUB FIDELITY: a late start SHORTENS an overhanging duration " +
         "instead of refusing (FACT 4)");

  shot.workAreaStart = 0;
  shot.workAreaDuration = 4;
  shot.duration = 2;
  assert(near(shot.workAreaDuration, 2),
         "STUB FIDELITY: shortening the comp drags the work area in (FACT 6)");
  shot.duration = 4;
  shot.workAreaStart = 0;
  shot.workAreaDuration = 4;

  const rejects = [[0, 0], [-1, -1], [2.5, 2.5], [2], 2];
  let allThrew = true;
  for (const bad of rejects) {
    try { shot.resolutionFactor = bad; allThrew = false; } catch (e) {}
  }
  assert(allThrew,
         "STUB FIDELITY: 0, -1, a fraction, a short array and a bare " +
         "number are all refused resolutions (FACT 7)");
  shot.resolutionFactor = [1, 3];
  assert(shot.resolutionFactor[0] === 1 && shot.resolutionFactor[1] === 3,
         "STUB FIDELITY: a NON-UNIFORM resolution pair is legal (FACT 7)");
  shot.resolutionFactor = [1, 1];

  shot.workAreaStart = 0;
  shot.workAreaDuration = 1;
  shot.workAreaStart = 1;                                   // FACT 9
  assert(near(shot.workAreaStart, 23 * FD) &&
         near(shot.workAreaDuration, 25 * FD),
         "STUB FIDELITY: a start written onto the work area's own end " +
         "comes back a frame early and a frame long (FACT 9)");
  shot.workAreaStart = 0;
  shot.workAreaDuration = 4;
}

// ------------------------------------------------------ 2. the work area

{
  const r = call("set_comp_setting",
                 { comp: "Shot", workAreaStart: 1, workAreaDuration: 2 });
  assert(r.ok, "a work area can be set at all: " + (r.error || ""));
  assert(near(shot.workAreaStart, 1) && near(shot.workAreaDuration, 2),
         "and AE really holds 1s-3s");
  assert(r.data.workArea === "1s-3s",
         "the result SAYS the range, not just the numbers: " +
         r.data.workArea);
  assert(near(r.data.workAreaStart, 1) && near(r.data.workAreaDuration, 2),
         "and reports both halves as numbers a follow-up can use");
  assert(/workArea/.test(r.data.changed),
         "and lists what it changed: " + r.data.changed);
}

{
  // The order trap of FACT 3: widening from a late start. The tool must
  // write the START first or AE throws.
  const r = call("set_comp_setting",
                 { comp: "Shot", workAreaStart: 0, workAreaEnd: 4 });
  assert(r.ok, "widening from a late start does not throw: " + (r.error || ""));
  assert(near(shot.workAreaStart, 0) && near(shot.workAreaDuration, 4),
         "the whole comp is the work area again");
}

{
  const r = call("set_comp_setting",
                 { comp: "Shot", workAreaStart: 1, workAreaEnd: 2.5 });
  assert(r.ok && near(shot.workAreaDuration, 1.5),
         "workAreaEnd is turned into a duration: " +
         shot.workAreaDuration);
  assert(r.data.workArea === "1s-2.5s",
         "and the reported range is the one asked for: " + r.data.workArea);
}

{
  const r = call("set_comp_setting", { comp: "Shot", workArea: "comp" });
  assert(r.ok && near(shot.workAreaStart, 0) && near(shot.workAreaDuration, 4),
         "workArea:'comp' resets it to the whole comp");
  const bad = call("set_comp_setting", { comp: "Shot", workArea: "selection" });
  assert(!bad.ok && /workAreaStart/.test(bad.error) &&
         /'comp'/.test(bad.error),
         "and an unknown word is refused with what IS accepted: " +
         bad.error);
}

{
  // FACT 1 out loud: a snap is a silent change, so the tool says it.
  const r = call("set_comp_setting", { comp: "Shot", workAreaStart: 0.333,
                                       workAreaDuration: 1.7 });
  assert(r.ok && near(shot.workAreaStart, 8 * FD) &&
         near(shot.workAreaDuration, 41 * FD),
         "off-grid times land on the frame grid: " + shot.workAreaStart +
         " / " + shot.workAreaDuration);
  assert(/snapped to the frame grid/.test(r.data.note || "") &&
         /frame 8/.test(r.data.note || ""),
         "and the snap is REPORTED, with the frame number: " + r.data.note);
}

{
  // A start-only move that overhangs: AE shortens it silently, we say so.
  call("set_comp_setting", { comp: "Shot", workArea: "comp" });
  const r = call("set_comp_setting", { comp: "Shot", workAreaStart: 3 });
  assert(r.ok && near(shot.workAreaDuration, 1),
         "moving only the start keeps the work area inside the comp: " +
         shot.workAreaDuration);
  assert(/shorter than/.test(r.data.note || ""),
         "and the shortening is spoken: " + r.data.note);
}

{
  // FACT 9 through the tool: the same target, from the state that trips
  // AE up. audio_to_keyframes restored a work area with the naive order
  // and moved it a frame every time; the real-AE suite caught it.
  const rig = call("set_comp_setting",
                   { comp: "Shot", workAreaStart: 0, workAreaDuration: 1 });
  assert(rig.ok && near(shot.workAreaStart, 0) &&
         near(shot.workAreaDuration, 1), "rig the colliding state, 0s-1s");
  const r = call("set_comp_setting",
                 { comp: "Shot", workAreaStart: 1, workAreaDuration: 1 });
  assert(r.ok && near(shot.workAreaStart, 1) &&
         near(shot.workAreaDuration, 1),
         "a start that lands on the work area's own end is still EXACT: " +
         shot.workAreaStart + " / " + shot.workAreaDuration);
  assert(r.data.workArea === "1s-2s",
         "and the result says so: " + r.data.workArea);
  assert(!/snapped/.test(r.data.note || ""),
         "with no snap note — nothing was off the grid: " + r.data.note);
}

// --------------------------------------------- 3. work-area refusals

{
  call("set_comp_setting", { comp: "Shot", workArea: "comp" });
  const past = call("set_comp_setting",
                    { comp: "Shot", workAreaStart: 1, workAreaDuration: 5 });
  assert(!past.ok && /past the end/.test(past.error) &&
         /3s/.test(past.error),
         "a work area past the comp's end is refused with what DOES fit: " +
         past.error);
  assert(near(shot.workAreaStart, 0) && near(shot.workAreaDuration, 4),
         "and nothing moved");

  const zero = call("set_comp_setting",
                    { comp: "Shot", workAreaDuration: 0 });
  assert(!zero.ok && /holds no frame/.test(zero.error) &&
         /24 fps/.test(zero.error),
         "a zero-length work area is refused in frames, not in AE's raw " +
         "words: " + zero.error);

  const neg = call("set_comp_setting", { comp: "Shot", workAreaStart: -2 });
  assert(!neg.ok && /cannot start before 0/.test(neg.error),
         "a negative start is refused: " + neg.error);

  const late = call("set_comp_setting", { comp: "Shot", workAreaStart: 99 });
  assert(!late.ok && /last frame starts at/.test(late.error),
         "a start past the comp names the last legal frame: " + late.error);

  const both = call("set_comp_setting", { comp: "Shot", workAreaStart: 1,
                                          workAreaDuration: 1,
                                          workAreaEnd: 3 });
  assert(!both.ok && /OR workAreaEnd/.test(both.error),
         "duration AND end together is refused, with the arithmetic: " +
         both.error);
  assert(near(shot.workAreaStart, 0) && near(shot.workAreaDuration, 4),
         "and the contradictory call changed nothing");
}

// ------------------------------------------------------ 4. resolution

{
  const half = call("set_comp_setting", { comp: "Shot", resolution: "half" });
  assert(half.ok && shot.resolutionFactor[0] === 2 &&
         shot.resolutionFactor[1] === 2, "resolution:'half' is [2, 2]");
  assert(half.data.resolution === "half [2, 2]",
         "and the result names it AND shows the pair: " +
         half.data.resolution);

  assert(call("set_comp_setting", { comp: "Shot", resolution: "third" }).ok &&
         shot.resolutionFactor[0] === 3, "'third' is [3, 3]");
  assert(call("set_comp_setting", { comp: "Shot", resolution: "quarter" }).ok &&
         shot.resolutionFactor[0] === 4, "'quarter' is [4, 4]");
  assert(call("set_comp_setting", { comp: "Shot", resolution: 2 }).ok &&
         shot.resolutionFactor[0] === 2, "a bare downsample factor works");
  assert(call("set_comp_setting", { comp: "Shot", resolution: "2" }).ok &&
         shot.resolutionFactor[0] === 2,
         "and so does the quoted number a small model sends");

  const pair = call("set_comp_setting", { comp: "Shot", resolution: [1, 3] });
  assert(pair.ok && pair.data.resolution === "custom [1, 3]",
         "a non-uniform pair is legal and reads as custom: " +
         pair.data.resolution);

  const full = call("set_comp_setting", { comp: "Shot", resolution: "full" });
  assert(full.ok && shot.resolutionFactor[0] === 1 &&
         full.data.resolution === "full [1, 1]", "'full' is [1, 1]");
}

{
  const named = call("set_comp_setting", { comp: "Shot", resolution: "low" });
  assert(!named.ok && /'half' \(2\)/.test(named.error),
         "an unknown name is refused with the real ones: " + named.error);

  const zero = call("set_comp_setting", { comp: "Shot", resolution: 0 });
  assert(!zero.ok && /whole number from 1/.test(zero.error),
         "0 is refused BEFORE AE throws: " + zero.error);

  const frac = call("set_comp_setting", { comp: "Shot", resolution: 2.5 });
  assert(!frac.ok && /whole number/.test(frac.error),
         "a fraction is refused: " + frac.error);

  const one = call("set_comp_setting", { comp: "Shot", resolution: [2] });
  assert(!one.ok && /exactly two values/.test(one.error),
         "a one-element array is refused: " + one.error);

  assert(shot.resolutionFactor[0] === 1 && shot.resolutionFactor[1] === 1,
         "and every refusal left the comp at full resolution");
}

// -------------------------------- 5. the settings that already shipped

{
  const r = call("set_comp_setting", { comp: "Shot", width: 800, height: 600,
                                       duration: 6, frameRate: 24,
                                       bgColor: [1, 0, 0] });
  assert(r.ok && r.data.width === 800 && r.data.height === 600 &&
         near(r.data.duration, 6) && near(r.data.frameRate, 24),
         "the old arguments still work");
  assert(r.data.bgColor && near(r.data.bgColor[0], 1) &&
         near(r.data.bgColor[2], 0),
         "and bgColor is now REPORTED, not just written: " +
         JSON.stringify(r.data.bgColor));
  assert(/scale_comp/.test(r.data.note || ""),
         "a resize with layers in the comp names scale_comp: " + r.data.note);
}

{
  // FACT 6: the silent drag, now spoken.
  call("set_comp_setting", { comp: "Shot", duration: 6, workArea: "comp" });
  const r = call("set_comp_setting", { comp: "Shot", duration: 2 });
  assert(r.ok && near(shot.workAreaDuration, 2),
         "shortening the comp shortens the work area");
  assert(/pulled the work area in with it/.test(r.data.note || ""),
         "and the tool says so instead of letting it happen quietly: " +
         r.data.note);
  call("set_comp_setting", { comp: "Shot", duration: 4, workArea: "comp" });
}

{
  const nothing = call("set_comp_setting", { comp: "Shot" });
  assert(!nothing.ok && /workAreaStart/.test(nothing.error) &&
         /resolution/.test(nothing.error) && /bgColor/.test(nothing.error),
         "a call with no setting in it is refused with the whole menu: " +
         nothing.error);
}

// ---------------------------------------------- 6. wiring and the docs

{
  assert(AELL_MUTATING.set_comp_setting === true,
         "set_comp_setting is still registered as mutating (one Ctrl+Z)");
  assert(!AELL_NO_UNDO_GROUP || !AELL_NO_UNDO_GROUP.set_comp_setting,
         "and is not exempt from the undo group");

  const docs = toolsSrc.slice(toolsSrc.indexOf("set_comp_setting"),
                              toolsSrc.indexOf("set_comp_setting") + 1200);
  assert(/workAreaStart/.test(docs) && /workAreaEnd/.test(docs),
         "the work area is documented, or the model cannot reach it");
  assert(/resolution\?/.test(docs) && /quarter/.test(docs),
         "and so is resolution, with its named values");
}

console.log("\n" + (process.exitCode ? "SOME TESTS FAILED"
                                     : "ALL TESTS PASSED") +
            " (" + checks + " checks)");
