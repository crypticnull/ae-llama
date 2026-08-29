// Regression test: organize_project against a stubbed AE project model.
//
// The stub models what AE 2026 was MEASURED to do (probe of the
// organize_project pass, WORKPLAN-LOG 2026-08-28), not what reads well:
//
//  - a comp created by script lands at the project ROOT;
//  - AE parks a solid's SOURCE in its own "Solids" folder as soon as the
//    solid is created, so solids are normally NOT loose;
//  - a SolidSource reports isStill TRUE -- so a tool that tests isStill
//    before SolidSource files every solid as an image;
//  - a still is hasVideo+isStill, an audio-only file is hasAudio without
//    hasVideo, a movie is both with isStill false;
//  - folder names are not unique, so a "Comps" folder can already exist
//    NESTED somewhere: the shipped tool used to find it by name anywhere
//    in the tree and file the user's root comps inside it.
//
// Several checks drive the RAW stub API first, so a stub that quietly
// stopped modelling a hazard cannot let the tool pass on a technicality.
"use strict";
const fs = require("fs");
const path = require("path");

let NEXT_ID = 1;
let ALL_ITEMS = [];

function Item(name) {
  this.name = name;
  this.id = NEXT_ID++;
  this._parent = null;
  ALL_ITEMS.push(this);
}
Object.defineProperty(Item.prototype, "parentFolder", {
  get() { return this._parent; },
  set(f) {
    if (this._parent) {
      const i = this._parent.children.indexOf(this);
      if (i >= 0) this._parent.children.splice(i, 1);
    }
    this._parent = f;
    if (f) f.children.push(this);
  }
});
Item.prototype.remove = function () {
  const i = ALL_ITEMS.indexOf(this);
  if (i >= 0) ALL_ITEMS.splice(i, 1);
  if (this._parent) {
    const j = this._parent.children.indexOf(this);
    if (j >= 0) this._parent.children.splice(j, 1);
  }
};

function FolderItem(name) { Item.call(this, name); this.children = []; }
FolderItem.prototype = Object.create(Item.prototype);
Object.defineProperty(FolderItem.prototype, "numItems", {
  get() { return this.children.length; }
});
FolderItem.prototype.item = function (i) { return this.children[i - 1]; };

function CompItem(name) { Item.call(this, name); this.layers = []; }
CompItem.prototype = Object.create(Item.prototype);
Object.defineProperty(CompItem.prototype, "numLayers", {
  get() { return this.layers.length; }
});
CompItem.prototype.layer = function (i) { return this.layers[i - 1]; };

// isStill TRUE on a solid is the trap this stub exists to model.
function SolidSource() { this.isStill = true; this.file = null; }
function FileSource(file, isStill) {
  this.file = { fsName: file };
  this.isStill = !!isStill;
}
function FootageItem(name, source, hasVideo, hasAudio) {
  Item.call(this, name);
  this.mainSource = source;
  this.hasVideo = hasVideo === undefined ? true : hasVideo;
  this.hasAudio = !!hasAudio;
}
FootageItem.prototype = Object.create(Item.prototype);
Object.defineProperty(FootageItem.prototype, "usedIn", { get() { return []; } });

function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {}
const ParagraphJustification = {};

let root = new FolderItem("(root)");
ALL_ITEMS.length = 0;

const renderQueue = {
  queued: [],
  get numItems() { return this.queued.length; },
  item(i) { return this.queued[i - 1]; },
  items: { add(comp) { const it = { comp }; renderQueue.queued.push(it); return it; } }
};

const project = {
  rootFolder: root,
  get numItems() { return ALL_ITEMS.length; },
  item(i) { return ALL_ITEMS[i - 1]; },
  renderQueue,
  items: {
    addFolder(name) { const f = new FolderItem(name); f.parentFolder = root; return f; },
    addComp(name) { const c = new CompItem(name); c.parentFolder = root; return c; }
  },
  activeItem: null,
  file: null
};

const app = {
  project,
  beginUndoGroup() {}, endUndoGroup() {},
  beginSuppressDialogs() {}, endSuppressDialogs() {}
};
const $ = { global: {} };

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "jsx",
                               "hostscript.jsx"), "utf8"));

function call(tool, args) {
  return JSON.parse($.global.AELL_call(tool, JSON.stringify(args)));
}
let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}
function reset() {
  ALL_ITEMS = [];
  root = new FolderItem("(root)");
  ALL_ITEMS.length = 0;
  project.rootFolder = root;
  renderQueue.queued = [];
}
function names(list) { return (list || []).slice().sort().join(","); }
function where(it) {
  return it.parentFolder === root ? "(root)" : it.parentFolder.name;
}

