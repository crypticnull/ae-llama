// Regression test: for_each_layer, the batch executor.
//
// The bug this file exists for, measured in AE 2026: for_each_layer only
// checked that `args.tool` NAMED something in AELL_TOOLS, so
// {tool: "add_solid"} over two layers answered {ok: true, succeeded: 2}
// and made two identically named solids, and {tool: "create_comp"} over
// two layers answered {ok: true, succeeded: 2} and left two junk comps in
// the project. The injected {layer} was ignored, so the call silently
// became "repeat this comp-level tool N times" while reporting per-layer
// success. Its own error string already promised "'tool' must name a
// layer tool" — nothing enforced it.
//
// Two halves here:
//  1. Behaviour: the refusals, and the drive path that must still work.
//  2. Anti-drift: the drivable/batched/read lists are RE-DERIVED from
//     hostscript.jsx's source and compared to the tables it ships, so a
//     tool added later cannot quietly fall through unclassified.
"use strict";
const fs = require("fs");
const path = require("path");

const HOST = path.join(__dirname, "..", "extension", "jsx", "hostscript.jsx");
const source = fs.readFileSync(HOST, "utf8");

// ------------------------------------------------------------ stubbed AE

function Layer(name, comp) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.threeDLayer = false;
  this._effects = new Parade();
}
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
Layer.prototype.property = function (p) {
  return p === "ADBE Effect Parade" ? this._effects : null;
};

function Parade() { this._fx = []; }
Parade.prototype.canAddProperty = function () { return true; };
Parade.prototype.addProperty = function (name) {
  const fx = { name, matchName: "ADBE " + name, numProperties: 0,
               property() { return null; } };
  this._fx.push(fx);
  return fx;
};

function Comp(name, n) {
  this.name = name;
  this.width = 640; this.height = 360;
  this.duration = 10; this.frameRate = 30; this.frameDuration = 1 / 30;
  this._layers = [];
  for (let i = 0; i < n; i++) {
    this._layers.push(new Layer(name[0] + " " + (i + 1), this));
  }
}
Comp.prototype.layer = function (ref) {
  const l = typeof ref === "number"
    ? this._layers[ref - 1]
    : this._layers.find(x => x.name === ref);
  if (!l) throw new Error("no layer " + ref);
  return l;
};
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { return this._layers.length; }
});
Object.defineProperty(Comp.prototype, "selectedLayers", {
  get() { return this._layers.filter(l => l.selected); }
});

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};

function makeComp(name, n) {
  const c = new Comp(name, n);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  return c;
}

const comp = makeComp("Batch", 60);
// The project counter is the assertion that matters for create_comp: a
// comp-level tool driven per layer shows up here, not on any layer.
const project = {
  rootFolder: { name: "(root)" },
  numItems: 0,
  item() { return null; },
  items: {
    addComp(name) {
      project.numItems++;
      return makeComp(name, 0);
    }
  },
  activeItem: comp
};
const app = { project, beginUndoGroup() {}, endUndoGroup() {} };
const $ = { global: {} };

// This file is "use strict", so eval() gets its OWN variable scope and
// hostscript's `var` declarations do not leak out. Hand the few internals
// the test drives directly back across that boundary.
const host = eval(source + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_okay: AELL_okay, AELL_err: AELL_err, " +
  "AELL_PER_LAYER: AELL_PER_LAYER, " +
  "AELL_PER_LAYER_READ: AELL_PER_LAYER_READ, " +
  "AELL_ALREADY_BATCHED: AELL_ALREADY_BATCHED, " +
  "AELL_PER_LAYER_LIST: AELL_PER_LAYER_LIST, " +
  "AELL_PER_LAYER_READ_LIST: AELL_PER_LAYER_READ_LIST, " +
  "AELL_ALREADY_BATCHED_LIST: AELL_ALREADY_BATCHED_LIST })");
const { AELL_TOOLS, AELL_okay, AELL_err, AELL_PER_LAYER,
        AELL_PER_LAYER_READ, AELL_ALREADY_BATCHED, AELL_PER_LAYER_LIST,
        AELL_PER_LAYER_READ_LIST, AELL_ALREADY_BATCHED_LIST } = host;

