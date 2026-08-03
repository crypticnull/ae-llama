/*
 * llama.js — manages the bundled llama-server child process and talks to its
 * OpenAI-compatible HTTP API. All HTTP goes through CEP's embedded Node.js
 * (no browser fetch), which avoids any CORS considerations entirely.
 */
(function (global) {
  "use strict";

  var child_process = null;
  var http = null;
  var fs = null;
  var path = null;
  var NodeBuffer = null;

  function ensureNode() {
    if (child_process) return;
    child_process = global.AEBridge.nodeRequire("child_process");
    http = global.AEBridge.nodeRequire("http");
    fs = global.AEBridge.nodeRequire("fs");
    path = global.AEBridge.nodeRequire("path");
    NodeBuffer = global.AEBridge.nodeRequire("buffer").Buffer;
  }

  // ---------------------------------------------------------------- state

  var proc = null;              // current child process, if any
  var state = "stopped";        // stopped | starting | running | error
  var currentModel = "";        // model path the running server was started with
  var healthTimer = null;
  var listeners = { status: [], log: [] };

  function emit(kind, a, b) {
    var subs = listeners[kind] || [];
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](a, b); } catch (e) { /* listener errors are not ours */ }
    }
  }

  function setState(next, detail) {
    state = next;
    emit("status", next, detail || "");
  }

  function clearHealthTimer() {
    if (healthTimer) {
      global.clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  // ------------------------------------------------------------ discovery

  /** Recursively collect *.gguf under dir (depth-limited). */
  function scanModels(dir) {
    ensureNode();
    var found = [];
    function walk(d, depth) {
      if (depth > 3) return;
      var entries;
      try { entries = fs.readdirSync(d); } catch (e) { return; }
      for (var i = 0; i < entries.length; i++) {
        var full = path.join(d, entries[i]);
        var st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (/\.gguf$/i.test(entries[i])) {
          found.push(full);
        }
      }
    }
    if (dir) walk(dir, 0);
    found.sort(function (a, b) {
      return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
    });
    return found;
  }

  /** Find llama-server.exe under the vendor folder if the default is stale. */
  function findServerExe(preferredPath) {
    ensureNode();
    if (preferredPath && fs.existsSync(preferredPath)) return preferredPath;
    var root = global.AEBridge.getExtensionPath();
    if (!root) return "";
    var vendor = path.join(root, "vendor");
    var hit = "";
    function walk(d, depth) {
      if (hit || depth > 4) return;
      var entries;
      try { entries = fs.readdirSync(d); } catch (e) { return; }
      for (var i = 0; i < entries.length && !hit; i++) {
        var full = path.join(d, entries[i]);
        var st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (entries[i].toLowerCase() === "llama-server.exe" ||
                   entries[i] === "llama-server") {
          hit = full;
        }
      }
    }
    walk(vendor, 0);
    return hit;
  }

  // ----------------------------------------------------------------- http

  function requestJson(method, port, urlPath, body, timeoutMs, cb) {
    ensureNode();
    var payload = body ? JSON.stringify(body) : null;
    var req = http.request({
      host: "127.0.0.1",
      port: port,
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
        try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ }
        cb(null, res.statusCode, json, text);
      });
    });
    req.on("error", function (err) { cb(err); });
    req.setTimeout(timeoutMs, function () {
      req.destroy(new Error("Request timed out after " + timeoutMs + " ms"));
    });
    if (payload) req.write(payload);
    req.end();
  }

  // --------------------------------------------------------------- server

  function startServer(opts, done) {
    ensureNode();
    var serverPath = findServerExe(opts.serverPath);
    if (!serverPath) {
      setState("error", "llama-server.exe not found — run scripts/get-llama.ps1");
      if (done) done(new Error("llama-server.exe not found"));
      return;
    }
    if (!opts.modelPath || !fs.existsSync(opts.modelPath)) {
      setState("error", "Model file not found: " + (opts.modelPath || "(none)"));
      if (done) done(new Error("model not found"));
      return;
    }

    stopServer();  // synchronous kill of any previous child

    var args = [
      "-m", opts.modelPath,
      "--host", "127.0.0.1",
      "--port", String(opts.port),
      "-c", String(opts.ctxSize),
      "-ngl", String(opts.gpuLayers)
    ];

    emit("log", "[panel] starting: " + serverPath + " " + args.join(" ") + "\n");
    setState("starting", "Loading model…");

    try {
      proc = child_process.spawn(serverPath, args, {
        cwd: path.dirname(serverPath),
        windowsHide: true
      });
    } catch (e) {
      proc = null;
      setState("error", "Failed to spawn llama-server: " + e.message);
      if (done) done(e);
      return;
    }

    currentModel = opts.modelPath;
    var thisProc = proc;

    proc.stdout.on("data", function (d) { emit("log", d.toString()); });
    proc.stderr.on("data", function (d) { emit("log", d.toString()); });

    proc.on("error", function (err) {
      if (thisProc !== proc) return;
      clearHealthTimer();
      proc = null;
      setState("error", "llama-server error: " + err.message);
    });

    proc.on("exit", function (code, signal) {
      if (thisProc !== proc) return;   // an old process exiting after restart
      clearHealthTimer();
      proc = null;
      if (state !== "stopped") {
        setState(code === 0 || signal ? "stopped" : "error",
                 code === 0 || signal ? "Server stopped"
                                      : "Server exited with code " + code);
      }
    });

    // Poll /health until the model finishes loading (can take minutes for
    // big models on slow disks), then report running.
    var waitedMs = 0;
    var POLL_MS = 1000;
    var TIMEOUT_MS = 300000;
    clearHealthTimer();
    healthTimer = global.setInterval(function () {
      if (thisProc !== proc) { clearHealthTimer(); return; }
      waitedMs += POLL_MS;
      requestJson("GET", opts.port, "/health", null, 2000,
        function (err, statusCode) {
          if (thisProc !== proc) return;
          if (!err && statusCode === 200) {
            clearHealthTimer();
            setState("running", "Ready");
            if (done) { done(null); done = null; }
          } else if (waitedMs >= TIMEOUT_MS) {
            clearHealthTimer();
            stopServer();
            setState("error", "Server did not become healthy in time");
            if (done) { done(new Error("health timeout")); done = null; }
          }
        });
    }, POLL_MS);
  }

  function stopServer() {
    clearHealthTimer();
    if (proc) {
      var p = proc;
      proc = null;               // detach before kill so 'exit' is ignored
      try { p.kill(); } catch (e) { /* already dead */ }
    }
    currentModel = "";
    setState("stopped", "Server stopped");
  }

  // ----------------------------------------------------------------- chat

  /**
   * One non-streaming chat completion constrained to `schema`.
   * cb(err, parsedObject, rawText)
   */
  function chat(opts, messages, schema, cb) {
    var body = {
      model: "default",
      messages: messages,
      temperature: opts.temperature,
      max_tokens: 2048,
      cache_prompt: true,
      response_format: {
        type: "json_schema",
        json_schema: { name: "ae_actions", schema: schema }
      }
    };

    function parseContent(json, rawText) {
      var content = null;
      try { content = json.choices[0].message.content; } catch (e) {}
      if (typeof content !== "string") {
        cb(new Error("Unexpected server response: " + rawText.slice(0, 300)));
        return;
      }
      var obj = null;
      try {
        obj = JSON.parse(content);
      } catch (e) {
        // Constrained decoding failed or was unsupported — salvage the first
        // JSON object in the text.
        var m = content.match(/\{[\s\S]*\}/);
        if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} }
      }
      if (!obj) {
        cb(new Error("Model returned unparseable output: " +
                     content.slice(0, 300)));
        return;
      }
      cb(null, obj, content);
    }

    requestJson("POST", opts.port, "/v1/chat/completions", body, 600000,
      function (err, statusCode, json, rawText) {
        if (err) { cb(err); return; }
        if (statusCode === 200 && json) { parseContent(json, rawText); return; }

        // Older llama-server builds may reject response_format json_schema.
        // Retry once without the constraint.
        if (statusCode >= 400 && body.response_format) {
          var relaxed = {
            model: body.model,
            messages: messages,
            temperature: opts.temperature,
            max_tokens: 2048,
            cache_prompt: true
          };
          requestJson("POST", opts.port, "/v1/chat/completions", relaxed,
            600000, function (err2, sc2, json2, rawText2) {
              if (err2) { cb(err2); return; }
              if (sc2 === 200 && json2) { parseContent(json2, rawText2); return; }
              cb(new Error("llama-server HTTP " + sc2 + ": " +
                           (rawText2 || "").slice(0, 300)));
            });
          return;
        }
        cb(new Error("llama-server HTTP " + statusCode + ": " +
                     (rawText || "").slice(0, 300)));
      });
  }

  // ------------------------------------------------------------------ api

  global.Llama = {
    scanModels: scanModels,
    findServerExe: findServerExe,
    start: startServer,
    stop: stopServer,
    chat: chat,
    getState: function () { return state; },
    getCurrentModel: function () { return currentModel; },
    isRunning: function () { return state === "running"; },
    on: function (kind, fn) {
      (listeners[kind] = listeners[kind] || []).push(fn);
    }
  };

})(window);
