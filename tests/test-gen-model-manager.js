/*
 * test-gen-model-manager.js — the settings per-model rows must tell the
 * truth about the disk, and Remove must never reach outside the panel's
 * own folders.
 *
 * What this pins (built 2026-08-30, owner request: "make it easy to
 * remove those downloads later"):
 *   - catalogModelStatus measures what IS there, file by file, across
 *     every root the panel knows — including the Comfy-Desktop shared
 *     store and the user's own extra roots — and says for each file
 *     whether it sits somewhere the panel manages (deletable) or in
 *     somebody else's folder (reported, never touched).
 *   - removeCatalogWeights deletes ONLY from the panel-managed roots
 *     (the Settings models folder + the hidden backend's own tree),
 *     with receipts: removed (and the MiB freed), kept (with WHY and
 *     WHERE), failed (Windows holding an open file gets an actionable
 *     sentence, not a stack).
 *   - genWeightDest refuses with a grounded sentence when there is no
 *     panel-managed folder to download into, and never invents one.
 *   - applyExtraModelPaths now writes the Comfy-Desktop shared store
 *     into the backend's extra_model_paths.yaml, so the hidden backend
 *     can LOAD what the Desktop app downloaded (the H3 gap: the panel
 *     priced weights the backend could not see).
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}
function eq(actual, expected, label) {
  assert(actual === expected, label + " [" + JSON.stringify(actual) + "]");
}

const REPO = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aell-genmgr-"));

// ------------------------------------------------------------- the rig
//
// Real comfy.js + setup.js + tools.js over a fake disk. The fake
// "process" is how the Comfy-Desktop shared store is steered: tools.js
// and comfy.js both find it via LOCALAPPDATA, never via a config file
// (there is none — measured on the dev machine, that is the whole bug).

const MANAGED = path.join(TMP, "managed");        // Settings models folder
const USER = path.join(TMP, "userroot");          // user's own extra root
const LOCALAPP = path.join(TMP, "localapp");
const SHARED = path.join(LOCALAPP, "Comfy-Desktop", "ComfyUI-Shared",
                         "models");
let DATA = path.join(TMP, "data");                // switchable dataRoot
const VENDOR = path.join(DATA, "vendor", "comfy", "Comfy_win");

const fakeProcess = { env: { LOCALAPPDATA: LOCALAPP },
                      platform: process.platform };

// The fs the panel code sees: real, except unlinkSync can be told to
// refuse one file — the deterministic stand-in for Windows holding a
// weight the backend still has open (chmod tricks stop neither root
// nor Windows).
let failUnlinkFor = null;
const fsForPanel = Object.create(fs);
fsForPanel.unlinkSync = function (p) {
  if (failUnlinkFor && String(p).indexOf(failUnlinkFor) !== -1) {
    const e = new Error("EBUSY: resource busy or locked, unlink '" +
                        p + "'");
    e.code = "EBUSY";
    throw e;
  }
  return fs.unlinkSync(p);
};

const SETTINGS = {
  comfyModelsDir: MANAGED,
  comfyModelRoots: [USER, path.join(TMP, "managed2")],
  comfyDir: ""
};

const window = {
  AEBridge: {
    nodeRequire: (name) => name === "process" ? fakeProcess
                 : name === "fs" ? fsForPanel : require(name),
    getExtensionPath: () => path.join(REPO, "extension"),
    available: () => true,
    evalScript: () => {}
  },
  Settings: {
    get: () => SETTINGS,
    dataRoot: () => DATA
  },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  console: console,
  localStorage: { getItem: () => null, setItem: () => {} }
};
window.window = window;

function load(rel) {
  const src = fs.readFileSync(path.join(REPO, rel), "utf8");
  // eslint-disable-next-line no-eval
  (function (global) { eval(src); })(window);
}
// Same order the panel loads them (setup.js needs nothing of tools at
// load time; tools.js reaches Setup/Comfy only at call time).
load("extension/js/comfy.js");
load("extension/js/setup.js");
load("extension/js/tools.js");

const Tools = window.Tools, Setup = window.Setup, Comfy = window.Comfy;

// The vendor install findComfyInstall recognizes: main.py + embedded
// python under <dataRoot>/vendor/comfy/<folder>/.
fs.mkdirSync(path.join(VENDOR, "ComfyUI"), { recursive: true });
fs.writeFileSync(path.join(VENDOR, "ComfyUI", "main.py"), "# stub\n");
fs.mkdirSync(path.join(VENDOR, "python_embeded"), { recursive: true });
fs.writeFileSync(path.join(VENDOR, "python_embeded", "python.exe"), "MZ");

const MiB = 1048576;
function put(root, kind, file) {
  const dir = path.join(root, kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), Buffer.alloc(MiB, 7));
  return path.join(dir, file);
}

const E_URLS = {
  name: "wan-test", label: "Wan Test", kind: "video", sizeMB: 300,
  urls: [
    { url: "https://host/repo/dm.safetensors?download=true",
      sizeMB: 100, dir: "diffusion_models" },
    { url: "https://host/repo/te.safetensors", sizeMB: 100,
      dir: "text_encoders" },
    { url: "https://host/repo/vae.safetensors", sizeMB: 100, dir: "vae" }
  ]
};
const E_FILES = {
  name: "krea-test", label: "Krea Test", kind: "image",
  files: ["k1.safetensors", "k2.safetensors"], urls: []
};

// ------------------------------------------------ status: empty disk

let st = Tools.catalogModelStatus(E_URLS, SETTINGS);
eq(st.totalCount, 3, "urls[] entry knows all three files");
eq(st.presentCount, 0, "nothing on disk yet");
eq(st.downloadable, true, "pinned links make it downloadable");
eq(st.files[0].file, "dm.safetensors",
   "the filename is the URL basename, query string stripped");

st = Tools.catalogModelStatus(E_FILES, SETTINGS);
eq(st.totalCount, 2, "files[] entry counts its bare names");
eq(st.downloadable, false, "no pinned links = not downloadable");

// -------------------------------------- status: files across roots

put(MANAGED, "diffusion_models", "dm.safetensors");
put(USER, "text_encoders", "te.safetensors");
put(SHARED, "vae", "vae.safetensors");

st = Tools.catalogModelStatus(E_URLS, SETTINGS);
eq(st.presentCount, 3, "all three found across three different roots");
eq(st.presentMB, 3, "presentMB is the measured MiB sum");
const byName = {};
for (const f of st.files) byName[f.file] = f;
eq(byName["dm.safetensors"].managed, true,
   "the Settings models folder is panel-managed");
eq(byName["te.safetensors"].managed, false,
   "the user's extra root is NOT panel-managed");
eq(byName["vae.safetensors"].managed, false,
   "the Comfy-Desktop shared store is NOT panel-managed");
eq(st.anyManaged, true, "anyManaged: there is something to Remove");

// A sibling directory whose name merely EXTENDS a managed root must not
// count as inside it ("managed2" starts with "managed").
put(path.join(TMP, "managed2"), "loras", "k2.safetensors");
let stf = Tools.catalogModelStatus(E_FILES, SETTINGS);
const k2 = stf.files.filter((f) => f.file === "k2.safetensors")[0];
assert(k2.path && k2.managed === false,
       "a root named managed2 is not inside the root named managed");

// Bare names (files[]) are found by searching every kind folder.
put(MANAGED, "checkpoints", "k1.safetensors");
stf = Tools.catalogModelStatus(E_FILES, SETTINGS);
eq(stf.presentCount, 2, "bare filenames are found across kind folders");
eq(stf.files.filter((f) => f.file === "k1.safetensors")[0].managed, true,
   "and the managed one is deletable");

// ------------------------------------------------ remove: the fence

// The same file in BOTH a managed root and the user's root: the search
// prefers the managed copy, Remove deletes exactly that one, and the
// user's copy is untouched and found again afterwards.
const teManaged = put(MANAGED, "text_encoders", "te.safetensors");
let r = Tools.removeCatalogWeights(E_URLS, SETTINGS);
eq(r.removed.length, 2, "removed the two managed files, nothing else");
eq(r.freedMB, 2, "freedMB is the measured sum of what was deleted");
eq(r.kept.length, 1, "the shared-store file was kept");
assert(r.kept[0].why.indexOf("panel-managed") !== -1,
       "and the receipt says WHY it was kept");
assert(!fs.existsSync(teManaged), "the managed te copy is gone");
assert(fs.existsSync(path.join(USER, "text_encoders", "te.safetensors")),
       "the user's own te copy was never touched");
assert(fs.existsSync(path.join(SHARED, "vae", "vae.safetensors")),
       "the shared store was never touched");

st = Tools.catalogModelStatus(E_URLS, SETTINGS);
eq(st.presentCount, 2,
   "after Remove the user's copies still register (te + vae)");
eq(st.anyManaged, false, "and nothing deletable is left");

r = Tools.removeCatalogWeights(E_URLS, SETTINGS);
eq(r.removed.length, 0, "a second Remove deletes nothing");
eq(r.kept.length, 2, "and reports the two foreign copies it left alone");

// A truly absent model says so in one sentence.
r = Tools.removeCatalogWeights(
  { name: "ghost", label: "Ghost", urls: [], files: ["nope.safetensors"] },
  SETTINGS);
assert(r.note.indexOf("Ghost") !== -1 && r.note.indexOf("disk") !== -1,
       "removing a model that is not there says so, named");

// An undeletable file (Windows: the backend still holds it open) gets
// an actionable receipt, not a throw.
failUnlinkFor = "k1.safetensors";
r = Tools.removeCatalogWeights(E_FILES, SETTINGS);
failUnlinkFor = null;
eq(r.failed.length, 1, "an unlink failure lands in failed[]");
assert(r.failed[0].error.indexOf("stop it and retry") !== -1,
       "with the sentence a user can act on");
assert(fs.existsSync(path.join(MANAGED, "checkpoints", "k1.safetensors")),
       "and the file it could not delete is still there, reported");

// ------------------------------------- download target resolution

let plan = Setup._genWeightDest(E_URLS.urls[0]);
eq(plan.dest,
   path.join(MANAGED, "diffusion_models", "dm.safetensors"),
   "with a Models folder set, downloads land in its kind layout");

SETTINGS.comfyModelsDir = "";
plan = Setup._genWeightDest(E_URLS.urls[1]);
eq(plan.dest,
   path.join(VENDOR, "ComfyUI", "models", "text_encoders",
             "te.safetensors"),
   "without one, the hidden backend's own tree is the target");

DATA = path.join(TMP, "empty-data");   // no vendor install here
plan = Setup._genWeightDest(E_URLS.urls[0]);
assert(plan.err && plan.err.indexOf("Models folder in Settings") !== -1,
       "no managed root at all refuses with the two ways to get one");

plan = Setup._genWeightDest({ sizeMB: 5 });
assert(plan.err && plan.err.indexOf("not pinned yet") !== -1,
       "an entry without pinned links refuses by name");

DATA = path.join(TMP, "data");
SETTINGS.comfyModelsDir = MANAGED;

// An already-present file is answered without any network at all. (The
// absent-file path opens a real socket, so it stays untested here — the
// dest arithmetic above is the part that can rot.)
put(MANAGED, "vae", "vae.safetensors");
let dlDone = null;
const ctrl2 = Setup.downloadGenWeight(E_URLS.urls[2],
  {}, (err, dest) => { dlDone = { err: err, dest: dest }; });
assert(dlDone && !dlDone.err &&
       dlDone.dest === path.join(MANAGED, "vae", "vae.safetensors"),
       "a file already on disk is answered instantly, no download");
eq(ctrl2, null, "and no controller is opened for it");

// ------------------------------- the yaml the hidden backend reads

const yamlPath = path.join(VENDOR, "ComfyUI", "extra_model_paths.yaml");

SETTINGS.comfyModelsDir = "";
SETTINGS.comfyModelRoots = [];
Comfy._applyExtraModelPaths({ root: VENDOR });
assert(fs.existsSync(yamlPath),
       "empty settings still write the yaml when a shared store exists");
let yaml = fs.readFileSync(yamlPath, "utf8");
assert(yaml.indexOf("comfy_desktop_shared:") !== -1,
       "the Comfy-Desktop shared store is a section of its own");
assert(yaml.indexOf(SHARED.replace(/\\/g, "/")) !== -1,
       "with its real base_path, forward slashes");
assert(/diffusion_models: \|\r?\n    diffusion_models\r?\n    checkpoints/.test(yaml) &&
       yaml.indexOf("text_encoders: text_encoders") !== -1,
       "and every kind folder mapped (checkpoints as diffusion models too)");

SETTINGS.comfyModelsDir = MANAGED;
Comfy._applyExtraModelPaths({ root: VENDOR });
yaml = fs.readFileSync(yamlPath, "utf8");
assert(yaml.indexOf("aellama:") !== -1 &&
       yaml.indexOf("comfy_desktop_shared:") !== -1,
       "the models folder and the shared store coexist in one yaml");

delete fakeProcess.env.LOCALAPPDATA;
SETTINGS.comfyModelsDir = "";
Comfy._applyExtraModelPaths({ root: VENDOR });
assert(fs.existsSync(yamlPath) &&
       fs.readFileSync(yamlPath, "utf8").indexOf("comfy_desktop_shared:") === -1 &&
       fs.readFileSync(yamlPath, "utf8").indexOf("aellama:") === -1,
       "no settings and no shared store drops both sections; the yaml " +
       "stays for the backend's own checkpoints-as-diffusion-models line");
fakeProcess.env.LOCALAPPDATA = LOCALAPP;
SETTINGS.comfyModelsDir = MANAGED;

// ------------------------------------------------ anti-drift checks

const mainSrc = fs.readFileSync(
  path.join(REPO, "extension", "js", "main.js"), "utf8");
assert(mainSrc.indexOf("Tools.catalogModelStatus") !== -1,
       "main.js rows read the same status the tests exercise");
assert(mainSrc.indexOf("Tools.removeCatalogWeights") !== -1,
       "main.js Remove goes through the fenced deleter, no ad-hoc unlink");
assert(mainSrc.indexOf("Setup.downloadGenWeight") !== -1,
       "main.js Download goes through the managed-root resolver");
assert(mainSrc.indexOf("renderGenModelRows()") !== -1,
       "the rows re-render when settings open/change");
const htmlSrc = fs.readFileSync(
  path.join(REPO, "extension", "index.html"), "utf8");
assert(htmlSrc.indexOf("comfy-genmodels-list") !== -1,
       "index.html carries the rows' container");
assert(Array.isArray(Comfy.MODEL_SUBS) && Comfy.MODEL_SUBS.length >= 8,
       "comfy.js exports the single kind-folder list tools.js searches");

// ---------------------------------------------------------- summary

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

if (failures) {
  console.log(failures + " FAILED");
  process.exit(1);
}
console.log("all ok");