function call(tool, args) {
  return JSON.parse($.global.AELL_call(tool, JSON.stringify(args)));
}
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------- 1. the drive path works

const names = comp._layers.map(l => l.name);
const rOk = call("for_each_layer",
                 { layers: names, tool: "apply_effect",
                   args: { effect: "Gaussian Blur" } });
assert(rOk.ok, "60-layer apply_effect succeeds: " + (rOk.error || ""));
assert(rOk.data.succeeded === 60,
       "all 60 layers reported (got " + rOk.data.succeeded + ")");
assert(comp._layers.every(l => l._effects._fx.length === 1),
       "every layer really carries exactly one effect");

// The injected layer must be each layer's OWN index, not a stale snapshot.
const seen = [];
AELL_TOOLS.__probe = function (a) { seen.push(a.layer); return AELL_okay({}); };
AELL_PER_LAYER.__probe = true;
const rIdx = call("for_each_layer",
                  { layers: ["B 2", "B 5", "B 9"], tool: "__probe", args: {} });
assert(rIdx.ok && seen.join(",") === "2,5,9",
       "each iteration targets its own layer index (got " + seen.join(",") + ")");
delete AELL_TOOLS.__probe;
delete AELL_PER_LAYER.__probe;

// -------------------------------------------- 2. the refusals (the bug)

const before = project.numItems;
const rComp = call("for_each_layer",
                   { layers: ["B 1", "B 2"], tool: "create_comp",
                     args: { name: "Junk", width: 100, height: 100 } });
assert(!rComp.ok, "create_comp is REFUSED, not run once per layer");
assert(project.numItems === before,
       "no comps were created (project items " + project.numItems +
       ", was " + before + ")");
assert(/no per-layer target/.test(rComp.error || ""),
       "the refusal says why: " + rComp.error);
assert(/Drivable tools:/.test(rComp.error || "") &&
       /apply_effect/.test(rComp.error || ""),
       "the refusal lists what IS drivable (grounded error)");

const layersBefore = comp._layers.length;
const rSolid = call("for_each_layer",
                    { layers: ["B 1", "B 2"], tool: "add_solid",
                      args: { name: "spawned", width: 50, height: 50 } });
assert(!rSolid.ok, "add_solid is REFUSED (it has no {layer} target)");
assert(comp._layers.length === layersBefore,
       "no duplicate-named solids were spawned");

const rBatched = call("for_each_layer",
                      { layers: ["B 1", "B 2"], tool: "grid_layout",
                        args: { columns: 3 } });
assert(!rBatched.ok, "grid_layout is REFUSED — it takes its own {layers}");
assert(/already takes its own \{layers\} list/.test(rBatched.error || ""),
       "and is told to be called ONCE: " + rBatched.error);

const rSelf = call("for_each_layer",
                   { layers: ["B 1"], tool: "for_each_layer", args: {} });
assert(!rSelf.ok, "for_each_layer cannot drive itself");

const rRead = call("for_each_layer",
                   { layers: ["B 1", "B 2"], tool: "get_property",
                     args: { property: "transform/Position" } });
assert(!rRead.ok, "get_property is REFUSED: for_each_layer reports counts, " +
       "so every value would be discarded");
assert(/discarded/.test(rRead.error || ""),
       "and the refusal says the values would be lost: " + rRead.error);

const rUnknown = call("for_each_layer",
                      { layers: ["B 1"], tool: "wiggle_everything", args: {} });
assert(!rUnknown.ok && /Unknown tool/.test(rUnknown.error || ""),
       "an invented tool name is named back: " + rUnknown.error);

// A bad tool name is reported as a TOOL problem even when the layer list is
// also wrong — otherwise the model chases a layer-not-found red herring.
const rBoth = call("for_each_layer",
                   { layers: ["nope"], tool: "create_comp", args: {} });
assert(!rBoth.ok && /no per-layer target/.test(rBoth.error || ""),
       "tool is validated before layers: " + rBoth.error);

// ------------------------------------- 3. anti-drift: re-derive the lists

