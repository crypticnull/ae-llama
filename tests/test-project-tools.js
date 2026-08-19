// Regression test: project-panel tools against a stubbed AE object model.
// Scenario:
// "add an _ARCHIVE folder at the root of every folder within _COMPS"
"use strict";
const fs = require("fs");

let NEXT_ID = 1;
const ALL_ITEMS = [];

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

function CompItem(name) { Item.call(this, name); this.numLayers = 0; }
CompItem.prototype = Object.create(Item.prototype);
function FootageItem(name) { Item.call(this, name); }
FootageItem.prototype = Object.create(Item.prototype);
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};

const root = new FolderItem("(root)");
ALL_ITEMS.length = 0;   // root itself is not a project item

const project = {
  rootFolder: root,
  get numItems() { return ALL_ITEMS.length; },
  item(i) { return ALL_ITEMS[i - 1]; },
  items: {
    addFolder(name) {
      const f = new FolderItem(name);
      f.parentFolder = root;
      return f;
    },
    addComp() { throw new Error("not needed"); }
  },
  activeItem: null,
  file: null
};
const app = { project, beginUndoGroup() {}, endUndoGroup() {} };
const $ = { global: {} };

// --- build the fixture project ---
function folder(name, parent) {
  const f = project.items.addFolder(name);
  if (parent) f.parentFolder = parent;
  return f;
}
const comps = folder("_COMPS");
const promo = folder("Promo", comps);
const social = folder("Social", comps);
const broadcast = folder("Broadcast", comps);
folder("Promo");                 // decoy: same name at ROOT — must not confuse paths
const looseComp = new CompItem("Main Comp");
looseComp.parentFolder = root;

// --- load the real hostscript ---
eval(fs.readFileSync(require("path").join(__dirname, "..", "extension", "jsx", "hostscript.jsx"), "utf8"));

function call(tool, args) {
  return JSON.parse($.global.AELL_call(tool, JSON.stringify(args)));
}
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// 1. Model's first step: inspect — folder paths must be visible.
const info = call("get_project_info", {});
assert(info.ok, "get_project_info succeeds");
const subPaths = info.data.items
  .filter(x => x.type === "folder" && x.folder === "_COMPS")
  .map(x => x.path);
assert(JSON.stringify(subPaths.sort()) ===
       JSON.stringify(["_COMPS/Broadcast", "_COMPS/Promo", "_COMPS/Social"]),
       "subfolders of _COMPS enumerable with paths: " + subPaths.join(", "));

// 2. Create _ARCHIVE inside each — same name, three different parents.
for (const p of subPaths) {
  const r = call("create_folder", { name: "_ARCHIVE", parent: p });
  assert(r.ok && !r.data.note, "_ARCHIVE created fresh in " + p +
         (r.ok ? "" : " -> " + r.error));
}
assert(promo.children.some(c => c.name === "_ARCHIVE"), "Promo has _ARCHIVE");
assert(social.children.some(c => c.name === "_ARCHIVE"), "Social has _ARCHIVE");
assert(broadcast.children.some(c => c.name === "_ARCHIVE"), "Broadcast has _ARCHIVE");
assert(ALL_ITEMS.filter(i => i.name === "_ARCHIVE").length === 3,
       "exactly three distinct _ARCHIVE folders exist");

// 3. Idempotency: re-running reports already-exists, creates nothing new.
const again = call("create_folder", { name: "_ARCHIVE", parent: "_COMPS/Promo" });
assert(again.ok && /already existed/.test(again.data.note || ""),
       "re-create in same parent reports 'already existed'");
assert(ALL_ITEMS.filter(i => i.name === "_ARCHIVE").length === 3,
       "still exactly three _ARCHIVE folders");

// 4. Path disambiguation: decoy root 'Promo' must NOT receive children.
const decoy = ALL_ITEMS.find(i => i.name === "Promo" && i._parent === root);
assert(decoy.children.length === 0, "decoy root 'Promo' untouched");

// 5. move/rename round-trip through paths.
const mv = call("move_to_folder", { items: "Main Comp", folder: "_COMPS/Promo/_ARCHIVE" });
assert(mv.ok && mv.data.moved[0] === "Main Comp", "comp moved into nested _ARCHIVE by path");
const rn = call("rename_item", { item: "Main Comp", name: "Main Comp OLD" });
assert(rn.ok && rn.data.name === "Main Comp OLD", "rename works");

// 6. delete BY PATH (three same-named folders exist) notes the cascade.
const del = call("delete_item", { item: "_COMPS/Promo/_ARCHIVE" });
assert(del.ok && /contained 1 item/.test(del.data.note || ""),
       "path-addressed folder delete reports contained items: " +
       JSON.stringify(del.data));
assert(!promo.children.some(c => c.name === "_ARCHIVE") &&
       social.children.some(c => c.name === "_ARCHIVE"),
       "exactly the Promo _ARCHIVE was deleted, Social's survives");
// 7. rename by path disambiguates too.
const rn2 = call("rename_item", { item: "_COMPS/Social/_ARCHIVE", name: "_ARCHIVE_OLD" });
assert(rn2.ok && social.children.some(c => c.name === "_ARCHIVE_OLD"),
       "path-addressed rename hit the right folder");

// 8. "at the root" phrasings all work for create_folder.
const atRoot = call("create_folder", { name: "_ARCHIVE", parent: "root" });
assert(atRoot.ok && ALL_ITEMS.some(i => i.name === "_ARCHIVE" && i._parent === root),
       "create_folder parent:'root' creates at project root");
const noParent = call("create_folder", { name: "_RENDERS" });
assert(noParent.ok && ALL_ITEMS.some(i => i.name === "_RENDERS" && i._parent === root),
       "create_folder with parent omitted defaults to root");
const parenRoot = call("move_to_folder", { items: "_RENDERS", folder: "(root)" });
assert(parenRoot.ok, "move_to_folder accepts '(root)' alias");

// 9. failed lookups list the folders that actually exist (grounded retry).
const badParent = call("create_folder", { name: "X", parent: "NoSuchFolder" });
assert(!badParent.ok && /Existing folders:.*_COMPS/.test(badParent.error),
       "failed parent lookup lists real folders: " +
       badParent.error.slice(0, 100));
const badMove = call("move_to_folder", { items: "_RENDERS", folder: "Imaginary" });
assert(!badMove.ok && /Existing folders:/.test(badMove.error),
       "failed move target lists real folders");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
