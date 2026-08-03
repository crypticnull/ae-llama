/*
 * settings.js — persisted panel settings (localStorage-backed).
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "com.cptk.aellama.settings";

  function extPath() {
    return global.AEBridge.getExtensionPath();
  }

  function defaults() {
    var root = extPath();
    return {
      serverPath: root ? root + "/vendor/llama.cpp/llama-server.exe" : "",
      modelsDir:  root ? root + "/models" : "",
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
      comfyWorkflowsDir: root ? root + "/comfy-workflows" : "",
      comfyOutDir: root ? root + "/generated" : "",
      comfyTimeoutSec: 600
    };
  }

  function load() {
    var merged = defaults();
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var k in saved) {
          if (Object.prototype.hasOwnProperty.call(merged, k)) {
            merged[k] = saved[k];
          }
        }
      }
    } catch (e) { /* corrupted storage -> fall back to defaults */ }
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
      return s;
    },
    reset: function () {
      current = defaults();
      try { global.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      return current;
    }
  };

  global.Settings = Settings;

})(window);
