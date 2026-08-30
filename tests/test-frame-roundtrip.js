// Regression test: the frame round-trip, comp -> PNG -> layer
// (WORKPLAN 5.8).
//
// `snapshot_frame` and `import_as_layer` are the bridge every image or
// video generator stands on, and both are built on measurements from
// three probe rounds against real AE 2026 (26.3x87). The stub below
// encodes those measurements so the same bug class is caught WITHOUT
// After Effects:
//
//  1. `comp.saveFrameToPng(time, File)` works headless, with no viewer
//     open, and leaves `comp.time` alone.
//  2. A String path THROWS ("is not a File or Folder object") - the
//     argument must be a File.
//  3. A folder that does not exist is a SILENT NO-OP: the call returns
//     normally and writes nothing at all.
//  4. An out-of-range time CLAMPS and writes a BLANK frame. Measured:
//     time 99 and time -5 on a 4s comp both produced 378-byte files
//     where the real frame was 644.
//  5. The comp's resolutionFactor is honoured, silently: a 320x240 comp
//     at [2,2] writes a 160x120 PNG and nothing says so.
//  6. AE writes PNG BYTES into whatever name it is handed. A frame
//     saved as "wrongext.jpg" is a PNG called .jpg, and no .png appears
//     beside it.
//  7. It overwrites an existing file with no dialog and no undo (unlike
//     a render, which raises a modal that wedges AE).
//  8. A file AE has just written reports exists === false for ~300 ms,
//     so its own output has to be polled rather than glanced at.
//  9. Guide layers are NOT rendered into the frame.
// 10. `importFile` on a path already in the project makes a SECOND item
//     and says nothing (one path, two ids).
// 11. A non-media file throws "Could not read from source" - while
//     `canImportAs(FOOTAGE)` answers TRUE for the very same .txt, so
//     the throw is the only honest signal.
// 12. `mainSource.reload()` re-reads the file and keeps the item id.
// 13. A still placed in a comp spans the WHOLE comp, and AE centres it.
// 14. AE's "Fit to Comp" menu commands do NOTHING with no viewer open
//     (scale stayed 100,100), so the panel must do the arithmetic
//     itself. With a viewer open they produced, for a 320x240 par-1
//     source: in an 800x480 par-1 comp, Fit 250x200, Width 250x250,
//     Height 200x200; in a 720x480 par-1.2121 comp, Fit 272.727x200 and
//     Width 272.727x272.727 - pixel-aspect-corrected on X. Those exact
//     numbers are asserted below.
// 15. Adding a layer selects it and deselects everything else.
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
function near(a, b) { return Math.abs(Number(a) - Number(b)) < 0.001; }

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
function mkdirp(p) { DIRS[norm(p).toLowerCase()] = true; }
function dirnameOf(p) {
  const n = norm(p);
  const i = n.lastIndexOf("\\");
  return i <= 0 ? "" : n.slice(0, i);
}
// FACT 8: a file AE has JUST written is invisible for a moment. Only
// files written through saveFrameToPng start hidden - the rig's own
// source files have been on disk all along.
const HIDE_TICKS = 2;
function writePng(p, w, h, bytes, hidden) {
  FILES[norm(p).toLowerCase()] =
    { bytes: bytes, hidden: hidden || 0, png: { w: w, h: h } };
}
function writePlain(p, bytes) {
  FILES[norm(p).toLowerCase()] = { bytes: bytes, hidden: 0, png: null };
}

function File(p) {
  this._p = norm(p);
  this.fsName = this._p;
  this.name = this._p.slice(this._p.lastIndexOf("\\") + 1);
  this.encoding = "";
}
Object.defineProperty(File.prototype, "exists", {
  get() {
    const rec = FILES[this._p.toLowerCase()];
    if (!rec) return false;
    if (rec.hidden > 0) { rec.hidden--; return false; }      // FACT 8
    return true;
  }
});
Object.defineProperty(File.prototype, "length", {
  get() {
    const rec = FILES[this._p.toLowerCase()];
    return rec ? rec.bytes : -1;
  }
});
Object.defineProperty(File.prototype, "parent", {
  get() {
    const d = dirnameOf(this._p);
    return d ? new Folder(d) : null;
  }
});
File.prototype.open = function () {
  this._rec = FILES[this._p.toLowerCase()];
  return !!this._rec;
};
// A PNG's first 24 bytes: the 8-byte signature, then the IHDR length,
// type, width and height. Read as a BINARY string, one char per byte,
// exactly as ExtendScript hands it over.
File.prototype.read = function (n) {
  const rec = this._rec;
  if (!rec) return "";
  const b = [];
  if (rec.png) {
    b.push(0x89, 80, 78, 71, 13, 10, 26, 10);
    b.push(0, 0, 0, 13, 73, 72, 68, 82);
    const be = (v) => [(v >>> 24) & 255, (v >>> 16) & 255,
                       (v >>> 8) & 255, v & 255];
    b.push.apply(b, be(rec.png.w));
    b.push.apply(b, be(rec.png.h));
  } else {
    for (let i = 0; i < 24; i++) b.push(65);      // "AAAA..." - not a PNG
  }
  return b.slice(0, n || b.length)
          .map((c) => String.fromCharCode(c)).join("");
};
File.prototype.close = function () { this._rec = null; return true; };
File.prototype.remove = function () {
  delete FILES[this._p.toLowerCase()];
  return true;
};

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
Folder.temp = new Folder("C:\\Temp");
Folder.startup = new Folder("C:\\Program Files\\Adobe\\AE\\Support Files");
Folder.myDocuments = new Folder("C:\\Users\\probe\\Documents");

