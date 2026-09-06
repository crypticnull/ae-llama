// Regression test: hidden ComfyUI backend setup helpers (asset picking +
// portable-install detection) running setup.js in a sandboxed window.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aell-comfy-"));

// applyExtraModelPaths reads LOCALAPPDATA to find the Comfy-Desktop
// shared store, so this suite must SAY whether one exists instead of
// inheriting the runner's machine. It inherited it for 21 unattended
// passes on the owner's box, where the store is real: "blank settings
// remove the mapping" failed every night against correct behaviour,
// and every pass logged it as environmental. A test that cannot fail
// for the right reason on one machine teaches everyone to skip its
// failures. Both states are pinned below instead.
const fakeProcess = { env: {}, platform: process.platform };
const nodeRequire = (n) => (n === "process" ? fakeProcess : require(n));

const window = {
  AEBridge: {
    nodeRequire: nodeRequire,
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

// The REAL asset list, from ComfyUI v0.34.0 (not a prerelease), read off
// the live release endpoint on the owner's machine 2026-09-06. The
// fixture above is INVENTED, and it invents the one asset that decides
// the non-NVIDIA branch: ComfyUI publishes amd / intel / nvidia /
// nvidia_cu126 and NO cpu build at all.
const REAL_V034 = [
  { name: "ComfyUI_windows_portable_amd.7z", size: 1690000000 },
  { name: "ComfyUI_windows_portable_intel.7z", size: 1620000000 },
  { name: "ComfyUI_windows_portable_nvidia.7z", size: 2000000000 },
  { name: "ComfyUI_windows_portable_nvidia_cu126.7z", size: 1950000000 }
];
assert(Setup.pickComfyAsset(REAL_V034, true).name ===
       "ComfyUI_windows_portable_nvidia.7z",
       "against the REAL v0.34.0 assets an NVIDIA machine gets the " +
       "newest-CUDA nvidia build, not the cu126 fallback — this is the " +
       "asset WORKPLAN 17c downloads");
// Not asserted as CORRECT, recorded as MEASURED: with no cpu asset to
// find, both cpu patterns miss and the bare portable fallback takes the
// FIRST portable in list order, which is AMD. So an Intel or GPU-less
// buyer is handed the AMD runtime silently. Filed as WORKPLAN 17e; when
// that is fixed, this assertion is what flips.
assert(Setup.pickComfyAsset(REAL_V034, false).name ===
       "ComfyUI_windows_portable_amd.7z",
       "MEASURED DEFECT (17e): a non-NVIDIA machine falls through to " +
       "the AMD build because ComfyUI ships no cpu asset");
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

// clearing the setting removes the mapping — when there is nothing else
// to map. fakeProcess.env carries no LOCALAPPDATA, so no shared store.
window.Settings.get = () => ({ comfyModelsDir: "", comfyModelRoots: [] });
assert(Comfy._applyExtraModelPaths({ root }) === null &&
       !fs.existsSync(yamlPath),
       "blank settings remove a previously written mapping");

// ...but a Comfy-Desktop shared store is not the user's setting to
// clear. It is declared in no config file, the panel finds it only
// through LOCALAPPDATA, and the hidden backend cannot load what the
// Desktop app downloaded without this section (the H3 gap, 0.11.0).
// So with blank settings AND a store on disk the yaml is still
// written, carrying that one section and nothing the user cleared.
const sharedStore = path.join(tmpRoot, "localapp", "Comfy-Desktop",
                              "ComfyUI-Shared", "models");
fs.mkdirSync(sharedStore, { recursive: true });
fakeProcess.env.LOCALAPPDATA = path.join(tmpRoot, "localapp");
const sharedYaml = Comfy._applyExtraModelPaths({ root });
assert(sharedYaml === yamlPath && fs.existsSync(yamlPath),
       "a shared store keeps the yaml alive through blank settings");
const yamlShared = fs.readFileSync(yamlPath, "utf8");
assert(yamlShared.includes("comfy_desktop_shared:") &&
       yamlShared.includes("base_path: " +
                           sharedStore.replace(/\\/g, "/")),
       "and it is the shared store's own section: " +
       yamlShared.split("\n")[1]);
assert(!yamlShared.includes("aellama:") &&
       !yamlShared.includes("aellama_extra_"),
       "with nothing the user cleared carried along");

// A LOCALAPPDATA that names no store is the same as no store at all —
// the panel must not write a mapping for a folder that is not there.
fakeProcess.env.LOCALAPPDATA = path.join(tmpRoot, "no-such-localapp");
assert(Comfy._applyExtraModelPaths({ root }) === null &&
       !fs.existsSync(yamlPath),
       "an absent shared store maps nothing");
delete fakeProcess.env.LOCALAPPDATA;

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
function comfyWith(listening, seen, hiddenInstalled, settings, storedPid) {
  const httpStub = makeHttp(listening, seen);
  // Every pre-existing step in this file predates comfyBackend and means
  // "the instance at the URL I am handing you" — which is exactly what
  // "own" is. Saying so explicitly keeps them testing a real, supported
  // path instead of inheriting a default.
  const s = settings || { comfyBackend: "own" };
  const store = {};
  if (storedPid) store["aell-comfy-pid"] = String(storedPid);
  const win = {
    AEBridge: {
      nodeRequire: n => (n === "http" || n === "https") ? httpStub
                                                        : require(n),
      getExtensionPath: () => tmpRoot
    },
    Settings: { dataRoot: () => tmpRoot, get: () => s },
    Setup: { findComfyInstall: () => (hiddenInstalled ? { root: "x" }
                                                      : null) },
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k)
        ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; }
    },
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

// ---------------------------------------------------------------- §17a
// MANAGED backend by default, own install as an explicit bypass.
//
// The defect this closes: comfyUrl shipped as 127.0.0.1:8188 — ComfyUI's
// OWN default port — and ensureRunning used whatever answered there. So
// a buyer who already ran ComfyUI silently became a bring-your-own user
// without deciding to, and the panel then priced jobs and checked
// weights against a model set it does not manage. comfy.js already
// refuses to reroute to an instance found on ANOTHER port for exactly
// that reason (elsewhereHint); the matching-port door had no such guard.

const MANAGED = { comfyBackend: "managed", comfyManagedPort: 8288 };

// 1. The resolver: managed ignores comfyUrl entirely, own honours it.
{
  const C = comfyWith([], null, false, MANAGED);
  assert(C.backendUrl({ comfyBackend: "managed", comfyManagedPort: 8288,
                        comfyUrl: "http://127.0.0.1:8188" }) ===
         "http://127.0.0.1:8288",
         "managed mode resolves to its OWN port, never comfyUrl");
  assert(C.backendUrl({ comfyBackend: "own",
                        comfyUrl: "http://127.0.0.1:8000" }) ===
         "http://127.0.0.1:8000",
         "own mode resolves to comfyUrl");
  assert(C.backendUrl({ comfyBackend: "managed" }) ===
         "http://127.0.0.1:8288",
         "a missing managed port falls back to the default 8288");
  assert(C.backendUrl({ comfyBackend: "managed", comfyManagedPort: 0 }) ===
         "http://127.0.0.1:8288" &&
         C.backendUrl({ comfyBackend: "managed",
                        comfyManagedPort: 99999 }) ===
         "http://127.0.0.1:8288",
         "an out-of-range managed port falls back rather than building a " +
         "URL nothing can listen on");
  // 8288 is deliberately outside the ports findLocalComfy scans, so the
  // panel can never collide with, or be mistaken for, a user's own
  // ComfyUI.
  assert([8188, 8189, 8000].indexOf(C.managedPort(MANAGED)) === -1,
         "the managed port sits outside the scanned ComfyUI ports");
}

// 2. Managed: a FOREIGN ComfyUI on 8188 is ignored, not adopted — the
//    panel boots its own instead. This is the inversion.
step(function (next) {
  const C = comfyWith(["127.0.0.1:8188"], null, false, MANAGED);
  C.ensureRunning("http://127.0.0.1:8288", null, function (err) {
    assert(err && /hidden backend is not installed/.test(err.message),
           "managed mode ignores a foreign ComfyUI on 8188 and goes to " +
           "boot its own: " + (err && err.message));
    assert(!/answering at 127\.0\.0\.1:8188/.test(err.message),
           "it does not offer the foreign instance as the fix — that is " +
           "own mode's refusal");
    next();
  });
});

// 3. Managed: something ALREADY on our port that we did not start is
//    REFUSED, never attached to. Attaching is the original bug wearing a
//    different port number.
step(function (next) {
  const C = comfyWith(["127.0.0.1:8288"], null, true, MANAGED);
  C.ensureRunning("http://127.0.0.1:8288", null, function (err) {
    assert(err && /did not start it/.test(err.message),
           "a stranger on the managed port is refused: " +
           (err && err.message));
    assert(/Managed backend port/.test(err.message) &&
           /own ComfyUI/.test(err.message),
           "and the refusal names both ways out (change the port, or " +
           "switch modes)");
    next();
  });
});

// 4. Managed: our OWN backend from a previous session — remembered PID —
//    is used as-is. Without this the refusal above would fire on every
//    second generation.
step(function (next) {
  const C = comfyWith(["127.0.0.1:8288"], null, true, MANAGED, 4242);
  C.ensureRunning("http://127.0.0.1:8288", null, function (err, res) {
    assert(!err && res && res.started === false,
           "a backend WE started is adopted, not refused: " +
           (err && err.message));
    next();
  });
});

// 5. status() reports the mode, and in managed mode a foreign instance
//    is an OFFER rather than "change your URL".
step(function (next) {
  const C = comfyWith(["127.0.0.1:8188"], null, false, MANAGED);
  C.status("http://127.0.0.1:8288", function (err, st) {
    assert(st && st.backend === "managed",
           "status names which backend the panel is talking to");
    assert(st.foundAt === "http://127.0.0.1:8188",
           "it still names the ComfyUI it can see: " + st.foundAt);
    assert(/Use my own ComfyUI/.test(st.hint) &&
           /will not switch on its own/.test(st.hint),
           "as an offer to switch modes, not a URL correction: " + st.hint);
    next();
  });
});

// 6. own mode keeps every word of its old refusal — the bypass is a real
//    supported path, not a deprecated one.
step(function (next) {
  const C = comfyWith(["127.0.0.1:8188"], null, false,
                      { comfyBackend: "own" });
  C.status("http://127.0.0.1:8000", function (err, st) {
    assert(st.backend === "own", "own mode says so");
    assert(/Set the ComfyUI URL in Settings/.test(st.hint),
           "and keeps the URL-correction hint: " + st.hint);
    next();
  });
});

runSteps(0);
