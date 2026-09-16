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

  // LIFETIME, decided 2026-09-16 (WORKPLAN 17i): the server dies with the
  // PROCESS that spawned it, on purpose. spawnServer() passes no
  // `detached`, so libuv puts llama-server in the host process's Windows
  // job object and it is killed the moment that process exits - measured
  // 2026-09-09 for the same spawn in comfy.js; `unref()` does not change
  // it. Closing AE therefore frees the model's RAM/VRAM even when CEP never
  // fires `unload`. Nothing needs a llama-server that outlives the panel
  // (unlike `comfy-install.js --boot`), so there is no detach seam here.
  //
  // What the job object does NOT cover is a new PAGE in the SAME process:
  // the job lives as long as the process, not the JS context. A reload that
  // skips Llama.stop() (DevTools / Ctrl+R; reloadPanel() does call stop)
  // leaves a live server whose `proc` handle died with the old page, still
  // holding the port. That is the survivor reapOrphan() exists for: the PID
  // is persisted, and init reaps it. Whether CEF keeps the process across
  // location.reload() is reasoned, not measured (WORKPLAN 17i-a).

  function rememberPid(pid, serverPath) {
    try {
      global.localStorage.setItem(PID_KEY,
        JSON.stringify({ pid: pid, serverPath: serverPath }));
    } catch (e) {}
  }

  function forgetPid() {
    try { global.localStorage.removeItem(PID_KEY); } catch (e) {}
  }

  /** Kill a recorded llama-server left by an earlier page load, if it lives. */
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
                    rec.pid + ") left by an earlier load of this panel\n");
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
    reapOrphan(function () {   // kill a survivor from an earlier page load
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

  // KV CACHE (WORKPLAN §13b, NEXT UP 11c). q8_0 on both K and V halves the
  // cache at an accuracy chat-probe could not tell from f16 at 16K (11b-2),
  // so 32K costs what 16K cost before. HARD-CODED on purpose: q4_0 on the
  // KEY cache returns garbage from a server that loads healthy (measured
  // 2026-09-16), so no fallback could catch it; never make it a setting.
  // Flash attention is already auto-on (build 10240), and a bare `-fa`
  // takes a value there, so it is not passed.
  var KV_CACHE_TYPE = "q8_0";

  // What a build prints when it does not know the flags or the type; the
  // same shapes scripts/lib/kv-quant.js parseServerLog reads. Measured on
  // build 10240: `error: invalid argument: --cache-type-zz` and `error
  // while handling argument "-ctk": Unsupported cache type: bogus`, exit 1
  // before any load. A quantized V cache refused without flash attention
  // is reasoned, not measured. The line must NAME the cache, so a refusal
  // of some other argument is not answered by dropping ours.
  var KV_REJECT_RE = /(error: (?:invalid|unknown) argument[^\r\n]*|invalid value for[^\r\n]*|Unsupported cache type[^\r\n]*|[^\r\n]*quantized V cache[^\r\n]*requires[^\r\n]*|[^\r\n]*V cache quantization requires[^\r\n]*)/i;
  var KV_NAMED_RE = /-ctk|-ctv|cache.type|V cache/i;

  function kvRefusal(log) {
    var lines = String(log).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = KV_REJECT_RE.exec(lines[i]);
      if (m && KV_NAMED_RE.test(lines[i])) return m[1].trim();
    }
    return "";
  }

  function serverArgs(opts, plainKv) {
    var args = [
      "-m", opts.modelPath,
      "--host", "127.0.0.1",
      "--port", String(opts.port),
      "-c", String(opts.ctxSize),
      "-ngl", String(opts.gpuLayers)
    ];
    if (!plainKv) args.push("-ctk", KV_CACHE_TYPE, "-ctv", KV_CACHE_TYPE);
    return args;
  }

  function spawnServer(serverPath, opts, finish, plainKv) {
    var args = serverArgs(opts, plainKv);
    var bootLog = "";   // what the server said before it was ready

    emit("log", "[panel] starting: " + serverPath + " " + args.join(" ") + "\n");
    setState("starting", "Loading model…");

    try {
      // No `detached`: the job object must take the server down with AE.
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

    function onData(d) {
      var t = d.toString();
      if (state === "starting" && bootLog.length < 65536) bootLog += t;
      emit("log", t);
    }
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("error", function (err) {
      if (thisProc !== proc) return;
      clearHealthTimer();
      proc = null;
      forgetPid();
      setState("error", "llama-server error: " + err.message);
      finish(err);
    });

    function onGone(code, signal) {
      if (thisProc !== proc) return;   // an old process exiting after restart
      clearHealthTimer();
      proc = null;
      forgetPid();
      var rejected = !plainKv && state === "starting" && kvRefusal(bootLog);
      if (rejected) {
        emit("log", "[panel] this llama-server refused the " + KV_CACHE_TYPE +
          " KV cache (" + rejected + "); restarting it with the " +
          "default cache, which uses more VRAM per token of context\n");
        spawnServer(serverPath, opts, finish, true);
        return;
      }
      if (state !== "stopped") {
        var ok = code === 0 || !!signal;
        setState(ok ? "stopped" : "error",
                 ok ? "Server stopped" : "Server exited with code " + code);
      }
      finish(new Error("llama-server exited before becoming ready"));
    }

    proc.on("exit", function (code, signal) {
      // Node may fire 'exit' before the pipes drain, and a refusal is the
      // LAST thing the server writes. While a quantized start is loading,
      // decide on 'close', when every byte of the boot log is in.
      if (!plainKv && state === "starting" && thisProc === proc) {
        thisProc.once("close", function () { onGone(code, signal); });
        return;
      }
      onGone(code, signal);
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

  function parseModelContent(content, cb) {
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

  /**
   * One STREAMING chat completion constrained to `schema`.
   * onDelta(accumulatedText) fires as tokens arrive.
   * cb(err, parsedObject, rawText) — exactly once; a user cancel yields an
   * Error with .cancelled === true.
   * Returns a handle: { cancel: fn } — cancelling also frees the server slot
   * (llama-server aborts generation when the connection drops).
   */
  function chat(opts, messages, schema, onDelta, cb) {
    ensureNode();
    var body = {
      model: "default",
      messages: messages,
      temperature: opts.temperature,
      // Room for large-but-legit command batches; a reply that still hits
      // this cap arrives truncated and unparseable, and main.js answers
      // with a compact-retry round.
      max_tokens: 3072,
      cache_prompt: true,
      stream: true,
      response_format: {
        type: "json_schema",
        json_schema: { name: "ae_actions", schema: schema }
      }
    };

    var cancelled = false;
    var called = false;
    function once(err, obj, raw) {
      if (called) return;
      called = true;
      cb(err, obj, raw);
    }

    var payload = JSON.stringify(body);
    var req = http.request({
      host: "127.0.0.1",
      port: opts.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": NodeBuffer.byteLength(payload),
        "Accept": "text/event-stream"
      }
    }, function (res) {
      if (res.statusCode !== 200) {
        // Older llama-server builds may reject response_format/stream —
        // retry once, non-streaming and unconstrained.
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          if (cancelled) { deliverCancel(); return; }
          var relaxed = {
            model: body.model,
            messages: messages,
            temperature: opts.temperature,
            max_tokens: 3072,
            cache_prompt: true
          };
          requestJson("POST", opts.port, "/v1/chat/completions", relaxed,
            600000, function (err2, sc2, json2, rawText2) {
              if (err2) { once(err2); return; }
              var content = null;
              try { content = json2.choices[0].message.content; } catch (e) {}
              if (sc2 === 200 && typeof content === "string") {
                parseModelContent(content, once);
                return;
              }
              once(new Error("llama-server HTTP " + sc2 + ": " +
                             (rawText2 || "").slice(0, 300)));
            });
        });
        res.on("error", function () {});
        return;
      }

      var buffer = "";
      var content = "";
      var finished = false;

      function handleLine(line) {
        line = line.replace(/^\s+|\s+$/g, "");
        if (line.indexOf("data:") !== 0) return;
        var data = line.slice(5).replace(/^\s+/, "");
        if (data === "[DONE]") { finished = true; return; }
        var json = null;
        try { json = JSON.parse(data); } catch (e) { return; }
        var delta = null;
        try { delta = json.choices[0].delta.content; } catch (e) {}
        if (typeof delta === "string" && delta) {
          content += delta;
          if (onDelta) {
            try { onDelta(content); } catch (e) {}
          }
        }
      }

      res.on("data", function (c) {
        buffer += c.toString("utf8");
        var idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      });
      res.on("end", function () {
        if (buffer) handleLine(buffer);
        if (cancelled) { deliverCancel(); return; }
        if (!content) {
          once(new Error(finished ? "Model returned an empty response"
                                  : "Stream ended unexpectedly"));
          return;
        }
        parseModelContent(content, once);
      });
      res.on("error", function (err) {
        if (cancelled) { deliverCancel(); return; }
        once(err);
      });
    });

    function deliverCancel() {
      var e = new Error("Cancelled");
      e.cancelled = true;
      once(e);
    }

    req.on("error", function (err) {
      if (cancelled) { deliverCancel(); return; }
      once(err);
    });
    req.setTimeout(600000, function () {
      req.destroy(new Error("Chat request timed out"));
    });
    req.write(payload);
    req.end();

    return {
      cancel: function () {
        if (called) return;
        cancelled = true;
        try { req.destroy(); } catch (e) {}
        deliverCancel();
      }
    };
  }

  // ------------------------------------------------------------------ api

  global.Llama = {
    scanModels: scanModels,
    findServerExe: findServerExe,
    start: startServer,
    stop: function () { stopServer(false); },
    reapOrphan: reapOrphan,
    serverArgs: serverArgs,
    kvRefusal: kvRefusal,
    chat: chat,
    getState: function () { return state; },
    getCurrentModel: function () { return currentModel; },
    isRunning: function () { return state === "running"; },
    on: function (kind, fn) {
      (listeners[kind] = listeners[kind] || []).push(fn);
    }
  };

})(window);