// ------------------------------------------------------------ footage

function FileSource(file) { this.file = file; this.reloads = 0; }
FileSource.prototype.reload = function () { this.reloads++; };
function ImportOptions(file) { this.file = file; this.sequence = false; }

let nextId = 6000;
function Footage(file, w, h, par, duration) {
  this.name = file.name;
  this.id = nextId++;
  this.width = w; this.height = h;
  this.pixelAspect = par === undefined ? 1 : par;
  this.duration = duration || 0;
  this.mainSource = new FileSource(file);
  Object.setPrototypeOf(this, FootageItem.prototype);
}

// --------------------------------------------------------------- layers

function Prop(value) { this._v = value; this.numKeys = 0; }
Prop.prototype.setValue = function (v) { this._v = v; };
Object.defineProperty(Prop.prototype, "value", { get() { return this._v; } });

function Layer(comp, item) {
  this._comp = comp;
  this.name = item.name;
  this.source = item;
  this.width = item.width; this.height = item.height;
  this.threeDLayer = false;
  this.selected = true;                                       // FACT 15
  this.inPoint = 0;
  // FACT 13: a still spans the whole comp.
  this.outPoint = item.duration > 0
    ? Math.min(item.duration, comp.duration) : comp.duration;
  // FACT 13: AE centres what it adds. Values are PADDED to three
  // components on a 2D layer, exactly as the scripting API does.
  const t = {
    "ADBE Scale": new Prop([100, 100, 100]),
    "ADBE Position": new Prop([comp.width / 2, comp.height / 2, 0]),
    "ADBE Anchor Point": new Prop([item.width / 2, item.height / 2, 0])
  };
  this._groups = { "ADBE Transform Group": { property: (n) => t[n] } };
}
Layer.prototype.property = function (n) { return this._groups[n]; };
Object.defineProperty(Layer.prototype, "index", {
  get() { return this._comp._layers.indexOf(this) + 1; }
});

// --------------------------------------------------------------- comps

let silentNoOps = 0;
const savedTimes = [];

function Comp(name, w, h, par, duration, fps) {
  this.name = name;
  this.width = w; this.height = h;
  this.pixelAspect = par === undefined ? 1 : par;
  this.duration = duration === undefined ? 4 : duration;
  this.frameRate = fps || 24;
  this.frameDuration = 1 / this.frameRate;
  this.time = 0;
  this.resolutionFactor = [1, 1];
  this._layers = [];
}
Object.defineProperty(Comp.prototype, "numLayers", {
  get() { return this._layers.length; }
});
Object.defineProperty(Comp.prototype, "selectedLayers", {
  get() { return this._layers.filter((l) => l.selected); }
});
Comp.prototype.layer = function (ref) {
  const l = typeof ref === "number" ? this._layers[ref - 1]
    : this._layers.filter((x) => x.name === ref)[0];
  if (!l) throw new Error("no layer " + ref);
  return l;
};
Comp.prototype.openInViewer = function () {};
// FACTS 2-8 all live in here.
Comp.prototype.saveFrameToPng = function (t, file) {
  if (!(file instanceof File)) {                              // FACT 2
    throw new Error("After Effects error: Unable to call " +
      "\u201CsaveFrameToPng\u201D because of parameter 2. " + file +
      " is not a File or Folder object.");
  }
  const dir = file.parent;
  if (!dir || !dir.exists) { silentNoOps++; return; }         // FACT 3
  savedTimes.push(t);
  const rf = this.resolutionFactor || [1, 1];                 // FACT 5
  const w = Math.floor(this.width / rf[0]);
  const h = Math.floor(this.height / rf[1]);
  // FACT 4: out of range does not complain, it writes a blank frame.
  const blank = t < 0 || t > this.duration;
  // FACTS 6 + 7: PNG bytes, whatever the name, over whatever was there.
  writePng(file.fsName, w, h, blank ? 378 : 644, HIDE_TICKS);
};