// Classify every AELL_TOOLS.<name> by what its BODY reads. Singular
// {layer} (directly or via AELL_layerOrSelection) = drivable; a {layers}
// array (AELL_layersOrSelection / AELL_targetLayers / args.layers) with no
// singular form = already batched; neither = not a layer tool at all.
function classify(src) {
  const re = /AELL_TOOLS\.([A-Za-z0-9_]+)\s*=\s*function/g;
  const starts = [];
  let m;
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  const out = {};
  for (let i = 0; i < starts.length; i++) {
    const body = src.slice(starts[i].at,
      i + 1 < starts.length ? starts[i + 1].at : src.length);
    const sing = /args\.layer\b/.test(body) ||
                 /AELL_layerOrSelection/.test(body);
    const plur = /args\.layers\b/.test(body) ||
                 /AELL_layersOrSelection/.test(body) ||
                 /AELL_targetLayers/.test(body);
    out[starts[i].name] = sing ? "single" : (plur ? "batched" : "none");
  }
  return out;
}

const kinds = classify(source);
assert(Object.keys(kinds).length > 40,
       "the classifier found the tool table (" + Object.keys(kinds).length +
       " tools)");

const unclassified = [];
const misfiled = [];
for (const name of Object.keys(kinds)) {
  const listed = AELL_PER_LAYER[name] ? "single"
    : AELL_PER_LAYER_READ[name] ? "single"
    : AELL_ALREADY_BATCHED[name] ? "batched"
    : null;
  if (kinds[name] === "none") {
    if (listed) misfiled.push(name + " takes no layer but is listed as " + listed);
    continue;
  }
  if (!listed) { unclassified.push(name + " (" + kinds[name] + ")"); continue; }
  // for_each_layer itself reads args.layers; it is deliberately in the
  // batched list so it cannot drive itself.
  if (name !== "for_each_layer" && listed !== kinds[name]) {
    misfiled.push(name + " is " + kinds[name] + " but listed as " + listed);
  }
}
assert(unclassified.length === 0,
       "every layer tool is classified for for_each_layer" +
       (unclassified.length ? " — MISSING: " + unclassified.join(", ") : ""));
assert(misfiled.length === 0,
       "no tool is filed under the wrong kind" +
       (misfiled.length ? " — " + misfiled.join("; ") : ""));

// Nothing may be listed that does not exist: a typo in the table would
// otherwise present as a silently undrivable tool.
const ghosts = []
  .concat(AELL_PER_LAYER_LIST, AELL_PER_LAYER_READ_LIST,
          AELL_ALREADY_BATCHED_LIST)
  .filter(n => !Object.prototype.hasOwnProperty.call(kinds, n));
assert(ghosts.length === 0,
       "every listed name is a real tool" +
       (ghosts.length ? " — ghosts: " + ghosts.join(", ") : ""));

// The three lists must not overlap — a name in two of them makes the
// refusal message depend on check order rather than on the tool.
const counts = {};
[].concat(AELL_PER_LAYER_LIST, AELL_PER_LAYER_READ_LIST,
          AELL_ALREADY_BATCHED_LIST)
  .forEach(n => { counts[n] = (counts[n] || 0) + 1; });
assert(Object.keys(counts).every(n => counts[n] === 1),
       "the drivable / read / batched lists are disjoint");

// -------------------------------------------------- 4. honest failure cap

let calls = 0;
AELL_TOOLS.__fail = function () {
  calls++;
  return AELL_err("nope");
};
AELL_PER_LAYER.__fail = true;
const rFail = call("for_each_layer",
                   { layers: names, tool: "__fail", args: {} });
assert(!rFail.ok, "a failing tool fails the batch");
assert(calls === 5, "it stops after 5 failures, not 60 (ran " + calls + ")");
assert(/NOT undone/.test(rFail.error || ""),
       "and warns that earlier layers were already changed: " + rFail.error);
delete AELL_TOOLS.__fail;
delete AELL_PER_LAYER.__fail;

const big = makeComp("Huge", 0);
for (let i = 0; i < 201; i++) big._layers.push(new Layer("H " + i, big));
project.activeItem = big;
const rCap = call("for_each_layer",
                  { layers: big._layers.map(l => l.name), tool: "apply_effect",
                    args: { effect: "Gaussian Blur" } });
assert(!rCap.ok && /Capped at 200/.test(rCap.error || ""),
       "201 layers is refused at the cap: " + rCap.error);
assert(big._layers.every(l => l._effects._fx.length === 0),
       "the capped call changed nothing");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
