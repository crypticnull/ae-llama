// Regression test: render queue (WORKPLAN 5.5).
//
// `add_to_render_queue` shipped long ago with zero stub tests and zero
// suite steps, and nothing in the panel could ever RENDER. Five probes
// against real AE 2026 (26.3x87) measured the API first
// (WORKPLAN-LOG 2026-08-28), and the stub below encodes those
// measurements so the same bug class is caught WITHOUT After Effects:
//
//  1. `renderQueue.render()` renders the WHOLE QUEUE, not the item you
//     just added. Two fresh items, one call, both DONE. So a naive
//     "render this comp" also renders everything the user had queued.
//  2. `rqItem.render = false` quarantines an item: it stays QUEUED
//     (3015) and writes nothing. The flag does NOT reset itself, so it
//     has to be put back by hand.
//  3. Rendering onto a file that ALREADY EXISTS raises a MODAL. This is
//     the one that matters: unattended it wedged real AE mid-probe and
//     then swallowed every later -r script while the process still
//     reported as healthy. The stub raises a distinctive throw in that
//     case, because a test cannot model "hangs forever" any other way.
//  4. `app.beginSuppressDialogs()` suppresses it and genuinely
//     OVERWRITES — 64840 -> 698880 bytes when the second render was 12
//     frames rather than 1, so it is not a silent skip.
//  5. A missing output DIRECTORY throws instead of prompting
//     ("Directory does not exist: ..."), so it can be pre-checked.
//  6. `applyTemplate` REWRITES the file extension: an .mp4 became .avi
//     under "Lossless". Hence template first, file second.
//  7. A fresh output module inherits the LAST RENDER'S settings AND
//     FOLDER. On the probe machine an untouched item pointed at
//     Documents\ComfyUI\output\video\... — nothing to do with the
//     project. So an outputPath-less queue add is not neutral.
//  8. A bogus template name throws a message that does NOT list the
//     valid ones.
//  9. `status` is readOnly — a DONE item cannot be re-queued.
// 10. A file AE has just written reports `exists === false` to a
//     brand-new File object for ~300 ms. A tool that checks its own
//     output once would call a good render a failure.
// 11. AE lets the same comp sit in the queue twice and says nothing;
//     both copies then render.
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

const RQItemStatus = {
  WILL_CONTINUE: 3012, NEEDS_OUTPUT: 3013, UNQUEUED: 3014, QUEUED: 3015,
  RENDERING: 3016, USER_STOPPED: 3017, ERR_STOPPED: 3018, DONE: 3019
};

