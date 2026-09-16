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

  // The comfyUrl every install shipped with before comfyBackend existed.
  // A saved value EQUAL to it is an untouched default, not a choice —
  // see the migration at the end of load().
  var LEGACY_COMFY_URL = "http://127.0.0.1:8188";

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
      ctxSize: 16384,
      // Prompt routing (WORKPLAN §24b): "auto" renders only the tools a
      // sentence points at plus the core set; "all" is the whole prompt.
      // Stays "all" until the §24d measurement flips it.
      promptRouting: "all",
      gpuLayers: 99,
      temperature: 0.7,
      maxRounds: 6,
      dryRun: false,
      // --- ComfyUI (image/video generation) ---
      // WHICH backend the panel talks to. "managed" (the default) is the
      // portable ComfyUI the panel installs and boots itself, on a port
      // it owns; comfyUrl is not consulted at all in that mode. "own" is
      // the deliberate bypass for a user who runs their own instance.
      //
      // The default used to be an ACCIDENT: comfyUrl shipped as
      // 127.0.0.1:8188 — ComfyUI's OWN default port — and ensureRunning
      // used whatever answered there. So every buyer who already ran
      // ComfyUI became a bring-your-own user without deciding to be one,
      // and the panel priced jobs and checked weights against a model
      // set it does not manage. comfy.js refuses to reroute to an
      // instance found on ANOTHER port for exactly that reason; the
      // matching-port door had no such guard.
      comfyBackend: "managed",   // "managed" | "own"
      // The port the MANAGED backend owns. Deliberately outside
      // LOCAL_COMFY_PORTS (8188/8189/8000) so the panel never collides
      // with, or is mistaken for, a ComfyUI the user started.
      comfyManagedPort: 8288,
      // Only consulted when comfyBackend is "own".
      comfyUrl: "http://127.0.0.1:8188",
      comfyDir: "",            // definable install folder (for Launch)
      comfyWorkflowsDir: j("comfy-workflows"),
      comfyOutDir: j("generated"),
      comfyTimeoutSec: 600,
      // Optional external models folder for the hidden backend — image/
      // video models are tens of GB, so users can point them at a big
      // drive. Blank = the backend's own models folder.
      comfyModelsDir: "",
      // Additional model roots for users whose collections span drives.
      // Each entry is an absolute folder path, optionally per-kind as
      // "kind=path" (e.g. "checkpoints=D:\\SD\\ckpts"). All of them are
      // written into extra_model_paths.yaml alongside comfyModelsDir.
      comfyModelRoots: [],
      // Pause the chat LLM during image/video generation:
      //   auto   — tier arithmetic decides per job (default)
      //   always — every generation pauses chat
      //   never  — never pause; a job that cannot fit is refused with
      //            the honest numbers instead of OOMing the card.
      // Pre-tri-state booleans migrate in load(): true→auto, false→never.
      comfyPauseLlm: "auto",
      // Impersonate a card: enforce this VRAM budget (GB) instead of the
      // measured one, so any tier is testable on any machine. 0 = off.
      vramOverrideGB: 0,
      // Per-workflow prompt enhancement: {workflowName: bool}. A name
      // that is absent means ON — enhancement is the default, opting
      // OUT is the choice a user records.
      comfyEnhance: {},
      // Per-workflow enable: {workflowName: {enabled: bool}}. A name that
      // is absent means ENABLED - like comfyEnhance, only the opt-OUT is
      // recorded, so a template added by an update is available without a
      // settings migration. Read by Comfy.resolveWorkflow and the
      // Settings > Workflows rows.
      comfyWorkflows: {},
      // Visualizer pane width (px), set by dragging the divider. 0 = the
      // stylesheet default.
      vizWidth: 0,
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

  /*
   * Where the values in `current` came from: "localStorage", "file", or
   * "defaults". Read it before reporting anyone's configuration.
   *
   * Measured 2026-09-02: an unattended probe running in the WMI-detached
   * loop had no APPDATA, so dataRoot() fell through to a path holding no
   * settings.json, load() returned pure defaults, and the pass reported
   * `comfyUrl: 8188` as THE OWNER'S SETTING. It was 8000 and had never
   * been touched. Two sessions then repeated the claim. Defaults that
   * cannot be told apart from a saved answer are how a panel invents a
   * fact about a machine.
   */
  var loadedFrom = "defaults";

  function load() {
    var merged = defaults();
    var saved = null;
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) { saved = JSON.parse(raw); loadedFrom = "localStorage"; }
    } catch (e) {}
    // localStorage can be wiped by a reinstall — fall back to the mirror.
    if (!saved) {
      saved = readSettingsFile();
      if (saved) loadedFrom = "file";
    }
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
    // Old default upgrade: 8192 ctx overflowed on long tool rounds (field
    // 400s); anyone still on the old default moves to the new one. Same
    // for the old 4-round budget.
    if (merged.ctxSize === 8192) merged.ctxSize = 16384;
    if (merged.maxRounds === 4) merged.maxRounds = 6;
    // comfyPauseLlm grew from a boolean to auto|always|never. true maps
    // to auto (the old behavior WAS pause-by-default, and auto still
    // pauses whenever the fit is unprovable); false keeps its meaning.
    if (merged.comfyPauseLlm === true) merged.comfyPauseLlm = "auto";
    if (merged.comfyPauseLlm === false) merged.comfyPauseLlm = "never";
    // comfyBackend is new. An EXISTING install has to be sorted into a
    // mode, and the only evidence is whether the user ever touched the
    // URL: one they set themselves means they run their own ComfyUI, so
    // moving them to "managed" would silently stop talking to it.
    //
    // The trap, and why this reads `saved` rather than the merged value:
    // a DEFAULT must never be mistaken for an answer. Measured
    // 2026-09-02 — an unattended probe with no APPDATA fell through to a
    // path holding no settings.json, load() returned pure defaults, and
    // the pass reported comfyUrl 8188 as THE OWNER'S SETTING when it was
    // 8000 and had never been touched. Two sessions repeated the claim.
    // So only a value that was really SAVED, and really differs from the
    // shipped default, counts as a choice.
    if (saved && !Object.prototype.hasOwnProperty.call(saved,
                                                       "comfyBackend")) {
      var savedUrl = typeof saved.comfyUrl === "string" ? saved.comfyUrl : "";
      merged.comfyBackend =
        (savedUrl && savedUrl !== LEGACY_COMFY_URL) ? "own" : "managed";
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
      loadedFrom = "defaults";
      try { global.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      writeSettingsFile(current);
      return current;
    },
    /**
     * The receipt for Settings.get(): where these values came from, the
     * file that was looked for, and whether the environment variable
     * dataRoot() depends on was even set. `saved` is false when nothing
     * was found and every value is a default — the state in which no
     * claim about a user's configuration is worth making.
     */
    origin: function () {
      Settings.get();
      var appdata = "";
      try {
        appdata = global.AEBridge.nodeRequire("process").env.APPDATA || "";
      } catch (e) {}
      return { from: loadedFrom, saved: loadedFrom !== "defaults",
               file: settingsFile(), dataRoot: dataRoot(),
               appdata: appdata };
    },
    dataRoot: dataRoot
  };

  global.Settings = Settings;

})(window);
