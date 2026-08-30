// Regression test: Essential Graphics + .mogrt export (WORKPLAN 5.9).
//
// `expose_property` and `export_mogrt` are almost entirely made of what
// After Effects does SILENTLY. The stub below is the probe against real
// AE 2026 (26.3x87) written down, so the same bug class is caught with
// no AE in the room:
//
//  1. `exportAsMotionGraphicsTemplate` runs headless from a `-r` session
//     with no viewer open. It answers a boolean and writes a ZIP.
//  2. **A CANCELLED export returns `true` and writes NOTHING.** Any comp
//     holding a text layer whose font is not installed raises a "fonts
//     were not synced ... Click Cancel to stop the export" alert, and
//     cancelling it still answers true - measured four times running,
//     ~1.5 s against ~4.6 s for a real export. `true` is not evidence;
//     the file has to be stat'd. `app.beginSuppressDialogs()` is what
//     makes the same comp export whole (28 577 b, 4 632 ms).
//  3. The project must be SAVED **and CLEAN**. Unsaved raises "The
//     project needs to be saved first"; saved-but-dirty returns false in
//     ~390 ms and writes nothing at all.
//  4. A SUCCESSFUL export dirties the project, so a second one with no
//     save between returns false. (Measured: 13 717 b, then nothing.)
//  5. The path argument is a FOLDER. The file name is
//     `motionGraphicsTemplateName` VERBATIM plus ".mogrt", spaces and
//     all - but `File.name` is URI-ENCODED, so the same file reads back
//     as "P60%20Brand%20Card.mogrt" and only `displayName` is a name the
//     user can open.
//  6. AE `mkdir -p`s whatever folder it is handed, INCLUDING for calls
//     that then fail - a path ending ".mogrt" becomes a DIRECTORY of
//     that name.
//  7. A template name holding a character Windows forbids exports for
//     3.7 s, returns false and writes nothing.
//  8. A comp with ZERO controllers returns false in ~340 ms.
//  9. overwrite=false onto an existing .mogrt THROWS "A file with that
//     filename in that location already exists."
// 10. A successful export INVALIDATES every reference held across it -
//     a CompItem answers "Object is invalid" afterwards, though a fresh
//     lookup through app.project revives it. (A save does not.)
// 10b. And it is not only the CompItem: the held `app.project` dies too.
//     This cost the build pass two field runs. The tool ran all the way
//     to the end and then threw "Object is invalid" on `proj.file`,
//     which reads exactly like After Effects refusing an export it had
//     in fact just written - three .mogrt files sat on the disk while
//     the tool reported failure. Everything the result needs is read
//     BEFORE the call.
// 11. `canAddToMotionGraphicsTemplate` is false for a GROUP, false for a
//     Layer Control, and false once the property is already a
//     controller; `addToMotionGraphicsTemplate` then returns undefined.
// 12. Controller indices are NEWEST-FIRST and renumber on every add.
//     Out of range answers the string "undefined"; a negative index
//     throws.
// 13. The default controller name is the LAYER's name for a transform or
//     text property and the EFFECT's name for an effect parameter -
//     never the property's own - and AE accepts DUPLICATE names.
// 14. `setMotionGraphicsTemplateControllerName` does not exist on AE
//     2026, so there is no rename and no remove.
// 15. Setting the template name to "" resets it to "Untitled".
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
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};
const RQItemStatus = { QUEUED: 3015, DONE: 3019 };

// ------------------------------------------------------- virtual disk