// ------------------------------------------------------- virtual disk
//
// FACT 10 lives here, and it is deliberately NOT applied to everything:
// the ~300 ms invisibility was measured on `saveFrameToPng`, while a
// file written by `renderQueue.render()` read back correctly on the
// first look. So `hidden` is opt-in, render output is visible at once,
// and the polling helper is proved against a file that really is hidden
// rather than by pretending renders behave that way.
const DIRS = {};
const FILES = {};
function mkdirp(p) { DIRS[norm(p).toLowerCase()] = true; }
function norm(p) { return String(p).replace(/\//g, "\\").replace(/\\+$/, ""); }
function dirnameOf(p) {
  const n = norm(p);
  const i = n.lastIndexOf("\\");
  return i <= 0 ? "" : n.slice(0, i);
}
function writeFile(p, bytes, hidden) {
  FILES[norm(p).toLowerCase()] = { bytes, hidden: hidden || 0 };
}

function File(p) {
  this._p = norm(p);
  this.fsName = this._p;
  this.name = this._p.slice(this._p.lastIndexOf("\\") + 1);
}
Object.defineProperty(File.prototype, "exists", {
  get() {
    const rec = FILES[this._p.toLowerCase()];
    if (!rec) return false;
    if (rec.hidden > 0) { rec.hidden--; return false; }   // FACT 10
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
Folder.startup = new Folder("C:\\Program Files\\Adobe\\AE\\Support Files");
Folder.myDocuments = new Folder("C:\\Users\\probe\\Documents");

// ------------------------------------------------------- render queue

// FACT 7: what a brand-new output module inherits. Nothing to do with
// this project — it is wherever the machine last rendered.
const INHERITED = "C:\\Users\\probe\\Documents\\ComfyUI\\output\\video\\LAST";

const RS_TEMPLATES = ["Best Settings", "Current Settings", "DV Settings",
  "Draft Settings", "Multi-Machine Settings", "_HIDDEN X-Factor"];
const OM_TEMPLATES = ["AIFF 48kHz", "Alpha Only",
  "H.264 - Match Render Settings - 15 Mbps", "High Quality", "Lossless",
  "Lossless with Alpha", "Photoshop", "TIFF Sequence with Alpha",
  "_HIDDEN X-Factor 8"];
// FACT 6: the extension each template imposes.
const OM_EXT = {
  "Lossless": "avi", "Lossless with Alpha": "avi",
  "H.264 - Match Render Settings - 15 Mbps": "mp4",
  "High Quality": "avi", "Photoshop": "psd",
  "TIFF Sequence with Alpha": "tif", "AIFF 48kHz": "aif",
  "Alpha Only": "avi", "_HIDDEN X-Factor 8": "avi"
};

let modalRaised = 0;

function OutputModule(item) {
  this._item = item;
  this.name = "H.264 - Match Render Settings - 15 Mbps";
  // FACT 7.
  this._file = new File(INHERITED + "\\" + item.comp.name + ".mp4");
}
Object.defineProperty(OutputModule.prototype, "file", {
  get() { return this._file; },
  // FACT 6: the output module ALWAYS forces its own extension, and it
  // does it on the SETTER, not at render time. Measured both ways: a
  // .mp4 set under "Lossless" reads straight back as .avi, an .avi set
  // under H.264 reads back as .mp4, and a path with no extension gets
  // one. So the path you asked for is not necessarily the path you get,
  // and the only honest thing to report is what om.file says afterwards.
  set(f) {
    const want = String(f.fsName || f);
    const ext = OM_EXT[this.name] || "avi";
    this._file = new File(/\.[^.\\]*$/.test(want)
      ? want.replace(/\.[^.\\]*$/, "." + ext)
      : want + "." + ext);
  }
});
Object.defineProperty(OutputModule.prototype, "templates", {
  get() { return OM_TEMPLATES.slice(0); }
});
OutputModule.prototype.applyTemplate = function (name) {
  if (OM_TEMPLATES.indexOf(name) < 0) {
    // FACT 8: AE names the offender but not the alternatives.
    throw new Error("After Effects error: " + name +
                    " is not a valid template name.");
  }
  this.name = name;
  // FACT 6: the extension is rewritten under the caller's feet.
  const ext = OM_EXT[name] || "avi";
  this._file = new File(this._file.fsName.replace(/\.[^.\\]*$/, "." + ext));
};

function RQItem(comp, queue) {
  this.comp = comp;
  this._queue = queue;
  this._status = RQItemStatus.QUEUED;
  this.render = true;
  this.elapsedSeconds = 0;
  this.timeSpanStart = 0;
  this.timeSpanDuration = comp.duration;
  this._om = new OutputModule(this);
}
Object.defineProperty(RQItem.prototype, "status", {
  get() { return this._status; },
  // FACT 9.
  set() {
    throw new Error("After Effects error: Unable to set \u201Cstatus\u201D. " +
                    "It is a readOnly attribute.");
  }
});
Object.defineProperty(RQItem.prototype, "templates", {
  get() { return RS_TEMPLATES.slice(0); }
});
RQItem.prototype.outputModule = function (i) {
  if (i !== 1) throw new Error("no output module " + i);
  return this._om;
};
RQItem.prototype.applyTemplate = function (name) {
  if (RS_TEMPLATES.indexOf(name) < 0) {
    throw new Error("After Effects error: " + name +
                    " is not a valid template name.");
  }
  this._rs = name;
  // FACT 13: applyTemplate RESETS Resolution to Full. Measured in AE
  // 2026 -- an item set to Quarter and then given "Best Settings" reads
  // back ({"x":1,"y":1}). This is why render_comp sets resolution AFTER
  // both templates, and it is the fact this stub exists to enforce.
  this._res = "Full";
};

// FACT 14: the render-queue ITEM answers getSettings() with a plain
// name-keyed map (unlike the OUTPUT MODULE, whose getSettings() throws
// -- 6.1 Pass C measured that). Resolution reads back as the NAME here.
const RES_FACTORS = { Full: 1, Half: 2, Third: 3, Quarter: 4 };
RQItem.prototype.getSettings = function () {
  return {
    "Quality": "Best",
    "Resolution": this._res || "Full",
    "Proxy Use": "Use No Proxies",
    "Time Span": "Work Area Only",
    "Time Span Duration": String(this.timeSpanDuration),
    "Skip Existing Files": "false"
  };
};
// FACT 15: getSetting("Resolution") does NOT answer the name -- it
// answers the JSON-ish pair, verbatim, curly braces and all. Anything
// that wants the word has to read getSettings().
RQItem.prototype.getSetting = function (key) {
  if (key !== "Resolution") return String(this.getSettings()[key]);
  const f = RES_FACTORS[this._res || "Full"];
  return '({"x":' + f + ',"y":' + f + '})';
};
// FACT 16: Resolution is written by NAME and by nothing else. A number,
// a lowercase name and the word "Custom" all take the same throw, and
// the message names a form the API will not actually accept from a
// script -- so a tool that passes anything but the four names is broken
// in a way only this throw reveals.
RQItem.prototype.setSetting = function (key, value) {
  if (key !== "Resolution") { this._other = value; return; }
  if (!Object.prototype.hasOwnProperty.call(RES_FACTORS, String(value))) {
    throw new Error("After Effects error: Invalid Value for key: " +
      "<Resolution>.  Missing or incorrect component.  Must have form: " +
      "\"x,y\".");
  }
  this._res = String(value);
};
RQItem.prototype.setSettings = function (map) {
  for (const k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k)) {
      this.setSetting(k, map[k]);
    }
  }
};
RQItem.prototype.remove = function () {
  const i = this._queue._items.indexOf(this);
  if (i >= 0) this._queue._items.splice(i, 1);
};

let suppressing = false;
const renderedFrames = [];
const renderQueue = {
  _items: [],
  rendering: false,
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  items: {
    add(comp) {
      const it = new RQItem(comp, renderQueue);
      renderQueue._items.push(it);
      return it;
    }
  },
  // FACT 1: the WHOLE queue, every time.
  render() {
    for (let i = 0; i < this._items.length; i++) {
      const it = this._items[i];
      // FACT 2: quarantined items are simply passed over.
      if (!it.render) continue;
      if (it._status !== RQItemStatus.QUEUED) continue;
      const out = it._om.file;
      const dir = out.parent;
      // FACT 5.
      if (!dir || !dir.exists) {
        throw new Error("After Effects error: Error in output for render " +
          "queue item " + (i + 1) + ", output module 1. Directory does " +
          "not exist: " + (dir ? dir.fsName : "?") + ".");
      }
      const rec = FILES[out.fsName.toLowerCase()];
      if (rec && !suppressing) {
        // FACT 3: in real AE this is a modal that never returns. A test
        // cannot hang, so it throws with a name the assertions can see.
        modalRaised++;
        throw new Error("AELL_STUB_MODAL: After Effects is showing an " +
          "overwrite dialog for " + out.fsName + " and will never return.");
      }
      // FACT 12: note where this render happened relative to any open
      // undo group. In AE this is what earns the "Undo group mismatch"
      // modal; here it is just a counter the assertions can read.
      if (undoDepth > 0) renderedInsideGroup++;
      // FACT 4: suppressed, it really does overwrite. Bytes scale with
      // the frames actually rendered, so a silent skip is visible.
      const frames = Math.max(1,
        Math.round(it.timeSpanDuration * it.comp.frameRate));
      // FACT 17: Resolution changes the FRAME AE writes, and the size is
      // ceil(dim / factor) on each axis -- NOT floor. Measured: a
      // 641x361 comp at Half writes 321x181, and 640x360 at Third writes
      // 214x120. Bytes here are raw-ish so a reduced render is visible
      // in the file, the way it was in the field (1 389 680 -> 352 880).
      const rf = RES_FACTORS[it._res || "Full"];
      const rw = Math.ceil(it.comp.width / rf);
      const rh = Math.ceil(it.comp.height / rf);
      renderedFrames.push({ width: rw, height: rh, path: out.fsName });
      // Bytes stay the FULL-resolution figure the earlier facts were
      // measured with, divided by the pixels no longer being written --
      // the field ratio was 1 389 680 -> 352 880 for Half, which is 3.94.
      writeFile(out.fsName, Math.round(64840 * frames / (rf * rf)));
      it._status = RQItemStatus.DONE;
      it.elapsedSeconds = 1;
    }
  }
};

// ------------------------------------------------------------- project

function Comp(name, w, h) {
  this.name = name;
  this.width = w || 640; this.height = h || 480;
  this.duration = 10; this.frameRate = 24;
  this.time = 0;
  this._layers = [];
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
Comp.prototype.openInViewer = function () {};

function makeComp(name, w, h) {
  const c = new Comp(name, w, h);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  return c;
}

const project = {
  _items: [],
  dirty: false,
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  rootFolder: { name: "(root)" },
  renderQueue,
  items: {
    addComp(name, w, h) {
      const c = makeComp(name, w, h);
      project._items.push(c);
      return c;
    },
    addFolder(name) {
      const f = { name, remove() {} };
      Object.setPrototypeOf(f, FolderItem.prototype);
      project._items.push(f);
      return f;
    }
  }
};

let suppressBalance = 0;
// FACT 12: AE cannot render inside an undo group. Its renderer closes
// the script's group out from under it, so the count goes wrong and AE
// raises a modal "Undo group mismatch" at some later endUndoGroup. The
// stub models the DEPTH so that rendering inside a group is a visible,
// catchable error here rather than a wedged After Effects in the field.
let undoDepth = 0;
let renderedInsideGroup = 0;
const app = {
  project, version: "26.3x87",
  beginUndoGroup() { undoDepth++; },
  endUndoGroup() {
    if (undoDepth === 0) throw new Error("endUndoGroup with no group open");
    undoDepth--;
  },
  executeCommand() {},
  beginSuppressDialogs() { suppressing = true; suppressBalance++; },
  endSuppressDialogs() { suppressing = false; suppressBalance--; }
};
const $ = { global: {}, hiresTimer: 0, sleep() {} };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool, " +
  "AELL_rqSettle: AELL_rqSettle, AELL_callBatch: AELL_callBatch, " +
  "AELL_NO_UNDO_GROUP: AELL_NO_UNDO_GROUP })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool, AELL_rqSettle,
        AELL_callBatch, AELL_NO_UNDO_GROUP } = host;
const call = (t, a) => AELL_runTool(t, a || {});

// ---------------------------------------------------------------- rig

mkdirp("C:\\renders");
mkdirp("C:\\renders\\deep");
mkdirp(INHERITED);
const shot = project.items.addComp("Shot", 320, 240);
project.items.addComp("Other", 320, 240);

assert(typeof AELL_TOOLS.render_comp === "function",
       "render_comp exists");
assert(typeof AELL_TOOLS.list_render_templates === "function",
       "list_render_templates exists");
assert(typeof AELL_TOOLS.add_to_render_queue === "function",
       "add_to_render_queue still exists");

// ------------------------------------------------ 1. the stub is faithful
//
// Drive the raw API first, so a stub that quietly stopped modelling the
// hazards cannot let the fixes pass on a technicality.

{
  const it = renderQueue.items.add(shot);
  it.outputModule(1).applyTemplate("Lossless");
  it.outputModule(1).file = new File("C:\\renders\\fidelity.avi");
  renderQueue.render();
  assert(FILES["c:\\renders\\fidelity.avi"],
         "STUB FIDELITY: a plain render writes the file");
  const it2 = renderQueue.items.add(shot);
  it2.outputModule(1).applyTemplate("Lossless");
  it2.outputModule(1).file = new File("C:\\renders\\fidelity.avi");
  let threw = "";
  try { renderQueue.render(); } catch (e) { threw = String(e); }
  assert(/AELL_STUB_MODAL/.test(threw),
         "STUB FIDELITY: rendering onto an existing file raises the modal");
  renderQueue._items.length = 0;
  delete FILES["c:\\renders\\fidelity.avi"];
}

{
  const a = renderQueue.items.add(shot);
  a.outputModule(1).file = new File("C:\\renders\\whole_a.avi");
  const b = renderQueue.items.add(shot);
  b.outputModule(1).file = new File("C:\\renders\\whole_b.avi");
  renderQueue.render();
  assert(a.status === RQItemStatus.DONE && b.status === RQItemStatus.DONE,
         "STUB FIDELITY: render() takes the WHOLE queue, not one item");
  renderQueue._items.length = 0;
  delete FILES["c:\\renders\\whole_a.avi"];
  delete FILES["c:\\renders\\whole_b.avi"];
}

{
  const om = renderQueue.items.add(shot).outputModule(1);
  assert(/ComfyUI/.test(om.file.fsName),
         "STUB FIDELITY: a fresh output module inherits the last render's " +
         "folder — " + om.file.fsName);
  om.applyTemplate("Lossless");
  om.file = new File("C:\\renders\\ext.mp4");
  assert(/\.avi$/.test(om.file.fsName),
         "STUB FIDELITY: the output module forces its own extension even " +
         "on an explicitly set path — " + om.file.fsName);
  om.applyTemplate("H.264 - Match Render Settings - 15 Mbps");
  om.file = new File("C:\\renders\\ext.avi");
  assert(/\.mp4$/.test(om.file.fsName),
         "STUB FIDELITY: and the other way round too — " + om.file.fsName);
  om.applyTemplate("Lossless");
  om.file = new File("C:\\renders\\noext");
  assert(/noext\.avi$/.test(om.file.fsName),
         "STUB FIDELITY: a path with no extension is given one — " +
         om.file.fsName);
  renderQueue._items.length = 0;
}

// -------------------------------------------- 2. an existing file is refused

{
  writeFile("C:\\renders\\taken.avi", 999);
  const before = modalRaised;
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/taken.avi", template: "Lossless" });
  assert(!r.ok, "an existing output is refused rather than rendered onto");
  assert(/already exists/i.test(r.error) && /overwrite/i.test(r.error),
         "and the refusal says how to proceed: " + r.error.slice(0, 90));
  assert(/modal/i.test(r.error),
         "and says WHY, because the alternative wedges AE: " +
         r.error.slice(0, 120));
  assert(modalRaised === before,
         "no modal was raised — the tool never let AE ask");
  assert(renderQueue.numItems === 0,
         "and nothing was left in the queue");
}

// ------------------------------------------ 3. overwrite:true really renders

{
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/taken.avi", template: "Lossless",
      overwrite: true, frames: 12 });
  assert(r.ok, "overwrite:true renders: " + (r.error || ""));
  assert(FILES["c:\\renders\\taken.avi"].bytes === 64840 * 12,
         "and the bytes prove it OVERWROTE rather than silently skipping " +
         "(got " + FILES["c:\\renders\\taken.avi"].bytes + ")");
  assert(r.data.status === "DONE", "status is reported by name: " +
         r.data.status);
  assert(r.data.bytes === 64840 * 12,
         "the reported byte count survives AE's write latency (got " +
         r.data.bytes + ")");
  assert(/12 frame/.test(r.data.timeSpan),
         "the frame count is reported: " + r.data.timeSpan);
  assert(suppressBalance === 0,
         "suppressDialogs was balanced — a leaked suppression would " +
         "silence every later dialog in the session");
  assert(renderQueue.numItems === 0,
         "the tool's own queue item is cleaned up, not left as litter");
}

// ------------------------------- 4. the user's queued items are NOT rendered

{
  const foreign = renderQueue.items.add(project._items[1]);   // "Other"
  foreign.outputModule(1).file = new File("C:\\renders\\foreign.avi");
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/mine.avi", template: "Lossless",
      overwrite: true, frames: 1 });
  assert(r.ok, "render ok alongside a foreign item: " + (r.error || ""));
  assert(!FILES["c:\\renders\\foreign.avi"],
         "the user's own queued comp was NOT rendered");
  assert(foreign.status === RQItemStatus.QUEUED,
         "and it is still QUEUED, not consumed (got " +
         foreign.status + ")");
  assert(foreign.render === true,
         "its render flag was put back — AE does not reset it");
  assert(/held back/i.test(r.data.heldBack || ""),
         "and the result says so: " + (r.data.heldBack || "(silent)"));
  assert(FILES["c:\\renders\\mine.avi"], "our own output did land");
  assert(renderQueue.numItems === 1 && renderQueue.item(1) === foreign,
         "the queue is exactly as the user left it");
  foreign.remove();
}

