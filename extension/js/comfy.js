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
    var u;
    try {
      u = new URL(comfyUrl);
    } catch (e) {
      u = new URL("http://127.0.0.1:8188");
    }
    return {
      isHttps: u.protocol === "https:",
      host: u.hostname || "127.0.0.1",
      port: u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 8188)
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

  /**
   * Graft params onto the graph. Returns a list of what was changed so the
   * LLM (and user) can see how the template was used.
   * params: {prompt, negative, width, height, seed, frames}
   */
  function injectParams(graph, params) {
    var applied = [];
    var k, node;

    // Positive/negative text: follow sampler links when possible.
    var positiveIds = {};
    var negativeIds = {};
    for (k in graph) {
      if (!graph.hasOwnProperty(k)) continue;
      node = graph[k];
      if (!node || !node.inputs) continue;
      var pos = node.inputs.positive;
      var neg = node.inputs.negative;
      if (pos && pos instanceof Array) positiveIds[String(pos[0])] = true;
      if (neg && neg instanceof Array) negativeIds[String(neg[0])] = true;
    }

    for (k in graph) {
      if (!graph.hasOwnProperty(k)) continue;
      node = graph[k];
      if (!node || !node.inputs) continue;
      var isTextEncode = node.class_type &&
        node.class_type.indexOf("CLIPTextEncode") === 0 &&
        typeof node.inputs.text === "string";
      var title = (node._meta && node._meta.title ? node._meta.title : "");

      if (isTextEncode) {
        var isNegative = negativeIds[k] ||
          (!positiveIds[k] && /neg/i.test(title));
        if (isNegative && typeof params.negative === "string") {
          node.inputs.text = params.negative;
          applied.push("negative -> node " + k);
        } else if (!isNegative && typeof params.prompt === "string") {
          node.inputs.text = params.prompt;
          applied.push("prompt -> node " + k);
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

    var clientId = "aellama-" + Math.floor(Math.random() * 1e9);
    requestJson(base, "POST", "/prompt",
      { prompt: graph, client_id: clientId }, 30000,
      function (err, statusCode, json, rawText) {
        if (err) {
          cb(new Error("ComfyUI unreachable at " + opts.comfyUrl + " — " +
                       err.message));
          return;
        }
        if (statusCode !== 200 || !json || !json.prompt_id) {
          var detail = "";
          if (json && json.error && json.error.message) {
            detail = json.error.message;
            if (json.node_errors) {
              for (var nid in json.node_errors) {
                if (json.node_errors.hasOwnProperty(nid)) {
                  detail += " [node " + nid + "]";
                  break;
                }
              }
            }
          } else {
            detail = (rawText || "").slice(0, 200);
          }
          cb(new Error("ComfyUI rejected the workflow: " + detail));
          return;
        }

        var promptId = json.prompt_id;
        var waitedMs = 0;
        var POLL_MS = 2000;
        var timeoutMs = (opts.timeoutSec > 0 ? opts.timeoutSec : 600) * 1000;

        var timer = global.setInterval(function () {
          waitedMs += POLL_MS;
          if (onProgress && waitedMs % 10000 === 0) {
            onProgress(Math.round(waitedMs / 1000));
          }
          if (waitedMs >= timeoutMs) {
            global.clearInterval(timer);
            cb(new Error("Generation timed out after " +
                         Math.round(timeoutMs / 1000) + "s (prompt " +
                         promptId + " may still finish in ComfyUI)"));
            return;
          }
          requestJson(base, "GET", "/history/" + promptId, null, 10000,
            function (herr, hstatus, hjson) {
              if (herr || hstatus !== 200 || !hjson) return; // retry next tick
              var entry = hjson[promptId];
              if (!entry) return;                            // still queued/running
              var st = entry.status || {};
              if (st.status_str === "error") {
                global.clearInterval(timer);
                var msg = "ComfyUI reported an execution error";
                try {
                  var msgs = st.messages || [];
                  for (var i = 0; i < msgs.length; i++) {
                    if (msgs[i][0] === "execution_error") {
                      msg += ": " + (msgs[i][1].exception_message || "");
                      break;
                    }
                  }
                } catch (e) {}
                cb(new Error(msg));
                return;
              }
              var files = collectOutputFiles(entry);
              if (files.length === 0 && !st.completed) return; // keep waiting
              global.clearInterval(timer);
              if (files.length === 0) {
                cb(new Error("Workflow finished but produced no output " +
                             "files (no SaveImage/SaveVideo node?)"));
                return;
              }
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
          cb(null, { online: false, url: comfyUrl,
                     hint: "Start ComfyUI (Launch button in settings, or " +
                           "manually) and check the URL." });
          return;
        }
        var running = json.queue_running instanceof Array
          ? json.queue_running.length : 0;
        var pending = json.queue_pending instanceof Array
          ? json.queue_pending.length : 0;
        cb(null, { online: true, url: comfyUrl,
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

  global.Comfy = {
    listWorkflows: listWorkflows,
    loadWorkflow: loadWorkflow,
    injectParams: injectParams,
    generate: generate,
    status: status,
    launch: launch
  };

})(window);
