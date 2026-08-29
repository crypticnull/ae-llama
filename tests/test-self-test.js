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
function capLayers(compName, all, args) {
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
  const out = { name: compName, numLayers: total,
                layersShown: wanted.length, layers: wanted };
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
let camProbeReads = 0;
let textStyle = null;
// The ordering steps read back what the previous step wrote, so the canned
// host has to REMEMBER instead of answering with a constant — otherwise
// "did slot i go to layer i" is a question the stub answers for free.
let ordX = {};
let ordStack = [];
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
const parentedLayers = {}; // layer -> parent, so the resize can tell a
                           // child's inherited transform from its own
const cvExpr = {};       // "layer/prop"  -> expression
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
const inRbComp = (a) => a && /Rollback/.test(a.comp || "");
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
function shapeSeedLayer(name) {
  // add_shape_layer draws its rectangle inside a group, exactly as AE does.
  const L = { items: [] };
  const g = shapeAddItem(name, L.items, "group", "Rectangle 1");
  const r = shapeAddItem(name, g.items, "rectangle");
  r.vals.Size = [10, 10];
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
function shapeBounds(L) {
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
    g.items.forEach(it => {
      if (/^(rectangle|ellipse)$/.test(it.kind)) {
        const s = it.vals.Size || [100, 100];
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
    if (gx0 !== null) eat(gx0, gx1, gy0, gy1);
  });
  if (minX === null) return null;
  return [minX, maxX, minY, maxY];
}

function cannedOk(tool, args) {
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
        frameRate: (args && args.frameRate) || 30 };
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
      if (dryRun) {
        out.note = moves.length === 0
          ? "PREVIEW ONLY — nothing to do: no loose items at the " +
            "project root."
          : "PREVIEW ONLY — nothing was moved.";
        return out;                              // and it moves NOTHING
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
    case "link_property":
      // Same shape: the linked property now reads from the slider.
      markDriven(args && args.layer, args && args.property, 22.2);
      return { layer: args && args.layer,
               property: args && args.property };
    case "get_property": {
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
          // Both names, and the friendly alias, are one property.
          return { value: 0, matchName: "ADBE Rotate Z", numKeys: 0 };
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
      return { index: 1, name: (args && args.name) || "Null 1" };
    case "set_expression": {
      const expr = (args && args.expression) || "";
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
    case "add_mask":
      return { layer: args && args.layer,
               mask: (args && args.name) || "Mask 1",
               shape: (args && args.shape) || "rectangle" };
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
      shapeSeedLayer(nm);
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
    case "set_track_matte": return { mode: "alpha" };
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
      // The hygiene steps ask get_project_info whether a PREVIEW deleted
      // the orphaned solid, so its source has to really exist here.
      if (args && String(args.name || "").indexOf("ST HYG") === 0) {
        solidSources.push({ name: args.name, id: 950 + solidSources.length,
                            type: "footage" });
      }
      if (inBatComp(args)) batSolids.push(args.name);
      if (inRbComp(args)) rbLayers.push(args.name);
      if (inPcComp(args)) pcLayers.push(args.name);
      return { name: (args && args.name) || "ST Square" };
    case "apply_effect":
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
    case "set_transform": {
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
        ks.length = 0;
      }
      return { layers: 1, property: P, removed, remaining: ks.length };
    }
    case "apply_expression_preset": {
      const p = String((args && args.preset) || "").toLowerCase();
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
      if (args.width > 0) c.width = Math.round(args.width);
      if (args.height > 0) c.height = Math.round(args.height);
      if (args.duration > 0) c.duration = args.duration;
      if (args.frameRate > 0) c.frameRate = args.frameRate;
      return { name: nm, width: c.width, height: c.height,
               duration: c.duration, frameRate: c.frameRate };
    }
    case "duplicate_comp": {
      const src = (args && args.comp) || "";
      if (createdComps.indexOf(src) === -1) {
        return { __err: "Comp not found: " + src +
                 ". Existing comps: " + createdComps.join(", ") };
      }
      const nm = (args && args.name) || (src + " 2");
      createdComps.push(nm);
      // A duplicate carries the ORIGINAL's settings, not the defaults.
      compProps[nm] = Object.assign({}, compProps[src]);
      return { name: nm, id: 5000 + createdComps.length,
               duplicatedFrom: src };
    }
    case "rename_item": {
      const key = String((args && args.item) || "");
      if (!args || !args.name) return { __err: "'name' is required" };
      const i = createdComps.indexOf(key);
      if (i === -1) return { __err: "Project item not found: " + key };
      createdComps[i] = String(args.name);
      compProps[args.name] = compProps[key] || {};
      delete compProps[key];
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
      rqDisk[path.toLowerCase()] = 64840 * Math.max(1, frames);
      const out = { comp, output: path, status: "DONE",
                    bytes: rqDisk[path.toLowerCase()],
                    seconds: 0.2, outputModule: om,
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
  // does put the canned comp back rather than only SAYING it did.
  const rbBefore = rbLayers.slice();
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
    assert(/Self-test: \d+\/\d+ passed/.test(res.text),
           "report carries the summary line");

    // 3. failure path: a failing tool surfaces in the report and the run
    // still completes (cleanup included)
    createCount = 0;
    camProbeReads = 0;
    ordX = {};
    ordStack = [];
    maskKeys = {};
    batchLayers = 0; batchFx = {}; batchBlur = null;
    batSolids = []; batSolidFx = {}; batSolidPos = {}; rbLayers = []; rnRenamedTo = null; scUnique = []; lights = {}; resetCoverRig(); resetPcRig(); resetTxRig(); resetShapeRig(); resetPresetRig(); resetRqRig();
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
        maskKeys = {};
        batchLayers = 0; batchFx = {}; batchBlur = null;
        batSolids = []; batSolidFx = {}; batSolidPos = {}; rbLayers = []; rnRenamedTo = null; scUnique = []; lights = {}; resetCoverRig(); resetPcRig(); resetTxRig(); resetShapeRig(); resetPresetRig(); resetRqRig();
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