const DIRS = {};
const FILES = {};
function norm(p) { return String(p).replace(/\//g, "\\").replace(/\\+$/, ""); }
function mkdirp(p) {
  // FACT 6: AE creates the whole chain, and does it even when the export
  // it was creating it for then fails.
  let n = norm(p);
  while (n && n.indexOf("\\") > 0) {
    DIRS[n.toLowerCase()] = true;
    n = n.slice(0, n.lastIndexOf("\\"));
  }
}
function dirnameOf(p) {
  const n = norm(p);
  const i = n.lastIndexOf("\\");
  return i <= 0 ? "" : n.slice(0, i);
}
// FACT 2's cousin, measured on saveFrameToPng and true here too: a file
// AE has just written is invisible to a fresh handle for a moment.
const HIDE_TICKS = 2;
let fakeClock = 1000;
function writeFile(p, bytes) {
  FILES[norm(p).toLowerCase()] =
    { path: norm(p), bytes, hidden: HIDE_TICKS, mtime: ++fakeClock };
}

function File(p) {
  this._p = norm(p);
  this.fsName = this._p;
  // FACT 5: `name` is URI-ENCODED and `displayName` is the real one.
  // Reporting `name` sends the user after a file that does not exist
  // under that spelling.
  this.displayName = this._p.slice(this._p.lastIndexOf("\\") + 1);
  this.name = encodeURI(this.displayName);
}
Object.defineProperty(File.prototype, "exists", {
  get() {
    const rec = FILES[this._p.toLowerCase()];
    if (!rec) return false;
    if (rec.hidden > 0) { rec.hidden--; return false; }
    return true;
  }
});
Object.defineProperty(File.prototype, "length", {
  get() {
    const rec = FILES[this._p.toLowerCase()];
    return rec ? rec.bytes : -1;
  }
});
// An overwrite can land on the SAME byte count, so the modified stamp is
// the only thing separating "AE rewrote it" from "AE wrote nothing".
Object.defineProperty(File.prototype, "modified", {
  get() {
    const rec = FILES[this._p.toLowerCase()];
    return rec ? new Date(rec.mtime * 1000) : null;
  }
});
Object.defineProperty(File.prototype, "parent", {
  get() {
    const d = dirnameOf(this._p);
    return d ? new Folder(d) : null;
  }
});

function Folder(p) {
  this._p = norm(p);
  this.fsName = this._p;
  this.name = this._p.slice(this._p.lastIndexOf("\\") + 1);
}
Object.defineProperty(Folder.prototype, "exists", {
  get() { return !!DIRS[this._p.toLowerCase()]; }
});
Object.defineProperty(Folder.prototype, "parent", {
  get() {
    const d = dirnameOf(this._p);
    return d ? new Folder(d) : null;
  }
});
Folder.prototype.getFiles = function (mask) {
  const rx = new RegExp("^" +
    String(mask).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
    "$", "i");
  const here = this._p.toLowerCase();
  const out = [];
  for (const key of Object.keys(FILES)) {
    const rec = FILES[key];
    if (dirnameOf(rec.path).toLowerCase() !== here) continue;
    const nm = rec.path.slice(rec.path.lastIndexOf("\\") + 1);
    if (!rx.test(nm)) continue;
    if (rec.hidden > 0) { rec.hidden--; continue; }
    out.push(new File(rec.path));
  }
  return out;
};
Folder.temp = new Folder("C:\\Temp");

// --------------------------------------------------------- properties

function Prop(name, egName) {
  this.name = name;
  this.matchName = "ADBE " + name;
  // FACT 13: the name AE gives a controller when none is passed. It is
  // NOT this property's name.
  this._egName = egName;
  this._exposed = false;
  this._egAllowed = true;
  this.numKeys = 0;
  this._v = 0;
}
Prop.prototype.setValue = function (v) { this._v = v; };
Object.defineProperty(Prop.prototype, "value", { get() { return this._v; } });
Prop.prototype.canAddToMotionGraphicsTemplate = function (comp) {
  if (!(comp instanceof CompItem)) throw new Error("not a comp");
  // FACT 11: a kind EG will not take, or one that is already there.
  if (!this._egAllowed) return false;
  return !this._exposed;
};
Prop.prototype.addToMotionGraphicsTemplate = function (comp) {
  // FACT 11: undefined, not false, when it will not take it.
  if (!this.canAddToMotionGraphicsTemplate(comp)) return undefined;
  this._exposed = true;
  comp._controllers.push(this._egName);
  return true;
};
Prop.prototype.addToMotionGraphicsTemplateAs = function (comp, label) {
  if (!this.canAddToMotionGraphicsTemplate(comp)) return undefined;
  this._exposed = true;
  // An EMPTY label is not "no label": AE falls back to its own default.
  comp._controllers.push(String(label) === "" ? this._egName : String(label));
  return true;
};

function Group(name, matchName, kids) {
  this.name = name;
  this.matchName = matchName;
  this._kids = kids;
}
Group.prototype.property = function (ref) {
  if (typeof ref === "number") return this._kids[ref - 1];
  return this._kids.filter((k) => k.name === ref ||
                                  k.matchName === ref)[0] || null;
};
Object.defineProperty(Group.prototype, "numProperties", {
  get() { return this._kids.length; }
});
// A GROUP answers false, always (FACT 11).
Group.prototype.canAddToMotionGraphicsTemplate = function () { return false; };

// -------------------------------------------------------------- layers

function makeLayer(comp, name, opts) {
  const o = opts || {};
  const transform = new Group("Transform", "ADBE Transform Group", [
    new Prop("Anchor Point", name), new Prop("Position", name),
    new Prop("Scale", name), new Prop("Rotation", name),
    new Prop("Opacity", name)
  ]);
  transform._kids.forEach((k) => {
    k.matchName = { "Anchor Point": "ADBE Anchor Point",
                    Position: "ADBE Position", Scale: "ADBE Scale",
                    Rotation: "ADBE Rotate Z",
                    Opacity: "ADBE Opacity" }[k.name];
  });
  const effects = new Group("Effects", "ADBE Effect Parade", (o.effects || []));
  const l = {
    name,
    _comp: comp,
    selected: false,
    threeDLayer: false,
    _font: o.font || null,
    property(ref) {
      if (ref === "ADBE Transform Group") return transform;
      if (ref === "ADBE Effect Parade") return effects;
      return null;
    }
  };
  Object.defineProperty(l, "index",
    { get: () => comp._layers.indexOf(l) + 1 });
  comp._layers.push(l);
  return l;
}

function makeEffect(displayName, params) {
  const g = new Group(displayName, "ADBE " + displayName,
    params.map((p) => {
      // FACT 13: an effect parameter's default controller name is the
      // EFFECT's name.
      const pr = new Prop(p.name, displayName);
      if (p.egAllowed === false) pr._egAllowed = false;
      return pr;
    }));
  return g;
}

// --------------------------------------------------------------- comps

let exportCalls = 0;
let suppressDepth = 0;
let lastExportOverwrite = null;

function Comp(name) {
  this.name = name;
  this.width = 1920; this.height = 1080;
  this.pixelAspect = 1; this.duration = 5; this.frameRate = 30;
  this.frameDuration = 1 / 30;
  this.time = 0;
  this.resolutionFactor = [1, 1];
  this._layers = [];
  this._controllers = [];
  this._mgName = "Untitled";
  this._invalid = false;
}
Comp.prototype._check = function () {
  // FACT 10: a reference held across a successful export is dead.
  if (this._invalid) throw new Error("Object is invalid");
};
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { this._check(); return this._layers.length; }
});
Object.defineProperty(Comp.prototype, "selectedLayers", {
  get() { this._check(); return this._layers.filter((l) => l.selected); }
});
Comp.prototype.layer = function (ref) {
  this._check();
  const l = typeof ref === "number" ? this._layers[ref - 1]
    : this._layers.filter((x) => x.name === ref)[0];
  if (!l) throw new Error("no layer " + ref);
  return l;
};
Object.defineProperty(Comp.prototype, "motionGraphicsTemplateName", {
  get() { this._check(); return this._mgName; },
  // FACT 15: "" is not empty, it is "Untitled". Forbidden characters are
  // ACCEPTED here and only bite at export time (FACT 7).
  set(v) { this._check(); this._mgName = String(v) === "" ? "Untitled" : String(v); }
});
Object.defineProperty(Comp.prototype, "motionGraphicsTemplateControllerCount", {
  get() { this._check(); return this._controllers.length; }
});
Comp.prototype.getMotionGraphicsTemplateControllerName = function (i) {
  this._check();
  if (i < 0) {
    throw new Error("After Effects error: Unable to call " +
      "\u201CgetMotionGraphicsTemplateControllerName\u201D because of " +
      "parameter 1. " + i + " is not an unsigned integer.");
  }
  // FACT 12: newest first, and out of range is the STRING "undefined".
  const n = this._controllers.length;
  const v = this._controllers[n - i];
  return v === undefined ? "undefined" : v;
};
// FACT 14: there is no rename. The absence is the point, so it is
// asserted rather than stubbed.
Comp.prototype.exportAsMotionGraphicsTemplate = function (overwrite, where) {
  this._check();
  exportCalls++;
  lastExportOverwrite = overwrite;
  if (typeof where !== "string") {
    throw new Error("Object is invalid");        // a File/Folder object
  }
  mkdirp(where);                                              // FACT 6
  if (!project.file) {
    project._modals.push("The project needs to be saved first");
    return false;
  }
  if (project.dirty) return false;                            // FACT 3
  if (this._controllers.length === 0) return false;           // FACT 8
  const nm = this._mgName;
  if (/[\\/:*?"<>|]/.test(nm)) return false;                  // FACT 7
  // FACT 5: verbatim, spaces and all.
  const file = norm(where + "\\" + nm + ".mogrt");
  if (FILES[file.toLowerCase()] && !overwrite) {              // FACT 9
    throw new Error("After Effects error: A file with that filename in " +
      "that location already exists.");
  }
  // FACT 2: the font alert. Unsuppressed it is CANCEL, and the call
  // still answers true with nothing on disk.
  const badFont = this._layers.some((l) => l._font && !FONTS_INSTALLED[l._font]);
  if (badFont && suppressDepth === 0) {
    project._modals.push("The following 1 fonts were not synced");
    return true;
  }
  writeFile(file, 12192 + this._controllers.length);
  project.dirty = true;                                       // FACT 4
  this._exported = true;
  this._invalid = true;                                       // FACT 10
  project._invalid = true;                                    // FACT 10b
  return true;
};

const FONTS_INSTALLED = { "Helvetica": true };

function makeComp(name) {
  const c = new Comp(name);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  return c;
}

const project = {
  _items: [],
  _modals: [],
  dirty: false,
  file: null,
  saves: 0,
  activeItem: null,
  get numItems() { return this._items.length; },
  // A fresh lookup revives a comp a previous export invalidated - which
  // is what makes a SECOND export reachable at all.
  item(i) {
    const it = this._items[i - 1];
    if (it) it._invalid = false;
    return it;
  },
  _check() {
    // FACT 10b: the held app.project reference dies with the comp.
    if (this._invalid) throw new Error("Object is invalid");
  },
  rootFolder: { name: "(root)" },
  renderQueue: { numItems: 0, item() { return null; } },
  items: {
    addComp(name) {
      const c = makeComp(name);
      project._items.push(c);
      return c;
    }
  },
  // A save does NOT invalidate held references (measured), unlike the
  // export.
  save() { this.saves++; this.dirty = false; }
};

// The two reads a stale project reference dies on. Writes are left
// alone: the test rig sets them, After Effects does not.
["file", "dirty"].forEach((k) => {
  const hidden = "_" + k;
  project[hidden] = project[k];
  Object.defineProperty(project, k, {
    get() { this._check(); return this[hidden]; },
    set(v) { this[hidden] = v; }
  });
});

let undoDepth = 0;
const app = {
  // Reading app.project hands back a LIVE reference; the one the caller
  // stashed in a variable before the export is the one that dies.
  get project() { project._invalid = false; return project; },
  version: "26.3x87",
  beginUndoGroup() { undoDepth++; },
  endUndoGroup() {
    if (undoDepth === 0) throw new Error("endUndoGroup with no group open");
    undoDepth--;
  },
  executeCommand() {},
  findMenuCommandId() { return 2156; },
  beginSuppressDialogs() { suppressDepth++; },
  endSuppressDialogs() { if (suppressDepth > 0) suppressDepth--; }
};
const $ = { global: {}, hiresTimer: 0, sleep() {} };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool, " +
  "AELL_NO_UNDO_GROUP: AELL_NO_UNDO_GROUP, AELL_PER_LAYER: AELL_PER_LAYER, " +
  "AELL_mogrtFileName: AELL_mogrtFileName, " +
  "AELL_mogrtBadName: AELL_mogrtBadName })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool, AELL_NO_UNDO_GROUP,
        AELL_PER_LAYER, AELL_mogrtFileName, AELL_mogrtBadName } = host;
const call = (t, a) => AELL_runTool(t, a || {});

// ---------------------------------------------------------------- rig

mkdirp("C:\\out");
const brand = project.items.addComp("Brand Card");
project.activeItem = brand;
const bg = makeLayer(brand, "BG", {
  effects: [
    makeEffect("Slider Control", [{ name: "Slider" }]),
    // FACT 11: a Layer Control is the kind EG will not take.
    makeEffect("Layer Control", [{ name: "Layer", egAllowed: false }])
  ]
});
const title = makeLayer(brand, "Title", { font: "Power Centra" });
bg.selected = true;

console.log("=== expose_property ===");

// ---- the group refusal (FACT 11) --------------------------------------
let r = call("expose_property", { layer: "BG", property: "transform" });
assert(!r.ok, "a GROUP is refused, not exposed");
assert(/is a GROUP/.test(r.error) && /list_properties/.test(r.error),
       "and the refusal names the tool that lists what is inside: " +
       r.error.slice(0, 70));

// ---- the happy path, no label (FACT 13) --------------------------------
r = call("expose_property", { layer: "BG", property: "opacity" });
assert(r.ok, "a leaf transform property is exposed");
assert(r.data.controllerCount === 1, "controllerCount comes back (1)");
assert(r.data.controller === "BG",
       "the controller AE made is named after the LAYER, not the " +
       "property: " + r.data.controller);
assert(/never the property's own/.test(r.data.note || ""),
       "and the result SAYS so, so the model learns to pass a label");
assert(brand._controllers.length === 1, "the rig agrees one was added");

// ---- exposing the same property twice (FACT 11) ------------------------
r = call("expose_property", { layer: "BG", property: "opacity" });
assert(!r.ok, "the same property cannot be exposed twice");
assert(/ALREADY a controller/.test(r.error),
       "and 'already a controller' is the first reason offered");
assert(/BG/.test(r.error),
       "the refusal lists the roster, so the model can see what is there");
assert(brand._controllers.length === 1, "nothing was added by the refusal");

// ---- a kind EG will not take (FACT 11) ---------------------------------
r = call("expose_property", { layer: "BG",
                              property: "effect.Layer Control.Layer" });
assert(!r.ok, "a Layer Control parameter is refused");
assert(/Layer Control is the one measured/.test(r.error),
       "and the refusal names the kinds that DO work");

// ---- an effect parameter's default name (FACT 13) ----------------------
r = call("expose_property", { layer: "BG",
                              property: "effect.Slider Control.Slider" });
assert(r.ok, "an effect parameter is exposed");
assert(r.data.controller === "Slider Control",
       "its default controller name is the EFFECT's name: " +
       r.data.controller);

// ---- indices are newest-first and renumber (FACT 12) -------------------
assert(brand.getMotionGraphicsTemplateControllerName(1) === "Slider Control",
       "index 1 is the NEWEST controller");
assert(brand.getMotionGraphicsTemplateControllerName(2) === "BG",
       "index 2 is the one added before it - the numbering shifted");
assert(brand.getMotionGraphicsTemplateControllerName(99) === "undefined",
       "an out-of-range index answers the string 'undefined'");
assert(typeof brand.setMotionGraphicsTemplateControllerName === "undefined",
       "AE 2026 has no setMotionGraphicsTemplateControllerName, so there " +
       "is no rename");
assert(/no rename and no remove/.test(r.data.next || ""),
       "and the result says so rather than letting the model try");

// ---- a label, and the duplicate-name warning (FACT 13) -----------------
r = call("expose_property", { layer: "BG", property: "position",
                              label: "Slider Control" });
assert(r.ok, "a labelled controller is added");
assert(r.data.controller === "Slider Control", "under the label given");
assert(/ALSO called/.test(r.data.warning || ""),
       "and the duplicate name is reported, because AE accepts it " +
       "silently: " + (r.data.warning || "").slice(0, 60));

r = call("expose_property", { layer: "BG", property: "scale",
                              label: "Card Size" });
assert(r.ok && r.data.controller === "Card Size",
       "a unique label produces no warning");
assert(!r.data.warning, "and no warning");

console.log("=== export_mogrt: the refusals that cost nothing ===");

const callsBefore = exportCalls;

// ---- no folder ---------------------------------------------------------
r = call("export_mogrt", {});
assert(!r.ok && /'folder' is required/.test(r.error),
       "a missing folder is refused");
assert(/FILE name comes from the template name/.test(r.error),
       "and the refusal explains that the path is a folder, not a file");

// ---- relative path -----------------------------------------------------
r = call("export_mogrt", { folder: "templates" });
assert(!r.ok && /ABSOLUTE path/.test(r.error), "a relative path is refused");

// ---- a folder that does not exist (FACT 6) -----------------------------
r = call("export_mogrt", { folder: "C:\\out\\nope\\deeper" });
assert(!r.ok && /Folder does not exist/.test(r.error),
       "a missing folder is refused BEFORE the call");
assert(/Deepest folder that does exist: C:\\out/.test(r.error),
       "and the deepest one that does exist is named: " +
       r.error.slice(0, 90));
assert(!DIRS["c:\\out\\nope\\deeper"],
       "nothing was created - AE would have mkdir -p'd it and then " +
       "failed into it, leaving an empty directory behind");

// ---- a name Windows will not take (FACT 7) -----------------------------
r = call("export_mogrt", { folder: "C:\\out", name: "Brand: v2/final" });
assert(!r.ok && /contains/.test(r.error),
       "a template name with forbidden characters is refused");
assert(/: \/|\/ :/.test(r.error) || (r.error.indexOf(":") !== -1 &&
       r.error.indexOf("/") !== -1),
       "and the offending characters are named");
assert(/returns false and writes nothing/.test(r.error),
       "with what AE would have done instead - 3.7 s and no file");

// ---- zero controllers (FACT 8) -----------------------------------------
const bare = project.items.addComp("Bare");
makeLayer(bare, "Solo");
r = call("export_mogrt", { comp: "Bare", folder: "C:\\out" });
assert(!r.ok && /no Essential Graphics/.test(r.error),
       "a comp with no controllers is refused");
assert(/expose_property/.test(r.error),
       "and pointed at the tool that fixes it");

// ---- unsaved project (FACT 3) ------------------------------------------
r = call("export_mogrt", { comp: "Brand Card", folder: "C:\\out" });
assert(!r.ok && /never been saved/.test(r.error),
       "an unsaved project is refused");
assert(/needs to be saved first/.test(r.error),
       "quoting the alert AE would have raised");

assert(exportCalls === callsBefore,
       "not one of those six refusals reached After Effects (" +
       (exportCalls - callsBefore) + " calls)");

console.log("=== export_mogrt: saved, dirty, clean ===");

project.file = new File("C:\\proj\\Brand.aep");
project.dirty = true;

r = call("export_mogrt", { comp: "Brand Card", folder: "C:\\out" });
assert(!r.ok && /unsaved changes/.test(r.error),
       "a DIRTY project is refused - AE would return false in ~390 ms " +
       "and write nothing");
assert(/\{save: true\}/.test(r.error) && /Brand\.aep/.test(r.error),
       "and the refusal offers {save: true} and names the file it would " +
       "write");
assert(/right after expose_property/.test(r.error),
       "and says why this is the NORMAL state, not an odd one");
assert(exportCalls === callsBefore, "still no export attempted");
assert(project.saves === 0, "and the project was NOT saved behind the user");

// ---- the real thing ----------------------------------------------------
r = call("export_mogrt", { comp: "Brand Card", folder: "C:\\out",
                           name: "Brand Card v2", save: true });
assert(r.ok, "with {save: true} the export runs: " + (r.error || ""));
assert(project.saves === 1, "the project was saved exactly once");
assert(r.data.bytes > 0, "and the result reports the file's REAL size (" +
       r.data.bytes + " bytes), not the boolean AE returned");
assert(r.data.path === "C:\\out\\Brand Card v2.mogrt",
       "the file is the template name VERBATIM, spaces and all, and the " +
       "reported path is URI-DECODED - not Brand%20Card%20v2.mogrt: " +
       r.data.path);
assert(!r.data.nameNote,
       "the file is where the tool predicted, so nothing is flagged");
assert(!r.data.threw, "and AE raised nothing on a comp's FIRST export");
assert(r.data.controllers === 4, "the controller count comes back");
assert(/SECOND export with no save/.test(r.data.note || ""),
       "and the success warns that the export dirtied the project");
// Read through app.project, not the stale handle - the export killed
// that one, which is FACT 10b and the bug it stands for.
assert(app.project.dirty === true, "which it did");
assert(FILES["c:\\out\\brand card v2.mogrt"], "the file is on the disk");

// ---- FACT 10: the tool must not read the comp after the export ---------
assert(r.data.comp === "Brand Card",
       "the comp name survives in the result - every field was read " +
       "BEFORE the call, because the export invalidates the reference");
let died = false;
try { void brand.numLayers; } catch (e) { died = /invalid/.test(e.message); }
assert(died, "and the held CompItem really is dead afterwards");

console.log("=== export_mogrt: the export that reports success ===");

// A fresh comp with the same uninstalled font, dialogs NOT suppressed,
// is the case the whole probe was worth. The tool suppresses, so this
// asserts the suppression by removing it.
const card2 = project.items.addComp("Card Two");
makeLayer(card2, "Body", { font: "Power Centra" });
card2._layers[0].selected = true;
project.activeItem = card2;
r = call("expose_property", { comp: "Card Two", layer: "Body",
                              property: "opacity", label: "Fade" });
assert(r.ok, "a second comp gets a control");

const realBegin = app.beginSuppressDialogs;
app.beginSuppressDialogs = function () {};        // pretend we forgot
project.dirty = false;
r = call("export_mogrt", { comp: "Card Two", folder: "C:\\out",
                           name: "CardTwo" });
app.beginSuppressDialogs = realBegin;
assert(!r.ok,
       "WITHOUT beginSuppressDialogs the font alert cancels the export - " +
       "AE answers true, writes nothing, and this is reported as a " +
       "FAILURE");
assert(/returned true but wrote no \.mogrt/.test(r.error),
       "the error says exactly that: " + r.error.slice(0, 60));
assert(/font alert/.test(r.error) && /1\.5 s/.test(r.error),
       "and offers the two measured causes, including the timing tell");
assert(!FILES["c:\\out\\cardtwo.mogrt"], "and there really is no file");

// With the suppression back, the same comp exports whole.
project.dirty = false;
r = call("export_mogrt", { comp: "Card Two", folder: "C:\\out",
                           name: "CardTwo" });
assert(r.ok && r.data.bytes > 0,
       "with the suppression the same comp exports whole (" +
       (r.ok ? r.data.bytes + " bytes" : r.error) + ")");
assert(suppressDepth === 0, "and the suppression is always lifted again");

console.log("=== overwrite, and the .mogrt path trap ===");

// ---- FACT 9: an existing file --------------------------------------
const card3 = project.items.addComp("Card Three");
makeLayer(card3, "Body");
card3._layers[0].selected = true;
r = call("expose_property", { comp: "Card Three", layer: "Body",
                              property: "opacity", label: "Fade" });
assert(r.ok, "comp three gets a control");
project.dirty = false;
const before9 = exportCalls;
r = call("export_mogrt", { comp: "Card Three", folder: "C:\\out",
                           name: "CardTwo" });
assert(!r.ok && /already exists/.test(r.error),
       "an existing .mogrt is refused without {overwrite: true}");
assert(/bytes\)/.test(r.error), "and its size is quoted");
assert(exportCalls === before9,
       "refused BEFORE the call, so AE never throws its own version");