// -------------------------------------- 5. the flags come back after a THROW

{
  const foreign = renderQueue.items.add(project._items[1]);
  foreign.outputModule(1).file = new File("C:\\renders\\foreign2.avi");
  // A comp whose output folder vanishes mid-flight: the render throws.
  delete DIRS["c:\\renders\\deep"];
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/deep/x.avi", template: "Lossless" });
  assert(!r.ok, "a missing folder is refused");
  assert(/does not exist/i.test(r.error) && /C:\\renders/.test(r.error),
         "and the refusal names the deepest folder that DOES exist: " +
         r.error.slice(0, 130));
  assert(foreign.render === true,
         "a refusal before the render still leaves the user's flags alone");
  assert(renderQueue.numItems === 1,
         "and adds nothing to the queue");
  foreign.remove();
  mkdirp("C:\\renders\\deep");
}

// ------------------------------------------------- 6. template validation

{
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/tpl.avi", template: "MP4 Please" });
  assert(!r.ok, "a template AE does not have is refused");
  assert(/Lossless/.test(r.error) && /High Quality/.test(r.error),
         "and the refusal LISTS the installed ones, which AE's own throw " +
         "does not: " + r.error.slice(0, 120));
  assert(renderQueue.numItems === 0, "nothing queued for a bad template");

  const r2 = call("render_comp",
    { comp: "Shot", output: "C:/renders/tpl.avi", template: "lossless",
      renderSettings: "best settings", frames: 1 });
  assert(r2.ok, "a lowercase template name still finds it: " +
         (r2.error || ""));
  assert(r2.data.outputModule === "Lossless",
         "and the canonical name is reported back: " + r2.data.outputModule);
  assert(r2.data.renderSettings === "Best Settings",
         "same for render settings: " + r2.data.renderSettings);

  const r3 = call("render_comp",
    { comp: "Shot", output: "C:/renders/tpl2.avi",
      renderSettings: "Nope Settings" });
  assert(!r3.ok && /Best Settings/.test(r3.error),
         "a bad render-settings template lists the real ones too: " +
         String(r3.error).slice(0, 90));
}

