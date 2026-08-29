// Regression test: speech -> timed captions (WORKPLAN 6.1 Pass C).
//
// Three pieces ship in that pass and this covers all three without After
// Effects and without a speech model:
//
//   render_comp_audio  (hostscript) — the comp's audio, or a refusal
//   add_captions       (hostscript) — N timed text layers / markers
//   Whisper.*          (panel)      — find the install, parse segments
//
// Every fact the stub models was measured against real AE 2026 and
// whisper.cpp b4938 / ggml-base.en on 2026-08-29:
//
//  1. A comp with NO audio layer STILL RENDERS a full, valid, audio-only
//     AIFF: status DONE, 772 674 bytes, no warning of any kind. And two
//     seconds of silence transcribes as the word "You" with exit code 0.
//     So the end of that pipeline is a caption layer reading "You" over a
//     comp nobody spoke in, and every step of it reports success. The
//     refusal has to happen before the render.
//  2. `layer.inPoint` is a SLIDE, not a trim: setting it DRAGS outPoint
//     along, preserving duration. A fresh text layer in a 5 s comp reads
//     in=0 out=5; after inPoint=2 it reads in=2 **out=7**. Setting out
//     before in therefore leaves every caption the wrong length, silently.
//  3. An INVERTED span is accepted in silence — in=2 then out=1 reads
//     back in=2 out=1, a layer of negative duration that never appears.
//     A zero-length span (in=1, out=1) is accepted too.
//  4. inPoint/outPoint QUANTIZE to AE's internal time base, not the frame
//     grid: 0.3333 reads back 0.33329264322917 and 1.7777 reads back
//     1.7777099609375. Anything comparing them needs a tolerance.
//  5. addText names the layer after its own text, so a transcript makes
//     layers called "this is quite a long caption line that goes on".
//  6. AE keeps ONE marker per exact time; a second one at the same
//     instant REPLACES the first and says nothing.
//  7. The only audio-only output module on the dev machine is called
//     "AIFF 48kHz", and the module forces .aif onto whatever path it is
//     handed. whisper.cpp decodes that AIFF directly through miniaudio —
//     measured, 682 ms for 5 s — so no WAV conversion is needed.
//  8. whisper-cli's timestamped lines are contiguous: one segment's end
//     is the next one's start.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const hostSrc = fs.readFileSync(
  path.join(ROOT, "extension", "jsx", "hostscript.jsx"), "utf8");
const toolsSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "tools.js"), "utf8");
const whisperSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "whisper.js"), "utf8");

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}
function near(a, b, tol) {
  return Math.abs(Number(a) - Number(b)) < (tol || 0.001);
}

// ============================================================ stubbed AE

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {
  LEFT_JUSTIFY: 7413, RIGHT_JUSTIFY: 7414, CENTER_JUSTIFY: 7415
};
const RQItemStatus = {
  QUEUED: 3015, RENDERING: 3016, DONE: 3019, UNQUEUED: 3014
};

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
function File(p) {
  this._p = norm(p);
  this.fsName = this._p;
  this.name = this._p.slice(this._p.lastIndexOf("\\") + 1);
}
Object.defineProperty(File.prototype, "exists", {
  get() { return !!FILES[this._p.toLowerCase()]; }
});
Object.defineProperty(File.prototype, "length", {
  get() {
    const r = FILES[this._p.toLowerCase()];
    return r ? r.bytes : -1;
  }
});
Object.defineProperty(File.prototype, "parent", {
  get() { const d = dirnameOf(this._p); return d ? new Folder(d) : null; }
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
  get() { const d = dirnameOf(this._p); return d ? new Folder(d) : null; }
});
Folder.temp = new Folder("C:\\Temp");
Folder.startup = new Folder("C:\\AE");
Folder.myDocuments = new Folder("C:\\Users\\probe\\Documents");

// --------------------------------------------------------- text layers

function TextDocument(text) {
  this.text = text || "";
  this.font = "MyriadPro-Regular";
  this.fontSize = 50;
  this.tracking = 0;
  this.leading = 60;
  this.autoLeading = true;
  this.applyFill = true;
  this.fillColor = [1, 1, 1];
  this.applyStroke = false;
  this.justification = ParagraphJustification.LEFT_JUSTIFY;
  this.baselineShift = 0;
  this.horizontalScale = 1;
  this.verticalScale = 1;
  this.fauxBold = false;
  this.fauxItalic = false;
  this.smallCaps = false;
  this.allCaps = false;
  this.superscript = false;
  this.subscript = false;
  this.tsume = 0;
  this.strokeWidth = 0;
}
TextDocument.prototype.clone = function () {
  const d = new TextDocument();
  for (const k of Object.keys(this)) d[k] = this[k];
  return d;
};

function TextProp(doc) { this._doc = doc; }
Object.defineProperty(TextProp.prototype, "value", {
  get() { return this._doc.clone(); }
});
TextProp.prototype.setValue = function (d) { this._doc = d; };

function Prop(v) { this._v = v; this.numKeys = 0; }
Object.defineProperty(Prop.prototype, "value", { get() { return this._v; } });
Prop.prototype.setValue = function (v) { this._v = v; };

