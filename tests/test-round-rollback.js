// Regression test: rolling back a chat round that fails PART WAY.
//
// The bug, field-observed: "make nine red squares and spread them out"
// produced TEN. duplicate_layer errored because add_solid had not made
// the source layer yet; add_solid then succeeded anyway; the model saw a
// failed round and redid the whole thing, building nine more on top of
// the orphan. Every tool behaved correctly — there was simply no notion
// of undoing a partial round.
//
// The facts this file encodes, all MEASURED in AE 2026 before the code
// was written (see WORKPLAN-LOG 2026-08-25):
//
//  1. An EMPTY undo group registers NOTHING. One Undo then reaches
//     straight past it into the user's own previous edit. This is the
//     overshoot hazard, and it is why the sentinel exists — the stub
//     below models it exactly, so a rollback that forgets the sentinel
//     is caught here rather than in someone's project.
//  2. A net-zero comment write (set, then put back) DOES register a
//     group, leaving the project byte-identical.
//  3. Exactly ONE Undo is ever issued, inside the same script execution
//     that made the changes. If the fingerprint says it did not land on
//     the pre-round state, a single Redo puts it back — never a second
//     Undo.
//
// The scenario tools here stand in for add_solid/duplicate_layer rather
// than driving the real ones: the subject is the rollback dispatcher,
// and stubbing all of AE would test the stub instead.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HOST = path.join(ROOT, "extension", "jsx", "hostscript.jsx");
const TOOLS = path.join(ROOT, "extension", "js", "tools.js");
const hostSrc = fs.readFileSync(HOST, "utf8");
const toolsSrc = fs.readFileSync(TOOLS, "utf8");

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------------------ stubbed AE
//
// An undo STACK, not just a depth counter: mutations record how to
// reverse themselves, endUndoGroup pushes the frame, and executeCommand
// pops it. Empty frames are dropped on the floor, which is the AE
// behaviour the whole design turns on.

const undo = {
  open: null, depth: 0, stack: [], redo: [],
  opened: [], unbalanced: 0, undos: 0, redos: 0
};
function record(op) {
  if (undo.open) { undo.open.ops.push(op); return; }
  // A change made outside any group is its own undo step in AE.
  undo.stack.push({ name: "(ungrouped)", ops: [op] });
  undo.redo.length = 0;
}
function resetUndo() {
  undo.open = null; undo.depth = 0;
  undo.stack.length = 0; undo.redo.length = 0; undo.opened.length = 0;
  undo.unbalanced = 0; undo.undos = 0; undo.redos = 0;
}

// Write a field the way AE writes it: the new value AND the step that
// puts the old one back. `tear` skips the recording, which models a
// change the undo stack cannot reverse -- the only thing that can make
// the post-Undo fingerprint differ, and therefore the only thing the
// verification can ever catch.
function setRec(obj, key, next, tear) {
  const old = obj[key];
  obj[key] = next;
  if (tear) return;
  record({ undo() { obj[key] = old; }, redo() { obj[key] = next; } });
}

// A marker property, backed by an array of times. AE's own add_marker
// REPLACES a marker already at that time (measured, item 5.4), so the
// count alone cannot tell a replacement from a no-op.
function MarkerProp(owner) { this._t = []; this._owner = owner; }
Object.defineProperty(MarkerProp.prototype, "numKeys", {
  get() { return this._t.length; }
});
MarkerProp.prototype.keyTime = function (i) { return this._t[i - 1]; };
MarkerProp.prototype.add = function (t, tear) {
  const self = this, next = this._t.concat([t]).sort((a, b) => a - b);
  const old = this._t;
  this._t = next;
  if (tear) return;
  record({ undo() { self._t = old; }, redo() { self._t = next; } });
};