// --------------------------------- 7. an extension AE overrode is reported

{
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/movie.mp4", template: "Lossless",
      frames: 1 });
  assert(r.ok, "render ok: " + (r.error || ""));
  assert(/\.avi$/i.test(r.data.output),
         "AE wrote the extension its template imposes: " + r.data.output);
  assert(/not \.mp4/.test(r.data.note || ""),
         "and the mismatch is called out rather than left as a surprise: " +
         (r.data.note || "(silent)"));
  assert(!FILES["c:\\renders\\movie.mp4"],
         "no .mp4 was created");

  // A path with no extension at all is not a mismatch — AE simply adds
  // one. Reporting "AE changed it" here would be noise on a perfectly
  // ordinary call.
  const r2 = call("render_comp",
    { comp: "Shot", output: "C:/renders/noext_out", template: "Lossless",
      frames: 1 });
  assert(r2.ok, "an extensionless output renders: " + (r2.error || ""));
  assert(/noext_out\.avi$/i.test(r2.data.output),
         "AE supplies the extension: " + r2.data.output);
  assert(!r2.data.note,
         "and that is not reported as AE overriding a choice: " +
         (r2.data.note || ""));
}

// ------------------------------------------------ 8. path sanity is checked

{
  const r = call("render_comp", { comp: "Shot", output: "renders/rel.avi" });
  assert(!r.ok && /ABSOLUTE/i.test(r.error),
         "a relative path is refused: " + String(r.error).slice(0, 80));
  const r2 = call("render_comp", { comp: "Shot" });
  assert(!r2.ok && /required/i.test(r2.error),
         "a missing output is refused: " + String(r2.error).slice(0, 80));
  assert(renderQueue.numItems === 0, "and neither queued anything");
}