r = call("export_mogrt", { comp: "Card Three", folder: "C:\\out",
                           name: "CardTwo", overwrite: true });
assert(r.ok, "with {overwrite: true} it goes ahead");
assert(lastExportOverwrite === true,
       "and the flag is passed through to AE, not just checked here");
assert(r.data.replaced === true, "the result says a file was replaced");

// ---- FACT 6: a path ending .mogrt ------------------------------------
const card4 = project.items.addComp("Card Four");
makeLayer(card4, "Body");
card4._layers[0].selected = true;
call("expose_property", { comp: "Card Four", layer: "Body",
                          property: "opacity", label: "Fade" });
project.dirty = false;
r = call("export_mogrt", { comp: "Card Four",
                           folder: "C:\\out\\Lower Third.mogrt" });
assert(r.ok, "a path ending .mogrt still works: " + (r.error || ""));
assert(!DIRS["c:\\out\\lower third.mogrt"],
       "but no DIRECTORY of that name was created - AE would have made " +
       "one and put the file inside it");
assert(r.data.path === "C:\\out\\Lower Third.mogrt",
       "the basename became the template name: " + r.data.path);
assert(/ended in \.mogrt/.test(r.data.pathNote || ""),
       "and the correction is reported");

// ---- the default name is the comp's -----------------------------------
const card5 = project.items.addComp("Promo Bumper");
makeLayer(card5, "Body");
card5._layers[0].selected = true;
call("expose_property", { comp: "Promo Bumper", layer: "Body",
                          property: "opacity", label: "Fade" });