// A leaf transform property with real keyframe/ease writes, each
// recorded on the undo stack the way AE records them — what lets the
// REAL set_keyframes and apply_keyframe_ease run against this stub
// instead of a stand-in, so their partial-failure returns are the
// actual code under test.
function KeyProp(name, matchName, value) {
  this.name = name;
  this.matchName = matchName;
  this._v = value;
  this._keys = [];              // sorted [{time, value, eases…}]
  this.canSetExpression = true; // not a dormant animator slot
}
Object.defineProperty(KeyProp.prototype, "value", {
  get() { return this._v; }
});
Object.defineProperty(KeyProp.prototype, "numKeys", {
  get() { return this._keys.length; }
});
KeyProp.prototype.setValue = function (v) {
  const self = this, old = this._v;
  this._v = v;
  record({ undo() { self._v = old; }, redo() { self._v = v; } });
};
KeyProp.prototype.setValueAtTime = function (t, v) {
  // AE rejects a value the property cannot hold; the stub's stand-in
  // for that refusal is any non-numeric scalar.
  if (typeof v !== "number" && !Array.isArray(v)) {
    throw new Error("value is not a Number");
  }
  const self = this, old = this._keys;
  const next = old.concat([{ time: t, value: v }])
    .sort((a, b) => a.time - b.time);
  this._keys = next;
  record({ undo() { self._keys = old; }, redo() { self._keys = next; } });
};
KeyProp.prototype.keyTime = function (i) { return this._keys[i - 1].time; };
KeyProp.prototype.keyValue = function (i) { return this._keys[i - 1].value; };
KeyProp.prototype.setInterpolationTypeAtKey = function (i, inT, outT) {
  const k = this._keys[i - 1], wasI = k.interpIn, wasO = k.interpOut;
  k.interpIn = inT; k.interpOut = outT;
  record({ undo() { k.interpIn = wasI; k.interpOut = wasO; },
           redo() { k.interpIn = inT; k.interpOut = outT; } });
};
KeyProp.prototype.setTemporalEaseAtKey = function (i, inE, outE) {
  const k = this._keys[i - 1], wasI = k.inEase, wasO = k.outEase;
  k.inEase = inE; k.outEase = outE;
  record({ undo() { k.inEase = wasI; k.outEase = wasO; },
           redo() { k.inEase = inE; k.outEase = outE; } });
};
KeyProp.prototype.keyInTemporalEase = function (i) {
  return this._keys[i - 1].inEase || null;
};
KeyProp.prototype.keyOutTemporalEase = function (i) {
  return this._keys[i - 1].outEase || null;
};

function KeyframeEase(speed, influence) {
  this.speed = speed;
  this.influence = influence;
}
const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613,
                                    HOLD: 6614 };

function Layer(name, comp) {
  this.name = name;
  this.comp = comp;
  this.enabled = true;
  this.parent = null;
  this.inPoint = 0; this.outPoint = 10; this.startTime = 0;
  this._t = {
    "ADBE Position": new KeyProp("Position", "ADBE Position",
                                 [320, 180, 0]),
    "ADBE Scale": new KeyProp("Scale", "ADBE Scale", [100, 100, 100]),
    "ADBE Rotate Z": new KeyProp("Rotation", "ADBE Rotate Z", 0),
    "ADBE Opacity": new KeyProp("Opacity", "ADBE Opacity", 100)
  };
  // Every one of these was measured in AE 2026 (probe 3, 2026-08-29) as
  // written by a tool in AELL_MUTATING, reverted by the single Undo, and
  // INVISIBLE to the fingerprint before this. A stub that omitted them
  // would let a fingerprint that still ignores them pass.
  this.threeDLayer = false;
  this.shy = false;
  this.locked = false;
  this.motionBlur = false;
  this.adjustmentLayer = false;
  this.audioEnabled = true;
  this.collapseTransformation = false;
  this.blendingMode = 5212;                 // BlendingMode.NORMAL
  this._rot = { x: 0, y: 0, o: [0, 0, 0] };
  this._markers = new MarkerProp(this);
}
Layer.prototype.property = function (p) {
  const self = this;
  if (p === "ADBE Transform Group") {
    return {
      property(n) {
        if (self._t[n]) return self._t[n];
        // AE answers the 3D-only rotations on a 2D layer too — they read
        // as a stable 0 rather than throwing, which is exactly why
        // set_layer_3d can zero them without the fingerprint noticing.
        if (n === "ADBE Rotate X") return { value: self._rot.x, numKeys: 0 };
        if (n === "ADBE Rotate Y") return { value: self._rot.y, numKeys: 0 };
        if (n === "ADBE Orientation") return { value: self._rot.o, numKeys: 0 };
        throw new Error("no property " + n);
      }
    };
  }
  if (p === "ADBE Marker") return this._markers;
  if (p === "ADBE Effect Parade") return { numProperties: 0 };
  if (p === "ADBE Mask Parade") return { numProperties: 0 };
  throw new Error("no property " + p);
};

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};