// FACT 6: one marker per EXACT time; a second one replaces the first.
function MarkerValue(comment) { this.comment = comment; this.duration = 0; }
function MarkerProp() { this._keys = []; }
Object.defineProperty(MarkerProp.prototype, "numKeys", {
  get() { return this._keys.length; }
});
MarkerProp.prototype.keyTime = function (i) { return this._keys[i - 1].t; };
MarkerProp.prototype.keyValue = function (i) { return this._keys[i - 1].v; };
MarkerProp.prototype.setValueAtTime = function (t, v) {
  for (let i = 0; i < this._keys.length; i++) {
    if (Math.abs(this._keys[i].t - t) < 1e-9) { this._keys[i].v = v; return; }
  }
  this._keys.push({ t, v });
  this._keys.sort((a, b) => a.t - b.t);
};

// FACT 4: AE stores time on its own base, so a value written does not
// read back bit-identical. The exact drift measured on the dev machine
// (0.3333 -> 0.33329264322917) is a rational of 254016000 ticks/second.
const TICKS = 254016000;
function quantize(t) { return Math.round(Number(t) * TICKS) / TICKS; }

function Layer(name, comp, kind) {
  this.name = name;
  this._comp = comp;
  this.selected = false;
  this.enabled = true;
  this.index = comp._layers.length + 1;
  this.startTime = 0;
  this._in = 0;
  this._out = comp.duration;
  this.hasAudio = false;
  this.audioEnabled = true;
  this.threeDLayer = false;
  this._kind = kind;
  this._textProp = new TextProp(new TextDocument(kind === "text" ? name : ""));
  this._marker = new MarkerProp();
  this._pos = new Prop([comp.width / 2, comp.height / 2, 0]);
}
Object.defineProperty(Layer.prototype, "inPoint", {
  get() { return this._in; },
  // FACT 2: THE trap. inPoint is a SLIDE — it drags outPoint with it and
  // preserves the duration. A tool that sets out before in leaves every
  // caption the wrong length and AE never says a word.
  set(v) {
    const dur = this._out - this._in;
    this._in = quantize(v);
    this._out = quantize(this._in + dur);
  }
});
Object.defineProperty(Layer.prototype, "outPoint", {
  // FACT 3: outPoint is a plain trim and accepts anything, including a
  // value BEFORE inPoint (negative duration) or equal to it (zero).
  get() { return this._out; },
  set(v) { this._out = quantize(v); }
});
Layer.prototype.property = function (n) {
  if (n === "ADBE Text Properties") {
    const p = this._textProp;
    return { property(k) { return k === "ADBE Text Document" ? p : null; } };
  }
  if (n === "ADBE Marker") return this._marker;
  if (n === "ADBE Transform Group") {
    const pos = this._pos;
    return { property(k) { return k === "ADBE Position" ? pos : null; } };
  }
  return null;
};
Layer.prototype.remove = function () {
  const i = this._comp._layers.indexOf(this);
  if (i >= 0) this._comp._layers.splice(i, 1);
  for (let k = 0; k < this._comp._layers.length; k++) {
    this._comp._layers[k].index = k + 1;
  }
};

function asText(l) { Object.setPrototypeOf(l, Object.create(
  TextLayer.prototype, Object.getOwnPropertyDescriptors(Layer.prototype))); }
function asAV(l) { Object.setPrototypeOf(l, Object.create(
  AVLayer.prototype, Object.getOwnPropertyDescriptors(Layer.prototype))); }