// ------------------------------- 9. add_to_render_queue stops being silent

{
  const r = call("add_to_render_queue", { comp: "Shot" });
  assert(r.ok, "queue add still works: " + (r.error || ""));
  assert(/ComfyUI/.test(r.data.output || ""),
         "it reports the inherited destination AE would use: " +
         r.data.output);
  assert(/last render/i.test(r.data.note || "") &&
         /outputPath/.test(r.data.note || ""),
         "and warns that it is not the project's own folder: " +
         (r.data.note || "(silent)"));
  assert(r.data.status === "QUEUED",
         "status is a name, not 3015: " + r.data.status);

  const r2 = call("add_to_render_queue", { comp: "Shot" });
  assert(/already in the render queue/i.test(r2.data.warning || ""),
         "a duplicate queue entry is called out: " +
         (r2.data.warning || "(silent)"));

  const r3 = call("add_to_render_queue",
    { comp: "Shot", outputPath: "C:/nope/never/x.avi" });
  assert(!r3.ok && /does not exist/i.test(r3.error),
         "a missing output folder is refused up front: " +
         String(r3.error).slice(0, 80));
  assert(renderQueue.numItems === 2,
         "and the refusal queued nothing (queue still " +
         renderQueue.numItems + ")");

  // The default output module is H.264, so an .avi asked for here comes
  // back .mp4 — AE changed the destination and used to say nothing.
  const r4 = call("add_to_render_queue",
    { comp: "Shot", outputPath: "C:/renders/queued.avi" });
  assert(r4.ok, "queue add with an explicit path ok: " + (r4.error || ""));
  assert(/queued\.mp4$/i.test(r4.data.output),
         "AE forced the output module's own extension: " + r4.data.output);
  assert(/changed the destination/i.test(r4.data.note || ""),
         "and that is reported, not silently swallowed: " +
         (r4.data.note || "(silent)"));

  const r5 = call("add_to_render_queue",
    { comp: "Shot", outputPath: "C:/renders/kept.mp4" });
  assert(r5.ok && !r5.data.note,
         "a path AE keeps verbatim needs no warning");
  assert(/kept\.mp4$/i.test(r5.data.output),
         "and it is honoured: " + r5.data.output);
  renderQueue._items.length = 0;
}