// --- the four footage kinds, exactly as AE reports them --------------
function still(name) {
  const it = new FootageItem(name, new FileSource("C:/tmp/" + name, true), true, false);
  it.parentFolder = root;
  return it;
}
function movie(name) {
  const it = new FootageItem(name, new FileSource("C:/tmp/" + name, false), true, true);
  it.parentFolder = root;
  return it;
}
function audio(name) {
  const it = new FootageItem(name, new FileSource("C:/tmp/" + name, false), false, true);
  it.parentFolder = root;
  return it;
}
/* A solid source AE has already filed into its own Solids folder. */
function solidInAeFolder(name) {
  let f = ALL_ITEMS.find(x => x instanceof FolderItem && x.name === "Solids" &&
                              x.parentFolder === root);
  if (!f) f = project.items.addFolder("Solids");
  const it = new FootageItem(name, new SolidSource(), true, false);
  it.parentFolder = f;
  return it;
}
/* A solid source sitting loose at the root (a user dragged it out). */
function looseSolid(name) {
  const it = new FootageItem(name, new SolidSource(), true, false);
  it.parentFolder = root;
  return it;
}

// ---------------------------------------------------------------- rig A
// One of every kind at the root, one comp already filed, one root folder
// that has nothing to do with us.
function rigA() {
  reset();
  const compA = project.items.addComp("A Comp");
  const compB = project.items.addComp("B Comp");
  const keepFolder = project.items.addFolder("_WIP");
  const filed = project.items.addComp("Filed Comp");
  filed.parentFolder = keepFolder;
  return {
    compA, compB, keepFolder, filed,
    png: still("shot.png"),
    mp4: movie("clip.mp4"),
    wav: audio("tone.wav"),
    aeSolid: solidInAeFolder("Red Solid 1")
  };
}

// 1. The preview: names every move, moves nothing, creates nothing.
let g = rigA();
assert(g.aeSolid.mainSource.isStill === true,
       "raw stub: a SolidSource reports isStill TRUE (the trap is modelled)");
const beforeItems = project.numItems;
let res = call("organize_project", {});
assert(res.ok, "preview succeeds");
assert(res.data.dryRun === true, "dryRun defaults to TRUE");
assert(res.data.willMove === 5, "five loose items would move: " + res.data.willMove);
assert(names(res.data.moves) ===
       "A Comp -> Comps,B Comp -> Comps,clip.mp4 -> Footage," +
       "shot.png -> Images,tone.wav -> Audio",
       "each move is named item -> folder: " + names(res.data.moves));
assert(res.data.byFolder.Comps === 2 && res.data.byFolder.Images === 1 &&
       res.data.byFolder.Audio === 1 && res.data.byFolder.Footage === 1,
       "byFolder counts them: " + JSON.stringify(res.data.byFolder));
assert(res.data.byFolder.Solids === undefined,
       "AE had already filed the solid, so no Solids move is claimed");
assert(res.data.alreadyFiled === 2,
       "items already inside a folder are counted, not moved: " +
       res.data.alreadyFiled);
assert(names(res.data.foldersToCreate) === "Audio,Comps,Footage,Images",
       "the folders it would CREATE are named: " +
       names(res.data.foldersToCreate));
assert(project.numItems === beforeItems,
       "the preview created no folders (" + project.numItems + " items)");
assert(where(g.compA) === "(root)" && where(g.png) === "(root)" &&
       where(g.filed) === "_WIP",
       "the preview moved nothing at all");
assert(/PREVIEW ONLY/.test(res.data.note), "the note says it is a preview");

// 2. Execute: does what the preview said, and says what it created.
res = call("organize_project", { dryRun: false });
assert(res.ok && res.data.dryRun === false, "execute runs");
assert(res.data.moved === 5, "five items filed: " + res.data.moved);
assert(names(res.data.moves) ===
       "A Comp -> Comps,B Comp -> Comps,clip.mp4 -> Footage," +
       "shot.png -> Images,tone.wav -> Audio",
       "and they are the five the preview promised");
assert(names(res.data.foldersCreated) === "Audio,Comps,Footage,Images",
       "the four new folders are reported: " + names(res.data.foldersCreated));
assert(!res.data.notMoved, "nothing was left behind");
assert(where(g.compA) === "Comps" && where(g.png) === "Images" &&
       where(g.wav) === "Audio" && where(g.mp4) === "Footage",
       "every item really landed in its folder");
assert(where(g.filed) === "_WIP" && where(g.aeSolid) === "Solids",
       "an item that was already filed stayed where it was");
assert(g.keepFolder.numItems === 1, "the user's own folder is untouched");
assert(/Ctrl\+Z/.test(res.data.note), "the result says one Ctrl+Z undoes it");

// 3. Running it again is a no-op that says so, and claims nothing.
res = call("organize_project", {});
assert(res.ok && res.data.willMove === 0 && /nothing to do/i.test(res.data.note),
       "a second preview finds nothing loose: " + res.data.note);
res = call("organize_project", { dryRun: false });
assert(res.ok && res.data.moved === 0 && !res.data.foldersCreated,
       "and a second execute moves nothing and creates nothing");

