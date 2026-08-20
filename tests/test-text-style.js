// Regression test: text styling, and above all the FONT path.
//
// Real AE 2026 accepts a PostScript name that is not installed. The
// TextDocument stores the bogus name verbatim, the layer renders in some
// substituted face, and the tool reports a cheerful success -- so the
// model believes "use Futura" worked when it did not.
//
// The trap is that the obvious check does not work. AE's
// getFontsByPostScriptName ECHOES whatever name it is handed:
//
//   getFontsByPostScriptName("NoSuchFont-Bogus999")[0].postScriptName
//     === "NoSuchFont-Bogus999"      // <- looks perfectly valid
//
// The ONLY reliable tell is isSubstitute on the returned FontObject, and
// allFonts is an array of ARRAYS (the FontObject is one level in). This
// stub models all three quirks, so the check cannot be "simplified" back
// into a name comparison without this test failing.
"use strict";
const fs = require("fs");
const path = require("path");

// --- the installed set, as AE reports it -----------------------------
const INSTALLED = ["AbrilFatface-Regular", "Aldrich-Regular", "ArialMT",
                   "Arial-BoldMT", "PowerCentra-Book", "Anton-Regular"];

function FontObject(psName, isSubstitute) {
  this.postScriptName = psName;
  this.isSubstitute = isSubstitute;
  this.familyName = psName.split("-")[0];
}

const fonts = {
  // Array of ARRAYS, exactly like AE.
  get allFonts() { return INSTALLED.map(n => [new FontObject(n, false)]); },
  getFontsByPostScriptName(name) {
    const known = INSTALLED.indexOf(name) !== -1;
    // Echoes the requested name either way; only isSubstitute differs.
    return [new FontObject(name, !known)];
  }
};

// --- text document ----------------------------------------------------
function TextDocument() {
  this.text = "hello";
  this.fontSize = 36;
  this.font = "PowerCentra-Book";
  this.tracking = 0;
  this.leading = 40;
  this.autoLeading = true;
  this.applyFill = false;
  this.fillColor = [0, 0, 0];
  this.justification = null;
}
TextDocument.prototype.clone = function () {
  const d = new TextDocument();
  for (const k of Object.keys(this)) d[k] = this[k];
  return d;
};

function TextProp(doc) { this._doc = doc; }
Object.defineProperty(TextProp.prototype, "value", {
  // AE hands back a COPY; edits only land via setValue.
  get() { return this._doc.clone(); }
});
TextProp.prototype.setValue = function (d) { this._doc = d; };

function Prop(v) { this._value = v; this.numKeys = 0; }
Object.defineProperty(Prop.prototype, "value", { get() { return this._value; } });
Prop.prototype.setValue = function (v) { this._value = v; };

function Layer(name, comp, isText) {
  this.name = name;
  this.comp = comp;
  this.selected = false;
  this.threeDLayer = false;
  this.parent = null;
  this._isText = !!isText;
  this._textProp = new TextProp(new TextDocument());
  this._transform = {
    "ADBE Position": new Prop([100, 100, 0]),
    "ADBE Scale": new Prop([100, 100, 100]),
    "ADBE Rotate Z": new Prop(0),
    "ADBE Opacity": new Prop(100),
    "ADBE Anchor Point": new Prop([0, 0, 0])
  };
}
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
// setValue SWAPS the document, so tests must read the live one rather
// than a reference captured at construction.
Object.defineProperty(Layer.prototype, "doc", {
  get() { return this._textProp._doc; }
});
Layer.prototype.property = function (name) {
  if (name === "ADBE Transform Group") {
    const t = this._transform;
    return { property(n) { return t[n]; } };
  }
  if (name === "ADBE Text Properties") {
    if (!this._isText) return null;
    const p = this._textProp;
    return { property(n) { return n === "ADBE Text Document" ? p : null; } };
  }
  return null;
};

function Comp(name) { this.name = name; this._layers = []; this.time = 0; }
Comp.prototype.layer = function (ref) {
  const l = typeof ref === "number" ? this._layers[ref - 1]
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
Comp.prototype.layers = null;

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7415,
                                 RIGHT_JUSTIFY: 7414 };
const KeyframeInterpolationType = { BEZIER: "bezier" };
const AutoOrientType = { CAMERA_OR_POINT_OF_INTEREST: 4214,
                         NO_AUTO_ORIENT: 4212 };