function makeComp(name, w, h, par, duration, fps) {
  const c = new Comp(name, w, h, par, duration, fps);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  c.layers = {
    add(item) {
      const l = new Layer(c, item);
      // FACT 15: the new layer takes the selection with it.
      c._layers.forEach((x) => { x.selected = false; });
      c._layers.unshift(l);
      return l;
    },
    addSolid(color, nm, w2, h2) {
      const fake = { name: nm, width: w2, height: h2, duration: 0 };
      const l = new Layer(c, fake);
      l.source = { name: nm, mainSource: new SolidSource() };
      c._layers.forEach((x) => { x.selected = false; });
      c._layers.unshift(l);
      return l;
    }
  };
  return c;
}

const MEDIA = /\.(png|jpg|jpeg|tif|tiff|exr|psd|mov|mp4|avi|wav|mp3|aif)$/i;
const project = {
  _items: [],
  dirty: false,
  activeItem: null,
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  rootFolder: { name: "(root)" },
  renderQueue: { numItems: 0, item() { return null; } },
  items: {
    addComp(name, w, h, par, duration, fps) {
      const c = makeComp(name, w, h, par, duration, fps);
      project._items.push(c);
      return c;
    },
    addFolder(name) {
      const f = { name: name, remove() {} };
      Object.setPrototypeOf(f, FolderItem.prototype);
      project._items.push(f);
      return f;
    }
  },
  // FACTS 10 + 11.
  importFile(io) {
    const f = io.file;
    if (!FILES[f.fsName.toLowerCase()]) {
      throw new Error("After Effects error: file does not exist");
    }
    if (!MEDIA.test(f.fsName)) {
      throw new Error("After Effects error: Could not read from source. " +
        "Please check the settings and try again.");
    }
    const rec = FILES[f.fsName.toLowerCase()];
    const isAudio = /\.(wav|mp3|aif)$/i.test(f.fsName);
    const item = new Footage(f,
      isAudio ? 0 : (rec && rec.png ? rec.png.w : 320),
      isAudio ? 0 : (rec && rec.png ? rec.png.h : 240),
      1, isAudio ? 3 : 0);
    // No de-duplication whatsoever: the same path twice is two items.
    project._items.push(item);
    return item;
  },
  // FACT 11's other half: canImportAs is a liar, and nothing may use it.
  canImportAs() { return true; }
};

let undoDepth = 0;
const app = {
  project: project, version: "26.3x87",
  beginUndoGroup() { undoDepth++; },
  endUndoGroup() {
    if (undoDepth === 0) throw new Error("endUndoGroup with no group open");
    undoDepth--;
  },
  executeCommand() {},
  findMenuCommandId() { return 2156; },
  beginSuppressDialogs() {}, endSuppressDialogs() {}
};
const $ = { global: {}, hiresTimer: 0, sleep() {} };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool, " +
  "AELL_NO_UNDO_GROUP: AELL_NO_UNDO_GROUP, AELL_pngInfo: AELL_pngInfo })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool, AELL_NO_UNDO_GROUP,
        AELL_pngInfo } = host;
const call = (t, a) => AELL_runTool(t, a || {});

// ---------------------------------------------------------------- rig

mkdirp("C:\\Temp");
mkdirp("C:\\frames");
const shot = project.items.addComp("Shot", 320, 240, 1, 4, 24);
project.activeItem = shot;
shot.layers.addSolid([0, 0, 1], "BG", 320, 240);

assert(typeof AELL_TOOLS.snapshot_frame === "function",
       "snapshot_frame exists");
assert(typeof AELL_TOOLS.import_as_layer === "function",
       "import_as_layer exists");
assert(typeof AELL_TOOLS.import_file === "function",
       "import_file still exists");