function Comp(name) {
  this.name = name;
  this.width = 640; this.height = 360;
  this.duration = 10; this.frameRate = 30;
  this._comment = "";
  this._layers = [];
  this.parentFolder = null;
  // Composition Settings, i.e. everything set_comp_setting can write.
  // Same measurement as the layer switches: undoable in AE, and invisible
  // to the fingerprint until 2026-08-29.
  this.bgColor = [0, 0, 0];
  this.resolutionFactor = [1, 1];
  this.workAreaStart = 0;
  this.workAreaDuration = 10;
  this.pixelAspect = 1;
  this.displayStartTime = 0;
  this.motionBlur = false;
  this.shutterAngle = 180;
  this.shutterPhase = 0;
  this.frameBlending = false;
  this.hideShyLayers = false;
  this.preserveNestedFrameRate = false;
  this.preserveNestedResolution = false;
  this.markerProperty = new MarkerProp(this);
}
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { return this._layers.length; }
});
// The sentinel's target. AE records a comment write as a real, undoable
// change — and writing the SAME value back is a second one, so a
// set-and-restore pair leaves a non-empty group and an unchanged project.
Object.defineProperty(Comp.prototype, "comment", {
  get() { return this._comment; },
  set(v) {
    const self = this, old = this._comment, next = String(v);
    if (old === next) return;          // no change, nothing to record
    this._comment = next;
    record({ undo() { self._comment = old; },
             redo() { self._comment = next; } });
  }
});
Comp.prototype.layer = function (i) { return this._layers[i - 1]; };

function makeComp(name) {
  const c = new Comp(name);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  return c;
}

let folderAddThrows = false;
const project = {
  _items: [],
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  renderQueue: { numItems: 0 },
  rootFolder: { name: "(root)" },
  items: {
    addComp(name) {
      const c = makeComp(name);
      project._items.push(c);
      record({ undo() {
                 const k = project._items.indexOf(c);
                 if (k >= 0) project._items.splice(k, 1);
               },
               redo() { project._items.push(c); } });
      return c;
    },
    addFolder(name) {
      if (folderAddThrows) throw new Error("no folders here");
      const f = { name, remove() {
        const k = project._items.indexOf(f);
        if (k >= 0) project._items.splice(k, 1);
        record({ undo() { project._items.push(f); },
                 redo() {
                   const j = project._items.indexOf(f);
                   if (j >= 0) project._items.splice(j, 1);
                 } });
      } };
      Object.setPrototypeOf(f, FolderItem.prototype);
      project._items.push(f);
      record({ undo() {
                 const k = project._items.indexOf(f);
                 if (k >= 0) project._items.splice(k, 1);
               },
               redo() { project._items.push(f); } });
      return f;
    }
  }
};

const app = {
  project,
  beginUndoGroup(name) {
    undo.depth++;
    undo.opened.push(name);
    if (undo.depth === 1) undo.open = { name, ops: [] };
  },
  endUndoGroup() {
    if (undo.depth === 0) { undo.unbalanced++; return; }
    undo.depth--;
    if (undo.depth > 0) return;
    // MEASURED: an empty group is not pushed at all.
    if (undo.open.ops.length) {
      undo.stack.push(undo.open);
      undo.redo.length = 0;
    }
    undo.open = null;
  },
  executeCommand(id) {
    if (id === 16) {
      undo.undos++;
      const g = undo.stack.pop();
      if (!g) return;
      for (let i = g.ops.length - 1; i >= 0; i--) g.ops[i].undo();
      undo.redo.push(g);
    } else if (id === 17) {
      undo.redos++;
      const g = undo.redo.pop();
      if (!g) return;
      for (let i = 0; i < g.ops.length; i++) g.ops[i].redo();
      undo.stack.push(g);
    }
  }
};

const $ = { global: {} };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_okay: AELL_okay, AELL_err: AELL_err, " +
  "AELL_errPartial: AELL_errPartial, AELL_fingerprint: AELL_fingerprint, " +
  "AELL_sentinel: AELL_sentinel })");
const { AELL_TOOLS, AELL_MUTATING, AELL_okay, AELL_err, AELL_errPartial,
        AELL_fingerprint, AELL_sentinel } = host;

// ------------------------------------------------------- scenario tools

const comp = project.items.addComp("Rollback scratch");

// A solid's colour lives on the project ITEM, so set_solid_color changes
// something no walk of the comp's layers can reach. The fingerprint has
// to read it off the footage item or it cannot see that tool at all.
const solidItem = (function () {
  const src = { color: [1, 0, 0] };
  Object.setPrototypeOf(src, SolidSource.prototype);
  const it = { name: "Red Solid", width: 100, height: 100, comment: "",
               parentFolder: null, mainSource: src };
  Object.setPrototypeOf(it, FootageItem.prototype);
  project._items.push(it);
  return it;
})();

function squares() {
  return comp._layers.filter(l => /^Square/.test(l.name));
}
function addLayer(name) {
  const L = new Layer(name, comp);
  comp._layers.push(L);
  record({ undo() {
             const k = comp._layers.indexOf(L);
             if (k >= 0) comp._layers.splice(k, 1);
           },
           redo() { comp._layers.push(L); } });
  return L;
}