project.dirty = false;
r = call("export_mogrt", { comp: "Promo Bumper", folder: "C:\\out" });
assert(r.ok && r.data.template === "Promo Bumper",
       "with no {name} the COMP's name is used, not AE's 'Untitled': " +
       (r.ok ? r.data.template : r.error));

console.log("=== the reference that dies with the comp (FACT 10b) ===");

// This is the bug the field found twice: the tool ran to the very end
// and then died reading app.project, which reads exactly like AE
// refusing an export it had already written.
const two = project._items.filter((c) => c.name === "Card Two")[0];
assert(two._exported === true, "Card Two has exported once this session");
project.dirty = false;
r = call("export_mogrt", { comp: "Card Two", folder: "C:\\out",
                           name: "CardTwo", overwrite: true,
                           save: true });
assert(r.ok,
       "an export that needs the project path in its RESULT still " +
       "succeeds - every field is read before the call: " + (r.error || ""));
assert(r.data.projectSaved === "C:\\proj\\Brand.aep",
       "and the saved path comes back: " + r.data.projectSaved);
assert(project._invalid === true,
       "even though the held app.project really is dead by then");
assert(!r.data.threw, "no throw was involved");

// The other half of the same rule: a throw with NOTHING on disk is a
// failure, and stays one.
const card6 = app.project.items.addComp("Card Six");
makeLayer(card6, "Body");
card6._layers[0].selected = true;
call("expose_property", { comp: "Card Six", layer: "Body",
                          property: "opacity", label: "Fade" });