// ------------------------------------------------- 10. template listing

{
  const before = renderQueue.numItems;
  const r = call("list_render_templates", {});
  assert(r.ok, "list_render_templates ok: " + (r.error || ""));
  assert(r.data.outputModules.indexOf("Lossless") >= 0,
         "output-module templates are listed");
  assert(r.data.renderSettings.indexOf("Best Settings") >= 0,
         "render-settings templates are listed");
  assert(renderQueue.numItems === before,
         "and reading them leaves the queue exactly as it was — AE only " +
         "exposes the lists through a live item");
  assert(/_HIDDEN/.test(r.data.note || ""),
         "the note warns off AE's internal _HIDDEN entries: " +
         (r.data.note || "(silent)"));
}

// -------------------------------------- 11. AE's write latency is survived
//
// Measured on saveFrameToPng: a file AE has just written reports
// exists === false to a brand-new File object for ~300 ms, then appears.
// render_comp polls instead of looking once, so a good render is never
// reported as a missing file.

{
  writeFile("C:\\renders\\slow.avi", 4242, 3);
  assert(new File("C:\\renders\\slow.avi").exists === false,
         "STUB FIDELITY: a just-written file is invisible on the first " +
         "look, so a single check would call it missing");
  assert(AELL_rqSettle(new File("C:\\renders\\slow.avi"), 10) === 4242,
         "polling finds it anyway and reports the real size");
  writeFile("C:\\renders\\never.avi", 1, 99);
  assert(AELL_rqSettle(new File("C:\\renders\\never.avi"), 3) === -1,
         "a file that truly never appears is reported as -1, not invented");
  delete FILES["c:\\renders\\slow.avi"];
  delete FILES["c:\\renders\\never.avi"];
}

