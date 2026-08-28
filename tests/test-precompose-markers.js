// Regression test: precompose + add_marker (WORKPLAN 5.4).
//
// Both tools shipped long ago with zero stub tests and zero suite steps.
// Three probes against real AE 2026 (WORKPLAN-LOG 2026-08-28) measured
// what they actually do, and the stub below encodes those measurements
// so the same bug class is caught WITHOUT After Effects:
//
//  1. `precompose(indices, name, false)` THROWS for more than one layer
//     ("Can not set moveAllAttributes to false when calling precompose
//     with more than one layer") — the tool now refuses it first, in
//     words the model can act on.
//  2. AE tolerates a REPEATED index: [2, 2] moves ONE layer. The tool
//     used to report layersMoved: 2, which was simply untrue.
//  3. Precompose DESTROYS the layers it moves. A reference held across
//     the call throws "Object is invalid" on the next read — the trap
//     that broke the first cut of the selection restore, and the reason
//     the restore now matches on Layer.id captured BEFOREHAND.
//  4. It also selects the new precomp layer and deselects everything
//     else, so a user selection that SURVIVED is put back.
//  5. A moved layer whose parent stayed behind loses the parent outright
//     and silently. (The reverse — a layer left behind whose parent moved
//     in — is re-pointed by AE at the new precomp layer, and a pair moved
//     together keeps its link. Only the one direction loses anything.)
//  6. With moveAllAttributes TRUE an expression left behind that names a
//     moved layer is NOT rewritten and expressionError stays EMPTY: the
//     reference dangles with no complaint from AE. With FALSE, AE does
//     rewrite it to the new precomp layer.
//  7. AE lets a SECOND project item take the requested name, which makes
//     the later one unreachable by name (AELL_resolveComp returns the
//     first match). precompose now auto-numbers and registers the same
//     request-scoped alias create_comp does.
//  8. moveAllAttributes FALSE sizes the new comp to that ONE layer's
//     source (200x100), not to the comp (640x480).
//
// Markers:
//  9. A marker written at a time that already has one REPLACES it,
//     comment and duration and all, and setValueAtTime says nothing.
// 10. Marker times are COMPOSITION time on a layer too: keyTime read 3
//     and then 5 after the layer's startTime moved to 2.
// 11. AE accepts a marker outside the comp entirely (negative, or past
//     the end) where nobody can ever see it.
// 12. `{"time": "4"}` is what a small model writes often enough to
//     matter; the old strict typeof check refused it outright.
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

function MarkerValue(comment) {
  this.comment = String(comment === undefined ? "" : comment);
  this.duration = 0;
}

// FACT 9 + 11: one marker per EXACT time (a replace, not an insert), and
// no range check at all.
function MarkerProp() { this._keys = []; }
Object.defineProperty(MarkerProp.prototype, "numKeys", {
  get() { return this._keys.length; }
});
MarkerProp.prototype.canSetExpression = false;
MarkerProp.prototype.keyTime = function (i) { return this._keys[i - 1].t; };
MarkerProp.prototype.keyValue = function (i) { return this._keys[i - 1].v; };
MarkerProp.prototype.setValueAtTime = function (t, v) {
  for (let i = 0; i < this._keys.length; i++) {
    if (this._keys[i].t === t) { this._keys[i].v = v; return; }
  }
  this._keys.push({ t, v });
  this._keys.sort((a, b) => a.t - b.t);
};

function Prop(name, opts) {
  this.name = name;
  this.matchName = (opts && opts.matchName) || name;
  this.canSetExpression = !(opts && opts.canSetExpression === false);
  this.expression = "";
  this.numProperties = 0;
}
Prop.prototype.property = function () { throw new Error("no child"); };

function Group(name, kids) {
  this.name = name;
  this.canSetExpression = false;
  this._kids = kids || [];
}
Object.defineProperty(Group.prototype, "numProperties", {
  get() { return this._kids.length; }
});
Group.prototype.property = function (ref) {
  if (typeof ref === "number") return this._kids[ref - 1];
  const k = this._kids.filter(x => x.name === ref || x.matchName === ref)[0];
  if (!k) throw new Error("no property " + ref);
  return k;
};

