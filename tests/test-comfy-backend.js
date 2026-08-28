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

// 6. a dead comfyUrl while a ComfyUI IS running on this machine.
//
// Measured on the owner's machine 2026-08-28 through chat-probe: the
// setting said 127.0.0.1:8000, ComfyUI was answering on 8188, and the
// panel told the user to install a hidden backend they did not need —
// then the model relayed that dead end to them. The rule this project
// works to is that a failed lookup names what actually exists, so the
// refusal now names the ComfyUI it can see. It must still never REROUTE:
// rendering on a ComfyUI the user did not configure would swap the model
// set under them without saying so.

/** Minimal http stub: `listening` holds the "host:port" that answer. */
function makeHttp(listening, seen) {
  return {
    request(opts, onRes) {
      let errCb = null;
      const req = {
        on(ev, fn) { if (ev === "error") errCb = fn; return req; },
        setTimeout() { return req; },
        write() {},
        end() {
          setImmediate(function () {
            const key = opts.host + ":" + opts.port;
            if (seen) seen.push(key + opts.path);
            if (listening.indexOf(key) === -1) {
              if (errCb) errCb(new Error("connect ECONNREFUSED " + key));
              return;
            }
            const h = {};
            const res = { statusCode: 200, resume() {},
              on(ev, fn) { h[ev] = fn; return res; } };
            onRes(res);
            setImmediate(function () {
              if (h.data) h.data(Buffer.from(JSON.stringify(
                { queue_running: [], queue_pending: [] })));
              if (h.end) h.end();
            });
          });
        }
      };
      return req;
    }
  };
}

const comfySrc = fs.readFileSync(path.join(__dirname, "..", "extension",
                                           "js", "comfy.js"), "utf8");
function comfyWith(listening, seen, hiddenInstalled) {
  const httpStub = makeHttp(listening, seen);
  const win = {
    AEBridge: {
      nodeRequire: n => (n === "http" || n === "https") ? httpStub
                                                        : require(n),
      getExtensionPath: () => tmpRoot
    },
    Settings: { dataRoot: () => tmpRoot, get: () => ({}) },
    Setup: { findComfyInstall: () => (hiddenInstalled ? { root: "x" }
                                                      : null) },
    localStorage: { getItem() { return null; }, setItem() {},
                    removeItem() {} },
    setTimeout, clearTimeout
  };
  new Function("window", comfySrc)(win);
  return win.Comfy;
}

const pending = [];
function step(fn) { pending.push(fn); }
function runSteps(i) {
  if (i >= pending.length) {
    console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
    return;
  }
  pending[i](function () { runSteps(i + 1); });
}

step(function (next) {
  const seen = [];
  const C = comfyWith(["127.0.0.1:8188"], seen, false);
  C.status("http://127.0.0.1:8000", function (err, st) {
    assert(st && st.online === false,
           "a dead configured URL is still reported offline");
    assert(st.foundAt === "http://127.0.0.1:8188",
           "and the running ComfyUI on this machine is named: " + st.foundAt);
    assert(/Set the ComfyUI URL in Settings to http:\/\/127\.0\.0\.1:8188/
             .test(st.hint) && /8000/.test(st.hint),
           "the hint says which setting to change, and from what: " + st.hint);
    assert(!/hidden backend/i.test(st.hint),
           "and stops advising an install the user does not need");
    assert(seen[0] === "127.0.0.1:8000/queue",
           "the configured URL is tried FIRST, before any scan");
    next();
  });
});

step(function (next) {
  // The scan is a last resort, not a habit: a URL that answers is never
  // followed by a port scan of the user's machine.
  const seen = [];
  const C = comfyWith(["127.0.0.1:8000"], seen, false);
  C.status("http://127.0.0.1:8000", function (err, st) {
    assert(st && st.online === true, "a live configured URL is online");
    assert(seen.length === 1,
           "and nothing else on the machine was probed (" +
           seen.join(", ") + ")");
    next();
  });
});

step(function (next) {
  const C = comfyWith([], null, true);
  C.status("http://127.0.0.1:8000", function (err, st) {
    assert(st.foundAt === null && /boots automatically/.test(st.hint),
           "with nothing listening anywhere the old hint is unchanged: " +
           st.hint);
    next();
  });
});

step(function (next) {
  // ensureRunning is the path a GENERATION takes, and it was the one that
  // told the user to install a backend they already had running.
  const C = comfyWith(["127.0.0.1:8188"], null, false);
  C.ensureRunning("http://127.0.0.1:8000", null, function (err) {
    assert(err && /answering at 127\.0\.0\.1:8188/.test(err.message),
           "a generation refusal names the ComfyUI it can see: " +
           (err && err.message));
    assert(!/not installed/.test(err.message),
           "instead of the hidden-backend dead end");
    next();
  });
});

step(function (next) {
  // A remote URL that is down: the local instance is still worth naming,
  // and the remote-cannot-be-started refusal only stands when there is
  // nothing here either.
  const C = comfyWith(["127.0.0.1:8188"], null, false);
  C.ensureRunning("http://192.168.1.5:8188", null, function (err) {
    assert(err && /127\.0\.0\.1:8188/.test(err.message),
           "a dead remote URL points at the local instance: " +
           (err && err.message));
    const C2 = comfyWith([], null, false);
    C2.ensureRunning("http://192.168.1.5:8188", null, function (err2) {
      assert(err2 && /cannot be auto-started/.test(err2.message),
             "and with nothing local it keeps the remote refusal");
      next();
    });
  });
});

step(function (next) {
  // Order matters: 8188 is ComfyUI's own default and the hidden backend's
  // port, so it is offered before the alternate.
  const seen = [];
  const C = comfyWith(["127.0.0.1:8189"], seen, false);
  C.status("http://127.0.0.1:8000", function (err, st) {
    assert(st.foundAt === "http://127.0.0.1:8189",
           "the alternate port is found too");
    assert(seen.join(" ").indexOf("127.0.0.1:8188") <
           seen.join(" ").indexOf("127.0.0.1:8189"),
           "but 8188 is asked first");
    next();
  });
});

runSteps(0);