// ------------------------ 12. a render never happens inside an undo group
//
// The bug this pass shipped and then caught in real AE: render_comp was
// registered as mutating, AELL_call/AELL_callBatch wrapped it in an undo
// group, and After Effects raised a modal "Undo group mismatch" that
// wedged an unattended AE. Both routes to a render are checked here.

{
  writeFile("C:\\renders\\grp.avi", 1);
  renderedInsideGroup = 0;
  undoDepth = 0;
  const batch = JSON.parse(AELL_callBatch(JSON.stringify([
    { tool: "add_to_render_queue",
      args: { comp: "Shot", outputPath: "C:/renders/grp_q.avi" } },
    { tool: "render_comp",
      args: { comp: "Shot", output: "C:/renders/grp.avi",
              template: "Lossless", frames: 1, overwrite: true } }
  ]), "{}"));
  assert(batch.ok, "a batch mixing a mutation and a render runs: " +
         (batch.error || ""));
  assert(batch.data.results[0].ok && batch.data.results[1].ok,
         "both commands succeeded: " +
         JSON.stringify(batch.data.results.map(r => r.ok)));
  assert(renderedInsideGroup === 0,
         "the render happened OUTSIDE the batch's undo group — inside " +
         "one, AE raises the modal that wedged this pass");
  assert(undoDepth === 0,
         "and the group the batch opened is the group it closed " +
         "(depth " + undoDepth + ")");
  renderQueue._items.length = 0;
  delete FILES["c:\\renders\\grp.avi"];
  delete FILES["c:\\renders\\grp_q.avi"];
}

// ---------------- 14. resolution: rendering FEWER PIXELS, not smaller ones
//
// The export path renders a lossless master and then scales it down, so
// a 4K comp going to a 480 px GIF moved 24 MB a frame to keep 0.4. AE
// can render the smaller frame itself. Everything below is a measured
// AE 2026 fact first and an assertion second.

{
  // STUB FIDELITY first, driving the raw API: if the stub ever stops
  // modelling the reset, the ordering test after it passes for free.
  const it = renderQueue.items.add(shot);
  it.setSetting("Resolution", "Quarter");
  assert(it.getSettings()["Resolution"] === "Quarter",
         "STUB FIDELITY: getSettings() answers Resolution by NAME");
  assert(it.getSetting("Resolution") === '({"x":4,"y":4})',
         "STUB FIDELITY: getSetting() answers the PAIR, not the name — " +
         it.getSetting("Resolution"));
  it.applyTemplate("Best Settings");
  assert(it.getSettings()["Resolution"] === "Full",
         "STUB FIDELITY: applyTemplate RESETS Resolution to Full — this " +
         "is why the tool must set it last");
  let threw = "";
  try { it.setSetting("Resolution", "half"); } catch (e) { threw = String(e); }
  assert(/Must have form/.test(threw),
         "STUB FIDELITY: AE takes the NAME and nothing else — a lowercase " +
         "one throws: " + threw.slice(0, 80));
  threw = "";
  try { it.setSetting("Resolution", 2); } catch (e) { threw = String(e); }
  assert(/Must have form/.test(threw),
         "STUB FIDELITY: and so does a bare number");
  it.remove();
  renderQueue._items.length = 0;
}

{
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/half.avi", template: "Lossless",
      resolution: "half", frames: 4 });
  assert(r.ok, "render_comp takes {resolution}: " + (r.error || ""));
  assert(r.data.resolution === "Half",
         "and reports the resolution AE confirms, by name: " +
         r.data.resolution);
  assert(/^160x120/.test(r.data.renderedSize || ""),
         "and the SIZE AE actually wrote, not the comp's — " +
         r.data.renderedSize);
  assert(/comp is 320x240/.test(r.data.renderedSize || ""),
         "naming the comp's own size beside it, because a caller that " +
         "scales afterwards is scaling from the smaller number: " +
         r.data.renderedSize);
  assert(FILES["c:\\renders\\half.avi"].bytes === Math.round(64840 * 4 / 4),
         "and a quarter of the bytes reached the disk (got " +
         FILES["c:\\renders\\half.avi"].bytes + ")");
}

