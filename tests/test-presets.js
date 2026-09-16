// Regression test: list_presets + apply_preset (WORKPLAN 5.3).
//
// Three probes against real AE 2026 measured what layer.applyPreset()
// actually does (WORKPLAN-LOG 2026-08-28). The stub below encodes those
// measurements, so the bug class is caught WITHOUT After Effects:
//
//  1. applyPreset applies to the comp's SELECTION, not to the receiver.
//     With TWO layers selected, ONE call put the preset on BOTH.
//  2. With NOTHING selected it does not touch the receiver either: AE
//     invents a comp-sized solid ("Solid 6"), applies the preset THERE,
//     selects it and leaves the target alone. So a naive call is not a
//     no-op, it is litter.
//  3. A preset built for another layer type is a SILENT no-op — a Text
//     preset on a solid added no effect, no key, no expression and threw
//     nothing. Only a before/after census can tell that from success.
//  4. A text preset can add ZERO effects and only keyframes; one effect
//     preset (Backgrounds/Anime Radial) added TEN effects. "Did it work"
//     therefore counts effects AND expressions AND keys.
//  5. A bad path DOES throw ("Path is not valid").
//  6. A LOCKED layer still takes a preset — AE does not refuse.
//  7. Cameras have no Effect Parade and took nothing at all.
//  8. File.name is URI-ENCODED ("Bungee%20In.ffx"); displayName is not.
//  9. Documents may be redirected (OneDrive on the probe machine), so the
//     user-preset root has to come from Folder.myDocuments, and the
//     version folder is any "After Effects*" with a "User Presets" child.
// 10. Whether the comp is open in a viewer makes no difference, and
//     comp.time is untouched.
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

// --------------------------------------------------------- stubbed AE types

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};
const PropertyType = { PROPERTY: 6270, INDEXED_GROUP: 6271,
                       NAMED_GROUP: 6272 };

// ------------------------------------------------------ stubbed file system
//
// FACT 9: the app tree hangs off Folder.startup, the user tree off
// Folder.myDocuments, which here is redirected into OneDrive exactly as it
// is on the machine the probes ran on.

const START = "C:\\PF\\Adobe\\Adobe After Effects 2026\\Support Files";
const DOCS = "C:\\Users\\mr\\OneDrive\\Documents";

// Each .ffx carries what applying it DOES, measured shapes only:
//   effects: names added to the Effect Parade
//   keys:    keyframes/expressions added elsewhere on the layer
//   needs:   "text" = a Text-category preset (silent no-op elsewhere)
const P = (effects, keys, needs, controls) =>
  ({ effects, keys, needs: needs || "", controls: !!controls });
const TREE = {
  [START]: {
    Presets: {
      Behaviors: {
        "Wiggle - position.ffx": P(["Wiggle - position", "(Transform)"], 1),
        "Drift Over Time.ffx": P(["(Transform)"], 1),
        "Blinking Opacity.ffx": P(["(Transform)"], 1),
        // Shares the word "Fade" with a Text preset two folders away:
        // AE's own library is full of these, and a bare "Fade" must be
        // refused rather than guessed at.
        "Fade In+Out - frames.ffx": P(["(Transform)"], 2)
      },
      "Image - Utilities": {
        "Flip.ffx": P(["(Transform)"], 2),
        "Invert Alpha.ffx":
          P(["Invert Alpha", "Clip to Object Alpha", "Clean Up Edges"], 0)
      },
      Backgrounds: {
        // Ten effects from one preset, measured.
        "Anime Radial.ffx": P(["FX1", "FX2", "FX3", "FX4", "FX5", "FX6",
                               "FX7", "FX8", "FX9", "FX10"], 8)
      },
      Text: {
        "Animate In": {
          // FACT 4: no effects at all, only keyframes.
          "Fade Up Characters.ffx": P([], 2, "text"),
          "Drop In By Character.ffx": P([], 2, "text"),
          // FACT 11: a Text preset that carries expression CONTROLS lands
          // PARTIALLY on a non-text layer -- the six sliders arrive, the
          // animation does not.
          "Alternating Characters In.ffx":
            P(["Completion", "Y Position Offset", "Reveal",
               "Animator Width", "Ease In", "Ease Out"], 2, "text", true)
        }
      },
      Shapes: { "Bungee In.ffx": P(["(Transform)"], 2) }
    }
  },
  [DOCS]: {
    Adobe: {
      // A sibling that is NOT an AE folder, and an AE folder with no
      // User Presets child: neither may contribute.
      "Premiere Pro": { "User Presets": { "not-mine.ffx": P([], 1) } },
      "After Effects": {},
      "After Effects 2026": {
        "User Presets": {
          "(Adobe)": { "House Style.ffx": P(["House"], 3) },
          "My Look.ffx": P(["Look A", "Look B"], 1)
        }
      }
    }
  }
};