// stands in for add_solid
AELL_TOOLS.__square = function (a) {
  const L = addLayer(String(a.name || ("Square " + (squares().length + 1))));
  return AELL_okay({ name: L.name });
};
// stands in for duplicate_layer — grounded error when there is no source,
// which is exactly how the field bug started
AELL_TOOLS.__dup = function (a) {
  const src = squares()[0];
  if (!src) {
    return AELL_err("No layer to duplicate. Layers here: " +
      (comp._layers.map(l => l.name).join(", ") || "(none)"));
  }
  const n = Math.max(1, Number(a.count) || 1);
  for (let i = 0; i < n; i++) addLayer("Square " + (squares().length + 1));
  return AELL_okay({ made: n });
};
// stands in for for_each_layer giving up after changing things
AELL_TOOLS.__partial = function () {
  addLayer("Half done");
  return AELL_errPartial("Stopped after 5 failures (1 layer was already " +
                         "changed before that).");
};
// mutates nothing, just fails
AELL_TOOLS.__failMut = function () { return AELL_err("mutating tool failed"); };
// changes something the undo system cannot reverse (a torn write)
AELL_TOOLS.__ghost = function () {
  const L = new Layer("Ghost", comp);
  comp._layers.push(L);          // deliberately NOT recorded
  return AELL_okay({ name: "Ghost" });
};
AELL_TOOLS.__read = function () { return AELL_okay({ read: true }); };
AELL_TOOLS.__readFail = function () { return AELL_err("bad lookup"); };

// One dimension a MUTATING tool can write, named by the tool that writes
// it. `write(tear)` changes it; with tear=true the change is made WITHOUT
// an undo step, so it survives the one Undo. That is the whole test: the
// fingerprint must notice, or AELL_maybeRollback reports a clean
// rollback over a change that is still sitting in the user's project.
const DIMENSIONS = [
  ["comp bgColor (set_comp_setting)", t => setRec(comp, "bgColor", [0, 0, 1], t)],
  ["comp resolutionFactor (set_comp_setting)",
   t => setRec(comp, "resolutionFactor", [2, 2], t)],
  ["comp workAreaStart (set_comp_setting)", t => setRec(comp, "workAreaStart", 1, t)],
  ["comp workAreaDuration (set_comp_setting)",
   t => setRec(comp, "workAreaDuration", 2, t)],
  ["comp pixelAspect", t => setRec(comp, "pixelAspect", 2, t)],
  ["comp displayStartTime", t => setRec(comp, "displayStartTime", 1, t)],
  ["comp motionBlur", t => setRec(comp, "motionBlur", true, t)],
  ["comp shutterAngle", t => setRec(comp, "shutterAngle", 90, t)],
  ["comp frameBlending", t => setRec(comp, "frameBlending", true, t)],
  ["comp hideShyLayers", t => setRec(comp, "hideShyLayers", true, t)],
  ["comp markers (add_marker)", t => comp.markerProperty.add(1, t)],
  ["layer threeDLayer (set_layer_3d)",
   t => setRec(comp._layers[0], "threeDLayer", true, t)],
  ["layer blendingMode", t => setRec(comp._layers[0], "blendingMode", 5216, t)],
  ["layer shy", t => setRec(comp._layers[0], "shy", true, t)],
  ["layer locked", t => setRec(comp._layers[0], "locked", true, t)],
  ["layer motionBlur", t => setRec(comp._layers[0], "motionBlur", true, t)],
  ["layer adjustmentLayer",
   t => setRec(comp._layers[0], "adjustmentLayer", true, t)],
  ["layer audioEnabled", t => setRec(comp._layers[0], "audioEnabled", false, t)],
  ["layer collapseTransformation",
   t => setRec(comp._layers[0], "collapseTransformation", true, t)],
  ["layer markers (add_marker)", t => comp._layers[0]._markers.add(1, t)],
  ["layer rotationX (set_layer_3d's discard)",
   t => setRec(comp._layers[0]._rot, "x", 45, t)],
  ["layer orientation (set_layer_3d's discard)",
   t => setRec(comp._layers[0]._rot, "o", [0, 0, 90], t)],
  ["solid source colour (set_solid_color)",
   t => setRec(solidItem.mainSource, "color", [0, 0, 1], t)]
];

let tearIndex = 0, tearTorn = true;
// Succeeds, having changed exactly one dimension.
AELL_TOOLS.__dim = function () {
  DIMENSIONS[tearIndex][1](tearTorn);
  return AELL_okay({ wrote: DIMENSIONS[tearIndex][0] });
};

AELL_MUTATING.__square = true;
AELL_MUTATING.__dup = true;
AELL_MUTATING.__partial = true;
AELL_MUTATING.__failMut = true;
AELL_MUTATING.__ghost = true;
AELL_MUTATING.__dim = true;

const batch = (cmds, opts) => JSON.parse($.global.AELL_callBatch(
  JSON.stringify(cmds), opts === undefined ? undefined : JSON.stringify(opts)));

