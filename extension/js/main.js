/*
 * main.js — panel UI wiring: model dropdown, server lifecycle, chat loop.
 */
(function (global) {
  "use strict";

  var BROWSE_VALUE = "__browse__";

  var $ = function (id) { return document.getElementById(id); };

  var els = {};
  /*
   * One line + checkbox per workflow in the ComfyUI section: "enhance
   * prompts with the chat model" per workflow. Checked (the default)
   * means the rough idea is rewritten into that workflow's own prompt
   * format before generating — one extra completion on the ALREADY
   * LOADED chat model, not a model load; the Ollama enhancer inside the
   * bundled workflows loaded its own 27B per run and stays bypassed.
   * Only opt-OUTs are stored, so new workflows default to on.
   */
  function renderEnhanceToggles(s) {
    if (!els.comfyEnhanceList) return;
    els.comfyEnhanceList.innerHTML = "";
    var rows = [];
    try { rows = global.Tools.workflowRows(s) || []; } catch (e) {}
    if (!rows.length) {
      var none = document.createElement("div");
      none.className = "enhance-hint";
      none.textContent = "No workflows found yet — they appear here " +
        "once the generation backend is set up.";
      els.comfyEnhanceList.appendChild(none);
      return;
    }
    for (var i = 0; i < rows.length; i++) buildWorkflowRow(rows[i]);
  }

  /* One Workflows row. The MODEL is Tools.workflowRows(); this only
   * turns it into DOM, so the part with rules in it is stub-tested. */
  function buildWorkflowRow(r) {
    var wrap = document.createElement("div");
    wrap.className = "wf-row" + (r.enabled ? "" : " wf-off") +
                     (r.fits ? "" : " wf-unfit");

    var head = document.createElement("div");
    head.className = "wf-head";

    var on = document.createElement("label");
    on.className = "check";
    var onBox = document.createElement("input");
    onBox.type = "checkbox";
    onBox.checked = r.enabled;
    onBox.setAttribute("data-wf-enabled", r.name);
    var nameSpan = document.createElement("span");
    nameSpan.className = "wf-name";
    nameSpan.textContent = r.name;
    on.appendChild(onBox);
    on.appendChild(nameSpan);
    head.appendChild(on);

    if (r.kind) {
      var badge = document.createElement("span");
      badge.className = "wf-badge wf-" + r.kind;
      badge.textContent = r.kind;
      head.appendChild(badge);
    }
    // Which graph the catalog itself points at — the one a nameless
    // request gets when everything else ties.
    if (r.baseline) {
      var base = document.createElement("span");
      base.className = "wf-badge wf-baseline";
      base.textContent = "default";
      head.appendChild(base);
    }
    wrap.appendChild(head);

    if (r.label) {
      var renders = document.createElement("div");
      renders.className = "wf-sub";
      renders.textContent = "renders " + r.label;
      wrap.appendChild(renders);
    }
    // What it NEEDS. Every phrase is derived from the catalog entry and
    // the manifest, so a row can never promise what the chooser refuses.
    if (r.needs.length) {
      var needs = document.createElement("div");
      needs.className = "wf-needs" + (r.fits ? "" : " wf-needs-hard");
      needs.textContent = r.needs.join(" · ");
      wrap.appendChild(needs);
    }

    var enh = document.createElement("label");
    enh.className = "check wf-enhance";
    var enhBox = document.createElement("input");
    enhBox.type = "checkbox";
    enhBox.checked = r.enhance;
    enhBox.setAttribute("data-workflow", r.name);
    var enhSpan = document.createElement("span");
    enhSpan.textContent = "rewrite my prompt for this workflow";
    enh.appendChild(enhBox);
    enh.appendChild(enhSpan);
    wrap.appendChild(enh);

    els.comfyEnhanceList.appendChild(wrap);
  }

  /**
   * The per-model rows in Settings: what each catalog model costs on
   * disk RIGHT NOW (measured, never the authored number), with Download
   * for entries whose links are pinned and Remove for files the panel
   * itself downloaded. Remove never reaches into the user's own model
   * folders or the Comfy-Desktop shared store — those rows say where
   * the files live instead of offering to delete them.
   */
  var genDownloads = {};   // entry name -> {ctrl} while a download runs

  function renderGenModelRows() {
    if (!els.comfyGenModelsList) return;
    els.comfyGenModelsList.innerHTML = "";
    var s = global.Settings.get();
    var catalog = [];
    try { catalog = global.Setup.comfyCatalog(updateManifest) || []; }
    catch (e) {}
    if (!catalog.length) return;
    for (var i = 0; i < catalog.length; i++) {
      buildGenModelRow(catalog[i], s);
    }
  }

  function gbText(mb) {
    return (Math.round(mb / 1024 * 10) / 10) + " GB";
  }

  function buildGenModelRow(entry, s) {
    var st;
    try { st = global.Tools.catalogModelStatus(entry, s); }
    catch (e) { return; }
    if (!st.totalCount && !st.downloadable) {
      // Nothing to show or do (no pinned links AND no known filenames).
      return;
    }
    var row = document.createElement("div");
    row.className = "genmodel-row";
    var name = document.createElement("span");
    name.className = "genmodel-name";
    name.textContent = entry.label || entry.name;
    row.appendChild(name);

    var state = document.createElement("span");
    state.className = "genmodel-state";
    row.appendChild(state);

    function setState() {
      if (st.presentCount === 0) {
        state.textContent = st.downloadable
          ? "not downloaded" +
            (entry.sizeMB ? " — " + gbText(entry.sizeMB) : "")
          : "no download links pinned yet — they ship via the update feed";
      } else if (st.presentCount < st.totalCount) {
        state.textContent = st.presentCount + " of " + st.totalCount +
          " files on disk (" + gbText(st.presentMB) + ")";
      } else {
        state.textContent = gbText(st.presentMB) + " on disk" +
          (st.anyManaged ? "" : " — in a folder the panel doesn't manage");
      }
    }
    setState();

    var running = genDownloads[entry.name];
    if (running) {
      var cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.onclick = function () {
        try { if (running.ctrl) running.ctrl.cancel(); } catch (e) {}
        delete genDownloads[entry.name];
        renderGenModelRows();
      };
      row.appendChild(cancelBtn);
      state.textContent = running.text || "downloading…";
      running.onText = function (t) { state.textContent = t; };
    } else {
      if (st.downloadable && st.presentCount < st.totalCount) {
        var dlBtn = document.createElement("button");
        dlBtn.textContent = "Download";
        dlBtn.onclick = function () { startGenDownload(entry, st); };
        row.appendChild(dlBtn);
      }
      if (st.anyManaged) {
        var rmBtn = document.createElement("button");
        rmBtn.textContent = "Remove";
        rmBtn.onclick = function () { removeGenModel(entry); };
        row.appendChild(rmBtn);
      }
    }

    els.comfyGenModelsList.appendChild(row);
  }

  function startGenDownload(entry, st) {
    // Only what is missing: a partial download resumes with the files
    // that are not there, never re-fetching the ones that are.
    var missing = [];
    for (var i = 0; i < (entry.urls || []).length; i++) {
      var u = entry.urls[i];
      var base = String(u.url).split("?")[0].split("#")[0];
      base = base.slice(base.lastIndexOf("/") + 1);
      var have = false;
      for (var j = 0; j < st.files.length; j++) {
        if (st.files[j].file === base && st.files[j].path) { have = true; }
      }
      if (!have) missing.push(u);
    }
    if (!missing.length) { renderGenModelRows(); return; }
    var slot = { ctrl: null, text: "starting…", onText: null };
    genDownloads[entry.name] = slot;
    function say(t) {
      slot.text = t;
      if (slot.onText) slot.onText(t);
    }
    (function next(k) {
      if (k >= missing.length) {
        delete genDownloads[entry.name];
        renderGenModelRows();
        renderTierLine();   // a new weight can change the tier copy
        return;
      }
      var u = missing[k];
      var fileLabel = (missing.length > 1)
        ? "file " + (k + 1) + " of " + missing.length + ": " : "";
      slot.ctrl = global.Setup.downloadGenWeight(u, {
        status: function (t) { say(fileLabel + t); },
        progress: function (rec, total) {
          var pct = total ? Math.round(rec / total * 100) : 0;
          say(fileLabel + pct + "% of " +
              gbText(Math.round((total || 0) / 1048576)));
        }
      }, function (err) {
        if (err) {
          delete genDownloads[entry.name];
          renderGenModelRows();
          appendMsg("error", "Download failed: " + err.message);
          return;
        }
        next(k + 1);
      });
    })(0);
  }

  function removeGenModel(entry) {
    var s = global.Settings.get();
    var st = global.Tools.catalogModelStatus(entry, s);
    var lines = [], i;
    for (i = 0; i < st.files.length; i++) {
      if (st.files[i].path && st.files[i].managed) {
        lines.push(st.files[i].file + " (" + gbText(st.files[i].mb) + ")");
      }
    }
    if (!lines.length) { renderGenModelRows(); return; }
    var yes = window.confirm("Remove " + (entry.label || entry.name) +
      " from disk?\n\n" + lines.join("\n") +
      "\n\nOnly the panel's own model folders are touched. Download " +
      "again any time.");
    if (!yes) return;
    var r = global.Tools.removeCatalogWeights(entry, s);
    var parts = [];
    if (r.removed.length) {
      parts.push("Freed " + gbText(r.freedMB) + " (" + r.removed.length +
                 (r.removed.length === 1 ? " file" : " files") + ").");
    }
    for (i = 0; i < r.kept.length; i++) {
      parts.push("Kept " + r.kept[i].file + " — " + r.kept[i].why +
                 " (" + r.kept[i].path + ").");
    }
    for (i = 0; i < r.failed.length; i++) {
      parts.push("Could not delete " + r.failed[i].file + ": " +
                 r.failed[i].error);
    }
    if (r.note) parts.push(r.note);
    renderGenModelRows();
    // Re-render dropped the old note node; say the receipt in the chat
    // instead so it survives the refresh.
    if (parts.length) appendMsg("info", parts.join(" "));
    renderTierLine();
  }

  /* Only the opt-OUTs, same rule as enhancement: a template arriving in
   * an update is enabled without a settings migration. */
  function collectWorkflowEnabled() {
    var map = {};
    if (!els.comfyEnhanceList) return map;
    var boxes = els.comfyEnhanceList.querySelectorAll(
      "input[data-wf-enabled]");
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked) {
        map[boxes[i].getAttribute("data-wf-enabled")] = { enabled: false };
      }
    }
    return map;
  }

  function collectEnhanceToggles() {
    var map = {};
    if (!els.comfyEnhanceList) return map;
    var boxes = els.comfyEnhanceList.querySelectorAll(
      "input[data-workflow]");
    for (var i = 0; i < boxes.length; i++) {
      // Store only the opt-OUTs: absent = on, so a newly added workflow
      // starts enhanced without a settings migration.
      if (!boxes[i].checked) {
        map[boxes[i].getAttribute("data-workflow")] = false;
      }
    }
    return map;
  }

  var busy = false;
  // One-time notice when history first outgrows the model's window;
  // reset only by clearing the chat, not per message.
  var trimNoticeShown = false;
  var starveNoticeShown = false;      // once per session: the window itself
  var cutNoticeShown = false;         // once per chat: a message was cut
  var history = [];          // [{role, content}] — excludes system prompt
  var updateManifest = null; // cached update.json from the update channel

  // ------------------------------------------------------------ utilities

  function basename(p) {
    return String(p).replace(/[\\\/]+$/, "").split(/[\\\/]/).pop();
  }

  /** Version as shown to the user: "0.5.4-alpha". Comparisons stay numeric. */
  function displayVersion() {
    return global.AELL.VERSION +
      (global.AELL.CHANNEL ? "-" + global.AELL.CHANNEL : "");
  }

  var gpuInfo = null;   // cached at init for the copy-chat header

  /** Copy text to the clipboard (CEF supports execCommand on a textarea). */
  function copyToClipboard(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  /** Whole chat + environment header as a shareable text block. */
  function chatTranscript() {
    var env = global.AEBridge.getHostEnvironment();
    var s = global.Settings.get();
    var lines = [
      "AE Llama " + displayVersion() +
        (env && env.appVersion ? " — After Effects " + env.appVersion : ""),
      "Model: " + (global.Llama.getCurrentModel()
        ? basename(global.Llama.getCurrentModel())
        : basename(els.modelSelect.value || "(none)")) +
        " (port " + s.port + ", ctx " + s.ctxSize + ")",
      "GPU: " + (gpuInfo
        ? (gpuInfo.hasNvidia
            ? (gpuInfo.name || "NVIDIA") +
              (gpuInfo.vramGB ? ", " + gpuInfo.vramGB + " GB" : "") +
              (gpuInfo.cudaVersion ? ", CUDA " + gpuInfo.cudaVersion : "")
            : "no NVIDIA GPU detected")
        : "(not probed)"),
      "----"
    ];
    var msgs = els.chat.children;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m.className || m.className.indexOf("msg") === -1) continue;
      var kind = (m.className.match(/msg\s+(\S+)/) || [])[1] || "msg";
      var label = "";
      var lab = m.querySelector ? m.querySelector(".msg-label") : null;
      if (lab) label = lab.textContent + "\n";
      var text = m.textContent || "";
      if (lab) text = text.slice(lab.textContent.length);
      lines.push("[" + kind + "] " + (label ? label : "") + text);
    }
    return lines.join("\n");
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

  /*
   * Starting the chat model is a VRAM decision, and until 2026-09-15 it
   * was the only one the panel made without arithmetic: `planHandoff`
   * runs when a GENERATION is asked for, so a model loaded onto a card
   * After Effects was already working on was never priced at all. That
   * is the field incident in §16b — AE plus a 32B model at 28,804 MB of
   * 32,607, and a display that went black with no driver event logged.
   *
   * Three outcomes, and only one of them stops anything: a model that
   * cannot physically fit in the free VRAM is refused with the numbers;
   * a model that fits but leaves the desktop under its floor loads, and
   * says so first; anything unmeasured loads silently, because a gate
   * that guesses is worse than no gate. Then the card is READ again once
   * the model is resident — the estimate is file size plus a constant,
   * and the incident landed under the floor while that estimate said it
   * was clear.
   */
  function startServer() {
    var s = global.Settings.get();
    if (!s.modelPath) {
      appendMsg("error", "Pick a model first (dropdown above, or Browse…).");
      return;
    }
    global.Tools.planChatLoad(s, function (plan) {
      if (plan && plan.mode === "refuse") {
        appendMsg("error", plan.reason);
        return;
      }
      if (plan && plan.mode === "tight") appendMsg("info", plan.reason);
      global.Llama.start({
        serverPath: s.serverPath,
        modelPath: s.modelPath,
        port: s.port,
        ctxSize: s.ctxSize,
        gpuLayers: s.gpuLayers
      }, function (err) {
        if (err) return;
        appendMsg("info", basename(s.modelPath) + " ready on port " + s.port);
        global.Tools.checkVramAfterChatLoad(function (warn) {
          if (warn) appendMsg("info", warn);
        });
      });
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

  // Lives in tools.js so the budgeting rules can be tested without a
  // panel — see Tools.fetchProjectState.
  function fetchProjectState(cb) {
    global.Tools.fetchProjectState(cb);
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
    var parseRetried = false;   // one compact-retry per send on truncation
    // One hard-trim retry per send on a context 400. A per-send var, not
    // a property of `round`: round is a NUMBER here, and in strict mode
    // `round.forceTinyContext = true` threw inside the llama callback and
    // left the panel busy (§24c, tests/test-main-context-retry.js).
    var forceTinyContext = false;
    // ONE rollback per user request, across all its rounds. See
    // executeCommands: a second one turns a deterministic failure into
    // undo/retry/undo until maxRounds.
    var rollbackBudget = 1;
    // Comp-name aliases from create_comp renames live for exactly one
    // request — clear them as the next one begins (no timers).
    try {
      global.AEBridge.evalScript(
        "if ($.global.AELL_newRequest) $.global.AELL_newRequest();");
    } catch (eA) {}
    setSendMode(true);
    els.clearChatBtn.disabled = true;   // clearing mid-round corrupts history
    var thinking = appendMsg("info", "Thinking…");

    var s = global.Settings.get();

    var po = null, turnState = "";
    fetchProjectState(function (stateJson) {
      // The prompt form follows the window: under 24K tokens the full
      // tool docs leave no room for a conversation (measured 2026-09-01),
      // so those windows get the compact docs. The rules block is the
      // same in both. promptRouting "auto" narrows it to this sentence's
      // tools (§24b); scripts/chat-probe.js makes the same call.
      turnState = stateJson;
      po = global.Tools.promptOptsFor(s, text, history);
      var system = global.Tools.buildSystemPrompt(stateJson, po.opts);
      runRound(system, 0);
    });

    // Round N+1's route grows by what round N called and what its
    // results named (§24c); the state stays this turn's. In step with
    // scripts/chat-probe.js.
    function nextSystem(system, commands, resultsText) {
      if (!global.Tools.extendPromptOpts(po, commands, resultsText)) {
        return system;
      }
      return global.Tools.buildSystemPrompt(turnState, po.opts);
    }

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

    // A verbose tool result must never blow the model's context window.
    // The budgeting lives in tools.js so it can be tested without a
    // panel - and so it can never go back to byte-slicing, which used
    // to hand the model JSON cut mid-object.
    function compactToolResults(results) {
      return global.Tools.compactToolResults(results);
    }

    function runRound(system, round) {
      if (cancelRequested) { finish(); return; }
      // Bound what the model is SENT — the visible transcript keeps
      // everything. The budget is arithmetic over the window and the
      // MEASURED prompt (Tools.historyBudget), not a floor: the old
      // max(4000, …) floor was negative at real prompt sizes, so most
      // rounds ran with one turn of memory and nobody knew.
      var hb = global.Tools.historyBudget(s.ctxSize, system);
      var histBudget = hb.chars;
      if (forceTinyContext) {
        // The reactive path: a context 400 got through anyway (one huge
        // entry, or the estimate lost). Keep only the current exchange.
        histBudget = 1;
      }
      var fitted = global.Tools.fitHistory(history, histBudget);
      var sys = system;
      if (fitted.ledger) {
        // Dropped turns come back as the ledger: one line of function
        // each (what ran, what it named), in the prompt's own slice.
        sys += "\n\n" + fitted.ledger;
      }
      if (fitted.dropped > 0 && !trimNoticeShown) {
        trimNoticeShown = true;
        appendMsg("info", "Older turns now reach the model as a one-line " +
          "ledger of what ran and what it named, instead of in full — " +
          "your transcript is unaffected. Clearing the chat starts fresh.",
          "context ledger");
      }
      if (fitted.truncated > 0 && !cutNoticeShown) {
        cutNoticeShown = true;
        // Different fact from the ledger's, and worth its own line: the
        // ledger says old turns were SUMMARISED, this says a message in
        // the current exchange reached the model with its middle
        // missing. A result the model half-read is a result it may
        // half-believe, so the user gets told which way to fix it.
        appendMsg("info", "One message in this exchange was too large " +
          "for the model's context window on its own, so the model was " +
          "sent the start of it and told the rest was cut. If its answer " +
          "looks like it missed something, raise Context size in " +
          "Settings or clear the chat.", "message cut to fit");
      }
      if (hb.starved && !starveNoticeShown) {
        starveNoticeShown = true;
        appendMsg("info", "The model's context window (" + s.ctxSize +
          " tokens) is nearly filled by the tool documentation and " +
          "project state alone (~" + hb.promptTokens + " tokens), so it " +
          "will forget turns quickly. Raising Context size in Settings " +
          "gives it memory — it costs VRAM.", "context");
      }
      var messages = [{ role: "system", content: sys }]
        .concat(fitted.entries);
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
              finish();
              return;
            }
            // A reply that hit the output-token cap arrives as truncated,
            // unparseable JSON. Discard it and ask once for a compact redo
            // instead of failing the whole request.
            if (/unparseable/i.test(err.message) && !parseRetried) {
              parseRetried = true;
              history.push({ role: "user", content:
                "SYSTEM: Only your LAST response was truncated and " +
                "discarded — nothing from it ran. Everything acknowledged " +
                "in earlier TOOL RESULTS already happened: do NOT repeat " +
                "those commands (no re-creating comps or layers). Continue " +
                "from where the results left off, as valid JSON with AT " +
                "MOST 8 compact commands (use batch options like " +
                "duplicate_layer count or distribute_property step)." });
              appendMsg("info", "Reply was cut off — asking the model to " +
                        "retry compactly…");
              runRound(system, round);
              return;
            }
            // A context overflow that slipped past the proactive trim
            // (one oversized entry, or the chars-per-token estimate
            // lost). One retry with only the current exchange — the
            // grounded message, not llama-server's raw HTTP 400, is
            // what the user sees if that fails too.
            if (/context|exceed|too (?:long|large|many)/i.test(
                  err.message) && !forceTinyContext) {
              forceTinyContext = true;
              appendMsg("info", "The request outgrew the model's " +
                "context window — retrying with older turns trimmed.");
              runRound(system, round);
              return;
            }
            appendMsg("error", "Model error: " + err.message);
            finish();
            return;
          }
          history.push({ role: "assistant", content: raw });

          var reply = typeof obj.reply === "string" ? obj.reply : "";
          var commands = obj.commands instanceof Array ? obj.commands : [];
          if (reply) appendMsg("assistant", reply);

          if (commands.length === 0 || cancelRequested) { finish(); return; }

          // A rolled-back round rewrites every one of its results, so
          // reporting them one by one would bury the user in identical
          // red lines. Say it once, as what actually happened.
          var rollbackAnnounced = false;

          global.Tools.executeCommands(
            commands,
            { dryRun: s.dryRun,
              allowRollback: rollbackBudget > 0,
              shouldStop: function () { return cancelRequested; } },
            function (i, cmd, result) {
              if (result.rolledBack) {
                if (!rollbackAnnounced) {
                  rollbackAnnounced = true;
                  rollbackBudget--;
                  appendMsg("error",
                    "This round failed part way, so all of it was undone — " +
                    "the project is back to how it was before. " +
                    String(result.error || result.note || "").slice(0, 300),
                    "round rolled back");
                }
                return;
              }
              var head = cmd.tool + " " + JSON.stringify(cmd.args || {});
              // A failed command mid-round is usually the model being
              // CORRECTED by a grounded error and retrying — measured in
              // the field (2026-08-26): a red ERROR line for a call the
              // panel fixed itself one round later read as "the plugin
              // is broken". Render it muted; real failures reach the
              // user through the model's own reply, the rollback notice,
              // or the round cap — all of which stay loud.
              var body = result.ok
                ? (result.dryRun ? "would run" : "ok") +
                  (result.data ? ": " +
                    JSON.stringify(result.data).slice(0, 400) : "")
                : "adjusting — " + result.error;
              appendMsg(result.ok ? "tool" : "retry", body, head);
            },
            function (results) {
              var resultsText = compactToolResults(results);
              history.push({
                role: "user",
                content: "TOOL RESULTS:\n" + resultsText
              });
              if (cancelRequested) { finish(); return; }
              if (round + 1 >= s.maxRounds) {
                appendMsg("info",
                  "Stopped after " + s.maxRounds + " tool rounds.");
                finish();
                return;
              }
              runRound(nextSystem(system, commands, resultsText), round + 1);
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
    var ctrl = global.Setup.bootstrapEngine(
      { tag: tag, onProgress: paintProgress }, setupStatus,
      function (err, res) {
        hideProgress();
        setupLine = null;
        if (err) {
          appendMsg(err.cancelled ? "info" : "error",
            err.cancelled
              ? "Engine download cancelled — use 'Reinstall / update engine' in settings to retry."
              : "Engine setup failed: " + err.message +
                " — use 'Reinstall / update engine' in settings to retry.");
        } else if (!res.skipped) {
          appendMsg("info", "Engine installed. Pick a model and press Start.");
          populateModelDropdown();
        }
      });
    if (ctrl) showProgress("AI engine", function () { ctrl.cancel(); });
  }

  function updateEngine() {
    if (global.Llama.getState() !== "stopped" &&
        global.Llama.getState() !== "error") {
      global.Llama.stop();
    }
    var tag = updateManifest && updateManifest.llamaTag
      ? updateManifest.llamaTag : "latest";
    var ctrl = global.Setup.bootstrapEngine(
      { force: true, tag: tag, onProgress: paintProgress }, setupStatus,
      function (err) {
        hideProgress();
        setupLine = null;
        appendMsg(err ? (err.cancelled ? "info" : "error") : "info",
          err ? (err.cancelled ? "Engine update cancelled."
                               : "Engine update failed: " + err.message)
              : "Engine updated.");
      });
    if (ctrl) showProgress("AI engine", function () { ctrl.cancel(); });
  }

  var panelUpdateBusy = false;

  /**
   * Reload the panel in place: CEF re-reads index.html + js from the
   * extension folder, and init() re-evaluates the host jsx — so a freshly
   * installed update goes live without closing the panel.
   */
  function reloadPanel() {
    try { global.Llama.stop(); } catch (e) {}
    global.location.reload();
  }

  function installPanelUpdate(quiet) {
    if (panelUpdateBusy) return;
    panelUpdateBusy = true;
    // The launch-time auto check is silent until it has an OUTCOME. It
    // used to announce "Dev install detected — git pull in …" and then
    // say nothing when the repo was already current — a permanently
    // dangling status line, twice on some launches (field, 2026-08-26).
    // Progress narration is for the user-initiated button path only.
    global.Setup.installUpdate(updateManifest, quiet ? null : setupStatus,
      function (err, res) {
        panelUpdateBusy = false;
        setupLine = null;
        if (err) {
          if (quiet) {
            // A failed background pull (offline, mid-rebase repo) is
            // non-actionable at launch — one calm line, never red.
            appendMsg("info", "Panel self-update skipped: " +
              String(err.message || err).slice(0, 120));
          } else {
            appendMsg("error", "Panel update failed: " + err.message);
          }
          return;
        }
        if (res.kind === "git" && !res.changed) {
          // Nothing new: the quiet path stays wholly silent.
          if (!quiet) appendMsg("info", "Repo already up to date.");
          return;
        }
        if (quiet) {
          // Launch-time auto-update: apply it immediately (once per CEF
          // session, so a misbehaving feed can never cause a reload loop).
          var done = null;
          try { done = global.sessionStorage.getItem("aell-auto-reloaded"); } catch (e) {}
          if (!done) {
            try { global.sessionStorage.setItem("aell-auto-reloaded", "1"); } catch (e) {}
            appendMsg("info", "Panel updated — reloading with the new version…");
            global.setTimeout(reloadPanel, 1200);
            return;
          }
          // Guard tripped (already auto-reloaded once): hand over control.
          appendActionMsg("Panel updated" +
            (res.output ? " (" + res.output + ")" : "") + ".",
            [{ label: "Reload panel now", onClick: reloadPanel }]);
          return;
        }
        // User-initiated update: they asked for it — apply it.
        appendMsg("info", "Panel updated" +
          (res.output ? " (" + res.output + ")" : "") + " — reloading…");
        global.setTimeout(reloadPanel, 1200);
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
          displayVersion() + ").");
      }
    });
  }

  var gpuInfo = null;

  // ------------------------------------------------- download progress bar

  var currentCancel = null;
  var progressBase = "";
  var lastBarPaint = 0;

  function fmtBytes(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
    return Math.max(1, Math.round(b / 1e6)) + " MB";
  }

  function showProgress(label, cancelFn) {
    progressBase = label;
    currentCancel = cancelFn || null;
    els.progressLabel.textContent = label + " — starting…";
    els.progressFill.style.width = "0%";
    els.progressRow.classList.remove("hidden");
    // The bar lives above the drawers, but close settings so the user sees
    // the chat status lines too.
    els.settingsDrawer.classList.add("hidden");
  }

  function paintProgress(rec, total) {
    var now = Date.now();
    if (now - lastBarPaint < 150) return;
    lastBarPaint = now;
    if (total > 0) {
      var pct = Math.min(100, (rec / total) * 100);
      els.progressFill.style.width = pct.toFixed(1) + "%";
      els.progressLabel.textContent = progressBase + " — " +
        Math.floor(pct) + "%  (" + fmtBytes(rec) + " / " + fmtBytes(total) + ")";
    } else {
      els.progressLabel.textContent = progressBase + " — " + fmtBytes(rec);
    }
  }

  function hideProgress() {
    els.progressRow.classList.add("hidden");
    currentCancel = null;
  }

  /** Fill both catalog pickers, best fit for the detected GPU preselected. */
  function populateModelCatalog() {
    var catalog = global.Setup.modelCatalog(updateManifest);
    var rec = global.Setup.recommendModel(catalog, gpuInfo);
    var selects = [els.starterSelect, els.setModelSelect];
    for (var s = 0; s < selects.length; s++) {
      var sel = selects[s];
      if (!sel) continue;
      sel.innerHTML = "";
      for (var i = 0; i < catalog.length; i++) {
        var m = catalog[i];
        var fits = gpuInfo && gpuInfo.vramGB
          ? gpuInfo.vramGB >= m.minVramGB
          : !!m.cpuDefault;
        // sizeMB is MiB (version.js) — the same /1024 the download status
        // line uses. Dividing by 1000 here made the dropdown and the
        // downloader quote two different sizes for one file.
        var label = m.label + " · " + (m.sizeMB / 1024).toFixed(1) + " GB";
        if (!fits) label += " — needs " + m.minVramGB + "+ GB VRAM";
        if (rec && m.name === rec.name) label += "  ✓ recommended";
        var o = document.createElement("option");
        o.value = m.name;
        o.textContent = label;
        sel.appendChild(o);
      }
      if (rec) sel.value = rec.name;
    }
  }

  function downloadCatalogModel(selectEl) {
    var catalog = global.Setup.modelCatalog(updateManifest);
    var chosen = null;
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].name === selectEl.value) { chosen = catalog[i]; break; }
    }
    if (!chosen) { appendMsg("error", "Pick a model first."); return; }
    if (currentCancel) {
      appendMsg("info", "A download is already running — cancel it first (✕).");
      return;
    }
    els.getModelBtn.disabled = true;
    var ctrl = global.Setup.downloadModel(chosen, {
      status: setupStatus,
      progress: paintProgress
    }, function (err, dest) {
      hideProgress();
      setupLine = null;
      els.getModelBtn.disabled = false;
      if (err) {
        appendMsg(err.cancelled ? "info" : "error",
          err.cancelled ? "Model download cancelled."
                        : "Model download failed: " + err.message);
        return;
      }
      appendMsg("info", chosen.label + " downloaded.");
      global.Settings.set({ modelPath: dest });
      populateModelDropdown();
    });
    if (ctrl) {
      showProgress(chosen.label, function () { ctrl.cancel(); });
    }
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
    els.setComfyBackend.value = s.comfyBackend === "own" ? "own" : "managed";
    els.setComfyManagedPort.value = s.comfyManagedPort || 8288;
    els.setComfyUrl.value = s.comfyUrl;
    els.setComfyDir.value = s.comfyDir;
    els.setComfyWorkflows.value = s.comfyWorkflowsDir;
    els.setComfyOut.value = s.comfyOutDir;
    els.setComfyModels.value = s.comfyModelsDir || "";
    els.setComfyModelRoots.value =
      (s.comfyModelRoots || []).join("\n");
    els.setComfyTimeout.value = s.comfyTimeoutSec;
    els.setComfyPauseLlm.value =
      s.comfyPauseLlm === "always" || s.comfyPauseLlm === "never"
        ? s.comfyPauseLlm : "auto";
    els.setVramOverride.value = s.vramOverrideGB || 0;
    renderEnhanceToggles(s);
    renderGenModelRows();
    renderModelRootsCheck();
    renderTierLine();
    els.setAutoUpdate.checked = !!s.autoInstallUpdates;
  }

  /**
   * Under Extra model folders (WORKPLAN §19b): one line per typed folder
   * saying what the backend will find there ("12 model files" / "folder
   * not found"), so a typo is visible at once instead of as a Workflows
   * row still missing files three screens away.
   */
  function renderModelRootsCheck() {
    var box = els.modelRootsReport;
    if (!box) return;
    box.innerHTML = "";
    var rows = [];
    try { rows = global.Setup.checkModelRootLines(els.setComfyModelRoots.value); }
    catch (e) { rows = []; }
    for (var i = 0; i < rows.length; i++) {
      var line = document.createElement("div");
      line.className = rows[i].ok ? "mr-ok" : "mr-bad";
      line.textContent = (rows[i].ok ? "✓ " : "✗ ") +
        rows[i].line + " — " + rows[i].message;
      box.appendChild(line);
    }
  }

  /**
   * "Scan for models": the §19a shortlist, one line per folder found.
   * Folders the panel already searches say so; the rest get an Add
   * checkbox (ticked) and one button appends the ticked ones to the box.
   */
  function renderModelRootsScan() {
    var box = els.modelRootsReport;
    if (!box) return;
    formToSettings();
    box.innerHTML = "";
    var found = [];
    try { found = global.Setup.scanForModelRoots(global.Settings.get()); }
    catch (e) { found = []; }
    var head = document.createElement("div");
    if (!found.length) {
      head.textContent = "No model files in the usual places (Documents\\" +
        "ComfyUI, ComfyUI in your user folder, ComfyUI Desktop, your " +
        "ComfyUI install folder). If yours are elsewhere, type the folder " +
        "above.";
      box.appendChild(head);
      return;
    }
    head.textContent = "Found:";
    box.appendChild(head);
    var picks = [];
    for (var i = 0; i < found.length; i++) {
      var c = found[i];
      var label = document.createElement("label");
      label.className = "check";
      var text = document.createElement("span");
      text.textContent = global.Setup.describeModelRootCandidate(c);
      var where = document.createElement("div");
      where.className = "mr-path";
      where.textContent = c.path;
      if (c.covered) {
        text.className = "mr-ok";
        label.appendChild(text);
      } else {
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        picks.push({ box: cb, line: global.Setup.modelRootCandidateLine(c) });
        label.appendChild(cb);
        label.appendChild(text);
      }
      box.appendChild(label);
      box.appendChild(where);
    }
    if (!picks.length) return;
    var add = document.createElement("button");
    add.textContent = "Add ticked folders";
    add.addEventListener("click", function () {
      var lines = [];
      for (var p = 0; p < picks.length; p++) {
        if (picks[p].box.checked) lines.push(picks[p].line);
      }
      els.setComfyModelRoots.value = global.Setup.mergeModelRootLines(
        els.setComfyModelRoots.value, lines);
      formToSettings();
      renderGenModelRows();
      renderModelRootsCheck();
    });
    box.appendChild(add);
  }

  /**
   * The combined, tier-derived hardware line in the ComfyUI section:
   * what this card is, which tier it lands in, and the chat +
   * generation picks that follow from it. Re-rendered whenever the GPU
   * probe or the settings change.
   */
  function renderTierLine() {
    if (!els.tierLine) return;
    try {
      var rec = global.Setup.recommendSetup(updateManifest, gpuInfo);
      els.tierLine.textContent = rec.copy;
    } catch (e) {
      els.tierLine.textContent = "";
    }
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
      comfyBackend: els.setComfyBackend.value === "own" ? "own" : "managed",
      comfyManagedPort: parseInt(els.setComfyManagedPort.value, 10) || 8288,
      comfyUrl: els.setComfyUrl.value || "http://127.0.0.1:8188",
      comfyDir: els.setComfyDir.value,
      comfyWorkflowsDir: els.setComfyWorkflows.value,
      comfyOutDir: els.setComfyOut.value,
      comfyModelsDir: els.setComfyModels.value,
      comfyModelRoots: els.setComfyModelRoots.value
        .split(/\r?\n/)
        .map(function (l) { return l.replace(/^\s+|\s+$/g, ""); })
        .filter(function (l) { return !!l; }),
      comfyTimeoutSec: parseInt(els.setComfyTimeout.value, 10) || 600,
      comfyPauseLlm: els.setComfyPauseLlm.value || "auto",
      vramOverrideGB: parseInt(els.setVramOverride.value, 10) || 0,
      comfyEnhance: collectEnhanceToggles(),
      comfyWorkflows: collectWorkflowEnabled(),
      autoInstallUpdates: !!els.setAutoUpdate.checked
    });
    renderTierLine();
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
      setComfyBackend: $("set-comfy-backend"),
      setComfyManagedPort: $("set-comfy-managed-port"),
      setComfyUrl: $("set-comfy-url"),
      setComfyDir: $("set-comfy-dir"),
      setComfyWorkflows: $("set-comfy-workflows"),
      setComfyOut: $("set-comfy-out"),
      setComfyModels: $("set-comfy-models"),
      setComfyModelRoots: $("set-comfy-model-roots"),
      modelRootsReport: $("model-roots-report"),
      setComfyTimeout: $("set-comfy-timeout"),
      setComfyPauseLlm: $("set-comfy-pause-llm"),
      setVramOverride: $("set-vram-override"),
      tierLine: $("tier-line"),
      comfyEnhanceList: $("comfy-enhance-list"),
      comfyGenModelsList: $("comfy-genmodels-list"),
      setAutoUpdate: $("set-auto-update"),
      starterRow: $("starter-row"),
      starterSelect: $("starter-select"),
      setModelSelect: $("set-model-select"),
      getModelBtn: $("btn-get-model"),
      versionLine: $("version-line"),
      progressRow: $("progress-row"),
      progressLabel: $("progress-label"),
      progressFill: $("progress-fill")
    };

    if (!global.AEBridge.available()) {
      appendMsg("error",
        "CEP runtime not detected. This page must run inside After Effects.");
      return;
    }

    // Re-evaluate the host script: CEP only auto-loads ScriptPath on the
    // extension's FIRST load, so after an in-place update + reload this is
    // what brings the newest ExtendScript tools live too.
    try {
      var jsxPath = (global.AEBridge.getExtensionPath() + "/jsx/hostscript.jsx")
        .replace(/\\/g, "/").replace(/"/g, '\\"');
      global.AEBridge.evalScript('$.evalFile("' + jsxPath + '")');
    } catch (e) {}

    // Populate the settings form up front so no code path can ever persist
    // never-filled (empty) fields over the real settings.
    settingsToForm();

    // A llama-server or hidden ComfyUI from an earlier load of this page may
    // still be alive: both are non-detached, so AE exiting kills them, but a
    // reload keeps the process (and its job object) and loses our handles.
    // Reap by recorded PID (WORKPLAN 17i).
    try { global.Llama.reapOrphan(); } catch (e) {}
    try { global.Comfy.reapOrphan(); } catch (eC) {}

    // Persistent data folders (survive extension updates) + seeding.
    // A refresh means an unedited-but-stale bundled template was brought
    // up to date; say so in the console rather than changing a user's
    // workflow file in total silence.
    try {
      var seedSummary = global.Setup.ensureDataDirs();
      if (seedSummary && seedSummary.refreshed && seedSummary.refreshed.length) {
        console.log("AE Llama: updated stale bundled workflow file(s): " +
                    seedSummary.refreshed.join(", "));
      }
    } catch (e) {}

    els.versionLine.textContent = "AE Llama " + displayVersion() +
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

    // -- visualizer pane
    global.Viz.init({
      $: $,
      appendMsg: appendMsg,
      callHostTool: global.Tools.callHostTool
    });
    $("btn-visualizer").addEventListener("click", function () {
      var v = $("visualizer");
      var nowHidden = v.classList.toggle("hidden");
      $("split-handle").classList.toggle("hidden", nowHidden);
      if (!nowHidden) global.Viz.onShow();
    });

    // -- draggable chat/visualizer divider (width persists)
    (function () {
      var viz = $("visualizer");
      var handle = $("split-handle");
      var savedW = global.Settings.get().vizWidth;
      if (savedW > 0) viz.style.flex = "0 0 " + savedW + "px";
      var drag = null;
      handle.addEventListener("mousedown", function (e) {
        drag = { x: e.clientX, w: viz.offsetWidth || 260 };
        handle.classList.add("dragging");
        e.preventDefault();
      });
      global.addEventListener("mousemove", function (e) {
        if (!drag) return;
        var w = Math.max(180, Math.min(
          Math.round(global.innerWidth * 0.7),
          drag.w + (drag.x - e.clientX)));
        viz.style.flex = "0 0 " + w + "px";
      });
      global.addEventListener("mouseup", function () {
        if (!drag) return;
        drag = null;
        handle.classList.remove("dragging");
        try {
          global.Settings.set({ vizWidth: viz.offsetWidth });
        } catch (e) {}
      });
    })();

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
    $("btn-browse-comfy-models").addEventListener("click", function () {
      browseIntoField(els.setComfyModels,
        "Choose a folder for generation models (they get big)", true);
    });
    els.setComfyModelRoots.addEventListener("change", function () {
      formToSettings();
      renderGenModelRows();
      renderModelRootsCheck();
    });
    $("btn-scan-model-roots").addEventListener("click", renderModelRootsScan);
    // -- one-click real-AE self-test with a copyable report
    $("btn-self-test").addEventListener("click", function () {
      els.settingsDrawer.classList.add("hidden");
      global.SelfTest.run({
        callHostTool: global.Tools.callHostTool,
        callHostBatch: global.Tools.callHostBatch,
        onLine: function (t) { appendMsg("info", t); },
        onDone: function (res) {
          appendMsg(res.passed === res.total ? "info" : "error", res.text);
        }
      });
    });

    // -- one-click chat copy (transcript + version/model/GPU header)
    $("btn-copy-chat").addEventListener("click", function () {
      var text = chatTranscript();
      var count = (text.match(/^\[/gm) || []).length;
      appendMsg("info", copyToClipboard(text)
        ? "Chat copied to clipboard (" + count + " messages, with " +
          "version/model/GPU info)."
        : "Could not copy to the clipboard.");
    });

    // Probe the GPU once so the copy header has real hardware info —
    // and hand the result to the VRAM arbiter, which decides per
    // generation whether chat and the job can share the card.
    try {
      global.Setup.detectGpu(function (g) {
        gpuInfo = g;
        global.Tools.setGpuInfo(g);
        renderTierLine();
      });
    } catch (eG) {}

    $("btn-comfy-install").addEventListener("click", function () {
      var ctrl = global.Setup.bootstrapComfy(
        function (t) { appendMsg("info", t); },
        paintProgress,
        function (err, res) {
          hideProgress();
          if (err) {
            appendMsg(err.cancelled ? "info" : "error",
              err.cancelled ? "Backend install cancelled."
                            : "Backend install failed: " + err.message);
            return;
          }
          appendMsg("info", res.alreadyInstalled
            ? "Hidden ComfyUI backend is already installed (" +
              res.root + ")."
            : "Hidden ComfyUI backend installed — image generation now " +
              "runs invisibly and boots itself on the first request.");
        });
      if (ctrl) showProgress("ComfyUI backend", function () { ctrl.cancel(); });
    });
    $("btn-comfy-launch").addEventListener("click", function () {
      formToSettings();
      global.Comfy.launch(global.Settings.get().comfyDir, function (err, msg) {
        appendMsg(err ? "error" : "info", err ? err.message : msg);
      });
    });
    $("btn-comfy-test").addEventListener("click", function () {
      formToSettings();
      var cs = global.Settings.get();
      global.Comfy.status(global.Comfy.backendUrl(cs), function (err, st) {
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
      trimNoticeShown = false;   // a fresh chat earns a fresh warning
      cutNoticeShown = false;
      els.chat.innerHTML = "";
      appendMsg("info", "Conversation cleared.");
    });

    // -- shut the server + hidden backend down with the panel
    global.addEventListener("unload", function () {
      try { global.Llama.stop(); } catch (e) {}
      try { global.Comfy.stopManaged(); } catch (e2) {}
    });

    // -- advanced settings reveal
    $("btn-advanced-toggle").addEventListener("click", function () {
      var adv = $("advanced-settings");
      var open = adv.classList.toggle("hidden");
      this.innerHTML = open ? "Advanced &#9656;" : "Advanced &#9662;";
    });

    // -- comfyui settings reveal
    $("btn-comfy-toggle").addEventListener("click", function () {
      var cfy = $("comfy-settings");
      var open = cfy.classList.toggle("hidden");
      this.innerHTML = open ? "ComfyUI &#9656;" : "ComfyUI &#9662;";
    });

    // -- updates + model catalog + auto-bootstrap
    $("btn-progress-cancel").addEventListener("click", function () {
      if (currentCancel) {
        els.progressLabel.textContent = progressBase + " — cancelling…";
        currentCancel();
      }
    });
    els.getModelBtn.addEventListener("click", function () {
      downloadCatalogModel(els.starterSelect);
    });
    $("btn-get-model-settings").addEventListener("click", function () {
      downloadCatalogModel(els.setModelSelect);
    });
    populateModelCatalog();                       // sensible list immediately
    global.Setup.detectGpu(function (g) {         // then VRAM-aware refresh
      gpuInfo = g;
      global.Tools.setGpuInfo(g);
      populateModelCatalog();
      renderTierLine();
    });
    $("btn-check-updates").addEventListener("click", function () {
      checkForUpdates(true);
    });
    $("btn-update-panel").addEventListener("click", installPanelUpdate);
    $("btn-update-engine").addEventListener("click", updateEngine);

    var env = global.AEBridge.getHostEnvironment();
    appendMsg("info", "AE Llama " + displayVersion() + " ready" +
      (env && env.appVersion ? " — After Effects " + env.appVersion : "") +
      ".");

    // Silent update check, then hands-off engine install if needed.
    // (checkForUpdates caches the manifest so bootstrap can use its pinned
    // llamaTag; bootstrap proceeds regardless after a short head start.)
    checkForUpdates(false);
    global.setTimeout(autoBootstrap, 2500);

    // Git installs need no hosted update feed at all — the repo IS the
    // feed. With auto-update on, pull on every launch.
    global.setTimeout(function () {
      try {
        if (global.Settings.get().autoInstallUpdates &&
            global.Setup.detectInstallKind().kind === "git") {
          installPanelUpdate(true);
        }
      } catch (e) {}
    }, 4000);
  }

  document.addEventListener("DOMContentLoaded", init);

})(window);
