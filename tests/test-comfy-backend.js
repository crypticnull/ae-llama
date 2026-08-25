// Regression test: hidden ComfyUI backend setup helpers (asset picking +
// portable-install detection) running setup.js in a sandboxed window.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aell-comfy-"));

const window = {
  AEBridge: {
    nodeRequire: require,
    getExtensionPath: () => tmpRoot
  },
  Settings: { dataRoot: () => tmpRoot },
  AELL: { VERSION: "0.0.0", UPDATE_MANIFEST_URL: "http://localhost/x" },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout
};

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                "setup.js"), "utf8"));
const Setup = window.Setup;

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// 1. asset picking: GPU machines get the nvidia portable build
const assets = [
  { name: "ComfyUI_windows_portable_nvidia.7z", size: 1600000000 },
  { name: "ComfyUI_windows_portable_cpu.7z", size: 1400000000 },
  { name: "Source code (zip)", size: 1 }
];
assert(Setup.pickComfyAsset(assets, true).name ===
       "ComfyUI_windows_portable_nvidia.7z",
       "NVIDIA machine picks the nvidia portable 7z");
assert(Setup.pickComfyAsset(assets, false).name ===
       "ComfyUI_windows_portable_cpu.7z",
       "no-GPU machine picks the cpu portable 7z");
assert(Setup.pickComfyAsset(
         [{ name: "ComfyUI_windows_portable.7z" }], true).name ===
       "ComfyUI_windows_portable.7z",
       "generic portable 7z is the fallback either way");
assert(Setup.pickComfyAsset([{ name: "Source code (zip)" }], true) === null,
       "no portable asset -> null (never grabs source archives)");
assert(Setup.pickComfyAsset(
         [{ name: "comfyui_WINDOWS_PORTABLE_NVIDIA_cu128.7z" }], true) !==
       null, "asset matching is case-insensitive and suffix-tolerant");

// 2. install detection: nothing installed yet
assert(Setup.findComfyInstall() === null,
       "empty vendor/comfy -> no install found");

// 3. install detection: the portable layout is recognized
const root = path.join(tmpRoot, "vendor", "comfy",
                       "ComfyUI_windows_portable");
fs.mkdirSync(path.join(root, "ComfyUI"), { recursive: true });
fs.mkdirSync(path.join(root, "python_embeded"), { recursive: true });
fs.writeFileSync(path.join(root, "ComfyUI", "main.py"), "# comfy");
fs.writeFileSync(path.join(root, "python_embeded", "python.exe"), "");
const inst = Setup.findComfyInstall();
assert(inst && inst.root === root,
       "portable layout detected under vendor/comfy");
assert(inst.python.endsWith(path.join("python_embeded", "python.exe")) &&
       inst.mainPy.endsWith(path.join("ComfyUI", "main.py")),
       "python + main.py paths resolved for the hidden spawn");

// 4. an already-present install short-circuits bootstrapComfy
let done = null;
const ctrl = Setup.bootstrapComfy(null, null, (err, res) => {
  done = { err, res };
});
assert(ctrl && typeof ctrl.cancel === "function",
       "bootstrapComfy returns a cancel controller");
assert(done && !done.err && done.res.alreadyInstalled &&
       done.res.root === root,
       "existing install short-circuits without downloading");

// 5. external models folder maps into the backend via extra_model_paths
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                "comfy.js"), "utf8"));
const Comfy = window.Comfy;
const modelsDir = path.join(tmpRoot, "big-models");
window.Settings.get = () => ({ comfyModelsDir: modelsDir });
const yamlPath = Comfy._applyExtraModelPaths({ root });
assert(yamlPath && fs.existsSync(yamlPath) &&
       yamlPath === path.join(root, "ComfyUI", "extra_model_paths.yaml"),
       "extra_model_paths.yaml written inside the vendor install");
const yaml = fs.readFileSync(yamlPath, "utf8");
assert(yaml.includes("base_path: " + modelsDir.replace(/\\/g, "/")) &&
       /checkpoints: checkpoints/.test(yaml) &&
       /diffusion_models: diffusion_models/.test(yaml),
       "yaml maps the external base path and model subfolders");
assert(fs.existsSync(path.join(modelsDir, "checkpoints")) &&
       fs.existsSync(path.join(modelsDir, "loras")),
       "standard model subfolders created in the external location");

// 5b. extra roots: veterans have models spread across drives. A bare
// path maps the standard subfolders; "kind=path" maps ONE kind with the
// folder itself as that kind's root. User folders are read, never
// restructured — no subfolders are created in them.
const extraRoot = path.join(tmpRoot, "user-stash");
fs.mkdirSync(extraRoot, { recursive: true });
window.Settings.get = () => ({
  comfyModelsDir: modelsDir,
  comfyModelRoots: [extraRoot, "checkpoints=" + path.join(tmpRoot, "ck"),
                    "   ", ""]
});
assert(Comfy._applyExtraModelPaths({ root }) === yamlPath,
       "extra roots write into the same yaml");
const yaml2 = fs.readFileSync(yamlPath, "utf8");
assert(yaml2.includes("aellama_extra_0:") &&
       yaml2.includes("base_path: " + extraRoot.replace(/\\/g, "/")),
       "a bare extra root becomes its own yaml section");
assert(yaml2.includes("aellama_extra_1:") &&
       /checkpoints: \./.test(yaml2),
       "a kind=path root maps the folder AS that kind (checkpoints: .)");
assert(!yaml2.includes("aellama_extra_2:"),
       "blank lines in the setting are ignored");
assert(fs.readdirSync(extraRoot).length === 0,
       "the user's own folder was not restructured");

// A drive letter is a path, not a kind: "D:\..." must not be split at
// the colon-free '=' rule's expense.
window.Settings.get = () => ({
  comfyModelsDir: "", comfyModelRoots: ["D:\\SD\\everything"]
});
assert(/base_path: D:\/SD\/everything/.test(
         fs.readFileSync(Comfy._applyExtraModelPaths({ root }), "utf8")),
       "a windows drive path is one root, not a kind=path split");

// clearing the setting removes the mapping
window.Settings.get = () => ({ comfyModelsDir: "", comfyModelRoots: [] });
assert(Comfy._applyExtraModelPaths({ root }) === null &&
       !fs.existsSync(yamlPath),
       "blank settings remove a previously written mapping");

// 5c. freeVram is exported — the VRAM arbiter's gen->chat half asks
// ComfyUI to unload its cached models before the chat model returns.
assert(typeof Comfy.freeVram === "function",
       "Comfy.freeVram exists for the arbiter's resume path");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