const COMP_DEFAULTS = new Comp("defaults");
function reset() {
  comp._layers.length = 0;
  comp._comment = "";
  for (const k in COMP_DEFAULTS) {
    if (k === "name" || k === "_layers" || k === "_comment" ||
        k === "markerProperty") continue;
    comp[k] = Array.isArray(COMP_DEFAULTS[k])
      ? COMP_DEFAULTS[k].slice() : COMP_DEFAULTS[k];
  }
  comp.markerProperty = new MarkerProp(comp);
  solidItem.mainSource.color = [1, 0, 0];
  folderAddThrows = false;
  resetUndo();
}

const ROLL = { rollback: true };

// ------------------------------------------ 0. the stub is faithful first

reset();
app.beginUndoGroup("empty");
app.endUndoGroup();
assert(undo.stack.length === 0,
       "STUB FIDELITY: an empty undo group registers nothing (AE 2026)");

reset();
addLayer("User's own work");
app.beginUndoGroup("empty");
app.endUndoGroup();
app.executeCommand(16);
assert(comp._layers.length === 0,
       "STUB FIDELITY: so one Undo after an empty group eats the " +
       "PREVIOUS edit — the overshoot this design exists to prevent");

reset();
const before0 = AELL_fingerprint();
app.beginUndoGroup("sentinel only");
const armed0 = AELL_sentinel();
app.endUndoGroup();
assert(armed0 === true, "the sentinel reports that it fired");
assert(AELL_fingerprint() === before0,
       "and leaves the project byte-identical (net-zero comment write)");
assert(undo.stack.length === 1,
       "but DOES register an undo group, so an Undo cannot reach past it");

reset();
addLayer("User's own work");
undo.stack.length = 0;            // pretend that edit is older history
addLayer("Older still");
app.beginUndoGroup("sentinel only");
AELL_sentinel();
app.endUndoGroup();
app.executeCommand(16);
assert(comp._layers.length === 2,
       "with the sentinel, one Undo consumes OUR group and the user's " +
       "previous edit survives");

// --------------------------------------- 1. the ten-squares bug, exactly

reset();
const r1 = batch([{ tool: "__dup", args: { count: 8 } },
                  { tool: "__square", args: {} }], ROLL);
assert(r1.ok, "the batch itself still returns ok (per-command results)");
assert(r1.data.rollback && r1.data.rollback.rolledBack === true,
       "a round where one mutating command failed and another succeeded " +
       "is ROLLED BACK");
assert(squares().length === 0,
       "the orphan square is gone — comp is empty again (got " +
       squares().length + ")");
assert(undo.undos === 1, "exactly ONE Undo was issued (got " + undo.undos + ")");
assert(undo.redos === 0, "and no Redo");
assert(r1.data.results.length === 2, "one result per command, still");
assert(r1.data.results.every(x => x.rolledBack === true),
       "every result is marked rolledBack");
assert(r1.data.results.every(x => x.ok === false),
       "including the one that had succeeded — it no longer exists");
assert(/ROLLED BACK/.test(r1.data.results[0].error),
       "the first result carries the full explanation");
assert(/No layer to duplicate/.test(r1.data.results[0].error),
       "with the original grounded error kept: " +
       r1.data.results[0].error.slice(0, 60));
assert(r1.data.results[1].error.length < r1.data.results[0].error.length,
       "later results get the SHORT note (context budget)");

// The retry the model would make — from a clean comp, it lands on nine.
const r1b = batch([{ tool: "__square", args: {} },
                   { tool: "__dup", args: { count: 8 } }], ROLL);
assert(r1b.ok && !r1b.data.rollback,
       "the retry round succeeds and is not rolled back");
assert(squares().length === 9,
       "NINE squares, not ten — the field bug is fixed (got " +
       squares().length + ")");

// And the proof it is the rollback doing it: same two rounds, unarmed.
reset();
batch([{ tool: "__dup", args: { count: 8 } }, { tool: "__square", args: {} }]);
batch([{ tool: "__square", args: {} }, { tool: "__dup", args: { count: 8 } }]);
assert(squares().length === 10,
       "WITHOUT rollback the same two rounds still make ten (got " +
       squares().length + ") — this test can fail, not just pass");

// ------------------------------------------- 2. when NOT to roll back

reset();
const r2 = batch([{ tool: "__square", args: {} },
                  { tool: "__square", args: {} }], ROLL);
assert(!r2.data.rollback && squares().length === 2,
       "a round where everything succeeded is left alone");
assert(undo.undos === 0, "and no Undo is issued at all");

reset();
const r3 = batch([{ tool: "__failMut", args: {} },
                  { tool: "__dup", args: {} }], ROLL);
