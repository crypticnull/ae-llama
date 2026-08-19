/*
 * main.js — panel UI wiring: model dropdown, server lifecycle, chat loop.
 */
(function (global) {
  "use strict";

  var BROWSE_VALUE = "__browse__";

  var $ = function (id) { return document.getElementById(id); };

  var els = {};
  var busy = false;          // a chat round-trip is in flight
  var history = [];          // [{role, content}] — excludes system prompt
  var updateManifest = null; // cached update.json from the update channel

  // ------------------------------------------------------------ utilities

  function basename(p) {
    return String(p).replace(/[\\\/]+$/, "").split(/[\\\/]/).pop();
  }

  function appendMsg(kind, text, label) {
    var div = document.createElement("div");
    div.className = "msg " + kind;
    if (label) {
      var lab = document.createElement("span");
      lab.className = "msg-label";
      lab.textContent = label;
      div.appendChild(lab);
    }
    div.appendChild(document.createTextNode(text));
    els.chat.appendChild(div);
    els.chat.scrollTop = els.chat.scrollHeight;
    return div;
  }

  function setStatus(cls, text) {
    els.statusDot.className = "dot " + cls;
    els.statusText.textContent = text;
  }

  /** Info message with trailing clickable actions [{label, onClick}]. */
  function appendActionMsg(text, actions) {
    var div = appendMsg("info", text + " ");
    for (var i = 0; i < actions.length; i++) {
      (function (action) {
        var a = document.createElement("a");
        a.textContent = action.label;
        a.addEventListener("click", action.onClick);
        div.appendChild(a);
        div.appendChild(document.createTextNode("  "));
      })(actions[i]);
    }
    return div;
  }

  /** A single reusable status line (for setup progress spam control). */
  var setupLine = null;
  function setupStatus(text) {
    if (!setupLine || !setupLine.parentNode) {
      setupLine = appendMsg("info", text);
    } else {
      setupLine.textContent = text;
    }
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  // ------------------------------------------------------- model dropdown

  function populateModelDropdown() {
    var s = global.Settings.get();
    var scanned = [];
    try {
      scanned = global.Llama.scanModels(s.modelsDir);
    } catch (e) {
      appendMsg("error", "Model scan failed: " + e.message);
    }

    // Merge scanned models with custom (browsed) entries, de-duplicated.
    var seen = {};
    var options = [];
    var i;
    for (i = 0; i < scanned.length; i++) {
      if (!seen[scanned[i]]) {
        seen[scanned[i]] = true;
        options.push({ value: scanned[i], label: basename(scanned[i]) });
      }
    }
    // Missing custom entries (unplugged drive, network share asleep) are
    // hidden but never pruned — they come back when the path does.
    for (i = 0; i < s.customModels.length; i++) {
      var p = s.customModels[i];
      var exists = false;
      try {
        exists = !!p && global.AEBridge.nodeRequire("fs").existsSync(p);
      } catch (e) {}
      if (exists && !seen[p]) {
        seen[p] = true;
        options.push({ value: p, label: basename(p) + "  (custom)" });
      }
    }

    els.modelSelect.innerHTML = "";
    function addOption(value, label, disabled) {
      var o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      if (disabled) o.disabled = true;
      els.modelSelect.appendChild(o);
    }

    if (options.length === 0) {
      addOption("", "No .gguf models found — Browse… or drop files in models/", true);
    }
    for (i = 0; i < options.length; i++) {
      addOption(options[i].value, options[i].label, false);
    }
    addOption(BROWSE_VALUE, "Browse for model file…", false);

    // Offer the one-click starter model only while the dropdown is empty.
    if (els.starterRow) {
      els.starterRow.classList.toggle("hidden", options.length > 0);
    }

    // Restore previous selection when it still exists.
    if (s.modelPath && seen[s.modelPath]) {
      els.modelSelect.value = s.modelPath;
    } else if (options.length > 0) {
      els.modelSelect.value = options[0].value;
      global.Settings.set({ modelPath: options[0].value });
    } else {
      global.Settings.set({ modelPath: "" });
    }
  }

  function browseForModel() {
    var s = global.Settings.get();
    var picked = global.AEBridge.showOpenDialog({
      title: "Select a GGUF model",
      initialPath: s.modelsDir,
      folder: false,
      types: ["gguf"]
    });
    if (picked) {
      var customs = s.customModels.slice();
      var already = false;
      for (var i = 0; i < customs.length; i++) {
        if (customs[i] === picked) { already = true; break; }
      }
      if (!already) customs.push(picked);
      global.Settings.set({ customModels: customs, modelPath: picked });
    }
    populateModelDropdown();
    if (picked) onModelChosen(picked);
  }

  function onModelChosen(modelPath) {
    global.Settings.set({ modelPath: modelPath });
    // If a different model is live, restart onto the new one.
    if (global.Llama.isRunning() &&
        global.Llama.getCurrentModel() !== modelPath) {
      appendMsg("info", "Switching model to " + basename(modelPath) + "…");
      startServer();
    }
  }

  // ---------------------------------------------------------- server ctrl

  function startServer() {
    var s = global.Settings.get();
    if (!s.modelPath) {
      appendMsg("error", "Pick a model first (dropdown above, or Browse…).");
      return;
    }
    global.Llama.start({
      serverPath: s.serverPath,
      modelPath: s.modelPath,
      port: s.port,
      ctxSize: s.ctxSize,
      gpuLayers: s.gpuLayers
    }, function (err) {
      if (!err) {
        appendMsg("info", basename(s.modelPath) + " ready on port " + s.port);
      }
    });
  }

  function updateServerButton(state) {
    if (state === "stopped" || state === "error") {
      els.serverToggle.textContent = "Start";
      els.serverToggle.disabled = false;
    } else if (state === "starting") {
      els.serverToggle.textContent = "Stop";
      els.serverToggle.disabled = false;
    } else {
      els.serverToggle.textContent = "Stop";
      els.serverToggle.disabled = false;
    }
  }

  // ------------------------------------------------------------ chat loop

  function fetchProjectState(cb) {
    global.Tools.callHostTool("get_project_info", {}, function (info) {
      if (!info.ok) { cb("(project state unavailable)"); return; }
      global.Tools.callHostTool("get_comp_details", {}, function (comp) {
        var state = { project: info.data };
        if (comp.ok) state.activeComp = comp.data;
        var json = JSON.stringify(state);
        // Guard the prompt against giant projects.
        if (json.length > 6000) json = json.slice(0, 6000) + "…(truncated)";
        cb(json);
      });
    });
  }

  var currentChat = null;     // in-flight streaming request handle
  var cancelRequested = false;

  /** Pull the partially-streamed "reply" string out of incomplete JSON. */
  function extractPartialReply(text) {
    var m = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!m) return "";
    var frag = m[1];
    // A trailing lone backslash is an unfinished escape — drop it.
    var trailing = frag.match(/\\+$/);
    if (trailing && trailing[0].length % 2 === 1) {
      frag = frag.slice(0, -1);
    }
    try { return JSON.parse('"' + frag + '"'); } catch (e) { return ""; }
  }

  function setSendMode(running) {
    if (running) {
      els.sendBtn.textContent = "Stop";
      els.sendBtn.classList.remove("primary");
      els.sendBtn.classList.add("danger");
    } else {
      els.sendBtn.textContent = "Send";
      els.sendBtn.classList.add("primary");
      els.sendBtn.classList.remove("danger");
    }
  }

  function sendMessage() {
    if (busy) return;
    var text = els.chatInput.value.replace(/^\s+|\s+$/g, "");
    if (!text) return;
    if (!global.Llama.isRunning()) {
      appendMsg("error", "Start the llama-server first (Start button above).");
      return;
    }

    els.chatInput.value = "";
    appendMsg("user", text);
    history.push({ role: "user", content: text });

    busy = true;
    cancelRequested = false;
    setSendMode(true);
    els.clearChatBtn.disabled = true;   // clearing mid-round corrupts history
    var thinking = appendMsg("info", "Thinking…");

    var s = global.Settings.get();

    fetchProjectState(function (stateJson) {
      var system = global.Tools.buildSystemPrompt(stateJson);
      runRound(system, 0);
    });

    function finish() {
      busy = false;
      currentChat = null;
      setSendMode(false);
      els.clearChatBtn.disabled = false;
      if (thinking && thinking.parentNode) {
        thinking.parentNode.removeChild(thinking);
        thinking = null;
      }
    }

    function runRound(system, round) {
      if (cancelRequested) { finish(); return; }
      var messages = [{ role: "system", content: system }].concat(history);
      currentChat = global.Llama.chat(
        { port: s.port, temperature: s.temperature },
        messages,
        global.Tools.RESPONSE_SCHEMA,
        function (accumulated) {
          // Live-stream the model's reply text as it decodes.
          var partial = extractPartialReply(accumulated);
          if (thinking) {
            thinking.textContent = partial ? partial + " ▌" : "Thinking…";
            els.chat.scrollTop = els.chat.scrollHeight;
          }
        },
        function (err, obj, raw) {
          currentChat = null;
          if (thinking) thinking.textContent = "Thinking…";
          if (err) {
            if (err.cancelled) {
              appendMsg("info", "Stopped.");
            } else {
              appendMsg("error", "Model error: " + err.message);
            }
            finish();
            return;
          }
          history.push({ role: "assistant", content: raw });

          var reply = typeof obj.reply === "string" ? obj.reply : "";
          var commands = obj.commands instanceof Array ? obj.commands : [];
          if (reply) appendMsg("assistant", reply);

          if (commands.length === 0 || cancelRequested) { finish(); return; }

          global.Tools.executeCommands(
            commands,
            { dryRun: s.dryRun,
              shouldStop: function () { return cancelRequested; } },
            function (i, cmd, result) {
              var head = cmd.tool + " " + JSON.stringify(cmd.args || {});
              var body = result.ok
                ? (result.dryRun ? "would run" : "ok") +
                  (result.data ? ": " +
                    JSON.stringify(result.data).slice(0, 400) : "")
                : "ERROR: " + result.error;
              appendMsg(result.ok ? "tool" : "error", body, head);
            },
            function (results) {
              history.push({
                role: "user",
                content: "TOOL RESULTS:\n" + JSON.stringify(results)
              });
              if (cancelRequested) { finish(); return; }
              if (round + 1 >= s.maxRounds) {
                appendMsg("info",
                  "Stopped after " + s.maxRounds + " tool rounds.");
                finish();
                return;
              }
              runRound(system, round + 1);
            });
        });
    }
  }

  function cancelMessage() {
    cancelRequested = true;
    if (currentChat) {
      currentChat.cancel();   // frees the llama-server slot immediately
    }
  }

  // ---------------------------------------------------- setup & updates

  /** Hands-off first-run: install the inference engine if it's missing. */
  function autoBootstrap() {
    var s = global.Settings.get();
    if (global.Llama.findServerExe(s.serverPath)) return;   // already good
    appendMsg("info", "First-run setup: installing the local AI engine " +
      "(one time, fully automatic).");
    var tag = updateManifest && updateManifest.llamaTag
      ? updateManifest.llamaTag : "latest";
    global.Setup.bootstrapEngine({ tag: tag }, setupStatus,
      function (err, res) {
        setupLine = null;
        if (err) {
          appendMsg("error", "Engine setup failed: " + err.message +
            " — use 'Reinstall / update engine' in settings to retry.");
        } else if (!res.skipped) {
          appendMsg("info", "Engine installed. Pick a model and press Start.");
          populateModelDropdown();
        }
      });
  }

  function updateEngine() {
    if (global.Llama.getState() !== "stopped" &&
        global.Llama.getState() !== "error") {
      global.Llama.stop();
    }
    var tag = updateManifest && updateManifest.llamaTag
      ? updateManifest.llamaTag : "latest";
    global.Setup.bootstrapEngine({ force: true, tag: tag }, setupStatus,
      function (err) {
        setupLine = null;
        appendMsg(err ? "error" : "info",
          err ? "Engine update failed: " + err.message
              : "Engine updated.");
      });
  }

  function installPanelUpdate() {
    global.Setup.installUpdate(updateManifest, setupStatus,
      function (err, res) {
        setupLine = null;
        if (err) {
          appendMsg("error", "Panel update failed: " + err.message);
          return;
        }
        if (res.kind === "git" && !res.changed) {
          appendMsg("info", "Repo already up to date.");
          return;
        }
        appendMsg("info", "Panel updated" +
          (res.output ? " (" + res.output + ")" : "") +
          ". Close and reopen the panel (Window ▸ Extensions ▸ AE Llama) — " +
          "or restart After Effects — to load the new version.");
      });
  }

  function checkForUpdates(verbose) {
    global.Setup.checkForUpdates(function (err, result) {
      if (err || !result) {
        if (verbose) {
          appendMsg("info", "Update check failed (offline?): " +
            (err ? err.message : "no manifest"));
        }
        return;
      }
      updateManifest = result.manifest;
      if (result.panelUpdate) {
        var s = global.Settings.get();
        var installable = global.Setup.detectInstallKind().kind === "git" ||
                          !!updateManifest.panelPackageUrl;
        var label = "Update available: AE Llama " +
          result.panelUpdate.version +
          (result.panelUpdate.notes ? " — " + result.panelUpdate.notes : "") +
          ".";
        if (installable && s.autoInstallUpdates) {
          appendMsg("info", label + " Installing (auto-update is on)…");
          installPanelUpdate();
        } else {
          var actions = [];
          if (installable) {
            actions.push({ label: "Update now", onClick: installPanelUpdate });
          }
          if (result.panelUpdate.url) {
            actions.push({ label: "Get it here", onClick: function () {
              global.AEBridge.openURL(result.panelUpdate.url);
            } });
          }
          appendActionMsg(label, actions);
        }
      } else if (verbose) {
        appendMsg("info", "You are on the latest version (" +
          global.AELL.VERSION + ").");
      }
    });
  }

  function downloadStarterModel() {
    els.getModelBtn.disabled = true;
    global.Setup.downloadStarterModel(updateManifest, setupStatus,
      function (err, dest) {
        setupLine = null;
        els.getModelBtn.disabled = false;
        if (err) {
          appendMsg("error", "Model download failed: " + err.message);
          return;
        }
        appendMsg("info", "Model downloaded.");
        global.Settings.set({ modelPath: dest });
        populateModelDropdown();
      });
  }

  // -------------------------------------------------------------- settings

  function settingsToForm() {
    var s = global.Settings.get();
    els.setServerPath.value = s.serverPath;
    els.setModelsDir.value = s.modelsDir;
    els.setPort.value = s.port;
    els.setCtx.value = s.ctxSize;
    els.setNgl.value = s.gpuLayers;
    els.setTemp.value = s.temperature;
    els.setRounds.value = s.maxRounds;
    els.setDryRun.checked = !!s.dryRun;
    els.setComfyUrl.value = s.comfyUrl;
    els.setComfyDir.value = s.comfyDir;
    els.setComfyWorkflows.value = s.comfyWorkflowsDir;
    els.setComfyOut.value = s.comfyOutDir;
    els.setComfyTimeout.value = s.comfyTimeoutSec;
    els.setAutoUpdate.checked = !!s.autoInstallUpdates;
  }

  function formToSettings() {
    global.Settings.set({
      serverPath: els.setServerPath.value,
      modelsDir: els.setModelsDir.value,
      port: parseInt(els.setPort.value, 10) || 8737,
      ctxSize: parseInt(els.setCtx.value, 10) || 8192,
      gpuLayers: parseInt(els.setNgl.value, 10) >= 0
        ? parseInt(els.setNgl.value, 10) : 99,
      temperature: parseFloat(els.setTemp.value) >= 0
        ? parseFloat(els.setTemp.value) : 0.7,
      maxRounds: parseInt(els.setRounds.value, 10) || 4,
      dryRun: !!els.setDryRun.checked,
      comfyUrl: els.setComfyUrl.value || "http://127.0.0.1:8188",
      comfyDir: els.setComfyDir.value,
      comfyWorkflowsDir: els.setComfyWorkflows.value,
      comfyOutDir: els.setComfyOut.value,
      comfyTimeoutSec: parseInt(els.setComfyTimeout.value, 10) || 600,
      autoInstallUpdates: !!els.setAutoUpdate.checked
    });
  }

  // ------------------------------------------------------------------ init

  function init() {
    els = {
      statusDot: $("status-dot"),
      statusText: $("status-text"),
      modelSelect: $("model-select"),
      refreshModels: $("btn-refresh-models"),
      serverToggle: $("btn-server-toggle"),
      settingsBtn: $("btn-settings"),
      logsBtn: $("btn-logs"),
      settingsDrawer: $("settings-drawer"),
      logDrawer: $("log-drawer"),
      logOutput: $("log-output"),
      chat: $("chat"),
      chatInput: $("chat-input"),
      sendBtn: $("btn-send"),
      clearChatBtn: $("btn-clear-chat"),
      setServerPath: $("set-server-path"),
      setModelsDir: $("set-models-dir"),
      setPort: $("set-port"),
      setCtx: $("set-ctx"),
      setNgl: $("set-ngl"),
      setTemp: $("set-temp"),
      setRounds: $("set-rounds"),
      setDryRun: $("set-dryrun"),
      setComfyUrl: $("set-comfy-url"),
      setComfyDir: $("set-comfy-dir"),
      setComfyWorkflows: $("set-comfy-workflows"),
      setComfyOut: $("set-comfy-out"),
      setComfyTimeout: $("set-comfy-timeout"),
      setAutoUpdate: $("set-auto-update"),
      starterRow: $("starter-row"),
      getModelBtn: $("btn-get-model"),
      versionLine: $("version-line")
    };

    if (!global.AEBridge.available()) {
      appendMsg("error",
        "CEP runtime not detected. This page must run inside After Effects.");
      return;
    }

    // Populate the settings form up front so no code path can ever persist
    // never-filled (empty) fields over the real settings.
    settingsToForm();

    // A llama-server from a previous session may have survived panel
    // teardown (CEP doesn't reliably fire unload) — reap it now.
    try { global.Llama.reapOrphan(); } catch (e) {}

    // Persistent data folders (survive extension updates) + seeding.
    try { global.Setup.ensureDataDirs(); } catch (e) {}

    els.versionLine.textContent = "AE Llama " + global.AELL.VERSION +
      " — data folder: " + global.Settings.dataRoot();

    // -- server status + logs
    global.Llama.on("status", function (state, detail) {
      var cls = { stopped: "off", starting: "starting",
                  running: "on", error: "error" }[state] || "off";
      setStatus(cls, detail || state);
      updateServerButton(state);
    });
    var logBuf = "";
    global.Llama.on("log", function (chunk) {
      logBuf = (logBuf + chunk).slice(-20000);
      els.logOutput.textContent = logBuf;
      els.logOutput.scrollTop = els.logOutput.scrollHeight;
    });

    // -- model dropdown
    populateModelDropdown();
    els.modelSelect.addEventListener("change", function () {
      if (els.modelSelect.value === BROWSE_VALUE) {
        // Reset the visible selection before opening the dialog so
        // cancelling doesn't leave "Browse…" selected.
        var s = global.Settings.get();
        els.modelSelect.value = s.modelPath || "";
        browseForModel();
      } else if (els.modelSelect.value) {
        onModelChosen(els.modelSelect.value);
      }
    });
    els.refreshModels.addEventListener("click", populateModelDropdown);

    // -- server toggle
    els.serverToggle.addEventListener("click", function () {
      var st = global.Llama.getState();
      if (st === "running" || st === "starting") {
        global.Llama.stop();
      } else {
        // Settings are already persisted by each field's change listener —
        // do NOT snapshot the form here: on first run the drawer has never
        // been populated and doing so would wipe the path defaults.
        startServer();
      }
    });

    // -- drawers
    els.settingsBtn.addEventListener("click", function () {
      settingsToForm();
      els.settingsDrawer.classList.toggle("hidden");
      els.logDrawer.classList.add("hidden");
    });
    $("btn-settings-close").addEventListener("click", function () {
      formToSettings();
      els.settingsDrawer.classList.add("hidden");
      populateModelDropdown();
    });
    els.logsBtn.addEventListener("click", function () {
      els.logDrawer.classList.toggle("hidden");
      els.settingsDrawer.classList.add("hidden");
    });
    $("btn-log-close").addEventListener("click", function () {
      els.logDrawer.classList.add("hidden");
    });
    $("btn-log-clear").addEventListener("click", function () {
      logBuf = "";
      els.logOutput.textContent = "";
    });

    // settings fields persist on change
    var persistIds = ["set-server-path", "set-models-dir", "set-port",
                      "set-ctx", "set-ngl", "set-temp", "set-rounds",
                      "set-dryrun", "set-comfy-url", "set-comfy-dir",
                      "set-comfy-workflows", "set-comfy-out",
                      "set-comfy-timeout", "set-auto-update"];
    for (var i = 0; i < persistIds.length; i++) {
      $(persistIds[i]).addEventListener("change", formToSettings);
    }
    $("btn-browse-server").addEventListener("click", function () {
      var picked = global.AEBridge.showOpenDialog({
        title: "Locate llama-server.exe",
        initialPath: global.Settings.get().serverPath,
        types: ["exe"]
      });
      if (picked) {
        els.setServerPath.value = picked;
        formToSettings();
      }
    });
    $("btn-browse-models-dir").addEventListener("click", function () {
      var picked = global.AEBridge.showOpenDialog({
        title: "Choose models folder",
        initialPath: global.Settings.get().modelsDir,
        folder: true
      });
      if (picked) {
        els.setModelsDir.value = picked;
        formToSettings();
        populateModelDropdown();
      }
    });

    // -- ComfyUI controls
    function browseIntoField(el, title, folder) {
      var picked = global.AEBridge.showOpenDialog({
        title: title,
        initialPath: el.value,
        folder: folder
      });
      if (picked) {
        el.value = picked;
        formToSettings();
      }
    }
    $("btn-browse-comfy-dir").addEventListener("click", function () {
      browseIntoField(els.setComfyDir, "Locate your ComfyUI install folder", true);
    });
    $("btn-browse-comfy-workflows").addEventListener("click", function () {
      browseIntoField(els.setComfyWorkflows, "Choose workflow templates folder", true);
    });
    $("btn-browse-comfy-out").addEventListener("click", function () {
      browseIntoField(els.setComfyOut, "Choose generated files folder", true);
    });
    $("btn-comfy-launch").addEventListener("click", function () {
      formToSettings();
      global.Comfy.launch(global.Settings.get().comfyDir, function (err, msg) {
        appendMsg(err ? "error" : "info", err ? err.message : msg);
      });
    });
    $("btn-comfy-test").addEventListener("click", function () {
      formToSettings();
      global.Comfy.status(global.Settings.get().comfyUrl, function (err, st) {
        if (st && st.online) {
          appendMsg("info", "ComfyUI online at " + st.url +
            " — running: " + st.running + ", queued: " + st.pending);
        } else {
          appendMsg("error", "ComfyUI not reachable at " +
            (st ? st.url : "?") + ". " + (st && st.hint ? st.hint : ""));
        }
      });
    });

    // long generations narrate progress into the chat
    global.Tools.setProgressSink(function (text) {
      appendMsg("info", text);
    });

    // -- chat (Send doubles as Stop while a round-trip is in flight)
    els.sendBtn.addEventListener("click", function () {
      if (busy) cancelMessage();
      else sendMessage();
    });
    els.chatInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!busy) sendMessage();
      }
    });
    els.clearChatBtn.addEventListener("click", function () {
      history = [];
      els.chat.innerHTML = "";
      appendMsg("info", "Conversation cleared.");
    });

    // -- shut the server down with the panel
    global.addEventListener("unload", function () {
      try { global.Llama.stop(); } catch (e) {}
    });

    // -- updates + starter model + auto-bootstrap
    els.getModelBtn.addEventListener("click", downloadStarterModel);
    $("btn-check-updates").addEventListener("click", function () {
      checkForUpdates(true);
    });
    $("btn-update-panel").addEventListener("click", installPanelUpdate);
    $("btn-update-engine").addEventListener("click", updateEngine);

    var env = global.AEBridge.getHostEnvironment();
    appendMsg("info", "AE Llama " + global.AELL.VERSION + " ready" +
      (env && env.appVersion ? " — After Effects " + env.appVersion : "") +
      ".");

    // Silent update check, then hands-off engine install if needed.
    // (checkForUpdates caches the manifest so bootstrap can use its pinned
    // llamaTag; bootstrap proceeds regardless after a short head start.)
    checkForUpdates(false);
    global.setTimeout(autoBootstrap, 2500);
  }

  document.addEventListener("DOMContentLoaded", init);

})(window);