function KeyframeEase(speed, influence) {
  this.speed = speed; this.influence = influence;
}

const comp = new Comp("Text");
Object.setPrototypeOf(comp, Object.create(CompItem.prototype,
  Object.getOwnPropertyDescriptors(Comp.prototype)));
// set_text_style gates on `instanceof TextLayer`, so a stub layer that is
// merely shaped like one gets refused. Re-home each instance onto the real
// constructor while keeping Layer.prototype's getters and methods.
function asKind(layer, Kind) {
  Object.setPrototypeOf(layer, Object.create(Kind.prototype,
    Object.getOwnPropertyDescriptors(Layer.prototype)));
  return layer;
}
const textLayer = asKind(new Layer("ST Text", comp, true), TextLayer);
const solid = asKind(new Layer("NOTTEXT", comp, false), AVLayer);
comp._layers.push(textLayer, solid);
comp.layers = {
  addText(t) {
    const l = asKind(new Layer(t, comp, true), TextLayer);
    l.doc.text = t;
    comp._layers.push(l);
    return l;
  }
};

// The project must ENUMERATE, or resolving a comp by name cannot work
// (and its "Comps in this project:" grounded error would be empty).
const project = { rootFolder: { name: "(root)" }, numItems: 1,
                  item(i) { return i === 1 ? comp : null; },
                  items: {}, activeItem: comp };
const app = { project, fonts, beginUndoGroup() {}, endUndoGroup() {} };
const $ = { global: {} };

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "jsx",
                               "hostscript.jsx"), "utf8"));

function call(tool, args) {
  return JSON.parse($.global.AELL_call(tool, JSON.stringify(args)));
}
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// --- 1. an uninstalled font must be REFUSED, not silently accepted ----
const bogus = call("set_text_style", { comp: "Text", layer: "ST Text",
                                       font: "NoSuchFont-Bogus999" });
assert(!bogus.ok, "uninstalled font is refused (got ok=" + bogus.ok + ")");
assert(/not installed/i.test(bogus.error || ""),
       "refusal says the font is not installed");
assert(textLayer.doc.font === "PowerCentra-Book",
       "the refused font was NOT written to the document (got " +
       textLayer.doc.font + ")");

// --- 2. the refusal must be GROUNDED: name what IS installed ----------
const arial = call("set_text_style", { comp: "Text", layer: "ST Text",
                                       font: "Arial" });
assert(!arial.ok, "a family name ('Arial') is refused too");
assert(/ArialMT/.test(arial.error || ""),
       "refusal names the near match ArialMT (got: " + arial.error + ")");

// --- 3. installed fonts still work -----------------------------------
const good = call("set_text_style", { comp: "Text", layer: "ST Text",
                                      font: "AbrilFatface-Regular" });
assert(good.ok, "an installed font is accepted (" + (good.error || "") + ")");
assert(textLayer.doc.font === "AbrilFatface-Regular",
       "installed font written through");

// --- 4. a partial restyle must not drop the untouched fields ----------
call("set_text_style", { comp: "Text", layer: "ST Text", tracking: 20,
                         leading: 60 });
const partial = call("set_text_style", { comp: "Text", layer: "ST Text",
                                         fontSize: 24 });
assert(partial.ok && partial.data.style.fontSize === 24, "fontSize applied");
assert(textLayer.doc.tracking === 20 && textLayer.doc.leading === 60,
       "tracking/leading survive a fontSize-only restyle (got " +
       textLayer.doc.tracking + "/" + textLayer.doc.leading + ")");

// --- 5. leading can return to auto ------------------------------------
assert(textLayer.doc.autoLeading === false,
       "a numeric leading turned autoLeading off");
const auto = call("set_text_style", { comp: "Text", layer: "ST Text",
                                      leading: "auto" });
assert(auto.ok && textLayer.doc.autoLeading === true,
       "leading:'auto' restores autoLeading");
assert(auto.data.style.leading === "auto",
       "summary reports leading as auto (got " + auto.data.style.leading + ")");

// --- 6. grounded refusals for the other bad inputs --------------------
const badJust = call("set_text_style", { comp: "Text", layer: "ST Text",
                                         justification: "middle" });
assert(!badJust.ok && /left, center or right/.test(badJust.error || ""),
       "bad justification refused with the allowed values");
const notText = call("set_text_style", { comp: "Text", layer: "NOTTEXT",
                                         fontSize: 20 });
assert(!notText.ok, "a non-text layer is refused");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