assert(!r3.data.rollback,
       "a round where every mutating command FAILED has nothing to undo");
assert(undo.undos === 0, "so no Undo is issued");
assert(!r3.data.results[0].rolledBack,
       "and the grounded errors reach the model untouched");

reset();
const r4 = batch([{ tool: "__square", args: {} },
                  { tool: "__readFail", args: {} }], ROLL);
assert(!r4.data.rollback,
       "a failing READ-ONLY tool does not trigger a rollback (approved " +
       "call: a bad lookup leaves no debris)");
assert(squares().length === 1, "the real work stands");
assert(undo.undos === 0, "no Undo issued");

reset();
const r5 = batch([{ tool: "__dup", args: {} },
                  { tool: "__square", args: {} }]);
assert(!r5.data.rollback && squares().length === 1,
       "no rollback at all unless the caller asks for it");
assert(undo.undos === 0, "and no Undo when unarmed");

reset();
const r6 = batch([{ tool: "__read", args: {} },
                  { tool: "__readFail", args: {} }], ROLL);
assert(!r6.data.rollback && undo.opened.length === 0,
       "a read-only batch opens no undo group and costs no fingerprint");

// ----------------------------- 3. a tool that failed AFTER changing things

reset();
const r7 = batch([{ tool: "__partial", args: {} }], ROLL);
assert(r7.data.rollback && r7.data.rollback.rolledBack === true,
       "a single tool that gave up PART WAY rolls its own round back");
assert(comp._layers.length === 0,
       "the half-applied work is gone (got " + comp._layers.length + ")");
assert(undo.undos === 1, "one Undo");

// ----------------- 3b. the REAL partial-mutation tools, not stand-ins
//
// Audit 0.11: set_keyframes and apply_keyframe_ease returned a PLAIN
// AELL_err after keys/eases had already been written, so to
// AELL_maybeRollback the round read as failure-only and never armed —
// half-applied keyframes silently survived an armed round. These cases
// drive the real tools through the batch runner, so the mutated flag on
// their failure is the actual code under test.

const opProp = () => comp._layers[0].property("ADBE Transform Group")
  .property("ADBE Opacity");

reset();
addLayer("Square 1");
undo.stack.length = 0;            // the layer is older history
const kfDirect = AELL_TOOLS.set_keyframes({ comp: "Rollback scratch",
  layer: 1, property: "opacity",
  keys: [{ time: 0, value: 0 }, { time: 1, value: "not-a-number" }] });
assert(!kfDirect.ok && kfDirect.mutated === true,
       "set_keyframes that fails after writing a key reports " +
       "mutated:true: " + (kfDirect.error || "(it succeeded)"));
assert(/1 key\(s\) were applied before this/.test(kfDirect.error),
       "and keeps the message that counts the applied keys");

reset();
addLayer("Square 1");
undo.stack.length = 0;
const rk = batch([{ tool: "set_keyframes", args: { comp: "Rollback scratch",
  layer: 1, property: "opacity",
  keys: [{ time: 0, value: 0 }, { time: 1, value: "not-a-number" }] } }],
  ROLL);
assert(rk.data.rollback && rk.data.rollback.rolledBack === true,
       "an armed round with a part-way set_keyframes now ROLLS BACK");
assert(opProp().numKeys === 0,
       "and the key it did write is gone (got " + opProp().numKeys + ")");
assert(undo.undos === 1, "one Undo (got " + undo.undos + ")");

// a set_keyframes that fails before ANY write stays a plain error — a
// bad lookup with no debris must not spend the round's one Undo.
reset();
addLayer("Square 1");
undo.stack.length = 0;
const kfClean = AELL_TOOLS.set_keyframes({ comp: "Rollback scratch",
  layer: 1, property: "opacity",
  keys: [{ time: 0, value: "not-a-number" }] });
assert(!kfClean.ok && !kfClean.mutated,
       "a first-key failure mutated nothing and says so");

reset();
addLayer("Square 1");
addLayer("Square 2");
opProp().setValueAtTime(0, 0);
opProp().setValueAtTime(1, 100);
undo.stack.length = 0;            // the seeded keys are older history
const easeDirect = AELL_TOOLS.apply_keyframe_ease({
  comp: "Rollback scratch", layers: [1, 2], property: "opacity" });
assert(!easeDirect.ok && easeDirect.mutated === true,
       "apply_keyframe_ease that fails after easing layer 1 reports " +
       "mutated:true: " + (easeDirect.error || "(it succeeded)"));
assert(/1 pair\(s\) eased before this/.test(easeDirect.error),
       "and keeps the message that counts the eased pairs");