app.project.dirty = false;
card6.exportAsMotionGraphicsTemplate = function () {
  throw new Error("After Effects error: something went wrong");
};
r = call("export_mogrt", { comp: "Card Six", folder: "C:\\out",
                           name: "CardSix" });
assert(!r.ok && /something went wrong/.test(r.error),
       "a throw with nothing on disk is still a failure, and quotes AE");

// ...and a throw WITH a file is a success, because the disk is the
// evidence either way.
const card7 = app.project.items.addComp("Card Seven");
makeLayer(card7, "Body");
card7._layers[0].selected = true;
call("expose_property", { comp: "Card Seven", layer: "Body",
                          property: "opacity", label: "Fade" });
app.project.dirty = false;
card7.exportAsMotionGraphicsTemplate = function (ow, where) {
  writeFile(norm(where + "\\CardSeven.mogrt"), 9001);
  throw new Error("After Effects error: something went wrong");
};
r = call("export_mogrt", { comp: "Card Seven", folder: "C:\\out",
                           name: "CardSeven" });
assert(r.ok, "a throw is not a verdict either: " + (r.error || ""));
assert(r.data.bytes === 9001, "the bytes are read off the disk");
assert(/is on the disk anyway/.test(r.data.threwNote || ""),
       "and AE's message is passed on rather than swallowed");