let layerIds = 0;
function Comp(name, w, h, dur, fps) {
  this.name = name;
  this.width = w; this.height = h;
  this.duration = dur; this.frameRate = fps;
  this.time = 0;
  this.pixelAspect = 1;
  this.workAreaStart = 0;
  this.workAreaDuration = dur;
  this._layers = [];
  this.markerProperty = new MarkerProp();
  const self = this;
  this.layers = {
    // FACT 5: the new layer is NAMED AFTER ITS TEXT, and adding any
    // layer selects it and deselects everything else.
    addText(t) {
      const l = new Layer(String(t), self, "text");
      asText(l);
      l.id = ++layerIds;
      l._textProp._doc.text = String(t);
      for (const other of self._layers) other.selected = false;
      l.selected = true;
      self._layers.push(l);
      for (let k = 0; k < self._layers.length; k++) {
        self._layers[k].index = k + 1;
      }
      return l;
    }
  };
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

function makeComp(name, w, h, dur, fps) {
  const c = new Comp(name, w, h, dur, fps);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  return c;
}
function addAudioLayer(comp, name, opts) {
  const l = new Layer(name, comp, "av");
  asAV(l);
  l.id = ++layerIds;
  l.hasAudio = true;
  if (opts && opts.muted) l.audioEnabled = false;
  if (opts && opts.disabled) l.enabled = false;
  comp._layers.push(l);
  for (let k = 0; k < comp._layers.length; k++) comp._layers[k].index = k + 1;
  return l;
}

// ------------------------------------------------------- render queue
//
// FACT 7: only ONE audio-only module is installed, and it forces .aif.
const RS_TEMPLATES = ["Best Settings", "Draft Settings", "_HIDDEN X-Factor"];
let OM_TEMPLATES = ["AIFF 48kHz", "Alpha Only", "High Quality", "Lossless",
                    "Photoshop", "_HIDDEN X-Factor 8"];
const OM_EXT = { "AIFF 48kHz": "aif", "Lossless": "avi", "High Quality": "avi",
                 "Alpha Only": "avi", "Photoshop": "psd",
                 "_HIDDEN X-Factor 8": "avi" };

let suppressing = false;
function OutputModule(item) {
  this._item = item;
  this.name = "Lossless";
  this._file = new File("C:\\last\\" + item.comp.name + ".avi");
}
Object.defineProperty(OutputModule.prototype, "file", {
  get() { return this._file; },
  set(f) {
    const want = String(f.fsName || f);
    const ext = OM_EXT[this.name] || "avi";
    this._file = new File(/\.[^.\\]*$/.test(want)
      ? want.replace(/\.[^.\\]*$/, "." + ext) : want + "." + ext);
  }
});
Object.defineProperty(OutputModule.prototype, "templates", {
  get() { return OM_TEMPLATES.slice(0); }
});
OutputModule.prototype.applyTemplate = function (name) {
  if (OM_TEMPLATES.indexOf(name) < 0) {
    throw new Error("After Effects error: " + name +
                    " is not a valid template name.");
  }
  this.name = name;
  const ext = OM_EXT[name] || "avi";
  this._file = new File(this._file.fsName.replace(/\.[^.\\]*$/, "." + ext));
};

function RQItem(comp, queue) {
  this.comp = comp;
  this._queue = queue;
  this._status = RQItemStatus.QUEUED;
  this.render = true;
  this.timeSpanStart = 0;
  this.timeSpanDuration = comp.duration;
  this._om = new OutputModule(this);
}
Object.defineProperty(RQItem.prototype, "status", {
  get() { return this._status; },
  set() { throw new Error("readOnly"); }
});
Object.defineProperty(RQItem.prototype, "templates", {
  get() { return RS_TEMPLATES.slice(0); }
});
RQItem.prototype.outputModule = function (i) { return this._om; };
RQItem.prototype.applyTemplate = function (n) {
  if (RS_TEMPLATES.indexOf(n) < 0) throw new Error("bad rs template");
};
RQItem.prototype.remove = function () {
  const i = this._queue._items.indexOf(this);
  if (i >= 0) this._queue._items.splice(i, 1);
};

let rendered = [];
const renderQueue = {
  _items: [],
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  items: { add(comp) {
    const it = new RQItem(comp, renderQueue);
    renderQueue._items.push(it);
    return it;
  } },
  render() {
    for (const it of this._items) {
      if (!it.render || it._status !== RQItemStatus.QUEUED) continue;
      const out = it._om.file;
      if (!out.parent || !out.parent.exists) {
        throw new Error("Directory does not exist: " + out.parent.fsName);
      }
      // FACT 1: AE renders audio for a comp with no audio just as
      // happily as for one with. The stub writes bytes either way — the
      // whole point is that the file gives NOTHING away.
      FILES[out.fsName.toLowerCase()] = { bytes: 964674 };
      rendered.push({ path: out.fsName, module: it._om.name,
                      comp: it.comp.name });
      it._status = RQItemStatus.DONE;
    }
  }
};

const project = {
  _items: [],
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  rootFolder: { name: "(root)" },
  activeItem: null,
  renderQueue,
  items: { addComp(n, w, h, pa, d, f) {
    const c = makeComp(n, w, h, d, f);
    project._items.push(c);
    return c;
  } }
};

let undoDepth = 0;
const app = {
  project, version: "26.3x87", fonts: null,
  beginUndoGroup() { undoDepth++; },
  endUndoGroup() {
    if (undoDepth === 0) throw new Error("endUndoGroup with no group open");
    undoDepth--;
  },
  executeCommand() {}, findMenuCommandId() { return 0; },
  beginSuppressDialogs() { suppressing = true; },
  endSuppressDialogs() { suppressing = false; }
};
const $ = { global: {}, sleep() {}, hiresTimer: 0 };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_runTool: AELL_runTool, AELL_MUTATING: AELL_MUTATING, " +
  "AELL_NO_UNDO_GROUP: AELL_NO_UNDO_GROUP, " +
  "AELL_PER_LAYER: AELL_PER_LAYER, " +
  "AELL_audioTemplate: AELL_audioTemplate, " +
  // AE cannot gain a template while it runs, so the tool caches the list
  // for the session. Only a test can change it underneath, so only a test
  // needs this.
  "resetTemplateCache: function () { AELL_rqTemplateCache = null; } })");
const { AELL_TOOLS, AELL_runTool, AELL_MUTATING, AELL_NO_UNDO_GROUP,
        AELL_PER_LAYER, AELL_audioTemplate } = host;