let layerId = 0;
function Layer(name, comp, w, h) {
  this.name = name;
  this.comp = comp;
  this.id = ++layerId;         // FACT 3: the only identity that survives
  this.selected = false;
  this.parent = null;
  this.inPoint = 0;
  this.outPoint = 10;
  this.startTime = 0;
  this.dead = false;
  this.source = { name, width: w || 200, height: h || 100 };
  this._marker = new MarkerProp();
  this._opacity = new Prop("Opacity", { matchName: "ADBE Opacity" });
  this._xform = new Group("Transform", [this._opacity]);
  this._xform.matchName = "ADBE Transform Group";
}
// FACT 3: reading ANYTHING off a layer precompose consumed throws. This
// is what makes the "hold the object across the call" mistake fail loudly
// in the stub instead of only in After Effects.
function live(L) {
  if (L.dead) throw new Error("Object is invalid");
  return L;
}
Object.defineProperty(Layer.prototype, "index", {
  get() { live(this); return this.comp._layers.indexOf(this) + 1; }
});
Object.defineProperty(Layer.prototype, "numProperties", {
  get() { live(this); return 1; }
});
Layer.prototype.property = function (ref) {
  live(this);
  if (ref === 1 || ref === "ADBE Transform Group") return this._xform;
  if (ref === "ADBE Marker") return this._marker;
  throw new Error("no property " + ref);
};

