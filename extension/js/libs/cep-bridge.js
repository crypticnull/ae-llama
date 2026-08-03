/*
 * cep-bridge.js — minimal clean-room wrapper over the CEP runtime APIs this
 * panel actually uses. It talks directly to the `__adobe_cep__` /
 * `window.cep` objects that the CEP runtime injects into every extension.
 *
 * If you prefer Adobe's official CSInterface.js, drop it in js/libs/ and
 * replace this file's usages — the surface here is intentionally tiny:
 *   AEBridge.evalScript(src, cb)     run ExtendScript in the host, cb(result)
 *   AEBridge.getExtensionPath()      absolute path of the extension root
 *   AEBridge.getHostEnvironment()    parsed host env (app version, etc.)
 *   AEBridge.showOpenDialog(opts)    native open dialog -> path or null
 *   AEBridge.nodeRequire(name)       CEP's embedded Node.js require
 */
(function (global) {
  "use strict";

  var EVAL_ERROR = "EvalScript error.";

  function cepCore() {
    return global.__adobe_cep__ || null;
  }

  var AEBridge = {

    available: function () {
      return !!cepCore();
    },

    /** Run ExtendScript in the host app. cb(resultString, isError). */
    evalScript: function (script, cb) {
      var core = cepCore();
      if (!core) {
        if (cb) cb(EVAL_ERROR, true);
        return;
      }
      core.evalScript(script, function (result) {
        if (cb) cb(result, result === EVAL_ERROR);
      });
    },

    /**
     * Absolute filesystem path of this extension's root (no trailing slash).
     * The raw getSystemPath() return is a percent-encoded file:// URL
     * (e.g. "file:///C:/Program%20Files%20(x86)/..."), which no fs API can
     * use — normalize it the same way Adobe's CSInterface does.
     */
    getExtensionPath: function () {
      var core = cepCore();
      if (!core) return "";
      var p = core.getSystemPath("extension");
      if (!p) return "";
      try { p = decodeURI(p); } catch (e) { /* malformed %-seq: keep raw */ }
      if (navigator.platform.indexOf("Win") === 0) {
        p = p.replace(/^file:\/\/\//, "");
      } else {
        p = p.replace(/^file:\/\//, "");
      }
      return p.replace(/[\\\/]+$/, "");
    },

    /** Parsed host environment: { appName, appVersion, ... } or null. */
    getHostEnvironment: function () {
      var core = cepCore();
      if (!core) return null;
      try {
        return JSON.parse(core.getHostEnvironment());
      } catch (e) {
        return null;
      }
    },

    /**
     * Native file/folder picker.
     * opts: { title, initialPath, folder (bool), types (array of extensions
     * without dots, e.g. ["gguf"]) }
     * Returns the selected absolute path, or null if cancelled/unavailable.
     */
    showOpenDialog: function (opts) {
      opts = opts || {};
      var fsApi = global.cep && global.cep.fs;
      if (!fsApi || !fsApi.showOpenDialogEx) return null;
      var result = fsApi.showOpenDialogEx(
        false,                      // allowMultipleSelection
        !!opts.folder,              // chooseDirectory
        opts.title || "Select",
        opts.initialPath || "",
        opts.types || undefined
      );
      if (result && result.data && result.data.length > 0) {
        return result.data[0];
      }
      return null;
    },

    /** Open a URL in the user's default browser (external, not the panel). */
    openURL: function (url) {
      if (!/^https?:\/\//i.test(String(url))) return;
      if (global.cep && global.cep.util &&
          typeof global.cep.util.openURLInDefaultBrowser === "function") {
        global.cep.util.openURLInDefaultBrowser(url);
      }
    },

    /** CEP's embedded Node.js require(). Throws if Node is unavailable. */
    nodeRequire: function (name) {
      if (global.cep_node && typeof global.cep_node.require === "function") {
        return global.cep_node.require(name);
      }
      if (typeof global.require === "function") {
        return global.require(name);
      }
      throw new Error(
        "Node.js is not available in this CEP context. " +
        "Check that the manifest has --enable-nodejs / --mixed-context."
      );
    }
  };

  global.AEBridge = AEBridge;

})(window);