const call = (t, a) => AELL_runTool(t, a || {});

// =================================================== 0. the stub is faithful
//
// Drive the raw API first: a stub that quietly stopped modelling the
// hazards would let every fix below pass on a technicality.

mkdirp("C:\\Temp");
mkdirp("C:\\last");

{
  const c = makeComp("Fidelity", 640, 480, 5, 24);
  const t = c.layers.addText("x");
  assert(t.inPoint === 0 && t.outPoint === 5,
         "STUB FIDELITY: a fresh text layer spans the whole comp");
  t.inPoint = 2;
  assert(near(t.inPoint, 2) && near(t.outPoint, 7),
         "STUB FIDELITY: inPoint DRAGS outPoint (in=2 -> out=7, not 5) — " +
         "got out=" + t.outPoint);
  t.outPoint = 3;
  assert(near(t.inPoint, 2) && near(t.outPoint, 3),
         "STUB FIDELITY: outPoint alone is a plain trim");
  const u = c.layers.addText("y");
  u.outPoint = 1; u.inPoint = 2;
  assert(near(u.outPoint, 3),
         "STUB FIDELITY: out-then-in is the WRONG order and produces the " +
         "wrong length (out=" + u.outPoint + ", not 1)");
  const v = c.layers.addText("z");
  v.inPoint = 2; v.outPoint = 1;
  assert(v.outPoint < v.inPoint,
         "STUB FIDELITY: AE accepts an INVERTED span in silence");
  const w = c.layers.addText("q");
  w.inPoint = 0.3333;
  assert(w.inPoint !== 0.3333 && near(w.inPoint, 0.3333, 1e-4),
         "STUB FIDELITY: times QUANTIZE (0.3333 -> " + w.inPoint + ")");
  assert(c.layers.addText("hello there").name === "hello there",
         "STUB FIDELITY: addText names the layer after its own text");
  const m = new MarkerProp();
  m.setValueAtTime(1, new MarkerValue("a"));
  m.setValueAtTime(1, new MarkerValue("b"));
  assert(m.numKeys === 1 && m.keyValue(1).comment === "b",
         "STUB FIDELITY: a second marker at the same exact time REPLACES");
}

// ================================================ 1. render_comp_audio

assert(typeof AELL_TOOLS.render_comp_audio === "function",
       "render_comp_audio exists");
assert(typeof AELL_TOOLS.add_captions === "function", "add_captions exists");

// FACT 7: which module is audio-only, chosen by format not by position.
assert(AELL_audioTemplate(OM_TEMPLATES) === "AIFF 48kHz",
       "the audio-only output module is found by format");
assert(AELL_audioTemplate(["Lossless", "WAV 44.1", "AIFF 48kHz"]) === "WAV 44.1",
       "a WAV module is preferred over AIFF when both are installed");
assert(AELL_audioTemplate(["Lossless", "High Quality"]) === "",
       "and nothing is invented when no audio module is installed");
assert(AELL_audioTemplate(["_HIDDEN AIFF"]) === "",
       "an _HIDDEN internal is never offered as the audio module");
assert(AELL_audioTemplate(["Aftermath Preview"]) === "",
       "'Aftermath' is not an AIFF module — the match is word-bounded");

const silentComp = project.items.addComp("Silent", 320, 240, 1, 4, 24);
const solid = new Layer("bg", silentComp, "av");
asAV(solid);
solid.id = ++layerIds;
silentComp._layers.push(solid);
project.activeItem = silentComp;

{
  // FACT 1: THE step. Without this refusal the render succeeds, whisper
  // hears "You", and a caption layer lands on a comp nobody spoke in.
  const r = call("render_comp_audio",
                 { comp: "Silent", output: "C:/Temp/silent.aif" });
  assert(!r.ok, "a comp with NO audio layer is REFUSED before any render");
  assert(/silence/i.test(r.error),
         "and the refusal says AE would render SILENCE: " + r.error);
  assert(r.error.indexOf("bg") >= 0,
         "and it names the layers that ARE there (grounded): " + r.error);
  assert(rendered.length === 0,
         "nothing reached the render queue");
  assert(renderQueue.numItems === 0, "and no queue item was left behind");
}

const spoken = project.items.addComp("Spoken", 640, 480, 1, 5, 24);
const vo = addAudioLayer(spoken, "VO.wav");
project.activeItem = spoken;

{
  vo.audioEnabled = false;
  const r = call("render_comp_audio",
                 { comp: "Spoken", output: "C:/Temp/muted.aif" });
  assert(!r.ok, "a comp whose only audio layer is MUTED is refused too");
  assert(/muted/i.test(r.error) && r.error.indexOf("VO.wav") >= 0,
         "and it names the muted layer: " + r.error);
  vo.audioEnabled = true;
}