reset();
addLayer("Square 1");
addLayer("Square 2");
opProp().setValueAtTime(0, 0);
opProp().setValueAtTime(1, 100);
undo.stack.length = 0;
const re = batch([{ tool: "apply_keyframe_ease",
  args: { comp: "Rollback scratch", layers: [1, 2],
          property: "opacity" } }], ROLL);
assert(re.data.rollback && re.data.rollback.rolledBack === true,
       "an armed round with a part-way apply_keyframe_ease now ROLLS " +
       "BACK (layer 2 has no keys to ease)");
assert(typeof opProp()._keys[0].outEase === "undefined" &&
       typeof opProp()._keys[0].interpIn === "undefined",
       "and layer 1's ease is off again");
assert(opProp().numKeys === 2,
       "while its seeded keys — older history — survive the one Undo");
assert(undo.undos === 1, "one Undo (got " + undo.undos + ")");

// ------------------------------- 4. the safety nets: sentinel and Redo

reset();
comp._layers.length = 0;
project._items.length = 0;        // no comp to write a comment on
folderAddThrows = true;           // and no folder to add either
const r8 = batch([{ tool: "__failMut", args: {} },
                  { tool: "__square", args: {} }], ROLL);
assert(!r8.data.rollback.rolledBack,
       "with no sentinel available the rollback DISARMS itself");
assert(undo.undos === 0,
       "and issues no Undo at all — never on a guess (got " +
       undo.undos + ")");
assert(/could not be rolled back safely/.test(r8.data.rollback.why),
       "saying so: " + r8.data.rollback.why.slice(0, 50));
// The solid goes back with the comp: emptying the project was about
// leaving the sentinel no COMP to write a comment on, and dropping the
// footage item as well quietly cost the fingerprint the only solid
// source in the stub for every test after this one.
project._items.push(comp, solidItem);
folderAddThrows = false;

reset();
const r9 = batch([{ tool: "__ghost", args: {} },
                  { tool: "__square", args: {} },
                  { tool: "__failMut", args: {} }], ROLL);
assert(!r9.data.rollback.rolledBack,
       "when the Undo does not land on the pre-round state, the round is " +
       "reported as NOT rolled back");
assert(undo.undos === 1 && undo.redos === 1,
       "one Undo, then ONE Redo to put it back — never a second Undo " +
       "(undos " + undo.undos + ", redos " + undo.redos + ")");
assert(comp._layers.length === 2,
       "and the work is left exactly where it was — the torn Ghost plus " +
       "the square that succeeded (got " + comp._layers.length + ")");
assert(/abandoned/.test(r9.data.rollback.why),
       "with an honest explanation: " + r9.data.rollback.why.slice(0, 50));

// --------------------------------------- 5. create_comp aliases go back

reset();
$.global.AELL_compAliases = { "Main": "Main 2" };
const aliasSnapshot = JSON.stringify($.global.AELL_compAliases);
AELL_TOOLS.__aliasComp = function () {
  $.global.AELL_compAliases["Hero"] = "Hero 2";
  addLayer("comp stand-in");
  return AELL_okay({ name: "Hero 2" });
};
AELL_MUTATING.__aliasComp = true;
const r10 = batch([{ tool: "__aliasComp", args: {} },
                   { tool: "__failMut", args: {} }], ROLL);
assert(r10.data.rollback.rolledBack, "the aliasing round is rolled back");
assert(JSON.stringify($.global.AELL_compAliases) === aliasSnapshot,
       "and the comp-name alias it added is dropped with it — otherwise " +
       "the next round resolves a name to a comp that no longer exists");

// ------------------------------------------------ 6. the panel's budget

const setTimeoutRef = setTimeout;
const window = {
  console, JSON, Math, Date, setTimeout: setTimeoutRef,
  Settings: { get() { return {}; } },
  Llama: { isRunning() { return true; } },
  Comfy: {}
};

// Bridge that answers like a host which rolls back every partial round.
const seen = [];
window.AEBridge = {
  evalScript(script, cb) {
    const m = String(script).match(/^AELL_callBatch\((.*)\)$/);
    let optsIn = {};
    let cmds = [];
    if (m) {
      // Two JSON-string literals: the commands, then the options.
      const parts = new Function("return [" + m[1] + "]")();
      cmds = JSON.parse(parts[0]);
      if (parts.length > 1) optsIn = JSON.parse(parts[1]);
    }
    seen.push({ rollback: !!optsIn.rollback, n: cmds.length });
    // Every round here fails part way, so an ARMED host rolls it back.
    const rows = cmds.map(() => optsIn.rollback
      ? { ok: false, rolledBack: true, error: "ROLLED BACK: ..." }
      : { ok: false, error: "plain failure" });
    if (cb) setTimeoutRef(() => cb(JSON.stringify(
      { ok: true, data: { results: rows } }), false), 0);
  }
};

