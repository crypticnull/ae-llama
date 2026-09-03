// Regression test: the in-panel self-test suite — every step must target
// a real tool with well-formed args, the runner must sequence to
// completion, and failures must surface in the report.
"use strict";
const fs = require("fs");
const path = require("path");

const window = { setTimeout, clearTimeout };
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                "selftest.js"), "utf8"));
const SelfTest = window.SelfTest;

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// 1. every step references a tool that actually exists in TOOL_DEFS
const toolsSrc = fs.readFileSync(path.join(__dirname, "..", "extension",
                                            "js", "tools.js"), "utf8");
const steps = SelfTest._buildSteps();
assert(steps.length >= 20, "suite has " + steps.length + " steps (>= 20)");
function documented(name) {
  return toolsSrc.includes('name: "' + name + '"');
}
// A {batch: [...]} step has no single .tool -- it names one per command,
// and a deliberately bogus one is part of what it measures.
function stepTools(s) {
  if (!s.batch) return [s.tool];
  const cmds = typeof s.batch === "function" ? s.batch({ unComp: "C" })
                                             : s.batch;
  return cmds.map(c => c.tool).filter(t => t !== "not_a_real_tool");
}
let unknown = [];
for (const s of steps) {
  for (const t of stepTools(s)) if (!documented(t)) unknown.push(t);
}
assert(steps.filter(s => s.batch).length >= 2,
       "the suite exercises the multi-tool batch call");
assert(unknown.length === 0,
       "every step targets a documented tool" +
       (unknown.length ? " (unknown: " + unknown.join(", ") + ")" : ""));
const names = new Set(steps.map(s => s.name));
assert(names.size === steps.length, "step names are unique");

const hostSrc = fs.readFileSync(path.join(__dirname, "..", "extension",
                                          "jsx", "hostscript.jsx"), "utf8");

// get_comp_details / get_project_info cap their model-facing lists, and a
// stub that answered with the full list would let a suite step "pass"
// while checking rows real AE never sent. The cap number itself is read
// out of hostscript.jsx rather than copied, so the two cannot drift.
const LIST_LIMIT = Number(
  (/var AELL_LIST_LIMIT = (\d+);/.exec(hostSrc) || [])[1]);
assert(LIST_LIMIT > 0, "hostscript publishes a list cap (" + LIST_LIMIT + ")");

function listLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return LIST_LIMIT;
  if (raw === 0 || raw === "0" || raw === "all") return -1;
  const n = Math.round(Number(raw));
  return n > 0 ? n : LIST_LIMIT;
}

/** Window a full layer list the way the host does. */
// "half [2, 2]" - the same shape the host reports.
function compResolutionLabel(c) {
  const rf = (c && c.rf) || [1, 1];
  const NAMES = { 1: "full", 2: "half", 3: "third", 4: "quarter" };
  const name = (rf[0] === rf[1] && NAMES[rf[0]]) ? NAMES[rf[0]] : "custom";
  return name + " [" + rf[0] + ", " + rf[1] + "]";
}

function capLayers(compName, all, args) {
  // The matte rig's layers are in the comp whether or not the branch that
  // built this row list knows about them, and a layer keeps its row after
  // its matte is REMOVED -- which is the case the read-back step exists
  // for (measured in AE 2026: removeTrackMatte leaves trackMatteType at
  // the type it just removed, so only the matte LAYER tells the truth).
  const rig = mtRig[compName] || [];
  if (rig.length) {
    const have = {};
    for (const l of all) have[l.name] = true;
    const extra = [];
    for (const nm of rig) {
      if (!have[nm]) extra.push({ index: all.length + extra.length + 1,
                                  name: nm, effects: [] });
    }
    if (extra.length) all = all.concat(extra);
  }
  const total = all.length;
  const limit = listLimit(args && args.limit);
  let start = (args && args.start > 0) ? Math.round(args.start) : 1;
  if (start > total) start = total > 0 ? total : 1;
  const last = limit < 0 ? total : Math.min(total, start + limit - 1);
  const wanted = [];
  for (const l of all) {                       // selected layers win slots
    if (l.selected && (limit < 0 || wanted.length < limit)) wanted.push(l);
  }
  for (let i = start; i <= last; i++) {
    if (limit >= 0 && wanted.length >= limit) break;
    const l = all[i - 1];
    if (l && wanted.indexOf(l) < 0) wanted.push(l);
  }
  wanted.sort((a, b) => a.index - b.index);
  for (const l of wanted) {
    const m = mattes[compName + "|" + l.name];
    if (m) { l.matte = m.matte; l.matteMode = m.mode; }
    else if (l.matte) { delete l.matte; delete l.matteMode; }
  }
  const cp = compProps[compName];
  const out = { name: compName, numLayers: total,
                layersShown: wanted.length, layers: wanted };
  if (cp) {
    const secs = (t) => (Math.round(Number(t) * 1000) / 1000) + "s";
    out.workArea = secs(cp.waStart || 0) +
                   "-" + secs((cp.waStart || 0) + (cp.waDur || 0));
    out.resolution = compResolutionLabel(cp);
  }
  if (wanted.length < total) {
    out.note = "Showing " + wanted.length + " of " + total +
      " layers (indexes " + start + "-" + last + "). Ask again with start:" +
      (last + 1) + " for the next " + limit + ", or limit:0 for all.";
  }
  return out;
}

// canned happy-path results per tool
let createCount = 0;
const createdComps = [];
const folders = {};        // path -> true (the create_folder rig)
const folderIds = {};      // id -> path; real AE resolves an item by id
let nextFolderId = 5000;   // clear of the solid-source ids above
let orgShownKey = null;    // organize_project's preview gate (0.11.8)
// The render-queue rig (WORKPLAN 5.5). Measured in AE 2026: a render
// takes the WHOLE queue, an existing output file raises a modal, and the
// output module forces its own extension onto whatever path it is given.
// The canned host models all three, because a host that answered "ok"
// would let a tool that reintroduced any of them pass its own steps.
const RQ_RS_TEMPLATES = ["Best Settings", "Current Settings",
  "Draft Settings", "Multi-Machine Settings", "_HIDDEN X-Factor"];
const RQ_OM_TEMPLATES = ["AIFF 48kHz", "Alpha Only",
  "H.264 - Match Render Settings - 15 Mbps", "High Quality", "Lossless",
  "Lossless with Alpha", "TIFF Sequence with Alpha", "_HIDDEN X-Factor 8"];
const RQ_OM_EXT = {
  "Lossless": "avi", "Lossless with Alpha": "avi", "High Quality": "avi",
  "H.264 - Match Render Settings - 15 Mbps": "mp4",
  "TIFF Sequence with Alpha": "tif", "AIFF 48kHz": "aif",
  "Alpha Only": "avi", "_HIDDEN X-Factor 8": "avi"
};
const RQ_DEFAULT_OM = "H.264 - Match Render Settings - 15 Mbps";
const RQ_INHERITED =
  "C:\\Users\\probe\\Documents\\ComfyUI\\output\\video\\LAST";
const RQ_FOLDERS = ["c:\\users\\probe\\appdata\\local\\temp",
                    "c:\\users\\probe\\documents",
                    RQ_INHERITED.toLowerCase()];
const rqItems = [];        // what the user has queued
const rqDisk = {};         // lowercased path -> bytes
// The frame round-trip (WORKPLAN 5.8) writes into that same virtual
// disk. frPngs remembers each written frame's real pixel size (the tool
// reads it back out of the PNG header, not out of the comp), frItems
// which paths the project already holds an item for, and frScales what
// AE ends up holding, so get_property can be asked rather than trusted.
const frPngs = {};
const frItems = {};
const frScales = {};
const frLayers = {};
function rqNorm(p) { return String(p).split("/").join("\\"); }
function rqDirOf(p) {
  const n = rqNorm(p);
  const i = n.lastIndexOf("\\");
  return i <= 0 ? n : n.slice(0, i);
}
function rqFolderExists(d) {
  return RQ_FOLDERS.indexOf(rqNorm(d).toLowerCase()) !== -1;
}
function rqNearestFolder(d) {
  let cur = rqNorm(d);
  while (cur.indexOf("\\") > 0) {
    cur = cur.slice(0, cur.lastIndexOf("\\"));
    if (rqFolderExists(cur)) return cur;
  }
  return "(none - check the drive letter)";
}
function rqExtOf(p) {
  const s = rqNorm(p);
  const slash = s.lastIndexOf("\\");
  const dot = s.lastIndexOf(".");
  return dot <= slash + 1 ? "" : s.slice(dot + 1).toLowerCase();
}
function rqForceExt(p, om) {
  const s = rqNorm(p);
  const ext = RQ_OM_EXT[om] || "avi";
  return rqExtOf(s) ? s.replace(/\.[^.\\]*$/, "." + ext) : s + "." + ext;
}
// The precompose + marker rig (WORKPLAN 5.4). The canned host has to
// REMEMBER the parent links, expressions, trims and selection it was
// handed, or "precompose reported the parent it broke" would be a
// sentence the stub wrote for itself.
const pcNested = {};       // precomp name -> layers moved into it
const pcParent = {};       // layer -> parent layer
const pcExpr = {};         // layer -> its opacity expression
const pcTiming = {};       // layer -> {inPoint, outPoint}
const markers = {};        // "comp|layer" -> [{time, comment, duration}]
let pcSelection = [];      // layers selected in the precompose rig comp
const pcLayers = [];       // solids added to the precompose rig comp
// The request-scoped redirect create_comp registers and precompose now
// registers too: within one request, the name that was ASKED for still
// reaches the comp AE actually made.
const pcAlias = {};        // requested name -> the name it really got
// The suite is run three times over in this file (happy path, one broken
// tool, permissive host), so every rig has to be resettable — a run that
// inherited the last one's precomps would auto-number a name that should
// have been free and fail a step for the wrong reason.
function resetPcRig() {
  [pcNested, pcParent, pcExpr, pcTiming, markers, pcAlias].forEach((m) => {
    Object.keys(m).forEach((k) => { delete m[k]; });
  });
  pcSelection = [];
  pcLayers.length = 0;
}
function inPcComp(a) { return !!(a && /Self-Test Precomp/.test(a.comp || "")); }

// The animation-preset rig (WORKPLAN 5.3). AE's applyPreset acts on the
// comp's SELECTION rather than on the layer it is called on, and a preset
// built for another layer type changes NOTHING without throwing, so a
// canned host that answered "ok" would let both bugs pass their own steps.
// This one carries a small library, the split's leftover selection, and
// the effects each layer actually ends up with.
const PRESET_LIB = [
  { name: "Wiggle - position", category: "Behaviors", source: "app",
    effects: 2, keys: 1 },
  { name: "Drift Over Time", category: "Behaviors", source: "app",
    effects: 1, keys: 1 },
  { name: "Alternating Characters In", category: "Text/Animate In",
    source: "app", effects: 6, keys: 2, needs: "text", controls: true },
  { name: "Fade Up Characters", category: "Text/Animate In", source: "app",
    effects: 0, keys: 2, needs: "text" },
  { name: "Drop In By Character", category: "Text/Animate In",
    source: "app", effects: 0, keys: 2, needs: "text" },
  { name: "My Look", category: "", source: "user", effects: 1, keys: 0 }
];
const PRESET_CATS = ["Behaviors", "Text", "(root)"];
let preFx = {};            // layer -> effects a preset put there
let preSelection = [];     // what split_layer_into_chunks left selected
let preLayers = [];        // the rig's layers, in the main scratch comp
function resetPresetRig() { preFx = {}; preSelection = []; preLayers = []; }
// The render rig writes to a virtual disk and to the user's queue, so it
// has to be emptied between runs or the second run starts with the first
// run's files already on disk and its items already queued.
function resetRqRig() {
  rqItems.length = 0;
  for (const k of Object.keys(rqDisk)) delete rqDisk[k];
}
function presetPath(p) { return (p.category ? p.category + "/" : "") + p.name; }
function presetMatch(want) {
  const norm = String(want || "").split("\\").join("/")
    .replace(/\.ffx$/i, "").trim().toLowerCase();
  if (!norm) return { near: [] };
  const tiers = [[], [], [], []];
  PRESET_LIB.forEach((p) => {
    const full = presetPath(p).toLowerCase(), nm = p.name.toLowerCase();
    if (full === norm) tiers[0].push(p);
    else if (nm === norm) tiers[1].push(p);
    else if (full.indexOf(norm) !== -1) tiers[2].push(p);
    else if (nm.indexOf(norm) !== -1) tiers[3].push(p);
  });
  for (const t of tiers) {
    if (t.length === 1) return { hit: t[0] };
    if (t.length > 1) return { choices: t };
  }
  return { near: [] };
}
// Measured in AE 2026, and not the simple rule it looks like: a camera
// (or light) has no Effect Parade and takes NOTHING from any preset, while
// a Text preset on a SOLID lands PARTIALLY when it carries expression
// controls ("Alternating Characters In": six sliders and two keys, against
// census 15 on a real text layer) and not at all when it does not
// ("Center Spiral In"). The canned library holds one of each.
function presetLayerType(nm) {
  if (/PreCam/.test(String(nm || ""))) return "camera";
  if (/PreText/.test(String(nm || ""))) return "text";
  return "solid";
}
function presetFits(p, layer) {
  const t = presetLayerType(layer);
  if (t === "camera") return false;
  if (p.needs !== "text" || t === "text") return true;
  return !!p.controls;      // a Text preset with controls lands partially
}
// Solid SOURCES, mutable: deleting a comp does not delete these (the
// field bug), and the suite's new cleanup deletes them by id. Seeded
// with the accumulation observed in the real scratch project — a few of
// the suite's own ST-named leftovers drowning in generic solids.
const solidSources = [];
for (let i = 1; i <= 400; i++) {
  solidSources.push({ name: "Blue Solid " + i, id: 100 + i,
                      type: "footage" });
}
["ST Bat A", "ST Bat A", "ST Batch", "ST RB Orphan",
 "ST Cov Box"].forEach((nm, i) => {
  solidSources.push({ name: nm, id: 900 + i, type: "footage" });
});
// The leak the ST sweep could never see (measured in the real project
// 2026-08-30: 189 "Null <n>" and 168 "Audio Amplitude" solid sources
// accumulated, 34 of them per run). Every null AE makes gets a solid
// SOURCE in the project panel, and deleting the comp does not delete it.
// AE uniques the null's source name and does NOT unique the audio one —
// and neither name is in the suite's "ST " namespace, which is why a
// name-only cleanup swept a project it was leaking into. The stub leaks
// exactly the same way so the cleanup has something to fail on.
// And the other half of the contract: a project of the USER's that
// already holds items by those exact names. The sweep may not touch
// these -- they were here before the run, which is the only thing that
// tells them apart from the ones it leaked.
const USER_DECOYS = ["Null 1", "Audio Amplitude"];
USER_DECOYS.forEach((nm, i) => {
  solidSources.push({ name: nm, id: 950 + i, type: "footage" });
});
let leakedId = 20000;      // clear of the solid-source and folder ids
let leakedNulls = 0;
function leakSolidSource(name) {
  solidSources.push({ name, id: ++leakedId, type: "footage" });
  return name;
}
function leakNullSource() { return leakSolidSource("Null " + (++leakedNulls)); }
let camProbeReads = 0;
let textStyle = null;
// The ordering steps read back what the previous step wrote, so the canned
// host has to REMEMBER instead of answering with a constant — otherwise
// "did slot i go to layer i" is a question the stub answers for free.
let ordX = {};
let ordStack = [];
// Track mattes, remembered rather than answered with a constant: until
// 2026-09-02 the suite checked only set_track_matte's RECEIPT, so a matte
// AE never made read exactly like one it did. "comp|layer" -> the matte
// it currently carries; mtRig is which layers the matte steps touched, so
// get_comp_details still has a row for one whose matte was removed.
let mattes = {};
let mtRig = {};
// The masks each layer holds, "comp|layer" -> [names], so delete_mask
// answers from what add_mask really put there and the mask refusals
// ("no masks", "Mask not found ... Masks here:") are measurements.
let mkMasks = {};
// How big each layer really is, "comp|layer" -> {width, height}. add_mask
// refuses a mask that misses the layer entirely and get_comp_details puts
// the layer's own size on its row, and NEITHER can be answered from the
// comp's dimensions — which is the whole bug: the comp's were the only
// numbers the model had, so four phrasings masked a 100x100 layer with
// 1920x1080 and the tool said ok.
let mkSizes = {};
// The mask rig reads back what it just wrote (numKeys after a refusal),
// so the canned host has to remember how many keys each mask carries.
let maskKeys = {};
// stagger_layers is read back through get_comp_details ("did the layers
// really land 4 frames apart"), so the canned host has to remember where
// it put them rather than answering with a constant list.
let stagStart = {};
// The batch rig checks that for_each_layer really touched all 60 layers
// and that the tools it must refuse changed nothing, so the canned host
// tracks which layers carry the blur, what value it holds, and whether a
// refused comp-level tool leaked new project items.
let batchLayers = 0;
let batchFx = {};
let batchBlur = null;