{
  const r = call("render_comp_audio",
                 { comp: "Spoken", output: "C:/Temp/vo.wav" });
  assert(r.ok, "a comp with an audible layer renders: " +
         (r.ok ? "" : r.error));
  assert(rendered.length === 1 && rendered[0].module === "AIFF 48kHz",
         "the audio-only module was picked automatically");
  // FACT 7: the module forces .aif onto the path it was handed, so the
  // caller must use the path AE reports, not the one it asked for.
  assert(/\.aif$/i.test(r.data.output),
         "and the reported path is the one AE settled on (.aif, not the " +
         ".wav that was asked for): " + r.data.output);
  assert(r.data.audioLayers.indexOf("VO.wav") >= 0,
         "the result names the layers that went into the mix");
  assert(r.data.status === "DONE" && r.data.bytes > 0,
         "and it reports real bytes");
}

{
  const music = addAudioLayer(spoken, "Music.wav", { muted: true });
  rendered = [];
  const r = call("render_comp_audio",
                 { comp: "Spoken", output: "C:/Temp/vo2.aif" });
  assert(r.ok && /Music\.wav/.test(r.data.mutedLayers || ""),
         "a muted layer alongside an audible one is REPORTED, not refused");
  music.remove();
}

{
  const keep = OM_TEMPLATES;
  OM_TEMPLATES = ["Lossless", "High Quality", "Photoshop"];
  host.resetTemplateCache();
  const r = call("render_comp_audio",
                 { comp: "Spoken", output: "C:/Temp/none.aif" });
  assert(!r.ok, "no audio module installed is a refusal, not a video render");
  assert(r.error.indexOf("Lossless") >= 0 && r.error.indexOf("High Quality") >= 0,
         "and it lists what IS installed: " + r.error);
  OM_TEMPLATES = keep;
  host.resetTemplateCache();
}

{
  const r = call("render_comp_audio",
                 { comp: "Spoken", output: "relative/path.aif" });
  assert(!r.ok && /ABSOLUTE/i.test(r.error),
         "render_comp's path checks still apply (delegation is real)");
}

// ===================================================== 2. add_captions

const cap = project.items.addComp("Cap", 1920, 1080, 1, 5, 24);
project.activeItem = cap;

const SEGS = [
  { start: 0, end: 3.32, text: "The quick brown fox jumps over the lazy dog." },
  { start: 3.32, end: 4.9, text: "After effects renders the composition." }
];

{
  const before = cap.numLayers;
  const bad = [
    [[{ start: 1, end: 1, text: "x" }], /not after start/i,
     "a ZERO-length segment"],
    [[{ start: 2, end: 1, text: "x" }], /not after start/i,
     "an INVERTED segment"],
    [[{ start: -1, end: 1, text: "x" }], /before the start/i,
     "a NEGATIVE start"],
    [[{ start: 0, end: 1, text: "   " }], /non-empty string/i,
     "whitespace-only text"],
    [[{ start: 0, end: 1 }], /non-empty string/i, "missing text"],
    [[{ start: "soon", end: 1, text: "x" }], /'start' must be a number/i,
     "a non-numeric start"],
    [["just a string"], /not an object/i, "a segment that is not an object"]
  ];
  for (const [segments, re, what] of bad) {
    const r = call("add_captions", { comp: "Cap", segments });
    assert(!r.ok && re.test(r.error),
           what + " is refused, in words that say why: " +
           (r.ok ? "(accepted!)" : r.error));
  }
  assert(cap.numLayers === before,
         "and not one layer was created by any of those refusals");
}

{
  // Validation is up front: a bad segment LAST in the list must still
  // take the whole batch down, or half a transcript is left behind.
  const r = call("add_captions", { comp: "Cap", segments: [
    { start: 0, end: 1, text: "good" },
    { start: 1, end: 2, text: "also good" },
    { start: 3, end: 2, text: "bad" }
  ] });
  assert(!r.ok && /segment 3/.test(r.error),
         "a bad segment names its own index: " + (r.ok ? "(accepted)" : r.error));
  assert(cap.numLayers === 0,
         "and the two GOOD segments before it were not built either — " +
         "every segment is validated before anything is created");
}

{
  const r = call("add_captions", { comp: "Cap", segments: [] });
  assert(!r.ok && /required/i.test(r.error), "an empty segments array refuses");
  const r2 = call("add_captions", { comp: "Cap" });
  assert(!r2.ok && /required/i.test(r2.error), "and so does a missing one");
  const r3 = call("add_captions", { comp: "Cap", segments: SEGS, as: "titles" });
  assert(!r3.ok && /'as' must be/.test(r3.error),
         "an unknown 'as' is refused with the two that work: " + r3.error);
}