// ------------------------------------------------ 1. the stub is faithful
//
// Drive the raw API first: a stub that quietly stopped modelling the
// hazards would let the fixes pass on a technicality.
{
  let threw = "";
  try { shot.saveFrameToPng(1, "C:/frames/str.png"); }
  catch (e) { threw = String(e); }
  assert(/not a File or Folder object/.test(threw),
         "STUB FIDELITY: a String path throws (FACT 2)");

  const before = silentNoOps;
  shot.saveFrameToPng(1, new File("C:/frames/nope/deep.png"));
  assert(silentNoOps === before + 1 && !FILES["c:\\frames\\nope\\deep.png"],
         "STUB FIDELITY: a missing folder is a SILENT no-op (FACT 3)");

  shot.saveFrameToPng(99, new File("C:/frames/far.png"));
  assert(FILES["c:\\frames\\far.png"].bytes === 378,
         "STUB FIDELITY: an out-of-range time writes a BLANK frame (FACT 4)");

  shot.resolutionFactor = [2, 2];
  shot.saveFrameToPng(1, new File("C:/frames/half.png"));
  assert(FILES["c:\\frames\\half.png"].png.w === 160 &&
         FILES["c:\\frames\\half.png"].png.h === 120,
         "STUB FIDELITY: resolutionFactor silently halves the frame (FACT 5)");
  shot.resolutionFactor = [1, 1];

  shot.saveFrameToPng(1, new File("C:/frames/wrongext.jpg"));
  assert(FILES["c:\\frames\\wrongext.jpg"].png &&
         !FILES["c:\\frames\\wrongext.jpg.png"],
         "STUB FIDELITY: PNG bytes go into whatever name is given (FACT 6)");

  const f = new File("C:/frames/far.png");
  assert(f.exists === false && f.exists === false && f.exists === true,
         "STUB FIDELITY: a just-written file is invisible at first (FACT 8)");

  delete FILES["c:\\frames\\far.png"];
  delete FILES["c:\\frames\\half.png"];
  delete FILES["c:\\frames\\wrongext.jpg"];
}

{
  writePng("C:/frames/dup.png", 320, 240, 644);
  const a = project.importFile(
    new ImportOptions(new File("C:/frames/dup.png")));
  const b = project.importFile(
    new ImportOptions(new File("C:/frames/dup.png")));
  assert(a.id !== b.id && a !== b,
         "STUB FIDELITY: importing one path twice makes two items (FACT 10)");
  writePlain("C:/frames/notes.txt", 11);
  let threw = "";
  try {
    project.importFile(new ImportOptions(new File("C:/frames/notes.txt")));
  } catch (e) { threw = String(e); }
  assert(/Could not read from source/.test(threw) &&
         project.canImportAs() === true,
         "STUB FIDELITY: a .txt throws while canImportAs says yes (FACT 11)");
  const idBefore = a.id;
  a.mainSource.reload();
  assert(a.id === idBefore && a.mainSource.reloads === 1,
         "STUB FIDELITY: reload() keeps the item id (FACT 12)");
  project._items = project._items.filter((x) => x !== a && x !== b);
  delete FILES["c:\\frames\\dup.png"];
}

// --------------------------------------------------- 2. AELL_pngInfo

{
  writePng("C:/frames/info.png", 1920, 1080, 900);
  const info = AELL_pngInfo(new File("C:/frames/info.png"));
  assert(info && info.width === 1920 && info.height === 1080,
         "AELL_pngInfo reads the real dimensions out of the file header");
  writePlain("C:/frames/info.txt", 5);
  assert(AELL_pngInfo(new File("C:/frames/info.txt")) === null,
         "AELL_pngInfo returns null for something that is not a PNG");
  assert(AELL_pngInfo(new File("C:/frames/absent.png")) === null,
         "AELL_pngInfo returns null rather than throwing on a missing file");
  delete FILES["c:\\frames\\info.png"];
}

// ------------------------------------------------- 3. snapshot_frame

{
  const r = call("snapshot_frame", { comp: "Shot", time: 1,
                                     path: "C:/frames/a.png" });
  assert(r.ok, "snapshot_frame writes a frame: " + (r.error || ""));
  assert(r.data.bytes > 0,
         "and reports real bytes - AE hides a new file, so a single look " +
         "would call this a failure");
  assert(r.data.width === 320 && r.data.height === 240,
         "and reports the PNG's OWN dimensions, read from the file");
  assert(r.data.compSize === "320x240",
         "and the comp size beside them, so a mismatch is visible");
  assert(r.data.frame === 24 && near(r.data.time, 1),
         "and which frame it took (" + r.data.frame + ")");
  assert(/import_as_layer/.test(r.data.next || ""),
         "and names the tool that puts it back in a comp");
  assert(!r.data.warning, "a full-size snapshot carries no warning");
}

{
  shot.time = 2;
  const r = call("snapshot_frame", { comp: "Shot", path: "C:/frames/b.png" });
  assert(r.ok && r.data.frame === 48,
         "with no 'time' it snapshots the comp's CURRENT time");
  assert(/current time/.test(r.data.timeNote || ""),
         "and says so, because the model did not choose it: " +
         (r.data.timeNote || "(nothing)"));
  shot.time = 0;
}