function Comp(name, w, h) {
  this.name = name;
  this.width = w || 640; this.height = h || 480;
  this.duration = 10; this.frameRate = 24;
  this.markerProperty = new MarkerProp();
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
Object.defineProperty(Comp.prototype, "layers", {
  get() {
    const self = this;
    return {
      addSolid(color, name, w, h) {
        const L = new Layer(name, self, w, h);
        self._layers.forEach(x => { x.selected = false; });
        L.selected = true;
        self._layers.unshift(L);
        return L;
      },
      // The measured precompose, quirks and all.
      precompose(indices, name, moveAllAttributes) {
        const move = moveAllAttributes !== false;
        const uniq = [];
        indices.forEach(i => { if (uniq.indexOf(i) < 0) uniq.push(i); });
        // FACT 1.
        if (!move && uniq.length > 1) {
          throw new Error("After Effects error: Can not set " +
            "moveAllAttributes to false when calling precompose with " +
            "more than one layer.");
        }
        const moving = uniq.map(i => self._layers[i - 1]);
        const top = Math.min.apply(null, uniq);
        // FACT 8.
        const pre = makeComp(name,
          move ? self.width : moving[0].source.width,
          move ? self.height : moving[0].source.height);
        project._items.push(pre);
        moving.forEach(L => {
          const inner = new Layer(L.name, pre, L.source.width,
                                  L.source.height);
          inner.inPoint = L.inPoint;
          inner.outPoint = L.outPoint;
          inner.startTime = L.startTime;
          inner._parentWas = L.parent;
          pre._layers.push(inner);
        });
        // FACT 5, both directions.
        pre._layers.forEach(inner => {
          const was = inner._parentWas;
          inner.parent = (was && moving.indexOf(was) >= 0)
            ? pre._layers[moving.indexOf(was)]
            : null;
        });
        // FACT 3: the originals are gone, not moved.
        moving.forEach(L => {
          L.dead = true;
          self._layers.splice(self._layers.indexOf(L), 1);
        });
        const holder = new Layer(pre.name, self, pre.width, pre.height);
        holder.source = pre;
        self._layers.splice(top - 1, 0, holder);
        self._layers.forEach(L => {
          if (L.parent && moving.indexOf(L.parent) >= 0) L.parent = holder;
        });
        // FACT 6: rewritten ONLY when the attributes stayed behind.
        if (!move) {
          self._layers.forEach(L => {
            const p = L._opacity;
            moving.forEach(M => {
              p.expression = p.expression.split('"' + M.name + '"')
                              .join('"' + pre.name + '"');
            });
          });
        }
        // FACT 4.
        self._layers.forEach(L => { L.selected = false; });
        holder.selected = true;
        return pre;
      }
    };
  }
});

function makeComp(name, w, h) {
  const c = new Comp(name, w, h);
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
    // FACT 7: AE never uniquifies. Two items may share a name.
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

const app = { project, version: "26.3x87",
              beginUndoGroup() {}, endUndoGroup() {}, executeCommand() {} };
const $ = { global: {}, hiresTimer: 0 };

const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_runTool: AELL_runTool, " +
  "AELL_resolveComp: AELL_resolveComp })");
const { AELL_TOOLS, AELL_MUTATING, AELL_runTool, AELL_resolveComp } = host;
const call = (t, a) => AELL_runTool(t, a || {});

// ---------------------------------------------------------------- rig

const room = project.items.addComp("Room");
const add = n => room.layers.addSolid([1, 0, 0], n, 200, 100);

assert(typeof AELL_TOOLS.precompose === "function" &&
       typeof AELL_TOOLS.add_marker === "function",
       "both tools exist");

// ------------------------------------------- 1. a repeated layer counts once

{
  add("Keep"); add("Solo");
  const idx = room.layer("Solo").index;
  const r = call("precompose",
    { comp: "Room", layers: [idx, idx, "Solo"], name: "P1" });
  assert(r.ok, "a repeated reference is not an error: " + (r.error || ""));
  assert(r.data.layersMoved === 1,
         "layersMoved counts LAYERS, not references (got " +
         r.data.layersMoved + ")");
  assert(/Solo/.test(r.data.duplicatesIgnored || "") &&
         (r.data.duplicatesIgnored.match(/Solo/g) || []).length === 1,
         "and the repeat is named once, not once per mention: " +
         r.data.duplicatesIgnored);
}

// ------------------------------- 2. moveAttributes:false, more than one layer

{
  add("A2"); add("B2");
  const r = call("precompose",
    { comp: "Room", layers: ["A2", "B2"], name: "P2", moveAttributes: false });
  assert(!r.ok, "moveAttributes:false with two layers is refused");
  assert(/A2/.test(r.error) && /B2/.test(r.error),
         "the refusal names the layers: " + r.error.slice(0, 70));
  assert(!/After Effects error/.test(r.error),
         "in the panel's words, not AE's raw throw");
  assert(!project._items.some(it => it.name === "P2"),
         "and nothing was created");
  // FACT 1 fidelity: AE really would have thrown.
  let threw = "";
  try { room.layers.precompose([1, 2], "P2raw", false); }
  catch (e) { threw = String(e); }
  assert(/moveAllAttributes/.test(threw),
         "STUB FIDELITY: raw AE throws for that call — " + threw.slice(0, 60));
}

// ---------------------------------------- 3. a surviving selection comes back

{
  add("Stay"); add("Go1"); add("Go2");
  room._layers.forEach(L => { L.selected = L.name === "Stay"; });
  const r = call("precompose",
    { comp: "Room", layers: ["Go1", "Go2"], name: "P3" });
  assert(r.ok, "precompose ok: " + (r.error || ""));
  assert(room.selectedLayers.length === 1 &&
         room.selectedLayers[0].name === "Stay",
         "the user's selection is restored, not AE's new layer (selected: " +
         room.selectedLayers.map(l => l.name).join(",") + ")");
  assert(r.data.selectionKept === "Stay",
         "and the result says so: " + r.data.selectionKept);
}

// -------------------------- 4. a selection that ALL moved in is not resurrected

{
  add("All1"); add("All2");
  room._layers.forEach(L => { L.selected = /^All/.test(L.name); });
  const r = call("precompose",
    { comp: "Room", layers: ["All1", "All2"], name: "P4" });
  assert(r.ok, "precomposing the whole selection does not throw " +
         "'Object is invalid': " + (r.error || ""));
  assert(room.selectedLayers.length === 1 &&
         room.selectedLayers[0].name === "P4",
         "AE's new layer keeps the selection when nothing survived");
  assert(/none survived/.test(r.data.selectionKept),
         "and the result says which it is: " + r.data.selectionKept);
}

// --------------------------------------------- 5. a parent left behind is lost

{
  const par = add("Par5"), kid = add("Kid5");
  kid.parent = par;
  const r = call("precompose",
    { comp: "Room", layers: ["Kid5"], name: "P5" });
  assert(r.ok, "precompose ok: " + (r.error || ""));
  assert(/Kid5/.test(r.data.parentsBroken || "") &&
         /Par5/.test(r.data.parentsBroken || ""),
         "the dropped parent is reported: " + r.data.parentsBroken);
  const pre = project._items.filter(it => it.name === "P5")[0];
  assert(pre.layer(1).parent === null,
         "STUB FIDELITY: AE really does drop it");
}

{
  const par = add("Par5b"), kid = add("Kid5b");
  kid.parent = par;
  const r = call("precompose",
    { comp: "Room", layers: ["Kid5b", "Par5b"], name: "P5b" });
  assert(r.ok && !r.data.parentsBroken,
         "a parent that moves in TOO loses nothing, so nothing is reported");
  const pre = project._items.filter(it => it.name === "P5b")[0];
  assert(pre.layer(1).parent === pre.layer(2) ||
         pre.layer(2).parent === pre.layer(1),
         "STUB FIDELITY: the link survives inside the precomp");
}

{
  const par = add("Par5c"), kid = add("Kid5c");
  kid.parent = par;
  const r = call("precompose",
    { comp: "Room", layers: ["Par5c"], name: "P5c" });
  assert(r.ok && !r.data.parentsBroken,
         "a layer left behind whose PARENT moved in is re-pointed by AE, " +
         "so nothing is reported either");
  assert(room.layer("Kid5c").parent.name === "P5c",
         "STUB FIDELITY: AE re-points it at the new precomp layer");
}

// -------------------------------- 6. an expression left behind that dangles

{
  const out = add("Out6");
  add("In6");
  out._opacity.expression = 'thisComp.layer("In6").transform.opacity';
  const r = call("precompose",
    { comp: "Room", layers: ["In6"], name: "P6" });
  assert(r.ok, "precompose ok: " + (r.error || ""));
  assert(/Out6/.test(r.data.expressionsAtRisk || "") &&
         /In6/.test(r.data.expressionsAtRisk || ""),
         "the dangling expression is named: " + r.data.expressionsAtRisk);
  assert(out._opacity.expression.indexOf('"In6"') !== -1,
         "STUB FIDELITY: AE leaves it pointing at the missing layer");
}

{
  const out = add("Out6b");
  add("In6b");
  out._opacity.expression = 'thisComp.layer("In6b").transform.opacity';
  const r = call("precompose",
    { comp: "Room", layers: ["In6b"], name: "P6b", moveAttributes: false });
  assert(r.ok && !r.data.expressionsAtRisk,
         "moveAttributes:false rewrites it, so there is nothing to warn about");
  assert(out._opacity.expression.indexOf('"P6b"') !== -1,
         "STUB FIDELITY: AE rewrote it to the precomp layer");
  assert(/SIZE OF THE LAYER \(200x100\)/.test(r.data.note || ""),
         "and the note names the size the new comp really got: " + r.data.note);
}

// ------------------------------------- 7. a name already taken is auto-numbered

{
  add("N7a"); add("N7b");
  const first = call("precompose",
    { comp: "Room", layers: ["N7a"], name: "Same" });
  const second = call("precompose",
    { comp: "Room", layers: ["N7b"], name: "Same" });
  assert(first.ok && second.ok, "both precomposes succeed");
  assert(second.data.precomp === "Same 2",
         "the second is auto-numbered like create_comp (got " +
         second.data.precomp + ")");
  assert(/already existed/.test(second.data.note || "") &&
         /Same 2/.test(second.data.note || ""),
         "and says which name to use next: " + second.data.note);
  assert(AELL_resolveComp("Same").name === "Same 2",
         "the request-scoped alias redirects the rest of the batch");
  assert(project._items.filter(it => it.name === "Same").length === 1,
         "no two items end up sharing one name");
}

// ------------------------------------------------------- 8. marker basics

const mc = project.items.addComp("Markers");
const mk = mc.layers.addSolid([0, 0, 1], "Marked", 100, 100);

{
  const r = call("add_marker",
    { comp: "Markers", time: 1, comment: "one", duration: 2 });
  assert(r.ok, "a comp marker is added: " + (r.error || ""));
  assert(r.data.comment === "one" && r.data.duration === 2 &&
         r.data.markers === 1,
         "and the result echoes what landed: " + JSON.stringify(r.data));
}

// ----------------------------------- 9. writing over a marker names the loss

{
  const r = call("add_marker",
    { comp: "Markers", time: 1, comment: "two" });
  assert(r.ok, "the overwrite succeeds (AE allows it)");
  assert(/one/.test(r.data.replaced || "") &&
         /duration 2s/.test(r.data.replaced || ""),
         "and what it destroyed is reported: " + r.data.replaced);
  assert(mc.markerProperty.numKeys === 1,
         "STUB FIDELITY: AE keeps one marker per exact time");
}

{
  const r = call("add_marker",
    { comp: "Markers", time: 7, comment: "fresh" });
  assert(r.ok && !r.data.replaced,
         "a marker on empty time reports no replacement");
}

// ---------------------------------------------- 10. a quoted time is accepted

{
  const r = call("add_marker",
    { comp: "Markers", time: "4", comment: "quoted" });
  assert(r.ok && r.data.time === 4,
         "a small model's {\"time\": \"4\"} is accepted, not dropped: " +
         (r.error || r.data.time));
}

// -------------------------------------------- 11. a bad duration is refused

{
  const neg = call("add_marker", { comp: "Markers", time: 5, duration: -3 });
  assert(!neg.ok && /duration/.test(neg.error) && /-3/.test(neg.error),
         "a negative duration is refused with what came in: " + neg.error);
  const word = call("add_marker", { comp: "Markers", time: 5, duration: "two" });
  assert(!word.ok && /two/.test(word.error),
         "so is a duration that is not a number: " + word.error);
  assert(!mc.markerProperty._keys.some(k => k.t === 5),
         "and neither one leaves a marker behind");
  const quoted = call("add_marker",
    { comp: "Markers", time: 5, duration: "2" });
  assert(quoted.ok && quoted.data.duration === 2,
         "a quoted duration still works: " + (quoted.error || ""));
}

// ------------------------------------ 12. a marker nobody can see is flagged

{
  const far = call("add_marker",
    { comp: "Markers", time: 99, comment: "far" });
  assert(far.ok && /off the visible timeline/.test(far.data.note || ""),
         "past the end of the comp is allowed and flagged: " + far.data.note);
  const back = call("add_marker",
    { comp: "Markers", time: -1, comment: "back" });
  assert(back.ok && /off the visible timeline/.test(back.data.note || ""),
         "so is a negative time: " + back.data.note);
}

{
  mk.inPoint = 3;
  const r = call("add_marker",
    { comp: "Markers", layer: "Marked", time: 1, comment: "early" });
  assert(r.ok && /own span/.test(r.data.note || ""),
         "a layer marker outside the layer's span is flagged: " + r.data.note);
  mk.inPoint = 0;
  const ok = call("add_marker",
    { comp: "Markers", layer: "Marked", time: 2, comment: "fine" });
  assert(ok.ok && !ok.data.note,
         "and one inside it is not: " + (ok.data.note || ""));
}

// --------------------------------------------- 13. missing args stay grounded

{
  const noTime = call("add_marker", { comp: "Markers", comment: "x" });
  assert(!noTime.ok && /composition time/.test(noTime.error),
         "a missing time says which time space it wants: " + noTime.error);
  const badTime = call("add_marker", { comp: "Markers", time: "soon" });
  assert(!badTime.ok && /soon/.test(badTime.error),
         "and an unusable one quotes it back: " + badTime.error);
  const noName = call("precompose", { comp: "Room", layers: ["Keep"] });
  assert(!noName.ok && /'name' is required/.test(noName.error),
         "precompose still requires a name");
  const noLayers = call("precompose", { comp: "Room", name: "X" });
  assert(!noLayers.ok && /'layers'/.test(noLayers.error),
         "and a layers array");
}

// ------------------------------------------------- 14. the docs say all this

{
  const defs = toolsSrc;
  const pre = defs.slice(defs.indexOf('name: "precompose"'),
                         defs.indexOf('name: "add_camera"'));
  assert(/parent/i.test(pre) && /expression/i.test(pre),
         "the precompose doc warns about parents and expressions");
  assert(/auto-numbered|already/i.test(pre),
         "and about the name it may not get");
  const mkDoc = defs.slice(defs.indexOf('name: "add_marker"'),
                           defs.indexOf('name: "set_layer_3d"'));
  assert(/COMPOSITION time/.test(mkDoc),
         "the add_marker doc names the time space");
  assert(/REPLACES/.test(mkDoc),
         "and that a second marker at one time overwrites the first");
}

console.log("\n" + checks + " checks");