{
  const r = call("add_captions", { comp: "Cap", segments: SEGS });
  assert(r.ok, "two segments build: " + (r.ok ? "" : r.error));
  assert(cap.numLayers === 2, "one layer per segment");
  const a = cap.layer(1), b = cap.layer(2);
  // FACT 2: THE assertion of this file. Get the order wrong and these
  // read out=8.32 and out=8.22 instead.
  assert(near(a.inPoint, 0, 1e-4) && near(a.outPoint, 3.32, 1e-4),
         "caption 1 is trimmed to its own span — in=" + a.inPoint +
         " out=" + a.outPoint);
  assert(near(b.inPoint, 3.32, 1e-4) && near(b.outPoint, 4.9, 1e-4),
         "caption 2 is trimmed to its own span, NOT slid by inPoint — in=" +
         b.inPoint + " out=" + b.outPoint);
  assert(near(b.outPoint - b.inPoint, 1.58, 1e-3),
         "so its duration is the segment's 1.58s, not the comp's 5s");
  // FACT 5: not named after the transcript.
  assert(a.name === "Caption 1" && b.name === "Caption 2",
         "captions are named and numbered, not named after their text — " +
         "got '" + a.name + "', '" + b.name + "'");
  assert(a.property("ADBE Text Properties").property("ADBE Text Document")
          .value.text === SEGS[0].text,
         "and the TEXT is the segment's text");
  const pos = a.property("ADBE Transform Group").property("ADBE Position").value;
  assert(pos[0] === 960 && pos[1] === 918,
         "the default position is the lower third, centred — got " + pos);
  assert(a.property("ADBE Text Properties").property("ADBE Text Document")
          .value.justification === ParagraphJustification.CENTER_JUSTIFY,
         "with centre justification, so the text sits around that point");
  assert(r.data.captions === 2 && r.data.layers.length === 2,
         "the result reports what it built");
  while (cap.numLayers) cap.layer(1).remove();
}

{
  const r = call("add_captions", { comp: "Cap", segments: SEGS,
                                   name: "Sub", fontSize: 72,
                                   fillColor: [1, 1, 0], position: [100, 200],
                                   justification: "left" });
  assert(r.ok && cap.layer(1).name === "Sub 1" && cap.layer(2).name === "Sub 2",
         "'name' is the prefix for every caption");
  const doc = cap.layer(1).property("ADBE Text Properties")
                .property("ADBE Text Document").value;
  assert(doc.fontSize === 72, "fontSize reaches every caption");
  assert(near(doc.fillColor[1], 1) && near(doc.fillColor[2], 0),
         "and so does fillColor");
  assert(doc.justification === ParagraphJustification.LEFT_JUSTIFY,
         "an explicit justification overrides the caption default");
  const pos = cap.layer(1).property("ADBE Transform Group")
                .property("ADBE Position").value;
  assert(pos[0] === 100 && pos[1] === 200, "and so does an explicit position");
  while (cap.numLayers) cap.layer(1).remove();
}

{
  // A name already in the comp must not produce two layers AE cannot
  // tell apart — the same trap precompose had.
  const squatter = cap.layers.addText("x");
  squatter.name = "Caption 1";
  const r = call("add_captions", { comp: "Cap", segments: SEGS });
  assert(r.ok, "captions build alongside a layer already called Caption 1");
  const names = cap._layers.map(l => l.name);
  assert(new Set(names).size === names.length,
         "and every caption name is unique: " + names.join(", "));
  while (cap.numLayers) cap.layer(1).remove();
}

{
  const r = call("add_captions", { comp: "Cap", segments: [
    { start: 4, end: 9, text: "runs off the end" }
  ] });
  assert(r.ok, "a caption ending past the comp still builds");
  assert(/past/i.test(r.data.note || ""),
         "but the result SAYS it runs off the timeline: " + r.data.note);
  assert(near(cap.layer(1).outPoint, 9, 1e-4),
         "and the span it was asked for is the span it got");
  while (cap.numLayers) cap.layer(1).remove();
}

{
  // Adding a layer deselects everything else; the user's selection is
  // theirs, not the tool's.
  const mine = cap.layers.addText("user's own");
  mine.name = "Mine";
  mine.selected = true;
  const r = call("add_captions", { comp: "Cap", segments: SEGS });
  assert(r.ok && mine.selected === true,
         "the user's selection survives a caption batch");
  assert(cap.selectedLayers.length === 1,
         "and the captions did not add themselves to it");
  while (cap.numLayers) cap.layer(1).remove();
}

// ------------------------------------------------------------- markers

{
  const r = call("add_captions", { comp: "Cap", segments: SEGS,
                                   as: "markers" });
  assert(r.ok, "as:'markers' writes comp markers: " + (r.ok ? "" : r.error));
  assert(cap.numLayers === 0, "and creates no layers at all");
  assert(cap.markerProperty.numKeys === 2, "one marker per segment");
  assert(cap.markerProperty.keyValue(1).comment === SEGS[0].text,
         "the comment is the caption text");
  assert(near(cap.markerProperty.keyValue(1).duration, 3.32),
         "and the marker's DURATION is the segment's length — got " +
         cap.markerProperty.keyValue(1).duration);
  assert(r.data.markersAdded === 2, "the result counts what it wrote");
}

{
  // FACT 6: two segments starting at the same instant silently become
  // one marker. Counted, not hidden.
  cap.markerProperty._keys.length = 0;
  const r = call("add_captions", { comp: "Cap", as: "markers", segments: [
    { start: 1, end: 2, text: "first" },
    { start: 1, end: 3, text: "second, same instant" }
  ] });
  assert(r.ok && cap.markerProperty.numKeys === 1,
         "AE kept one marker for two same-time captions");
  assert(/collapsed|REPLACED/i.test(r.data.collapsed || ""),
         "and the result says so instead of claiming two: " +
         (r.data.collapsed || "(silent!)"));
  cap.markerProperty._keys.length = 0;
}