function splitPath(p) {
  return String(p).replace(/\//g, "\\").split("\\").filter(s => s !== "");
}
function nodeAt(p) {
  const segs = splitPath(p);
  // The two roots are addressed by their whole prefix.
  for (const root of [START, DOCS]) {
    const rs = splitPath(root);
    if (segs.length >= rs.length &&
        rs.every((s, i) => s.toLowerCase() === segs[i].toLowerCase())) {
      let node = TREE[root];
      for (let i = rs.length; i < segs.length; i++) {
        if (!node || typeof node !== "object") return undefined;
        const key = Object.keys(node)
          .find(k => k.toLowerCase() === segs[i].toLowerCase());
        if (key === undefined) return undefined;
        node = node[key];
      }
      return node;
    }
  }
  return undefined;
}
function joinPath(p, child) {
  return String(p).replace(/\//g, "\\").replace(/\\+$/, "") + "\\" + child;
}
function isFolderNode(n) {
  return n !== undefined && n !== null && typeof n === "object" &&
         !Object.prototype.hasOwnProperty.call(n, "effects");
}
// FACT 8: .name is URI-encoded, displayName is not. Every listing that
// reads .name ships "%20" into the model, so the stub keeps the encoding.
function encName(n) { return n.replace(/ /g, "%20"); }

function Folder(p) {
  this.fsName = String(p).replace(/\//g, "\\");
  const segs = splitPath(p);
  this.displayName = segs[segs.length - 1] || "";
  this.name = encName(this.displayName);
}
Object.defineProperty(Folder.prototype, "exists", {
  get() { return isFolderNode(nodeAt(this.fsName)); }
});
Folder.prototype.getFiles = function () {
  const node = nodeAt(this.fsName);
  if (!isFolderNode(node)) return [];
  return Object.keys(node).map(k => isFolderNode(node[k])
    ? new Folder(joinPath(this.fsName, k))
    : new File(joinPath(this.fsName, k)));
};
Folder.startup = new Folder(START);
Folder.myDocuments = new Folder(DOCS);

function File(p) {
  this.fsName = String(p).replace(/\//g, "\\");
  const segs = splitPath(p);
  this.displayName = segs[segs.length - 1] || "";
  this.name = encName(this.displayName);
}
Object.defineProperty(File.prototype, "exists", {
  get() {
    const n = nodeAt(this.fsName);
    return n !== undefined && !isFolderNode(n);
  }
});
File.prototype.spec = function () { return nodeAt(this.fsName); };

// -------------------------------------------------------- stubbed AE model

function Prop(name, matchName) {
  this.name = name;
  this.matchName = matchName || name;
  this.propertyType = PropertyType.PROPERTY;
  this.expression = "";
  this.canSetExpression = true;
  this.numKeys = 0;
  this.numProperties = 0;
}
Prop.prototype.property = function () { return null; };

function Group(name, matchName) {
  this.name = name;
  this.matchName = matchName || name;
  this.propertyType = PropertyType.NAMED_GROUP;
  this._kids = [];
}
Object.defineProperty(Group.prototype, "numProperties", {
  get() { return this._kids.length; }
});
Group.prototype.property = function (ref) {
  if (typeof ref === "number") return this._kids[ref - 1] || null;
  return this._kids.filter(k => k.name === ref || k.matchName === ref)[0] ||
         null;
};
Group.prototype.add = function (k) { this._kids.push(k); return k; };

let solidCount = 1;
function Layer(name, comp, kind) {
  this.name = name;
  this.comp = comp;
  this.kind = kind || "solid";
  this.selected = false;
  this.locked = false;
  this.nullLayer = kind === "null";
  // A solid is only a solid to AELL_layerType if its source carries a real
  // SolidSource — otherwise every refusal calls it "footage".
  if (kind === "solid" || !kind) {
    const src = Object.create(SolidSource.prototype);
    this.source = { name, width: 100, height: 100, mainSource: src };
  }
  this._root = new Group("(layer)", "(layer)");
  const t = new Group("Transform", "ADBE Transform Group");
  t.add(new Prop("Position", "ADBE Position"));
  t.add(new Prop("Opacity", "ADBE Opacity"));
  this._root.add(t);
  // FACT 7: a camera has no Effect Parade at all.
  if (kind !== "camera" && kind !== "light") {
    this._effects = new Group("Effects", "ADBE Effect Parade");
    this._root.add(this._effects);
  }
  if (kind === "text") {
    this._text = new Group("Text", "ADBE Text Properties");
    this._text.add(new Group("Animators", "ADBE Text Animators"));
    this._root.add(this._text);
  }
  const proto = { text: TextLayer, shape: ShapeLayer, camera: CameraLayer,
                  light: LightLayer }[kind] || AVLayer;
  Object.setPrototypeOf(this, Object.create(proto.prototype,
    Object.getOwnPropertyDescriptors(Layer.prototype)));
}
Object.defineProperty(Layer.prototype, "index", {
  get() { return this.comp._layers.indexOf(this) + 1; }
});
Object.defineProperty(Layer.prototype, "numProperties", {
  get() { return this._root.numProperties; }
});
Layer.prototype.property = function (ref) { return this._root.property(ref); };

// The whole point of the stub: AE's applyPreset, with every measured lie.
let applyCalls = 0;
Layer.prototype.applyPreset = function (file) {
  applyCalls++;
  const targets = this.comp.selectedLayers;
  // FACT 2: nothing selected -> AE invents a comp-sized solid and uses it.
  if (targets.length === 0) {
    const made = new Layer("Solid " + (++solidCount), this.comp, "solid");
    made.source.width = this.comp.width;
    made.source.height = this.comp.height;
    this.comp._layers.unshift(made);
    this.comp._layers.forEach(l => { l.selected = false; });
    made.selected = true;
    applyTo(made, file);
    return;
  }
  // FACT 5: the path is only validated once there is something to hit.
  const spec = file.spec();
  if (spec === undefined || isFolderNode(spec)) {
    throw new Error("After Effects error: Unable to call \u201CapplyPreset" +
      "\u201D because of parameter 1. Path is not valid. Path: \u201C" +
      file.fsName + "\u201D");
  }
  // FACT 1: EVERY selected layer receives it, not just the receiver.
  targets.forEach(l => applyTo(l, file));
};
function applyTo(layer, file) {
  const spec = file.spec();
  if (!spec) return;
  // FACT 3 + 7: a mismatched preset is a silent no-op, and so is any
  // preset on a layer with no Effect Parade.
  if (!layer._effects) return;
  if (spec.needs === "text" && layer.kind !== "text") {
    if (!spec.controls) return;
    // Measured: only the expression-control rig lands, never the keys.
    spec.effects.forEach(nm => {
      if (!layer._effects.property(nm)) {
        layer._effects.add(new Group(nm, "ADBE " + nm));
      }
    });
    return;
  }
  spec.effects.forEach(nm => {
    if (!layer._effects.property(nm)) {
      layer._effects.add(new Group(nm, "ADBE " + nm));
    }
  });
  // The census the host counts: expressions and keyframes anywhere.
  if (spec.keys) {
    const pos = layer.property("ADBE Transform Group").property("Position");
    pos.numKeys = Math.max(pos.numKeys, spec.keys);
  }
}

function Comp(name) {
  this.name = name;
  this.width = 400; this.height = 300;
  this.duration = 5; this.frameRate = 30; this.time = 0;
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

function makeComp(name) {
  const c = new Comp(name);
  Object.setPrototypeOf(c, Object.create(CompItem.prototype,
    Object.getOwnPropertyDescriptors(Comp.prototype)));
  return c;
}

const project = {
  _items: [],
  get numItems() { return this._items.length; },
  item(i) { return this._items[i - 1]; },
  rootFolder: { name: "(root)" },
  renderQueue: { numItems: 0 },
  items: {
    addComp(name) {
      const c = makeComp(name);
      project._items.push(c);
      return c;
    }
  }
};

let undoGroups = [];
const app = { project, version: "26.3x87",
              beginUndoGroup(n) { undoGroups.push(n); },
              endUndoGroup() {}, executeCommand() {},
              effects: [], fonts: null };
const $ = { global: {}, hiresTimer: 0 };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool } = host;
const call = (t, a) => AELL_runTool(t, a || {});

// ------------------------------------------------------------------- rig

const comp = project.items.addComp("Stage");
project.activeItem = comp;
function add(name, kind) {
  const l = new Layer(name, comp, kind);
  comp._layers.push(l);
  return l;
}
const solid = add("Red", "solid");
const text = add("Title", "text");
const bystander = add("Other", "solid");

assert(typeof AELL_TOOLS.list_presets === "function" &&
       typeof AELL_TOOLS.apply_preset === "function",
       "both tools exist");
assert(AELL_MUTATING.apply_preset === true &&
       AELL_MUTATING.list_presets !== true,
       "apply_preset is wrapped in an undo group, list_presets is not");

// ------------------------------------------------- 1. the index it builds

{
  const r = call("list_presets", { limit: 0 });
  assert(r.ok, "list_presets works: " + (r.error || ""));
  assert(r.data.installed === 13,
         "both roots walked, recursively (got " + r.data.installed + ")");
  const names = r.data.presets.map(p => p.name);
  assert(names.indexOf("Bungee In") >= 0 &&
         !names.some(n => /%20/.test(n)),
         "names come from displayName, NOT the URI-encoded .name: " +
         names.filter(n => /Bungee/.test(n)));
  const house = r.data.presets.filter(p => p.name === "House Style")[0];
  assert(house && house.source === "user" && house.category === "(Adobe)",
         "a user preset nested one folder deep keeps its category: " +
         JSON.stringify(house));
  const fade = r.data.presets.filter(p => p.name === "Fade Up Characters")[0];
  assert(fade && fade.category === "Text/Animate In" &&
         fade.source === "app",
         "a two-deep app category is the whole path: " + JSON.stringify(fade));
  assert(!names.some(n => n === "not-mine"),
         "a NON-AE sibling folder in Documents/Adobe contributes nothing");
  assert(r.data.categories.indexOf("Behaviors") >= 0 &&
         r.data.categories.indexOf("Text") >= 0,
         "top-level categories are offered: " + r.data.categories.join(","));
}

// ------------------------------------------------------- 2. search + paging

{
  let r = call("list_presets", { filter: "wiggle" });
  assert(r.ok && r.data.total === 1 &&
         r.data.presets[0].name === "Wiggle - position",
         "filter searches Category/Name");
  r = call("list_presets", { category: "Text" });
  assert(r.ok && r.data.total === 3,
         "category narrows to a subtree (got " + (r.data || {}).total + ")");
  r = call("list_presets", { source: "user" });
  assert(r.ok && r.data.total === 2,
         "source picks the user's own presets only");
  r = call("list_presets", { filter: "e", limit: 2 });
  assert(r.ok && r.data.listed === 2 && /offset: 2/.test(r.data.note),
         "limit pages and the note says how to get the rest: " + r.data.note);
  r = call("list_presets", { filter: "zzzz" });
  assert(!r.ok && /13 presets are installed/.test(r.error) &&
         /Behaviors/.test(r.error),
         "a filter that matches nothing is grounded in what exists: " +
         r.error);
}

// -------------------------------- 3. THE bug: applyPreset hits the selection

{
  // Stub fidelity first: driving AE the naive way really does contaminate.
  comp._layers.forEach(l => { l.selected = false; });
  solid.selected = true;
  bystander.selected = true;
  solid.applyPreset(new File(START + "\\Presets\\Image - Utilities\\Flip.ffx"));
  assert(bystander._effects.numProperties === 1,
         "STUB FIDELITY: a raw applyPreset with two layers selected hits " +
         "BOTH (the bystander picked up " +
         bystander._effects.numProperties + " effect)");
  // reset
  bystander._effects._kids.length = 0;
  solid._effects._kids.length = 0;
  solid.property("ADBE Transform Group").property("Position").numKeys = 0;
}

{
  comp._layers.forEach(l => { l.selected = false; });
  bystander.selected = true;
  const before = comp.numLayers;
  const r = call("apply_preset", { layer: "Red", preset: "Flip" });
  assert(r.ok, "apply_preset applies: " + (r.error || ""));
  assert(solid._effects.numProperties === 1,
         "the named layer got the preset");
  assert(bystander._effects.numProperties === 0,
         "and the OTHER selected layer did NOT (no contamination)");
  assert(comp.selectedLayers.length === 1 &&
         comp.selectedLayers[0].name === "Other",
         "the user's selection is restored, not left on the target");
  assert(comp.numLayers === before,
         "no invented layer: " + before + " -> " + comp.numLayers);
  assert(r.data.applied[0].effectsAdded.join(",") === "(Transform)" &&
         r.data.applied[0].keysAndExpressionsAdded === 2,
         "the result names what landed: " +
         JSON.stringify(r.data.applied[0]));
  assert(r.data.category === "Image - Utilities" && r.data.source === "app",
         "and where the preset came from");
}

// ------------------------------- 4. nothing selected must not litter the comp

{
  // Stub fidelity: raw AE invents a solid.
  comp._layers.forEach(l => { l.selected = false; });
  const before = comp.numLayers;
  const victim = add("Untouched", "solid");
  victim.selected = false;
  comp._layers.forEach(l => { l.selected = false; });
  victim.applyPreset(new File(START + "\\Presets\\Behaviors\\" +
                              "Drift Over Time.ffx"));
  assert(comp.numLayers === before + 2,
         "STUB FIDELITY: raw applyPreset with an empty selection invents a " +
         "layer (" + before + " -> " + comp.numLayers + ")");
  assert(victim._effects.numProperties === 0,
         "STUB FIDELITY: and the receiver gets nothing");
  const made = comp._layers.filter(l => /^Solid /.test(l.name))[0];
  assert(made && made._effects.numProperties === 1 &&
         made.source.width === comp.width,
         "STUB FIDELITY: the invented layer is comp-sized and holds it");
  comp._layers = comp._layers.filter(l => l !== made);
}

{
  comp._layers.forEach(l => { l.selected = false; });
  const before = comp.numLayers;
  const r = call("apply_preset",
                 { layer: "Untouched", preset: "Drift Over Time" });
  assert(r.ok && comp.numLayers === before,
         "with NOTHING selected the tool still hits the named layer and " +
         "invents nothing: " + (r.error || comp.numLayers));
  assert(comp.layer("Untouched")._effects.numProperties === 1,
         "the target really has the preset");
  assert(comp.selectedLayers.length === 0,
         "an empty selection is left empty");
}

// -------------------------------- 5. a preset that does nothing says nothing

{
  const r = call("apply_preset",
                 { layer: "Red", preset: "Fade Up Characters" });
  assert(!r.ok, "a Text preset on a solid is refused, not reported as done");
  assert(/silent/i.test(r.error) && /TEXT layer/.test(r.error) &&
         /'Red'/.test(r.error) && /solid/.test(r.error),
         "the refusal names the layer, its type and the rule: " + r.error);
  assert(/Text\/Animate In\/Fade Up Characters/.test(r.error),
         "and the preset by its full path: " + r.error);
}

// ------------------------------- 6. the same preset on the layer it fits

{
  const r = call("apply_preset",
                 { layer: "Title", preset: "Fade Up Characters" });
  assert(r.ok, "on a TEXT layer it applies: " + (r.error || ""));
  assert(!r.data.applied[0].effectsAdded &&
         r.data.applied[0].keysAndExpressionsAdded === 2,
         "a preset with ZERO effects still counts as applied, on keys " +
         "alone: " + JSON.stringify(r.data.applied[0]));
  assert(r.data.applied[0].type === "text", "and reports the layer type");
}

// ---------------------------------------- 7. a mixed batch is honest per row

{
  const t2 = add("Title 2", "text");
  const s2 = add("Blue", "solid");
  const r = call("apply_preset", { layers: ["Title 2", "Blue"],
                                   preset: "Drop In By Character" });
  assert(r.ok, "a batch where SOME layers fit still applies: " +
         (r.error || ""));
  assert(r.data.applied.length === 1 && r.data.applied[0].layer === "Title 2",
         "only the text layer is listed as applied");
  assert(r.data.skipped.length === 1 && r.data.skipped[0].layer === "Blue" &&
         /nothing/i.test(r.data.skipped[0].reason),
         "the solid is reported as skipped, not silently dropped: " +
         JSON.stringify(r.data.skipped));
  assert(/1 layer\(s\) got nothing/.test(r.data.note),
         "and the note counts them: " + r.data.note);
  assert(t2.property("ADBE Transform Group").property("Position").numKeys === 2 &&
         s2._effects.numProperties === 0,
         "the field state matches the report");
}

// ------------------------------------------------ 8. cameras take nothing

{
  add("Cam", "camera");
  const r = call("apply_preset", { layer: "Cam", preset: "Flip" });
  assert(!r.ok && /camera/.test(r.error),
         "a camera is refused with its type named: " + r.error);
}

// --------------------------------------------- 9. locked layers are honest

{
  const lk = add("Locked", "solid");
  lk.locked = true;
  const r = call("apply_preset", { layer: "Locked", preset: "Flip" });
  assert(r.ok && lk._effects.numProperties === 1,
         "AE does not block a preset on a locked layer, so neither do we");
  assert(r.data.lockedButApplied.join(",") === "Locked" &&
         /locked/i.test(r.data.lockNote),
         "and the result says the lock did not hold: " +
         JSON.stringify(r.data.lockedButApplied));
}

// ------------------------------------------- 10. naming: exact, path, fuzzy

{
  let r = call("apply_preset", { layer: "Blue", preset: "Flip.ffx" });
  assert(r.ok, "a trailing .ffx is tolerated: " + (r.error || ""));
  r = call("apply_preset",
           { layer: "Blue", preset: "image - utilities\\invert alpha" });
  assert(r.ok && r.data.applied[0].effectsAdded.length === 3,
         "a backslashed, lower-cased Category\\Name resolves, and ONE " +
         "preset can add three effects: " + (r.error || ""));
  r = call("apply_preset", { layer: "Blue", preset: "wiggle" });
  assert(r.ok && r.data.preset === "Wiggle - position",
         "a unique substring resolves: " + (r.error || ""));
}

{
  const r = call("apply_preset", { layer: "Blue", preset: "Fade" });
  assert(!r.ok && /matches 2 presets/.test(r.error) &&
         /Text\/Animate In\/Fade Up Characters/.test(r.error),
         "an ambiguous name is refused with the exact paths to choose " +
         "from: " + r.error);
}
{
  const r = call("apply_preset", { layer: "Blue", preset: "Sparkle Burst" });
  assert(!r.ok, "an invented preset name is refused");
  assert(/list_presets/.test(r.error) && !/After Effects error/.test(r.error),
         "in the panel's words, pointing at the search tool: " + r.error);
}
{
  const r = call("apply_preset", { layer: "Blue", preset: "Bungee Out" });
  assert(!r.ok && /Shapes\/Bungee In/.test(r.error),
         "a near miss names the closest installed preset: " + r.error);
}
{
  const r = call("apply_preset", { layer: "Blue" });
  assert(!r.ok && /'preset' is required/.test(r.error),
         "a missing preset is refused before anything is touched");
}

// ------------------------------------- 11. a file that vanished after indexing

{
  delete TREE[START].Presets.Shapes["Bungee In.ffx"];
  const r = call("apply_preset", { layer: "Blue", preset: "Bungee In" });
  assert(!r.ok && /refresh: true/.test(r.error),
         "an indexed preset that is gone points at the refresh: " + r.error);
  TREE[START].Presets.Shapes["Bungee In.ffx"] = P(["(Transform)"], 2);
  const r2 = call("list_presets", { refresh: true, filter: "Bungee" });
  assert(r2.ok && r2.data.total === 1, "and refresh re-walks the disk");
}

// ---------------------------------------------- 12. the comp is left alone

{
  comp.time = 1.5;
  const before = comp.numLayers;
  call("apply_preset", { layer: "Blue", preset: "Anime Radial" });
  assert(comp.time === 1.5 && comp.numLayers === before,
         "applying touches neither the CTI nor the layer count");
  const r = call("apply_preset", { layer: "Red", preset: "Anime Radial" });
  assert(r.ok && r.data.applied[0].effectsAdded.length === 10,
         "and a ten-effect preset reports all ten: " +
         JSON.stringify((r.data.applied[0] || {}).effectsAdded));
}

// ------------------- 13. a Text preset that carries CONTROLS lands partly

{
  const s3 = add("Grey", "solid");
  let r = call("apply_preset",
               { layer: "Grey", preset: "Alternating Characters In" });
  assert(r.ok, "a Text preset with expression controls DOES land on a " +
         "solid — refusing it would be wrong: " + (r.error || ""));
  assert(r.data.applied[0].effectsAdded.length === 6 &&
         !r.data.applied[0].keysAndExpressionsAdded,
         "the controls arrive and the animation does not: " +
         JSON.stringify(r.data.applied[0]));
  assert(r.data.partialOnNonText.join(",") === "Grey" &&
         /text animators/i.test(r.data.partialNote),
         "and the half-landing is reported, not passed off as success: " +
         JSON.stringify(r.data.partialOnNonText));
  assert(s3._effects.numProperties === 6, "the field state agrees");

  const t3 = add("Title 3", "text");
  r = call("apply_preset",
           { layer: "Title 3", preset: "Alternating Characters In" });
  assert(r.ok && !r.data.partialOnNonText,
         "on a TEXT layer there is nothing partial to report");
  assert(r.data.applied[0].keysAndExpressionsAdded === 2,
         "and the animation half lands too");
}

// ------------------------------------------------ 14. the docs say all this

{
  const doc = toolsSrc.slice(toolsSrc.indexOf('name: "list_presets"'),
                             toolsSrc.indexOf('name: "add_to_render_queue"'));
  assert(/list_presets/.test(doc) && /apply_preset/.test(doc),
         "both tools are documented for the model");
  assert(/non-text/.test(doc) && /nothing at all/.test(doc) &&
         /partial/.test(doc),
         "and the doc carries the type rule that AE enforces in silence");
  // The RENDERED prompt: since WORKPLAN §24a the section headers also sit
  // in RULE_SECTIONS, so a slice of the source no longer spans a section.
  const promptWin = {};
  promptWin.window = promptWin;
  new Function("window", toolsSrc).call(promptWin, promptWin);
  const prompt = promptWin.Tools.buildSystemPrompt("");
  assert(/list_presets/.test(prompt.slice(
           prompt.indexOf("Universal property access"),
           prompt.indexOf("Masks & shape content"))),
         "the system prompt points at the preset library");
}

console.log("\n" + checks + " checks");