// A value AE will not take, refused the way AELL_writeValue refuses it.
// Measured in real AE 2026 (scripts/param-value-probe.jsx): setValue
// COERCES a numeric string ("50" reads back 50, ["10","20"] reads back
// [10, 20]) and throws on anything else, so the guard keys on "a string
// that is not a number", never on "a string". Returns "" when the value
// is fine.
function badValueRefusal(value, label, shape, holds, linkPath) {
  let bad = null;
  const num = (x) => (typeof x === "number" ? (isNaN(x) ? null : x)
    : (typeof x === "string" && x !== "" && !isNaN(Number(x))
        ? Number(x) : null));
  if (Array.isArray(value)) {
    for (const el of value) {
      if (typeof el === "string" && num(el) === null) { bad = el; break; }
    }
  } else if (typeof value === "string" && num(value) === null) {
    bad = value;
  }
  if (bad === null) return "";
  const shown = bad.length > 90 ? bad.slice(0, 87) + "..." : bad;
  const wants = shape === "array" ? "an array of 3 numbers" : "a number";
  let msg = "'" + label + "' takes " + wants + ", and the text \"" + shown +
    "\" is not one" + (holds === null ? "" : " — it holds " + holds + " now") +
    ". (A number written as text, \"50\", is fine.)";
  if (/thisComp|thisLayer|thisProperty|\b(?:comp|layer|effect|mask|content|wiggle|linear|ease|random|valueAtTime|sourceRectAtTime|loopOut|loopIn|time|index|value)\b\s*[.([]|[-+*/]\s*\d|\)\s*\(/
        .test(bad)) {
    msg += " That is EXPRESSION code, and a value is never one. To drive " +
      "this property from a control use link_property {layer: \"...\", " +
      "property: \"" + linkPath + "\", ...} with controlLayer + " +
      "controlEffect — it writes the expression itself, dimension-aware. " +
      "For raw code use set_expression {..., expression: \"" + shown + "\"}.";
  }
  return msg;
}

// ---- the coverage rig: a miniature property model for the tools no
// other step in the suite calls. Faithful to what the probe measured in
// AE 2026 (WORKPLAN-LOG 2026-08-28) on the four points its steps turn on:
//   - a one-leaf control group resolves to its VALUE property, so the
//     matchName that comes back is "ADBE Slider Control-0001", never the
//     group's;
//   - the Transform tree is IDENTICAL for a 2D and a 3D layer (Z Position,
//     Orientation and both extra rotations are there either way), so
//     nothing about 3D-ness can be inferred from the tree;
//   - turning 3D back off ZEROES the Z component, silently;
//   - a layer root really does ship two groups both named "Geometry
//     Options", which is why every entry carries a matchName.
const cvControls = {};   // "layer/name" -> {type, match, value}
const cvKeys = {};       // "layer/prop"  -> [{time, value}]
// What a property SETTLES ON once its last key is taken away.
// Measured in AE 2026 (scripts/verb-semantics-probe.jsx): the host
// empties a property by removing key 1 over and over, so the key
// standing last is the last in TIME and AE holds that value --
// not the first key's, and not the value under the playhead (two
// rigs emptied at different playheads both kept the last key's).
// Without this the canned host answered a constant, which is how a
// step could read back a value nothing had produced.
const cvResidual = {};   // "layer/prop"  -> value after the last key
const parentedLayers = {}; // layer -> parent, so the resize can tell a
                           // child's inherited transform from its own
const cvExpr = {};       // "layer/prop"  -> expression
let cvSolids = [];       // solids in the coverage comp, by name
const cvThreeD = {};     // layer -> bool
const cvAnchor = {};     // layer -> [x, y, z]
const cvXRot = {};       // layer -> deg (3D-only, cleared by going 2D)
const cvFx = {};         // layer -> [effect display names, in AE's order]
// AE's layer-level name shortcut, measured name by name in AE 2026: a
// light answers Intensity, Color, Cone Angle, Cone Feather, Casts
// Shadows, Shadow Darkness and Shadow Diffusion but NOT Falloff, Radius
// or Falloff Distance -- the three options that arrived with falloff,
// living in the very same group. Everything the shortcut misses is what
// the deep search exists for, and the canned host has to draw that line
// in the same place or the suite's search steps prove nothing.
const LIGHT_DEEP_ONLY = {
  "Radius": ["radius", "ADBE Light Falloff Start"],
  "Falloff Distance": ["falloffDistance", "ADBE Light Falloff Distance"],
  "ADBE Light Falloff Start": ["radius", "ADBE Light Falloff Start"],
  "ADBE Light Falloff Distance": ["falloffDistance",
                                  "ADBE Light Falloff Distance"],
  "ADBE Light Shadow Diffusion": ["shadowDiffusion",
                                  "ADBE Light Shadow Diffusion"]
};
const LIGHT_DEEP_PATH = {
  "radius": "Light Options/Radius",
  "falloffDistance": "Light Options/Falloff Distance",
  "shadowDiffusion": "Light Options/Shadow Diffusion"
};
// Every run of the suite starts on a FRESH scratch comp in real AE, so
// the canned rig has to be wiped between runs here too. Not cosmetic:
// the Position keyframes the discard-report steps leave behind made the
// NEXT run's expression read answer with a key list instead.
const resetCoverRig = () => {
  cvSolids = [];
  const stores = [cvControls, cvKeys, cvExpr, cvThreeD, cvAnchor, cvXRot,
                  cvFx];
  for (const store of stores) {
    for (const k of Object.keys(store)) delete store[k];
  }
};
const cvProp = (p) => String(p || "").toLowerCase()
  .replace(/^transform\//, "").replace(/\s+/g, "");
const cvKeyList = (layer, prop) => {
  const k = layer + "/" + cvProp(prop);
  if (!cvKeys[k]) cvKeys[k] = [];
  return cvKeys[k];
};
const inCvComp = (a) => !!(a && /Cover/.test(a.comp || ""));

// ---- the carpet-bomb rig. remove_keyframes gained a gate on
// 2026-09-02: naming EVERY layer in a comp is the shape the model
// produced from "tidy it" (row 29, 18 opacity keys gone on an ok
// receipt), so it now previews first and the caller has to come back.
// Modelled here, not faked: the roster grows from the add_solid calls
// the suite really makes, so a fourth solid moves this stub's idea of
// "every layer" the same way it moves real AE's.
let wpLayers = [];               // solids in the wipe comp, by name
const wpKeys = {};               // "layer/prop" -> key count
let wpShown = null;              // what the gate has previewed
const inWpComp = (a) => !!(a && /Self-Test Wipe/.test(a.comp || ""));
const wpTargets = (a) => (Array.isArray(a.layers) && a.layers.length)
  ? a.layers.slice() : (a.layer ? [String(a.layer)] : []);
const wpCount = (layer, prop) => wpKeys[layer + "/" + cvProp(prop)] || 0;
// Every run starts on a fresh comp in real AE, and the GATE's memory is
// per-session there too — a stub that carried either across runs would
// stop gating the second one.
const resetWpRig = () => {
  wpLayers = [];
  wpShown = null;
  for (const k of Object.keys(wpKeys)) delete wpKeys[k];
};

// ---- the audio rig, modelled from AE 2026 rather than from the tool.
// A solid is silent until Tone is applied; then the converter hears it.
// One tone peaks at 34.33 on this rig, two at 36.02 — both measured, and
// the gap is what the suite's isolate/un-mute steps read.
const inAuComp = (a) => !!(a && /Self-Test Audio/.test(a.comp || ""));
let auLayers = [];         // {name, audio: bool}
let auNulls = [];          // the nulls the converter has left behind
function resetAuRig() { auLayers = []; auNulls = []; }
// resetRqRig already empties the virtual disk the frame rig shares.
function resetFrRig() {
  for (const m of [frPngs, frItems, frScales, frLayers]) {
    for (const k of Object.keys(m)) delete m[k];
  }
}
const auFind = (n) => auLayers.filter(l => l.name === String(n))[0];

// The caption rigs (WORKPLAN 6.1 Pass C). Two comps: one that gets a Tone
// effect so render_comp_audio has real audio to find, and one the text
// captions are built in. The facts this canned host has to model are the
// silent ones -- AE renders a comp with NO audio just as happily as one
// with, and inPoint DRAGS outPoint -- because those are the only ones the
// suite steps can catch.
const inCapAudio = (a) => !!(a && /Self-Test Caption Audio/.test(a.comp || ""));
const inCapText = (a) => !!(a && /Self-Test Captions/.test(a.comp || ""));
let capAudio = [];      // {name, audio: bool} in the audio rig
let capRows = [];       // {name, inPoint, outPoint} in the text rig
let capMarks = [];      // {time, comment, duration} on the text comp
function resetCapRig() { capAudio = []; capRows = []; capMarks = []; }

// The Essential Graphics rig (WORKPLAN 5.9). Everything the suite can
// reach here is a REFUSAL, because AE exports a template only from a
// saved, CLEAN project and the suite has been creating comps in the
// user's open one since step 1 -- so the canned host's job is to model
// the refusal chain in the order the real tool applies it. A permissive
// host that answered "ok" would let a tool that dropped any of these
// pass its own steps.
//
// Measured facts it has to carry: the default controller name is the
// LAYER's (never the property's), AE accepts DUPLICATE controller names
// in silence, a property that is already a controller is refused, and
// AE 2026 ships no rename and no remove.
const mgCtrl = {};         // comp -> [controller names, NEWEST first]
const mgFrom = {};         // comp -> {controller name: "layer|property"}
function resetMgRig() {
  for (const m of [mgCtrl, mgFrom]) {
    for (const k of Object.keys(m)) delete m[k];
  }
}
// AE stores time on its own base: 0.3333 reads back 0.33329264322917.
const CAP_TICKS = 254016000;
const capQuant = (t) => Math.round(Number(t) * CAP_TICKS) / CAP_TICKS;
const auPeak = (n) => Math.round((34.33 + 1.69 * (n - 1)) * 100) / 100;
const auUnique = (base) => {
  const taken = auLayers.map(l => l.name).concat(auNulls);
  if (taken.indexOf(base) === -1) return base;
  let k = 2;
  while (taken.indexOf(base + " " + k) !== -1) k++;
  return base + " " + k;
};
// Two effects of one class on one layer: AE names the second "<name> 2",
// and both hand out a param called "Blurriness" at the same depth under
// the same root. Equal standing is never guessed between.
const cvAmbiguous = (layer, prop) => {
  if (String(prop).toLowerCase() !== "blurriness") return null;
  const fx = (cvFx[layer] || []).filter(n => /^Gaussian Blur/.test(n));
  if (fx.length < 2) return null;
  const paths = fx.slice().reverse().map(n => "Effects/" + n + "/Blurriness");
  return "'" + prop + "' is ambiguous on '" + layer + "': " + fx.length +
    " properties share that name - " + paths.join(", ") +
    ". Pass the full path (list_properties shows the tree).";
};

// The control table and the preset list are READ OUT of hostscript.jsx,
// not paraphrased: a stub carrying its own copy would answer the two
// grounded-refusal steps for free the day the host's list changed.
const CONTROL_TYPES = (function () {
  const m = /var AELL_CONTROL_TYPES = \{([\s\S]*?)\n\};/.exec(hostSrc);
  if (!m) throw new Error("hostscript.jsx no longer defines " +
                          "AELL_CONTROL_TYPES");
  const out = {};
  const re = /(\w+):\s*\{\s*match:\s*"([^"]+)"/g;
  let g;
  while ((g = re.exec(m[1]))) out[g[1]] = g[2];
  return out;
})();
const EXPR_PRESETS = (function () {
  const m = /Available: "\s*\+\s*"([a-z_, ]+)"/.exec(hostSrc);
  if (!m) throw new Error("hostscript.jsx no longer lists the expression " +
                          "presets in its refusal");
  return m[1].split(",").map(s => s.trim());
})();

// The Transform tree and the layer root, exactly as AE 2026 handed them
// over for a solid layer. Hard-coded because the POINT of the steps that
// read them is that these lists do not vary with threeDLayer.
// AE renames ADBE Rotate Z with the 3D switch and nothing else moves.
const cvName = (n, mn, layer) =>
  (mn === "ADBE Rotate Z" && cvThreeD[layer]) ? "Z Rotation" : n;
const CV_TRANSFORM = [
  ["Anchor Point", "ADBE Anchor Point"], ["Position", "ADBE Position"],
  ["X Position", "ADBE Position_0"], ["Y Position", "ADBE Position_1"],
  ["Z Position", "ADBE Position_2"], ["Scale", "ADBE Scale"],
  ["Orientation", "ADBE Orientation"], ["X Rotation", "ADBE Rotate X"],
  ["Y Rotation", "ADBE Rotate Y"], ["Rotation", "ADBE Rotate Z"],
  ["Opacity", "ADBE Opacity"],
  ["Appears in Reflections", "ADBE Envir Appear in Reflect"]
];
const CV_ROOT = [
  ["Marker", "ADBE Marker", "prop"],
  ["Time Remap", "ADBE Time Remapping", "prop"],
  ["Motion Trackers", "ADBE MTrackers", "group"],
  ["Masks", "ADBE Mask Parade", "group"],
  ["Effects", "ADBE Effect Parade", "group"],
  ["Transform", "ADBE Transform Group", "group"],
  ["Layer Styles", "ADBE Layer Styles", "group"],
  ["Geometry Options", "ADBE Plane Options Group", "group"],
  ["Geometry Options", "ADBE Extrsn Options Group", "group"],
  ["Material Options", "ADBE Material Options Group", "group"],
  ["Audio", "ADBE Audio Group", "group"],
  ["Data", "ADBE Data Group", "group"],
  ["Essential Properties", "ADBE Layer Overrides", "group"],
  ["Sets", "ADBE Layer Sets", "group"],
  ["Replace Source", "ADBE Source Options Group", "group"]
];
// The installed-effect catalog list_effects pages through. Two of the
// five match "blur" by CATEGORY alone, which is what makes the suite's
// "name OR category" step mean something.
const CV_EFFECTS = [
  { name: "CC Cross Blur", matchName: "CS CrossBlur",
    category: "Blur & Sharpen" },
  { name: "CC Force Motion Blur", matchName: "CC Force Motion Blur",
    category: "Time" },
  { name: "Fast Box Blur", matchName: "ADBE Box Blur2",
    category: "Blur & Sharpen" },
  { name: "Sharpen", matchName: "ADBE Sharpen", category: "Blur & Sharpen" },
  { name: "Directional Blur", matchName: "ADBE Motion Blur",
    category: "Blur & Sharpen" },
  { name: "Glow", matchName: "ADBE Glo2", category: "Stylize" }
];
// Comps carry their settings, so set_comp_setting/duplicate_comp/
// move_to_folder can be read back through get_project_info instead of
// being taken at their word.
const compProps = {};

// Expression-driven properties, the way real AE behaves: a write is
// ACCEPTED and then invisible, because `.value` is the expression's
// answer. `driven[layer/prop]` is what the comp shows; "passthru" models
// an expression that consumes the written value (`value + wiggle(…)`) and
// so really does move. A stub that just remembered the last write would
// let the tools claim a spread that is not in the comp — which is the bug
// the field found.
let driven = {};
// The nine squares grid_layout rigs in the suite (it is called with a
// column count, not a layer list).
const SQUARES = ["ST Square"];
for (let i = 2; i <= 9; i++) SQUARES.push("ST Square " + i);
const drivenKey = (layer, prop) => layer + "/" + String(prop || "")
  .replace(/^position_[xy]$/, "position").toLowerCase();
function markDriven(layer, prop, shows) { driven[drivenKey(layer, prop)] = shows; }
function drivenShows(layer, prop) {
  const v = driven[drivenKey(layer, prop)];
  return (typeof v === "undefined" || v === "passthru") ? null : v;
}

// The batch-call rig asks whether commands after a FAILING one still ran,
// so the canned host has to know which layers exist in that comp -- a stub
// that accepted any layer name would answer the question for free.
let batSolids = [];
// The rollback comp: the canned host has to model the UNDO too, or a
// step could "pass" while the debris it is checking for never existed.
let rbLayers = [];
// The comp-rename rig, and the rename the canned host remembers making.
const RN = { host: "ST RN Host 2021", util: "ST RN Util 2019",
             linked: "ST RN Linked 2020", plain: "ST RN Plain 2019" };
let rnRenamedTo = null;
// set_solid_color rig: three layers sharing one solid, one text layer,
// and whichever layers have since been given their own solid.
const scShared = ["ST SC Square", "ST SC Square 2", "ST SC Square 3"];
const scText = ["ST SC Words"];
let scUnique = [];
// The rollback comp, by its CURRENT name. A step renames it inside an
// armed round that then fails, so a substring match on "Rollback"
// would lose track of the comp exactly when the rename is the thing
// being verified -- and every tool aimed at it would start
// succeeding, which is the one answer that makes the step vacuous.
let rbCompName = "ST Rollback";
const inRbComp = (a) => a && String(a.comp || "") === rbCompName;
let batSolidFx = {};
let batSolidPos = {};
const inBatComp = a => !!(a && /Undo/.test(a.comp || ""));

// Lights. The canned host has to enforce the SAME per-type hiding real
// AE does, or the refusal steps would pass against anything. The table
// is the one measured in AE 2026 (WORKPLAN-LOG 2026-08-26): every light
// property reports canSetValue false, the options group never shrinks,
// and what a type accepts is discoverable only by attempting the write.
const LIGHT_ON = {
  position:        "parallel spot point",
  pointOfInterest: "parallel spot",
  intensity:       "parallel spot point ambient environment",
  color:           "parallel spot point ambient environment",
  coneAngle:       "spot",
  coneFeather:     "spot",
  falloff:         "parallel spot point",
  radius:          "parallel spot point",
  falloffDistance: "parallel spot point",
  castsShadows:    "parallel spot point",
  shadowDarkness:  "parallel spot point",
  shadowDiffusion: "spot point"
};
// Write order: Falloff gates Radius and Falloff Distance, so it is first.
const LIGHT_ORDER = ["position", "pointOfInterest", "intensity", "color",
  "coneAngle", "coneFeather", "falloff", "radius", "falloffDistance",
  "castsShadows", "shadowDarkness", "shadowDiffusion"];
const LIGHT_KINDS = ["parallel", "spot", "point", "ambient", "environment"];
const lightAcc = (list, kind) =>
  (" " + list + " ").indexOf(" " + kind + " ") >= 0;
let lights = {};
// The rigger layers the matte tools have to refuse: cameras by name, the
// same way `lights` already tracks lights.
let cameraNames = {};

// ---- text animators (WORKPLAN 5.1). A canned host that just answered
// "ok" would let a silent add_text_animator pass its own suite steps, so
// this one reproduces the contract the real tool has to hold up: an
// animator carries every property already, hidden until added; a hidden
// one refuses writes and is flagged on reads; a repeated animator name is
// auto-numbered because AE would strand it; per-character 3D is a LAYER
// switch that comes on once; and AE's range refusal is reported, not
// swallowed.
const TXCOMP_NAME = "AELL Self-Test Text";
const TX_SLOTS = {
  opacity: ["Opacity", 100, 0, 100],
  position: ["Position", [0, 0, 0]],
  scale: ["Scale", [100, 100, 100]],
  rotation: ["Rotation", 0],
  xrotation: ["X Rotation", 0],
  yrotation: ["Y Rotation", 0],
  skew: ["Skew", 0],
  tracking: ["Tracking Amount", 0],
  fillcolor: ["Fill Color", [1, 0, 0, 1]]
};
const TX_3D_ONLY = { xrotation: 1, yrotation: 1 };
const txAnims = [];              // [{name, props: {Name: value}, sel}]
let txPerChar = false;
const inTx = (a) => !!a && a.comp === TXCOMP_NAME;
function resetTxRig() { txAnims.length = 0; txPerChar = false; }
function txFind(name) {
  return txAnims.filter(a => a.name === name)[0] || null;
}
// "Text/Animators/<anim>/Properties/<Name>" and the selector twin.
function txParse(path) {
  const m = /^Text\/Animators\/([^/]+)\/(Properties|Selectors)\/(.+)$/
    .exec(String(path || ""));
  if (!m) return null;
  return { anim: txFind(m[1]), kind: m[2], rest: m[3] };
}


// A hidden slot answers a READ (with a flag) and refuses every WRITE --
// the asymmetry the panel now has to reproduce, or the suite would pass
// on a host that quietly wrote to a property AE never renders.
const TX_DORMANT = "this animator property has not been added, so AE " +
  "keeps it hidden and the value below is never applied — " +
  "add_text_animator activates it";
function txSelRows(rec) {
  return (rec && rec.sel && rec.sel.rows) || {};
}
function txReadProp(path) {
  const t = txParse(path);
  if (!t || !t.anim) return null;
  if (t.kind === "Properties") {
    const active = Object.prototype.hasOwnProperty.call(t.anim.props, t.rest);
    const out = { property: path,
                  value: active ? t.anim.props[t.rest] : 0, numKeys: 0 };
    if (!active) out.inactive = TX_DORMANT;
    return out;
  }
  const leaf = t.rest.split("/")[1] || "";
  const rows = txSelRows(t.anim);
  // FACT: a lookup by the display name always finds the PERCENT twin,
  // whatever Units says -- so that is what a read has to answer with.
  const mn = "ADBE Text Percent " + leaf;
  const out = { property: path, matchName: mn,
                value: rows[mn] === undefined ? 0 : rows[mn], numKeys: 0 };
  const keys = t.anim.sel && t.anim.sel.keys;
  if (keys && leaf === "Offset") {
    out.numKeys = keys.length;
    out.keys = keys.slice();
    out.value = keys[0].value;
  }
  return out;
}

// for_each_layer's whole job is deciding which tools it may drive. Rather
// than paraphrasing that rule here — which would let the suite expect a
// refusal for a tool the host happily drives — read the host's own three
// lists straight out of hostscript.jsx.
function hostList(name) {
  const m = new RegExp("var\\s+" + name + "\\s*=\\s*\\[([\\s\\S]*?)\\];")
    .exec(hostSrc);
  if (!m) throw new Error("hostscript.jsx no longer defines " + name);
  return (m[1].match(/"([A-Za-z0-9_]+)"/g) || [])
    .map(s => s.replace(/"/g, ""));
}
const PER_LAYER_TOOLS = hostList("AELL_PER_LAYER_LIST");
const READ_TOOLS = hostList("AELL_PER_LAYER_READ_LIST");
const BATCHED_TOOLS = hostList("AELL_ALREADY_BATCHED_LIST");
// ---- shape contents: a STACK whose filters act on what is ABOVE them,
// under groups that hide their items one hop down (WORKPLAN 5.2, all
// measured in AE 2026). A canned host that only said "ok" would let a
// repeater that renders nothing, and a documented path that resolves to
// nothing, both pass their own suite steps -- which is how both shipped.
const SHAPE_FILTERS = { repeater: 1, trim_paths: 1, merge_paths: 1,
  offset_paths: 1, rounded_corners: 1, pucker_bloat: 1, twist: 1,
  zigzag: 1 };
const SHAPE_ITEM_NAME = { repeater: "Repeater 1", trim_paths: "Trim Paths 1",
  rectangle: "Rectangle Path 1", ellipse: "Ellipse Path 1",
  star: "Polystar Path 1", polygon: "Polystar Path 1", fill: "Fill 1",
  stroke: "Stroke 1" };
// Where each param sits INSIDE its item: "" is a direct child, and a
// repeater's six offsets are one level down in Transform.
const SHAPE_PARAMS = {
  repeater: { Copies: "", Offset: "", Composite: "",
              "Anchor Point": "Transform", Position: "Transform",
              Scale: "Transform", Rotation: "Transform",
              "Start Opacity": "Transform", "End Opacity": "Transform" },
  rectangle: { Size: "", Position: "", Roundness: "" },
  ellipse: { Size: "", Position: "" },
  star: { Type: "", Points: "", "Outer Radius": "" },
  polygon: { Type: "", Points: "", "Outer Radius": "" },
  fill: { Color: "", Opacity: "" },
  stroke: { Color: "", "Stroke Width": "" },
  trim_paths: { Start: "", End: "", Offset: "" }
};
const SHAPE_RANGE = { Copies: [0, null], Composite: [1, 2],
                      "Start Opacity": [0, 100], "End Opacity": [0, 100] };
const SHAPE_DEFAULTS = { repeater: { Copies: 1, Offset: 0, Composite: 1,
    "Transform/Anchor Point": [0, 0], "Transform/Position": [0, 0],
    "Transform/Scale": [100, 100], "Transform/Rotation": 0,
    "Transform/Start Opacity": 100, "Transform/End Opacity": 100 },
  rectangle: { Size: [100, 100], Position: [0, 0], Roundness: 0 },
  trim_paths: { Start: 0, End: 100, Offset: 0 },
  fill: { Color: [1, 1, 1, 1], Opacity: 100 } };
let shapeLayers = {};            // layer -> { groups: [], root: [] }
function resetShapeRig() { shapeLayers = {}; }
function shapeMakesGeometry(it) {
  return it.kind === "group" || /^(rectangle|ellipse|star|polygon)$/
    .test(it.kind);
}
function shapeNewItem(kind, name) {
  const it = { kind: kind, name: name || SHAPE_ITEM_NAME[kind] || kind,
               vals: {}, items: [] };
  const d = SHAPE_DEFAULTS[kind] || {};
  Object.keys(d).forEach(k => { it.vals[k] = d[k]; });
  // A group carries its own Transform BESIDE the Contents its items live
  // in -- the pair that makes "contents/G/Transform" ambiguous.
  if (kind === "group") it.vals["Transform/Rotation"] = 0;
  return it;
}
function shapeAddItem(layer, container, kind, name) {
  const it = shapeNewItem(kind, name);
  container.push(it);
  return it;
}
function shapeLayerOf(name) { return shapeLayers[name] || null; }
function shapeSeedLayer(name, size) {
  // add_shape_layer draws its rectangle inside a group, exactly as AE does,
  // at the size it was ASKED for -- a fixed 10x10 here would have let a
  // step assert bounds the real tool never produces.
  const L = { items: [] };
  const g = shapeAddItem(name, L.items, "group", "Rectangle 1");
  const r = shapeAddItem(name, g.items, "rectangle");
  r.vals.Size = (Array.isArray(size) && size.length >= 2)
    ? [size[0], size[1]] : [200, 200];
  shapeLayers[name] = L;
  return L;
}
function shapeFindGroup(L, name) {
  return L.items.filter(i => i.kind === "group" && i.name === name)[0] || null;
}
/* Resolve a 'contents/...' path the way the host now does: a direct child
   first, then the hop into a group's hidden Contents. */
function shapeResolve(L, layerName, path) {
  const segs = String(path).split("/").filter(s => s !== "");
  if (!segs.length || segs[0].toLowerCase() !== "contents") return null;
  let list = L.items, node = null, walked = ["contents"];
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    if (node && node.kind === "group" && seg === "Contents") continue;
    if (node) {
      const inner = node.kind === "group" ? node.items : null;
      // a param, possibly under the item's own Transform block
      const map = SHAPE_PARAMS[node.kind] || {};
      const rest = segs.slice(i).join("/");
      if (node.kind !== "group" || seg === "Transform") {
        const key = Object.prototype.hasOwnProperty.call(node.vals, rest)
          ? rest : null;
        if (key) return { item: node, key: key };
        if (Object.prototype.hasOwnProperty.call(map, seg) &&
            i === segs.length - 1) {
          return { item: node, key: (map[seg] ? map[seg] + "/" : "") + seg };
        }
      }
      if (!inner) {
        return { __err: "Path segment '" + seg + "' not found under '" +
          walked.join("/") + "'. Children here: " +
          Object.keys(node.vals).join(", ") +
          ". Use list_properties to inspect the real tree." };
      }
      const hit = inner.filter(c => c.name === seg)[0];
      if (!hit) {
        return { __err: "Path segment '" + seg + "' not found under '" +
          walked.join("/") + "'. Children here: Blend Mode, Contents, " +
          "Transform — and inside Contents: " +
          inner.map(c => c.name).join(", ") +
          ". Use list_properties to inspect the real tree." };
      }
      node = hit; walked.push(seg); continue;
    }
    const top = list.filter(c => c.name === seg)[0];
    if (!top) {
      return { __err: "Path segment '" + seg + "' not found under '" +
        walked.join("/") + "'. Children here: " +
        list.map(c => c.name).join(", ") +
        ". Use list_properties to inspect the real tree." };
    }
    node = top; walked.push(seg);
  }
  return { __err: "'" + path + "' is a GROUP — set one of its properties " +
    "instead" };
}
/* Rendered bounds, which is the only thing that says a repeater repeated:
   geometry in a group, widened by any repeater BELOW it. */
/* The value of an animated shape param at SOURCE time t: AE holds before
   the first key and after the last, which is all the bounds steps read. */
function shapeValAt(it, key, t) {
  const keys = it.keys && it.keys[key];
  if (!keys || !keys.length || typeof t !== "number") return it.vals[key];
  let v = keys[0].value;
  for (const k of keys) if (t >= k.time) v = k.value;
  return v;
}
function shapeBounds(L, t, extents) {
  let minX = null, maxX = null, minY = null, maxY = null;
  function eat(x0, x1, y0, y1) {
    minX = minX === null ? x0 : Math.min(minX, x0);
    maxX = maxX === null ? x1 : Math.max(maxX, x1);
    minY = minY === null ? y0 : Math.min(minY, y0);
    maxY = maxY === null ? y1 : Math.max(maxY, y1);
  }
  L.items.forEach(g => {
    if (g.kind !== "group") return;
    let gx0 = null, gx1 = 0, gy0 = 0, gy1 = 0;
    // extents grows the box by the stroke's MITER ALLOWANCE, not by half
    // its width: measured in AE 2026 twice, a 40px stroke adds 100 on
    // every side -- half-width x (the default miter limit 4 + 1).
    let pad = 0;
    if (extents) {
      g.items.forEach(it => {
        if (it.kind === "stroke") {
          pad = Math.max(pad, (Number(it.vals["Stroke Width"]) || 0) * 2.5);
        }
      });
    }
    g.items.forEach(it => {
      if (/^(rectangle|ellipse)$/.test(it.kind)) {
        const s = shapeValAt(it, "Size", t) || [100, 100];
        const p = it.vals.Position || [0, 0];
        const x0 = p[0] - s[0] / 2, x1 = p[0] + s[0] / 2;
        const y0 = p[1] - s[1] / 2, y1 = p[1] + s[1] / 2;
        if (gx0 === null) { gx0 = x0; gx1 = x1; gy0 = y0; gy1 = y1; }
        else { gx0 = Math.min(gx0, x0); gx1 = Math.max(gx1, x1);
               gy0 = Math.min(gy0, y0); gy1 = Math.max(gy1, y1); }
      } else if (it.kind === "repeater" && gx0 !== null) {
        // A repeater acts on what is above it: nothing above, nothing to
        // widen -- the silent no-op this suite exists to catch.
        const n = Math.max(1, Math.floor(it.vals.Copies || 1));
        const off = it.vals["Transform/Position"] || [0, 0];
        const dx = off[0] * (n - 1), dy = off[1] * (n - 1);
        gx0 = Math.min(gx0, gx0 + dx); gx1 = Math.max(gx1, gx1 + dx);
        gy0 = Math.min(gy0, gy0 + dy); gy1 = Math.max(gy1, gy1 + dy);
      }
    });
    if (gx0 !== null) eat(gx0 - pad, gx1 + pad, gy0 - pad, gy1 + pad);
  });
  if (minX === null) return null;
  return [minX, maxX, minY, maxY];
}


// ---- the bounds rig, modelled from AE 2026 (probes, WORKPLAN-LOG
// 2026-08-29) rather than from the tool ------------------------------
// The three facts the get_bounds steps exist to pin, and which this
// model therefore has to obey on AE's side of the fence:
//   - sourceRectAtTime ignores the layer's transform entirely;
//   - its time argument is the layer's OWN source time (unshifted by
//     startTime, unscaled by stretch) while property times are comp
//     times;
//   - cameras and lights have no sourceRectAtTime at all.
// A text layer's rect is the glyphs', measured from the BASELINE, so its
// top is negative -- the numbers below are 48px readings, not round ones.
const bnLayers = {};
const inBnComp = (a) => !!(a && /Bounds/.test(a.comp || ""));
const resetBoundsRig = () => {
  for (const k of Object.keys(bnLayers)) delete bnLayers[k];
};
function bnAdd(name, kind, extra) {
  const L = { kind: kind, pos: [0, 0], anchor: [0, 0], scale: [100, 100],
              rot: 0, parent: null, startTime: 0, stretch: 100,
              threeD: false, w: 100, h: 100, posKeys: [], z: 0,
              __name: name };
  Object.assign(L, extra || {});
  bnLayers[name] = L;
  return L;
}
/* Where a layer's Position IS at a time. Keyframes make this differ from
   L.pos, which is the whole reason parenting to an animated layer only
   holds still at one frame -- a model that ignored time could not tell
   the two apart. Linear between keys, held outside them. */
function bnPosAt(L, t) {
  const ks = L.posKeys;
  if (!ks || !ks.length) return L.pos;
  const at = typeof t === "number" ? t : 0;
  if (at <= ks[0].time) return ks[0].value;
  if (at >= ks[ks.length - 1].time) return ks[ks.length - 1].value;
  let i = 0;
  while (i < ks.length - 1 && ks[i + 1].time < at) i++;
  const f = (at - ks[i].time) / (ks[i + 1].time - ks[i].time);
  return [ks[i].value[0] + (ks[i + 1].value[0] - ks[i].value[0]) * f,
          ks[i].value[1] + (ks[i + 1].value[1] - ks[i].value[1]) * f];
}
function bnRect(name, t, extents) {
  const L = bnLayers[name];
  if (!L) return { left: 0, top: 0, width: 100, height: 100 };
  if (L.kind === "shape") {
    const SL = shapeLayerOf(name);
    const b = SL ? shapeBounds(SL, t, extents) : null;
    if (!b) return { left: 0, top: 0, width: 0, height: 0 };
    return { left: b[0], top: b[2], width: b[1] - b[0], height: b[3] - b[2] };
  }
  if (L.kind === "text") {
    return { left: 2.53, top: -34.7, width: 148.34, height: 35.06 };
  }
  return { left: 0, top: 0, width: L.w, height: L.h };
}
/* One layer's own transform applied to a point already measured from its
   anchor -- scale, then rotation, then position. */
function bnXform(L, pt, t) {
  const P = bnPosAt(L, t);
  const x = pt[0] * (L.scale[0] / 100), y = pt[1] * (L.scale[1] / 100);
  const rad = L.rot * Math.PI / 180;
  return [x * Math.cos(rad) - y * Math.sin(rad) + P[0],
          x * Math.sin(rad) + y * Math.cos(rad) + P[1]];
}
function bnUnXform(L, pt, t) {       // the inverse, for a new parent link
  const P = bnPosAt(L, t);
  const rad = -L.rot * Math.PI / 180;
  const dx = pt[0] - P[0], dy = pt[1] - P[1];
  const x = dx * Math.cos(rad) - dy * Math.sin(rad);
  const y = dx * Math.sin(rad) + dy * Math.cos(rad);
  return [x / (L.scale[0] / 100), y / (L.scale[1] / 100)];
}
function bnCompPoint(name, srcPt, t) {
  const L = bnLayers[name];
  let pt = bnXform(L, [srcPt[0] - L.anchor[0], srcPt[1] - L.anchor[1]], t);
  let up = L.parent ? bnLayers[L.parent] : null, guard = 0;
  while (up && guard++ < 32) {
    pt = bnXform(up, pt, t);
    up = up.parent ? bnLayers[up.parent] : null;
  }
  return pt;
}
/* Everything above a layer that MOVES, in the shape set_layer_parent
   reports it -- the model's half of the warning. */
function bnMovingChain(name) {
  const out = [];
  let L = name ? bnLayers[name] : null, guard = 0;
  while (L && guard++ < 32) {
    if (L.posKeys && L.posKeys.length) {
      out.push(L.__name + ": Position (" + L.posKeys.length + " keys)");
    }
    L = L.parent ? bnLayers[L.parent] : null;
  }
  return out;
}
function bnThreeD(name) {
  const hits = [];
  let L = bnLayers[name], guard = 0;
  while (L && guard++ < 32) {
    if (L.threeD) hits.push(L.__name);
    L = L.parent ? bnLayers[L.parent] : null;
  }
  return hits;
}
const bnR3 = (v) => Math.round(v * 1000) / 1000;
const bnSecs = (t) => (Math.round(Number(t) * 1000) / 1000) + "s";
function bnBounds(args, compW, compH) {
  const name = args && args.layer;
  const L = bnLayers[name];
  if (Array.isArray(args && args.layers)) {
    return { __err: "get_bounds reads ONE layer. Call it once per " +
      "layer -- for_each_layer reports only counts, so it would throw " +
      "every measurement away." };
  }
  if (!L) {
    return { __err: "No layer '" + name + "' in '" + args.comp + "' -- " +
      "it holds: " + Object.keys(bnLayers).join(", ") };
  }
  if (L.kind === "camera" || L.kind === "light") {
    return { __err: "A " + L.kind + " layer ('" + name + "') renders no " +
      "pixels, so it has no bounds -- AE gives sourceRectAtTime only to " +
      "layers with content (text, shape, solid, footage, precomp, null). " +
      "For a camera or light read its Position with get_property instead." };
  }
  let t = args && args.time;
  if (typeof t === "string" && t !== "" && !isNaN(Number(t))) t = Number(t);
  if (typeof t !== "number") {
    if (typeof (args && args.time) !== "undefined" && args.time !== null) {
      return { __err: "'time' must be a number of seconds; got " +
        JSON.stringify(args.time) };
    }
    t = 0;
  }
  const extents = !!(args && args.extents);
  const srcT = (t - L.startTime) / (L.stretch / 100);
  const r = bnRect(name, srcT, extents);
  const out = { layer: name, layerType: L.kind, time: bnR3(t),
    extents: extents,
    source: { left: bnR3(r.left), top: bnR3(r.top),
              right: bnR3(r.left + r.width), bottom: bnR3(r.top + r.height),
              width: bnR3(r.width), height: bnR3(r.height),
              centerX: bnR3(r.left + r.width / 2),
              centerY: bnR3(r.top + r.height / 2) },
    compSize: [compW, compH] };
  if (bnR3(srcT) !== bnR3(t)) {
    out.sourceTime = bnR3(srcT);
    out.timeNote = "measured at source time " + bnSecs(srcT) + ", which " +
      "is comp time " + bnSecs(t) + " for this layer (it starts at " +
      bnSecs(L.startTime) + " and is stretched to " + L.stretch + "%)";
  }
  if (out.source.width === 0 && out.source.height === 0) {
    out.empty = "this layer renders nothing at " + bnSecs(t) +
      (L.kind === "shape" ? " -- the shape layer has no drawn content yet"
                          : " -- check that the layer is on at this time");
  }
  const threeD = bnThreeD(name);
  if (threeD.length) {
    out.comp = null;
    out.compBoxUnavailable = "'" + threeD[0] + "' is a 3D layer, so where " +
      "these pixels land in the frame depends on the camera. AE's own " +
      "sourcePointToComp ignores Z, the camera and a 3D parent's rotation " +
      "(measured), so no honest comp-space box can be reported.";
    return out;
  }
  const pts = [[r.left, r.top], [r.left + r.width, r.top],
               [r.left + r.width, r.top + r.height],
               [r.left, r.top + r.height]].map(p => bnCompPoint(name, p, t));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  out.comp = { left: bnR3(minX), top: bnR3(minY), right: bnR3(maxX),
    bottom: bnR3(maxY), width: bnR3(maxX - minX), height: bnR3(maxY - minY),
    centerX: bnR3((minX + maxX) / 2), centerY: bnR3((minY + maxY) / 2) };
  out.corners = pts.map(p => [bnR3(p[0]), bnR3(p[1])]);
  if (L.rot % 360 !== 0) {
    out.rotated = L.rot % 360;
    out.rotatedNote = "the layer is rotated " + bnR3(L.rot % 360) +
      " degrees, so comp.width/height describe the axis-aligned box " +
      "AROUND it, not the layer's own size (source.width/height is that)";
  }
  const over = {};
  if (minX < 0) over.left = bnR3(-minX);
  if (minY < 0) over.top = bnR3(-minY);
  if (maxX > compW) over.right = bnR3(maxX - compW);
  if (maxY > compH) over.bottom = bnR3(maxY - compH);
  if (!Object.keys(over).length) {
    out.inFrame = "fully";
  } else if (maxX <= 0 || maxY <= 0 || minX >= compW || minY >= compH) {
    out.inFrame = "outside";
    out.outsideBy = over;
  } else {
    out.inFrame = "partly";
    out.outsideBy = over;
  }
  return out;
}
/* AE's side of every bounds-rig call. Returns undefined for the tools the
   generic canned host already models (the shape ones), so they fall
   through instead of being modelled twice. */
function bnCanned(tool, args) {
  const name = args && args.layer;
  switch (tool) {
    case "add_solid":
      bnAdd(args.name, "solid",
            { w: args.width || 100, h: args.height || 100,
              anchor: [(args.width || 100) / 2, (args.height || 100) / 2],
              pos: [500, 400] });
      return { name: args.name, index: 1 };
    case "add_null":
      bnAdd(args.name, "null", { pos: (args.position || [0, 0]).slice() });
      leakNullSource();
      return { name: args.name, index: 1 };
    case "add_text_layer":
      // AE names a text layer after its TEXT; the tool takes no 'name'.
      bnAdd(args.text, "text", { pos: [500, 400] });
      return { name: args.text, index: 1 };
    case "add_camera":
      bnAdd(args.name || "Camera", "camera", { threeD: true });
      return { name: args.name || "Camera", index: 1 };
    case "set_transform": {
      const L = bnLayers[name];
      if (!L) return undefined;
      const v = args.value;
      if (args.property === "position") {
        L.pos = [v[0], v[1]];
        if (v.length > 2) L.z = v[2];
      } else if (args.property === "anchorPoint") L.anchor = [v[0], v[1]];
      else if (args.property === "scale") L.scale = [v[0], v[1]];
      else if (args.property === "rotation") L.rot = Number(v);
      return { layer: name, property: args.property, value: v };
    }
    // Two DIFFERENT AE calls, and the tool shipped with them swapped
    // (measured 2026-08-29): keepPosition (the default) is `.parent =`,
    // which rewrites the child's transform -- current value AND every
    // keyframe -- so nothing moves on screen; keepPosition:false is
    // setParentWithJump, which touches nothing and lets the layer jump.
    case "set_layer_parent": {
      const L = bnLayers[name];
      if (!L) return undefined;
      const keep = args.keepPosition !== false;
      const clearing = args.parent === null ||
                       typeof args.parent === "undefined";
      const nk = keep ? L.posKeys.length : 0;
      // The compensation is worked out ONCE, at one frame (measured
      // 2026-08-29). With no atTime/atFrame that frame is the playhead,
      // which this rig leaves at 0.
      let T = 0, asked = false;
      if (typeof args.atFrame !== "undefined" && args.atFrame !== null &&
          args.atFrame !== "") {
        if (isNaN(Number(args.atFrame))) {
          return { __err: "atFrame must be a frame number; got " +
                          JSON.stringify(args.atFrame) };
        }
        T = Number(args.atFrame) / 30; asked = true;
      } else if (typeof args.atTime !== "undefined" && args.atTime !== null &&
                 args.atTime !== "") {
        if (isNaN(Number(args.atTime))) {
          return { __err: "atTime must be a number of seconds; got " +
                          JSON.stringify(args.atTime) };
        }
        T = Number(args.atTime); asked = true;
      }
      if (asked && !keep) {
        return { __err: "atTime/atFrame only means something when the " +
          "layer is being kept still. keepPosition:false leaves every " +
          "value alone, so there is no frame to compensate at -- drop " +
          "one of the two." };
      }
      if (asked && (T < 0 || T > 6)) {
        return { __err: "atTime " + T + "s is outside \"" + args.comp +
          "\", which runs 0 to 6s at 30 fps" };
      }
      const oldParent = L.parent;
      const movers = bnMovingChain(clearing ? oldParent : args.parent);
      if (keep) {
        // Bake the comp-space point AT THAT FRAME, relink, then read it
        // back in the new parent's space -- the shift AE applies to every
        // key too, which is why a keyed child's MOTION changes.
        const compPos = bnCompPoint(name, L.anchor, T);
        const before = L.pos;
        L.parent = clearing ? null : args.parent;
        L.pos = clearing ? compPos
                         : bnUnXform(bnLayers[args.parent], compPos, T);
        const dx = L.pos[0] - before[0], dy = L.pos[1] - before[1];
        for (const k of L.posKeys) {
          k.value = [k.value[0] + dx, k.value[1] + dy, 0];
        }
        // Z only passes between two 3D layers: a 2D parent leaves a 3D
        // child's Z alone, and a 3D parent's Z never reaches a 2D child.
        const wasP = oldParent ? bnLayers[oldParent] : null;
        const nowP = clearing ? null : bnLayers[args.parent];
        const oldZ = (wasP && wasP.threeD && L.threeD) ? (wasP.z || 0) : 0;
        const newZ = (nowP && nowP.threeD && L.threeD) ? (nowP.z || 0) : 0;
        L.z = (L.z || 0) + oldZ - newZ;
      } else {
        L.parent = clearing ? null : args.parent;
      }
      const out = { layer: name, parent: clearing ? "(none)" : args.parent,
        parented: name, skipped: "", keepPosition: keep,
        note: keep
          ? (clearing
              ? "Unparented with no visual jump: AE rewrote each layer's " +
                "Position/Scale/Rotation back into comp space, so the " +
                "numbers changed and the picture did not."
              : "No visual jump: AE rewrote each layer's Position/Scale/" +
                "Rotation into the parent's space, so those values now " +
                "read differently from before. Read them back rather " +
                "than assuming the old ones.")
          : (clearing
              ? "keepPosition:false -- values were left alone, so each " +
                "layer JUMPED to wherever its raw transform puts it in " +
                "comp space."
              : "keepPosition:false -- values were left alone, so each " +
                "layer JUMPED by the parent's transform.") };
      if (nk > 0) {
        out.keyframesRewritten = name + " (" + nk + ")";
        out.keyframesNote = "AE rewrote all " + nk + " transform " +
          "keyframe(s) on these layers, not just the current value; the " +
          "old numbers are gone.";
      }
      if (keep) {
        out.compensatedAt = (Math.round(T * 1000) / 1000) + "s (frame " +
          Math.round(T * 30) + ")" +
          (asked ? ", as asked" : ", the playhead where it stood");
      }
      if (movers.length) {
        out.parentAnimated = movers.join("; ");
        out.parentAnimatedNote = (clearing
          ? "The parent it left MOVES over time. AE compensates once, at " +
            out.compensatedAt.split(",")[0] + ", so the layer keeps the " +
            "position it had THERE and loses the motion the parent was " +
            "giving it at every other frame."
          : "That parent MOVES over time. AE compensates once, at " +
            out.compensatedAt.split(",")[0] + ", so the layer sits " +
            "exactly where it was at that frame and travels with the " +
            "parent everywhere else -- this is NOT a jump-free link " +
            "across the whole timeline.") +
          " Pass atTime/atFrame to choose the frame that must not move" +
          (clearing ? "." : ", or keepPosition:false to leave the numbers " +
            "alone and let the layer ride the parent.");
        if (nk > 0) {
          out.parentAnimatedNote += " These layers have keyframes of " +
            "their own, which now play inside that moving space, so " +
            "their MOTION changed, not just their numbers.";
        }
      }
      return out;
    }
    case "set_keyframes": {
      const L = bnLayers[name];
      if (!L || !/position/i.test(String(args.property || ""))) {
        return undefined;
      }
      L.posKeys = (args.keys || []).map(k => ({
        time: k.time, value: [k.value[0], k.value[1], 0] }));
      if (L.posKeys.length) L.pos = L.posKeys[0].value.slice(0, 2);
      return { layer: name, property: args.property,
               keysSet: L.posKeys.length };
    }
    case "delete_layer": {
      if (!bnLayers[name]) return undefined;
      delete bnLayers[name];
      return { deleted: name };
    }
    case "set_layer_timing": {
      const L = bnLayers[name];
      if (!L) return undefined;
      if (typeof args.startTime === "number") L.startTime = args.startTime;
      return { layer: name, startTime: L.startTime, inPoint: L.startTime,
               outPoint: L.startTime + 6 };
    }
    case "set_layer_3d": {
      const L = bnLayers[name];
      if (!L) return undefined;
      L.threeD = !!args.enabled;
      return { layer: name, threeD: L.threeD };
    }
    case "get_property": {
      const L = bnLayers[name];
      if (!L) return undefined;
      if (/anchor point$/i.test(String(args.property || ""))) {
        return { layer: name, property: args.property,
                 value: [L.anchor[0], L.anchor[1], 0], numKeys: 0 };
      }
      if (/^position$/i.test(String(args.property || ""))) {
        const out = { layer: name, property: args.property,
                      value: [L.pos[0], L.pos[1], L.z || 0],
                      numKeys: L.posKeys.length };
        if (L.posKeys.length) {
          out.keys = L.posKeys.map(k => ({ time: k.time,
                                           value: k.value.slice() }));
        }
        return out;
      }
      return undefined;
    }
    case "get_bounds":
      return bnBounds(args, 1000, 800);
    default:
      return undefined;
  }
}

// The singular-{layer} gate, mirrored from AELL_resolveLayer. A tool that
// takes ONE layer used to answer the bare "Missing 'layer' (name or
// 1-based index)" -- which names the absent key and never the key that
// arrived instead, so chat-probe row 36 re-sent {layers: [...]} to
// apply_effect and gave up. A canned host that just answered {ok} would
// let those refusal steps pass against anything.
//
// Scoped to the tools with NO plural branch of their own: set_property,
// set_layer_parent, get_bounds and the batch tools all read {layers}
// themselves, so the gate must not speak for them.
const SINGULAR_LAYER_TOOLS = ["apply_effect", "set_effect_param",
  "link_property", "add_control", "set_expression", "add_mask"];

// The comp's own roster, for the grounded bare-miss message. Only the
// batch comp is modelled by name here; that is the comp the refusal
// steps run in, and a roster invented for the others would be a lie.
function compRoster(comp) {
  if (!/Batch/.test(String(comp || ""))) return "(none)";
  const out = [];
  for (let i = 1; i <= batchLayers && i <= 8; i++) {
    out.push(i === 1 ? "ST Batch" : "ST Batch " + i);
  }
  if (batchLayers > 8) {
    return out.join(", ") + " … and " + (batchLayers - 8) + " more";
  }
  return out.join(", ") || "(none)";
}

function singularLayerGate(tool, args) {
  if (SINGULAR_LAYER_TOOLS.indexOf(tool) === -1) return null;
  const a = args || {};
  const plural = Array.isArray(a.layers) && a.layers.length
    ? a.layers : null;
  const redirect = " for_each_layer {layers: [...], tool: '" + tool +
    "', args: {...}} runs it on each.";
  if (Array.isArray(a.layer)) {
    return { __err: "'layer' (name or 1-based index) takes ONE layer, not " +
      "a list — you passed " + a.layer.join(", ") + "." + redirect };
  }
  if (plural) {
    return { __err: "Missing 'layer' (name or 1-based index) — you passed " +
      "'layers' (" + plural.join(", ") + "), which '" + tool +
      "' does not take." + redirect };
  }
  if (a.layer === null || typeof a.layer === "undefined" || a.layer === "") {
    return { __err: "Missing 'layer' (name or 1-based index). Layers in '" +
      String(a.comp || "") + "': " + compRoster(a.comp) + "." };
  }
  return null;
}

function cannedOk(tool, args) {
  const gated = singularLayerGate(tool, args);
  if (gated) return gated;
  if (inBnComp(args)) {
    const bn = bnCanned(tool, args);
    if (typeof bn !== "undefined") return bn;
  }
  switch (tool) {
    case "create_comp":
      createCount++;
      // Remember every comp, so get_project_info can answer with the
      // project this run actually built instead of a hard-coded list that
      // would drift the moment a step creates a differently-named comp.
      createdComps.push(createCount === 1 ? "AELL Self-Test"
        : createCount === 2 ? "AELL Self-Test 2"
        : ((args && args.name) || "AELL Self-Test 3"));
      compProps[createdComps[createdComps.length - 1]] = {
        width: (args && args.width) || 1280,
        height: (args && args.height) || 720,
        duration: (args && args.duration) || 8,
        frameRate: (args && args.frameRate) || 30,
        // Every real comp carries these from the moment it exists.
        waStart: 0, waDur: (args && args.duration) || 8, rf: [1, 1] };
      // 1st = the scratch comp, 2nd = the deliberate name collision that
      // must auto-number, 3rd+ = whatever was asked for (the camera comp).
      if (createCount === 1) return { name: "AELL Self-Test", id: 1 };
      if (createCount === 2) return { name: "AELL Self-Test 2", id: 2 };
      return { name: (args && args.name) || "AELL Self-Test 3",
               id: createCount };
    case "duplicate_layer": {
      if (inRbComp(args) && rbLayers.indexOf(args.layer) === -1) {
        // The grounded error that started the field bug: nothing to copy
        // because add_solid had not run yet.
        return { __err: "No layer '" + args.layer + "' in '" + args.comp +
          "' -- it holds: " + (rbLayers.join(", ") || "nothing") };
      }
      const n = (args && args.count) || 8;
      if (args && args.layer === "ST Batch") batchLayers = n + 1;
      return { created: n, totalLayersInComp: n + 1 };
    }
    case "for_each_layer": {
      const t = (args && args.tool) || "";
      const drivable = "Drivable tools: " + PER_LAYER_TOOLS.join(", ") + ".";
      if (BATCHED_TOOLS.indexOf(t) !== -1) {
        return { __err: "'" + t + "' already takes its own {layers} list " +
          "— call it ONCE with every layer instead of once per layer. " +
          drivable };
      }
      if (READ_TOOLS.indexOf(t) !== -1) {
        return { __err: "'" + t + "' READS a value, and for_each_layer " +
          "reports only counts — every value it returned would be " +
          "discarded. " + drivable };
      }
      if (PER_LAYER_TOOLS.indexOf(t) === -1) {
        // Refused, so it never runs and the project never grows. In REAL
        // AE the "and NO junk comps were created" step is a measurement;
        // here it checks that a refusal really is inert.
        return { __err: "'" + t + "' has no per-layer target, so running " +
          "it once per layer would just repeat the same comp- or " +
          "project-level action N times and report it as success. " +
          drivable };
      }
      const L = ((args && args.layers) || []).slice();
      const sub = (args && args.args) || {};
      if (t === "apply_effect") {
        L.forEach(nm => { batchFx[nm] = sub.effect; });
        return { tool: t, layers: L.length, succeeded: L.length,
                 failures: "" };
      }
      if (t === "set_effect_param") {
        // Only layers that really carry the effect can take the param —
        // that is what makes "reaches all 60" mean anything.
        const hit = L.filter(nm => batchFx[nm] === sub.effect);
        if (hit.length) batchBlur = sub.value;
        return { tool: t, layers: L.length, succeeded: hit.length,
                 failures: hit.length === L.length ? ""
                   : (L.length - hit.length) + " layers lack " + sub.effect };
      }
      return { tool: t, layers: L.length, succeeded: L.length,
               failures: "" };
    }
    case "create_folder": {
      // Folders live as a path->true map. Faithful on what the fan-out
      // steps measure: eachChildOf walks the REAL direct children, an
      // existing same-named folder is reported not re-created, and the
      // created paths come back as receipts.
      const nm = String((args && args.name) || "");
      if (args && args.eachChildOf) {
        const base = String(args.eachChildOf);
        if (!folders[base]) {
          return { __err: "Folder not found: " + base +
                   ". Existing folders: " + Object.keys(folders).join(", ") };
        }
        let kids = Object.keys(folders).filter(p =>
          p.indexOf(base + "/") === 0 &&
          p.slice(base.length + 1).indexOf("/") === -1);
        if (!kids.length) {
          return { __err: "'" + base + "' has no subfolders to create '" +
                   nm + "' in. It holds: (nothing)" };
        }
        // The exclusion is a promise: unknown names refuse, honored
        // names are reported — same contract as the real host.
        const skippedExc = [];
        if (args.except) {
          // Bare names and full paths both match, like the real host.
          const exc = (Array.isArray(args.except) ? args.except
                        : [args.except])
            .map(x => String(x).indexOf(base + "/") === 0
              ? String(x).slice(base.length + 1) : String(x));
          const kidNames = kids.map(p => p.slice(base.length + 1));
          const miss = exc.filter(x => kidNames.indexOf(x) === -1);
          if (miss.length) {
            return { __err: "'except' name(s) not among the subfolders " +
                     "of '" + base + "': " + miss.join(", ") +
                     ". Its subfolders: " + kidNames.join(", ") +
                     ". Fix the except list and re-call — nothing was " +
                     "created." };
          }
          kids = kids.filter(p => {
            const n = p.slice(base.length + 1);
            if (exc.indexOf(n) !== -1) { skippedExc.push(n); return false; }
            return true;
          });
        }
        const created = [], had = [];
        for (const k of kids) {
          const p = k + "/" + nm;
          if (folders[p]) had.push(p);
          else {
            const kid = ++nextFolderId;
            folders[p] = kid; folderIds[kid] = p; created.push(p);
          }
        }
        const out = { name: nm, parent: base, subfolders: kids.length,
                      createdCount: created.length, created };
        if (had.length) {
          out.alreadyExistedCount = had.length;
          out.alreadyExisted = had;
        }
        if (skippedExc.length) out.skippedAsExcepted = skippedExc;
        return out;
      }
      const parent = args && args.parent ? String(args.parent) : "";
      if (parent && !folders[parent]) {
        return { __err: "Parent folder not found: " + parent +
                 ". Existing folders: " + Object.keys(folders).join(", ") };
      }
      const path = parent ? parent + "/" + nm : nm;
      if (folders[path]) {
        return { name: nm, id: folders[path], path,
                 note: "Folder already existed in this parent" };
      }
      const fid = ++nextFolderId;
      folders[path] = fid;
      folderIds[fid] = path;
      return { name: nm, id: fid, path };
    }
    case "delete_item": {
      // Faithful on the point the cleanup measures: deleting works by
      // name OR id, a deleted item leaves every later listing, and a
      // missing target is a grounded error, not a silent ok.
      const key = args && args.item;
      const ci = createdComps.indexOf(String(key));
      if (ci !== -1) { createdComps.splice(ci, 1); return { deleted: key }; }
      for (let i = 0; i < solidSources.length; i++) {
        if (solidSources[i].id === key ||
            solidSources[i].name === String(key)) {
          const nm = solidSources[i].name;
          solidSources.splice(i, 1);
          return { deleted: nm };
        }
      }
      // A folder delete cascades to everything under its path, and works
      // by PATH or by the id create_folder handed back (real AE resolves
      // either -- a stub that only knew names would let a cleanup step
      // "pass" while the suite deleted a same-named folder of the user's).
      const fpath = folderIds[key] || (folders[String(key)] ? String(key) : null);
      if (fpath) {
        for (const p of Object.keys(folders)) {
          if (p === fpath || p.indexOf(fpath + "/") === 0) {
            delete folderIds[folders[p]];
            delete folders[p];
          }
        }
        return { deleted: fpath };
      }
      return { __err: "Project item not found: " + key };
    }
    case "clean_project": {
      // Modelled to REFUSE the way the real tool does: a canned host that
      // answered {ok} would let all six refusal steps pass while the tool
      // happily deleted the user's project.
      const act = String((args && args.action) || "")
        .toLowerCase().replace(/[\s\-]+/g, "_");
      const known = { remove_unused_footage: 1, remove_unused: 1, unused: 1,
                      consolidate_footage: 1, consolidate: 1,
                      reduce_project: 1, reduce: 1 };
      const menu = "remove_unused_footage | consolidate_footage | " +
                   "reduce_project";
      if (!act) return { __err: "clean_project needs an 'action'. " + menu };
      if (!known[act]) {
        return { __err: "Unknown action '" + args.action + "'. " + menu };
      }
      const action = /reduce/.test(act) ? "reduce_project"
                   : /consolidate/.test(act) ? "consolidate_footage"
                   : "remove_unused_footage";
      // No comp or layer scope (0.11.7). Modelled here for the same
      // reason the refusals above are: a canned host that accepted a
      // comp-scoped call would pass the suite step while the real tool
      // ignored the argument and deleted project-wide.
      const scopeKeys = action === "reduce_project"
        ? ["layer", "layers", "layerName", "layerNames"]
        : ["comp", "comps", "compName", "compNames", "keepComps",
           "layer", "layers", "layerName", "layerNames"];
      const offenders = [], scopeVals = [];
      for (const k of scopeKeys) {
        const v = args ? args[k] : undefined;
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) {
          if (!v.length) continue;
          for (const one of v) scopeVals.push(String(one));
        } else scopeVals.push(String(v));
        offenders.push(k);
      }
      if (offenders.length) {
        const named = scopeVals.filter((n) => createdComps.indexOf(n) !== -1);
        let msg = "clean_project has no comp or layer scope: it works on " +
          "the PROJECT PANEL, and " + action + " would ignore " +
          offenders.join(", ") + " and delete project-wide. ";
        if (named.length) {
          msg += "'" + named.join("', '") + "' " +
            (named.length > 1 ? "are comps" : "is a comp") +
            " in this project. To tidy a COMP, remove exactly what was " +
            "named, with the tool that removes it (remove_keyframes, " +
            "remove_effect, delete_mask, delete_layer, precompose); if " +
            "nothing was named, ask the user what should go. ";
        }
        msg += "To clean the PROJECT PANEL instead, call clean_project " +
          "again with action alone" +
          (action === "reduce_project" ? " plus keepComps" : "") + ".";
        return { __err: msg };
      }
      const dryRun = !(args && args.dryRun === false);
      const orphans = solidSources
        .filter((so) => String(so.name).indexOf("ST HYG Orphan") === 0)
        .map((so) => "Solids/" + so.name);
      if (action === "reduce_project") {
        let keep = (args && args.keepComps) || null;
        if (typeof keep === "string") keep = [keep];
        if (!keep || !keep.length) {
          return { __err: "reduce_project deletes every comp, footage " +
            "item and folder that the comps you keep do not need, so it " +
            "will not guess which ones matter. Name them in keepComps. " +
            "Comps in this project: " + createdComps.join(", ") };
        }
        for (const nm of keep) {
          if (createdComps.indexOf(String(nm)) !== -1) continue;
          if (solidSources.some((so) => so.name === String(nm))) {
            return { __err: "'" + nm + "' is a footage, not a comp. AE " +
              "accepts a non-comp here and then deletes EVERY comp in " +
              "the project, so it is refused. Name comps only." };
          }
          return { __err: "Comp not found: " + nm +
            ". Comps in this project: " + createdComps.join(", ") };
        }
        const doomedComps = createdComps.filter((c) => keep.indexOf(c) === -1);
        const out = { action, dryRun, keepComps: keep,
          willRemove: doomedComps.length + orphans.length,
          items: doomedComps.concat(orphans),
          compsRemoved: doomedComps.length };
        if (doomedComps.indexOf("ST HYG Drop") !== -1) {
          out.expressionBreaks = ["ST HYG Drop is named (comp()) by an " +
            "expression on ST HYG Keep / ST HYG Used / Opacity"];
          out.expressionNote = "AE does NOT report these: the expression " +
            "stays on the layer and expressionError reads empty.";
        }
        out.note = dryRun ? "PREVIEW ONLY — nothing was deleted."
                          : "deleted in ONE undo group (Ctrl+Z)";
        return out;
      }
      const items = action === "remove_unused_footage" ? orphans : [];
      const out = { action, dryRun, willRemove: items.length, items,
        note: items.length === 0 && dryRun
          ? "PREVIEW ONLY — nothing to do: this action would remove nothing."
          : (dryRun ? "PREVIEW ONLY — nothing was deleted."
                    : "deleted in ONE undo group (Ctrl+Z)") };
      if (!dryRun) {
        out.removedCount = items.length;
        out.itemsRemoved = items.length;
        out.removed = items;
      }
      return out;
    }
    case "organize_project": {
      // Modelled to PREVIEW, because a canned host that answered "ok"
      // would let the preview steps pass while the real tool rearranged
      // the user's project panel. It also models the rule the shipped
      // tool got wrong until 2026-08-28: a destination folder is looked
      // for at the ROOT, and a same-named folder nested somewhere else
      // is reported, never filed into.
      const DESTS = ["Comps", "Solids", "Audio", "Images", "Footage"];
      const dryRun = !(args && args.dryRun === false);
      const looseComps = createdComps.filter(
        (nm) => !(compProps[nm] && compProps[nm].folder));
      const looseFootage = solidSources.filter((so) => !so.folder);
      const moves = looseComps.map((nm) => nm + " -> Comps")
        .concat(looseFootage.map((so) => so.name + " -> Solids"));
      const byFolder = {};
      if (looseComps.length) byFolder.Comps = looseComps.length;
      if (looseFootage.length) byFolder.Solids = looseFootage.length;
      const toCreate = DESTS.filter(
        (d2) => byFolder[d2] && !folders[d2]);
      const elsewhere = Object.keys(folders).filter(
        (p2) => p2.indexOf("/") !== -1 &&
                byFolder[p2.slice(p2.lastIndexOf("/") + 1)]);
      const out = { dryRun, willMove: moves.length, byFolder,
                    alreadyFiled: createdComps.length - looseComps.length,
                    rootFolders: Object.keys(folders)
                      .filter((p2) => p2.indexOf("/") === -1).length };
      const CAP = 40;
      out.moves = moves.slice(0, CAP);
      if (moves.length > CAP) out.movesNotShown = moves.length - CAP;
      if (toCreate.length) {
        out.foldersToCreate = toCreate;
        out.foldersNote = "These folders do not exist at the project root " +
          "yet and would be created there.";
      }
      if (elsewhere.length) {
        out.sameNameElsewhere = elsewhere;
        out.sameNameNote = "A folder with that name already exists deeper " +
          "in the project. It is NOT used, so the project would end up " +
          "with two folders of that name.";
      }
      // The preview GATE (0.11.8). A canned host that ACCEPTED an
      // ungated dryRun:false would let the suite's refusal step pass
      // while the real tool filed the user's whole project panel --
      // the same faithfulness rule clean_project's refusals follow.
      const orgKey = moves.slice(0).sort().join(",");
      if (dryRun) {
        orgShownKey = orgKey;
        out.note = moves.length === 0
          ? "PREVIEW ONLY — nothing to do: no loose items at the " +
            "project root."
          : "PREVIEW ONLY — nothing was moved.";
        return out;                              // and it moves NOTHING
      }
      if (moves.length && orgShownKey !== orgKey) {
        const why = orgShownKey === null
          ? "nothing has been previewed yet"
          : "the project has changed since the last preview, so this is " +
            "not the list the user agreed to";
        orgShownKey = orgKey;
        return { __err: "organize_project refused to move: " + why +
          ". Nothing was moved. " + moves.length + " item(s) would be " +
          "filed — " + moves.slice(0, 10).join(", ") +
          (moves.length > 10 ? ", +" + (moves.length - 10) + " more" : "") +
          (toCreate.length ? ". It would also create these folders at " +
            "the project root: " + toCreate.join(", ") : "") +
          ". That IS the preview — show it to the user, and call " +
          "organize_project with dryRun:false in your NEXT reply, after " +
          "they say go." };
      }
      for (const nm of looseComps) {
        (compProps[nm] || (compProps[nm] = {})).folder = "Comps";
      }
      for (const so of looseFootage) so.folder = "Solids";
      for (const d2 of toCreate) {
        const fid = ++nextFolderId;
        folders[d2] = fid; folderIds[fid] = d2;
      }
      out.moved = moves.length;
      out.foldersCreated = toCreate;
      out.note = moves.length + " item(s) filed in ONE undo group (Ctrl+Z).";
      return out;
    }
    case "get_project_info": {
      // A scratch project the size of the real one: a few comps drowning
      // in accumulated solid footage. Comps come first out of the cap.
      // Reads the LIVE solidSources list, so a delete_item really removes
      // an item from later listings — the fidelity the cleanup steps
      // depend on.
      const items = createdComps.map((nm, i) => Object.assign(
        { name: nm, id: i + 1, type: "comp" }, compProps[nm] || {}));
      // Folders are items too, and they are what organize_project's
      // preview steps count: a listing without them would let a preview
      // that quietly created "Comps" at the root pass unnoticed.
      for (const p2 of Object.keys(folders)) {
        const cut = p2.lastIndexOf("/");
        const entry = { name: cut === -1 ? p2 : p2.slice(cut + 1),
                        id: folders[p2], type: "folder", path: p2 };
        if (cut !== -1) entry.folder = p2.slice(0, cut).split("/").pop();
        items.push(entry);
      }
      for (const so of solidSources) items.push(Object.assign({}, so));
      const limit = listLimit(args && args.limit);
      const total = items.length;
      let shown = items;
      if (limit >= 0 && total > limit) shown = items.slice(0, limit);
      const out = { numItems: total, itemsShown: shown.length,
                    items: shown,
                    activeComp: createdComps[createdComps.length - 1] || null };
      if (shown.length < total) {
        out.note = "Showing " + shown.length + " of " + total +
          " items (comps and folders first). " + (total - shown.length) +
          " footage items not listed — ask again with limit:0.";
      }
      return out;
    }
    case "distribute_property": {
      const L = (args && args.layers) || [];
      const from = (args && typeof args.from === "number") ? args.from : 0;
      const step = (args && typeof args.step === "number") ? args.step : 0;
      const applied = [], overridden = [], cleared = [];
      L.forEach((nm, i) => {
        // A layer whose property is driven does not move, however happily
        // AE accepted the write -- so it cannot be reported as applied.
        // Unless the caller passed clearExpressions: then exactly the
        // swallowing rig is removed and the value lands (the real host
        // writes first and clears only when the write was eaten).
        if (drivenShows(nm, args && args.property) !== null) {
          if (args && args.clearExpressions === true) {
            delete driven[drivenKey(nm, args && args.property)];
            cleared.push(nm);
          } else {
            overridden.push(nm);
            return;
          }
        }
        applied.push({ layer: nm, value: from + i * step });
      });
      for (const a of applied) ordX[a.layer] = a.value;
      const out = { property: args && args.property, layers: L.length,
                    applied };
      const notes = [];
      if (overridden.length) {
        out.overriddenByExpression = overridden;
        notes.push(overridden.length + " of " + L.length + " layer(s) did " +
          "NOT move because an expression drives " +
          (args && args.property) + " on them: clear it first " +
          "(set_expression with expression: \"\"). If the user explicitly " +
          "asked for these values, re-call with clearExpressions: true " +
          "to remove those expressions and apply them");
      }
      if (cleared.length) {
        out.expressionsCleared = cleared;
        notes.push("clearExpressions removed the expression driving " +
          (args && args.property) + " on " + cleared.length +
          " layer(s) so the values could land — tell the user their rig " +
          "on those layers is gone");
      }
      if (notes.length) out.note = notes.join(". ");
      return out;
    }
    case "reorder_layers": {
      // RELATIVE mode: one layer moved next to one anchor in the order
      // rig's stack. Faithful to the host's index rule (moveBefore = one
      // slot above the anchor, moveAfter = one below), to the refusals
      // it makes by name, and to the no-op it reports honestly.
      const relKeys = ["above", "below", "toFront", "toBack"]
        .filter(k => args && args[k] !== undefined && args[k] !== null &&
                     args[k] !== "" && args[k] !== false);
      if (relKeys.length) {
        if (relKeys.length > 1) {
          return { __err: "reorder_layers takes ONE relative key, got " +
            relKeys.join(" + ") + ". Pick one." };
        }
        if (args.by) {
          return { __err: "'" + relKeys[0] + "' moves ONE layer relative " +
            "to another; 'by: " + args.by + "' SORTS a whole list. They " +
            "cannot be combined — drop 'by' to move the layer." };
        }
        const key = relKeys[0];
        if ((key === "above" || key === "below")
              ? (typeof args[key] !== "string" && typeof args[key] !== "number")
              : args[key] !== true) {
          return { __err: (key === "toFront" || key === "toBack")
            ? "'" + key + "' takes true, got '" + args[key] + "' — did " +
              "you mean {" + (key === "toFront" ? "above" : "below") +
              ": '" + args[key] + "'}?"
            : "'" + key + "' names a layer to sit next to — pass {" + key +
              ": 'X'}." };
        }
        const who = String(args.layer);
        const from = ordStack.indexOf(who);
        const notFound = (nm) => ({ __err: "Layer not found in '" +
          args.comp + "': " + nm + ". Actual layers: " +
          ordStack.join(", ") + ". For the user's selection, OMIT the " +
          "'layer' argument on tools that support it." });
        if (from < 0) return notFound(who);
        let anchor = null;
        if (key === "above" || key === "below") {
          anchor = String(args[key]);
          if (ordStack.indexOf(anchor) < 0) return notFound(anchor);
          if (anchor === who) {
            return { __err: "'" + who + "' cannot be moved " + key +
              " itself — name a DIFFERENT layer to sit " + key +
              ". Layers in '" + args.comp + "': " + ordStack.join(", ") };
          }
        }
        ordStack.splice(from, 1);
        const at = key === "toFront" ? 0
          : key === "toBack" ? ordStack.length
          : ordStack.indexOf(anchor) + (key === "below" ? 1 : 0);
        ordStack.splice(at, 0, who);
        const out = { layer: who, movedTo: at + 1, previousIndex: from + 1 };
        out[key] = anchor || true;
        out.note = out.movedTo === out.previousIndex
          ? "Nothing moved — '" + who + "' was already there"
          : "Only '" + who + "' moved; every other layer kept its order";
        return out;
      }
      const L = ((args && args.layers) || []).slice();
      if (args && args.by === "name") {
        // Faithful to the fix: the trailing number sorts as a NUMBER, so
        // "ST Ord 2" comes before "ST Ord 10". A stub that string-sorted
        // here would let a string-sorting host pass.
        L.sort((a, b) => {
          const na = parseInt((/(\d+)\s*$/.exec(a) || [0, "1"])[1], 10);
          const nb = parseInt((/(\d+)\s*$/.exec(b) || [0, "1"])[1], 10);
          return na - nb;
        });
      }
      if (!(args && /^desc/i.test(args.order || ""))) L.reverse();
      ordStack = L;
      return { layers: L.length, by: (args && args.by) || "startTime",
               order: (args && /^desc/i.test(args.order || ""))
                 ? "descending" : "ascending",
               topToBottom: L.join(" | "), slots: "1.." + L.length,
               note: "Stacking changed only" };
    }
    case "get_comp_details": {
      // The mask rig, where a layer row has to carry the LAYER's size.
      // Only when it differs from the comp's: absent means "the comp's",
      // which is in the same result, so a full-frame comp pays nothing.
      if (args && /Self-Test Mask$/.test(String(args.comp || ""))) {
        const mkP = compProps[args.comp] || {};
        const mkRows = Object.keys(mkSizes)
          .filter((k) => k.indexOf(args.comp + "|") === 0)
          .map((k, i) => {
            const sz = mkSizes[k];
            const row = { index: i + 1,
                          name: k.slice(args.comp.length + 1), effects: [] };
            if (sz.width !== mkP.width || sz.height !== mkP.height) {
              row.width = sz.width;
              row.height = sz.height;
            }
            return row;
          });
        const mkOut = capLayers(args.comp, mkRows, args);
        mkOut.width = mkP.width;
        mkOut.height = mkP.height;
        return mkOut;
      }
      // The preset rig lives in the MAIN scratch comp, and its two split
      // pieces are SELECTED — the state applyPreset misreads in real AE.
      // It answers before the other rigs so the selection is never lost.
      if (preLayers.length && args && /Self-Test$/.test(args.comp || "")) {
        const preRows = ordStack.map((nm, i) => ({ index: i + 1, name: nm }));
        preLayers.forEach((nm) => {
          preRows.push({ index: preRows.length + 1, name: nm,
                         selected: preSelection.indexOf(nm) !== -1 });
        });
        return capLayers(args.comp, preRows, args);
      }
      // A precomp answers with what precompose moved into it, and with
      // the size that call really produced (moveAttributes:false takes
      // the LAYER's size, not the comp's).
      if (args && (pcNested[args.comp] || pcAlias[args.comp])) {
        const want = pcAlias[args.comp] || args.comp;
        const d = capLayers(want, pcNested[want].map((nm, i) => ({
          index: i + 1, name: nm, effects: [] })), args);
        const p = compProps[want] || {};
        d.width = p.width; d.height = p.height;
        return d;
      }
      if (args && /Self-Test Light/.test(args.comp || "")) {
        // Filtered by comp: the camera comp holds lights too, and
        // counting those here made a refusal step look like a leak.
        const mine = Object.keys(lights)
          .filter((nm) => lights[nm].comp === args.comp);
        return capLayers(args.comp, mine.map((nm, i) => ({
          index: i + 1, name: nm, type: "light", effects: [] })), args);
      }
      if (inCapText(args)) {
        return capLayers(args.comp, capRows.map((r, i) => ({
          index: i + 1, name: r.name, inPoint: r.inPoint,
          outPoint: r.outPoint, effects: [] })), args);
      }
      if (args && /Self-Test Frame/.test(args.comp || "")) {
        return capLayers(args.comp, (frLayers[args.comp] || []).map(
          (nm, i) => ({ index: i + 1, name: nm, effects: [] })), args);
      }
      if (args && /Solid Room/.test(args.comp || "")) {
        return capLayers(args.comp,
          scShared.concat(scText).map((nm, i) => ({
            index: i + 1, name: nm, effects: [] })), args);
      }
      if (inRbComp(args)) {
        return capLayers(args.comp, rbLayers.map((nm, i) => ({
          index: i + 1, name: nm, effects: [] })), args);
      }
      if (inBatComp(args)) {
        return capLayers(args.comp, batSolids.map((nm, i) => ({
          index: i + 1, name: nm,
          effects: batSolidFx[nm] ? [batSolidFx[nm]] : [] })), args);
      }
      if (args && /Batch/.test(args.comp || "")) {
        const ls = [];
        for (let i = 1; i <= batchLayers; i++) {
          const nm = i === 1 ? "ST Batch" : "ST Batch " + i;
          ls.push({ index: i, name: nm,
                    effects: batchFx[nm] ? [batchFx[nm]] : [] });
        }
        return capLayers(args.comp, ls, args);
      }
      if (args && /Self-Test$/.test(args.comp || "") &&
          typeof stagStart[SQUARES[0]] === "number") {
        return capLayers(args.comp, SQUARES.map((nm, i) => ({
          index: i + 1, name: nm, startTime: stagStart[nm] })), args);
      }
      return capLayers(args && args.comp,
        ordStack.map((nm, i) => ({ index: i + 1, name: nm })), args);
    }
    // set_solid_color's whole point is the SHARED source, so the canned
    // host tracks who shares what rather than answering yes to anything.
    case "set_solid_color": {
      const named = (args && args.layers) ||
                    (args && args.layer ? [args.layer] : []);
      if (!args || !args.color) {
        return { __err: "'color' is required: [r, g, b] floats 0..1" };
      }
      const bad = named.filter(n => scText.indexOf(n) !== -1);
      if (bad.length) {
        return { __err: "set_solid_color only works on SOLID layers. Not " +
          "solids: " + bad.join(", ") + ". A shape layer's colour is in " +
          "its contents (use set_property), and a text layer's is " +
          "fillColor (use set_text_style)." };
      }
      const sharers = scShared.filter(n => scUnique.indexOf(n) === -1);
      const collateral = named.some(n => sharers.indexOf(n) !== -1)
        ? sharers.filter(n => named.indexOf(n) === -1) : [];
      if (collateral.length && typeof args.makeUnique === "undefined") {
        return { __err: "That solid is SHARED. Recolouring it would also " +
          "change " + collateral.length + " layer(s) nobody asked about: " +
          collateral.join(", ") + ". Say which you want: makeUnique:true " +
          "gives the layer(s) you named their OWN solid, makeUnique:false " +
          "recolours all of them on purpose." };
      }
      if (args.makeUnique === true) {
        named.forEach(n => { if (scUnique.indexOf(n) === -1) scUnique.push(n); });
        return { comp: args.comp, layers: named, color: args.color,
                 solidsTouched: named.length,
                 madeUnique: named.map(n => n + " -> " + n + " solid"),
                 note: "Each layer got its OWN solid, so nothing else " +
                       "changed. That adds " + named.length +
                       " item(s) to the project panel." };
      }
      const out = { comp: args.comp, layers: named, color: args.color,
                    solidsTouched: 1,
                    note: "Nothing else uses that solid." };
      if (collateral.length) out.alsoChanged = collateral;
      return out;
    }
    case "precompose": {
      // The precompose rig (WORKPLAN 5.4). Faithful to the four things
      // real AE does quietly, because the suite steps exist to prove the
      // tool reports every one of them — a canned host that just said
      // "ok" would let a silent precompose pass.
      const asked = (args && args.layers) || [];
      const move = !(args && args.moveAttributes === false);
      const uniq = [];
      const dupes = [];
      asked.forEach((L) => {
        if (uniq.indexOf(L) === -1) uniq.push(L);
        else if (dupes.indexOf(L) === -1) dupes.push(L);
      });
      if (!move && uniq.length > 1) {
        return { __err: "moveAttributes:false only works on ONE layer — " +
          "AE refuses it for " + uniq.length + " (" + uniq.join(", ") +
          "). Leaving attributes behind means the new comp takes that " +
          "single layer's own size, which is undefined for several. Drop " +
          "moveAttributes to move them all in together." };
      }
      // AE never uniquifies; the tool does, the way create_comp does.
      let nm = (args && args.name) || "Pre-comp 1";
      let renamed = false;
      if (createdComps.indexOf(nm) !== -1) {
        let k = 2;
        while (createdComps.indexOf(nm + " " + k) !== -1) k++;
        nm = nm + " " + k;
        renamed = true;
      }
      createdComps.push(nm);
      if (renamed) pcAlias[String(args.name)] = nm;
      else delete pcAlias[String(args && args.name)];
      pcNested[nm] = uniq.slice(0);
      compProps[nm] = move
        ? { width: 640, height: 480, duration: 10, frameRate: 24 }
        : { width: 100, height: 100, duration: 10, frameRate: 24 };
      // The selection: AE selects the new layer, the tool puts back
      // whatever the user had that SURVIVED.
      const kept = pcSelection.filter(n => uniq.indexOf(n) === -1);
      const out = { precomp: nm, id: 900 + createdComps.length,
                    layersMoved: uniq.length,
                    layers: uniq.join(", "),
                    selectionKept: kept.length ? kept.join(", ")
                      : "(none survived — AE's new '" + nm +
                        "' layer is selected)" };
      pcSelection = kept.length ? kept : [nm];
      if (dupes.length) {
        out.duplicatesIgnored = dupes.join(", ") +
          " — named more than once; each layer moves once.";
      }
      const lost = uniq.filter(n => pcParent[n] && uniq.indexOf(pcParent[n]) === -1);
      if (lost.length) {
        out.parentsBroken = lost.map(n => n + " (was parented to " +
          pcParent[n] + ")").join("; ") + ". AE drops a parent that " +
          "stayed behind; re-parent inside '" + nm + "' or precompose " +
          "the parent too.";
      }
      if (move) {
        const risky = Object.keys(pcExpr)
          .filter(n => uniq.indexOf(n) === -1 &&
                       uniq.some(m => pcExpr[n].indexOf('"' + m + '"') !== -1));
        if (risky.length) {
          out.expressionsAtRisk = risky.map(n => n + " > Opacity names '" +
            uniq.filter(m => pcExpr[n].indexOf('"' + m + '"') !== -1)[0] +
            "'").join("; ") + ". Those layers are no longer in '" +
            (args && args.comp) + "' and AE does NOT report the broken " +
            "reference.";
        }
      }
      if (!move) {
        out.note = "moveAttributes:false — '" + nm + "' is the SIZE OF " +
          "THE LAYER (100x100), not of '" + (args && args.comp) +
          "', and the transform stayed outside.";
      } else if (renamed) {
        out.note = "An item named '" + (args && args.name) +
          "' already existed — this precomp is '" + nm +
          "'. Use THIS name in every following command.";
      }
      return out;
    }
    case "add_marker": {
      const t = typeof args.time === "number" ? args.time
        : (typeof args.time === "string" && args.time !== "" &&
           !isNaN(Number(args.time))) ? Number(args.time) : null;
      if (t === null) {
        return { __err: "'time' (seconds, composition time) is required" +
          (typeof args.time === "undefined" ? "" : " — got " + args.time) };
      }
      let dur = 0;
      if (args.duration !== null && typeof args.duration !== "undefined" &&
          args.duration !== "") {
        dur = (typeof args.duration === "number") ? args.duration
          : (typeof args.duration === "string" && !isNaN(Number(args.duration)))
            ? Number(args.duration) : null;
        if (dur === null || dur < 0) {
          return { __err: "'duration' must be a number of seconds >= 0 — " +
            "got " + args.duration + ". Omit it for a plain marker." };
        }
      }
      const key = (args.comp || "") + "|" + (args.layer || "(comp)");
      const list = markers[key] || (markers[key] = []);
      const at = list.filter(m => m.time === t)[0];
      const out = { marker: args.layer ? "layer " + args.layer
                                       : "comp " + args.comp,
                    time: t, comment: args.comment || "", duration: dur };
      if (at) {
        out.replaced = "A marker already at " + t + "s was overwritten: " +
          (at.comment ? "'" + at.comment + "'" : "(no comment)") +
          (at.duration > 0 ? ", duration " + at.duration + "s" : "") +
          ". AE keeps one marker per exact time.";
        at.comment = args.comment || "";
        at.duration = dur;
      } else {
        list.push({ time: t, comment: args.comment || "", duration: dur });
        list.sort((a, b) => a.time - b.time);
      }
      out.markers = list.length;
      const cd = compProps[args.comp] || { duration: 10 };
      if (t < 0 || t > cd.duration) {
        out.note = "Outside '" + args.comp + "' (0 to " + cd.duration +
          "s) — the marker exists but is off the visible timeline.";
      } else if (args.layer && pcTiming[args.layer] &&
                 (t < pcTiming[args.layer].inPoint ||
                  t > pcTiming[args.layer].outPoint)) {
        out.note = "Outside " + args.layer + "'s own span (" +
          pcTiming[args.layer].inPoint + " to " +
          pcTiming[args.layer].outPoint + "s) — the marker rides the " +
          "layer and is not visible where the layer is not.";
      }
      return out;
    }
    // The comp-rename rig: one plain comp, one nested (a utility), one
    // named by an expression. The canned host has to remember the rename
    // it performed, or the idempotency step would be asking nothing.
    case "audit_comp_usage": {
      const plainNow = rnRenamedTo || RN.plain;
      const mk = (name, over) => Object.assign(
        { name, id: 0, numLayers: 0, usedIn: [], usedInCount: 0,
          inRenderQueue: false, expressionRefs: [], expressionRefCount: 0,
          looksLikeUtility: false }, over || {});
      const comps = [
        mk(RN.host, { numLayers: 2 }),
        mk(RN.util, { usedIn: [RN.host], usedInCount: 1,
                      looksLikeUtility: true }),
        mk(RN.linked, { expressionRefCount: 1, expressionRefs: [{
          kind: "comp()", inComp: RN.host, layer: "ST RN Expr",
          property: "Opacity",
          excerpt: 'comp("' + RN.linked + '").duration * 0 + 100' }] }),
        mk(plainNow)
      ];
      return { comps, compsFound: comps.length,
               scanned: { expressionsFound: 1, scanMs: 1 } };
    }
    case "rename_comps": {
      const dry = !(args && args.dryRun === false);
      const plainNow = rnRenamedTo || RN.plain;
      const already = /^REV\d\d_/.test(plainNow);
      const plan = [
        { comp: plainNow,
          newName: already ? null : "REV19_" + plainNow,
          action: already ? "skip" : "rename",
          reason: already ? "Already carries the prefix — nothing to do"
                          : "Not referenced by any expression" },
        { comp: RN.util, newName: null, action: "skip",
          reason: "Looks like a utility comp — it is nested in " + RN.host +
            " and is not in the render queue. Skipped by default; pass " +
            "includeUtility:true to rename it anyway." },
        { comp: RN.linked, newName: null, action: "skip",
          reason: "An expression names this comp as a string (comp()). " +
            "AE does NOT rewrite those on rename." }
      ];
      const willRename = plan.filter(p => p.action === "rename").length;
      const out = { dryRun: dry, rule: (args && args.rule) || "rev-prefix",
        plan, compsConsidered: plan.length, willRename,
        skipped: plan.length - willRename };
      if (dry) { out.note = "PREVIEW ONLY — nothing was renamed."; return out; }
      const renamed = [];
      if (willRename) {
        renamed.push(plainNow + " -> REV19_" + plainNow);
        rnRenamedTo = "REV19_" + plainNow;
        // The rename is visible to every later listing and delete — the
        // project item itself changed name, exactly as in AE.
        const at = createdComps.indexOf(plainNow);
        if (at !== -1) createdComps[at] = rnRenamedTo;
      }
      out.renamed = renamed;
      out.renamedCount = renamed.length;
      return out;
    }
    case "grid_layout":
      // The rig it builds DRIVES Position and ignores whatever value sits
      // underneath — every later write to those layers is swallowed.
      (((args && args.layers) || SQUARES)).forEach((nm, i) =>
        markDriven(nm, "position", [320 + (i % 3) * 320, 180, 0]));
      return { sliders: ["Grid X Spacing", "Grid Y Spacing",
                         "Grid Columns"] };
    case "link_property": {
      // Same shape: the linked property now reads from the slider.
      markDriven(args && args.layer, args && args.property, 22.2);
      const out = { layer: args && args.layer,
                    property: args && args.property };
      // The real tool WRITES the expression and reports it — a canned
      // host that omitted it let a step assert on a field that is
      // always there in AE and never here.
      const cl = args && args.controlLayer, ce = args && args.controlEffect;
      if (cl && ce) {
        const sc = args && typeof args.scale === "number" ? args.scale : 1;
        out.linkedTo = cl + " > " + ce;
        out.expression = 'thisComp.layer("' + cl + '").effect("' + ce +
                         '")(1)' + (sc !== 1 ? " * " + sc : "") + ";";
      }
      return out;
    }
    case "get_property": {
      // What import_as_layer wrote, read back the way the suite reads it:
      // the report is not evidence, the property is.
      const frS = frScales[((args && args.comp) || "") + "|" +
                           ((args && args.layer) || "")];
      if (frS && /^scale$/i.test(String((args && args.property) || ""))) {
        return { property: "Scale", matchName: "ADBE Scale", value: frS,
                 numKeys: 0 };
      }
      if (inWpComp(args)) {
        return { layer: args.layer, property: args.property,
                 numKeys: wpCount(String(args.layer),
                                  String(args.property || "")),
                 value: 100 };
      }
      const SLg = shapeLayerOf(args && args.layer);
      if (SLg && /^contents\//i.test(String((args && args.property) || ""))) {
        const hit = shapeResolve(SLg, args.layer, args.property);
        if (hit && hit.__err) return hit;
        if (hit) {
          const keys = hit.item.keys && hit.item.keys[hit.key];
          return { layer: args.layer, property: args.property,
                   value: hit.item.vals[hit.key],
                   numKeys: keys ? keys.length : 0 };
        }
      }
      if (inTx(args)) {
        const tx = txReadProp(args && args.property);
        if (tx) return tx;
      }
      // Markers read back through get_property as a key list — the only
      // route the panel has to them, and how the suite proves a layer
      // marker sits at the COMP time it was given.
      if (args && /^marker$/i.test(String(args.property || ""))) {
        const ms = markers[(args.comp || "") + "|" +
                           (args.layer || "(comp)")] || [];
        return { property: "Marker", matchName: "ADBE Marker",
                 value: "[object]", numKeys: ms.length,
                 keys: ms.map(m => ({ time: m.time, value: "[object]" })) };
      }
      // A keyframed property answers with its key list and the value at
      // the comp's current time (0) — the shape real AE returns, and what
      // the light-animation and remove_keyframes steps read back. This
      // comes FIRST so that keyframing a light option really does change
      // what a read of it says.
      const kk = args ? cvKeys[args.layer + "/" + cvProp(args.property)]
                      : null;
      if (kk && kk.length) {
        return { value: kk[0].value, numKeys: kk.length,
                 keys: kk.map(k => ({ time: k.time, value: k.value })) };
      }
      if (inCvComp(args)) {
        const P = String(args.property || "");
        // Two effects of the same class carry the same param name at the
        // same depth under the same root: nothing separates them, so the
        // search must refuse rather than pick.
        const tie = cvAmbiguous(args.layer, P);
        if (tie) return { __err: tie };
        // With ONE blur left (remove_effect took the other) the bare
        // name resolves through the deep search to that one's path.
        if (/^blurriness$/i.test(P)) {
          const blurs = (cvFx[args.layer] || [])
            .filter(n => /^Gaussian Blur/.test(n));
          if (blurs.length === 1) {
            return { value: 25, matchName: "ADBE Gaussian Blur 2-0001",
                     resolvedPath: "Effects/" + blurs[0] + "/Blurriness" };
          }
        }
        // A full path still reads the one it names.
        // Measured in AE 2026: a freshly applied Gaussian Blur comes up
        // at Blurriness 25, not 0.
        const full = /^effects\/(Gaussian Blur 2?)\/Blurriness$/i.exec(P);
        if (full) return { value: 25, matchName: "ADBE Gaussian Blur 2-0001" };
        // Transform beats the eleven latent Layer Styles: AE ships them
        // all on every layer, so "Opacity" would otherwise have ten
        // shallower answers than the one the user means.
        if (P === "Opacity") {
          return { value: 100, matchName: "ADBE Opacity", numKeys: 0 };
        }
        const ctl = cvControls[args.layer + "/" +
                               P.replace(/^effects\//i, "")];
        if (ctl) {
          // "effects/<name>" lands on the control GROUP and descends to
          // its single value property, so the matchName is the value's.
          const out = { value: ctl.value, matchName: ctl.match + "-0001",
                        numKeys: 0 };
          // Reached by its BARE name, the search says where it landed --
          // that is how the model learns the path for next time. Through
          // "effects/<name>" it says nothing: no hunt happened.
          if (!/^effects\//i.test(P)) {
            out.resolvedPath = "Effects/" + P + "/" + ctl.leaf;
          }
          return out;
        }
        // A path whose HEAD the layer cannot see either: "<control>/<leaf>".
        const seg = P.split("/");
        const head = seg.length === 2 ? cvControls[args.layer + "/" + seg[0]]
                                      : null;
        if (head && seg[1].toLowerCase() === head.leaf.toLowerCase()) {
          return { value: head.value, matchName: head.match + "-0001",
                   numKeys: 0,
                   resolvedPath: "Effects/" + seg[0] + "/" + head.leaf };
        }
        const np = cvProp(P);
        if (np === "anchorpoint") {
          return { value: (cvAnchor[args.layer] || [0, 0, 0]).slice(),
                   numKeys: 0 };
        }
        // The rotation-name asymmetry, measured in AE 2026: a 3D layer
        // answers to BOTH "Rotation" and "Z Rotation", a 2D layer only to
        // "Rotation". So the refusal only ever happens one way round.
        if (/^transform\/z rotation$/i.test(P) && !cvThreeD[args.layer]) {
          return { __err: "Path segment 'Z Rotation' not found under " +
            "'transform'. Children here: " +
            CV_TRANSFORM.map(([n, mn]) => cvName(n, mn, args.layer))
              .join(", ") +
            ". Use list_properties to inspect the real tree." };
        }
        if (np === "rotation" || np === "zrotation") {
          // Both names, and the friendly alias, are one property. Its
          // VALUE is 0 unless remove_keyframes un-animated it, in which
          // case AE left the last key's value sitting there and a read
          // has to say so -- a constant here let a step read back a
          // number nothing in the suite had produced.
          const rr = cvResidual[args.layer + "/rotation"];
          return { value: typeof rr === "undefined" ? 0 : rr,
                   matchName: "ADBE Rotate Z", numKeys: 0 };
        }
        if (np === "position") {
          // A driven Position reads back EVALUATED: a live wiggle is
          // off-centre, and a comp centre of [320, 240] is what an
          // expression AE had disabled would leave behind.
          const ex = cvExpr[args.layer + "/" + np];
          return ex ? { value: [324.77, 240.28, 0], expression: ex,
                        numKeys: 0 }
                    : { value: [320, 240, 0], numKeys: 0 };
        }
        return { value: 0, numKeys: 0 };
      }
      // Lights answer from what add_light actually applied, so a read
      // can never confirm a write the canned host never made.
      if (args && lights[args.layer]) {
        const la = lights[args.layer];
        const P = args.property;
        const pad3 = (v) => [v[0], v[1], v.length > 2 ? v[2] : 0];
        const deep = LIGHT_DEEP_ONLY[P];
        if (deep) {
          return { value: la[deep[0]], matchName: deep[1],
                   numKeys: 0, resolvedPath: LIGHT_DEEP_PATH[deep[0]] };
        }
        if (P === "Blurriness" || P === "Diffusion") {
          // The grounded error survives the search and grows a line
          // saying the whole tree was walked too -- plus, for a near
          // miss, the real names that contain what was asked for.
          let err = "Path segment '" + P + "' not found under layer '" +
            args.layer + "'. Children here: Marker, Transform, " +
            "Light Options. Use list_properties to inspect the real " +
            "tree. No property named '" + P + "' exists anywhere on '" +
            args.layer + "' either (searched the whole tree to depth 5).";
          if (P === "Diffusion") {
            err += " Names containing it: Light Options/Shadow Diffusion.";
          }
          return { __err: err };
        }
        if (P === "Cone Angle") return { value: la.coneAngle };
        if (P === "Intensity") return { value: la.intensity };
        if (P === "light/Radius") return { value: la.radius };
        if (P === "light/Falloff Distance") {
          return { value: la.falloffDistance };
        }
        if (P === "light/Shadow Diffusion") {
          return { value: la.shadowDiffusion };
        }
        if (P === "light/Cone Angle") return { value: la.coneAngle };
        if (P === "Casts Shadows") {
          return { value: la.castsShadows ? 1 : 0 };
        }
        if (P === "Point of Interest") {
          return { value: pad3(la.pointOfInterest || [0, 0]) };
        }
        if (P === "Position") return { value: pad3(la.position || [0, 0]) };
        return { __err: "Path segment '" + P + "' not found under " +
          "layer '" + args.layer + "'" };
      }
      if (inRbComp(args) && rbLayers.indexOf(args.layer) === -1) {
        return { __err: "No layer '" + args.layer + "' in '" + args.comp +
          "' -- it holds: " + (rbLayers.join(", ") || "nothing") };
      }
      // The batch rig reads back the write that came AFTER a failing
      // command. Padded to three components, the way real AE answers.
      if (inBatComp(args) && batSolidPos[args.layer]) {
        const bp = batSolidPos[args.layer];
        return { value: [bp[0], bp[1], 0] };
      }
      // Position on a 2D layer: the scripting API pads the value to 3
      // components ([x, y, 0]) even though the expression engine sees
      // 2 — model that faithfully, and give the two grid squares
      // different cells so the "distinct cells" step is real.
      if (args && /^ST Ord/.test((args && args.layer) || "")) {
        return { value: [ordX[args.layer], 300, 0] };
      }
      // Read back what for_each_layer wrote through set_effect_param.
      if (args && /Blurriness/.test(args.property || "")) {
        return { value: batchBlur };
      }
      if (args && args.property === "Zoom") { return { value: 500 }; }
      if (args && args.property === "Point of Interest") {
        return args.layer === "ST Cam One"
          ? { value: [400, 300, 0] }    // no aim point; left alone
          : { value: [200, 150, 0] };   // re-centred with the comp
      }
      if (args && args.property === "Scale") {
        // Halved with the comp: [100,100] -> [50,50], [200,50] -> [100,25].
        return { keys: [{ time: 0, value: [50, 50, 100] },
                        { time: 2, value: [100, 25, 100] }] };
      }
      if (args && args.property === "Position") {
        // The mask probes read maskPath.points(t) BETWEEN two keys: 150
        // is halfway from 100 to 200, and 280 is frame 10 of keys that
        // sit on frames 8 and 18. Both are values a held or popped path
        // can never produce.
        if (args.layer === "ST Mask Probe") return { value: [150, 0, 0] };
        if (args.layer === "ST Off Probe") return { value: [280, 0, 0] };
        // The eased-motion probe reads the SAME point before and after
        // the resize, so a correct scale_comp halves it exactly.
        if (args.layer === "ST Cam Probe") {
          camProbeReads++;
          return camProbeReads === 1 ? { value: [520, 300, 0] }
                                     : { value: [260, 150, 0] };
        }
        if (args.layer === "ST Cam Ease") {
          return { keys: [{ time: 0, value: [50, 150, 0] },
                          { time: 2, value: [350, 150, 0] }] };
        }
        if (args.layer === "ST Cam Kid") return { value: [400, 300, -800] };
        // The anchor probes measure the SAME layer origin before and
        // after center_anchor_point, so a correct tool leaves these
        // readings identical — hence one fixed value per probe.
        if (args.layer === "ST AP Probe 0") return { value: [420.5, 311.25, 0] };
        if (args.layer === "ST AP Probe 2") return { value: [588.75, 402.5, 0] };
        return args.layer === "ST Square 2"
          ? { value: [640, 180, 0], expression: "// grid rig" }
          : { value: [320, 180, 0], expression: "// grid rig" };
      }
      return { value: 3 };
    }
    case "set_keyframes": {
      if (inWpComp(args)) {
        const wts = wpTargets(args), wn = (args.keys || []).length;
        for (const L of wts) wpKeys[L + "/" + cvProp(args.property)] = wn;
        return { layers: wts.length, property: args.property,
                 keysSet: wts.length * wn };
      }
      const SLk = shapeLayerOf(args && args.layer);
      if (SLk && /^contents\//i.test(String((args && args.property) || ""))) {
        const hit = shapeResolve(SLk, args.layer, args.property);
        if (hit && hit.__err) return hit;
        if (hit) {
          hit.item.keys = hit.item.keys || {};
          hit.item.keys[hit.key] = (args.keys || []).slice();
          return { layers: 1, property: args.property,
                   keysSet: (args.keys || []).length,
                   numKeys: (args.keys || []).length };
        }
      }
      if (inTx(args)) {
        const t = txParse(args && args.property);
        if (t && t.anim && t.kind === "Properties" &&
            !Object.prototype.hasOwnProperty.call(t.anim.props, t.rest)) {
          return { __err: "'" + args.property + "' is a text-animator " +
            "property that has not been added, so AE keeps it hidden and " +
            "keyframing it does nothing. add_text_animator adds and sets " +
            "one in a single call." };
        }
        if (t && t.anim && t.kind === "Selectors") {
          t.anim.sel.keys = args.keys.slice();
          return { layers: 1, property: args.property,
                   keysSet: args.keys.length, numKeys: args.keys.length };
        }
      }
      // 9 layers x 2 keys for the batch step; one layer x its own keys
      // for the single-layer ones.
      return { keysSet: (args && args.layer && args.keys)
        ? args.keys.length : 18 };
    }
    case "add_null":
      leakNullSource();
      return { index: 1, name: (args && args.name) || "Null 1" };
    case "set_expression": {
      const expr = (args && args.expression) || "";
      if (inCvComp(args) && args.layer) {
        const ck = args.layer + "/" + cvProp(args.property);
        if (expr === "") delete cvExpr[ck]; else cvExpr[ck] = expr;
      }
      if (expr === "") {
        delete driven[drivenKey(args && args.layer, args && args.property)];
        return { layer: args && args.layer, property: args && args.property,
                 expression: "cleared" };
      }
      // An expression that reads the property's own value passes writes
      // through; anything else computes the property from scratch and
      // swallows them.
      markDriven(args && args.layer, args && args.property,
                 /\bvalue\b/.test(expr) ? "passthru" : 999);
      if (inPcComp(args) && args.layer) pcExpr[args.layer] = expr;
      return { expressionEnabled: true, expression: expr };
    }
    case "center_anchor_point": {
      // On a shape layer built above, the anchor is the CENTRE OF THE
      // RENDERED BOUNDS -- the suite's only proof that a repeater made
      // more than one copy.
      const SL = shapeLayerOf(args && args.layer);
      const b = SL ? shapeBounds(SL) : null;
      if (b) {
        return { layer: args.layer, oldAnchor: [0, 0, 0],
                 newAnchor: [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, 0],
                 note: "anchor centered on content" };
      }
      return { layer: (args && args.layer) || "Anchor",
               oldAnchor: [0, 0, 0], newAnchor: [113.07, -35.33, 0],
               note: "anchor centered on content; all 2 Position " +
                     "keyframes offset so the layer did not move (NOTE: " +
                     "Scale/Rotation are animated too, so the offset is " +
                     "exact at the Position keyframes and approximate " +
                     "between them)" };
    }
    case "apply_keyframe_ease":
      // The camera-comp steps ease ONE pair; the batch step eases nine.
      return { easedPairs: (args && args.layer) ? 1 : 9 };
    case "stagger_layers": {
      // Two units that mean different things: 'spread' is the TOTAL span
      // of the stagger, 'step'/'stepFrames' the gap BETWEEN consecutive
      // layers. A stub that accepted both would answer the suite's
      // refusal step for free, and one that never reported the per-layer
      // gap would let a host go back to reporting a request as a result.
      const fd = 1 / 30;                 // the scratch comp runs at 30 fps
      const r3 = v => Math.round(v * 1000) / 1000;
      const hasStep = !!(args && typeof args.step === "number");
      const hasFrames = !!(args && typeof args.stepFrames === "number");
      const hasSpread = !!(args && args.spread > 0);
      if (hasStep && hasFrames) {
        return { __err: "Pass 'step' (seconds between consecutive layers) " +
          "or 'stepFrames' (frames between consecutive layers), not both" };
      }
      if ((hasStep || hasFrames) && hasSpread) {
        return { __err: "'spread' is the TOTAL span and 'step' is the gap " +
          "BETWEEN consecutive layers -- pass one, not both." };
      }
      const names = (args && args.layers) || SQUARES;
      const n = names.length;
      const base = (args && typeof args.startAt === "number")
        ? args.startAt : 0;
      const out = { layers: n, startAt: base };
      const gap = (hasStep || hasFrames)
        ? (hasFrames ? args.stepFrames * fd : args.step)
        : ((hasSpread ? args.spread : 2) / (n - 1));
      const placed = [];
      names.forEach((nm, i) => {
        stagStart[nm] = base + i * gap;
        placed.push({ layer: nm, startTime: r3(base + i * gap) });
      });
      out.placed = placed;
      out.spread = r3(gap * (n - 1));
      if (hasStep || hasFrames) {
        out.step = r3(gap);
        out.stepFrames = Math.round((gap / fd) * 100) / 100;
      } else {
        out.perLayer = r3(gap);
        out.perLayerFrames = Math.round((gap / fd) * 100) / 100;
        if (Math.abs(gap) < fd) {
          out.note = "'spread' is the TOTAL span, so " + n + " layers " +
            "across " + r3(out.spread) + "s land " + r3(gap / fd) +
            " frame(s) apart -- under one frame. If you meant " +
            r3(out.spread) + "s BETWEEN layers, pass step: " +
            r3(out.spread) + " instead of spread.";
        }
      }
      return out;
    }
    case "add_mask": {
      const mkKey = ((args && args.comp) || "") + "|" + ((args && args.layer) || "");
      // Faithful to the host's new refusal: a rectangle that does not
      // touch the layer at all hides ALL of it, and AE takes it silently
      // (measured — setting a comp-sized shape on a 100x100 solid threw
      // nothing). A canned host that accepted it would let that ship again.
      const mkSz = mkSizes[mkKey];
      const mkB = args && args.bounds;
      if (mkSz && Array.isArray(mkB) && mkB.length >= 4) {
        const bl = Math.min(mkB[0], mkB[0] + mkB[2]);
        const br = Math.max(mkB[0], mkB[0] + mkB[2]);
        const bt = Math.min(mkB[1], mkB[1] + mkB[3]);
        const bb = Math.max(mkB[1], mkB[1] + mkB[3]);
        if (bl <= 0 && bt <= 0 && br >= mkSz.width && bb >= mkSz.height &&
            (br - bl > mkSz.width || bb - bt > mkSz.height)) {
          return { __err: "That mask covers ALL of '" + args.layer + "', " +
            "so it hides nothing: the mask spans x " + bl + " to " + br +
            ", y " + bt + " to " + bb + " and the layer is only " +
            mkSz.width + "x" + mkSz.height + " at x 0 to " + mkSz.width +
            ", y 0 to " + mkSz.height + ". Mask coordinates are in LAYER " +
            "space, not comp space. To show only the top half of this " +
            "layer, mask bounds [0, 0, " + mkSz.width + ", " +
            (mkSz.height / 2) + "]." };
        }
        if (br <= 0 || bl >= mkSz.width || bb <= 0 || bt >= mkSz.height) {
          return { __err: "That mask misses '" + args.layer + "' completely, " +
            "so it would hide the whole layer: the mask spans x " + bl +
            " to " + br + ", y " + bt + " to " + bb + " and the layer is " +
            mkSz.width + "x" + mkSz.height + " at x 0 to " + mkSz.width +
            ", y 0 to " + mkSz.height + ". Mask coordinates are in LAYER " +
            "space, not comp space. The whole layer is bounds [0, 0, " +
            mkSz.width + ", " + mkSz.height + "]." };
        }
      }
      const held = mkMasks[mkKey] || (mkMasks[mkKey] = []);
      const mkName = (args && args.name) || ("Mask " + (held.length + 1));
      held.push(mkName);
      return { layer: args && args.layer, mask: mkName,
               shape: (args && args.shape) || "rectangle" };
    }
    case "delete_mask": {
      // Faithful to the host's three refusals and to AELL_findMask: one
      // mask needs no ref, a number is a 1-based index, a miss lists
      // what exists. A host that accepted a delete on an empty layer
      // again would fail its own step here.
      const dmKey = ((args && args.comp) || "") + "|" + ((args && args.layer) || "");
      const dm = mkMasks[dmKey] || [];
      if (dm.length === 0) {
        return { __err: "'" + args.layer + "' has no masks — nothing to " +
          "delete. add_mask creates one." };
      }
      const ref = args && args.mask;
      let at = -1;
      if (typeof ref === "number") at = Math.round(ref) - 1;
      else if (ref !== undefined && ref !== null && ref !== "") {
        at = dm.indexOf(String(ref));
      } else if (dm.length === 1) at = 0;
      if (at < 0 || at >= dm.length) {
        return { __err: "Mask not found on '" + args.layer + "'" +
          (ref ? ": " + ref : " (several masks — pass {mask: name|index})") +
          ". Masks here: " + dm.join(", ") };
      }
      const gone = dm.splice(at, 1)[0];
      return { layer: args.layer, removed: gone, remainingMasks: dm.slice() };
    }
    case "set_mask_path": {
      // Faithful to the host's rules, not to its happy path: keys that
      // disagree on point count and key times that collide on a frame
      // must be REFUSED here too, or a host that accepted them again
      // would sail through this suite.
      const fd = 1 / 25;            // the mask scratch comp runs at 25 fps
      const id = ((args && args.layer) || "") + "/" + ((args && args.mask) || "");
      const keys = (args && args.keys) || [];
      if (keys.length) {
        const counts = keys.map(k => (k.vertices || []).length);
        if (counts.some(c => c !== counts[0])) {
          const odd = counts.findIndex(c => c !== counts[0]);
          return { __err: "Mask path keys must all have the same number " +
            "of points: keys[" + odd + "] has " + counts[odd] + " but " +
            "keys[0] has " + counts[0] + ". After Effects cannot " +
            "interpolate between paths with different point counts, so " +
            "the mask would POP instead of animating, and AE raises a " +
            "modal warning that blocks the whole application. Give every " +
            "key " + counts[0] + " points (repeat a vertex to pad a " +
            "simpler shape)." };
        }
        const times = keys.map(k => Math.round(k.time / fd) * fd);
        const frames = times.map(t => Math.round(t / fd));
        for (let i = 0; i < frames.length; i++) {
          for (let j = i + 1; j < frames.length; j++) {
            if (frames[i] === frames[j]) {
              return { __err: "keys[" + i + "] (" + keys[i].time + "s) and " +
                "keys[" + j + "] (" + keys[j].time + "s) both land on the " +
                "same frame -- the later one would silently overwrite the " +
                "earlier. Put them on different frames." };
            }
          }
        }
        let snapped = 0;
        keys.forEach((k, i) => {
          if (Math.abs(times[i] - k.time) > 1e-9) snapped++;
        });
        maskKeys[id] = keys.length;
        const out = { keysSet: keys.length, numKeys: keys.length,
          points: counts[0], keyFrames: frames,
          keyTimes: times.map(t => Math.round(t * 10000) / 10000),
          note: "Mask path animated" };
        if (snapped) out.snappedToFrames = snapped;
        return out;
      }
      if (args && typeof args.atTime === "number") {
        maskKeys[id] = (maskKeys[id] || 0) + 1;
        const at = Math.round(args.atTime / fd) * fd;
        return { keyframed: true, numKeys: maskKeys[id],
                 time: Math.round(at * 10000) / 10000,
                 frame: Math.round(at / fd),
                 points: ((args && args.vertices) || []).length };
      }
      if (maskKeys[id]) {
        return { __err: "Mask '" + (args && args.mask) + "' is already " +
          "animated (" + maskKeys[id] + " keyframes) -- pass 'atTime' to " +
          "add a keyframe, 'keys' to rewrite the animation, or clear it " +
          "first with remove_keyframes." };
      }
      return { points: ((args && args.vertices) || []).length };
    }
    case "add_shape_layer": {
      const nm = (args && args.name) || "Shape Layer 1";
      shapeSeedLayer(nm, args && args.size);
      if (inBnComp(args)) {
        bnAdd(nm, "shape", { pos: (args && args.position) || [0, 0] });
      }
      return { index: 1, name: nm,
               shape: (args && args.shape) || "rectangle" };
    }
    case "add_shape_content": {
      const L = shapeLayerOf(args && args.layer);
      if (!L) return { params: "End" };
      const kind = String((args && args.kind) || "");
      let container = L.items, into = "(layer root)";
      if (args && args.group) {
        const g = shapeFindGroup(L, args.group);
        if (!g) {
          return { __err: "Group not found: " + args.group + ". Groups " +
            "here: " + L.items.filter(i => i.kind === "group")
              .map(i => i.name).join(", ") };
        }
        container = g.items; into = g.name;
      }
      const item = shapeNewItem(kind, kind === "group"
        ? (args.name || "Group 1") : (args.name || null));
      const applied = [];
      const map = SHAPE_PARAMS[kind] || {};
      const params = (args && args.params) || {};
      for (const k of Object.keys(params)) {
        if (!Object.prototype.hasOwnProperty.call(map, k)) {
          return { __err: "Param '" + k + "' not found on the new " + kind +
            " ('" + item.name + "' WAS added). Its params: " +
            Object.keys(map).join(", ") };
        }
        const range = SHAPE_RANGE[k];
        if (range && typeof params[k] === "number") {
          if (params[k] < range[0]) {
            return { __err: "AE rejected param '" + k + "': After Effects " +
              "error: Unable to call “setValue” because of " +
              "parameter 1. Value " + params[k] + " is less-than-" +
              range[0] + "." };
          }
          if (range[1] !== null && params[k] > range[1]) {
            return { __err: "AE rejected param '" + k + "': After Effects " +
              "error: Unable to call “setValue” because of " +
              "parameter 1. Value " + params[k] + " out of range " +
              range[0] + " to " + range[1] + "." };
          }
        }
        item.vals[(map[k] ? map[k] + "/" : "") + k] = params[k];
        applied.push(k);
      }
      container.push(item);
      const base = "contents/" +
        (into === "(layer root)" ? "" : into + "/") + item.name + "/";
      const out = { layer: args.layer, added: item.name, container: into,
        params: applied.join(", "),
        note: "Animatable via set_keyframes on '" + base + "<param>' " +
          "paths" + (kind === "repeater"
            ? " — the offsets are one level down, e.g. '" + base +
              "Transform/Position'" : "") };
      if (SHAPE_FILTERS[kind] === 1) {
        const idx = container.indexOf(item);
        let above = 0;
        for (let i = 0; i < idx; i++) {
          if (shapeMakesGeometry(container[i])) above++;
        }
        if (!above) {
          out.warning = "'" + item.name + "' WAS added to " + into +
            ", but nothing above it there draws a shape, so it changes " +
            "nothing. A " + kind + " acts on the content ABOVE it in the " +
            "list, and new content is always appended BELOW — so adding " +
            "the rectangle now will NOT fix this. Put the shape in " +
            "first, then the " + kind + ".";
        }
      }
      return out;
    }
    // Cameras and lights can neither take a matte nor be one, and real
    // AE will not say so: measured 2026-09-01, a CameraLayer carries no
    // setTrackMatte at all and `camera.trackMatteType = LUMA` is
    // accepted silently. The refusal is the host's own, by layer TYPE,
    // so the stub answers by type too — every other layer kind, shape
    // and text included, still mattes.
    case "set_track_matte": {
      const tmLayer = (args && args.layer) || "";
      const rigged = (nm) => cameraNames[nm] || lights[nm];
      const kind = (nm) => (cameraNames[nm] ? "camera" : "light");
      if (rigged(tmLayer)) {
        return { __err: "'" + tmLayer + "' is " + kind(tmLayer) + " and cannot " +
          "take a track matte — only visual (AV) layers have pixels to " +
          "cut. get_comp_details {comp: \"" + (args && args.comp) +
          "\"} lists the layers and their types." };
      }
      const mtComp = (args && args.comp) || "";
      const mtKey = mtComp + "|" + tmLayer;
      const remember = (nm) => {
        if (!mtRig[mtComp]) mtRig[mtComp] = [];
        if (mtRig[mtComp].indexOf(nm) === -1) mtRig[mtComp].push(nm);
      };
      const mode = String((args && args.mode) || "alpha").toLowerCase();
      if (mode === "none" || mode === "off" || mode === "remove") {
        if (!mattes[mtKey]) {
          return { __err: "'" + tmLayer + "' has no track matte to " +
            "remove. get_comp_details {comp: \"" + mtComp + "\"} shows " +
            "'matte' on every layer in '" + mtComp + "' that has one." };
        }
        const was = mattes[mtKey].matte;
        delete mattes[mtKey];
        remember(tmLayer);
        return { layer: tmLayer, matte: "removed", was: was };
      }
      const mt = args && args.matteLayer;
      if (rigged(mt)) {
        return { __err: "matteLayer '" + mt + "' is " + kind(mt) +
          " and cannot BE a matte — only a visual (AV) layer has the " +
          "alpha/luma to cut with (layer: '" + tmLayer + "' is solid)." };
      }
      mattes[mtKey] = { matte: mt, mode: mode };
      remember(tmLayer);
      remember(mt);
      return { layer: tmLayer, matte: mt, mode: mode };
    }
    case "set_layer_parent":
      if (args && args.layer) parentedLayers[args.layer] = args.parent;
      if (inPcComp(args) && args.layer) pcParent[args.layer] = args.parent;
      return { parented: "ST Square 5" };
    case "scale_comp": {
      // The resize MUTATES the canned lights, so a later read can only
      // confirm a write that actually happened. Which options are in
      // play is the measured type + falloff table: Radius needs smooth
      // or inverseSquareClamped, Falloff Distance needs smooth, Shadow
      // Diffusion is spot/point only, and an ambient light has nothing
      // at all -- not even a writable Position.
      const relit = [], nothing = [];
      for (const nm of Object.keys(lights)) {
        const la = lights[nm];
        if (la.comp !== (args && args.comp)) continue;
        const kind = la.type ? String(la.type).toLowerCase() : "spot";
        const fall = la.falloff ? String(la.falloff).toLowerCase() : "none";
        if (kind === "ambient" || kind === "environment") {
          nothing.push(nm + " (" + kind + " light)");
          continue;
        }
        const half = (k) => {
          if (typeof la[k] === "number" && la[k]) { la[k] /= 2; return true; }
          return false;
        };
        const did = [];
        if ((fall === "smooth" || fall === "inversesquareclamped") &&
            half("radius")) did.push("Radius");
        if (fall === "smooth" && half("falloffDistance")) {
          did.push("Falloff Distance");
        }
        if ((kind === "spot" || kind === "point") &&
            half("shadowDiffusion")) did.push("Shadow Diffusion");
        if (did.length) relit.push(nm + " (" + did.join(", ") + ")");
        // A parented light inherits its TRANSFORM and nothing else.
        if (!parentedLayers[nm] && la.position) {
          la.position = la.position.map((n) => n / 2);
        }
      }
      // layersSkipped absent = nothing refused the write. That is the
      // assertion the camera regression would have tripped.
      const out = { scaleFactor: 0.5, layersScaled: 8, layersInherited: 2,
                    parentedCamerasRezoomed: ["ST Cam Kid"] };
      if (relit.length) out.lightOptionsRescaled = relit;
      if (nothing.length) out.layersWithNothingToScale = nothing;
      return out;
    }
    case "add_solid":
      // A solid knows its own size, and every later read of it has to be
      // able to say so — the comp's dimensions are a different number.
      mkSizes[((args && args.comp) || "") + "|" + ((args && args.name) || "")] =
        { width: (args && args.width) || 100,
          height: (args && args.height) || 100 };
      if (args && /Self-Test Frame/.test(String(args.comp || ""))) {
        frLayers[args.comp] = (frLayers[args.comp] || []);
        frLayers[args.comp].unshift(String(args.name || "solid"));
      }
      // The hygiene steps ask get_project_info whether a PREVIEW deleted
      // the orphaned solid, so its source has to really exist here.
      if (args && String(args.name || "").indexOf("ST HYG") === 0) {
        solidSources.push({ name: args.name, id: 950 + solidSources.length,
                            type: "footage" });
      }
      if (inCvComp(args)) cvSolids.push(String(args.name));
      if (inWpComp(args)) wpLayers.push(String(args.name));
      if (inBatComp(args)) batSolids.push(args.name);
      if (inRbComp(args)) rbLayers.push(args.name);
      if (inPcComp(args)) pcLayers.push(args.name);
      // A fresh solid is SILENT — hasAudio is false until Tone lands.
      if (inAuComp(args)) auLayers.push({ name: args.name, audio: false });
      if (inCapAudio(args)) capAudio.push({ name: args.name, audio: false });
      return { name: (args && args.name) || "ST Square" };
    case "apply_effect":
      if (inCapAudio(args)) {
        if (String(args.effect) !== "Tone") {
          return { __err: "Effect not available: " + args.effect };
        }
        const capHost = capAudio.filter(l => l.name === String(args.layer))[0];
        if (!capHost) return { __err: "Layer not found: " + args.layer };
        capHost.audio = true;
        return { layer: args.layer, effect: "Tone",
                 matchName: "ADBE Aud Tone",
                 params: ["Waveform options", "Level", "Compositing Options"] };
      }
      if (inAuComp(args)) {
        if (String(args.effect) !== "Tone") {
          return { __err: "Effect not available: " + args.effect };
        }
        const host = auFind(args.layer);
        if (!host) return { __err: "Layer not found: " + args.layer };
        host.audio = true;      // measured: layer.hasAudio flips to true
        return { layer: args.layer, effect: "Tone",
                 matchName: "ADBE Aud Tone",
                 params: ["Waveform options", "Frequency 1", "Frequency 2",
                          "Frequency 3", "Frequency 4", "Frequency 5",
                          "Level", "Compositing Options"] };
      }
      if (inCvComp(args)) {
        const have = cvFx[args.layer] || (cvFx[args.layer] = []);
        // AE's own duplicate-name rule: the second copy becomes "<name> 2".
        const dupes = have.filter(n => n === args.effect ||
                                       n.indexOf(args.effect + " ") === 0);
        const named = dupes.length ? args.effect + " " + (dupes.length + 1)
                                   : args.effect;
        have.push(named);
        return { layer: args.layer, effect: named,
                 matchName: "ADBE Gaussian Blur 2" };
      }
      if (inBatComp(args)) {
        if (batSolids.indexOf(args.layer) === -1) {
          return { __err: "No layer '" + args.layer + "' in '" +
            args.comp + "' -- it holds: " + batSolids.join(", ") };
        }
        batSolidFx[args.layer] = args.effect;
        return { layer: args.layer, effect: args.effect };
      }
      return { done: true };
    case "remove_effect": {
      // The coverage rig's parade: the controls add_control put there
      // (AE lists them as effects too) then the blurs, in AE's order.
      // Every blur shares the one matchName, so a matchName call matches
      // them all and the FIRST goes. Anywhere else the layer carries no
      // effects, which is the refusal the order rig measures.
      const ctrlNames = Object.keys(cvControls)
        .filter(k => k.indexOf(args.layer + "/") === 0)
        .map(k => k.slice(String(args.layer).length + 1));
      const blurs = inCvComp(args) ? (cvFx[args.layer] || []) : [];
      const parade = ctrlNames.concat(blurs);
      if (!inCvComp(args) || parade.length === 0) {
        return { __err: "'" + args.layer + "' has no effects at all — " +
          "nothing to remove, and no other effect name will match either." };
      }
      const want = String((args && args.effect) || "");
      const hits = parade.filter(n => n === want ||
        (want === "ADBE Gaussian Blur 2" && /^Gaussian Blur/.test(n)));
      if (!hits.length) {
        return { __err: "No effect '" + want + "' on '" + args.layer +
          "'. Effects here: " + parade.join(", ") + " — pass one of " +
          "those display names (or its matchName). apply_effect adds " +
          "one that is missing." };
      }
      const victim = hits[0];
      if (blurs.indexOf(victim) !== -1) {
        cvFx[args.layer].splice(cvFx[args.layer].indexOf(victim), 1);
      } else {
        delete cvControls[args.layer + "/" + victim];
      }
      const out = { layer: args.layer, removed: victim,
                    matchName: "ADBE Gaussian Blur 2",
                    remainingEffects: parade.filter(n => n !== victim) };
      if (hits.length > 1) {
        out.alsoMatched = hits.slice(1);
        out.note = hits.length + " effects matched '" + want + "' — " +
          "removed the first (top-most, '" + victim + "'); " +
          hits.slice(1).join(", ") + " still on the layer.";
      }
      return out;
    }
    case "set_effect_param": {
      // Only the batch comp's Gaussian Blur is modelled by name; that is
      // where the value-shape steps run, and a roster invented for the
      // other comps would be a lie.
      const bad = badValueRefusal(args && args.value,
        String((args && args.effect) || "") + "/" +
        String((args && args.param) || ""), "number",
        batchBlur === null ? null : batchBlur,
        "effect." + String((args && args.effect) || "") + "." +
        String((args && args.param) || ""));
      if (bad) return { __err: bad };
      if (/Batch/.test(String((args && args.comp) || "")) &&
          /Blurriness/.test(String((args && args.param) || ""))) {
        batchBlur = Number(args.value);
      }
      return { layer: args && args.layer, effect: args && args.effect,
               param: args && args.param,
               value: Number(args && args.value) };
    }
    case "set_transform": {
      const badT = badValueRefusal(args && args.value,
        String((args && args.property) || ""),
        args && args.property === "position" ? "array" : "number",
        null, String((args && args.property) || ""));
      if (badT) return { __err: badT };
      const shows = drivenShows(args && args.layer, args && args.property);
      if (shows !== null) {
        // Accepted and invisible: the honest answer names the value that
        // is really in the comp.
        return { layer: args.layer, property: args.property,
                 value: args.value, applied: false,
                 warning: "'" + args.property + "' is driven by an " +
                   "expression that ignores written values -- the comp " +
                   "still shows " + JSON.stringify(shows) + ", not " +
                   JSON.stringify(args.value) + ". Clear it first " +
                   "(set_expression with expression: \"\")." };
      }
      if (inBatComp(args)) {
        if (batSolids.indexOf(args.layer) === -1) {
          return { __err: "No layer '" + args.layer + "' in '" +
            args.comp + "' -- it holds: " + batSolids.join(", ") };
        }
        // AE takes {property, value} here, NOT {position: [...]}. The stub
        // used to accept either, so a malformed step passed CI and only
        // failed in real AE -- which is exactly what happened.
        const OK = ["position", "scale", "rotation", "opacity",
                    "anchorPoint"];
        if (OK.indexOf(args.property) === -1) {
          return { __err: "'property' must be one of: " + OK.join(", ") };
        }
        if (args.property === "position") {
          batSolidPos[args.layer] = args.value;
        }
        return { layer: args.layer, property: args.property,
                 value: args.value };
      }
      if (inCvComp(args) && args.property === "anchorPoint") {
        // Z only exists to be written while the layer is 3D. A 2D layer
        // takes the x/y and drops the third component on the floor.
        const v = args.value || [];
        cvAnchor[args.layer] = [v[0] || 0, v[1] || 0,
                                cvThreeD[args.layer] ? (v[2] || 0) : 0];
        return { layer: args.layer, property: args.property,
                 value: cvAnchor[args.layer].slice() };
      }
      return { done: true };
    }
    case "add_text_animator": {
      const a = args || {};
      if (a.layer === "ST Anim Solid") {
        return { __err: "'ST Anim Solid' is a solid layer — text " +
          "animators only exist on TEXT layers. Text layers here: " +
          "ANIMATE ME." };
      }
      const wanted = [], unknown = [], needs3D = [];
      const props = a.properties || {};
      Object.keys(props).forEach(k => {
        const slot = TX_SLOTS[String(k).toLowerCase()];
        if (!slot) { unknown.push(k); return; }
        wanted.push({ key: String(k).toLowerCase(), slot: slot,
                      value: props[k] });
        if (TX_3D_ONLY[String(k).toLowerCase()]) needs3D.push(k);
      });
      if (unknown.length) {
        return { __err: "No animator property named " + unknown.join(", ") +
          ". AE's animator properties: anchorPoint, position, scale, skew, " +
          "skewAxis, rotation, xRotation, yRotation, opacity, fillColor, " +
          "tracking, blur." };
      }
      const sel = a.selector || {};
      const selType = sel.type ? String(sel.type).toLowerCase() : "range";
      const idxUnits = String(sel.units || "") === "index";
      const ends = ["start", "end", "offset"];
      for (let i = 0; i < ends.length; i++) {
        const v = sel[ends[i]];
        if (v === undefined || v === null) continue;
        if (!idxUnits && (v < -100 || v > 100)) {
          return { __err: "selector '" + ends[i] + "' is a PERCENT here (" +
            v + " is outside -100..100). For a character count pass " +
            'units: "index" too.' };
        }
      }
      // AE would let the name repeat and then answer a lookup with the
      // FIRST one, so the tool numbers it and says so.
      const asked = a.name || ("Animator " + (txAnims.length + 1));
      let finalName = asked, n = 2;
      while (txFind(finalName)) finalName = asked + " " + (n++);
      const rec = { name: finalName, props: {}, sel: null };
      txAnims.push(rec);
      const out = { layer: a.layer, animator: finalName,
                    path: "Text/Animators/" + finalName };
      if (finalName !== asked) {
        out.nameTaken = "'" + asked + "' was already an animator on this " +
          "layer, so AE would have answered a lookup with the OTHER one";
      }
      if (needs3D.length && !txPerChar) {
        txPerChar = true;
        out.perCharacter3D = "per-character 3D turned ON — " +
          needs3D.join(", ") + " only affects characters with it; AE made '" +
          a.layer + "' a 3D layer to do it";
      }
      const problems = [], applied = [];
      wanted.forEach(w => {
        let v = w.value;
        if (Array.isArray(v) && Array.isArray(w.slot[1])) {
          v = v.slice();
          while (v.length < w.slot[1].length) v.push(0);
        }
        if (typeof v === "string" && !isNaN(Number(v))) v = Number(v);
        const lo = w.slot[2], hi = w.slot[3];
        if (typeof lo === "number" && (v < lo || v > hi)) {
          problems.push("AE rejected '" + w.key + "': After Effects error: " +
            "Value " + v + " out of range. Range: " + lo + " to " + hi + ".");
          return;
        }
        rec.props[w.slot[0]] = v;
        applied.push({ property: w.slot[0], value: v,
                       path: "Text/Animators/" + finalName + "/Properties/" +
                             w.slot[0] });
      });
      out.properties = applied;
      if (selType === "none") {
        out.selector = "none — the animator applies to every character";
      } else if (selType === "wiggly") {
        rec.sel = { name: "Wiggly Selector 1", type: "wiggly",
                    rows: { "ADBE Text Temporal Freq": sel.wigglesPerSecond,
                            "ADBE Text Character Correlation": sel.correlation,
                            "ADBE Text Wiggly Max Amount": sel.maxAmount } };
        out.selector = { name: rec.sel.name, type: "wiggly",
          path: "Text/Animators/" + finalName + "/Selectors/Wiggly Selector 1",
          settings: { wigglesPerSecond: sel.wigglesPerSecond,
                      correlation: sel.correlation, maxAmount: sel.maxAmount,
                      mode: sel.mode } };
      } else {
        const rows = { "ADBE Text Percent Start": 0,
                       "ADBE Text Percent End": 100,
                       "ADBE Text Percent Offset": 0,
                       "ADBE Text Index Start": 0, "ADBE Text Index End": 0,
                       "ADBE Text Index Offset": 0 };
        const settings = {};
        if (idxUnits) settings.units = "index";
        ends.forEach(k => {
          if (sel[k] === undefined || sel[k] === null) return;
          rows["ADBE Text " + (idxUnits ? "Index" : "Percent") + " " +
               k.charAt(0).toUpperCase() + k.slice(1)] = sel[k];
          settings[k] = sel[k];
        });
        if (sel.shape) settings.shape = sel.shape;
        if (sel.easeHigh !== undefined) settings.easeHigh = sel.easeHigh;
        rec.sel = { name: "Range Selector 1", type: "range", rows: rows,
                    keys: null };
        out.selector = { name: "Range Selector 1", type: "range",
          path: "Text/Animators/" + finalName + "/Selectors/Range Selector 1",
          settings: settings };
        out.animateHint = 'set_keyframes {layer: "' + a.layer +
          '", property: "' + out.selector.path + '/Offset", keys: [...]} ' +
          "slides the selection across the text";
      }
      if (problems.length) out.problems = problems;
      return out;
    }
    case "add_text_layer": {
      // comp.layers.addText() inherits AE's Character panel, so the host
      // resets a NEW layer to a documented baseline and lets the args
      // override it. The canned host models that contract; without it the
      // baseline steps would pass on a stub that never normalizes.
      const inherit = !!(args && args.inheritStyle);
      textStyle = inherit
        ? { fontSize: 66, font: "PowerCentra-Book", tracking: 251,
            leading: 92, fillColor: [0.55, 0.1, 0.9] }
        : { fontSize: 72, font: "StubFont-Regular", tracking: 0,
            leading: "auto", fillColor: [1, 1, 1] };
      if (args && args.fontSize !== undefined) textStyle.fontSize = args.fontSize;
      if (args && args.font !== undefined) textStyle.font = args.font;
      if (args && args.tracking !== undefined) textStyle.tracking = args.tracking;
      if (args && args.leading !== undefined) textStyle.leading = args.leading;
      if (args && args.fillColor !== undefined) textStyle.fillColor = args.fillColor;
      // AE names a new text layer after its own text.
      const made = { index: 1, name: (args && args.text) || "Text",
                     style: textStyle };
      if (/^ST PreText/.test(made.name)) preLayers.push(made.name);
      if (inherit) made.inheritedStyle = true; else made.styleReset = true;
      return made;
    }
    case "delete_layer":
      if (args && preLayers.indexOf(args.layer) !== -1) {
        preLayers = preLayers.filter((nm) => nm !== args.layer);
        preSelection = preSelection.filter((nm) => nm !== args.layer);
      }
      return { removed: args && args.layer };
    case "set_text_style":
      if (!textStyle) textStyle = {};
      if (args && args.fontSize !== undefined) textStyle.fontSize = args.fontSize;
      if (args && args.tracking !== undefined) textStyle.tracking = args.tracking;
      if (args && args.font !== undefined) textStyle.font = args.font;
      if (args && args.leading !== undefined) {
        textStyle.leading = args.leading === "auto" ? "auto" : args.leading;
      }
      return { style: textStyle };
    case "add_light": {
      const has = (k) => args && args[k] !== undefined &&
                         args[k] !== null && args[k] !== "";
      const kind = has("type") ? String(args.type).toLowerCase() : "spot";
      if (!lightAcc(LIGHT_KINDS.join(" "), kind)) {
        return { __err: "No light type '" + args.type + "'. AE has: " +
          LIGHT_KINDS.join(", ") + "." };
      }
      const fall = has("falloff")
        ? String(args.falloff).toLowerCase() : "none";
      for (const k of LIGHT_ORDER) {
        if (!has(k)) continue;
        if (!lightAcc(LIGHT_ON[k], kind)) {
          const mine = LIGHT_ORDER.filter(x => lightAcc(LIGHT_ON[x], kind));
          return { __err: (/^[ae]/.test(kind) ? "An " : "A ") + kind +
            " light has no " + k + " \u2014 AE hides it. Types that " +
            "take it: " + LIGHT_ON[k].split(" ").join(", ") +
            ". This light accepts: " + mine.join(", ") + "." };
        }
      }
      if (has("radius") && fall !== "smooth" &&
          fall !== "inversesquareclamped") {
        return { __err: "'radius' only exists while Falloff is smooth, " +
          "inverseSquareClamped; this light's falloff is '" + fall +
          "'. Pass falloff: \"smooth\" too." };
      }
      if (has("falloffDistance") && fall !== "smooth") {
        return { __err: "'falloffDistance' only exists while Falloff " +
          "is smooth; this light's falloff is '" + fall +
          "'. Pass falloff: \"smooth\" too." };
      }
      if (args && args.oneNode === true && has("pointOfInterest")) {
        return { __err: "A one-node light has no Point of Interest to " +
          "aim at. Drop 'pointOfInterest', or drop 'oneNode' to aim it." };
      }
      const nm = (args && args.name) || "Light";
      // A light AE just made carries DEFAULTS for everything the caller
      // left out, and a read has to answer with them -- measured in real
      // AE 2026: radius 500, falloff distance 500, diffusion 0, cone 90,
      // intensity 100. Without them the resize step that must leave a
      // HIDDEN Falloff Distance alone had nothing to leave alone.
      lights[nm] = Object.assign(
        { radius: 500, falloffDistance: 500, shadowDiffusion: 0,
          coneAngle: 90, intensity: 100 }, args || {});
      const applied = LIGHT_ORDER.filter(has);
      return { index: Object.keys(lights).length, name: nm, type: kind,
        applied: applied.join(", ") || "(defaults only)", refused: "",
        note: "Only 3D layers (set_layer_3d) with Material Options > " +
              "Accepts Lights are lit by this" };
    }
    case "add_camera":
      if (args && /^ST PreCam/.test(String(args.name || ""))) {
        preLayers.push(args.name);
      }
      cameraNames[(args && args.name) || "Camera"] = true;
      return { index: 1, name: (args && args.name) || "Camera" };
    case "set_layer_timing":
      // Writing the trim echoes it back; calling it with no timing args is
      // a pure READ, which is how the suite gets AE's unrounded in/out.
      if (args && typeof args.inPoint === "number") {
        if (inPcComp(args)) {
          pcTiming[args.layer] = { inPoint: args.inPoint,
                                   outPoint: args.outPoint };
        }
        return { layer: args.layer, inPoint: args.inPoint,
                 outPoint: args.outPoint, startTime: 0 };
      }
      return { layer: args && args.layer, inPoint: 85 / 30,
               outPoint: 107 / 30, startTime: 0 };
    case "split_layer_into_chunks": {
      // The preset rig needs the one real side effect this tool has: it
      // DESELECTS everything and leaves its pieces selected, which is the
      // only way a suite step can hand AE a multi-layer selection.
      if (args && args.chunks && args.chunks !== 7) {
        const n = Math.round(args.chunks);
        const base = String(args.layer || "ST Pre");
        const made = [];
        for (let i = 0; i < n; i++) {
          made.push({ layer: i === 0 ? base : base + " " + (i + 1),
                      index: i + 1, inPoint: i, outPoint: i + 1 });
        }
        preSelection = made.map((x) => x.layer);
        preLayers = preSelection.slice();
        return { chunks: n, chunkSeconds: 1, pieces: made,
                 note: "Chunks play seamlessly end-to-end on separate " +
                       "layers (no overlap); stacked ascending and now " +
                       "SELECTED" };
      }
      // A 1.35s..6.55s clip at 30 fps cut into 7: the ends stay verbatim
      // (frames 40.5 and 196.5) and every interior cut is moved onto a
      // whole frame. Reported in/out are rounded to 4 decimals, as the
      // host does.
      const fr = [40.5, 63, 85, 107, 130, 152, 174, 196.5];
      const pieces = [];
      for (let i = 0; i < 7; i++) {
        pieces.push({ layer: "ST Clip chunk " + (i + 1), index: 7 - i,
                      inPoint: Math.round(fr[i] / 30 * 10000) / 10000,
                      outPoint: Math.round(fr[i + 1] / 30 * 10000) / 10000 });
      }
      return { chunks: 7, chunkSeconds: 0.743, pieces: pieces,
               note: "Chunks play seamlessly end-to-end on separate " +
                     "layers (no overlap); stacked ascending and now " +
                     "SELECTED; cut on whole frames at 30 fps" };
    }
    // ---- the coverage rig's tools.
    case "add_control": {
      const kinds = Object.keys(CONTROL_TYPES);
      const t = String((args && args.type) || "slider").toLowerCase();
      if (!CONTROL_TYPES[t]) {
        return { __err: "'type' must be " +
                 kinds.slice(0, -1).join(", ") + " or " +
                 kinds[kinds.length - 1] };
      }
      if (!args || !args.name) {
        return { __err: "'name' is required (e.g. 'Speed')" };
      }
      // The display name of the group's single value property, which is
      // what the deep search appends when it descends into a control:
      // AE names it after the control type ("Slider", "Point", ...).
      cvControls[args.layer + "/" + args.name] =
        { type: t, match: CONTROL_TYPES[t], value: args.value,
          leaf: t.charAt(0).toUpperCase() + t.slice(1) };
      return { layer: args.layer, control: String(args.name), type: t,
               hint: "Link with link_property {controlLayer: \"" +
                     args.layer + "\", controlEffect: \"" + args.name +
                     "\"}" };
    }
    case "add_keyframe": {
      if (!args || typeof args.time !== "number") {
        return { __err: "'time' (seconds) required" };
      }
      const ks = cvKeyList(args.layer, args.property);
      const hit = ks.find(k => Math.abs(k.time - args.time) < 1e-9);
      if (hit) hit.value = args.value;
      else {
        ks.push({ time: args.time, value: args.value });
        ks.sort((a, b) => a.time - b.time);
      }
      return { layer: args.layer, property: args.property, time: args.time,
               numKeys: ks.length };
    }
    case "remove_keyframes": {
      if (inWpComp(args)) {
        const wp = String((args && args.property) || "");
        const wts = wpTargets(args);
        let wtotal = 0, wrows = 0;
        for (const L of wts) {
          const n = wpCount(L, wp);
          if (n > 0) { wtotal += n; wrows++; }
        }
        const wide = Array.isArray(args.layers) && args.layers.length >= 3 &&
          wts.length === wpLayers.length &&
          !(Array.isArray(args.times) && args.times.length) && wtotal > 0;
        if (wide) {
          const wkey = wp + "|" + wtotal + "|" + wrows;
          // The suite runs as ONE request in real AE (AELL_requestSeq is
          // bumped per chat turn, not per step), so a repeat inside it
          // hits the third branch rather than being let through. Modelled
          // exactly that way -- a stub that released on the second call
          // would have passed a suite real AE fails.
          {
            const why = (wpShown === wkey)
              ? "that preview was taken in THIS same reply, so the user " +
                "has not seen it yet"
              : "nothing has been previewed yet";
            wpShown = wkey;
            return { __err: "remove_keyframes refused to wipe every layer " +
              "in '" + args.comp + "': " + why + ". " +
              "Nothing was removed. This would delete " + wtotal + " " + wp +
              " keyframe(s) from " + wrows + " layer(s). That IS the " +
              "preview — ask the user WHICH of those should lose their " +
              "keyframes (or whether they really mean all of them), and " +
              "call again in your NEXT reply once they answer." };
          }
        }
        for (const L of wts) wpKeys[L + "/" + cvProp(wp)] = 0;
        return { layers: wts.length, property: wp, removed: wtotal };
      }
      const P = String((args && args.property) || "");
      // A group has no keys of its own; the host says so rather than
      // walking into it.
      if (/^(transform|effects|masks|contents|text|light)$/i.test(P)) {
        return { __err: "'" + P + "' is a GROUP" };
      }
      const ks = cvKeyList(args.layer, P);
      let removed = 0;
      if (Array.isArray(args.times) && args.times.length) {
        // Nearest key within 50 ms, the host's own tolerance — a time
        // that matches nothing removes nothing.
        for (const t of args.times) {
          let best = -1, bestD = 1e9;
          ks.forEach((k, i) => {
            const d = Math.abs(k.time - Number(t));
            if (d < bestD) { bestD = d; best = i; }
          });
          if (best >= 0 && bestD < 0.05) { ks.splice(best, 1); removed++; }
        }
      } else {
        removed = ks.length;
        if (ks.length) {
          cvResidual[args.layer + "/" + cvProp(P)] = ks[ks.length - 1].value;
        }
        ks.length = 0;
      }
      return { layers: 1, property: P, removed, remaining: ks.length };
    }
    case "apply_expression_preset": {
      const p = String((args && args.preset) || "").toLowerCase();
      // A missing 'property' is the host's most-hit refusal with the real
      // model, and it has to hand back what the layer actually carries —
      // the transform words, this layer's effects (the only way to spell
      // effect.<Effect>.<Param>) and whatever already has keyframes.
      if (!(args && args.property)) {
        let why = "";
        if (p === "wiggle") {
          why = " — wiggle needs the property to wiggle — 'position' is " +
                "the drift/float/hover one, rotation a sway, opacity a " +
                "flicker";
        } else if (p.slice(0, 5) === "loop_") {
          why = " — a loop preset needs the property that HAS the keyframes";
        } else if (p === "time_linear") {
          why = " — time_linear needs a scalar property (rotation, " +
                "opacity, a slider)";
        }
        const L = String((args && args.layer) || "");
        let msg = "Missing 'property'" + why + ". On '" + L + "' it can " +
          "be position, scale, rotation, opacity or anchorPoint";
        const parade = Object.keys(cvControls)
          .filter(k => k.indexOf(L + "/") === 0)
          .map(k => k.slice(L.length + 1))
          .concat(cvFx[L] || []);
        if (parade.length) {
          msg += ", or effect.<Effect>.<Param> using this layer's " +
            "effects: " + parade.join(", ");
        }
        const keyed = ["position", "scale", "rotation", "opacity",
                       "anchorPoint"].filter(
          n => (cvKeys[L + "/" + n.toLowerCase()] || []).length > 0);
        if (keyed.length) {
          msg += ". Already keyframed here: " + keyed.join(", ");
        }
        return { __err: msg + "." };
      }
      if (EXPR_PRESETS.indexOf(p) === -1) {
        return { __err: "Unknown preset '" + (args && args.preset) +
                 "'. Available: " + EXPR_PRESETS.join(", ") };
      }
      const np = cvProp(args && args.property);
      const isArrayTarget = np === "position" || np === "scale" ||
                            np === "anchorpoint";
      if (p === "time_linear" && isArrayTarget) {
        return { __err: "time_linear works on scalar properties " +
          "(rotation, opacity, slider). For position drift, keyframe it " +
          "or rig a slider with link_property." };
      }
      const ref = (c) => {
        if (!cvControls[c.layer + "/" + c.effect]) return null;
        return 'thisComp.layer("' + c.layer + '").effect("' + c.effect +
               '")(1)';
      };
      let expr;
      if (p === "wiggle") {
        let f = 2, a = 20;
        if (args.freqControl) {
          f = ref(args.freqControl);
          if (!f) {
            return { __err: "Control not found: '" + args.freqControl.effect +
              "' on layer '" + args.freqControl.layer + "'. Use " +
              "add_control first." };
          }
        } else if (typeof args.frequency === "number") f = args.frequency;
        if (args.ampControl) {
          a = ref(args.ampControl);
          if (!a) {
            return { __err: "Control not found: '" + args.ampControl.effect +
              "' on layer '" + args.ampControl.layer + "'. Use " +
              "add_control first." };
          }
        } else if (typeof args.amplitude === "number") a = args.amplitude;
        expr = "wiggle(" + f + ", " + a + ");";
      } else if (p === "time_linear") {
        expr = "value + time * (" +
               (typeof args.rate === "number" ? args.rate : 100) + ");";
      } else {
        expr = 'loopOut("' + p.replace(/^loop_/, "") + '");';
      }
      cvExpr[args.layer + "/" + np] = expr;
      return { layer: args.layer, property: args.property, preset: p,
               expression: expr };
    }
    case "set_property": {
      const SL = shapeLayerOf(args && args.layer);
      if (SL && /^contents\//i.test(String((args && args.property) || ""))) {
        const hit = shapeResolve(SL, args.layer, args.property);
        if (hit && hit.__err) return hit;
        if (hit) {
          hit.item.vals[hit.key] = args.value;
          return { layer: args.layer, property: args.property,
                   value: args.value, keyframed: false, numKeys: 0 };
        }
      }
      if (inTx(args)) {
        const spec = String((args && args.property) || "");
        const t = txParse(spec);
        if (t && t.anim && t.kind === "Properties" &&
            !Object.prototype.hasOwnProperty.call(t.anim.props, t.rest)) {
          return { __err: "'" + spec + "' is a text-animator property " +
            "that has not been added, so AE keeps it hidden and writing " +
            "to it does nothing. add_text_animator {layer: \"" +
            args.layer + "\", properties: {…}} adds and sets one in a " +
            "single call." };
        }
        // A BARE name that only a hidden slot answers to: the deep search
        // finds it, and refuses rather than leaking AE's own error.
        if (!t && txAnims.length && !/\//.test(spec)) {
          const hit = txAnims.filter(an =>
            Object.prototype.hasOwnProperty.call(an.props, spec))[0];
          if (!hit) {
            return { __err: "'" + spec + "' on '" + args.layer + "' exists " +
              "only as an INACTIVE text-animator property " +
              "(Text/Animators/" + txAnims[0].name + "/Properties/" + spec +
              "). AE hides those until an animator is asked for them, and " +
              "a value written there is ignored. add_text_animator " +
              "activates it." };
          }
        }
      }
      // Only what the coverage rig asks of it: a 3D-only rotation, so the
      // discard report below has something real to find.
      if (cvProp(args && args.property) === "xrotation") {
        cvXRot[args.layer] = args.value;
      }
      if (inCvComp(args)) {
        const tie = cvAmbiguous(args.layer, args.property);
        // A refusal that still wrote would be the worst of both: the
        // canned host returns the error INSTEAD of touching anything.
        if (tie) return { __err: tie };
      }
      // Written through the deep search, a light option really moves --
      // a read afterwards can only confirm a write that happened.
      if (args && lights[args.layer]) {
        const deep = LIGHT_DEEP_ONLY[String(args.property)];
        if (deep) {
          lights[args.layer][deep[0]] = args.value;
          return { layer: args.layer, property: args.property,
                   value: args.value, keyframed: false, numKeys: 0,
                   resolvedPath: LIGHT_DEEP_PATH[deep[0]] };
        }
      }
      return { layer: args && args.layer, property: args && args.property,
               value: args && args.value };
    }
    case "set_layer_3d": {
      const L = (args && args.layer) || "";
      const want = !!(args && args.enabled);
      // Going back to 2D discards the Z of Position and Anchor Point,
      // resets Scale Z to 100 and clears Orientation and X/Y Rotation --
      // keyframes included -- and never restores them. AE says nothing;
      // the host reads the doomed values BEFORE the write and names them.
      const lost = [];
      const pk = cvKeys[L + "/position"] || [];
      if (cvThreeD[L] && !want) {
        let hits = 0, worst = null;
        for (const k of pk) {
          const z = Array.isArray(k.value) ? k.value[2] : undefined;
          if (typeof z !== "number" || z === 0) continue;
          hits++;
          if (worst === null || Math.abs(z) > Math.abs(worst)) worst = z;
        }
        if (hits) {
          lost.push("Position Z on " + hits + " of " + pk.length +
                    " keyframes (largest " + worst + ")");
        }
        if (cvAnchor[L] && cvAnchor[L][2]) {
          lost.push("Anchor Point Z " + cvAnchor[L][2]);
        }
        if (cvXRot[L]) lost.push("X Rotation " + cvXRot[L]);
      }
      cvThreeD[L] = want;
      if (!want) {
        if (cvAnchor[L]) cvAnchor[L][2] = 0;
        cvXRot[L] = 0;
        for (const k of pk) if (Array.isArray(k.value)) k.value[2] = 0;
      }
      const out = { layer: L, threeD: cvThreeD[L] };
      if (lost.length) out.discarded = lost;
      return out;
    }
    case "list_properties": {
      const P = String((args && args.path) || "");
      if (/^effects$/i.test(P) && args &&
          preLayers.indexOf(args.layer) !== -1) {
        const n = preFx[args.layer] || 0;
        const rows = [];
        for (let i = 0; i < n; i++) {
          rows.push({ path: "effects/FX " + (i + 1),
                      matchName: "ADBE FX", kind: "group" });
        }
        return { layer: args.layer, root: "effects", count: n,
                 properties: rows, note: "" };
      }
      if (inTx(args)) {
        if (P === "Text/Animators") {
          return { layer: args.layer, root: P, count: txAnims.length,
                   properties: txAnims.map(an => ({ path: P + "/" + an.name,
                     matchName: "ADBE Text Animator", kind: "group" })),
                   note: "" };
        }
        const t = txParse(P);
        if (t && t.anim && t.kind === "Selectors") {
          const rows = Object.keys(txSelRows(t.anim)).map(mn => ({
            path: P + "/" + mn, matchName: mn, kind: "prop",
            value: txSelRows(t.anim)[mn] === undefined
              ? 0 : txSelRows(t.anim)[mn] }));
          return { layer: args.layer, root: P, count: rows.length,
                   properties: rows, note: "" };
        }
      }
      if (/\/(position|scale|rotation|opacity|anchor point)$/i.test(P)) {
        return { __err: "'" + P + "' is a PROPERTY, not a group — use " +
                 "get_property for its value" };
      }
      const rows = /^transform$/i.test(P)
        ? CV_TRANSFORM.map(([n, mn]) => ({ path: "transform/" + cvName(n, mn,
            args && args.layer), matchName: mn, kind: "prop" }))
        : CV_ROOT.map(([n, mn, kind]) => ({ path: n, matchName: mn, kind }));
      return { layer: args && args.layer, root: P || "(layer)",
               count: rows.length, properties: rows, note: "" };
    }
    case "list_presets": {
      const f = String((args && args.filter) || "").toLowerCase();
      const wc = String((args && args.category) || "")
        .split("\\").join("/").toLowerCase();
      const ws = String((args && args.source) || "").toLowerCase();
      const lim = listLimit(args && args.limit);
      const hits = PRESET_LIB.filter((p) => {
        if (ws && p.source !== ws) return false;
        if (wc && (p.category || "").toLowerCase().indexOf(wc) !== 0) {
          return false;
        }
        return !f || presetPath(p).toLowerCase().indexOf(f) !== -1;
      });
      if (!hits.length) {
        return { __err: "No preset matches '" + ((args && args.filter) ||
          (args && args.category) || "that") + "'. " + PRESET_LIB.length +
          " presets are installed. Categories: " + PRESET_CATS.join(", ") +
          "." };
      }
      const page = lim < 0 ? hits : hits.slice(0, lim);
      return { total: hits.length, offset: 0, listed: page.length,
               installed: PRESET_LIB.length, categories: PRESET_CATS,
               presets: page.map((p) => ({ name: p.name,
                 category: p.category, source: p.source })),
               note: "" };
    }
    // AE's measured contract, not "ok": the preset lands on the layer it
    // was GIVEN (never on the rest of the selection), a preset built for
    // another layer type changes nothing, and the refusal has to say so.
    case "apply_preset": {
      const targets = (args && args.layers) ||
                      (args && args.layer ? [args.layer] : preSelection);
      if (!args || !args.preset) {
        return { __err: "'preset' is required — a preset name or " +
                 "\"Category/Name\". Use list_presets to find one." };
      }
      const m = presetMatch(args.preset);
      if (m.choices) {
        return { __err: "'" + args.preset + "' matches " + m.choices.length +
          " presets — pass one of these exactly: " +
          m.choices.map(presetPath).join(", ") };
      }
      if (!m.hit) {
        return { __err: "No preset named '" + args.preset + "'. " +
          PRESET_LIB.length + " presets are installed; categories: " +
          PRESET_CATS.join(", ") + ". Use list_presets {filter} to search." };
      }
      const applied = [], skipped = [];
      targets.forEach((nm) => {
        if (!presetFits(m.hit, nm)) {
          skipped.push({ layer: nm, type: presetLayerType(nm),
                         reason: "AE applied nothing" });
          return;
        }
        const row = { layer: nm, type: presetLayerType(nm) };
        if (m.hit.effects) {
          preFx[nm] = (preFx[nm] || 0) + m.hit.effects;
          row.effectsAdded = [];
          for (let i = 0; i < m.hit.effects; i++) {
            row.effectsAdded.push(m.hit.name + " fx " + (i + 1));
          }
        }
        if (m.hit.keys) row.keysAndExpressionsAdded = m.hit.keys;
        applied.push(row);
      });
      if (!applied.length) {
        const types = [];
        skipped.forEach((k) => {
          if (types.indexOf(k.type) === -1) types.push(k.type);
        });
        return { __err: "Preset '" + presetPath(m.hit) + "' changed " +
          "nothing on " + (skipped.length === 1
            ? "layer '" + skipped[0].layer + "' (" + types.join(", ") + ")"
            : skipped.length + " layers (" + types.join(", ") + ")") +
          ". AE applies a preset built for another layer type as a SILENT " +
          "no-op — a Text preset needs a TEXT layer, and cameras/lights " +
          "take no effects at all." };
      }
      const out = { preset: m.hit.name, category: m.hit.category,
                    source: m.hit.source, applied: applied };
      const nonText = applied.filter(r => r.type !== "text")
                             .map(r => r.layer);
      if (/^Text($|\/)/i.test(m.hit.category || "") && nonText.length) {
        out.partialOnNonText = nonText;
        out.partialNote = "This is a Text preset. On a non-text layer only " +
          "its expression CONTROLS can land — the animation itself lives " +
          "in text animators, which only a TEXT layer has.";
      }
      if (skipped.length) {
        out.skipped = skipped;
        out.note = skipped.length + " layer(s) got nothing — the preset " +
          "does not fit that layer type.";
      }
      return out;
    }
    case "list_effects": {
      const f = String((args && args.filter) || "").toLowerCase();
      const off = (args && args.offset > 0) ? Math.round(args.offset) : 0;
      const hits = CV_EFFECTS.filter(e => !f ||
        (e.name + " " + e.category).toLowerCase().indexOf(f) !== -1);
      const page = hits.slice(off, off + 40);
      return { total: hits.length, offset: off, listed: page.length,
               effects: page,
               note: hits.length > off + page.length
                 ? "More matches — pass {offset: " + (off + page.length) +
                   "} or a narrower {filter}" : "" };
    }
    case "set_comp_setting": {
      const nm = (args && args.comp) || createdComps[createdComps.length - 1];
      const c = compProps[nm] || (compProps[nm] = {});
      const notes = [];
      const changed = [];
      if (args.width > 0) {
        c.width = Math.round(args.width); changed.push("width");
      }
      if (args.height > 0) {
        c.height = Math.round(args.height); changed.push("height");
      }
      if (args.duration > 0) {
        c.duration = args.duration;
        changed.push("duration");
        if (c.waStart + c.waDur > c.duration) {       // AE's silent drag
          c.waDur = Math.max(0, c.duration - c.waStart);
          notes.push("Re-timing the comp pulled the work area in with it.");
        }
      }
      if (args.frameRate > 0) {
        c.frameRate = args.frameRate; changed.push("frameRate");
      }
      if (Array.isArray(args.bgColor)) {
        c.bg = args.bgColor.slice(0, 3); changed.push("bgColor");
      }
      const fd = 1 / (c.frameRate || 30);
      const snap = (t) => Math.round(Number(t) / fd) * fd;
      const secs = (t) => (Math.round(Number(t) * 1000) / 1000) + "s";
      const num = (v) => (typeof v === "number" ? v
        : (typeof v === "string" && v !== "" && !isNaN(Number(v)))
            ? Number(v) : null);
      const aS = num(args.workAreaStart), aD = num(args.workAreaDuration),
            aE = num(args.workAreaEnd);
      if (args.workArea !== undefined || aS !== null || aD !== null ||
          aE !== null) {
        let start, dur;
        if (args.workArea !== undefined) {
          if (String(args.workArea).toLowerCase() !== "comp") {
            return { __err: "'workArea' takes 'comp' - reset the work area " +
              "to the whole comp. Got '" + args.workArea + "'. For a " +
              "sub-range pass workAreaStart with workAreaDuration or " +
              "workAreaEnd, in seconds." };
          }
          start = 0; dur = c.duration;
        } else {
          if (aD !== null && aE !== null) {
            return { __err: "Pass workAreaDuration OR workAreaEnd, not " +
              "both - they say the same thing two ways." };
          }
          start = aS === null ? c.waStart : aS;
          dur = aE !== null ? aE - start : (aD !== null ? aD : c.waDur);
        }
        const rawStart = start, rawDur = dur;
        start = snap(start); dur = snap(dur);
        let trimmed = 0;
        if (aD === null && aE === null && args.workArea === undefined &&
            start + dur > c.duration) {
          trimmed = dur;
          dur = snap(c.duration - start);
        }
        if (start < 0) {
          return { __err: "A work area cannot start before 0 - got " +
            secs(rawStart) + "." };
        }
        if (start > c.duration - fd + 0.0001) {
          return { __err: "Comp '" + nm + "' is " + secs(c.duration) +
            " long, so its last frame starts at " + secs(c.duration - fd) +
            " - a work area cannot start at " + secs(rawStart) + "." };
        }
        if (dur <= 0 || dur < fd - 0.0001) {
          return { __err: "A work area of " + secs(rawDur) + " holds no " +
            "frame - the shortest one is " + secs(fd) + " (one frame)." };
        }
        if (start + dur > c.duration + 0.0001) {
          return { __err: "A work area of " + secs(rawDur) + " starting at " +
            secs(start) + " would end at " + secs(start + dur) + ", past " +
            "the end of comp '" + nm + "' (" + secs(c.duration) + "). The " +
            "longest that fits from there is " + secs(c.duration - start) +
            "." };
        }
        c.waStart = start; c.waDur = dur;
        changed.push("workArea");
        if (Math.abs(start - rawStart) > 0.000001) {
          notes.push("The work area start snapped to the frame grid: " +
            secs(rawStart) + " -> " + secs(start) + " (frame " +
            Math.round(start / fd) + ").");
        }
        if (!trimmed && Math.abs(dur - rawDur) > 0.000001) {
          notes.push("The work area duration snapped to the frame grid.");
        }
        if (trimmed) {
          notes.push("Moving the start left only " + secs(dur) +
            " before the comp ends, so the work area is shorter than the " +
            secs(trimmed) + " it was.");
        }
      }
      if (args.resolution !== undefined) {
        const NAMED = { full: 1, half: 2, third: 3, quarter: 4 };
        let pair = null;
        if (Array.isArray(args.resolution)) {
          if (args.resolution.length !== 2) {
            return { __err: "'resolution' as an array needs exactly two " +
              "values, [horizontal, vertical]." };
          }
          pair = [Number(args.resolution[0]), Number(args.resolution[1])];
        } else if (num(args.resolution) !== null) {
          pair = [num(args.resolution), num(args.resolution)];
        } else if (NAMED[String(args.resolution).toLowerCase()]) {
          const n = NAMED[String(args.resolution).toLowerCase()];
          pair = [n, n];
        } else {
          return { __err: "Unknown resolution '" + args.resolution +
            "'. Named resolutions: 'full' (1), 'half' (2), 'third' (3), " +
            "'quarter' (4) - or pass a whole-number downsample factor, or " +
            "a [horizontal, vertical] pair." };
        }
        for (const v of pair) {
          if (!(v >= 1) || !(v <= 99) || Math.floor(v) !== v) {
            return { __err: "A resolution factor is a whole number from 1 " +
              "(full, every pixel) to 99 - got " + v + "." };
          }
        }
        c.rf = pair;
        changed.push("resolution");
      }
      if (!changed.length) {
        return { __err: "set_comp_setting was given nothing to change. It " +
          "sets: duration, frameRate, width, height, bgColor, " +
          "workAreaStart / workAreaDuration / workAreaEnd and resolution." };
      }
      const out = { name: nm, width: c.width, height: c.height,
                    duration: c.duration, frameRate: c.frameRate,
                    bgColor: c.bg || [0, 0, 0],
                    workAreaStart: c.waStart, workAreaDuration: c.waDur,
                    workArea: secs(c.waStart) + "-" +
                              secs(c.waStart + c.waDur),
                    resolution: compResolutionLabel(c),
                    changed: changed.join(", ") };
      if (notes.length) out.note = notes.join(" ");
      return out;
    }
    // Modelled from AE 2026 (probe 2026-08-29): AE names the copy itself
    // ("X" -> "X 2"), puts it in the SOURCE'S folder, shares its layers'
    // sources with the original, copies expressions verbatim, and accepts
    // both a blank name and one another item already holds.
    case "duplicate_comp": {
      const src = (args && args.comp) || "";
      if (createdComps.indexOf(src) === -1) {
        return { __err: "Comp not found: " + src +
                 ". Existing comps: " + createdComps.join(", ") };
      }
      const taken = (n) => createdComps.indexOf(n) !== -1 || !!folders[n] ||
                           cvSolids.indexOf(n) !== -1;
      const nextFree = (base) => {
        let k = 2;
        while (taken(base + " " + k)) k++;
        return base + " " + k;
      };
      const out = { name: nextFree(src), duplicatedFrom: src,
                    folder: "Root" };
      if (args && typeof args.name !== "undefined" && args.name !== null) {
        const want = String(args.name);
        if (/^\s*$/.test(want)) {
          return { __err: "'name' was blank. AE accepts a blank comp name " +
            "and the copy then has none, which nothing can look up. Leave " +
            "'name' out to take AE's own '" + src + " 2', or pass a real " +
            "name." };
        }
        if (taken(want)) {
          out.name = nextFree(want);
          out.nameTaken = "'" + want + "' was already another project " +
            "item's name — a second one is unreachable by name, so the " +
            "copy is '" + out.name + "'. Use THIS name in every following " +
            "command" + (want === src
              ? "; '" + src + "' still means the comp it was copied FROM."
              : ".");
        } else {
          out.name = want;
        }
      }
      createdComps.push(out.name);
      out.id = 5000 + createdComps.length;
      // A duplicate carries the ORIGINAL's settings, not the defaults.
      compProps[out.name] = Object.assign({}, compProps[src]);
      if (/Cover/.test(src)) {
        const shared = cvSolids.map((n) => n + " (solid)");
        if (shared.length) {
          out.sharedSources = shared;
          out.sharedNote = "AE copied the LAYERS, not what they point at: " +
            "these items are the same in both comps, so changing one " +
            "there changes '" + src + "' too.";
        }
        const back = [];
        for (const key of Object.keys(cvExpr)) {
          if (String(cvExpr[key]).indexOf('comp("' + src + '")') === -1) {
            continue;
          }
          const bits = key.split("/");
          back.push(bits[0] + " > " + bits[1].charAt(0).toUpperCase() +
                    bits[1].slice(1));
        }
        if (back.length) {
          out.stillDrivenBySource = back;
          out.expressionNote = "These expressions in the copy name '" + src +
            "' as a string, so they still read the ORIGINAL comp. AE does " +
            "not rewrite them and expressionError stays empty. Point them " +
            "at thisComp (or at '" + out.name + "') if the copy should " +
            "stand alone.";
        }
      }
      return out;
    }
    case "rename_item": {
      const key = String((args && args.item) || "");
      if (!args || !args.name) return { __err: "'name' is required" };
      const i = createdComps.indexOf(key);
      if (i === -1) return { __err: "Project item not found: " + key };
      createdComps[i] = String(args.name);
      compProps[args.name] = compProps[key] || {};
      delete compProps[key];
      if (key === rbCompName) rbCompName = String(args.name);
      return { oldName: key, name: String(args.name) };
    }
    case "move_to_folder": {
      const dest = String((args && args.folder) || "");
      if (!folders[dest]) {
        return { __err: "Folder not found: " + dest +
                 ". Existing folders: " + Object.keys(folders).join(", ") +
                 ". Use one of those, or create_folder first." };
      }
      const refs = Array.isArray(args.items) ? args.items : [args.items];
      const moved = [], missing = [];
      for (const r of refs) {
        const nm = String(r);
        if (createdComps.indexOf(nm) === -1) { missing.push(nm); continue; }
        (compProps[nm] || (compProps[nm] = {})).folder = dest;
        moved.push(nm);
      }
      if (!moved.length) {
        return { __err: "Nothing was moved" +
          (missing.length ? " — items not found: " + missing.join(", ") : "") };
      }
      const out = { folder: dest, moved };
      if (missing.length) out.notFound = missing;
      return out;
    }
    // ---- render queue (WORKPLAN 5.5).
    //
    // A host that just answered "ok" would let every one of these steps
    // pass while the real tool wedged AE, so this canned host models the
    // measured hazards rather than the happy path: the whole-queue
    // render, the overwrite modal, and the output module forcing its own
    // extension onto the path it is handed.
    // AE's converter is silent on failure and blind to the selection, so
    // this models the TOOL's contract around it: refuse before calling,
    // isolate by muting, unique the null's name, say what it measured.
    case "audio_to_keyframes": {
      const comp = String((args && args.comp) || "");
      const range = String((args && args.range) || "comp");
      if (range !== "comp" && range !== "workArea") {
        return { __err: "'range' must be 'comp' (whole comp, the default) " +
          "or 'workArea' (AE's own behaviour - work area only)." };
      }
      const audible = auLayers.filter(l => l.audio);
      if (!auLayers.some(l => l.audio)) {
        return { __err: "No layer in '" + comp + "' has audio, and AE's " +
          "converter would silently do nothing. Layers here: " +
          auLayers.map(l => l.name).concat(auNulls).join(", ") +
          ". Import an audio or video file with import_file and add it to " +
          "the comp first." };
      }
      let only = null;
      if (args && args.layer) {
        only = auFind(args.layer);
        if (!only || !only.audio) {
          return { __err: "'" + args.layer + "' has no audio track. Layers " +
            "with audio in '" + comp + "': " +
            audible.map(l => l.name).join(", ") +
            ". Omit 'layer' to measure the whole comp mix." };
        }
      }
      const heard = only ? 1 : audible.length;
      // AE's converter reads the WORK AREA, not the comp: the default
      // widens it and puts it back, range:'workArea' leaves it alone.
      const acp = compProps[comp] ||
        { duration: 3, frameRate: 24, waStart: 0, waDur: 3 };
      const auPartial = acp.waStart > 0.0000001 ||
                        acp.waDur < acp.duration - 0.0000001;
      const auStart = (range === "workArea" && auPartial) ? acp.waStart : 0;
      const auEnd = (range === "workArea" && auPartial)
        ? acp.waStart + acp.waDur : acp.duration;
      const auKeys = Math.round((auEnd - auStart) * acp.frameRate) + 1;
      const wanted = (args && args.name) ? String(args.name)
                                         : "Audio Amplitude";
      const name = auUnique(wanted);
      auNulls.push(name);
      // AE's converter leaves a solid source behind too, and it never
      // uniques THAT name: the real project holds 168 items all called
      // "Audio Amplitude".
      leakSolidSource("Audio Amplitude");
      const out = { layer: name, index: 1, controlLayer: name,
        controlEffects: ["Left Channel", "Right Channel", "Both Channels"],
        keyframes: auKeys, rangeStart: auStart, rangeEnd: auEnd,
        peak: auPeak(heard),
        measured: only ? only.name : "whole comp mix",
        next: "Drive anything with link_property {layer: <target>, " +
              "property: <prop>, controlLayer: '" + name + "', " +
              "controlEffect: 'Both Channels', scale: <n>}." };
      if (name !== wanted) {
        out.nameTaken = "'" + wanted + "' was already a layer in this comp " +
          "- this one is '" + name + "'. Use THIS name from here on.";
      }
      if (auPartial && range === "comp") {
        out.workArea = "The work area covered " + acp.waStart.toFixed(3) +
          "s-" + (acp.waStart + acp.waDur).toFixed(3) + "s and AE only " +
          "converts inside it, so it was widened to the whole comp and put " +
          "back. Pass range: 'workArea' to keep AE's own behaviour.";
      } else if (auPartial && range === "workArea") {
        out.workArea = "Keyframes cover the WORK AREA only (" +
          acp.waStart.toFixed(3) + "s-" +
          (acp.waStart + acp.waDur).toFixed(3) + "s), as asked.";
      }
      if (only && audible.length > 1) {
        out.isolated = "AE's converter always reads the whole comp mix, so " +
          audible.filter(l => l !== only).map(l => l.name).join(", ") +
          " was muted for the conversion and un-muted again.";
      }
      return out;
    }
    // --- Essential Graphics (WORKPLAN 5.9) ---------------------------
    case "expose_property": {
      const comp = String((args && args.comp) || "");
      const layer = String((args && args.layer) || "");
      const spec = String((args && args.property) || "");
      const label = (args && args.label) ? String(args.label) : "";
      const list = mgCtrl[comp] || (mgCtrl[comp] = []);
      const from = mgFrom[comp] || (mgFrom[comp] = {});
      // A GROUP always answers canAdd = false, so the useful answer is
      // which leaf to name instead.
      if (/^(transform|contents|effects|masks|text)$/i.test(spec)) {
        return { __err: "'" + spec + "' is a GROUP, and Essential " +
          "Graphics takes single properties, not groups - " +
          "list_properties {layer: \"" + layer + "\", path: \"" + spec +
          "\"} shows the ones inside. (An EFFECT row is a group too.)" };
      }
      // Already a controller: AE refuses a second copy, and answers
      // `undefined` rather than false.
      if (from[layer + "|" + spec.toLowerCase()]) {
        return { __err: "After Effects will not expose '" + spec +
          "' on '" + layer + "' in '" + comp + "'. Measured reasons, in " +
          "the order they happen: it is ALREADY a controller (AE refuses " +
          "a second copy); it is a kind Essential Graphics does not take " +
          "(a Layer Control is the one measured); or it belongs to a " +
          "layer INSIDE a precomp of this comp. Controllers on '" + comp +
          "' now (newest first): " + (list.join(", ") || "(none)") + "." };
      }
      // AE's default is the LAYER's name for a transform or text
      // property, never the property's own.
      const got = label || (layer + " " + spec.charAt(0).toUpperCase() +
        spec.slice(1));
      const dupes = list.filter(n => n === got).length;
      list.unshift(got);
      from[layer + "|" + spec.toLowerCase()] = got;
      const out = { comp, layer, property: spec, controller: got,
        controllerCount: list.length, templateName: "Untitled" };
      if (dupes > 0) {
        out.warning = dupes + " other controller(s) on '" + comp +
          "' are ALSO called \"" + got + "\" - AE accepts duplicate " +
          "names and an editor cannot tell them apart. Pass {label: " +
          "\"...\"} to name this one.";
      } else if (!label) {
        out.note = "No label given, so AE named the controller \"" + got +
          "\" - its default is the LAYER's name for a transform or text " +
          "property and the EFFECT's name for an effect parameter, " +
          "never the property's own.";
      }
      out.next = "export_mogrt {comp: \"" + comp + "\", folder: \"...\"} " +
        "writes the template once every control is exposed. There is no " +
        "rename and no remove: AE ships neither, and the indices " +
        "renumber on every add (1 is the newest).";
      return out;
    }
    case "export_mogrt": {
      const comp = String((args && args.comp) || "");
      let raw = (args && (args.folder || args.path || args.output)) || "";
      if (!raw) {
        return { __err: "'folder' is required - the ABSOLUTE folder to " +
          "write the .mogrt into, e.g. \"C:/templates\". The FILE name " +
          "comes from the template name, not from this path." };
      }
      raw = String(raw).replace(/[\\/]+$/, "");
      if (!/^[a-zA-Z]:[\\/]/.test(raw) && raw.indexOf("\\\\") !== 0) {
        return { __err: "'folder' must be an ABSOLUTE path (got \"" +
          raw + "\"). AE resolves a relative path against its own " +
          "working directory, not the project." };
      }
      if (!rqFolderExists(raw)) {
        return { __err: "Folder does not exist: " + rqNorm(raw) +
          ". Deepest folder that does exist: " + rqNearestFolder(raw) +
          ". AE would CREATE this folder and then fail into it, leaving " +
          "an empty directory behind, so it is refused here instead." };
      }
      const tpl = (args && args.name) ? String(args.name) : comp;
      const bad = [];
      for (const ch of "\\/:*?\"<>|") {
        if (tpl.indexOf(ch) !== -1 && bad.indexOf(ch) === -1) bad.push(ch);
      }
      if (bad.length) {
        return { __err: "Template name \"" + tpl + "\" contains " +
          bad.join(" ") + ", which Windows will not put in a file name. " +
          "AE does not refuse this - it works for 3.7 seconds, returns " +
          "false and writes nothing. Pass {name: \"...\"} without those " +
          "characters." };
      }
      if (!(mgCtrl[comp] || []).length) {
        return { __err: "'" + comp + "' has no Essential Graphics " +
          "controllers, and AE will not export a template without one " +
          "(it returns false and writes nothing). Use expose_property " +
          "{layer: \"...\", property: \"...\", label: \"...\"} first - " +
          "that is what an editor gets to change." };
      }
      // And the wall the suite stops at. By the time these steps run the
      // suite has created a dozen comps, so the open project is ALWAYS
      // dirty; there is no path from here to a real export that does not
      // save the user's project, which the suite may never do.
      return { __err: "The project has unsaved changes, and AE exports " +
        "only from a CLEAN one - a dirty project returns false in about " +
        "390 ms and writes nothing, with no message at all. Pass {save: " +
        "true} to save \"C:\\\\Users\\\\probe\\\\Documents\\\\scratch.aep\" " +
        "first, or save it in After Effects and ask again. (Exposing a " +
        "property is itself a change, so this is the normal state right " +
        "after expose_property.)" };
    }
    case "list_render_templates": {
      return { renderSettings: RQ_RS_TEMPLATES.slice(),
               outputModules: RQ_OM_TEMPLATES.slice(),
               tempFolder: "C:\\Users\\probe\\AppData\\Local\\Temp",
               note: "Pass one of outputModules as {template} and one of " +
                 "renderSettings as {renderSettings} to render_comp. " +
                 "Names starting with '_HIDDEN' are AE internals -- do " +
                 "not offer them. render_comp needs an ABSOLUTE output " +
                 "path." };
    }
    case "add_to_render_queue": {
      const comp = String((args && args.comp) || "");
      const already = rqItems.filter(it => it.comp === comp).length;
      let path = (args && args.outputPath) ? String(args.outputPath) : "";
      if (path && !rqFolderExists(rqDirOf(path))) {
        return { __err: "Output folder does not exist: " + rqDirOf(path) +
          ". Create it, or queue without an outputPath and set the " +
          "destination in AE." };
      }
      const asked = path;
      // No outputPath -> AE reuses the last render's folder, which has
      // nothing to do with this project.
      path = rqForceExt(path || (RQ_INHERITED + "\\" + comp + ".mp4"),
                        RQ_DEFAULT_OM);
      rqItems.push({ comp, file: path, render: true, status: "QUEUED" });
      const out = { comp, queuePosition: rqItems.length, status: "QUEUED",
                    output: path };
      if (!asked) {
        out.note = "No outputPath given, so AE reused the last render's " +
          "settings and folder - this will write to \"" + path +
          "\". Pass {outputPath} to choose.";
      } else if (rqExtOf(asked) && rqExtOf(asked) !== rqExtOf(path)) {
        out.note = "The current output module writes ." + rqExtOf(path) +
          ", so AE changed the destination to \"" + path + "\".";
      }
      if (already) {
        out.warning = comp + " was already in the render queue " + already +
          " time(s); this adds another, and both would render.";
      }
      return out;
    }
    // FACT: a comp with NO audio layer STILL renders a full, valid,
    // audio-only AIFF -- DONE, 772 674 bytes, no warning -- and silence
    // transcribes as the word "You". So this canned host renders happily
    // either way, and the refusal has to come from the tool.
    case "render_comp_audio": {
      const audible = capAudio.filter(l => l.audio);
      if (!capAudio.length || !audible.length) {
        const have = capAudio.map(l => l.name).join(", ") || "(none)";
        return { __err: !capAudio.length || capAudio.every(l => !l.audio)
          ? "No layer in '" + (args && args.comp) + "' has audio. AE would " +
            "still render a full file of SILENCE and report DONE, and a " +
            "transcriber hears the word \"You\" in silence. Layers here: " +
            have + ". Import an audio or video file with import_file and " +
            "add it to the comp first."
          : "Every audio layer is muted, so the render would be silence." };
      }
      const audioOm = RQ_OM_TEMPLATES.filter(
        n => !/^_HIDDEN/.test(n) && /(^|[^a-z])(wav|aiff?|mp3)([^a-z]|$)/i
                                      .test(n))[0];
      if (!audioOm) {
        return { __err: "No audio-only output-module template is " +
          "installed. Installed: " + RQ_OM_TEMPLATES.join(", ") + "." };
      }
      const inner = cannedOk("render_comp",
        { comp: args && args.comp, output: args && args.output,
          template: audioOm, overwrite: args && args.overwrite });
      if (inner && inner.__err) return inner;
      inner.audioLayers = audible.map(l => l.name).join(", ");
      return inner;
    }
    case "add_captions": {
      const as = String((args && args.as) || "text").toLowerCase();
      if (as !== "text" && as !== "markers") {
        return { __err: "'as' must be 'text' (a text layer per caption, " +
          "the default) or 'markers' — got " + (args && args.as) };
      }
      if (as === "text" && args && args.layer) {
        return { __err: "'layer' only applies to {as: 'markers'} — it is " +
          "the layer the markers land on. Drop it, or pass " +
          "{as: 'markers'}." };
      }
      const segs = (args && args.segments) || [];
      if (!segs.length) {
        return { __err: "'segments' is required: an array of {start, end, " +
          "text} in seconds." };
      }
      // Every segment is validated BEFORE anything is created: half a
      // transcript on the timeline plus an error is worse than an error.
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i] || {};
        const where = "segment " + (i + 1);
        if (typeof sg.start !== "number" || typeof sg.end !== "number") {
          return { __err: where + ": 'start' must be a number of seconds" };
        }
        if (sg.start < 0) {
          return { __err: where + ": 'start' is " + sg.start + "s. A " +
            "caption before the start of the comp is never visible." };
        }
        if (sg.end <= sg.start) {
          return { __err: where + ": end (" + sg.end + "s) is not after " +
            "start (" + sg.start + "s). AE accepts that silently." };
        }
        if (typeof sg.text !== "string" || !sg.text.replace(/\s/g, "")) {
          return { __err: where + ": 'text' must be a non-empty string" };
        }
      }
      const compName = String((args && args.comp) || "");
      const dur = (compProps[compName] || { duration: 10 }).duration;
      let past = 0;
      for (const sg of segs) if (sg.end > dur + 0.0001) past++;
      if (as === "markers") {
        const before = capMarks.length;
        for (const sg of segs) {
          const at = capMarks.filter(m => m.time === sg.start)[0];
          if (at) { at.comment = sg.text; at.duration = sg.end - sg.start; }
          else capMarks.push({ time: sg.start, comment: sg.text,
                               duration: sg.end - sg.start });
        }
        const added = capMarks.length - before;
        const outM = { comp: compName, as: "markers",
                       target: args && args.layer ? "layer " + args.layer
                                                  : "comp " + compName,
                       captions: segs.length, markersAdded: added,
                       markers: capMarks.length };
        if (added < segs.length) {
          outM.collapsed = (segs.length - added) + " caption(s) landed on " +
            "a time that already had a marker and REPLACED it.";
        }
        return outM;
      }
      const base = (args && args.name) || "Caption";
      const built = [];
      for (let i = 0; i < segs.length; i++) {
        let nm = base + " " + (i + 1), k = 2;
        while (capRows.some(r => r.name === nm)) nm = base + " " + (i + 1) +
          " " + (k++);
        // inPoint FIRST, then outPoint: the other order leaves the layer
        // the wrong length, which is what the suite step reads.
        capRows.push({ name: nm, inPoint: capQuant(segs[i].start),
                       outPoint: capQuant(segs[i].end) });
        built.push(nm);
      }
      const out = { comp: compName, as: "text", captions: built.length,
                    layers: built.slice(0, 12), justification: "center" };
      if (past) {
        out.note = past + " caption(s) end past '" + compName + "' (" +
          dur + "s) — they exist but run off the timeline.";
      }
      return out;
    }
    case "render_comp": {
      const comp = String((args && args.comp) || "");
      const raw = (args && args.output) ? String(args.output) : "";
      if (!raw) {
        return { __err: "'output' is required - an ABSOLUTE file path to " +
          "render to, e.g. \"C:/renders/shot.avi\"." };
      }
      if (!/^[a-zA-Z]:[\\/]/.test(raw) && raw.indexOf("\\\\") !== 0) {
        return { __err: "'output' must be an ABSOLUTE path (got \"" + raw +
          "\"). AE resolves a relative path against its own working " +
          "directory, not the project." };
      }
      const dir = rqDirOf(raw);
      if (!rqFolderExists(dir)) {
        return { __err: "Output folder does not exist: " + dir +
          ". Deepest folder that does exist: " + rqNearestFolder(dir) +
          ". Create the folder, or render somewhere that exists." };
      }
      let om = RQ_DEFAULT_OM;
      if (args && args.template) {
        om = RQ_OM_TEMPLATES.filter(
          n => n.toLowerCase() === String(args.template).toLowerCase())[0];
        if (!om) {
          return { __err: "No output-module template named '" +
            args.template + "'. Installed: " +
            RQ_OM_TEMPLATES.join(", ") + "." };
        }
      }
      let rs = "";
      if (args && args.renderSettings) {
        rs = RQ_RS_TEMPLATES.filter(
          n => n.toLowerCase() ===
               String(args.renderSettings).toLowerCase())[0];
        if (!rs) {
          return { __err: "No render-settings template named '" +
            args.renderSettings + "'. Installed: " +
            RQ_RS_TEMPLATES.join(", ") + "." };
        }
      }
      const path = rqForceExt(raw, om);
      const overwrite = args && (args.overwrite === true ||
                                 args.overwrite === "true");
      if (rqDisk[path.toLowerCase()] !== undefined && !overwrite) {
        return { __err: "Output file already exists: " + path + " (" +
          rqDisk[path.toLowerCase()] + " bytes). Pass {overwrite: true} " +
          "to replace it, or choose another path. (Rendering onto an " +
          "existing file without this raises a modal dialog that blocks " +
          "After Effects.)" };
      }
      // The whole-queue hazard: everything already queued is held back,
      // and its flag put back afterwards. A tool that forgot would render
      // the user's items, and the count below would be wrong.
      const held = rqItems.filter(it => it.status === "QUEUED");
      const frames = (args && args.frames) ? Number(args.frames)
        : ((args && args.durationSeconds)
            ? Math.round(Number(args.durationSeconds) * 24) : 24);
      // Render Settings Resolution. AE takes the four NAMES and nothing
      // else, and writes ceil(dim / factor) on each axis -- measured
      // 2026-08-30, and 641x361 at Half really is 321x181.
      const RES_F = { full: 1, half: 2, third: 3, quarter: 4 };
      let resName = "Full", resF = 1;
      if (args && args.resolution !== undefined &&
          args.resolution !== null && args.resolution !== "") {
        let wr = String(args.resolution).trim().toLowerCase();
        const mm = /^1\s*\/\s*([1-4])$/.exec(wr);
        if (mm) wr = { "1": "full", "2": "half", "3": "third",
                       "4": "quarter" }[mm[1]];
        if (wr === "1" || wr === "2" || wr === "3" || wr === "4") {
          wr = ["full", "half", "third", "quarter"][Number(wr) - 1];
        }
        if (!Object.prototype.hasOwnProperty.call(RES_F, wr)) {
          return { __err: "'resolution' must be one of: Full (1/1), " +
            "Half (1/2), Third (1/3), Quarter (1/4) - got \"" +
            String(args.resolution) + "\". AE's Render Settings only " +
            "offer these four; there is no arbitrary percentage." };
        }
        resF = RES_F[wr];
        resName = wr.charAt(0).toUpperCase() + wr.slice(1);
      }
      const cp = compProps[comp] || { width: 1280, height: 720 };
      const rw = Math.ceil(cp.width / resF), rh = Math.ceil(cp.height / resF);
      rqDisk[path.toLowerCase()] =
        Math.round(64840 * Math.max(1, frames) / (resF * resF));
      const out = { comp, output: path, status: "DONE",
                    bytes: rqDisk[path.toLowerCase()],
                    seconds: 0.2, outputModule: om,
                    resolution: resName,
                    renderedSize: rw + "x" + rh + (resF > 1
                      ? " (comp is " + cp.width + "x" + cp.height +
                        ", rendered at " + resName + ")" : ""),
                    renderSettings: rs || "(AE default)",
                    timeSpan: "start 0s, " + Math.max(1, frames) +
                      " frame(s) at 24 fps" };
      if (rqExtOf(raw) && rqExtOf(raw) !== rqExtOf(path)) {
        out.note = "The '" + om + "' output module writes ." +
          rqExtOf(path) + ", so the file is \"" + path + "\", not ." +
          rqExtOf(raw) + ".";
      }
      if (held.length) {
        out.heldBack = held.length + " render-queue item(s) the user had " +
          "already queued were held back and left QUEUED.";
      }
      return out;
    }
    // ---- the frame round-trip (WORKPLAN 5.8). Faithful to what real
    // AE does SILENTLY: PNG bytes into whatever name it is handed, an
    // overwrite with no dialog, an out-of-range time clamped to a blank
    // frame, and a second project item for a path it already holds.
    case "import_file": {
      const rawF = (args && args.path) ? String(args.path) : "";
      if (!rawF) return { __err: "'path' is required" };
      const pF = rqNorm(rawF);
      if (rqDisk[pF.toLowerCase()] === undefined) {
        return { __err: "File not found: " + pF };
      }
      frItems[pF.toLowerCase()] = true;
      // Real AE has MEASURED the file by the time importFile returns, and
      // a still has no duration and no frame rate at all - reporting them
      // as 0 would let "no duration" read as "0 seconds" downstream.
      const dimF = frPngs[pF.toLowerCase()] || { width: 320, height: 240 };
      return { name: pF.slice(pF.lastIndexOf("\\") + 1), id: 9100,
               width: dimF.width, height: dimF.height };
    }
    case "snapshot_frame": {
      const comp = String((args && args.comp) || "");
      const props = compProps[comp] ||
        { width: 1280, height: 720, duration: 8, frameRate: 30 };
      const raw = (args && args.path) ? String(args.path) : "";
      if (!raw) {
        return { __err: "'path' is required - an ABSOLUTE .png path to " +
          "write the frame to, e.g. \"C:/frames/shot.png\"." };
      }
      if (!/^[a-zA-Z]:[\\/]/.test(raw) && raw.indexOf("\\\\") !== 0) {
        return { __err: "'path' must be an ABSOLUTE path (got \"" + raw +
          "\"). AE resolves a relative path against its own working " +
          "directory, not the project." };
      }
      const png = rqExtOf(raw) === "png" ? rqNorm(raw)
        : (rqExtOf(raw) ? rqNorm(raw).replace(/\.[^.\\]*$/, ".png")
                        : rqNorm(raw) + ".png");
      const dir = rqDirOf(png);
      if (!rqFolderExists(dir)) {
        return { __err: "Output folder does not exist: " + dir +
          ". Deepest folder that does exist: " + rqNearestFolder(dir) +
          ". Create the folder, or write somewhere that exists." };
      }
      const overwrite = args && (args.overwrite === true ||
                                 args.overwrite === "true");
      if (rqDisk[png.toLowerCase()] !== undefined && !overwrite) {
        return { __err: "Output file already exists: " + png + " (" +
          rqDisk[png.toLowerCase()] + " bytes). Pass {overwrite: true} to " +
          "replace it, or choose another path. (saveFrameToPng overwrites " +
          "silently - no dialog, and no undo.)" };
      }
      const gaveTime = args && args.time !== undefined &&
                       args.time !== null && args.time !== "";
      const t = gaveTime ? Number(args.time) : 0;
      if (isNaN(t)) {
        return { __err: "'time' must be a number of seconds (got \"" +
          args.time + "\")." };
      }
      if (t < 0 || t > props.duration) {
        return { __err: "'time' " + t + "s is outside '" + comp + "' (0 to " +
          props.duration + "s). AE does not refuse this - it CLAMPS to the " +
          "nearest end and writes a BLANK frame, so it is refused here " +
          "instead." };
      }
      const res = (args && args.resolution)
        ? String(args.resolution).toLowerCase() : "full";
      if (res !== "full" && res !== "comp") {
        return { __err: "'resolution' must be 'full' (default - the comp's " +
          "real pixel size) or 'comp' (whatever downsample the comp is set " +
          "to). Got: " + args.resolution };
      }
      const srf = props.rf || [1, 1];
      const shrunk = res === "comp" && (srf[0] !== 1 || srf[1] !== 1);
      const pngW = shrunk ? Math.round(props.width / srf[0]) : props.width;
      const pngH = shrunk ? Math.round(props.height / srf[1]) : props.height;
      let frame = Math.round(t * props.frameRate);
      const lastFrame = Math.round(props.duration * props.frameRate) - 1;
      if (frame > lastFrame) frame = lastFrame;
      rqDisk[png.toLowerCase()] = 644;
      frPngs[png.toLowerCase()] = { width: pngW, height: pngH };
      const out = { comp: comp, path: png, time: frame / props.frameRate,
                    frame: frame, bytes: 644,
                    width: pngW, height: pngH,
                    compSize: props.width + "x" + props.height,
                    next: "import_as_layer {path: \"" +
                      png.split("\\").join("/") +
                      "\"} places this PNG back into a comp as a layer." };
      if (rqExtOf(raw) !== "png") {
        out.pathNote = "AE writes PNG bytes whatever the file is called, " +
          "so the path was corrected to \"" + png + "\".";
      }
      if (!gaveTime) {
        out.timeNote = "No 'time' given, so the comp's current time (" +
          out.time + "s, frame " + frame + ") was used.";
      }
      if (res === "full" && (srf[0] !== 1 || srf[1] !== 1)) {
        out.resolutionNote = "'" + comp + "' was set to resolution 1/" +
          srf[0] + " - it was snapshotted at FULL size and put back the " +
          "way it was. Pass {resolution: \"comp\"} to keep the downsample.";
      }
      if (shrunk) {
        out.warning = "The PNG is " + pngW + "x" + pngH + ", not the " +
          "comp's " + props.width + "x" + props.height + " - the comp is " +
          "downsampled and {resolution: \"comp\"} kept it.";
      }
      return out;
    }
    case "import_as_layer": {
      const raw = (args && args.path) ? String(args.path) : "";
      if (!raw) {
        return { __err: "'path' is required - the ABSOLUTE path of an " +
          "image, video or audio file to place in a comp." };
      }
      if (!/^[a-zA-Z]:[\\/]/.test(raw) && raw.indexOf("\\\\") !== 0) {
        return { __err: "'path' must be ABSOLUTE (got \"" + raw + "\"). " +
          "AE resolves a relative path against its own working directory, " +
          "not the project folder." };
      }
      const p2 = rqNorm(raw);
      if (rqDisk[p2.toLowerCase()] === undefined) {
        return { __err: "File not found: " + p2 +
          ". Check the path - nothing was imported." };
      }
      let fit = (args && args.fit) ? String(args.fit).toLowerCase() : "fit";
      if (fit === "center") fit = "none";
      if (["fit", "fill", "stretch", "width", "height",
           "none"].indexOf(fit) === -1) {
        return { __err: "'fit' must be one of: fit (contain, default), " +
          "fill (cover, crops), stretch (fills exactly, distorts - what " +
          "AE's own \"Fit to Comp\" does), width, height, none (100%; " +
          "'center' means the same). Got: " + args.fit };
      }
      const comp2 = String((args && args.comp) || "");
      const props2 = compProps[comp2] ||
        { width: 1280, height: 720, duration: 8, frameRate: 30 };
      const src = frPngs[p2.toLowerCase()] || { width: 320, height: 240 };
      const fileName = p2.slice(p2.lastIndexOf("\\") + 1);
      const name = (args && args.name) ? String(args.name) : fileName;
      const reused = frItems[p2.toLowerCase()] === true;
      frItems[p2.toLowerCase()] = true;
      const rx = 100 * props2.width / src.width;
      const ry = 100 * props2.height / src.height;
      let sx = null, sy = null;
      if (fit === "stretch") { sx = rx; sy = ry; }
      else if (fit === "width") { sx = rx; sy = rx; }
      else if (fit === "height") { sx = ry; sy = ry; }
      else if (fit === "fill") { sx = Math.max(rx, ry); sy = sx; }
      else if (fit === "fit") { sx = Math.min(rx, ry); sy = sx; }
      const out2 = { comp: comp2, layer: name, index: 1, source: fileName,
                     sourceSize: src.width + "x" + src.height,
                     compSize: props2.width + "x" + props2.height,
                     fit: fit, inPoint: 0, outPoint: props2.duration };
      if (sx !== null) {
        out2.scale = [Math.round(sx * 1000) / 1000,
                      Math.round(sy * 1000) / 1000];
        frScales[comp2 + "|" + name] = [out2.scale[0], out2.scale[1], 100];
      }
      if (reused) {
        out2.reusedExisting = true;
        out2.reuseNote = "'" + fileName + "' was already in the project " +
          "for that file, so it was reused and RELOADED from disk (any " +
          "layer already using it now shows the current file) instead of " +
          "imported a second time.";
      }
      out2.stillNote = "A still spans the whole comp (0s to " +
        props2.duration + "s). set_layer_timing changes that.";
      frLayers[comp2] = (frLayers[comp2] || []);
      frLayers[comp2].unshift(name);
      return out2;
    }
    default: return { done: true };
  }
}

function cannedResult(tool, args) {
  if (!documented(tool)) return { ok: false, error: "Unknown tool: " + tool };
  const d = cannedOk(tool, args);
  return d && d.__err ? { ok: false, error: d.__err } : { ok: true, data: d };
}

// Which tools mutate, read out of hostscript.jsx rather than copied, so
// the canned host cannot drift from the real rollback trigger.
const MUTATING_NAMES = (function () {
  const m = /var AELL_MUTATING = \{([\s\S]*?)\};/.exec(hostSrc);
  if (!m) throw new Error("hostscript.jsx no longer defines AELL_MUTATING");
  return new Set((m[1].match(/([A-Za-z0-9_]+)\s*:\s*true/g) || [])
    .map(s => s.split(":")[0].trim()));
})();
assert(MUTATING_NAMES.has("add_solid") && !MUTATING_NAMES.has("get_property"),
       "the mutating list parses out of hostscript (" +
       MUTATING_NAMES.size + " tools)");

// Many tools in ONE host call. Faithful to AELL_callBatch on three points
// the suite measures: one row per command, in order; a failing row does
// NOT stop the commands behind it; and an ARMED round that both succeeded
// and failed at mutating comes back rolled back, every row rewritten.
const batchCalls = [];
function cannedBatch(cmds, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  opts = opts || {};
  batchCalls.push(cmds.length);
  // Snapshot what an Undo would restore, so a rolled-back round really
  // does put the canned project back rather than only SAYING it did.
  //
  // PROJECT ITEMS are in here as of 2026-08-29, when the question "does
  // one Undo reach them" was finally measured in real AE — it does, for
  // creation, deletion, duplication, folder moves and renames alike. A
  // canned host that only rewound layers let a step assert an item-level
  // rollback that never happened.
  const rbBefore = rbLayers.slice();
  const itemsBefore = {
    comps: createdComps.slice(),
    createCount,
    unique: scUnique.slice(),
    rbName: rbCompName,
    props: (function () {
      const o = {};
      for (const k in compProps) o[k] = Object.assign({}, compProps[k]);
      return o;
    })()
  };
  const rows = cmds.map(c => cannedResult(c.tool, c.args || {}));
  let okMut = 0, badMut = 0, firstError = "";
  cmds.forEach((c, i) => {
    if (!MUTATING_NAMES.has(c.tool)) return;
    if (rows[i].ok) { okMut++; return; }
    badMut++;
    if (!firstError) firstError = c.tool + ": " + rows[i].error;
  });
  if (opts.rollback && okMut && badMut) {
    rbLayers = rbBefore;
    createdComps.length = 0;
    Array.prototype.push.apply(createdComps, itemsBefore.comps);
    createCount = itemsBefore.createCount;
    scUnique = itemsBefore.unique;
    rbCompName = itemsBefore.rbName;
    for (const k in compProps) delete compProps[k];
    Object.assign(compProps, itemsBefore.props);
    const note = "ROLLED BACK: a command in this round failed (" +
      firstError + ") after others had already changed the project.";
    cmds.forEach((c, i) => {
      if (MUTATING_NAMES.has(c.tool)) {
        rows[i] = { ok: false, rolledBack: true,
                    error: (rows[i].ok ? "" : rows[i].error + " — ") +
                           (i === 0 ? note : "Rolled back with the round.") };
      } else {
        rows[i].rolledBack = true;
      }
    });
  }
  cb(rows);
}

// 2. happy path: all steps pass, cleanup (delete_item) runs last
const calls = [];
SelfTest.run({
  callHostTool(tool, args, cb) {
    calls.push(tool);
    assert(args && typeof args === "object",
           "args object for " + tool);
    cb(cannedResult(tool, args));
  },
  callHostBatch: cannedBatch,
  onLine() {},
  onDone(res) {
    assert(res.passed === res.total,
           "happy path: " + res.passed + "/" + res.total + " passed" +
           (res.passed === res.total ? "" : " -- " + res.text));
    // The suite used to END on a delete; now it ends on a verification
    // READ that proves nothing of the suite's remains. The deletes come
    // right before it.
    assert(calls[calls.length - 1] === "get_project_info",
           "the final call verifies the project is clean (got " +
           calls[calls.length - 1] + ")");
    assert(calls.lastIndexOf("delete_item") > calls.length - 30,
           "the delete cleanup runs at the end, just before verification");
    // The leak this cleanup was rebuilt for: the sources AE names for
    // itself ("Null <n>", "Audio Amplitude") are gone, and the user's
    // own items of the SAME NAMES are untouched. Both halves, or the
    // fix is either useless or destructive.
    const leftBehind = solidSources.filter((so) => so.id > 20000);
    assert(leftBehind.length === 0,
           "the run's own solid sources are all swept (left " +
           leftBehind.length + ": " +
           leftBehind.slice(0, 5).map((so) => so.name).join(", ") + ")");
    USER_DECOYS.forEach((nm) => {
      assert(solidSources.some((so) => so.name === nm && so.id < 20000),
             "the user's own '" + nm + "' survives the sweep");
    });
    assert(calls[0] === "get_project_info",
           "the run photographs the project BEFORE it creates anything " +
           "(got " + calls[0] + ")");
    assert(/Self-test: \d+\/\d+ passed/.test(res.text),
           "report carries the summary line");

    // 3. failure path: a failing tool surfaces in the report and the run
    // still completes (cleanup included)
    createCount = 0;
    camProbeReads = 0;
    ordX = {};
    ordStack = [];
    mattes = {};
    mtRig = {};
    maskKeys = {};
    mkMasks = {}; mkSizes = {};
    batchLayers = 0; batchFx = {}; batchBlur = null;
    batSolids = []; batSolidFx = {}; batSolidPos = {}; rbLayers = []; rnRenamedTo = null; scUnique = []; lights = {}; resetCoverRig(); resetWpRig(); resetPcRig(); resetTxRig(); resetShapeRig(); resetBoundsRig(); resetPresetRig(); resetRqRig(); resetAuRig(); resetFrRig(); resetCapRig(); resetMgRig();
    SelfTest.run({
      callHostTool(tool, args, cb) {
        if (tool === "grid_layout") {
          cb({ ok: false, error: "boom" });
          return;
        }
        cb(cannedResult(tool, args));
      },
      callHostBatch: cannedBatch,
      onLine() {},
      onDone(res2) {
        assert(res2.passed === res2.total - 1,
               "one failure recorded (" + res2.passed + "/" +
               res2.total + ")");
        assert(/FAIL grid rig/.test(res2.text) && /boom/.test(res2.text),
               "report names the failed step with its error");

        // 4. the inverted steps must really be inverted: a host that
        // ACCEPTS a call the suite expects to be refused has to fail, or
        // every grounded-refusal step is decorative.
        const inverted = steps.filter(st => st.expectError);
        assert(inverted.length >= 3,
               "suite carries " + inverted.length + " refusal steps");
        createCount = 0;
        camProbeReads = 0;
        ordX = {};
        ordStack = [];
        mattes = {};
        mtRig = {};
        maskKeys = {};
        mkMasks = {}; mkSizes = {};
        batchLayers = 0; batchFx = {}; batchBlur = null;
        batSolids = []; batSolidFx = {}; batSolidPos = {}; rbLayers = []; rnRenamedTo = null; scUnique = []; lights = {}; resetCoverRig(); resetWpRig(); resetPcRig(); resetTxRig(); resetShapeRig(); resetBoundsRig(); resetPresetRig(); resetRqRig(); resetAuRig(); resetFrRig(); resetCapRig(); resetMgRig();
        SelfTest.run({
          callHostTool(tool, args, cb) {
            // Never refuse anything -- the old permissive host.
            const d3 = cannedOk(tool, args);
            cb({ ok: true, data: d3 && d3.__err ? { keysSet: 2 } : d3 });
          },
          onLine() {},
          onDone(res3) {
            assert(res3.passed <= res3.total - inverted.length,
                   "a permissive host fails every refusal step (" +
                   res3.passed + "/" + res3.total + ", " +
                   inverted.length + " refusals)");
            assert(/expected a refusal/.test(res3.text),
                   "the report says the tool accepted what it must refuse");
            checkFlatStack();
          }
        });
      }
    });
  }
});

// 5. the CLI runner drives this SAME suite with a shimmed setTimeout, and
// ExtendScript's stack is small. selftest.js ends every step with
// setTimeout(step), so a shim that called straight through nested each
// step inside the last one and the suite killed itself with "Stack
// overrun" once it outgrew ~100 steps -- a failure that looks nothing
// like a failing step. scripts/ae-selftest.jsx queues instead and drains
// from the top level; this proves the queue is flat AND that the
// measurement can actually see the difference.
function checkFlatStack() {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts",
                                        "ae-selftest.jsx"), "utf8");
  assert(!/setTimeout:\s*function\s*\(fn\)\s*\{\s*fn\(\)/.test(src),
         "the CLI runner's setTimeout does not call straight through");
  assert(/pending\.push\(fn\)/.test(src) &&
         /while \(pending\.length > 0/.test(src),
         "the CLI runner queues each step and drains it from the top level");

  // Model both shims against the real step list: the queue must stay at
  // depth 1 whatever the suite length, the pass-through must not.
  const steps2 = SelfTest._buildSteps();
  let recursive = 0, flat = 0, depth = 0;
  const recurse = fn => { depth++; if (depth > recursive) recursive = depth;
                          fn(); depth--; };
  const pending = [];
  const queueUp = fn => { pending.push(fn); };
  (function model(shim, drain) {
    let i = 0;
    const step = () => { if (i++ < steps2.length) shim(step); };
    step();
    if (drain) {
      let d = 0;
      while (pending.length) {
        d++;
        if (d > flat) flat = d;
        const fn = pending.shift();
        fn();
        d--;
      }
    }
  })(queueUp, true);
  (function () {
    depth = 0;
    let i = 0;
    const step = () => { if (i++ < steps2.length) recurse(step); };
    step();
  })();
  assert(flat === 1,
         "queued steps stay one frame deep (" + flat + ")");
  assert(recursive >= steps2.length - 1,
         "pass-through nests one frame PER STEP (" + recursive + " for " +
         steps2.length + " steps) — that is the stack ExtendScript ran out " +
         "of");
  console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
}