{
  const r = call("snapshot_frame", { comp: "Shot", time: 1,
                                     path: "C:/frames/c.jpg" });
  assert(r.ok && /\.png$/i.test(r.data.path),
         "a non-.png path is corrected: " + r.data.path);
  assert(/PNG bytes whatever the file is called/.test(r.data.pathNote || ""),
         "and the correction is explained, not silent");
  assert(!FILES["c:\\frames\\c.jpg"],
         "nothing is written to the .jpg the caller asked for");
}

{
  const r = call("snapshot_frame", { comp: "Shot", time: 1,
                                     path: "C:/frames/a.png" });
  assert(!r.ok && /already exists/i.test(r.error),
         "an existing file is REFUSED rather than replaced: " + r.error);
  assert(/silently|no undo/i.test(r.error),
         "and the refusal says why that matters: " + r.error);
  const w = call("snapshot_frame", { comp: "Shot", time: 1,
                                     path: "C:/frames/a.png",
                                     overwrite: true });
  assert(w.ok, "{overwrite: true} goes through: " + (w.error || ""));
}

{
  const r = call("snapshot_frame", { comp: "Shot", path: "frames/rel.png" });
  assert(!r.ok && /ABSOLUTE/i.test(r.error),
         "a relative path is refused: " + r.error);
  assert(/'path'/.test(r.error),
         "and the refusal names 'path', not render_comp's 'output': " +
         r.error);
}

{
  const before = silentNoOps;
  const r = call("snapshot_frame", { comp: "Shot",
                                     path: "C:/frames/gone/x.png" });
  assert(!r.ok && /does not exist/i.test(r.error),
         "a missing folder is refused: " + r.error);
  assert(silentNoOps === before,
         "and AE is never asked - an unchecked call writes NOTHING and " +
         "reports no error at all");
  assert(/C:\\frames/i.test(r.error),
         "the refusal names the deepest folder that does exist: " + r.error);
}

{
  const r = call("snapshot_frame", { comp: "Shot", time: 99,
                                     path: "C:/frames/far2.png" });
  assert(!r.ok && /outside/i.test(r.error),
         "an out-of-range time is refused: " + r.error);
  assert(/CLAMPS|blank/i.test(r.error),
         "and says what AE would have done instead: " + r.error);
  assert(!FILES["c:\\frames\\far2.png"], "no blank frame is left behind");
  const neg = call("snapshot_frame", { comp: "Shot", time: -5,
                                       path: "C:/frames/neg.png" });
  assert(!neg.ok && /outside/i.test(neg.error),
         "a negative time is refused the same way");
}

{
  const r = call("snapshot_frame", { comp: "Shot", time: "1.5",
                                     path: "C:/frames/str2.png" });
  assert(r.ok && r.data.frame === 36,
         "a QUOTED time is accepted, the way the rest of the panel does");
  const bad = call("snapshot_frame", { comp: "Shot", time: "soon",
                                       path: "C:/frames/bad.png" });
  assert(!bad.ok && /number of seconds/i.test(bad.error),
         "a non-numeric time is refused: " + bad.error);
}

{
  // The last frame is at duration - one frame, so a time ON the
  // duration must not ask AE for a frame past the end.
  const r = call("snapshot_frame", { comp: "Shot", time: 4,
                                     path: "C:/frames/end.png" });
  assert(r.ok && r.data.frame === 95,
         "time == duration lands on the LAST frame (" + r.data.frame + ")");
}

{
  shot.resolutionFactor = [2, 2];
  const r = call("snapshot_frame", { comp: "Shot", time: 1,
                                     path: "C:/frames/full.png" });
  assert(r.ok && r.data.width === 320 && r.data.height === 240,
         "a downsampled comp is still snapshotted at FULL size");
  assert(/put back the way it was/.test(r.data.resolutionNote || ""),
         "and the override is reported: " + (r.data.resolutionNote || ""));
  assert(shot.resolutionFactor[0] === 2 && shot.resolutionFactor[1] === 2,
         "the comp's own resolution is restored exactly");

  const keep = call("snapshot_frame", { comp: "Shot", time: 1,
                                        resolution: "comp",
                                        path: "C:/frames/downs.png" });
  assert(keep.ok && keep.data.width === 160 && keep.data.height === 120,
         "{resolution: 'comp'} keeps AE's downsample");
  assert(/not the comp's 320x240/.test(keep.data.warning || ""),
         "and the smaller frame is WARNED about, not hidden: " +
         (keep.data.warning || ""));
  assert(shot.resolutionFactor[0] === 2,
         "and the comp is left alone in that mode");

  const bad = call("snapshot_frame", { comp: "Shot", resolution: "half",
                                       path: "C:/frames/badres.png" });
  assert(!bad.ok && /'full'/.test(bad.error),
         "an invented resolution is refused with the real choices: " +
         bad.error);
  shot.resolutionFactor = [1, 1];
}