console.log("=== helpers, registration and docs ===");

assert(AELL_mogrtFileName("AELL Probe Template") ===
       "AELL Probe Template.mogrt",
       "AELL_mogrtFileName is the template name VERBATIM - AE transforms " +
       "nothing, and the space-stripping an earlier probe reported was " +
       "that probe reading back a name that never had spaces in it");
assert(AELL_mogrtBadName("a:b/c").join("") === ":/",
       "AELL_mogrtBadName finds the characters Windows forbids");
assert(AELL_mogrtBadName("Perfectly Fine 2").length === 0,
       "and leaves an ordinary name alone");

assert(AELL_MUTATING.expose_property === true,
       "expose_property gets an undo group - it edits the project");
assert(!AELL_MUTATING.export_mogrt,
       "export_mogrt does NOT, and is exempt instead");
assert(AELL_NO_UNDO_GROUP.export_mogrt === true,
       "because it writes a file and may save the project, and a save " +
       "inside an open undo group is the one thing it must never do");
assert(AELL_PER_LAYER.expose_property === true,
       "expose_property is drivable by for_each_layer (one layer each)");
assert(!AELL_PER_LAYER.export_mogrt,
       "export_mogrt is not - it takes no layer");

const defs = toolsSrc.match(/name:\s*"(expose_property|export_mogrt)"/g) || [];
assert(defs.length === 2,
       "both tools are documented in tools.js - an undocumented tool is " +
       "unreachable by the model");
assert(/SAVED and has NO unsaved changes/.test(toolsSrc),
       "and the docs carry the saved-AND-clean rule, which is the one " +
       "the model cannot guess");
assert(/reports success even/.test(toolsSrc),
       "and that AE reports success when it wrote nothing");

console.log("\n" + checks + " checks");
if (process.exitCode) console.log("TESTS FAILED");
else console.log("ALL TESTS PASSED");