{
  const target = addAudioLayer(cap, "VO2.wav");
  const r = call("add_captions", { comp: "Cap", as: "markers",
                                   layer: "VO2.wav", segments: SEGS });
  assert(r.ok && target.property("ADBE Marker").numKeys === 2,
         "markers can land on a named layer instead of the comp");
  assert(cap.markerProperty.numKeys === 0, "and not on the comp as well");
  // 'layer' means nothing to a text caption; accepting it silently is how
  // for_each_layer {tool: add_captions} would build the transcript once
  // per selected layer.
  const r2 = call("add_captions", { comp: "Cap", layer: "VO2.wav",
                                    segments: SEGS });
  assert(!r2.ok && /only applies to/i.test(r2.error),
         "'layer' with text captions is REFUSED, not ignored: " +
         (r2.ok ? "(accepted!)" : r2.error));
  target.remove();
}

// ================================================ 3. registration

assert(AELL_MUTATING.add_captions === true,
       "add_captions is registered as mutating (one Ctrl+Z)");
assert(!AELL_NO_UNDO_GROUP.add_captions,
       "and it is NOT exempt from the undo group — it only adds layers");
assert(!AELL_MUTATING.render_comp_audio,
       "render_comp_audio is NOT in AELL_MUTATING: AE cannot render " +
       "inside an undo group");
assert(AELL_NO_UNDO_GROUP.render_comp_audio === true,
       "and it IS in AELL_NO_UNDO_GROUP, so a batch steps out for it");
assert(AELL_PER_LAYER.add_captions === true,
       "add_captions is classified for for_each_layer");

for (const t of ["render_comp_audio", "add_captions",
                 "transcribe_to_captions"]) {
  const re = new RegExp('name:\\s*"' + t + '"');
  assert(re.test(toolsSrc), t + " is documented in TOOL_DEFS " +
         "(an undocumented tool is unreachable by the model)");
}
assert(/name: "transcribe_to_captions", mutating: true/.test(toolsSrc),
       "transcribe_to_captions is marked mutating, so a dry run refuses it");
assert(/PANEL_TOOLS\.transcribe_to_captions/.test(toolsSrc),
       "and it is a PANEL tool — ExtendScript cannot spawn a child process");

// ============================================= 4. the whisper panel module

const wglobal = {
  Settings: { dataRoot: () => WHISPER_ROOT },
  AEBridge: { nodeRequire: (m) => require(m) }
};
let WHISPER_ROOT = path.join(os.tmpdir(), "aell-captions-test-" + process.pid);
new Function(whisperSrc).call(wglobal);
const Whisper = wglobal.Whisper;

// ----------------------------------------------------- the parser

const REAL_OUTPUT = "\n" +
"[00:00:00.000 --> 00:00:03.320]   The quick brown fox jumps over the lazy dog.\n" +
"[00:00:03.320 --> 00:00:06.240]   After effects renders the composition.\n" +
"[00:00:06.240 --> 00:00:09.900]   Export the timeline as a lossless master file.\n" +
"[00:00:09.900 --> 00:00:13.280]   The layer moves from the left side to the right side.\n" +
"[00:00:13.280 --> 00:00:15.720]   Captions appear underneath the picture.\n";

{
  const segs = Whisper.parseSegments(REAL_OUTPUT);
  assert(segs.length === 5,
         "the real five-sentence transcript parses to five segments — got " +
         segs.length);
  assert(segs[0].start === 0 && near(segs[0].end, 3.32),
         "timestamps become seconds — " + segs[0].start + ".." + segs[0].end);
  assert(segs[0].text === "The quick brown fox jumps over the lazy dog.",
         "the three spaces after the timestamp are not part of the caption");
  // FACT 8.
  let contiguous = true;
  for (let i = 1; i < segs.length; i++) {
    if (!near(segs[i].start, segs[i - 1].end)) contiguous = false;
  }
  assert(contiguous, "segments are contiguous — captions touch, not overlap");
  assert(near(segs[4].end, 15.72), "and the last one ends where it should");
}

{
  const segs = Whisper.parseSegments(
    "[00:01:02.500 --> 01:00:03.250]   over an hour in\n");
  assert(near(segs[0].start, 62.5) && near(segs[0].end, 3603.25),
         "hours and minutes are carried, not just seconds — " +
         segs[0].start + ".." + segs[0].end);
}

{
  const noisy =
    "whisper_init_from_file_with_params_no_state: loading model\n" +
    "system_info: n_threads = 4\n" +
    "[00:00:00.000 --> 00:00:01.000]   real speech\n" +
    "[00:00:01.000 --> 00:00:02.000]   [BLANK_AUDIO]\n" +
    "[00:00:02.000 --> 00:00:03.000]   [ Music ]\n" +
    "[00:00:03.000 --> 00:00:03.000]   zero length\n" +
    "[00:00:05.000 --> 00:00:04.000]   inverted\n" +
    "[00:00:06.000 --> 00:00:07.000]   \n" +
    "output_txt: saving output\n";
  const segs = Whisper.parseSegments(noisy);
  assert(segs.length === 1 && segs[0].text === "real speech",
         "banner lines, bracketed non-speech, empty, zero-length and " +
         "inverted spans are all dropped — got " +
         JSON.stringify(segs.map(s => s.text)));
}