{
  // A throw mid-snapshot must not leave the user's comp switched to Full.
  shot.resolutionFactor = [4, 4];
  const real = shot.saveFrameToPng;
  shot.saveFrameToPng = function () { throw new Error("boom"); };
  const r = call("snapshot_frame", { comp: "Shot", time: 1,
                                     path: "C:/frames/throw.png" });
  shot.saveFrameToPng = real;
  assert(!r.ok && /boom/.test(r.error),
         "a failed save comes back as an error, not a throw: " + r.error);
  assert(shot.resolutionFactor[0] === 4,
         "and the comp's resolution is restored even when it throws");
  shot.resolutionFactor = [1, 1];
}

{
  const r = call("snapshot_frame", { comp: "No Such Comp",
                                     path: "C:/frames/x.png" });
  assert(!r.ok && /Shot/.test(r.error),
         "an unknown comp is refused with the list of real ones: " + r.error);
  const noPath = call("snapshot_frame", { comp: "Shot" });
  assert(!noPath.ok && /'path' is required/.test(noPath.error),
         "a missing path is refused: " + noPath.error);
}

// ----------------------------------------------- 4. import_as_layer

const wide = project.items.addComp("Wide", 800, 480, 1, 5, 24);
project.items.addComp("NTSC", 720, 480, 1.21212121212121, 5, 24);
writePng("C:/frames/src.png", 320, 240, 644);

{
  const r = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "Wide" });
  assert(r.ok, "import_as_layer places a file in a comp: " + (r.error || ""));
  assert(r.data.index === 1 && r.data.layer === "src.png",
         "the layer lands on top and takes the file's name");
  assert(r.data.sourceSize === "320x240" && r.data.compSize === "800x480",
         "and both sizes are reported, so the scale is checkable");
  // FACT 14: AE's own Fit to Comp Height on this exact rig.
  assert(near(r.data.scale[0], 200) && near(r.data.scale[1], 200),
         "the DEFAULT fit CONTAINS the image (200%) - got " +
         r.data.scale.join(","));
  assert(/whole comp/.test(r.data.stillNote || ""),
         "and a still is flagged as spanning the comp: " +
         (r.data.stillNote || ""));
}

{
  const before = wide.numLayers;
  wide.layer(1).selected = true;
  const marked = wide.layer(1);
  const r = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "Wide", fit: "fill",
                                      name: "Cover" });
  assert(r.ok && near(r.data.scale[0], 250) && near(r.data.scale[1], 250),
         "fit 'fill' COVERS (250%) - got " + (r.data.scale || []).join(","));
  assert(r.data.layer === "Cover", "and 'name' renames the layer");
  assert(marked.selected === true && wide.layer(1).selected === false,
         "and the user's selection survives the import (FACT 15)");
  assert(wide.numLayers === before + 1, "exactly one layer was added");
}

{
  const r = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "Wide", fit: "stretch" });
  assert(r.ok && near(r.data.scale[0], 250) && near(r.data.scale[1], 200),
         "fit 'stretch' reproduces AE's own Fit to Comp, 250 x 200 - got " +
         (r.data.scale || []).join(","));
  const w = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "Wide", fit: "width" });
  assert(w.ok && near(w.data.scale[0], 250) && near(w.data.scale[1], 250),
         "fit 'width' matches AE's Fit to Comp Width, 250 x 250");
  const h = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "Wide", fit: "height" });
  assert(h.ok && near(h.data.scale[0], 200) && near(h.data.scale[1], 200),
         "fit 'height' matches AE's Fit to Comp Height, 200 x 200");
  const n = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "Wide", fit: "none" });
  assert(n.ok && !n.data.scale,
         "fit 'none' leaves the layer at AE's own 100%");
  const c = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "Wide", fit: "CENTER" });
  assert(c.ok && c.data.fit === "none",
         "'center' is the same thing, and case does not matter");
  const bad = call("import_as_layer", { path: "C:/frames/src.png",
                                        comp: "Wide", fit: "squish" });
  assert(!bad.ok && /contain, default/.test(bad.error),
         "an invented fit is refused with the real list: " + bad.error);
}

