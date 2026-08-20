/*
 * comfy.js — bridge to a local ComfyUI instance (image/video generation).
 *
 * Talks to ComfyUI's HTTP API through CEP's embedded Node.js:
 *   POST /prompt              queue an API-format workflow graph
 *   GET  /history/<id>        poll for completion + output file list
 *   GET  /view?filename=…     download rendered files
 *   GET  /queue               liveness + queue depth
 *
 * Workflow templates are plain "API format" JSON files exported from ComfyUI
 * (Export (API) in the workflow menu). Before queueing, injectParams() grafts
 * the model's prompt/size/seed/frames onto the graph by node introspection,
 * so almost any user workflow works without hand-editing.
 */
(function (global) {
  "use strict";

  var http = null;
  var https = null;
  var fs = null;
  var path = null;
  var child_process = null;
  var NodeBuffer = null;

  function ensureNode() {
    if (http) return;
    http = global.AEBridge.nodeRequire("http");
    https = global.AEBridge.nodeRequire("https");
    fs = global.AEBridge.nodeRequire("fs");
    path = global.AEBridge.nodeRequire("path");
    child_process = global.AEBridge.nodeRequire("child_process");
    NodeBuffer = global.AEBridge.nodeRequire("buffer").Buffer;
  }

  // ------------------------------------------------------------------ http

  function parseBase(comfyUrl) {
    var raw = String(comfyUrl || "");
    // "localhost:8189" / "192.168.1.5:8188" are valid user input but not
    // valid URLs — give them a scheme instead of silently probing defaults.
    if (raw && raw.indexOf("://") === -1) raw = "http://" + raw;
    var u;
    try {
      u = new URL(raw);
    } catch (e) {
      u = new URL("http://127.0.0.1:8188");
    }
    var isHttps = u.protocol === "https:";
    return {
      isHttps: isHttps,
      host: u.hostname || "127.0.0.1",
      port: u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 8188),
      label: (u.hostname || "127.0.0.1") + ":" +
             (u.port || (isHttps ? "443" : "8188"))
    };
  }

  function requestJson(base, method, urlPath, body, timeoutMs, cb) {
    ensureNode();
    var mod = base.isHttps ? https : http;
    var payload = body ? JSON.stringify(body) : null;
    var req = mod.request({
      host: base.host,
      port: base.port,
      path: urlPath,
      method: method,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": NodeBuffer.byteLength(payload)
      } : {}
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var text = NodeBuffer.concat(chunks).toString("utf8");
        var json = null;
        try { json = JSON.parse(text); } catch (e) {}
        cb(null, res.statusCode, json, text);
      });
    });
    req.on("error", function (err) { cb(err); });
    req.setTimeout(timeoutMs, function () {
      req.destroy(new Error("ComfyUI request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  }

  function downloadFile(base, urlPath, destPath, cb) {
    ensureNode();
    var mod = base.isHttps ? https : http;
    var req = mod.request({
      host: base.host, port: base.port, path: urlPath, method: "GET"
    }, function (res) {
      if (res.statusCode !== 200) {
        res.resume();
        cb(new Error("Download failed (HTTP " + res.statusCode + "): " + urlPath));
        return;
      }
      var out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on("finish", function () { out.close(); cb(null, destPath); });
      out.on("error", function (err) { cb(err); });
    });
    req.on("error", function (err) { cb(err); });
    req.setTimeout(120000, function () {
      req.destroy(new Error("Download timed out: " + urlPath));
    });
    req.end();
  }

  // ------------------------------------------------------------- workflows

  /** List *.json workflow templates in dir (non-recursive). */
  function listWorkflows(dir) {
    ensureNode();
    var out = [];
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return out; }
    for (var i = 0; i < entries.length; i++) {
      if (/\.json$/i.test(entries[i])) {
        out.push({
          name: entries[i].replace(/\.json$/i, ""),
          file: path.join(dir, entries[i])
        });
      }
    }
    out.sort(function (a, b) {
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    });
    return out;
  }

  /** Load and validate an API-format workflow graph. Throws with guidance. */
  function loadWorkflow(file) {
    ensureNode();
    var graph = JSON.parse(fs.readFileSync(file, "utf8"));
    if (graph && graph.nodes && graph.links) {
      throw new Error(
        path.basename(file) + " is a UI-format export. In ComfyUI use " +
        "'Export (API)' (enable Dev mode options) and save that JSON instead.");
    }
    var hasNode = false;
    for (var k in graph) {
      if (graph.hasOwnProperty(k) && graph[k] && graph[k].class_type) {
        hasNode = true;
        break;
      }
    }
    if (!hasNode) {
      throw new Error(path.basename(file) + " does not look like a ComfyUI " +
                      "API-format workflow (no class_type nodes).");
    }
    return graph;
  }

  // -------------------------------------------------------- param grafting

  var NEUTRAL_COND_INPUTS = {
    conditioning: true, conditioning_1: true, conditioning_2: true,
    conditioning_to: true, conditioning_from: true
  };

  function isTextEncode(node) {
    return !!(node && node.class_type &&
              node.class_type.indexOf("CLIPTextEncode") === 0);
  }

  /**
   * Polarity-aware upstream walk: seed from every node that has
   * positive/negative link inputs (samplers, ControlNet appliers, …) and
   * follow conditioning chains without ever crossing polarity, marking the
   * CLIPTextEncode* nodes each side reaches.
   */
  function classifyEncoders(graph) {
    var pos = {};
    var neg = {};

    function walk(id, polarity, visited) {
      if (!id || visited[id]) return;
      visited[id] = true;
      var node = graph[id];
      if (!node || !node.inputs) return;
      if (isTextEncode(node)) {
        (polarity === "neg" ? neg : pos)[id] = true;
        return;
      }
      for (var key in node.inputs) {
        if (!node.inputs.hasOwnProperty(key)) continue;
        var v = node.inputs[key];
        if (!(v instanceof Array) || v.length < 1) continue;
        if (key === "positive") {
          if (polarity === "pos") walk(String(v[0]), "pos", visited);
        } else if (key === "negative") {
          if (polarity === "neg") walk(String(v[0]), "neg", visited);
        } else if (NEUTRAL_COND_INPUTS[key]) {
          walk(String(v[0]), polarity, visited);
        }
      }
    }

    for (var k in graph) {
      if (!graph.hasOwnProperty(k)) continue;
      var node = graph[k];
      if (!node || !node.inputs) continue;
      if (node.inputs.positive instanceof Array) {
        walk(String(node.inputs.positive[0]), "pos", {});
      }
      if (node.inputs.negative instanceof Array) {
        walk(String(node.inputs.negative[0]), "neg", {});
      }
    }
    return { pos: pos, neg: neg };
  }

  /**
   * Write `text` into an encoder node. Handles the three real export shapes:
   * literal inputs.text, SDXL text_g/text_l, and a text widget converted to
   * an input link (followed one hop to a literal string source).
   * Returns a short description of what was set, or null if nothing could be.
   */
  function setEncoderText(graph, id, text) {
    var node = graph[id];
    if (!node || !node.inputs) return null;
    if (typeof node.inputs.text === "string") {
      node.inputs.text = text;
      return "node " + id;
    }
    if (typeof node.inputs.text_g === "string" ||
        typeof node.inputs.text_l === "string") {
      if (typeof node.inputs.text_g === "string") node.inputs.text_g = text;
      if (typeof node.inputs.text_l === "string") node.inputs.text_l = text;
      return "node " + id + " (sdxl g+l)";
    }
    if (node.inputs.text instanceof Array) {
      var up = graph[String(node.inputs.text[0])];
      if (up && up.inputs) {
        var stringKeys = [];
        var candidates = ["text", "string", "value"];
        for (var i = 0; i < candidates.length; i++) {
          if (typeof up.inputs[candidates[i]] === "string") {
            stringKeys.push(candidates[i]);
          }
        }
        // Only rewrite an unambiguous single-string source node; anything
        // fancier (concat/style/wildcard nodes) is left as authored.
        if (stringKeys.length === 1) {
          up.inputs[stringKeys[0]] = text;
          return "node " + String(node.inputs.text[0]) +
                 " (via link from node " + id + ")";
        }
      }
    }
    return null;
  }

  /**
   * Graft params onto the graph. Returns a list of what was changed so the
   * LLM (and user) can see how the template was used.
   * params: {prompt, negative, width, height, seed, frames}
   */
  function injectParams(graph, params) {
    var applied = [];
    var cls = classifyEncoders(graph);
    var k, node;

    for (k in graph) {
      if (!graph.hasOwnProperty(k)) continue;
      node = graph[k];
      if (!node || !node.inputs) continue;
      var title = (node._meta && node._meta.title ? node._meta.title : "");

      if (isTextEncode(node)) {
        var inPos = !!cls.pos[k];
        var inNeg = !!cls.neg[k];
        var polarity;
        if (inPos && inNeg) {
          // Reachable from both sides — refuse to guess.
          polarity = /neg/i.test(title) ? "neg" : null;
          if (!polarity) {
            applied.push("skipped ambiguous-polarity encoder node " + k);
          }
        } else if (inNeg) {
          polarity = "neg";
        } else if (inPos) {
          polarity = "pos";
        } else {
          // Unreachable from any sampler chain — fall back to the title.
          polarity = /neg/i.test(title) ? "neg" : "pos";
        }
        if (polarity === "neg" && typeof params.negative === "string") {
          var wn = setEncoderText(graph, k, params.negative);
          if (wn) applied.push("negative -> " + wn);
        } else if (polarity === "pos" && typeof params.prompt === "string") {
          var wp = setEncoderText(graph, k, params.prompt);
          if (wp) applied.push("prompt -> " + wp);
        }
      }

      // Size on latent/video source nodes.
      if (typeof node.inputs.width === "number" &&
          typeof node.inputs.height === "number") {
        if (params.width > 0) {
          node.inputs.width = Math.round(params.width);
          applied.push("width -> node " + k);
        }
        if (params.height > 0) {
          node.inputs.height = Math.round(params.height);
          applied.push("height -> node " + k);
        }
      }

      // Frame count for video workflows.
      if (params.frames > 0) {
        var frameKeys = ["length", "frames", "video_frames", "num_frames"];
        for (var fi = 0; fi < frameKeys.length; fi++) {
          if (typeof node.inputs[frameKeys[fi]] === "number") {
            node.inputs[frameKeys[fi]] = Math.round(params.frames);
            applied.push("frames(" + frameKeys[fi] + ") -> node " + k);
            break;
          }
        }
      }

      // Seed (randomized unless pinned) so repeat runs vary.
      var seedKeys = ["seed", "noise_seed"];
      for (var si = 0; si < seedKeys.length; si++) {
        if (typeof node.inputs[seedKeys[si]] === "number") {
          var seed = params.seed > 0 ? Math.round(params.seed)
            : Math.floor(Math.random() * 999999999999);
          node.inputs[seedKeys[si]] = seed;
          applied.push("seed(" + seedKeys[si] + ")=" + seed + " -> node " + k);
        }
      }
    }
    return applied;
  }

  // -------------------------------------------------------- error details

  /** Flatten ComfyUI's node_errors bag into a readable, capped string. */
  function describeNodeErrors(nodeErrors) {
    var parts = [];
    try {
      for (var nid in nodeErrors) {
        if (!nodeErrors.hasOwnProperty(nid)) continue;
        var ne = nodeErrors[nid];
        if (ne && ne.errors instanceof Array && ne.errors.length > 0) {
          for (var j = 0; j < ne.errors.length; j++) {
            var e = ne.errors[j];
            parts.push("node " + nid + " (" + (ne.class_type || "?") + "): " +
              (e.message || "error") + (e.details ? " — " + e.details : ""));
          }
        } else {
          parts.push("node " + nid);
        }
      }
    } catch (e2) { /* server-controlled shape — best effort */ }
    var text = parts.join("; ");
    return text.length > 600 ? text.slice(0, 600) + "…" : text;
  }

  // ------------------------------------------------------------ generation

  function collectOutputFiles(historyEntry) {
    var files = [];
    var outputs = historyEntry && historyEntry.outputs ? historyEntry.outputs : {};
    for (var nodeId in outputs) {
      if (!outputs.hasOwnProperty(nodeId)) continue;
      var bags = ["images", "gifs", "videos", "audio"];
      for (var b = 0; b < bags.length; b++) {
        var arr = outputs[nodeId][bags[b]];
        if (!(arr instanceof Array)) continue;
        for (var i = 0; i < arr.length; i++) {
          var f = arr[i];
          // temp previews aren't final outputs
          if (f && f.filename && f.type !== "temp") files.push(f);
        }
      }
    }
    return files;
  }

  /**
   * End-to-end generation.
   * opts: {comfyUrl, workflowFile, params, outDir, timeoutSec}
   * onProgress(secondsElapsed) fires periodically while waiting.
   * cb(err, {files: [absolute paths], applied: [...], promptId})
   * cb fires exactly once.
   */
  function generate(opts, onProgress, cb) {
    ensureNode();
    var base = parseBase(opts.comfyUrl);
    var graph, applied;
    try {
      graph = loadWorkflow(opts.workflowFile);
      applied = injectParams(graph, opts.params || {});
    } catch (e) {
      cb(e);
      return;
    }

    // A prompt that lands nowhere means the render would use the template's
    // baked-in text — fail fast instead of burning GPU minutes on it.
    if (opts.params && typeof opts.params.prompt === "string" &&
        opts.params.prompt !== "") {
      var landed = false;
      for (var ai = 0; ai < applied.length; ai++) {
        if (applied[ai].indexOf("prompt -> ") === 0) { landed = true; break; }
      }
      if (!landed) {
        cb(new Error("This workflow has no editable prompt text (its text " +
          "widget may be converted to a non-literal input). Un-convert it " +
          "in ComfyUI and re-export, or use another template."));
        return;
      }
    }

    var clientId = "aellama-" + Math.floor(Math.random() * 1e9);
    requestJson(base, "POST", "/prompt",
      { prompt: graph, client_id: clientId }, 30000,
      function (err, statusCode, json, rawText) {
        if (err) {
          cb(new Error("ComfyUI unreachable at " + base.label + " — " +
                       err.message));
          return;
        }
        if (statusCode !== 200 || !json || !json.prompt_id) {
          var detail = "";
          if (json && json.error && json.error.message) {
            detail = json.error.message;
            if (json.node_errors) {
              var nd = describeNodeErrors(json.node_errors);
              if (nd) detail += " [" + nd + "]";
            }
          } else {
            detail = (rawText || "").slice(0, 200);
          }
          cb(new Error("ComfyUI rejected the workflow: " + detail));
          return;
        }

        // Partial validation: valid branches queued, broken ones dropped.
        // Surface what was skipped alongside the eventual result.
        if (json.node_errors) {
          var skipped = describeNodeErrors(json.node_errors);
          if (skipped) applied.push("WARNING skipped branches: " + skipped);
        }

        var promptId = json.prompt_id;
        var startedAt = Date.now();
        var lastProgressAt = startedAt;
        var POLL_MS = 2000;
        var timeoutMs = (opts.timeoutSec > 0 ? opts.timeoutSec : 600) * 1000;

        // cb must fire exactly once, and no work may happen after settling —
        // in-flight /history responses can land after the timer is cleared.
        var finished = false;
        var inFlight = false;
        var timer = null;

        function settle(err2, res2) {
          if (finished) return;
          finished = true;
          if (timer) global.clearInterval(timer);
          cb(err2, res2);
        }

        timer = global.setInterval(function () {
          if (finished) return;
          var elapsed = Date.now() - startedAt;
          if (onProgress && Date.now() - lastProgressAt >= 10000) {
            lastProgressAt = Date.now();
            onProgress(Math.round(elapsed / 1000));
          }
          if (elapsed >= timeoutMs) {
            settle(new Error("Generation timed out after " +
                             Math.round(elapsed / 1000) + "s (prompt " +
                             promptId + " may still finish in ComfyUI)"));
            return;
          }
          if (inFlight) return;
          inFlight = true;
          requestJson(base, "GET", "/history/" + promptId, null, 10000,
            function (herr, hstatus, hjson) {
              inFlight = false;
              if (finished) return;
              if (herr || hstatus !== 200 || !hjson) return; // retry next tick
              var entry = hjson[promptId];
              if (!entry) return;                            // still queued/running
              var st = entry.status || {};
              if (st.status_str === "error") {
                var msg = "ComfyUI reported an execution error";
                try {
                  var msgs = st.messages || [];
                  for (var i = 0; i < msgs.length; i++) {
                    if (msgs[i][0] === "execution_interrupted") {
                      msg = "Generation was cancelled/interrupted in ComfyUI" +
                        (msgs[i][1] && msgs[i][1].node_type
                          ? " at node " + msgs[i][1].node_type : "");
                      break;
                    }
                    if (msgs[i][0] === "execution_error") {
                      msg += ": " + (msgs[i][1].exception_message || "");
                      break;
                    }
                  }
                } catch (e) {}
                settle(new Error(msg));
                return;
              }
              var files = collectOutputFiles(entry);
              if (files.length === 0 && !st.completed) return; // keep waiting
              if (files.length === 0) {
                settle(new Error("Workflow finished but produced no output " +
                                 "files (no SaveImage/SaveVideo node?)"));
                return;
              }
              // Terminal success path: latch BEFORE the downloads so a
              // straggler poll response can't start a second download chain.
              if (finished) return;
              finished = true;
              global.clearInterval(timer);
              try {
                if (!fs.existsSync(opts.outDir)) {
                  fs.mkdirSync(opts.outDir, { recursive: true });
                }
              } catch (e) {
                cb(new Error("Cannot create output folder " + opts.outDir +
                             ": " + e.message));
                return;
              }
              var saved = [];
              (function next(i) {
                if (i >= files.length) {
                  cb(null, { files: saved, applied: applied,
                             promptId: promptId });
                  return;
                }
                var f = files[i];
                var q = "/view?filename=" + encodeURIComponent(f.filename) +
                        "&subfolder=" + encodeURIComponent(f.subfolder || "") +
                        "&type=" + encodeURIComponent(f.type || "output");
                var dest = path.join(opts.outDir, f.filename);
                downloadFile(base, q, dest, function (derr, savedPath) {
                  if (derr) { cb(derr); return; }
                  saved.push(savedPath);
                  next(i + 1);
                });
              })(0);
            });
        }, POLL_MS);
      });
  }

  // ---------------------------------------------------------------- status

  function status(comfyUrl, cb) {
    var base = parseBase(comfyUrl);
    requestJson(base, "GET", "/queue", null, 5000,
      function (err, statusCode, json) {
        if (err || statusCode !== 200 || !json) {
          var hasHidden = false;
          try {
            hasHidden = !!(global.Setup && global.Setup.findComfyInstall &&
                           global.Setup.findComfyInstall());
          } catch (eH) {}
          cb(null, { online: false, url: comfyUrl, target: base.label,
                     hiddenBackendInstalled: hasHidden,
                     hint: hasHidden
                       ? "Hidden backend installed — it boots " +
                         "automatically on the next generation request."
                       : "Start ComfyUI (Launch button in settings, or " +
                         "manually), or install the hidden backend in " +
                         "Settings → ComfyUI (tried " + base.label + ")." });
          return;
        }
        var running = json.queue_running instanceof Array
          ? json.queue_running.length : 0;
        var pending = json.queue_pending instanceof Array
          ? json.queue_pending.length : 0;
        cb(null, { online: true, url: comfyUrl, target: base.label,
                   running: running, pending: pending });
      });
  }

  // ---------------------------------------------------------------- launch

  /**
   * Best-effort launch of a local ComfyUI install (definable folder).
   * Supports the Windows portable build (run_*.bat) and plain git checkouts
   * (main.py + python on PATH). Detached: ComfyUI outlives the panel.
   */
  function launch(comfyDir, cb) {
    ensureNode();
    if (!comfyDir) {
      cb(new Error("Set the ComfyUI install folder in settings first."));
      return;
    }
    if (!fs.existsSync(comfyDir)) {
      cb(new Error("ComfyUI folder not found: " + comfyDir));
      return;
    }

    function spawnDetached(cmd, args, cwd, useShell) {
      var child = child_process.spawn(cmd, args, {
        cwd: cwd,
        detached: true,
        shell: useShell,
        stdio: "ignore",
        windowsHide: false
      });
      child.unref();
    }

    var bats = ["run_nvidia_gpu.bat", "run_cpu.bat"];
    for (var i = 0; i < bats.length; i++) {
      var bat = path.join(comfyDir, bats[i]);
      if (fs.existsSync(bat)) {
        spawnDetached('"' + bat + '"', [], comfyDir, true);
        cb(null, "Launched " + bats[i] + " (portable build). Give it a " +
                 "moment, then Test connection.");
        return;
      }
    }

    var embeddedPy = path.join(comfyDir, "python_embeded", "python.exe");
    var portableMain = path.join(comfyDir, "ComfyUI", "main.py");
    if (fs.existsSync(embeddedPy) && fs.existsSync(portableMain)) {
      spawnDetached(embeddedPy,
        ["-s", portableMain, "--windows-standalone-build"], comfyDir, false);
      cb(null, "Launched portable ComfyUI via embedded Python.");
      return;
    }

    var mainPy = path.join(comfyDir, "main.py");
    if (fs.existsSync(mainPy)) {
      spawnDetached("python", ["main.py"], comfyDir, false);
      cb(null, "Launched 'python main.py' in " + comfyDir + ". If ComfyUI " +
               "uses a venv, start it manually instead and just set the URL.");
      return;
    }

    cb(new Error("No launcher found in " + comfyDir + " (looked for " +
                 "run_*.bat, python_embeded, main.py). Start ComfyUI " +
                 "manually — the panel only needs the URL."));
  }

  // ------------------------------------------- hidden managed backend
  // The panel talks to ComfyUI purely over HTTP, so the backend can run
  // completely invisibly: spawn the vendor portable build hidden on the
  // configured localhost port, health-poll it up, and reap it like the
  // llama-server (PID persisted across panel sessions).

  var COMFY_PID_KEY = "aell-comfy-pid";
  var managedProc = null;
  var startWaiters = null;   // non-null while a boot is in flight

  function rememberPid(pid) {
    try { global.localStorage.setItem(COMFY_PID_KEY, String(pid)); }
    catch (e) {}
  }
  function forgetPid() {
    try { global.localStorage.removeItem(COMFY_PID_KEY); } catch (e) {}
  }

  /** Kill a hidden backend left over from a previous panel session. */
  function reapOrphan(done) {
    ensureNode();
    var pid = null;
    try { pid = parseInt(global.localStorage.getItem(COMFY_PID_KEY), 10); }
    catch (e) {}
    if (!pid) { if (done) done(false); return; }
    // PIDs recycle — only kill if the process really is our backend
    // (its command line references ComfyUI's main.py).
    child_process.execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid +
       "').CommandLine"],
      { timeout: 15000 },
      function (err, stdout) {
        var isOurs = !err && /ComfyUI/i.test(String(stdout || ""));
        if (!isOurs) { forgetPid(); if (done) done(false); return; }
        child_process.execFile("taskkill",
          ["/PID", String(pid), "/T", "/F"], function () {
            forgetPid();
            if (done) done(true);
          });
      });
  }

  function isUp(base, cb) {
    requestJson(base, "GET", "/system_stats", null, 4000,
      function (err, statusCode) { cb(!err && statusCode === 200); });
  }

  /**
   * Point the hidden backend at the user's external models folder (they
   * get big) via ComfyUI's own extra_model_paths.yaml mechanism. The yaml
   * lives inside OUR vendor install, so it is safe to (re)write on every
   * boot; blank setting = the backend's built-in models folder only.
   */
  var COMFY_MODEL_SUBS = ["checkpoints", "diffusion_models", "text_encoders",
    "clip", "clip_vision", "vae", "loras", "controlnet", "upscale_models",
    "embeddings"];
  function applyExtraModelPaths(install) {
    ensureNode();
    var dir = "";
    try {
      dir = String((global.Settings.get() || {}).comfyModelsDir || "");
    } catch (e) {}
    var yamlPath = path.join(install.root, "ComfyUI",
                             "extra_model_paths.yaml");
    if (!dir) {
      // Setting cleared — remove a previously written mapping.
      try { if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath); }
      catch (eU) {}
      return null;
    }
    try {
      var i;
      for (i = 0; i < COMFY_MODEL_SUBS.length; i++) {
        var d = path.join(dir, COMFY_MODEL_SUBS[i]);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      }
      var lines = [
        "# Managed by AE Llama — external models folder (panel setting)",
        "aellama:",
        "  base_path: " + dir.replace(/\\/g, "/")
      ];
      for (i = 0; i < COMFY_MODEL_SUBS.length; i++) {
        lines.push("  " + COMFY_MODEL_SUBS[i] + ": " + COMFY_MODEL_SUBS[i]);
      }
      fs.writeFileSync(yamlPath, lines.join("\n") + "\n");
      return yamlPath;
    } catch (e2) {
      return null;
    }
  }

  /**
   * Make sure a ComfyUI answers at the configured URL. An already-running
   * instance (the user's own) is used as-is; otherwise the hidden vendor
   * install is booted invisibly on that port and health-polled up.
   */
  function ensureRunning(comfyUrl, onStatus, cb) {
    ensureNode();
    var base = parseBase(comfyUrl);
    function say(t) { if (onStatus) onStatus(t); }
    isUp(base, function (up) {
      if (up) { cb(null, { started: false }); return; }
      if (base.host !== "127.0.0.1" && base.host !== "localhost") {
        cb(new Error("ComfyUI at " + base.label + " is not responding, " +
          "and a remote instance cannot be auto-started. Start it there, " +
          "or point the URL at 127.0.0.1 to use the hidden backend."));
        return;
      }
      var install = global.Setup && global.Setup.findComfyInstall
        ? global.Setup.findComfyInstall() : null;
      if (!install) {
        cb(new Error("ComfyUI is not running and the hidden backend is " +
          "not installed. Install it in Settings → ComfyUI → 'Install " +
          "hidden backend', or launch your own ComfyUI."));
        return;
      }
      if (startWaiters) { startWaiters.push(cb); return; }
      startWaiters = [cb];
      applyExtraModelPaths(install);
      say("Starting the hidden ComfyUI backend…");
      var errTail = "";
      var proc;
      try {
        proc = child_process.spawn(install.python,
          ["-s", install.mainPy, "--windows-standalone-build",
           "--port", String(base.port), "--listen", "127.0.0.1",
           "--disable-auto-launch"],
          { cwd: install.root, windowsHide: true });
      } catch (eS) {
        var early = startWaiters;
        startWaiters = null;
        for (var w = 0; w < early.length; w++) early[w](eS);
        return;
      }
      managedProc = proc;
      rememberPid(proc.pid);
      function tail(d) {
        errTail = (errTail + d.toString()).slice(-600);
      }
      proc.stdout.on("data", tail);
      proc.stderr.on("data", tail);
      var settledBoot = false;
      function finishBoot(err) {
        if (settledBoot) return;
        settledBoot = true;
        var ws = startWaiters || [];
        startWaiters = null;
        for (var i = 0; i < ws.length; i++) {
          ws[i](err, err ? null : { started: true });
        }
      }
      proc.on("error", function (e) {
        managedProc = null;
        forgetPid();
        finishBoot(new Error("Backend failed to start: " + e.message));
      });
      proc.on("exit", function (code) {
        managedProc = null;
        forgetPid();
        finishBoot(new Error("Backend exited during startup (code " +
          code + ")" + (errTail ? " — " + errTail : "")));
      });
      // First boot can take a while (model scans, torch warm-up).
      var deadline = new Date().getTime() + 240000;
      (function poll() {
        if (settledBoot) return;
        isUp(base, function (nowUp) {
          if (settledBoot) return;
          if (nowUp) {
            say("Hidden ComfyUI backend is up.");
            finishBoot(null);
            return;
          }
          if (new Date().getTime() > deadline) {
            finishBoot(new Error("Backend did not come up within 4 " +
              "minutes" + (errTail ? " — " + errTail : "")));
            try { proc.kill(); } catch (eK) {}
            return;
          }
          global.setTimeout(poll, 2500);
        });
      })();
    });
  }

  /** Shut the hidden backend down (panel close frees its VRAM). */
  function stopManaged() {
    ensureNode();
    var pid = managedProc ? managedProc.pid : null;
    if (!pid) {
      try { pid = parseInt(global.localStorage.getItem(COMFY_PID_KEY), 10); }
      catch (e) {}
    }
    if (pid) {
      try {
        child_process.execFile("taskkill",
          ["/PID", String(pid), "/T", "/F"], function () {});
      } catch (e2) {}
    }
    managedProc = null;
    forgetPid();
  }

  global.Comfy = {
    listWorkflows: listWorkflows,
    loadWorkflow: loadWorkflow,
    injectParams: injectParams,
    generate: generate,
    status: status,
    launch: launch,
    ensureRunning: ensureRunning,
    stopManaged: stopManaged,
    reapOrphan: reapOrphan,
    _applyExtraModelPaths: applyExtraModelPaths   // exposed for tests
  };

})(window);