{
  // THE bug class this section exists for. Set before applyTemplate --
  // the obvious place, next to the other settings -- and AE silently
  // renders at Full while the tool reports success.
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/order.avi", template: "Lossless",
      renderSettings: "Best Settings", resolution: "quarter", frames: 2,
      overwrite: true });
  assert(r.ok, "a render-settings template and a resolution together: " +
         (r.error || ""));
  assert(r.data.resolution === "Quarter",
         "the resolution SURVIVES applyTemplate — set any earlier and AE " +
         "resets it to Full and says nothing (got " + r.data.resolution + ")");
  assert(/^80x60/.test(r.data.renderedSize || ""),
         "and the frame really is a quarter: " + r.data.renderedSize);
  assert(!r.data.resolutionWarning,
         "no warning, because what AE reports is what was asked for");
}

{
  const odd = project.items.addComp("Odd", 641, 361);
  const r = call("render_comp",
    { comp: "Odd", output: "C:/renders/odd.avi", template: "Lossless",
      resolution: "third", frames: 1 });
  assert(r.ok, "an odd-sized comp renders reduced: " + (r.error || ""));
  assert(/^214x121/.test(r.data.renderedSize || ""),
         "AE rounds each axis UP, not down: 641/3 is 214 and 361/3 is " +
         "121, measured — " + r.data.renderedSize);
  void odd;
}

{
  const forms = [["QUARTER", "Quarter"], ["1/2", "Half"], [3, "Third"],
                 ["Full", "Full"], [1, "Full"]];
  for (let i = 0; i < forms.length; i++) {
    const r = call("render_comp",
      { comp: "Shot", output: "C:/renders/forms.avi", template: "Lossless",
        resolution: forms[i][0], frames: 1, overwrite: true });
    assert(r.ok && r.data.resolution === forms[i][1],
           "\"" + forms[i][0] + "\" means " + forms[i][1] + " — a user " +
           "who says \"half\" or \"1/2\" gets the same render (got " +
           (r.ok ? r.data.resolution : r.error) + ")");
  }
}

{
  const before = renderQueue.numItems;
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/bad.avi", template: "Lossless",
      resolution: "35%" });
  assert(!r.ok, "an arbitrary percentage is refused — AE has no such thing");
  assert(/Full/.test(r.error) && /Quarter/.test(r.error),
         "and the refusal LISTS the four AE really offers: " +
         r.error.slice(0, 120));
  assert(renderQueue.numItems === before && !FILES["c:\\renders\\bad.avi"],
         "nothing was queued and nothing was written for a bad value");
}

{
  const r = call("render_comp",
    { comp: "Shot", output: "C:/renders/plain.avi", template: "Lossless",
      frames: 1, overwrite: true });
  assert(r.ok && r.data.resolution === "Full",
         "no {resolution} still reports what AE used: " +
         (r.ok ? r.data.resolution : r.error));
  assert(r.data.renderedSize === "320x240",
         "and a full render says the size plainly, with no comparison " +
         "nobody needs: " + r.data.renderedSize);
}

// ------------------------------------------- 13. registry + documentation

{
  // FACT 12, and the one that cost this pass a wedged AE: AE cannot
  // render inside an undo group. With render_comp in AELL_MUTATING the
  // suite rendered fine and AE then raised a modal "Undo group mismatch"
  // — its renderer closes the script's group out from under it, so the
  // count goes wrong and the warning surfaces at some innocent
  // endUndoGroup later in the run.
  assert(!AELL_MUTATING.render_comp,
         "render_comp is NOT in the host's undo-group map — AE cannot " +
         "render inside an undo group and raises a modal if it tries");
  assert(AELL_NO_UNDO_GROUP.render_comp === true,
         "and it is listed as must-not-be-grouped, so a BATCH that also " +
         "mutates steps out of its group for the render");
  assert(/name: "render_comp"[\s\S]*?mutating: true/.test(
           toolsSrc.slice(toolsSrc.indexOf('name: "render_comp"') - 40)) ||
         /mutating: true[\s\S]{0,80}name: "render_comp"/.test(toolsSrc),
         "but it IS mutating in tools.js, so a dry run still refuses to " +
         "burn a real render — the two maps mean different things");
  assert(!AELL_MUTATING.list_render_templates,
         "list_render_templates is NOT, so a dry run still lists them " +
         "and a successful read cannot arm the round rollback");
  assert(/name: "render_comp"/.test(toolsSrc),
         "render_comp is documented in tools.js — an undocumented tool " +
         "is unreachable by the model");
  assert(/name: "list_render_templates"/.test(toolsSrc),
         "list_render_templates is documented too");
  const def = toolsSrc.slice(toolsSrc.indexOf('name: "render_comp"'),
                             toolsSrc.indexOf('name: "list_render_templates"'));
  assert(/overwrite/.test(def) && /ABSOLUTE/.test(def),
         "and its docs name the two arguments that decide whether it " +
         "wedges AE");
  assert(/Blocks until/i.test(def),
         "and warn that it blocks, like comfy_generate does");
}

console.log("\n" + checks + " checks");
if (process.exitCode) console.log("SOME TESTS FAILED");
else console.log("ALL TESTS PASSED");
