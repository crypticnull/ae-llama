/*
 * test-scan-model-roots.js — Setup.scanForModelRoots (WORKPLAN §19a).
 *
 * What this pins:
 *   - it probes the NAMED shortlist only (Documents\ComfyUI, ~\ComfyUI,
 *     the Comfy-Desktop store, <comfyDir>\models, roots a ComfyUI yaml
 *     declares) and never anything else on the disk;
 *   - it counts model files by EXTENSION inside the kind folders, not by
 *     catalog membership, and ignores non-model files and empty files;
 *   - a folder with no model file is not a candidate;
 *   - a candidate the panel's search path already covers says so;
 *   - per-kind yaml roots count only for their own kind.
 * Real setup.js + tools.js + comfy.js over a temp disk and a fake env.
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
  assert(JSON.stringify(actual) === JSON.stringify(expected),
         label + " [" + JSON.stringify(actual) + "]");
}

const REPO = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aell-scanroots-"));
const HOME = path.join(TMP, "home");
const LOCALAPP = path.join(TMP, "localapp");
const APPDATA = path.join(TMP, "appdata");
const COMFY = path.join(TMP, "mycomfy");
const ELSEWHERE = path.join(TMP, "elsewhere", "models"); // off the list
const YAML_CKPT = path.join(TMP, "big-drive", "ckpts");

const fakeProcess = { env: { USERPROFILE: HOME, LOCALAPPDATA: LOCALAPP,
                             APPDATA: APPDATA },
                      platform: process.platform };
let SETTINGS = { comfyDir: COMFY, comfyModelRoots: [] };

const window = {
  AEBridge: {
    nodeRequire: (name) => name === "process" ? fakeProcess : require(name),
    getExtensionPath: () => path.join(REPO, "extension"),
    available: () => true,
    evalScript: () => {}
  },
  Settings: { get: () => SETTINGS, dataRoot: () => path.join(TMP, "data") },
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
load("extension/js/version.js");
load("extension/js/comfy.js");
load("extension/js/setup.js");
load("extension/js/tools.js");
const Setup = window.Setup;

function put(dir, file, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), Buffer.alloc(bytes === undefined ? 16 : bytes, 1));
}

// Documents\ComfyUI: 2 checkpoints (one in a subfolder), 1 lora, plus
// noise that must not count.
const DOCS = path.join(HOME, "Documents", "ComfyUI", "models");
put(path.join(DOCS, "checkpoints"), "a.safetensors");
put(path.join(DOCS, "checkpoints", "sdxl"), "b.ckpt");
put(path.join(DOCS, "checkpoints"), "put_checkpoints_here");
put(path.join(DOCS, "checkpoints"), "preview.png");
put(path.join(DOCS, "checkpoints"), "empty.safetensors", 0);
put(path.join(DOCS, "loras"), "style.safetensors");
put(path.join(DOCS, "not_a_kind"), "stray.safetensors");
// ~\ComfyUI exists but holds only placeholders: not a candidate.
put(path.join(HOME, "ComfyUI", "models", "checkpoints"), "put_checkpoints_here");
// Comfy-Desktop store: a gguf and a vae.
const SHARED = path.join(LOCALAPP, "Comfy-Desktop", "ComfyUI-Shared", "models");
put(path.join(SHARED, "diffusion_models"), "wan.gguf");
put(path.join(SHARED, "vae"), "wan_vae.safetensors");
// <comfyDir>\models
put(path.join(COMFY, "models", "text_encoders"), "t5.safetensors");
// A per-kind root declared in the user's own yaml. It also holds a
// "vae" folder, which a checkpoints root must not count as vae.
put(YAML_CKPT, "big.safetensors");
put(path.join(YAML_CKPT, "vae"), "x.safetensors");
fs.writeFileSync(path.join(COMFY, "extra_model_paths.yaml"),
  "mine:\n  base_path: " + path.join(TMP, "big-drive") + "\n" +
  "  checkpoints: ckpts\n");
// Off the shortlist: must never be found.
put(path.join(ELSEWHERE, "checkpoints"), "secret.safetensors");

let found = Setup.scanForModelRoots(SETTINGS);
const byPath = {};
found.forEach((c) => { byPath[c.path] = c; });

assert(typeof Setup.scanForModelRoots === "function", "Setup.scanForModelRoots is exported");
eq(found.map((c) => c.path),
   [DOCS, SHARED, path.join(COMFY, "models"), YAML_CKPT],
   "shortlist order, empty and off-list folders absent");
eq(byPath[DOCS] && byPath[DOCS].counts, { checkpoints: 2, loras: 1 },
   "Documents counts by extension, recurses into subfolders, skips placeholders/png/empty/unknown kinds");
eq(byPath[DOCS] && byPath[DOCS].total, 3, "Documents total");
eq(byPath[SHARED] && byPath[SHARED].counts, { diffusion_models: 1, vae: 1 },
   "Desktop store counts gguf too");
eq(byPath[YAML_CKPT] && byPath[YAML_CKPT].kind, "checkpoints", "yaml per-kind root keeps its kind");
eq(byPath[YAML_CKPT] && byPath[YAML_CKPT].counts, { checkpoints: 2 },
   "a per-kind root counts everything under it as that kind only");
assert(!found.some((c) => c.path.indexOf("elsewhere") !== -1), "never probes off the shortlist");

// covered: Documents is not on the search path; the Desktop store,
// comfyDir\models and yaml roots are (Tools.comfyModelRoots finds them).
eq(byPath[DOCS] && byPath[DOCS].covered, false, "Documents\\ComfyUI offered (not already searched)");
eq(byPath[SHARED] && byPath[SHARED].covered, true, "Desktop store marked covered");
eq(byPath[path.join(COMFY, "models")] && byPath[path.join(COMFY, "models")].covered, true,
   "comfyDir models marked covered");
eq(byPath[YAML_CKPT] && byPath[YAML_CKPT].covered, true, "yaml root marked covered");

// Once the user adds it (trailing slash, other case), it is covered.
SETTINGS = { comfyDir: COMFY, comfyModelRoots: [DOCS.toUpperCase() + path.sep] };
found = Setup.scanForModelRoots(SETTINGS);
eq(found.filter((c) => c.path === DOCS).map((c) => c.covered), [true],
   "an added root is covered regardless of case and trailing separator");

// Injected deps: no comfyDir, no env -> nothing, and no throw.
eq(Setup.scanForModelRoots({}, { env: {}, covered: [] }), [], "empty env finds nothing");

fs.rmSync(TMP, { recursive: true, force: true });
if (failures) { console.log("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nALL CHECKS PASSED");