{
  // FACT 14's other half: the pixel-aspect correction on X. AE's Fit to
  // Comp gave 272.727 x 200 here, NOT the pixel-only 225 x 200.
  const r = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "NTSC", fit: "stretch" });
  assert(r.ok && near(r.data.scale[0], 272.727) && near(r.data.scale[1], 200),
         "a non-square-pixel comp gets AE's PAR-corrected X scale - got " +
         (r.data.scale || []).join(","));
  assert(/pixel aspect/.test(r.data.pixelAspectNote || ""),
         "and the correction is explained: " +
         (r.data.pixelAspectNote || ""));
  const w = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "NTSC", fit: "width" });
  assert(w.ok && near(w.data.scale[0], 272.727) &&
         near(w.data.scale[1], 272.727),
         "and 'width' carries the corrected number to both axes, as AE does");
}

{
  const itemsBefore = project.numItems;
  const r = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "Shot" });
  assert(r.ok && project.numItems === itemsBefore,
         "a file already in the project is REUSED, not imported again");
  assert(r.data.reusedExisting === true &&
         /RELOADED/.test(r.data.reuseNote || ""),
         "and it is reloaded from disk, so a regenerated file shows: " +
         (r.data.reuseNote || ""));
}

{
  // A project that already holds two items for one path (AE allows it)
  // must not be silently half-used.
  writePng("C:/frames/twice.png", 100, 50, 300);
  project.importFile(new ImportOptions(new File("C:/frames/twice.png")));
  project.importFile(new ImportOptions(new File("C:/frames/twice.png")));
  const r = call("import_as_layer", { path: "C:/frames/twice.png",
                                      comp: "Shot" });
  assert(r.ok && /already holds 2 items/.test(r.data.warning || ""),
         "duplicate items for one file are reported: " +
         (r.data.warning || "(nothing)"));
}

{
  // import_file MEASURES what it imported. Nothing upstream can: the
  // caller knows only the size it ASKED for, and comfy_generate proved
  // that is a different number - the shipped KREA2 template upscales
  // 1.6x between its two passes, so a request for 1024x1024 saves a
  // 1640x1640 file and every decision made after the import (a comp
  // built to hold it, a scale) was being made from the wrong one.
  writePng("C:/frames/measured.png", 1640, 1640, 900);
  const r = call("import_file", { path: "C:/frames/measured.png" });
  assert(r.ok && r.data.width === 1640 && r.data.height === 1640,
         "import_file reports the size AE measured: " +
         JSON.stringify(r.data));
  assert(r.data.name && r.data.id > 0,
         "and still reports the item it made");
  assert(r.data.duration === undefined && r.data.frameRate === undefined,
         "a still carries no duration and no frame rate - reporting 0 " +
         "would read as '0 seconds': " + JSON.stringify(r.data));

  // Audio has a duration and no picture, and 0x0 must be ABSENT rather
  // than reported as a size, or a comp gets built around nothing.
  writePlain("C:/frames/track.wav", 2048);
  const a = call("import_file", { path: "C:/frames/track.wav" });
  assert(a.ok && a.data.width === undefined && a.data.height === undefined,
         "an audio file reports no dimensions rather than 0x0: " +
         JSON.stringify(a.data));
  assert(a.data.duration === 3,
         "and does report its duration: " + JSON.stringify(a.data));

  // The guard that matters in the field: importFile does not always
  // answer with an AVItem (an .aep comes back as a FolderItem), and a
  // host object with no `width` must not take the tool down with it.
  const items = project._items.slice();
  const realImport = project.importFile;
  project.importFile = function () {
    const folder = { name: "legacy.aep", id: 7777,
                     get width() { throw new Error("Unknown property"); },
                     get duration() { throw new Error("Unknown property"); },
                     get hasAudio() { throw new Error("Unknown property"); } };
    return folder;
  };
  writePlain("C:/frames/legacy.aep", 64);
  const f = call("import_file", { path: "C:/frames/legacy.aep" });
  project.importFile = realImport;
  project._items = items;
  assert(f.ok && f.data.name === "legacy.aep" && f.data.width === undefined,
         "an item with no measurable size still imports cleanly: " +
         JSON.stringify(f));
}

{
  const r = call("import_as_layer", { path: "C:/frames/notes.txt",
                                      comp: "Shot" });
  assert(!r.ok && /could not import/i.test(r.error),
         "a non-media file is refused: " + r.error);
  assert(/png|mov|wav/.test(r.error),
         "and the refusal says what AE DOES read: " + r.error);
  assert(project._items.filter((x) => x.name === "notes.txt").length === 0,
         "and nothing is left in the project");
}

