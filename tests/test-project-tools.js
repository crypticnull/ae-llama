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
    addComp(name, w, h, ar, dur, fps) {
      const c = new CompItem(name);
      c.width = w; c.height = h; c.duration = dur; c.frameRate = fps;
      c.openInViewer = () => {};
      c.parentFolder = root;
      return c;
    }
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

// 10. create_comp never silently reuses a taken name — the field failure
// where a same-named second comp made every later command hit the OLD one.
const c1 = call("create_comp", { name: "Squares", width: 1920, height: 1080 });
assert(c1.ok && c1.data.name === "Squares", "first comp keeps its name");
const c2 = call("create_comp", { name: "Squares", width: 1920, height: 1080 });
assert(c2.ok && c2.data.name === "Squares 2",
       "colliding comp name auto-numbers (got " + c2.data.name + ")");
assert(/use THIS name/i.test(c2.data.note),
       "collision note tells the model which name to use");

// batched same-reply references to the requested name must hit the NEW
// comp, not the old one (the model writes its whole batch before seeing
// the rename result).
const aliased = call("set_comp_setting", { comp: "Squares", duration: 5 });
assert(aliased.ok && aliased.data.name === "Squares 2",
       "same-name reference right after an auto-rename redirects to the " +
       "new comp (got " + (aliased.ok ? aliased.data.name : aliased.error) +
       ")");

// aliases are scoped to ONE user request — the panel clears them when the
// next request starts, so old comps stay addressable by their real name.
$.global.AELL_newRequest();
const literal = call("set_comp_setting", { comp: "Squares", duration: 7 });
assert(literal.ok && literal.data.name === "Squares",
       "new request clears the alias — literal name hits the old comp " +
       "again (got " + (literal.ok ? literal.data.name : literal.error) +
       ")");

// a manually-renamed comp self-heals: the not-found error lists the real
// comps so the model retries with a live name.
const gone = call("set_comp_setting", { comp: "OldName", duration: 3 });
assert(!gone.ok && /Comps in this project:.*Squares 2/.test(gone.error),
       "comp-not-found error lists the project's real comps: " +
       gone.error.slice(0, 90));

// 11. eachChildOf — the field failure of 2026-08-26, replayed. Asked for
// _ARCHIVE inside each of 10 subfolders of a work project, the model
// acted from the TRIMMED project summary, hit 2 wrong-ish targets and
// claimed the whole job done. This form makes the host walk the real
// subfolders in one call, so the receipts are real or the claim is
// impossible.
const field = folder("_FIELD");
const north = folder("North", field);
const south = folder("South", field);
const chicago = folder("Chicago", field);
folder("_ARCHIVE", chicago);              // one child already archived
const fieldComp = new CompItem("Field Comp");
fieldComp.parentFolder = field;           // a comp is NOT a subfolder

const fan = call("create_folder", { name: "_ARCHIVE", eachChildOf: "_FIELD" });
assert(fan.ok, "eachChildOf fan-out answers (" + (fan.error || "") + ")");
assert(fan.data.subfolders === 3 && fan.data.createdCount === 2,
       "3 real subfolders seen, 2 created (Chicago already had one): " +
       JSON.stringify(fan.data));
assert(JSON.stringify((fan.data.created || []).sort()) ===
       JSON.stringify(["_FIELD/North/_ARCHIVE", "_FIELD/South/_ARCHIVE"]),
       "created lists the exact real paths — the receipts (got " +
       JSON.stringify(fan.data.created) + ")");
assert(fan.data.alreadyExistedCount === 1 &&
       fan.data.alreadyExisted[0] === "_FIELD/Chicago/_ARCHIVE",
       "the pre-existing one is reported as existing, not created");
assert(north.children.some(c => c.name === "_ARCHIVE") &&
       south.children.some(c => c.name === "_ARCHIVE"),
       "…and the folders are really in the stubbed project");
assert(!field.children.some(c => c.name === "_ARCHIVE"),
       "NOTHING was created directly inside _FIELD itself — the exact " +
       "wrong level the field failure produced");
assert(fieldComp.numLayers === 0 && !fieldComp.children,
       "the comp child was skipped, not treated as a folder");

// idempotent: run it again, nothing new, everything reported existing.
const fan2 = call("create_folder", { name: "_ARCHIVE", eachChildOf: "_FIELD" });
assert(fan2.ok && fan2.data.createdCount === 0 &&
       fan2.data.alreadyExistedCount === 3,
       "second run creates nothing and says so (got " +
       JSON.stringify(fan2.data) + ")");

// a folder with no subfolders refuses with its real contents.
const leaf = folder("_LEAF");
const leafComp = new CompItem("Leaf Comp");
leafComp.parentFolder = leaf;
const noKids = call("create_folder", { name: "X", eachChildOf: "_LEAF" });
assert(!noKids.ok && /no subfolders/.test(noKids.error) &&
       /Leaf Comp/.test(noKids.error),
       "no-subfolders refusal names what the folder really holds: " +
       noKids.error.slice(0, 120));

// a bad reference stays grounded.
const badEach = call("create_folder", { name: "X", eachChildOf: "Nope" });
assert(!badEach.ok && /Existing folders:/.test(badEach.error),
       "unknown eachChildOf lists the folders that really exist");

// 12. "except for _North" — the second field sentence of 2026-08-26.
// The exclusion is a promise: excluded children are untouched and
// REPORTED, and an except name that matches no real subfolder refuses
// (silently creating in "_North" because the model wrote "North" would
// betray exactly the folder the user asked to spare).
const exc = folder("_EXC");
const excA = folder("Alpha", exc);
const excNorth = folder("_North", exc);
const excB = folder("Beta", exc);
const fanX = call("create_folder",
  { name: "_ARCHIVE", eachChildOf: "_EXC", except: ["_North"] });
assert(fanX.ok && fanX.data.createdCount === 2 &&
       JSON.stringify(fanX.data.skippedAsExcepted) ===
       JSON.stringify(["_North"]),
       "except skips exactly _North and says so (got " +
       JSON.stringify(fanX.data) + ")");
assert(excNorth.children.length === 0,
       "_North was really left untouched");
assert(excA.children.some(c => c.name === "_ARCHIVE") &&
       excB.children.some(c => c.name === "_ARCHIVE"),
       "…while Alpha and Beta got their archives");

// a lone string works like a one-item list — models write both.
const fanS = call("create_folder",
  { name: "_KEEP", eachChildOf: "_EXC", except: "_North" });
assert(fanS.ok && fanS.data.createdCount === 2 &&
       excNorth.children.length === 0,
       "except as a bare string behaves like a one-item list");

// a guessed name refuses BEFORE creating anything, naming the real ones.
const fanBad = call("create_folder",
  { name: "_NOPE", eachChildOf: "_EXC", except: ["North"] });
assert(!fanBad.ok && /North/.test(fanBad.error) &&
       /_North/.test(fanBad.error) && /nothing was created/.test(fanBad.error),
       "a non-matching except name refuses and lists the real " +
       "subfolders: " + fanBad.error.slice(0, 130));
assert(!excA.children.some(c => c.name === "_NOPE"),
       "…and truly nothing was created on the refusal");

// excluding everything is an error, not a silent no-op.
const fanAll = call("create_folder",
  { name: "_X", eachChildOf: "_EXC",
    except: ["Alpha", "_North", "Beta"] });
assert(!fanAll.ok && /every subfolder/.test(fanAll.error),
       "excluding every subfolder refuses with the reason");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
