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
    // reorder_layers reads a singular {layer} only in its RELATIVE mode
    // (one layer moved next to one anchor); for for_each_layer's purposes
    // it is still the batched sorter and must not be driven per layer.
    // An explicit exemption, so the host helper can live beside the tool
    // instead of being placed out of this scanner's sight.
    if (starts[i].name === "reorder_layers") {
      out[starts[i].name] = "batched";
      continue;
    }
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
assert(/were already changed/.test(rFail.error || ""),
       "and says earlier layers were already changed: " + rFail.error);
// It gave up PART WAY, so it is a partial failure, not a plain one: the
// round rollback counts `mutated` as both a success and a failure, which
// is what lets a lone for_each_layer undo its own half-applied work.
assert(rFail.mutated === true,
       "and is flagged as having mutated before failing (rollback trigger)");
delete AELL_TOOLS.__fail;
delete AELL_PER_LAYER.__fail;

// ------------------------------- 4b. identical failures collapse to ONE
//
// The context bill, measured 2026-09-03 in a real field round: a sub-tool
// that refuses the SAME way on every layer had its ~450-char refusal
// printed five times in one result — ~2.2 KB against a default 16384 ctx
// — and the next transcript line was "context trimmed — 2 earlier
// message(s) dropped". The panel drops HISTORY on overflow, so repeating
// a refusal deletes the turns the model needs in order to act on it.
const LONG = "'Opacity' takes a number, and the text \"" + "x".repeat(200) +
  "\" is not one — it holds 100 now. (A number written as text, \"50\", " +
  "is fine.)";
AELL_TOOLS.__same = function () { return AELL_err(LONG); };
AELL_PER_LAYER.__same = true;
const rSame = call("for_each_layer",
                   { layers: names, tool: "__same", args: {} });
delete AELL_TOOLS.__same;
delete AELL_PER_LAYER.__same;
assert(!rSame.ok, "five identical failures still fail the batch");
const copies = (rSame.error || "").split(LONG).length - 1;
assert(copies === 1,
       "the identical refusal is printed ONCE, not once per layer (got " +
       copies + " copies)");
assert(/B 1, B 2, B 3, B 4, B 5: /.test(rSame.error || ""),
       "and every layer that hit it is named, in order: " + rSame.error);
assert((rSame.error || "").length < LONG.length * 2,
       "so the whole result stays near one copy long (" +
       (rSame.error || "").length + " chars for a " + LONG.length +
       "-char refusal)");

// Failures that genuinely differ are NOT merged — collapsing those would
// hide four real problems behind one layer's message.
let nth = 0;
AELL_TOOLS.__vary = function () { return AELL_err("reason " + (++nth)); };
AELL_PER_LAYER.__vary = true;
const rVary = call("for_each_layer",
                   { layers: names, tool: "__vary", args: {} });
delete AELL_TOOLS.__vary;
delete AELL_PER_LAYER.__vary;
assert(!rVary.ok && [1, 2, 3, 4, 5].every(
         n => new RegExp("B " + n + ": reason " + n).test(rVary.error || "")),
       "five DIFFERENT failures each print in full: " + rVary.error);

// One failure among successes formats exactly as it always has — the
// grouping must not change the single-failure shape the panel and the
// model already read.
AELL_TOOLS.__one = function (a) {
  return a.layer === 2 ? AELL_err("just this one") : AELL_okay({});
};
AELL_PER_LAYER.__one = true;
const rOne = call("for_each_layer",
                  { layers: names.slice(0, 3), tool: "__one", args: {} });
delete AELL_TOOLS.__one;
delete AELL_PER_LAYER.__one;
assert(rOne.ok && rOne.data.succeeded === 2 &&
       rOne.data.failures === "B 2: just this one",
       "a lone failure keeps the plain 'Name: error' shape: " +
       JSON.stringify(rOne.data));

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