{
  const miss = call("import_as_layer", { path: "C:/frames/absent.png",
                                         comp: "Shot" });
  assert(!miss.ok && /File not found/.test(miss.error),
         "a missing file is refused before AE is asked: " + miss.error);
  const rel = call("import_as_layer", { path: "frames/src.png",
                                        comp: "Shot" });
  assert(!rel.ok && /ABSOLUTE/.test(rel.error),
         "a relative path is refused, naming AE's working directory: " +
         rel.error);
  const none = call("import_as_layer", { comp: "Shot" });
  assert(!none.ok && /'path' is required/.test(none.error),
         "a missing path is refused: " + none.error);
}

{
  writePlain("C:/frames/beat.wav", 16044);
  const r = call("import_as_layer", { path: "C:/frames/beat.wav",
                                      comp: "Shot" });
  assert(r.ok && !r.data.scale,
         "an audio file is placed with nothing scaled: " + (r.error || ""));
  assert(/no picture/.test(r.data.note || ""),
         "and says why there is no fit: " + (r.data.note || ""));
}

{
  const r = call("import_as_layer", { path: "C:/frames/src.png",
                                      comp: "Wide", fit: "none",
                                      position: [10, 20] });
  assert(r.ok, "a position is accepted");
  const pos = wide.layer(1).property("ADBE Transform Group")
                  .property("ADBE Position").value;
  assert(pos[0] === 10 && pos[1] === 20 && pos.length === 3,
         "and is written keeping the scripting API's padded 3rd " +
         "component: " + pos.join(","));
}

// -------------------------------------------- 5. the round trip itself
//
// The point of the item: a frame taken out of a comp and put back into
// it must come back the same size, at 100%.
{
  const snap = call("snapshot_frame", { comp: "Wide", time: 0,
                                        path: "C:/frames/trip.png" });
  assert(snap.ok && snap.data.width === 800 && snap.data.height === 480,
         "ROUND TRIP: the snapshot is the comp's own size");
  const back = call("import_as_layer", { path: snap.data.path,
                                         comp: "Wide" });
  assert(back.ok && near(back.data.scale[0], 100) &&
         near(back.data.scale[1], 100),
         "ROUND TRIP: importing it back fits at exactly 100% - got " +
         ((back.data.scale || []).join(",")));
  assert(back.data.sourceSize === back.data.compSize,
         "ROUND TRIP: source and comp dimensions match (" +
         back.data.sourceSize + ")");
}

// ------------------------------------------------- 6. wiring and docs

{
  assert(AELL_MUTATING.import_as_layer === true,
         "import_as_layer is registered as mutating - one Ctrl+Z undoes it");
  assert(!AELL_MUTATING.snapshot_frame,
         "snapshot_frame is NOT: it changes nothing that survives the call, " +
         "so a successful one must never arm a rollback and spend the " +
         "round's one Ctrl+Z on somebody else's edit");
  assert(AELL_NO_UNDO_GROUP.snapshot_frame === true,
         "and it says so explicitly, the way render_comp does - a tool " +
         "documented as mutating owes the host one answer or the other");
}

{
  // An undocumented tool is unreachable by the model, so the docs are
  // part of the feature. Read them out of the source the way the rest of
  // the suite does.
  assert(/name: "snapshot_frame"/.test(toolsSrc),
         "snapshot_frame is DOCUMENTED in tools.js");
  assert(/name: "import_as_layer"/.test(toolsSrc),
         "import_as_layer is documented too");
  const snapAt = toolsSrc.indexOf('name: "snapshot_frame"');
  const snapDef = toolsSrc.slice(snapAt, snapAt + 1600);
  assert(/mutating: true/.test(snapDef),
         "snapshot_frame is 'mutating' for the dry run: it writes a file");
  assert(/overwrite/.test(snapDef),
         "its docs mention the overwrite refusal");
  assert(/current time/.test(snapDef),
         "and that 'time' defaults to the comp's current time");
  assert(/resolution/.test(snapDef),
         "and the full-resolution default");
  const impDef = toolsSrc.slice(toolsSrc.indexOf('name: "import_as_layer"'),
                                snapAt);
  assert(/mutating: true/.test(impDef), "import_as_layer is mutating");
  assert(/fit/.test(impDef) && /fill/.test(impDef) && /stretch/.test(impDef),
         "its docs explain the fit modes");
  assert(/REUSED|reused/.test(impDef),
         "and that an already-imported file is reused rather than doubled");
  const fileDef = toolsSrc.slice(toolsSrc.indexOf('name: "import_file"'),
                                 toolsSrc.indexOf('name: "import_as_layer"'));
  assert(/import_as_layer/.test(fileDef),
         "and import_file now points at it, since it only reaches the " +
         "project panel");
}

console.log("\n" + checks + " checks");
if (process.exitCode) console.log("SOME TESTS FAILED");
else console.log("ALL TESTS PASSED");