assert(Whisper.parseSegments("").length === 0, "empty output parses to none");
assert(Whisper.parseSegments(null).length === 0, "and so does no output");
assert(Whisper.parseSegments("The quick brown fox.\n").length === 0,
       "text with NO timestamp is not a caption — that is what -nt output " +
       "looks like, and it carries no times to build with");

// --------------------------------------------- the silence signature
//
// FACT 1 again, from the other end: this is the shape of a recording
// nobody spoke in, and it arrives with exit code 0.

{
  const silent = Whisper.parseSegments(
    "[00:00:00.000 --> 00:00:02.000]   You\n");
  assert(silent.length === 1 && silent[0].text === "You",
         "silence parses as one segment reading 'You'");
  assert(Whisper.looksLikeSilence(silent) === true,
         "and looksLikeSilence recognises it");
  assert(Whisper.looksLikeSilence(
    Whisper.parseSegments("[00:00:00.000 --> 00:00:02.000]   Thank you.\n")),
    "so is the other thing it hears in silence, punctuation and all");
  assert(Whisper.looksLikeSilence(Whisper.parseSegments(REAL_OUTPUT)) === false,
         "a real transcript is not silence");
  assert(Whisper.looksLikeSilence([{ start: 0, end: 1, text: "Yes" }]) === false,
         "and neither is a genuine one-word caption that is not on the list");
  assert(Whisper.looksLikeSilence([]) === false, "nothing is not silence");
  assert(Whisper.looksLikeSilence([
    { start: 0, end: 1, text: "You" }, { start: 1, end: 2, text: "You" }
  ]) === false,
         "two segments are speech even when both are 'You' — the signature " +
         "is ONE short segment, not the word itself");
}

// ------------------------------------------- finding the install
//
// A real (tiny) tree on disk: the walk, the smallest-model rule and the
// three grounded refusals are all cheaper to prove for real than to fake.

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
}
rmrf(WHISPER_ROOT);

{
  const r = Whisper.find();
  assert(!r.ok && /get-whisper\.ps1/.test(r.reason),
         "no install at all is a grounded refusal naming the acquirer: " +
         r.reason);
}

const vend = path.join(WHISPER_ROOT, "vendor", "whisper.cpp");
fs.mkdirSync(path.join(vend, "bin", "Release"), { recursive: true });
fs.mkdirSync(path.join(vend, "models"), { recursive: true });

{
  fs.writeFileSync(path.join(vend, "bin", "Release", "main.exe"), "x");
  const r = Whisper.find();
  assert(!r.ok && /whisper-cli\.exe is not under/.test(r.reason),
         "main.exe alone is not the transcriber — it is a deprecation shim");
  assert(/main\.exe/.test(r.reason),
         "and the refusal lists the exes that ARE there: " + r.reason);
}

// The archive nests under Release\, so the exe is found by WALKING.
fs.writeFileSync(path.join(vend, "bin", "Release", "whisper-cli.exe"), "x");

{
  const r = Whisper.find();
  assert(!r.ok && /No ggml-\*\.bin model/.test(r.reason),
         "a binary with no model says exactly which half is missing: " +
         r.reason);
}

fs.writeFileSync(path.join(vend, "models", "ggml-large-v3.bin"),
                 Buffer.alloc(4096));
fs.writeFileSync(path.join(vend, "models", "ggml-base.en.bin"),
                 Buffer.alloc(64));

{
  const r = Whisper.find();
  assert(r.ok, "a complete install is found: " + r.reason);
  assert(/Release[\\/]whisper-cli\.exe$/.test(r.cli),
         "the exe is found NESTED under bin\\Release: " + r.cli);
  assert(/ggml-base\.en\.bin$/.test(r.model),
         "and the SMALLEST model is picked by file size, not by name " +
         "(large-v3 sorts first alphabetically): " + r.model);
  assert(r.models.length === 2, "every model present is reported");
}

{
  const r = Whisper.find("large-v3");
  assert(r.ok && /large-v3/.test(r.model), "a named model is honoured");
  const r2 = Whisper.find("ggml-medium.en.bin");
  assert(!r2.ok && /Present:/.test(r2.reason) && /base\.en/.test(r2.reason),
         "and a model that is not there lists what IS: " + r2.reason);
  assert(Whisper.find("ggml-base.en").ok && Whisper.find("base.en").ok,
         "'base.en', 'ggml-base.en' and the file name all name one model");
}

rmrf(WHISPER_ROOT);

console.log("\n" + checks + " checks");
if (process.exitCode) console.log("TESTS FAILED");
else console.log("ALL TESTS PASSED");