// 4. The isStill trap: a LOOSE solid files as a solid, never as an image.
reset();
const loose = looseSolid("Blue Solid 1");
assert(loose.mainSource.isStill === true,
       "raw stub: the loose solid still reports isStill TRUE");
res = call("organize_project", {});
assert(res.data.moves[0] === "Blue Solid 1 -> Solids",
       "a solid files to Solids despite isStill: " + res.data.moves[0]);
call("organize_project", { dryRun: false });
assert(where(loose) === "Solids", "and it really lands there");

// 5. A folder of the same name NESTED elsewhere is named, never used.
//    (Shipped behaviour until 2026-08-28: the root comps went INTO it.)
reset();
const archive = project.items.addFolder("PR Archive");
const nestedComps = project.items.addFolder("Comps");
nestedComps.parentFolder = archive;
const c = project.items.addComp("Loose Comp");
res = call("organize_project", {});
assert(names(res.data.sameNameElsewhere) === "PR Archive/Comps",
       "the nested homonym is named by its PATH: " +
       names(res.data.sameNameElsewhere));
assert(/two folders of that name/.test(res.data.sameNameNote || ""),
       "and the note warns what the project will end up with");
assert(names(res.data.foldersToCreate) === "Comps",
       "a root-level Comps would still be created");
res = call("organize_project", { dryRun: false });
assert(where(c) === "Comps", "the comp landed in a folder called Comps");
assert(c.parentFolder !== nestedComps,
       "and it is NOT the user's nested one (the bug this rule fixes)");
assert(c.parentFolder.parentFolder === root,
       "the folder it landed in is at the project root");
assert(nestedComps.numItems === 0, "the nested folder was never touched");

// 6. An existing ROOT folder of the right name is reused, not duplicated.
reset();
const rootImages = project.items.addFolder("Images");
still("a.png"); still("b.png");
res = call("organize_project", {});
assert(!res.data.foldersToCreate,
       "nothing to create when the folder is already at the root");
assert(res.data.rootFolders === 1, "the existing root folder is counted");
res = call("organize_project", { dryRun: false });
assert(!res.data.foldersCreated && rootImages.numItems === 2,
       "both stills went into the folder that was already there");
assert(ALL_ITEMS.filter(x => x instanceof FolderItem).length === 1,
       "no second Images folder was made");

// 7. A move AE refuses is REPORTED, not counted as done.
reset();
const stubborn = new FootageItem("stuck.png", new FileSource("C:/tmp/s.png", true),
                                 true, false);
Object.defineProperty(stubborn, "parentFolder", {
  get() { return root; },                 // AE keeps it where it was
  set() {}
});
still("fine.png");
res = call("organize_project", { dryRun: false });
assert(res.data.moved === 1, "only the item that really moved is counted: " +
       res.data.moved);
assert(names(res.data.notMoved) === "stuck.png (still in the project root)",
       "the one that did not move is named: " + names(res.data.notMoved));
assert(names(res.data.moves) === "fine.png -> Images",
       "and it is absent from the moves list");

// 8. Long lists are capped with a count, never silently truncated.
reset();
for (let i = 0; i < 45; i++) still("bulk" + i + ".png");
res = call("organize_project", {});
assert(res.data.willMove === 45, "all 45 are counted: " + res.data.willMove);
assert(res.data.moves.length === 40 && res.data.movesNotShown === 5,
       "the list is capped at 40 and says how many are missing: " +
       res.data.moves.length + " / " + res.data.movesNotShown);

// 9. An empty project answers honestly instead of erroring.
reset();
res = call("organize_project", {});
assert(res.ok && res.data.willMove === 0 && res.data.alreadyFiled === 0 &&
       res.data.rootFolders === 0, "an empty project: " + res.data.note);

// 10. Registration: mutating (so it gets an undo group), and the model is
//     told the preview comes first.
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "jsx",
                                      "hostscript.jsx"), "utf8");
assert(/organize_project:\s*true/.test(src.split("AELL_MUTATING")[1] || ""),
       "organize_project is in AELL_MUTATING");
const defs = fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                       "tools.js"), "utf8");
assert(/name:\s*"organize_project",\s*mutating:\s*true/.test(defs),
       "organize_project is documented to the model as mutating");
const doc = defs.split('name: "organize_project"')[1].slice(0, 1200);
assert(/dryRun is TRUE by default/.test(doc),
       "the tool doc tells the model the preview comes first");
assert(/dryRun\?: bool/.test(doc), "and the arg is documented");
const prompt = defs.split("function buildSystemPrompt")[1] || "";
assert(/organize the project panel' = organize_project/.test(prompt),
       "the system prompt routes 'organize the project panel' to the tool");
assert(/not an organized project/.test(prompt),
       "and tells the model a preview is not the job done");

console.log(failures ? "\nFAILURES: " + failures :
            "\nAll organize_project checks passed");
