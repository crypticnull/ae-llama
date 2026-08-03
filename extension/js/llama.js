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

  var PID_KEY = "com.cptk.aellama.serverPid";

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

  /** Find llama-server.exe under the vendor folders if the default is stale. */
  function findServerExe(preferredPath) {
    ensureNode();
    if (preferredPath && fs.existsSync(preferredPath)) return preferredPath;
    var roots = [];
    try {
      var dataRoot = global.Settings.dataRoot();
      if (dataRoot) roots.push(path.join(dataRoot, "vendor"));
    } catch (e) {}
    var ext = global.AEBridge.getExtensionPath();
    if (ext) roots.push(path.join(ext, "vendor"));   // pre-0.2 dev installs
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
    for (var r = 0; r < roots.length && !hit; r++) walk(roots[r], 0);
    return hit;
  }

  // ----------------------------------------------------------------- http

  function requestJson(method, port, urlPath, body, timeoutMs, cb) {
    ensureNode();
    // cb must fire exactly once even if the connection dies mid-body —
    // a dropped callback would wedge the panel's busy flag forever.
    var called = false;
    function once(err, statusCode, json, text) {
      if (called) return;
      called = true;
      cb(err, statusCode, json, text);
    }
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
      var ended = false;
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        ended = true;
        var text = NodeBuffer.concat(chunks).toString("utf8");
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ }
        once(null, res.statusCode, json, text);
      });
      res.on("error", function (err) { once(err); });
      res.on("close", function () {
        if (!ended) once(new Error("Connection closed before the response completed"));
      });
    });
    req.on("error", function (err) { once(err); });
    req.setTimeout(timeoutMs, function () {
      req.destroy(new Error("Request timed out after " + timeoutMs + " ms"));
    });
    if (payload) req.write(payload);
    req.end();
  }

  // -------------------------------------------------- orphan management

  // CEP panels don't reliably fire unload when closed, so a spawned
  // llama-server can outlive us (pinning RAM/VRAM and the port). We persist
  // the child's PID and reap it on the next panel session.

  function rememberPid(pid, serverPath) {
    try {
      global.localStorage.setItem(PID_KEY,
        JSON.stringify({ pid: pid, serverPath: serverPath }));
    } catch (e) {}
  }

  function forgetPid() {
    try { global.localStorage.removeItem(PID_KEY); } catch (e) {}
  }

  /** Kill a recorded llama-server from a previous session, if it survives. */
  function reapOrphan(done) {
    ensureNode();
    var rec = null;
    try { rec = JSON.parse(global.localStorage.getItem(PID_KEY)); } catch (e) {}
    if (!rec || !rec.pid) { if (done) done(false); return; }
    // Verify the PID still belongs to llama-server before killing anything —
    // PIDs get recycled.
    child_process.execFile("tasklist",
      ["/FI", "PID eq " + rec.pid, "/FO", "CSV", "/NH"],
      function (err, stdout) {
        var isOurs = !err && typeof stdout === "string" &&
                     /llama-server/i.test(stdout);
        if (!isOurs) { forgetPid(); if (done) done(false); return; }
        emit("log", "[panel] killing orphaned llama-server (pid " +
                    rec.pid + ") from a previous session\n");
        child_process.execFile("taskkill",
          ["/PID", String(rec.pid), "/T", "/F"],
          function () {
            forgetPid();
            if (done) done(true);
          });
      });
  }

  /**
   * Poll until nothing answers on the port (old server fully gone) so the
   * new child can bind. cb(err) — err set if the port never frees up.
   */
  function waitForPortFree(port, timeoutMs, cb) {
    var waited = 0;
    var STEP = 500;
    (function probe() {
      requestJson("GET", port, "/health", null, 1500,
        function (err) {
          if (err) { cb(null); return; }        // connection refused = free
          waited += STEP;
          if (waited >= timeoutMs) {
            cb(new Error("Port " + port + " is still in use — another " +
              "llama-server (or app) is running there. Stop it or change " +
              "the port in settings."));
            return;
          }
          global.setTimeout(probe, STEP);
        });
    })();
  }

  // --------------------------------------------------------------- server

  function startServer(opts, done) {
    ensureNode();
    // done(err) fires exactly once per start attempt, on every outcome.
    function finish(err) {
      if (done) { var d = done; done = null; d(err); }
    }

    var serverPath = findServerExe(opts.serverPath);
    if (!serverPath) {
      setState("error", "llama-server.exe not found — run scripts/get-llama.ps1");
      finish(new Error("llama-server.exe not found"));
      return;
    }
    if (!opts.modelPath || !fs.existsSync(opts.modelPath)) {
      setState("error", "Model file not found: " + (opts.modelPath || "(none)"));
      finish(new Error("model not found"));
      return;
    }

    setState("starting", "Preparing…");
    stopServer(true);          // ask any previous child to die
    reapOrphan(function () {   // kill a survivor from an earlier session
      // The old process releases the port asynchronously — spawning in the
      // same tick makes the new server intermittently fail to bind.
      waitForPortFree(opts.port, 8000, function (portErr) {
        if (portErr) {
          setState("error", portErr.message);
          finish(portErr);
          return;
        }
        spawnServer(serverPath, opts, finish);
      });
    });
  }

  function spawnServer(serverPath, opts, finish) {
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
      finish(e);
      return;
    }

    currentModel = opts.modelPath;
    var thisProc = proc;
    rememberPid(proc.pid, serverPath);

    proc.stdout.on("data", function (d) { emit("log", d.toString()); });
    proc.stderr.on("data", function (d) { emit("log", d.toString()); });

    proc.on("error", function (err) {
      if (thisProc !== proc) return;
      clearHealthTimer();
      proc = null;
      forgetPid();
      setState("error", "llama-server error: " + err.message);
      finish(err);
    });

    proc.on("exit", function (code, signal) {
      if (thisProc !== proc) return;   // an old process exiting after restart
      clearHealthTimer();
      proc = null;
      forgetPid();
      if (state !== "stopped") {
        var ok = code === 0 || !!signal;
        setState(ok ? "stopped" : "error",
                 ok ? "Server stopped" : "Server exited with code " + code);
      }
      finish(new Error("llama-server exited before becoming ready"));
    });

    // Poll /health until the model finishes loading (can take minutes for
    // big models on slow disks), then verify we're talking to OUR server
    // before reporting running.
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
            verifyServerIdentity(opts, function (identityErr) {
              if (thisProc !== proc) return;
              if (identityErr) {
                setState("error", identityErr.message);
                stopServer();
                finish(identityErr);
                return;
              }
              setState("running", "Ready");
              finish(null);
            });
          } else if (waitedMs >= TIMEOUT_MS) {
            clearHealthTimer();
            stopServer();
            setState("error", "Server did not become healthy in time");
            finish(new Error("health timeout"));
          }
        });
    }, POLL_MS);
  }

  /**
   * Confirm the healthy server on our port is the child we spawned with the
   * model we asked for — not a stale/foreign instance that owns the port.
   */
  function verifyServerIdentity(opts, cb) {
    requestJson("GET", opts.port, "/props", null, 5000,
      function (err, statusCode, json) {
        if (err || statusCode !== 200 || !json) {
          cb(null);   // /props unavailable on this build — best effort only
          return;
        }
        var reported = json.model_path ||
          (json["default_generation_settings"] &&
           json["default_generation_settings"].model) || "";
        if (!reported) { cb(null); return; }
        var want = String(opts.modelPath).split(/[\\\/]/).pop().toLowerCase();
        var got = String(reported).split(/[\\\/]/).pop().toLowerCase();
        if (got && want && got !== want) {
          cb(new Error("A different llama-server answered on port " +
            opts.port + " (serving '" + got + "', expected '" + want +
            "'). Kill it or change the port in settings."));
          return;
        }
        cb(null);
      });
  }

  function stopServer(keepStatus) {
    clearHealthTimer();
    if (proc) {
      var p = proc;
      proc = null;               // detach before kill so 'exit' is ignored
      try { p.kill(); } catch (e) { /* already dead */ }
      // proc.kill() from CEP on Windows can be unreliable — follow up with
      // taskkill on the recorded PID as belt and braces.
      try {
        child_process.execFile("taskkill",
          ["/PID", String(p.pid), "/T", "/F"], function () {});
      } catch (e) {}
      forgetPid();
    }
    currentModel = "";
    if (!keepStatus) setState("stopped", "Server stopped");
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
    stop: function () { stopServer(false); },
    reapOrphan: reapOrphan,
    chat: chat,
    getState: function () { return state; },
    getCurrentModel: function () { return currentModel; },
    isRunning: function () { return state === "running"; },
    on: function (kind, fn) {
      (listeners[kind] = listeners[kind] || []).push(fn);
    }
  };

})(window);