new Function("window", toolsSrc)(window);
const Tools = window.Tools;

function run(commands, opts) {
  return new Promise(resolve => {
    Tools.executeCommands(commands, opts || {}, null, resolve);
  });
}
// ------------------------------- N. the fingerprint's 21 blind spots
//
// AELL_fingerprint's only job is to prove the one Undo landed EXACTLY on
// the pre-round state. Probe 3 (real AE, 2026-08-29) wrote 25 dimensions
// a tool in AELL_MUTATING can write and found the fingerprint saw only
// four of them: name, enabled, comment and a text layer's source string.
// AE reverted all 25, so nothing was being left behind TODAY — but the
// check could not have told anyone if it had been, and the overshoot it
// exists to catch (one Undo reaching past our group into the user's own
// last edit) is invisible whenever that edit was a switch, a work area
// or a background colour.
//
// Each dimension gets both halves. The first is stub fidelity: written
// normally it is undoable, so a rollback over it must come back CLEAN —
// this is what fails if the fingerprint ever starts reading something
// non-deterministic. The second is the bug: written as a TORN change the
// Undo cannot reverse, the round must be reported as NOT rolled back.
// Before the fix every one of the second halves reported rolledBack:true
// over a change still sitting in the project.

function withOneDim(i, torn) {
  reset();
  addLayer("Square 1");             // the dimension tools need a layer
  undo.stack.length = 0;            // and that layer is older history
  tearIndex = i; tearTorn = torn;
  return batch([{ tool: "__dim", args: {} },
                { tool: "__failMut", args: {} }], ROLL);
}

for (let i = 0; i < DIMENSIONS.length; i++) {
  const label = DIMENSIONS[i][0];

  const clean = withOneDim(i, false);
  assert(clean.data.rollback && clean.data.rollback.rolledBack === true,
         "STUB FIDELITY: an undoable write to " + label +
         " rolls back clean");

  const torn = withOneDim(i, true);
  const v = torn.data.rollback || {};
  assert(v.rolledBack === false,
         "the fingerprint SEES " + label +
         " — a torn write there is not reported as a clean rollback");
  assert(/did not land on the pre-round state/.test(String(v.why || "")),
         "and says so honestly instead: " + label);
}

// The verification has to be deterministic or it would cry overshoot on
// every rollback. Two reads of an untouched project must be identical.
reset();
addLayer("Square 1");
comp.markerProperty.add(2, false);
comp._layers[0].threeDLayer = true;
comp._layers[0]._rot.o = [10, 20, 30];
assert(AELL_fingerprint() === AELL_fingerprint(),
       "the widened fingerprint is byte-stable across back-to-back reads");

// A camera has no adjustmentLayer and no audio. AE throws on some of
// these rather than answering undefined, and a throw mid-signature would
// drop every field after it — a STABLE absence is the requirement.
reset();
const hostile = new Layer("Hostile", comp);
["threeDLayer", "shy", "locked", "motionBlur", "adjustmentLayer",
 "audioEnabled", "collapseTransformation", "blendingMode"].forEach(k => {
  Object.defineProperty(hostile, k, {
    get() { throw new Error("this layer has no " + k); }, configurable: true
  });
});
comp._layers.push(hostile);
const sig1 = AELL_fingerprint();
assert(typeof sig1 === "string" && sig1.length > 0,
       "a layer that THROWS on every switch still fingerprints");
assert(sig1 === AELL_fingerprint(),
       "and does so identically twice — a refusal is a stable absence, " +
       "not a moving value");
assert(/\|3\?\?\?\?\?\?\?/.test(sig1),
       "each refused switch reads as '?' in place, so the fields after " +
       "it are not lost with it");
reset();

const H = t => ({ tool: t, args: {} });

(async function () {
  seen.length = 0;
  await run([H("add_solid"), H("comfy_status"), H("add_mask"),
             H("apply_effect")], { allowRollback: true });
  assert(seen.length === 2,
         "a panel tool splits this round into two host batches (got " +
         seen.length + ")");
  assert(seen[0].rollback === true,
         "the first batch is armed for rollback");
  assert(seen[1].rollback === false,
         "the SECOND is not — one rollback per request, or a " +
         "deterministic failure would loop undo/retry/undo forever");

  seen.length = 0;
  await run([H("add_solid")], { allowRollback: false });
  assert(seen[0].rollback === false,
         "a caller with no budget left never arms it");

  seen.length = 0;
  await run([H("add_solid"), H("get_comp_details")],
            { allowRollback: true, dryRun: true });
  assert(seen.every(s => s.rollback === false),
         "a dry run mutates nothing, so it is never armed");

  console.log("\n" + checks + " checks");
})();