// --------------------------------- 5. the plural handed to a SINGULAR tool
//
// Measured in AE 2026 (chat-probe row 36 casual, "drop shadow on every
// layer but the BG"): the model routed CORRECTLY to apply_effect and
// passed {layers: [...]}, which apply_effect does not take. The refusal
// was the bare "Missing 'layer' (name or 1-based index)" -- it named the
// absent key and never the key that HAD arrived, so the model re-sent the
// identical call and gave up. A refusal that cannot be acted on is the
// bug; for_each_layer is the plural these tools have, and nothing said so.

const plural = makeComp("Plural", 3);
project.activeItem = plural;

const rPlural = call("apply_effect",
                     { layers: ["P 1", "P 2"], effect: "Gaussian Blur" });
assert(!rPlural.ok, "apply_effect {layers: [...]} is refused");
assert(plural._layers.every(l => l._effects._fx.length === 0),
       "and nothing was applied to anything");
assert(/you passed 'layers'/.test(rPlural.error || ""),
       "the refusal names the key that WAS handed over: " + rPlural.error);
assert(/P 1/.test(rPlural.error || "") && /P 2/.test(rPlural.error || ""),
       "and quotes the layers it was given back");
assert(/apply_effect/.test(rPlural.error || ""),
       "and names the tool that does not take it");
assert(/for_each_layer \{layers/.test(rPlural.error || ""),
       "and names for_each_layer, the plural this tool DOES have");

// Nothing handed over at all: no plural to name, so ground it in the
// roster instead -- names are the only way in for a caller that cannot
// click, and the bare form gave it none.
const rBare = call("apply_effect", { effect: "Gaussian Blur" });
assert(!rBare.ok && /Missing 'layer'/.test(rBare.error || ""),
       "a bare call still says which key is missing: " + rBare.error);
assert(/Layers in 'Plural'/.test(rBare.error || "") &&
       /P 1, P 2, P 3/.test(rBare.error || ""),
       "and now lists what the comp actually has: " + rBare.error);
assert(!/you passed 'layers'/.test(rBare.error || ""),
       "and does not invent a plural nobody sent");

// The same mistake down the SELECTION path. Falling through to "select
// one in AE" is a dead end twice over: the caller cannot click, and it
// NAMED its targets -- honouring a stale selection instead would work on
// layers nobody asked for and report success.
plural._layers.forEach(l => { l.selected = false; });
const rSel = call("duplicate_layer", { layers: ["P 1", "P 2"] });
assert(!rSel.ok, "a layerOrSelection tool handed {layers} is refused too");
assert(/you passed 'layers'/.test(rSel.error || "") &&
       !/select/i.test(rSel.error || ""),
       "and says so instead of 'select one in AE': " + rSel.error);
assert(plural._layers.length === 3, "and duplicated nothing");

// The mirror: a list under the SINGULAR key. comp.layer([a, b]) answered
// "invalid numeric result (divide by zero?)" in the field -- a message
// that names neither the argument nor the tool.
const rList = call("link_property",
                   { layer: ["P 1", "P 2"], property: "opacity",
                     controlLayer: "P 3", controlEffect: "Slider" });
assert(!rList.ok && /takes ONE layer, not a list/.test(rList.error || ""),
       "a list under 'layer' is named as such: " + rList.error);
assert(/P 1, P 2/.test(rList.error || ""),
       "and quotes the list it was handed");

// ...but ONLY for the target argument. 'parent' sits beside a legitimate
// {layers} list, so "run it on each" would answer a question nobody asked.
const rParent = call("set_layer_parent",
                     { layers: ["P 1"], parent: ["P 2", "P 3"] });
assert(!rParent.ok &&
       /'parent' \(name or 1-based index\)/.test(rParent.error || ""),
       "a bad 'parent' is reported as 'parent', not 'layer': " +
       rParent.error);
assert(!/for_each_layer/.test(rParent.error || ""),
       "and is not answered with the per-layer redirect: " + rParent.error);

// set_property wrote this redirect by hand after the same mistake was
// measured twice in one probe run. Its own wording still wins.
const rSetProp = call("set_property",
                      { layers: ["P 1"], property: "opacity", value: 50 });
assert(!rSetProp.ok && /works on ONE layer/.test(rSetProp.error || ""),
       "set_property keeps its own hand-written redirect: " + rSetProp.error);

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
