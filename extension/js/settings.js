/*
 * settings.js — persisted panel settings.
 *
 * All heavy/user data (llama.cpp binaries, models, renders, workflow
 * templates) lives OUTSIDE the extension folder, in %APPDATA%\AE-Llama —
 * a ZXP update replaces the extension folder wholesale, and nothing there
 * can be trusted to survive. Settings are stored in localStorage and
 * mirrored to <dataRoot>\settings.json so they too survive reinstalls.
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "com.cptk.aellama.settings";

  function extPath() {
    return global.AEBridge.getExtensionPath();
  }

  var cachedDataRoot = null;

  /** Stable per-user data folder that survives extension updates. */
  function dataRoot() {
    if (cachedDataRoot) return cachedDataRoot;
    try {
      var path = global.AEBridge.nodeRequire("path");
      var proc = global.AEBridge.nodeRequire("process");
      var base = proc.env.APPDATA || proc.env.USERPROFILE || extPath();
      cachedDataRoot = path.join(base, "AE-Llama");
    } catch (e) {
      cachedDataRoot = extPath();
    }
    return cachedDataRoot;
  }

  function settingsFile() {
    try {
      return global.AEBridge.nodeRequire("path")
        .join(dataRoot(), "settings.json");
    } catch (e) { return ""; }
  }

  function defaults() {
    var root = dataRoot();
    var sep = "\\";
    if (root.indexOf("/") !== -1 && root.indexOf("\\") === -1) sep = "/";
    function j(sub) { return root ? root + sep + sub : ""; }
    return {
      serverPath: j("vendor" + sep + "llama.cpp" + sep + "llama-server.exe"),
      modelsDir:  j("models"),
      modelPath:  "",          // currently selected .gguf (absolute)
      customModels: [],        // absolute paths added via Browse…
      port: 8737,
      ctxSize: 8192,
      gpuLayers: 99,
      temperature: 0.7,
      maxRounds: 4,
      dryRun: false,
      // --- ComfyUI (image/video generation) ---
      comfyUrl: "http://127.0.0.1:8188",
      comfyDir: "",            // definable install folder (for Launch)
      comfyWorkflowsDir: j("comfy-workflows"),
      comfyOutDir: j("generated"),
      comfyTimeoutSec: 600,
      // Optional external models folder for the hidden backend — image/
      // video models are tens of GB, so users can point them at a big
      // drive. Blank = the backend's own models folder.
      comfyModelsDir: "",
      // Stop the chat LLM during image/video generation so the two never
      // fight over VRAM; it restarts automatically before the reply.
      comfyPauseLlm: true,
      // Install panel updates without asking (git pull for dev installs,
      // panelPackageUrl download for package installs). Store builds
      // without a panelPackageUrl are unaffected — they only show the
      // banner. Opt out in settings.
      autoInstallUpdates: true,
      // Visualizer curve (CSS cubic-bezier handles), persisted across runs.
      vizBezier: [0.25, 0.25, 0.75, 0.75]
    };
  }

  function readSettingsFile() {
    try {
      var fs = global.AEBridge.nodeRequire("fs");
      var f = settingsFile();
      if (f && fs.existsSync(f)) {
        return JSON.parse(fs.readFileSync(f, "utf8"));
      }
    } catch (e) {}
    return null;
  }

  function writeSettingsFile(s) {
    try {
      var fs = global.AEBridge.nodeRequire("fs");
      var f = settingsFile();
      if (!f) return;
      var dir = global.AEBridge.nodeRequire("path").dirname(f);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, JSON.stringify(s, null, 2), "utf8");
    } catch (e) { /* best effort */ }
  }

  function load() {
    var merged = defaults();
    var saved = null;
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (e) {}
    // localStorage can be wiped by a reinstall — fall back to the mirror.
    if (!saved) saved = readSettingsFile();
    if (saved) {
      var ext = extPath();
      for (var k in saved) {
        if (!Object.prototype.hasOwnProperty.call(merged, k)) continue;
        var val = saved[k];
        if (typeof merged[k] === "string" && merged[k] !== "" &&
            typeof val === "string") {
          // Heal bad/stale persisted paths: empty strings, un-normalized
          // file:// URLs, and pre-0.2 defaults that pointed inside the
          // (replaceable) extension folder and no longer exist.
          if (val === "" || val.indexOf("file://") === 0) continue;
          if (ext && val.indexOf(ext) === 0) {
            var exists = false;
            try {
              exists = global.AEBridge.nodeRequire("fs").existsSync(val);
            } catch (e2) {}
            if (!exists) continue;
          }
        }
        merged[k] = val;
      }
    }
    return merged;
  }

  var current = null;

  var Settings = {
    get: function () {
      if (!current) current = load();
      return current;
    },
    set: function (patch) {
      var s = Settings.get();
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
      }
      try {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      } catch (e) { /* storage full/unavailable — keep in-memory value */ }
      writeSettingsFile(s);
      return s;
    },
    reset: function () {
      current = defaults();
      try { global.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      writeSettingsFile(current);
      return current;
    },
    dataRoot: dataRoot
  };

  global.Settings = Settings;

})(window);
