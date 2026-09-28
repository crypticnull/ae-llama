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

  // ------------------------------------------------- which backend, and where
  //
  // The panel talks to ONE of two things and the user chooses which:
  // the MANAGED portable install it boots itself (default), or their
  // OWN ComfyUI at comfyUrl. Everything downstream — status, generate,
  // missingWeights, freeVram, the arbiter — asks backendUrl() rather
  // than reading comfyUrl, so the mode is decided in one place.
  //
  // Managed owns a port outside LOCAL_COMFY_PORTS and never consults
  // comfyUrl, because the old default WAS comfyUrl and it pointed at
  // ComfyUI's own port: a user who already ran ComfyUI silently became
  // a bring-your-own user, and the panel then priced jobs and checked
  // weights against a model set it does not manage.
  var MANAGED_PORT = 8288;

  /** "managed" | "own". Absent = "own": a caller handing us an explicit
   *  URL predates the setting and means the instance at that URL. */
  function backendMode(settings) {
    var s = settings;
    if (!s) {
      try { s = global.Settings.get() || {}; } catch (e) { s = {}; }
    }
    return s.comfyBackend === "managed" ? "managed" : "own";
  }

  /** The port the managed backend owns, defaulted and range-checked. */
  function managedPort(settings) {
    var s = settings || {};
    var p = parseInt(s.comfyManagedPort, 10);
    return (p > 0 && p < 65536) ? p : MANAGED_PORT;
  }

  /** The URL every caller should use. Never read comfyUrl directly. */
  function backendUrl(settings) {
    var s = settings;
    if (!s) {
      try { s = global.Settings.get() || {}; } catch (e) { s = {}; }
    }
    if (backendMode(s) === "own") return s.comfyUrl || "";
    return "http://127.0.0.1:" + managedPort(s);
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

  // ------------------------------------------------- progress over /ws
  /*
   * How far along a generation is exists on exactly ONE channel: the
   * websocket at /ws. Measured on the managed vendor build 2026-09-09 —
   * /history is EMPTY until the job finishes, /queue says only "running",
   * and /api/jobs (the newest route, and the one that sounds like it
   * should) serialises status and outputs with no value/max anywhere. So
   * without this the panel can report elapsed seconds and nothing else,
   * and a 15-minute render is indistinguishable from a hang.
   *
   * Node has no WebSocket global (CEP's is 17.7.2; the browser one landed
   * in Node 21), and reaching for a package would put a dependency in a
   * panel that has none. RFC 6455 over the http Upgrade this file already
   * has a client for is ~80 lines and runs identically in the panel and in
   * a headless probe, which is what makes it testable without AE.
   *
   * Everything here is BEST EFFORT and must stay that way: a refused
   * handshake, a build that never sends progress_state, a frame shape we
   * do not know — every one of them leaves the caller with the elapsed
   * seconds it already had. Progress must never be able to fail a render.
   */

  function wsClientKey() {
    var raw = "";
    for (var i = 0; i < 16; i++) {
      raw += String.fromCharCode(Math.floor(Math.random() * 256));
    }
    return NodeBuffer.from(raw, "binary").toString("base64");
  }

  /**
   * Read ONE frame off the head of buf. Returns null when the buffer does
   * not yet hold a whole frame — the caller keeps the bytes and retries on
   * the next chunk. `size` is how much of buf the frame consumed.
   */
  function wsReadFrame(buf) {
    if (buf.length < 2) return null;
    var b0 = buf[0], b1 = buf[1];
    var masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f;
    var off = 2;
    if (len === 126) {
      if (buf.length < off + 2) return null;
      len = buf.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) return null;
      // A >4 GB frame cannot happen here, but the high word still has to be
      // read or the payload offset is wrong.
      len = buf.readUInt32BE(off) * 4294967296 + buf.readUInt32BE(off + 4);
      off += 8;
    }
    var maskKey = null;
    if (masked) {
      if (buf.length < off + 4) return null;
      maskKey = buf.slice(off, off + 4); off += 4;
    }
    if (buf.length < off + len) return null;
    var payload = buf.slice(off, off + len);
    if (maskKey) {
      payload = NodeBuffer.from(payload);
      for (var i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    return { fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f,
             payload: payload, size: off + len };
  }

  /** Client -> server frames MUST be masked (RFC 6455 5.3). */
  function wsWriteFrame(socket, opcode, payload) {
    var body = payload || NodeBuffer.alloc(0);
    var len = body.length;
    var header;
    if (len < 126) {
      header = NodeBuffer.alloc(2); header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = NodeBuffer.alloc(4); header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = NodeBuffer.alloc(10); header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;
    var mask = NodeBuffer.alloc(4);
    for (var i = 0; i < 4; i++) mask[i] = Math.floor(Math.random() * 256);
    var out = NodeBuffer.from(body);
    for (var j = 0; j < out.length; j++) out[j] ^= mask[j % 4];
    try { socket.write(NodeBuffer.concat([header, mask, out])); } catch (e) {}
  }

  /**
   * Subscribe to ComfyUI's event stream as `clientId`. onMessage receives
   * every decoded TEXT event ({type, data}); binary frames (preview images)
   * are parsed past and dropped. Returns {close}. Never throws.
   */
  function openEventSocket(base, clientId, onMessage) {
    ensureNode();
    var handle = { close: closeIt, opened: false };
    var closed = false;
    var sock = null;

    function closeIt() {
      closed = true;
      if (sock) {
        // A close FRAME first, so the backend logs a client that left
        // rather than a connection that broke.
        try { wsWriteFrame(sock, 0x8, NodeBuffer.alloc(0)); } catch (e) {}
        try { sock.destroy(); } catch (e2) {}
        sock = null;
      }
    }

    var mod = base.isHttps ? https : http;
    var req;
    try {
      req = mod.request({
        host: base.host,
        port: base.port,
        path: "/ws?clientId=" + encodeURIComponent(String(clientId)),
        method: "GET",
        headers: {
          "Connection": "Upgrade",
          "Upgrade": "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": wsClientKey()
        }
      });
    } catch (e) { return handle; }

    // A backend that answers HTTP but refuses the upgrade replies normally
    // instead of emitting "upgrade". Drain it and stay silent.
    req.on("response", function (res) { res.resume(); });
    req.on("error", function () {});
    req.on("upgrade", function (res, socket, head) {
      if (closed) { try { socket.destroy(); } catch (e) {} return; }
      sock = socket;
      handle.opened = true;
      socket.on("error", function () { closeIt(); });
      socket.on("close", function () { sock = null; });
      // `head` is not an optional nicety: ComfyUI sends its first event the
      // instant the socket is up, so those bytes routinely arrive in the
      // SAME TCP segment as the 101 and Node hands them over here rather
      // than through "data". Dropping them loses whole frames and, worse,
      // leaves the reader mid-frame for everything after.
      var buf = (head && head.length) ? NodeBuffer.from(head) : NodeBuffer.alloc(0);
      var fragOp = 0;
      var fragParts = null;
      function pump(chunk) {
        if (closed) return;
        if (chunk && chunk.length) buf = NodeBuffer.concat([buf, chunk]);
        for (;;) {
          var f = wsReadFrame(buf);
          if (!f) break;
          buf = buf.slice(f.size);
          if (f.opcode === 0x8) { closeIt(); return; }   // close
          if (f.opcode === 0x9) {                        // ping -> pong
            wsWriteFrame(socket, 0xA, f.payload); continue;
          }
          if (f.opcode === 0xA) continue;                // pong
          var op = f.opcode;
          var body = f.payload;
          if (op === 0x0) {                              // continuation
            if (!fragParts) continue;
            fragParts.push(body);
            if (!f.fin) continue;
            op = fragOp;
            body = NodeBuffer.concat(fragParts);
            fragParts = null;
          } else if (!f.fin) {
            fragOp = op; fragParts = [body]; continue;
          }
          if (op !== 0x1) continue;                      // binary preview
          var msg = null;
          try { msg = JSON.parse(body.toString("utf8")); } catch (e) {}
          if (msg) { try { onMessage(msg); } catch (e2) {} }
        }
      }
      socket.on("data", pump);
      pump(null);   // whatever arrived alongside the 101
    });
    try { req.end(); } catch (e3) {}
    return handle;
  }

  /**
   * Turns ComfyUI's event stream into the one thing a waiting user needs:
   * step k of N for the node that is running, and how long the rest of it
   * should take.
   *
   * The projection is deliberately NOT elapsed/value. Elapsed includes
   * model loading, which on the video templates here is most of a minute
   * before the first step — dividing by it would quote an ETA far past the
   * truth on exactly the renders that need one. It is anchored on the
   * first step actually seen, so the rate quoted is the sampling rate.
   *
   * And never below step 1. The bar reports 0 when the sampler node
   * starts, and weights staged for dynamic VRAM loading stream in during
   * the FIRST forward pass, so step 0->1 is load time too. Observed
   * 2026-09-17 (WORKPLAN NEXT UP 37): H3 at 1920x1072 read "about 10m
   * left" at step 2 of a ~20 s/step render (~6m true), and the timeout
   * warning fired on a job that then finished 160 s inside it.
   */
  function makeProgressTracker(promptId) {
    var wantId = promptId || null;
    var node = null, value = 0, max = 0;
    var anchorAt = 0, anchorValue = 0;

    function retarget(id, v, m) {
      node = id; max = m; value = v;
      anchorAt = Date.now(); anchorValue = v;
    }

    function advance(v) {
      // A node that restarts its bar (a second pass on the same node id, at
      // the same step count) must not project from a rate measured across
      // the reset — the comparison is against the LAST value, not the
      // anchor, or a bar that resets to above where it was anchored keeps
      // quoting the old rate.
      if (v < value || (anchorValue < 1 && v >= 1)) {
        anchorAt = Date.now(); anchorValue = v;
      }
      value = v;
    }

    return {
      /* The socket is opened before the POST that names the prompt, so
       * the id it filters on arrives a moment later. */
      setPromptId: function (id) { wantId = id || null; },
      accept: function (msg) {
        if (!msg || typeof msg !== "object") return;
        var d = msg.data || {};
        if (msg.type === "progress_state") {
          if (wantId && d.prompt_id && d.prompt_id !== wantId) return;
          var nodes = d.nodes || {};
          // The sampler is the node with the most steps to run. A build
          // that reports several at once (VAE tiles, an upscaler) would
          // otherwise flip the fraction between them message by message.
          var bestId = null, best = null;
          for (var k in nodes) {
            if (!nodes.hasOwnProperty(k)) continue;
            var n = nodes[k] || {};
            if (n.state !== "running") continue;
            if (!(n.max > 1)) continue;
            if (!best || n.max > best.max) { best = n; bestId = k; }
          }
          if (!best) return;
          if (bestId !== node || best.max !== max) {
            retarget(bestId, best.value || 0, best.max);
          } else {
            advance(best.value || 0);
          }
          return;
        }
        if (msg.type === "progress") {              // older builds
          if (wantId && d.prompt_id && d.prompt_id !== wantId) return;
          if (!(d.max > 1)) return;
          var id = String(d.node);
          if (id !== node || d.max !== max) retarget(id, d.value || 0, d.max);
          else advance(d.value || 0);
        }
      },
      /** {value, max, node, etaSec} or null before anything has reported. */
      read: function () {
        if (!(max > 1)) return null;
        var out = { value: value, max: max, node: node, etaSec: 0 };
        var done = value - anchorValue;
        if (done > 0 && value < max) {
          var per = (Date.now() - anchorAt) / done;
          out.etaSec = Math.round(per * (max - value) / 1000);
        }
        return out;
      }
    };
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

  /* ComfyUI stores an upload under the CLIENT-sent name, and this panel
   * posts overwrite=true — so two different source files sharing a basename
   * (AE frame grabs are all "grab NNNN.png"-shaped) replace each other in
   * ComfyUI's input dir, and a prior job still sitting in the queue then
   * renders the LATER file. Every upload therefore gets a name unique to
   * the call: the run id separates two panel processes, the counter orders
   * calls within one. Deliberately no timestamp — batched uploads land in
   * the same millisecond routinely, which is exactly when uniqueness is
   * needed most. */
  var uploadRunId = Math.floor(Math.random() * 1679616).toString(36);
  var uploadSeq = 0;

  /**
   * Upload a local file into ComfyUI's input folder so a LoadImage node can
   * name it. LoadImage takes a FILENAME inside ComfyUI's own input dir, never
   * a path, so an AE-side render can only reach the graph this way.
   * The name handed to cb is the one the SERVER says it stored — ComfyUI may
   * place it in a subfolder — and it is the only name the graph may use.
   * cb(err, nameForLoadImage)
   */
  function uploadImage(base, filePath, cb) {
    ensureNode();
    var data;
    try {
      data = fs.readFileSync(filePath);
    } catch (e) {
      cb(new Error("Cannot read image '" + filePath + "' — " + e.message));
      return;
    }
    // A quote, backslash or newline in the name would break the multipart
    // header apart; ComfyUI stores whatever name we send, so sanitise here.
    // The per-call prefix goes in FRONT so the extension keeps deciding how
    // ComfyUI decodes the file.
    uploadSeq++;
    var name = "aell-" + uploadRunId + "-" + uploadSeq + "_" +
               String(path.basename(filePath)).replace(/["\\\r\n]/g, "_");
    var boundary = "----aellama" + Math.floor(Math.random() * 1e12);
    var CRLF = "\r\n";
    var head = NodeBuffer.from(
      "--" + boundary + CRLF +
      'Content-Disposition: form-data; name="image"; filename="' +
      name + '"' + CRLF +
      "Content-Type: application/octet-stream" + CRLF + CRLF, "utf8");
    var tail = NodeBuffer.from(
      CRLF + "--" + boundary + CRLF +
      'Content-Disposition: form-data; name="overwrite"' + CRLF + CRLF +
      "true" + CRLF +
      "--" + boundary + "--" + CRLF, "utf8");
    var payload = NodeBuffer.concat([head, data, tail]);
    var mod = base.isHttps ? https : http;
    var req = mod.request({
      host: base.host, port: base.port, path: "/upload/image", method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": payload.length
      }
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var text = NodeBuffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          cb(new Error("ComfyUI rejected the image upload (HTTP " +
                       res.statusCode + "): " + text.slice(0, 200)));
          return;
        }
        var json = null;
        try { json = JSON.parse(text); } catch (e2) {}
        if (!json || !json.name) {
          cb(new Error("ComfyUI's upload reply carried no filename: " +
                       text.slice(0, 200)));
          return;
        }
        cb(null, (json.subfolder ? json.subfolder + "/" : "") + json.name);
      });
    });
    req.on("error", function (err) {
      cb(new Error("ComfyUI unreachable at " + base.label + " — " +
                   err.message));
    });
    req.setTimeout(120000, function () {
      req.destroy(new Error("Image upload timed out"));
    });
    req.write(payload);
    req.end();
  }

  // ------------------------------------------------------------- workflows

  /** List *.json workflow templates in dir (non-recursive). */
  /* The optional sidecar next to a workflow: <name>.manifest.json.
   * Carries the enhancer instruction and dependency lists for bundled
   * workflows; a user-added workflow without one simply returns null. */
  function readManifest(workflowFile) {
    ensureNode();
    try {
      var mf = String(workflowFile).replace(/\.json$/i, ".manifest.json");
      return JSON.parse(fs.readFileSync(mf, "utf8"));
    } catch (e) { return null; }
  }

  function listWorkflows(dir) {
    ensureNode();
    var out = [];
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return out; }
    for (var i = 0; i < entries.length; i++) {
      // A sidecar is not a workflow. Listing it would offer the model a
      // "<name>.manifest" template that loadWorkflow can only reject.
      if (/\.manifest\.json$/i.test(entries[i])) continue;
      // Neither is a DOTFILE. The bundle carries .hash-history.json (the
      // seeder's record of every version ever shipped, 0.10.1), and a
      // leading dot sorts FIRST — so anything pointed at the bundled
      // directory got ".hash-history" offered to the model as a template
      // and, because the default is simply list[0], generating without
      // naming a workflow ran the record file as a graph. Measured
      // 2026-08-30 against extension/comfy-workflows.
      if (entries[i].charAt(0) === ".") continue;
      if (/\.json$/i.test(entries[i])) {
        var file = path.join(dir, entries[i]);
        // A template that still holds this project's own placeholder
        // cannot render anything — example-txt2img ships with
        // ckpt_name "CHANGE-ME.safetensors". Offering it next to the
        // real ones is how the model ends up choosing it: it is the one
        // whose NAME says txt2img, so a request for a picture lands on
        // it and dies inside ComfyUI's validator (measured through
        // chat-probe, 2026-08-28). Flagged here; the tools decide.
        var isExample = false;
        try {
          isExample = fs.readFileSync(file, "utf8").indexOf("CHANGE-ME") !== -1;
        } catch (eR) {}
        out.push({
          name: entries[i].replace(/\.json$/i, ""),
          file: file,
          example: isExample
        });
      }
    }
    out.sort(function (a, b) {
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    });
    return out;
  }

  /**
   * Everything the panel knows about the templates in `dir`, from the
   * files plus their manifest sidecars. ONE describer, so the nameless
   * default, the Settings rows and (later) the compound tools all read
   * the same facts instead of each deriving their own.
   *
   * Pure over the filesystem, so it is stub-testable — which matters
   * because main.js has no executed coverage and the Settings rows are
   * built from this.
   *
   *   kind          "image" | "video" | undefined
   *   catalogEntry  the COMFY_CATALOG.name this graph renders, or undefined
   *   takesImage    the manifest declares procedural.firstFrame at all
   *   requiresImage ...and it is NOT detachable, so the graph cannot run
   *                 without one (a true i2v/img2img template)
   *   lengthIn      "seconds" when the manifest carries
   *                 procedural.durationSeconds, else "frames"
   *
   * A template with NO manifest is described with everything undefined.
   * That is deliberate and the README promises it: a user's own API
   * export "works as-is", so it must stay a candidate rather than be
   * refused for lacking a sidecar it was never asked to have.
   */
  function describeWorkflows(dir) {
    var out = [];
    var all = listWorkflows(dir);
    for (var i = 0; i < all.length; i++) {
      var mf = readManifest(all[i].file);
      var proc = (mf && mf.procedural) || {};
      var ff = proc.firstFrame;
      out.push({
        name: all[i].name,
        file: all[i].file,
        example: !!all[i].example,
        kind: mf && (mf.kind === "image" || mf.kind === "video")
          ? mf.kind : undefined,
        catalogEntry: mf && mf.catalogEntry ? mf.catalogEntry : undefined,
        takesImage: !!ff,
        requiresImage: !!(ff && !ff.detachable),
        lengthIn: proc.durationSeconds ? "seconds" : "frames"
      });
    }
    return out;
  }

  /**
   * WHICH template a generation runs when the model named none.
   *
   * It used to be `list[0]` — the alphabet. With the shipped bundle that
   * means "a picture of a red apple" is handed to AE_LLAMA_H3_I2V_V1,
   * a 40 GB Blackwell-only VIDEO graph, because ae_llama_h3 sorts before
   * ae_llama_krea2. The regression test pinned that outcome as correct
   * because nothing better existed.
   *
   * Pure: every input is passed in, nothing is read from globals, so the
   * whole matrix is stub-testable with no ComfyUI and no GPU.
   *
   *   descs   describeWorkflows() output
   *   want    {kind, image, disabled}  - disabled is settings.comfyWorkflows
   *   ctx     Tiers.resolveTier() output {vramGB, arch} or null
   *   catalog COMFY_CATALOG (for entryFits/weights), or null
   *   opts    {fits, weightsPresent, baseline} - injected so this file
   *           does not reach into tiers.js or tools.js
   *
   * Returns {chosen, why, candidates} or {chosen: null, why} - never
   * throws, because the caller turns `why` into a grounded refusal.
   */
  function resolveWorkflow(descs, want, ctx, opts) {
    want = want || {};
    opts = opts || {};
    var disabled = want.disabled || {};
    var wantKind = want.kind === "video" ? "video" : "image";

    // Count WHY each one dropped out. A refusal that names the wrong
    // cause sends the user to the wrong setting, and this is the only
    // place that knows the difference between "you turned them all off",
    // "they all need an image" and "there is nothing installed".
    var pool = [], dropped = { example: 0, disabled: 0, needsImage: 0 };
    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      if (d.example) { dropped.example++; continue; }   // never renders
      var off = disabled[d.name];
      if (off && off.enabled === false) { dropped.disabled++; continue; }
      // A template that REQUIRES an image cannot run without one. The
      // detach primitive can DELETE a LoadImage node but cannot rewire a
      // sampler's latent, so without this the graph keeps its authored
      // filename - a file that exists on one machine - and the run dies
      // inside ComfyUI after the queue is already paid for.
      if (d.requiresImage && !want.image) { dropped.needsImage++; continue; }
      pool.push(d);
    }
    if (!pool.length) {
      var why;
      if (dropped.needsImage && !dropped.disabled) {
        why = "every runnable template needs a reference image; pass " +
              "image: <absolute path>, or install one that does not";
      } else if (dropped.disabled && !dropped.needsImage) {
        why = "every runnable template is switched off in Settings > " +
              "ComfyUI > Workflows";
      } else if (dropped.disabled || dropped.needsImage) {
        why = "no template is both enabled and runnable without an image";
      } else if (dropped.example) {
        why = "the only templates installed are format examples with a " +
              "placeholder checkpoint";
      } else {
        why = "no workflow templates are installed";
      }
      return { chosen: null, candidates: [], why: why };
    }

    // Described templates of the wanted kind first; UNDESCRIBED ones
    // (no manifest) after them, never excluded - the README promises a
    // user's own export works as-is, and it has no kind to match on.
    var kinded = [], unknown = [], otherKind = [];
    for (var j = 0; j < pool.length; j++) {
      if (pool[j].kind === wantKind) kinded.push(pool[j]);
      else if (pool[j].kind === undefined) unknown.push(pool[j]);
      else otherKind.push(pool[j]);
    }

    function rank(list) {
      var scored = [];
      for (var k = 0; k < list.length; k++) {
        var d = list[k];
        scored.push({
          d: d,
          // Fit FIRST: never hand a card a graph it cannot hold while one
          // it can is sitting there.
          fits: opts.fits ? (opts.fits(d) ? 1 : 0) : 1,
          // Then weights actually on this disk - a template whose files
          // are missing is a refusal the user has to act on.
          present: opts.weightsPresent ? (opts.weightsPresent(d) ? 1 : 0) : 0,
          // Then the BASELINE: the graph the catalog entry itself points
          // at. Without this the owner's own refined template and the
          // shipped basic tie on everything and fall through to NAME,
          // where the winner is whichever sorts first - luck, not design.
          baseline: opts.baseline ? (opts.baseline(d) ? 1 : 0) : 0,
          // Then the image the caller actually gave us.
          usesImage: (want.image && d.takesImage) ? 1 : 0
        });
      }
      scored.sort(function (a, b) {
        if (a.fits !== b.fits) return b.fits - a.fits;
        if (a.present !== b.present) return b.present - a.present;
        if (a.baseline !== b.baseline) return b.baseline - a.baseline;
        if (a.usesImage !== b.usesImage) return b.usesImage - a.usesImage;
        return a.d.name.toLowerCase() < b.d.name.toLowerCase() ? -1 : 1;
      });
      var names = [];
      for (var n = 0; n < scored.length; n++) names.push(scored[n].d);
      return names;
    }

    var order = rank(kinded).concat(rank(unknown)).concat(rank(otherKind));
    var pick = order[0];
    var why = "no workflow named; picked " + pick.name + " for a " +
              wantKind + " request";
    if (pick.kind === undefined) {
      why += " (it carries no manifest, so its kind is unknown)";
    } else if (pick.kind !== wantKind) {
      why += " (nothing of that kind is available)";
    }
    return { chosen: pick, candidates: order, why: why };
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

  // ------------------------------------- manifest-driven injection points

  /* The generic walk above only understands CLIPTextEncode-shaped graphs.
   * MiniMax H3 carries its prompt on the sampler node itself, its duration
   * on a seconds primitive feeding a frame-grid expression, and its size as
   * MEGAPIXELS on a ResolutionSelector — so without help the render would
   * silently use the template's placeholder text at the template's size.
   * The workflow's sidecar manifest names those nodes in a `procedural`
   * block; everything below is driven by it and does nothing without one. */

  /** True for an API-format link value, i.e. ["<upstreamId>", slot]. */
  function isLink(v) { return v instanceof Array; }

  /**
   * Resolve a procedural entry to the input KEY it addresses.
   * `input` (a name) is authoritative. `widget: N` is the fallback for
   * hand-written manifests: widgets keep their authored order in the API
   * export, so N counts literal (unlinked) inputs from the front.
   */
  function proceduralKey(node, entry, label) {
    var keys = [];
    for (var k in node.inputs) {
      if (node.inputs.hasOwnProperty(k) && !isLink(node.inputs[k])) keys.push(k);
    }
    if (entry && typeof entry.input === "string") {
      if (!node.inputs.hasOwnProperty(entry.input)) {
        throw new Error("Manifest procedural." + label + " names input '" +
          entry.input + "', which node " + entry.nodeId + " (" +
          node.class_type + ") does not have. It has: " +
          keys.join(", ") + ".");
      }
      return entry.input;
    }
    var idx = (entry && typeof entry.widget === "number") ? entry.widget : 0;
    if (idx >= keys.length) {
      throw new Error("Manifest procedural." + label + " asks for widget " +
        idx + " of node " + entry.nodeId + " (" + node.class_type +
        "), which has " + keys.length + " settable input(s): " +
        (keys.join(", ") || "none") + ".");
    }
    return keys[idx];
  }

  /** Write a value keeping the widget's authored type (".98" stays a string). */
  function writeWidget(node, key, value) {
    node.inputs[key] = (typeof node.inputs[key] === "string")
      ? String(value) : value;
  }

  function proceduralNode(graph, entry, label) {
    if (!entry || entry.nodeId === undefined || entry.nodeId === null) return null;
    var node = graph[String(entry.nodeId)];
    if (!node || !node.inputs) {
      throw new Error("Manifest procedural." + label + " points at node " +
        entry.nodeId + ", which is not in this workflow. Re-export the " +
        "template or fix the manifest.");
    }
    return node;
  }

  function injectProcedural(graph, params, procedural, applied) {
    var p = procedural;

    if (p.prompt && typeof params.prompt === "string" && params.prompt !== "") {
      var pn = proceduralNode(graph, p.prompt, "prompt");
      var pk = proceduralKey(pn, p.prompt, "prompt");
      writeWidget(pn, pk, params.prompt);
      applied.push("prompt -> node " + p.prompt.nodeId + "." + pk +
                   " (manifest)");
    }

    // Seconds, never frames: this graph converts to the model's 17k+5 frame
    // grid itself. Writing a frame count into the seconds widget would ask
    // for a two-minute render and look like it worked.
    if (p.durationSeconds) {
      if (params.durationSeconds > 0) {
        var dn = proceduralNode(graph, p.durationSeconds, "durationSeconds");
        var dk = proceduralKey(dn, p.durationSeconds, "durationSeconds");
        writeWidget(dn, dk, Number(params.durationSeconds));
        applied.push("durationSeconds=" + Number(params.durationSeconds) +
                     " -> node " + p.durationSeconds.nodeId + "." + dk +
                     " (manifest)");
      } else if (params.frames > 0) {
        throw new Error("This template's length is set in SECONDS, not " +
          "frames — its graph converts seconds to the model's own frame " +
          "grid. Re-call with durationSeconds (e.g. durationSeconds: 5) " +
          "instead of frames: " + Math.round(params.frames) + ".");
      }
    } else if (params.durationSeconds > 0) {
      applied.push("durationSeconds ignored (this template has no seconds " +
                   "input; use frames)");
    }

    // ResolutionSelector takes MEGAPIXELS plus its own aspect_ratio combo,
    // so width/height can only set the total area. Say so rather than let
    // the caller believe it got the exact pixel dimensions it asked for.
    if (p.resolution && params.width > 0 && params.height > 0) {
      var rn = proceduralNode(graph, p.resolution, "resolution");
      var rk = proceduralKey(rn, p.resolution, "resolution");
      var mp = (params.width * params.height) / 1e6;
      var capped = "";
      if (p.resolution.maxMegapixels > 0 && mp > p.resolution.maxMegapixels) {
        mp = p.resolution.maxMegapixels;
        capped = ", capped at this model's trained maximum";
      }
      mp = Math.round(mp * 100) / 100;
      writeWidget(rn, rk, mp);
      applied.push("width x height -> " + mp + " megapixels on node " +
        p.resolution.nodeId + "." + rk + " (this template derives pixel " +
        "dimensions from megapixels + its own aspect ratio" + capped + ")");
    }

    // The reference image. With one, the caller's uploaded filename goes in;
    // without one, the whole LoadImage is detached and the graph runs as
    // text-to-video — the template's baked-in filename exists on nobody
    // else's machine, so leaving it would fail validation for every user.
    if (p.firstFrame) {
      var fid = String(p.firstFrame.nodeId);
      var fn = proceduralNode(graph, p.firstFrame, "firstFrame");
      if (typeof params.imageName === "string" && params.imageName !== "") {
        var fk = proceduralKey(fn, p.firstFrame, "firstFrame");
        writeWidget(fn, fk, params.imageName);
        applied.push("image -> node " + fid + "." + fk + " (manifest)");
      } else if (p.firstFrame.detachable) {
        var dropped = [];
        for (var cid in graph) {
          if (!graph.hasOwnProperty(cid)) continue;
          var c = graph[cid];
          if (!c || !c.inputs) continue;
          for (var ck in c.inputs) {
            if (!c.inputs.hasOwnProperty(ck)) continue;
            if (isLink(c.inputs[ck]) && String(c.inputs[ck][0]) === fid) {
              delete c.inputs[ck];
              dropped.push(cid + "." + ck);
            }
          }
        }
        delete graph[fid];
        applied.push("no image: detached the reference frame (node " + fid +
                     (dropped.length ? " -> " + dropped.join(", ") : "") +
                     ") and ran text-to-video");
      } else {
        applied.push("no image given, and this template's reference frame " +
                     "is not marked detachable — node " + fid +
                     " keeps its authored file");
      }
    }
  }

  /*
   * ------------------------------------------ what width/height BECOME
   *
   * A template that renders at one size and enlarges before it saves is
   * ordinary, and the shipped KREA2 graph is one: authored 1920x1080, a
   * 1.6x latent upscale between its two passes, 3072x1728 on disk. So a
   * caller asking for 1024x1024 gets a 1640x1640 file, and until now the
   * only record of that anywhere was the file itself.
   *
   * `widget` is the factor's input name per class. `latent` says the
   * enlargement happens in LATENT space, where the factor lands on the /8
   * grid and is multiplied back out - which is why 1024 becomes 1640 and
   * not 1638. Both shipped sizes reproduce exactly this way.
   */
  var SCALE_CLASSES = {
    LatentUpscaleBy:     { widget: "scale_by", latent: true },
    SesquiLatentUpscale: { widget: "scale",    latent: true },
    ImageScaleBy:        { widget: "scale_by", latent: false }
  };

  /** True for a node that writes a file, i.e. the end of a size chain. */
  function isOutputNode(node) {
    if (!node || !node.inputs) return false;
    if (node.inputs.hasOwnProperty("filename_prefix")) return true;
    return /^Save/.test(String(node.class_type || ""));
  }

  /** nodeId -> [ids of the nodes taking one of its outputs]. */
  function consumerMap(graph) {
    var consumers = {}, k, key;
    for (k in graph) {
      if (!graph.hasOwnProperty(k)) continue;
      if (!graph[k] || !graph[k].inputs) continue;
      for (key in graph[k].inputs) {
        if (!graph[k].inputs.hasOwnProperty(key)) continue;
        var v = graph[k].inputs[key];
        if (!isLink(v)) continue;
        var src = String(v[0]);
        if (!consumers[src]) consumers[src] = [];
        consumers[src].push(k);
      }
    }
    return consumers;
  }

  /**
   * Follow the picture made at `startId` forward to whatever writes it to
   * disk, and answer by how much its size is multiplied on the way.
   *
   * Returns {factor, latent} or NULL, and null is reported as nothing at
   * all. The rule is the one the weight check already lives by: a number
   * that might be wrong is worse than no number, because it sends a user
   * looking for pixels that were never there. So every case this cannot
   * account for - a resize whose amount lives in a MODEL rather than in a
   * widget, a scale widget that is not a positive number, two output
   * branches that disagree, a chain that reaches no output at all - gives
   * up rather than guesses.
   */
  function outputScaleFrom(graph, startId) {
    var consumers = consumerMap(graph);
    var unknown = false;
    var factors = {};          // "1.6|l" -> {factor, latent}
    var found = 0;

    function visit(id, factor, latent, depth) {
      if (unknown) return;
      if (depth > 64) { unknown = true; return; }
      var node = graph[id];
      if (!node || !node.inputs) return;
      var cls = String(node.class_type || "");
      var f = factor, lat = latent;

      if (depth > 0) {
        var rule = SCALE_CLASSES.hasOwnProperty(cls)
          ? SCALE_CLASSES[cls] : null;
        if (rule) {
          var raw = node.inputs[rule.widget];
          var num = (typeof raw === "string") ? Number(raw) : raw;
          if (typeof num !== "number" || !(num > 0)) { unknown = true; return; }
          f = factor * num;
          if (rule.latent) lat = true;
        } else if (node.inputs.hasOwnProperty("upscale_model") ||
                   /UpscaleWithModel/.test(cls)) {
          // The factor is a property of the .pth, not of the graph.
          unknown = true;
          return;
        } else if (typeof node.inputs.width === "number" &&
                   typeof node.inputs.height === "number") {
          // An absolute resize, and injectParams has just written the
          // caller's own numbers into it - so from here the size IS the
          // size that was asked for, whatever happened upstream.
          f = 1;
          lat = false;
        }
      }

      if (isOutputNode(node)) {
        var key = f + "|" + (lat ? "l" : "p");
        if (!factors.hasOwnProperty(key)) {
          factors[key] = { factor: f, latent: lat };
          found++;
        }
      }
      var next = consumers[String(id)] || [];
      for (var i = 0; i < next.length; i++) visit(next[i], f, lat, depth + 1);
    }

    visit(String(startId), 1, false, 0);
    if (unknown || found !== 1) return null;
    for (var key2 in factors) {
      if (factors.hasOwnProperty(key2)) return factors[key2];
    }
    return null;
  }

  /** Apply a scale the way the node carrying it would. */
  function scaleDim(px, factor, latent) {
    if (latent) return Math.round((px / 8) * factor) * 8;
    return Math.round(px * factor);
  }

  // ------------------------------------------- size from the comp (§23c)

  /**
   * The size a render takes when it is placed in a comp and the caller
   * named none (WORKPLAN §23c bullet 2, NEXT UP 22). Pure.
   *
   * o: {kind, authoredW, authoredH, compW, compH, factor, step: {w, h},
   *     min: {w, h}, max: {w, h}}. `factor` is what the template enlarges
   * by before it saves (outputScaleFrom), so a picture's FILE lands near
   * the comp's size rather than its generation size.
   *
   * VIDEO keeps the authored pixel count at the comp's aspect: every
   * measured second and VRAM gate was taken at that count. IMAGE takes
   * the comp's size, but never more pixels than the template was authored
   * (and measured) at - an SD 1.5 graph asked for 1920x1080 is both out of
   * its training and over its gate, and import_as_layer fits the result to
   * the comp either way. Snapped to the node's own declared step.
   */
  function sizeForComp(o) {
    var f = o.factor > 0 ? o.factor : 1;
    var area = o.authoredW * o.authoredH;
    var aspect = o.compW / o.compH;
    var w, h;
    if (o.kind === "video") {
      w = Math.sqrt(area * aspect);
      h = Math.sqrt(area / aspect);
    } else {
      w = o.compW / f;
      h = o.compH / f;
      if (w * h > area) {
        w = Math.sqrt(area * aspect);
        h = Math.sqrt(area / aspect);
      }
    }
    function snap(v, step, min, max) {
      step = step > 0 ? step : 1;
      var s = Math.max(step, Math.round(v / step) * step);
      if (max > 0 && s > max) s = Math.floor(max / step) * step;
      if (min > 0 && s < min) s = Math.ceil(min / step) * step;
      return s;
    }
    var st = o.step || {}, mn = o.min || {}, mx = o.max || {};
    return { width: snap(w, st.w, mn.w, mx.w),
             height: snap(h, st.h, mn.h, mx.h) };
  }

  /** {step, min, max} of one INT input in an /object_info class, or null. */
  function intSpec(info, name) {
    var inp = info && info.input;
    if (!inp) return null;
    var d = (inp.required && inp.required[name]) ||
            (inp.optional && inp.optional[name]);
    if (!(d instanceof Array) || d[0] !== "INT" || !d[1]) return null;
    return { step: Number(d[1].step) || 1, min: Number(d[1].min) || 0,
             max: Number(d[1].max) || 0 };
  }

  /**
   * When params.compSize is set and no width/height is, write the comp-
   * derived size into params before injectParams. cb(note) - note is the
   * applied line, or null when nothing was changed. Never guesses: no
   * single size node, an unaccountable output scale, or a step the backend
   * will not declare leaves the authored size and says why.
   */
  function applyCompSize(base, graph, params, manifest, cb) {
    var cs = params.compSize;
    if (!cs || !(cs.width > 0) || !(cs.height > 0) ||
        params.width > 0 || params.height > 0) { cb(null); return; }
    var id = null, count = 0;
    for (var k in graph) {
      if (!graph.hasOwnProperty(k)) continue;
      var n = graph[k];
      if (n && n.inputs && typeof n.inputs.width === "number" &&
          typeof n.inputs.height === "number") { id = k; count++; }
    }
    var from = "comp '" + cs.name + "' is " + cs.width + "x" + cs.height;
    if (count !== 1) {
      cb(from + ", but this template has " + (count ? count : "no") +
         " size nodes, so it renders at its authored size");
      return;
    }
    var node = graph[id];
    var kind = (manifest && manifest.kind === "video") ? "video" : "image";
    var sc = kind === "image" ? outputScaleFrom(graph, id) : { factor: 1 };
    if (!sc) {
      cb(from + ", but this template's output scale cannot be read, so " +
         "it renders at its authored size");
      return;
    }
    var cls = String(node.class_type || "");
    requestJson(base, "GET", "/object_info/" + encodeURIComponent(cls),
      null, 10000, function (err, statusCode, json) {
        var info = (!err && statusCode === 200 && json) ? json[cls] : null;
        var sw = intSpec(info, "width"), sh = intSpec(info, "height");
        if (!sw || !sh) {
          cb(from + ", but ComfyUI did not declare " + cls + "'s width/" +
             "height step, so it renders at its authored size");
          return;
        }
        var aw = node.inputs.width, ah = node.inputs.height;
        var size = sizeForComp({
          kind: kind, authoredW: aw, authoredH: ah,
          compW: cs.width, compH: cs.height, factor: sc.factor,
          step: { w: sw.step, h: sh.step }, min: { w: sw.min, h: sh.min },
          max: { w: sw.max, h: sh.max } });
        params.width = size.width;
        params.height = size.height;
        cb("size " + size.width + "x" + size.height + " from " + from +
           " (" + (kind === "video"
             ? "video keeps the authored " + aw + "x" + ah + " pixel count"
             : "image at the comp's size, at most the authored " + aw +
               "x" + ah + " pixel count") +
           ", comp aspect, snapped to " + sw.step +
           "; pass width/height to override)");
      });
  }

  /**
   * The line that closes the gap: for every node whose size was just set,
   * say what that size turns into on disk. Silent when nothing enlarges it
   * and silent whenever outputScaleFrom cannot account for the chain.
   */
  function noteOutputSize(graph, sizedIds, applied) {
    var seen = {};
    for (var i = 0; i < sizedIds.length; i++) {
      var id = sizedIds[i];
      var node = graph[id];
      if (!node || !node.inputs) continue;
      var w = node.inputs.width, h = node.inputs.height;
      if (typeof w !== "number" || typeof h !== "number") continue;
      var sc = outputScaleFrom(graph, id);
      if (!sc || sc.factor === 1) continue;
      var line = "size " + w + "x" + h + " on node " + id + " is enlarged " +
        sc.factor + "x before this template saves, so the file will be " +
        scaleDim(w, sc.factor, sc.latent) + "x" +
        scaleDim(h, sc.factor, sc.latent) +
        " - width/height set the size it GENERATES at, not the size it " +
        "writes";
      if (seen.hasOwnProperty(line)) continue;
      seen[line] = true;
      applied.push(line);
    }
  }

  /**
   * The length a video renders when the caller named none (WORKPLAN 18
   * P3a(b)). The authored H3 graph defaulted to 15 s, a >15-minute render
   * on a 5090, and that is what "make a video of X" handed a user. A
   * template authored longer than AELL.COMFY_DEFAULT_CLIP_SECONDS is
   * brought down to it; one authored shorter is left alone, and a named
   * durationSeconds or frames always wins, so this is a default and never
   * a ceiling. Says so in applied: a silently shorter clip reads exactly
   * like a broken graph.
   *
   * Seconds templates are read through their manifest pointer. Frames
   * templates through the same frame keys injectParams writes, over the
   * graph's own `fps`; with no fps the length in seconds is unknowable
   * and the graph keeps its authored count.
   */
  function capDefaultClip(graph, params, manifest, applied) {
    var cap = global.AELL && global.AELL.COMFY_DEFAULT_CLIP_SECONDS;
    if (!(cap > 0)) return;
    if (params.durationSeconds > 0 || params.frames > 0) return;
    var p = (manifest && manifest.procedural) || {};

    if (p.durationSeconds) {
      var dn = proceduralNode(graph, p.durationSeconds, "durationSeconds");
      if (!dn) return;
      var dk = proceduralKey(dn, p.durationSeconds, "durationSeconds");
      var secs = Number(dn.inputs[dk]);
      if (!(secs > cap)) return;
      writeWidget(dn, dk, cap);
      applied.push("durationSeconds=" + cap + " -> node " +
        p.durationSeconds.nodeId + "." + dk + " (no length named: the " +
        "template is authored at " + secs + " s, the default is capped at " +
        cap + " s; pass durationSeconds to render longer)");
      return;
    }

    var frameKeys = ["length", "frames", "video_frames", "num_frames"];
    var fNode = null, fKey = null, fps = 0, k, i;
    for (k in graph) {
      if (!graph.hasOwnProperty(k)) continue;
      var n = graph[k];
      if (!n || !n.inputs) continue;
      if (!fNode) {
        for (i = 0; i < frameKeys.length; i++) {
          if (typeof n.inputs[frameKeys[i]] === "number") {
            fNode = k; fKey = frameKeys[i]; break;
          }
        }
      }
      if (!fps && typeof n.inputs.fps === "number") fps = n.inputs.fps;
    }
    if (!fNode || !(fps > 0)) return;
    var authored = graph[fNode].inputs[fKey];
    if (!(authored / fps > cap)) return;
    // Step down in eights from the authored count: video latents here sit
    // on a 4k+1 (Wan) or 8k+1 (LTX) frame grid, and a count congruent to
    // the authored one mod 8 stays on either.
    var frames = authored - 8 * Math.ceil((authored - cap * fps) / 8);
    if (frames < 1) return;
    graph[fNode].inputs[fKey] = frames;
    applied.push("frames(" + fKey + ")=" + frames + " -> node " + fNode +
      " (no length named: the template is authored at " + authored +
      " frames = " + Math.round(authored / fps * 100) / 100 + " s, the " +
      "default is capped at " + cap + " s; pass frames to render longer)");
  }

  // ------------------------------------------------ H3 prompt shape (§13e)

  /* The MiniMax H3 encoder RAISES "text segment exceeds the supported prompt
   * length" when a prompt tokenizes into more than one batch, and its
   * tokenizer's max_length is 99999999 (comfy/text_encoders/qwen3vl.py,
   * read 2026-09-17 on the managed 0.34.0). A token covers at least one
   * UTF-8 byte, so a prompt of at most this many bytes provably fits. */
  var H3_PROMPT_MAX_TOKENS = 99999999;

  /* Owner, 2026-09-17: format only when the user gave no timeline and no
   * camera direction, otherwise send the text untouched. A detector, not a
   * judgement. The camera words are the published H3 vocabulary
   * (docs/proposals/h3-prompt-format.md §2); "track" alone is too common
   * ("race track"), so it counts only with a direction. */
  var H3_TIMELINE_RE = /\[\s*\d+(?:\.\d+)?\s*s?\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?\s*s?\s*\]|\[\s*\d+(?:\.\d+)?\s*s(?:ec(?:onds?)?)?\s*\]/i;
  var H3_CAMERA_RE = /\b(?:dolly|dollies|dollying|pan|pans|panning|panned|tilt|tilts|tilting|tilted|orbit|orbits|orbiting|crane|craning|hand-?held|whip[- ]pan|locked[- ]off|track(?:s|ing|ed)?\s+(?:left|right|in|out|shot)|tracking shot)\b/i;

  /**
   * Shape a user's sentence into the H3 craft order (References, Retention,
   * Scene, Timeline, Camera, Audio, Constraints), inventing nothing: every
   * element the panel was not given is left out. The panel knows the scene
   * (the words) and the length (the graph), so that is the whole of it:
   * "[0-6s] <words>". i2v and t2v format alike; the mode changes what a
   * user must describe, not the shape, and the encoder labels the picture
   * itself.
   *
   * Returns {prompt, formatted, reason}. Throws a grounded error when the
   * result could exceed the encoder's limit, which would otherwise raise
   * inside the backend after the models loaded.
   */
  function formatH3Prompt(text, opts) {
    var src = String(text);
    var seconds = opts && Number(opts.seconds);
    var out = { prompt: src, formatted: false, reason: "" };
    var cam = H3_CAMERA_RE.exec(src);
    if (H3_TIMELINE_RE.test(src)) {
      out.reason = "it already carries a bracketed timeline";
    } else if (cam) {
      out.reason = "it already names a camera move ('" + cam[0] + "')";
    } else if (!(seconds > 0)) {
      out.reason = "the clip length is not known";
    } else {
      var s = String(Math.round(seconds * 10) / 10);
      out.prompt = "[0-" + s + "s] " + src.replace(/^\s+|\s+$/g, "");
      out.formatted = true;
    }
    var bytes = unescape(encodeURIComponent(out.prompt)).length;
    if (bytes > H3_PROMPT_MAX_TOKENS) {
      throw new Error("The prompt is " + bytes + " bytes; MiniMax H3's " +
        "encoder refuses a prompt over " + H3_PROMPT_MAX_TOKENS +
        " tokens. Shorten it and re-call.");
    }
    return out;
  }

  /** Seconds the H3 node will render, read from the graph as it will queue. */
  function h3ClipSeconds(graph, node, procedural) {
    if (procedural.durationSeconds) {
      var dn = proceduralNode(graph, procedural.durationSeconds,
                              "durationSeconds");
      var secs = Number(dn.inputs[proceduralKey(dn,
        procedural.durationSeconds, "durationSeconds")]);
      return secs > 0 ? secs : 0;
    }
    var len = node.inputs.length;
    if (typeof len !== "number" || !(len > 0)) return 0;
    // The node snaps length UP to its 17k+5 grid (its /object_info tooltip).
    if (len > 5) len = 5 + 17 * Math.ceil((len - 5) / 17);
    for (var k in graph) {
      if (!graph.hasOwnProperty(k)) continue;
      var n = graph[k];
      if (n && n.inputs && typeof n.inputs.fps === "number" && n.inputs.fps > 0) {
        return len / n.inputs.fps;
      }
    }
    return 0;
  }

  /**
   * Last graft for an H3 template: rewrite the prompt the manifest pointed
   * at into the H3 shape. Keyed on the node's class, not the template name,
   * so every H3 sibling gets it. Returns the text actually sent, so the
   * landed check can look for THAT rather than the caller's raw words.
   */
  function shapeH3Prompt(graph, params, manifest, applied) {
    var p = manifest && manifest.procedural;
    if (!p || !p.prompt || typeof params.prompt !== "string" ||
        params.prompt === "") return null;
    var node = proceduralNode(graph, p.prompt, "prompt");
    if (!node || !/^MiniMaxH3/.test(String(node.class_type))) return null;
    var key = proceduralKey(node, p.prompt, "prompt");
    var r = formatH3Prompt(params.prompt,
                           { seconds: h3ClipSeconds(graph, node, p) });
    writeWidget(node, key, r.prompt);
    applied.push(r.formatted
      ? "prompt shaped for H3 -> \"" + r.prompt + "\""
      : "prompt sent to H3 untouched (" + r.reason + ")");
    return r.prompt;
  }

  /**
   * Graft params onto the graph. Returns a list of what was changed so the
   * LLM (and user) can see how the template was used.
   * params: {prompt, negative, width, height, seed, frames, durationSeconds,
   *          imageName}
   * manifest: the workflow's sidecar, if any — its `procedural` block names
   * the nodes the generic introspection below cannot find.
   */
  function injectParams(graph, params, manifest) {
    var applied = [];
    var cls = classifyEncoders(graph);
    var sizedIds = [];
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
        if (params.width > 0 || params.height > 0) sizedIds.push(k);
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

    // Last, so an explicit manifest target always wins over a guess.
    if (manifest && manifest.procedural) {
      injectProcedural(graph, params, manifest.procedural, applied);
    }
    capDefaultClip(graph, params, manifest, applied);
    // After the cap, so the timeline states the length that will render.
    var h3Sent = shapeH3Prompt(graph, params, manifest, applied);
    if (h3Sent !== null) applied.promptSent = h3Sent;
    // After everything, because the answer depends on the graph as it is
    // going to be queued.
    noteOutputSize(graph, sizedIds, applied);
    return applied;
  }

  /**
   * True when `value` appears verbatim as a LITERAL (non-link) input
   * somewhere in the graph. The queue/no-queue decisions in generate() read
   * the graph itself through this, never the applied[] prose: applied is
   * written for the model's benefit, and prose can fail to say what the
   * graph does not carry — a KREA2 run with an image uploaded the file,
   * injected nothing, and rendered as pure text-to-image without a word.
   */
  function graphCarriesValue(graph, value) {
    for (var k in graph) {
      if (!graph.hasOwnProperty(k)) continue;
      var node = graph[k];
      if (!node || !node.inputs) continue;
      for (var ik in node.inputs) {
        if (!node.inputs.hasOwnProperty(ik)) continue;
        var v = node.inputs[ik];
        if (typeof v === "string" && v === value) return true;
      }
    }
    return false;
  }

  /* Same cap the AE-side tools use for grounded listings
   * (AELL_LIST_LIMIT in hostscript.jsx). */
  var COMFY_LIST_LIMIT = 40;

  /**
   * Names of the workflows in `dir` whose manifest declares
   * procedural.firstFrame — the only path by which a caller's image ever
   * reaches a graph, so also the only templates worth naming when an image
   * landed nowhere.
   */
  function imageCapableWorkflows(dir) {
    var names = [];
    var all = listWorkflows(dir);
    for (var i = 0; i < all.length; i++) {
      var mf = readManifest(all[i].file);
      if (mf && mf.procedural && mf.procedural.firstFrame) {
        names.push(all[i].name);
      }
    }
    return names;
  }


  // -------------------------------------------------- filename tokens
  //
  // ComfyUI advertises %date:yyyy-MM-dd% and %Node title.widget% inside
  // filename_prefix (SaveVideo's own tooltip says so), but NOTHING on the
  // server expands them: the FRONTEND rewrites the text in
  // applyTextReplacements() before it posts the prompt, and the server saves
  // whatever string it is handed. A panel that posts API-format graphs IS the
  // frontend, so it has to do this itself.
  //
  // Measured, not assumed: the bundled H3 template's SaveVideo prefix is
  // "video/MiniMax_H3/%date:yyyy_MM_dd%/…". Posted verbatim, ComfyUI 0.32.0
  // answered
  //
  //   [WinError 267] The directory name is invalid:
  //   'C:\…\output\video\MiniMax_H3\%date:yyyy_MM_dd%'
  //
  // — the unexpanded token still holds a COLON, which Windows will not accept
  // in a path, so the whole render died at the last node after the GPU work
  // was already paid for. The same template run from ComfyUI's own UI on this
  // machine wrote output/video/MiniMax_H3/2026_08_03/, which is the proof the
  // expansion happens client-side.
  //
  // The port below is deliberately literal — same token regex, same date
  // grammar, same illegal-character scrub, same "leave it alone" fallback for
  // anything unresolvable (frontend settingStore bundle, ComfyUI frontend
  // 1.48.7). A prompt reading "brightness 50% to 100%" is left untouched by
  // exactly the rule that leaves it untouched in the browser.

  var DATE_GETTERS = {
    d: function (t) { return t.getDate(); },
    M: function (t) { return t.getMonth() + 1; },
    h: function (t) { return t.getHours(); },
    m: function (t) { return t.getMinutes(); },
    s: function (t) { return t.getSeconds(); }
  };
  var DATE_TOKEN_RE = /dd?|MM?|hh?|mm?|ss?|yyy?y?/g;

  function padLeft(text, width) {
    var s = String(text);
    while (s.length < width) s = "0" + s;
    return s;
  }

  /** The frontend's formatDate: "yyyy_MM_dd" + a Date -> "2026_08_27". */
  function formatDateToken(fmt, when) {
    return String(fmt).replace(DATE_TOKEN_RE, function (m) {
      if (m === "yy") return String(when.getFullYear()).substring(2);
      if (m === "yyyy") return String(when.getFullYear());
      var get = DATE_GETTERS[m.charAt(0)];
      if (!get) return m;                       // "yyy" and friends: verbatim
      return padLeft(get(when), m.length);
    });
  }

  /**
   * The name a %Title.widget% reference matches. The browser matches the
   * node's "Node name for S&R" property first and its title second; an
   * API-format graph has neither, so class_type (what S&R defaults to) is
   * tried first and the adapter-preserved _meta.title second.
   */
  function nodeRefNames(node) {
    var names = [];
    if (node && node.class_type) names.push(String(node.class_type));
    if (node && node._meta && node._meta.title) {
      names.push(String(node._meta.title));
    }
    return names;
  }

  function expandTokensIn(graph, text, when) {
    return String(text).replace(/%([^%]+)%/g, function (whole, inner) {
      var parts = inner.split(".");
      if (parts.length !== 2) {
        if (parts[0].indexOf("date:") === 0) {
          return formatDateToken(parts[0].substring(5), when);
        }
        return whole;                    // not a token we know: hands off
      }
      for (var id in graph) {
        if (!graph.hasOwnProperty(id)) continue;
        var names = nodeRefNames(graph[id]);
        var hit = false;
        for (var n = 0; n < names.length; n++) {
          if (names[n] === parts[0]) { hit = true; break; }
        }
        if (!hit) continue;
        var v = graph[id].inputs ? graph[id].inputs[parts[1]] : undefined;
        if (v === undefined || isLink(v)) continue;   // linked: no literal
        // Same scrub the browser applies before the value reaches a path.
        return String(v).replace(/[\/?<>\\:*|"\x00-\x1f\x7f]/g, "_");
      }
      return whole;                      // unresolvable: leave it visible
    });
  }

  /**
   * Expand filename tokens across every literal string input in the graph.
   * Returns a list of "node.input: before -> after" notes (empty when the
   * template used no tokens, which is the common case).
   */
  function expandFilenameTokens(graph, when) {
    var changes = [];
    when = when || new Date();
    for (var id in graph) {
      if (!graph.hasOwnProperty(id)) continue;
      var node = graph[id];
      if (!node || !node.inputs) continue;
      for (var key in node.inputs) {
        if (!node.inputs.hasOwnProperty(key)) continue;
        var val = node.inputs[key];
        if (typeof val !== "string" || val.indexOf("%") === -1) continue;
        var next = expandTokensIn(graph, val, when);
        if (next === val) continue;
        node.inputs[key] = next;
        changes.push(id + "." + key + ": " + val + " -> " + next);
      }
    }
    return changes;
  }

  // ------------------------------------------------------- optional nodes

  /**
   * Is a node class registered on the running server?
   *
   * GET /object_info/<class> answers **200 with an empty object** for a class
   * ComfyUI has never heard of (server.py get_object_info_node) — it does not
   * 404. Testing the status code alone would report every class installed.
   */
  function classInstalled(base, className, cb) {
    requestJson(base, "GET", "/object_info/" + encodeURIComponent(className),
      null, 10000, function (err, statusCode, json) {
        if (err) {
          cb(new Error("ComfyUI unreachable at " + base.label + " — " +
                       err.message));
          return;
        }
        if (statusCode !== 200 || !json) {
          cb(new Error("ComfyUI could not be asked about node class " +
                       className + " (HTTP " + statusCode + ")"));
          return;
        }
        cb(null, Object.prototype.hasOwnProperty.call(json, className));
      });
  }

  // ------------------------------------------------- weight availability

  /**
   * A loader widget's value is a WEIGHT when it names a weight FILE.
   * The same combo lists also carry modes (`weight_dtype: "default"`,
   * `type: "krea2"`), and those are not what this asks about.
   */
  var WEIGHT_FILE_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i;

  /**
   * The list of values a node class declares for one input, or null when
   * that input is not a combo this can answer about.
   *
   * Measured on ComfyUI 0.32.0: `input.required.<name>` is
   * `[[choice, ...], {...}]`. The `["COMBO", {options: [...]}]` form some
   * builds emit is read too; anything else answers null, which makes the
   * caller silent rather than wrong.
   */
  function comboChoices(def, name) {
    if (!def || !def.input) return null;
    var spec = null;
    if (def.input.required &&
        Object.prototype.hasOwnProperty.call(def.input.required, name)) {
      spec = def.input.required[name];
    } else if (def.input.optional &&
               Object.prototype.hasOwnProperty.call(def.input.optional, name)) {
      spec = def.input.optional[name];
    }
    if (!(spec instanceof Array) || !spec.length) return null;
    if (spec[0] instanceof Array) return spec[0];
    if (spec[0] === "COMBO" && spec[1] && spec[1].options instanceof Array) {
      return spec[1].options;
    }
    return null;
  }

  /**
   * A combo's options are BUILD-CONSTANT when they come from the build
   * itself (`euler`, `simple`, `bislerp`) rather than from this disk
   * (`ckpt_name`, `lora_name`, `image`). Only the first kind can be
   * checked against a template's authored literal: the second kind is a
   * picture of one machine, and half of them are values the panel
   * OVERWRITES at generate time anyway (LoadImage.image is the author's
   * own PNG until the panel uploads over it).
   *
   * Same rule, same regex as scripts/harvest-core-enums.js, which pins
   * the offline half of this check — if the two ever disagree about what
   * is checkable, the offline test and the live preflight are answering
   * different questions.
   */
  var INSTALL_DEPENDENT_RE =
    /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|yaml|json|png|jpg|jpeg|webp|gif|bmp|tiff?|mp4|webm|mov|npy|txt)$|[\\\/]/i;
  function buildConstant(choices) {
    if (!(choices instanceof Array) || !choices.length) return false;
    for (var i = 0; i < choices.length; i++) {
      if (typeof choices[i] === "string" &&
          INSTALL_DEPENDENT_RE.test(choices[i])) return false;
    }
    return true;
  }

  /**
   * Everything about a graph's LITERAL inputs that the running backend
   * would refuse — the weights it cannot load AND the enum values it does
   * not have — in one walk of /object_info.
   *
   * Why both, and why here (WORKPLAN 17g). `missingWeights` below answers
   * only about weight FILES, and it was read as "this template will run",
   * which it cannot answer. Measured 2026-09-09: the shipped KREA2
   * template named sampler `res_2s`, a value the RES4LYF pack adds to a
   * CORE node's enum. The weight check passed it clean and printed
   * `PASS a template whose weights the backend LISTS is not refused` —
   * and ComfyUI then dropped every output branch of that same graph at
   * validation. A complete-LOOKING answer that does not contain the
   * truth, which is the class this repo has already paid for once (the
   * truncated comp roster, §1).
   *
   * This mirrors what ComfyUI's own `validate_inputs` does to a literal:
   * membership in the input's combo list. It deliberately does NOT
   * re-implement the rest (link types, min/max, a node's own
   * VALIDATE_INPUTS), because ComfyUI has no validate-only endpoint —
   * measured on the vendor build, `POST /prompt` QUEUES the graph the
   * moment validation passes, and a cancel cannot land before the worker
   * thread has started loading 18 GB of weights. A preflight that runs
   * the job it is asking about is not a preflight.
   *
   * cb(err, {missing, badValues, checked, valuesChecked}).
   *   missing    — weight slots the backend cannot load (see below)
   *   badValues  — {node, classType, input, value, choices} for a
   *                build-constant enum whose authored value is not offered
   *
   * NEVER guesses, in either list. A class the server does not know, an
   * input that is not a combo, a linked input, and a combo whose options
   * come from this disk are all passed over in silence. The one residual
   * exposure is a node with a VALIDATE_INPUTS that takes the input by
   * name: ComfyUI skips its own combo check for those, so this could
   * refuse a value that build would have accepted. No part of
   * /object_info reports that a validate function exists, so it cannot be
   * detected from here — and `missingWeights` has carried the identical
   * exposure since it shipped.
   *
   * `opts.skipNodes` — node ids the CALLER knows will not reach the
   * server as written (a manifest optionalNodes entry that drops or
   * substitutes unconditionally). Entries gated on `when: "missing"` need
   * no listing: if the class is missing there is no def and this is
   * already silent, and if it is present the node runs exactly as written.
   */
  function validateGraphInputs(comfyUrl, graph, opts, cb) {
    var base;
    try { base = parseBase(comfyUrl); } catch (e) { cb(e); return; }
    var skip = {};
    var skipList = (opts && opts.skipNodes instanceof Array)
      ? opts.skipNodes : [];
    for (var s = 0; s < skipList.length; s++) skip[String(skipList[s])] = true;
    var ids = [], k;
    for (k in graph) {
      if (Object.prototype.hasOwnProperty.call(graph, k)) ids.push(k);
    }
    ids.sort();
    var defs = {};                 // class_type -> definition|null, once each
    var missing = [], badValues = [], checked = 0, valuesChecked = 0;
    (function next(i) {
      if (i >= ids.length) {
        cb(null, { missing: missing, badValues: badValues,
                   checked: checked, valuesChecked: valuesChecked });
        return;
      }
      var nid = ids[i];
      if (skip[nid]) { next(i + 1); return; }
      var node = graph[nid] || {};
      var cls = node.class_type;
      var inputs = node.inputs || {};
      var names = [], n;
      for (n in inputs) {
        if (!Object.prototype.hasOwnProperty.call(inputs, n)) continue;
        if (typeof inputs[n] === "string") names.push(n);
      }
      if (!cls || !names.length) { next(i + 1); return; }
      function withDef(def) {
        for (var j = 0; j < names.length; j++) {
          var name = names[j];
          var choices = comboChoices(def, name);
          if (!choices) continue;
          var value = inputs[name];
          var isWeight = WEIGHT_FILE_RE.test(value);
          // A value that is not a weight filename is only checkable when
          // the LIST is build-constant. Anything else is one disk's
          // contents and belongs to the weight half or to nobody.
          if (!isWeight && !buildConstant(choices)) continue;
          var hit = false;
          for (var c = 0; c < choices.length; c++) {
            if (choices[c] === value) { hit = true; break; }
          }
          if (isWeight) {
            checked++;
            if (!hit) {
              missing.push({ node: nid, classType: cls, input: name,
                             value: value, choiceCount: choices.length });
            }
          } else {
            valuesChecked++;
            if (!hit) {
              badValues.push({ node: nid, classType: cls, input: name,
                               value: value, choices: choices });
            }
          }
        }
        next(i + 1);
      }
      if (Object.prototype.hasOwnProperty.call(defs, cls)) {
        withDef(defs[cls]);
        return;
      }
      requestJson(base, "GET", "/object_info/" + encodeURIComponent(cls),
        null, 10000, function (err, statusCode, json) {
          if (err) {
            cb(new Error("ComfyUI unreachable at " + base.label + " — " +
                         err.message));
            return;
          }
          var def = (statusCode === 200 && json &&
                     Object.prototype.hasOwnProperty.call(json, cls))
            ? json[cls] : null;
          defs[cls] = def;
          withDef(def);
        });
    })(0);
  }

  /**
   * Which weights in `graph` the RUNNING backend cannot load.
   *
   * The panel prices a generation off the DISK (tools.js modelFileMB) and
   * ComfyUI decides off ITS OWN search path, and the two answer different
   * questions: the disk knows how big a weight is (/object_info carries no
   * sizes), the backend knows whether it can open it (the disk cannot know
   * the search path). Measured on this machine 2026-08-30, they disagreed:
   * all four MiniMax H3 weights are on disk where the panel looks, and the
   * running ComfyUI — launched `--base-directory Documents\ComfyUI`, with
   * no extra_model_paths.yaml anywhere — sees none of them. So the arbiter
   * would stop the chat model to make room for 40 503 MiB of weights and
   * only then hear `Value not in list — vae_name: ...`. A user pays a full
   * handoff for a job that was never runnable.
   *
   * cb(err, {missing: [{node, classType, input, value, choiceCount}],
   *          checked}). The weight half of validateGraphInputs above, kept
   * as its own name because that is the question the VRAM arbiter asks:
   * whether these files can be opened, not whether the graph is runnable.
   * NEVER guesses — see the invariants on validateGraphInputs.
   */
  function missingWeights(comfyUrl, graph, cb) {
    validateGraphInputs(comfyUrl, graph, null, function (err, res) {
      if (err) { cb(err); return; }
      cb(null, { missing: res.missing, checked: res.checked });
    });
  }

  /**
   * Drop node `id` and rewire its consumers to whatever fed its `passthrough`
   * input — ComfyUI's own mode-4 bypass semantics, except the pass-through
   * socket is DECLARED by the manifest rather than inferred from types: an
   * API-format graph carries no type information to infer from.
   *
   * `passthrough` is an input NAME for the ordinary single-output node, or a
   * MAP of output slot -> input name for a node that emits more than one
   * type. rgthree's Power Lora Loader (KREA2 node 604) emits MODEL on slot 0
   * and CLIP on slot 1, fed by two different inputs; collapsing both onto one
   * source would hand every CLIPTextEncode in the graph a MODEL, and the
   * server would report the type error at a node the user never touched. So
   * the string form answers slot 0 ONLY, and says so the moment a consumer
   * reads any other slot.
   *
   * Returns {rewired: [...]}. Throws grounded errors; never guesses, and
   * mutates nothing until every source has been resolved.
   */
  function bypassNode(graph, id, passthrough) {
    var nid = String(id);
    var node = graph[nid];
    if (!node) return null;
    var inputs = node.inputs || {};
    var names = [];
    for (var n in inputs) { if (inputs.hasOwnProperty(n)) names.push(n); }

    // Every socket that reads this node, and WHICH output slot it reads.
    var readers = [];
    var slotUsed = {};
    for (var cid in graph) {
      if (!graph.hasOwnProperty(cid)) continue;
      var c = graph[cid];
      if (!c || !c.inputs || cid === nid) continue;
      for (var ck in c.inputs) {
        if (!c.inputs.hasOwnProperty(ck)) continue;
        var v = c.inputs[ck];
        if (isLink(v) && String(v[0]) === nid) {
          var slot = Number(v[1]) || 0;
          readers.push({ cid: cid, key: ck, slot: slot });
          slotUsed[slot] = true;
        }
      }
    }
    var used = [];
    for (var su in slotUsed) {
      if (slotUsed.hasOwnProperty(su)) used.push(Number(su));
    }
    used.sort(function (a, b) { return a - b; });

    var isMap = !!passthrough && typeof passthrough === "object" &&
                !(passthrough instanceof Array);
    if (!passthrough || (typeof passthrough !== "string" && !isMap)) {
      throw new Error("Cannot bypass node " + nid + " (" + node.class_type +
        "): the manifest does not say which input passes through. Add " +
        "\"passthrough\" naming one of: " + names.join(", ") +
        (used.length > 1
          ? " — or, since consumers read output slots " + used.join(" and ") +
            ", a map of slot to input, e.g. {\"" + used[0] + "\": \"" +
            (names[0] || "…") + "\"}."
          : ""));
    }

    // slot -> the link that feeds it, all resolved BEFORE anything changes.
    var sourceOf = {};
    function resolve(slot, name) {
      if (!inputs.hasOwnProperty(name)) {
        throw new Error("Cannot bypass node " + nid + " (" + node.class_type +
          "): it has no input named \"" + name + "\". It has: " +
          (names.length ? names.join(", ") : "(none)"));
      }
      var src = inputs[name];
      // A literal cannot be handed to a downstream socket that wants a link,
      // so there is nothing to rewire TO. Say that instead of quietly
      // deleting the consumers' inputs and letting validation fail later.
      // A slot NOTHING reads needs no source at all — a terminal node is
      // removable whatever its inputs hold.
      if (!isLink(src)) {
        if (!slotUsed[slot]) return;
        throw new Error("Cannot bypass node " + nid + " (" + node.class_type +
          "): its \"" + name + "\" input is a literal value (" +
          JSON.stringify(src) + "), not a link from another node, so " +
          "consumers have nothing to rewire to.");
      }
      sourceOf[slot] = src;
    }

    if (isMap) {
      var mapped = [];
      for (var mk in passthrough) {
        if (!passthrough.hasOwnProperty(mk)) continue;
        mapped.push(Number(mk));
        resolve(Number(mk), passthrough[mk]);
      }
      for (var ui = 0; ui < used.length; ui++) {
        if (!sourceOf.hasOwnProperty(used[ui])) {
          throw new Error("Cannot bypass node " + nid + " (" +
            node.class_type + "): consumers read its output slot " +
            used[ui] + ", which the manifest's passthrough map does not " +
            "cover. It maps slot(s): " +
            (mapped.length ? mapped.join(", ") : "(none)") + ".");
        }
      }
    } else {
      resolve(0, passthrough);
      var wrong = [];
      for (var ri = 0; ri < readers.length; ri++) {
        if (readers[ri].slot !== 0) {
          wrong.push(readers[ri].cid + "." + readers[ri].key + " reads slot " +
                     readers[ri].slot);
        }
      }
      if (wrong.length) {
        throw new Error("Cannot bypass node " + nid + " (" + node.class_type +
          "): \"" + passthrough + "\" answers output slot 0, but " +
          wrong.join(", ") + ". This node emits more than one type, so one " +
          "input cannot stand in for all of them — give the manifest a " +
          "passthrough MAP of slot to input, e.g. {\"0\": \"" + passthrough +
          "\", \"" + used[used.length - 1] + "\": \"…\"}.");
      }
    }

    var rewired = [];
    for (var i = 0; i < readers.length; i++) {
      var r = readers[i];
      var src2 = sourceOf[r.slot];
      graph[r.cid].inputs[r.key] = [String(src2[0]), src2[1]];
      rewired.push(r.cid + "." + r.key + " -> " + src2[0] + ":" + src2[1]);
    }
    delete graph[nid];
    return { rewired: rewired };
  }

  /**
   * Coerce a literal widget value on the way into a substitute node's input.
   * ComfyLiterals' Float carries ".98" in a STRING widget; core PrimitiveFloat
   * wants a FLOAT, and validation rejects the string. Nothing is coerced
   * unless the manifest asks (`as`), and a link is never coerced at all — its
   * type is whatever its source emits, which this side cannot see.
   */
  function coerceInput(value, as, nid, from) {
    if (!as) return value;
    if (isLink(value)) {
      throw new Error("Cannot coerce node " + nid + " input \"" + from +
        "\" to " + as + ": it is a link from node " + value[0] + ", and a " +
        "link carries whatever type its source emits.");
    }
    if (as === "number" || as === "int") {
      var num = (typeof value === "number") ? value : parseFloat(String(value));
      if (!isFinite(num)) {
        throw new Error("Cannot coerce node " + nid + " input \"" + from +
          "\" to a number: its value is " + JSON.stringify(value) + ".");
      }
      return (as === "int") ? Math.round(num) : num;
    }
    if (as === "string") return String(value);
    if (as === "boolean") {
      return (value === true || value === 1 || value === "true");
    }
    throw new Error("Manifest substitute for node " + nid + " asks to coerce " +
      "\"" + from + "\" to unknown type \"" + as + "\". Known: number, int, " +
      "string, boolean.");
  }

  /**
   * Replace node `id` in place with a different class — the fallback for a
   * value SOURCE, which cannot be bypassed at all: a node whose only inputs
   * are literals has nothing for its consumers to be rewired TO. Consumers
   * keep pointing at the same id and the same socket, so only the class and
   * the input names change.
   * spec: {class, inputs: {<newName>: "<oldName>" | {from, as} | {const}}}.
   * Inputs the map does not name are DROPPED: a substitute class has its own
   * signature, and inheriting stray keys fails validation at the server.
   * Returns {carried: [...], dropped: [...]}. Throws grounded errors.
   */
  function substituteNode(graph, id, spec) {
    var nid = String(id);
    var node = graph[nid];
    if (!node) return null;
    var old = node.inputs || {};
    var names = [];
    for (var n in old) { if (old.hasOwnProperty(n)) names.push(n); }
    if (!spec || typeof spec["class"] !== "string" || spec["class"] === "") {
      throw new Error("Cannot substitute node " + nid + " (" + node.class_type +
        "): the manifest's substitute block names no replacement class.");
    }
    var map = spec.inputs || {};
    var next = {};
    var carried = [];
    var taken = {};
    for (var k in map) {
      if (!map.hasOwnProperty(k)) continue;
      var rule = map[k];
      if (rule && typeof rule === "object" && !(rule instanceof Array) &&
          rule.hasOwnProperty("const")) {
        next[k] = rule["const"];
        carried.push(k + " = " + JSON.stringify(rule["const"]));
        continue;
      }
      var from = (typeof rule === "string") ? rule : (rule ? rule.from : null);
      if (typeof from !== "string" || from === "") {
        throw new Error("Cannot substitute node " + nid + " (" +
          node.class_type + ") with " + spec["class"] + ": the rule for " +
          "input \"" + k + "\" names neither a source input (\"from\") nor a " +
          "literal (\"const\").");
      }
      if (!old.hasOwnProperty(from)) {
        throw new Error("Cannot substitute node " + nid + " (" +
          node.class_type + ") with " + spec["class"] + ": it has no input " +
          "named \"" + from + "\" to carry into \"" + k + "\". It has: " +
          (names.length ? names.join(", ") : "(none)"));
      }
      next[k] = coerceInput(old[from], (rule && rule.as) || null, nid, from);
      taken[from] = true;
      carried.push(k + " <- " + from);
    }
    var dropped = [];
    for (var d = 0; d < names.length; d++) {
      if (!taken[names[d]]) dropped.push(names[d]);
    }
    node.class_type = spec["class"];
    node.inputs = next;
    if (node._meta && node._meta.title) { node._meta.title = spec["class"]; }
    return { carried: carried, dropped: dropped };
  }

  /**
   * Honour the manifest's `optionalNodes` block: a node the template can run
   * without, because the pack that defines it is not on every machine.
   * Each entry: {nodeId, class, when?: "missing"|"always", reason?, keptNote?}
   * plus EITHER `passthrough` (drop the node, rewire consumers to that input)
   * OR `substitute` (swap the class for one the loader ships) — never both.
   * The default ("missing") asks the LIVE server, so the same template runs
   * on a machine with the pack and on one without it.
   * cb(err) — errors are grounded and fatal; this runs before any GPU time.
   */
  function resolveOptionalNodes(base, graph, manifest, applied, cb) {
    var list = manifest && manifest.optionalNodes;
    if (!(list instanceof Array) || list.length === 0) { cb(null); return; }
    var i = 0;
    (function next() {
      if (i >= list.length) { cb(null); return; }
      var entry = list[i++] || {};
      var nid = String(entry.nodeId);
      var node = graph[nid];
      if (!node) {
        // Another injection step already removed it (a detached reference
        // frame, say). Not an error, but not silent either.
        applied.push("optional node " + nid + " was already absent");
        next();
        return;
      }
      var cls = entry["class"] || node.class_type;
      if (entry["class"] && node.class_type !== entry["class"]) {
        // The sidecar and the template have drifted apart. Bypassing by id
        // alone here would delete whatever node inherited that id.
        cb(new Error("Manifest optionalNodes names node " + nid + " as " +
          entry["class"] + ", but this workflow's node " + nid + " is a " +
          node.class_type + ". Regenerate the API template from the " +
          "manifest's panelAdaptation, or fix the sidecar."));
        return;
      }
      if (entry.substitute && entry.passthrough) {
        cb(new Error("Manifest optionalNodes entry for node " + nid + " (" +
          cls + ") sets both \"passthrough\" and \"substitute\". They are " +
          "different answers to the same question — drop the node, or swap " +
          "its class. Pick one."));
        return;
      }
      function doDrop(why) {
        if (entry.substitute) { doSubstitute(why); return; }
        var r;
        try { r = bypassNode(graph, nid, entry.passthrough); }
        catch (e) { cb(e); return; }
        applied.push("bypassed optional node " + nid + " (" + cls + "): " +
          why + (entry.reason ? " — " + entry.reason : "") +
          (r && r.rewired.length ? "; rewired " + r.rewired.join(", ") : ""));
        next();
      }
      function doSubstitute(why) {
        var sub = entry.substitute;
        var subClass = sub ? sub["class"] : null;
        // The replacement must itself be installed, or the graph has traded
        // one missing class for another and only says so after the POST.
        classInstalled(base, String(subClass), function (sErr, subPresent) {
          if (sErr) { cb(sErr); return; }
          if (!subPresent) {
            cb(new Error("Node " + nid + " (" + cls + ") is not available on " +
              "this ComfyUI, and neither is the manifest's substitute for " +
              "it (" + subClass + "). Install the pack that provides " + cls +
              " — the manifest's customNodes block names it — or correct the " +
              "substitute."));
            return;
          }
          var r;
          try { r = substituteNode(graph, nid, sub); }
          catch (e) { cb(e); return; }
          applied.push("substituted optional node " + nid + " (" + cls +
            " -> " + subClass + "): " + why +
            (entry.reason ? " — " + entry.reason : "") +
            (r && r.carried.length ? "; carried " + r.carried.join(", ") : "") +
            (r && r.dropped.length ? "; dropped " + r.dropped.join(", ") : ""));
          next();
        });
      }
      if (entry.when === "always") { doDrop("manifest says always"); return; }
      classInstalled(base, cls, function (err, present) {
        if (err) { cb(err); return; }
        if (!present) { doDrop("not installed on this ComfyUI"); return; }
        applied.push("optional node " + nid + " (" + cls + ") is installed, " +
          "keeping it" + (entry.keptNote ? " — " + entry.keptNote : ""));
        next();
      });
    })();
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
   * Stop a prompt this panel queued and then gave up on.
   *
   * A timeout used to be pure ABANDONMENT: the panel stopped looking, the
   * job kept the card and kept computing, and the VRAM arbiter's very next
   * act was to reload the chat model into whatever was left. Measured
   * 2026-08-30 on a 32 GB card (logs/oom-probe-*): a KREA2 job the panel
   * timed out on at 90 s still held **23 673 MB** when llama-server was
   * asked to load a 18 932 MB model back into the same card, the "verified
   * release" wait burned its whole 10 s reporting a release that had not
   * happened, and the abandoned job went on grinding for another ten
   * minutes. On Windows the driver's system-memory fallback hid the
   * collision — the chat model "came back" spilled into host RAM.
   *
   * Never a blind POST /interrupt. This is the USER'S ComfyUI and they may
   * have queued their own work in its own UI, so the queue is READ first
   * and only our own prompt id is acted on:
   *   still pending  -> POST /queue {delete: [id]}  (id-targeted on every
   *                     ComfyUI version)
   *   still running  -> POST /interrupt {prompt_id} (targeted on 0.32; on
   *                     older builds that ignore prompt_id it is a global
   *                     interrupt, which by then cancels exactly the job we
   *                     mean, because we just proved ours is the running one)
   *   neither        -> nothing to do; it finished or was already dropped.
   *
   * cb(note) — a clause for the error message saying what was actually done.
   * Never fails the round: a backend that cannot be asked leaves the job
   * alone and says so.
   */
  function cancelPrompt(base, promptId, cb) {
    requestJson(base, "GET", "/queue", null, 10000,
      function (err, statusCode, json) {
        if (err || statusCode !== 200 || !json) {
          cb(" — ComfyUI's queue could not be read, so it was left alone " +
             "and may still be running");
          return;
        }
        // Queue rows are positional: [number, prompt_id, prompt, ...].
        function holds(list) {
          if (!(list instanceof Array)) return false;
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i][1] === promptId) return true;
          }
          return false;
        }
        if (holds(json.queue_pending)) {
          requestJson(base, "POST", "/queue", { "delete": [promptId] }, 10000,
            function (dErr, dStatus) {
              cb(dErr || dStatus !== 200
                ? " — it was still queued and ComfyUI refused to drop it"
                : " — it was still queued and has been removed");
            });
          return;
        }
        if (holds(json.queue_running)) {
          requestJson(base, "POST", "/interrupt", { prompt_id: promptId },
            10000, function (iErr, iStatus) {
              cb(iErr || iStatus !== 200
                ? " — it is still running and ComfyUI refused to cancel it"
                : " — it was still running and has been cancelled");
            });
          return;
        }
        cb(" — ComfyUI is no longer running it");
      });
  }

  /**
   * What the job had done when the timeout cancelled it, so the message
   * reads as a LIMIT the user can raise rather than a hang (§18 P3c).
   * Empty when no step was ever reported: a guess here would be the
   * number the user sizes the new timeout on.
   */
  function timeoutProgressNote(progress) {
    if (!progress || !(progress.max > 1)) return "";
    var pct = Math.round(100 * progress.value / progress.max);
    return " — it was at step " + progress.value + "/" + progress.max +
      " (" + pct + "%)" +
      (progress.etaSec > 0
        ? ", projected to need about " + progress.etaSec + "s more"
        : "");
  }
  var TIMEOUT_HINT = ". This is a limit, not a hang: raise Settings > " +
    "Generation timeout (s) to let it finish";

  /**
   * End-to-end generation.
   * opts: {comfyUrl, workflowFile, params, outDir, timeoutSec}
   * onProgress(secondsElapsed, progress) fires periodically while waiting.
   * progress is {value, max, node, etaSec} once ComfyUI has reported a step
   * for the running node, and null until then — and on any build or network
   * where the event socket never comes up, which is why no caller may
   * depend on it.
   * cb(err, {files: [absolute paths], applied: [...], promptId})
   * cb fires exactly once.
   */
  function generate(opts, onProgress, cb) {
    ensureNode();
    var base = parseBase(opts.comfyUrl);
    var params = opts.params || {};
    var manifest = opts.manifest !== undefined
      ? opts.manifest : readManifest(opts.workflowFile);

    var graph, applied;

    // A reference image has to exist inside ComfyUI's input folder before the
    // graph can name it, so the upload happens before any grafting.
    if (typeof params.image === "string" && params.image !== "") {
      uploadImage(base, params.image, function (upErr, name) {
        if (upErr) { cb(upErr); return; }
        params.imageName = name;
        start();
      });
      return;
    }
    start();

    function start() {
      try {
        graph = loadWorkflow(opts.workflowFile);
      } catch (e) {
        cb(e);
        return;
      }
      // A comp to place into sets the size when the caller named none;
      // it reads the node's step from the live server, so it is async.
      applyCompSize(base, graph, params, manifest, function (sizeNote) {
        try {
          applied = injectParams(graph, params, manifest);
        } catch (e) {
          cb(e);
          return;
        }
        if (sizeNote) applied.unshift(sizeNote);
        // Optional nodes are resolved against the LIVE server, so this has
        // to happen after grafting and before queueing — it is the only
        // step that can tell whether a pack the template names exists on
        // THIS machine.
        resolveOptionalNodes(base, graph, manifest, applied, function (oErr) {
          if (oErr) { cb(oErr); return; }
          queueIt();
        });
      });
    }

    function queueIt() {
    // Both landed checks run BEFORE token expansion: expandFilenameTokens
    // rewrites every literal string input it recognizes, so a prompt that
    // happens to contain a resolvable %token% would no longer match the
    // injected text verbatim and a healthy round would be refused. The
    // checks still run after injectParams AND resolveOptionalNodes, so a
    // node a later step took back out is still caught.

    // A prompt that lands nowhere means the render would use the template's
    // baked-in text — fail fast instead of burning GPU minutes on it.
    // An H3 prompt is reshaped on the way in, so look for what was sent.
    if (typeof params.prompt === "string" && params.prompt !== "" &&
        !graphCarriesValue(graph, (applied && typeof applied.promptSent ===
          "string") ? applied.promptSent : params.prompt)) {
      cb(new Error("This workflow has no editable prompt text (its text " +
        "widget may be converted to a non-literal input). Un-convert it " +
        "in ComfyUI and re-export, or use another template."));
      return;
    }

    // An image that lands nowhere is worse: the upload succeeded, so
    // everything up to here looked right, and the render would finish —
    // as text-to-image, the reference silently ignored. The only route an
    // image takes into a graph is a manifest's procedural.firstFrame, so
    // the refusal names the templates that have one.
    if (typeof params.imageName === "string" && params.imageName !== "" &&
        !graphCarriesValue(graph, params.imageName)) {
      var wfName = path.basename(String(opts.workflowFile || ""))
                       .replace(/\.json$/i, "");
      var capable = imageCapableWorkflows(
        path.dirname(String(opts.workflowFile || "")));
      var shownCap = capable.slice(0, COMFY_LIST_LIMIT);
      cb(new Error("Workflow '" + wfName + "' has no image input — the " +
        "uploaded reference (" + params.imageName + ") reached ComfyUI " +
        "but lands on no node of this graph, so the render would have " +
        "ignored it and run as text-to-image. Use a template whose " +
        "manifest declares procedural.firstFrame" +
        (capable.length
          ? ": " + shownCap.join(", ") +
            (capable.length > shownCap.length
              ? " (showing " + shownCap.length + " of " + capable.length +
                "; comfy_list_workflows lists all)"
              : "")
          : " — none of the templates alongside this one do") +
        ". Or re-call without an image."));
      return;
    }

    // Last thing before the POST, exactly where the browser does it: a
    // %date:…% left in a filename_prefix kills the render at its final
    // node, after every GPU second has already been spent.
    var expanded = expandFilenameTokens(graph, new Date());
    for (var ei = 0; ei < expanded.length; ei++) {
      applied.push("filename token expanded — " + expanded[ei]);
    }

    var clientId = "aellama-" + Math.floor(Math.random() * 1e9);

    // Subscribed BEFORE the queue POST, not after: on a warm backend the
    // first sampling steps land inside the same second the prompt is
    // accepted, and a socket opened afterwards misses them. ComfyUI
    // addresses these events to our clientId alone, so nothing another
    // client queued can reach this tracker.
    var tracker = makeProgressTracker(null);
    var events = onProgress
      ? openEventSocket(base, clientId, tracker.accept)
      : { close: function () {} };

    requestJson(base, "POST", "/prompt",
      { prompt: graph, client_id: clientId }, 30000,
      function (err, statusCode, json, rawText) {
        if (err) {
          events.close();
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
          events.close();
          cb(new Error("ComfyUI rejected the workflow: " + detail));
          return;
        }

        // Partial validation: valid branches queued, broken ones dropped.
        // Surface what was skipped alongside the eventual result — and
        // keep it, because when EVERY output branch is dropped this is the
        // only account of why the run produced nothing.
        var skipped = "";
        if (json.node_errors) {
          skipped = describeNodeErrors(json.node_errors);
          if (skipped) applied.push("WARNING skipped branches: " + skipped);
        }

        var promptId = json.prompt_id;
        tracker.setPromptId(promptId);
        var startedAt = Date.now();
        var lastProgressAt = startedAt;
        var POLL_MS = 2000;
        var timeoutMs = (opts.timeoutSec > 0 ? opts.timeoutSec : 600) * 1000;

        // cb must fire exactly once, and no work may happen after settling —
        // in-flight /history responses can land after the timer is cleared.
        var finished = false;
        var inFlight = false;
        var cancelling = false;
        var timer = null;

        function settle(err2, res2) {
          if (finished) return;
          finished = true;
          if (timer) global.clearInterval(timer);
          events.close();
          cb(err2, res2);
        }

        timer = global.setInterval(function () {
          if (finished) return;
          var elapsed = Date.now() - startedAt;
          if (onProgress && Date.now() - lastProgressAt >= 10000) {
            lastProgressAt = Date.now();
            onProgress(Math.round(elapsed / 1000), tracker.read());
          }
          if (elapsed >= timeoutMs) {
            // Stop looking AND stop the job — see cancelPrompt. The cancel
            // is awaited before settling so the arbiter's resume, which
            // runs next and waits for the card to come back to the floor,
            // is waiting for something that can actually happen.
            if (cancelling) return;
            cancelling = true;
            var secs = Math.round(elapsed / 1000);
            var atTimeout = timeoutProgressNote(tracker.read());
            cancelPrompt(base, promptId, function (note) {
              settle(new Error("Generation timed out after " + secs +
                               "s (prompt " + promptId + ")" + atTimeout +
                               note + (atTimeout ? TIMEOUT_HINT : "")));
            });
            return;
          }
          if (inFlight) return;
          inFlight = true;
          requestJson(base, "GET", "/history/" + promptId, null, 10000,
            function (herr, hstatus, hjson) {
              inFlight = false;
              // A poll issued just before the timeout can land while the
              // cancel is in flight. Let the timeout own the message —
              // "timed out and has been cancelled" is the truth, where
              // this path would report the panel's own interrupt back to
              // the user as if ComfyUI had been cancelled from elsewhere.
              if (finished || cancelling) return;
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
                // ComfyUI QUEUES a prompt whose outputs all failed
                // validation, runs it in ~0.01 s and reports it complete
                // with no error and no outputs. Measured 2026-08-30: a
                // CLIPLoader type the backend does not know dropped all
                // five output branches and the panel blamed a missing
                // SaveImage node — the real reason was in node_errors at
                // queue time and had been thrown away. Say what ComfyUI
                // said.
                settle(new Error(skipped
                  ? "ComfyUI dropped every output branch of this workflow " +
                    "when it validated it, so nothing was rendered: " +
                    skipped
                  : "Workflow finished but produced no output files (no " +
                    "SaveImage/SaveVideo node?)"));
                return;
              }
              // Terminal success path: latch BEFORE the downloads so a
              // straggler poll response can't start a second download chain.
              if (finished) return;
              finished = true;
              global.clearInterval(timer);
              // This path latches without going through settle(), so the
              // event socket has to be released here too — otherwise every
              // SUCCESSFUL generation leaks one for the life of the panel,
              // and only the failures clean up after themselves.
              events.close();
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
  }

  // ---------------------------------------------------------------- status

  function status(comfyUrl, cb, settings) {
    var s = settings;
    if (!s) {
      try { s = global.Settings.get() || {}; } catch (eS) { s = {}; }
    }
    var mode = backendMode(s);
    var base = parseBase(comfyUrl);
    requestJson(base, "GET", "/queue", null, 5000,
      function (err, statusCode, json) {
        if (err || statusCode !== 200 || !json) {
          var hasHidden = false;
          try {
            hasHidden = !!(global.Setup && global.Setup.findComfyInstall &&
                           global.Setup.findComfyInstall());
          } catch (eH) {}
          // A ComfyUI on this machine at another port outranks both
          // canned hints: it is the one thing the user can act on in one
          // setting change. In MANAGED mode it is an OFFER — the panel
          // has its own backend and will not switch on its own — and in
          // OWN mode it is the URL correction it always was.
          findLocalComfy(base, function (found) {
            cb(null, { online: false, url: comfyUrl, target: base.label,
                       backend: mode,
                       hiddenBackendInstalled: hasHidden,
                       foundAt: found ? found.url : null,
                       hint: found
                         ? elsewhereHint(base, found, mode)
                         : (hasHidden
                             ? "Hidden backend installed — it boots " +
                               "automatically on the next generation request."
                             : "Start ComfyUI (Launch button in settings, " +
                               "or manually), or install the hidden backend " +
                               "in Settings → ComfyUI (tried " + base.label +
                               ").") });
          });
          return;
        }
        var running = json.queue_running instanceof Array
          ? json.queue_running.length : 0;
        var pending = json.queue_pending instanceof Array
          ? json.queue_pending.length : 0;
        cb(null, { online: true, url: comfyUrl, target: base.label,
                   backend: mode, running: running, pending: pending });
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

  // How long stopManaged() may block. It runs inside the panel's `unload`
  // handler, which After Effects waits on while it is trying to quit, so
  // every millisecond here is a millisecond of an AE that looks hung to
  // the user -- no dialog, Responding = True, ignoring File > Exit.
  //
  // The old numbers were 30 000 for the taskkill and 20 000 for the
  // residual wait: ~50 seconds of a shutdown that cannot be cancelled,
  // against a measured happy path of 110 ms (17q-d -- a synchronous
  // taskkill returns with the process already gone, 0.2 ms of residual
  // wait). The bounds existed for a pathological backend and were paid
  // for by every ordinary quit.
  //
  // Giving up early is safe and that is what makes these numbers
  // affordable: stopManaged() returns false and KEEPS the pid record, and
  // reapOrphan() reads that same key at the next init. The worst case of
  // a short budget is a backend collected one launch later. The worst
  // case of a long one is the owner force-killing After Effects, which is
  // how a stale record gets written in the first place.
  var OWNERSHIP_MS = 4000;   // one Get-CimInstance read
  var KILL_MS      = 5000;   // taskkill /T /F
  var RESIDUAL_MS  = 2000;   // the rare "taskkill asked but it is not gone yet"
  var managedProc = null;
  var startWaiters = null;   // non-null while a boot is in flight

  /*
   * Does the backend outlive the process that spawned it? Measured
   * 2026-09-09 on this machine: a Node child spawned WITHOUT
   * `detached: true` is killed the moment its parent exits — libuv puts
   * it in the parent's Windows job object, and `unref()` does not change
   * that (the probe ran both ways with identical unref() calls; the
   * plain child was gone, the detached one alive).
   *
   * The PANEL wants the default, false: `unload` calls stopManaged() so
   * closing AE frees the backend's VRAM, and reapOrphan() at init is the
   * safety net for when CEP does not fire unload.
   *
   * A SCRIPT wants true. `comfy-install.js --boot` exists to leave a
   * backend up for later passes and prints "the backend is STILL
   * RUNNING"; measured 2026-09-09 it was already dead, killed by the job
   * object as the script exited. The 2026-09-06 fix in
   * scripts/lib/comfy-managed.js made the PID RECORD survive the
   * process, which is only half of it — the record then named a corpse.
   * Scripts opt in through setManagedDetached(); nothing is written to
   * the user's settings, because this is a property of the launcher and
   * not of their install.
   */
  var managedDetached = false;
  function setManagedDetached(on) { managedDetached = !!on; }

  /*
   * A DETACHED backend needs a real stdio sink, and this is a
   * correctness fix before it is a diagnostic one.
   *
   * Measured 2026-09-09: with the default PIPED stdio, a backend that
   * outlives its launcher inherits pipes whose reader is gone. ComfyUI's
   * progress bar calls sys.stderr.flush() the moment sampling starts,
   * Windows answers a dead pipe with OSError [Errno 22] Invalid
   * argument, and the prompt dies at the first sampler node — so EVERY
   * generation on a script-booted backend failed, in the one
   * configuration no user's panel uses and every unattended pass does.
   * The §17f sampler bug HID this: it stopped KREA2 at validation, so
   * nothing had ever reached a sampler on a detached backend.
   *
   * `stdio: "ignore"` would fix that alone and leave §17j's other half
   * (a backend that dies half an hour later leaves no evidence at all)
   * exactly as it was. A FILE fixes both. The panel path keeps its
   * in-memory errTail — there the host process is alive to read it.
   */
  function managedLogPath() {
    var root = null;
    try { root = global.Settings.dataRoot(); } catch (e) { return null; }
    if (!root) return null;
    return path.join(root, "comfy-managed.log");
  }

  /* One generation of rotation, so the boot that comes to investigate a
   * death does not erase it. Two bounded files; appending forever grows
   * without limit across months of launches. */
  function openManagedLog(p) {
    if (!p) return null;
    try {
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (eD) {}
      if (fs.existsSync(p)) {
        var prev = p.replace(/\.log$/, ".prev.log");
        try { if (fs.existsSync(prev)) fs.unlinkSync(prev); } catch (e1) {}
        try { fs.renameSync(p, prev); } catch (e2) {}
      }
      var fd = fs.openSync(p, "a");
      fs.writeSync(fd, "=== AE Llama managed backend, booted " +
                       new Date().toISOString() + " ===\r\n");
      return fd;
    } catch (e) { return null; }
  }

  /** The last `n` bytes of the managed log — the detached errTail. */
  function managedLogTail(p, n) {
    if (!p) return "";
    try {
      var txt = String(fs.readFileSync(p, "utf8") || "");
      return txt.length > n ? txt.slice(-n) : txt;
    } catch (e) { return ""; }
  }

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
            // VERIFY, then forget — never the other way round (§17q-d).
            // This is the panel's only recovery from its own orphan: an
            // orphan on the managed port makes ensureRunning refuse to
            // generate, and the PID record is the only thing that can
            // find it. Dropping the record after a kill that did not
            // take would strand the user with no path back.
            //
            // Async all the way here, unlike stopManaged(): reapOrphan
            // runs at init with a callback, so waiting costs nothing but
            // wall time on a timer.
            var tries = 0;
            (function check() {
              if (!pidAlive(pid)) { forgetPid(); if (done) done(true); return; }
              if (++tries > 20) { if (done) done(false); return; }
              global.setTimeout(check, 250);
            })();
          });
      });
  }

  function isUp(base, cb) {
    requestJson(base, "GET", "/system_stats", null, 4000,
      function (err, statusCode) { cb(!err && statusCode === 200); });
  }

  /*
   * The panel's URL setting is dead — is a ComfyUI running on this machine
   * anyway? Measured on the owner's machine 2026-08-28: comfyUrl said
   * 8000, a ComfyUI was answering on 8188, and the panel told them to
   * install a hidden backend they did not need. That is the ungrounded
   * error this project does not ship: a failed lookup names what actually
   * exists.
   *
   * Deliberately narrow. Localhost only (scanning a remote host's ports is
   * not the panel's business), the well-known ComfyUI ports only, and
   * only AFTER the configured URL has already failed. It REPORTS what it
   * finds and never reroutes: silently rendering on a different ComfyUI
   * than the user configured would swap the model set under them.
   *
   * 8000 earns its place the same way: the owner's own machine moved
   * ComfyUI there (2026-09-01), and it is what `--port 8000` gives a
   * launcher that avoids the default. A false positive costs nothing —
   * isUp() only believes a host that answers /system_stats with 200,
   * which no plain web server on 8000 does.
   */
  var LOCAL_COMFY_PORTS = [8188, 8189, 8000];

  function findLocalComfy(base, cb) {
    var localBase = base.host === "127.0.0.1" || base.host === "localhost";
    var ports = [];
    for (var i = 0; i < LOCAL_COMFY_PORTS.length; i++) {
      if (!localBase || LOCAL_COMFY_PORTS[i] !== base.port) {
        ports.push(LOCAL_COMFY_PORTS[i]);
      }
    }
    (function next(k) {
      if (k >= ports.length) { cb(null); return; }
      var probe = { isHttps: false, host: "127.0.0.1", port: ports[k],
                    label: "127.0.0.1:" + ports[k],
                    url: "http://127.0.0.1:" + ports[k] };
      isUp(probe, function (up) {
        if (up) { cb(probe); return; }
        next(k + 1);
      });
    })(0);
  }

  /** The sentence a user can act on, once findLocalComfy has an answer. */
  function elsewhereHint(base, found, mode) {
    if (mode === "managed") {
      // The panel has its own backend; this is an offer, not a fix.
      return "The panel's own ComfyUI is not running at " + base.label +
        " yet — it boots on the next generation. A DIFFERENT ComfyUI is " +
        "answering at " + found.label + ": to use that one instead, " +
        "switch Settings → ComfyUI to 'Use my own ComfyUI' and set the " +
        "URL to " + found.url + ". The panel will not switch on its own.";
    }
    return "Nothing is listening at " + base.label + ", but a ComfyUI IS " +
      "answering at " + found.label + ". Set the ComfyUI URL in Settings " +
      "to " + found.url + " — the panel will not switch to it on its own.";
  }

  /**
   * Point the hidden backend at the user's external models folder (they
   * get big) via ComfyUI's own extra_model_paths.yaml mechanism. The yaml
   * lives inside OUR vendor install, so it is safe to (re)write on every
   * boot; blank setting = the backend's built-in models folder only —
   * plus the Comfy-Desktop shared store below, when the machine has one,
   * and the checkpoints-as-diffusion-models line (pushModelSubs).
   */
  var COMFY_MODEL_SUBS = ["checkpoints", "diffusion_models", "text_encoders",
    "clip", "clip_vision", "vae", "loras", "controlnet", "upscale_models",
    "embeddings"];
  /**
   * A whole-checkpoint file is ALSO a diffusion model to this backend, and
   * one shipped graph depends on it (AE_LLAMA_SDXL_FP8_T2I_V1, WORKPLAN 18
   * P7c step 2g). Core UNETLoader is the only node that casts weights on
   * load, it lists only `diffusion_models`, and the vendor's
   * load_diffusion_model_state_dict pulls the UNet out of a whole
   * checkpoint. So every `checkpoints` folder this yaml maps is mapped as a
   * `diffusion_models` folder too, AFTER the real one: a name found in both
   * resolves to the real diffusion file (folder_paths.get_full_path takes
   * the first hit). The alternative was a second 6.6 GB download of a file
   * the user already has. The vendor utils/extra_config.py splits each
   * value on newlines, hence the block scalar.
   */
  function pushModelSubs(lines) {
    for (var k = 0; k < COMFY_MODEL_SUBS.length; k++) {
      var sub = COMFY_MODEL_SUBS[k];
      if (sub === "diffusion_models") {
        lines.push("  diffusion_models: |");
        lines.push("    diffusion_models");
        lines.push("    checkpoints");
      } else {
        lines.push("  " + sub + ": " + sub);
      }
    }
  }
  function applyExtraModelPaths(install) {
    ensureNode();
    var s = null;
    try { s = global.Settings.get() || {}; } catch (e) { s = {}; }
    var dir = String(s.comfyModelsDir || "");
    // ComfyUI veterans have models spread across drives — extra roots,
    // one per line in settings, each either a whole models tree or a
    // per-kind folder written as "kind=path" (e.g.
    // "checkpoints=D:\\SD\\ckpts").
    var roots = s.comfyModelRoots instanceof Array ? s.comfyModelRoots : [];
    // The Comfy-Desktop app's shared auto-download store. Weights the
    // Desktop downloader already fetched live here and are declared in no
    // config file, so without this section the hidden backend prices a
    // job the panel can see and then cannot load it (the H3 gap, measured
    // 2026-08-30). Search it, read-only; never a download target.
    var sharedStore = null;
    try {
      var proc = global.AEBridge.nodeRequire("process");
      var localApp = proc.env && proc.env.LOCALAPPDATA;
      if (localApp) {
        var cand = path.join(localApp, "Comfy-Desktop", "ComfyUI-Shared",
                             "models");
        if (fs.existsSync(cand)) sharedStore = cand;
      }
    } catch (eP) {}
    var yamlPath = path.join(install.root, "ComfyUI",
                             "extra_model_paths.yaml");
    // A root already written, by kind + folder, so a tree reached two
    // ways (settings AND a config file) is one section.
    var written = {};
    function rootSig(kind, p) {
      return String(kind) + "|" +
        String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    }
    try {
      var i;
      var lines = [
        "# Managed by AE Llama — external model folders (panel settings)"
      ];
      if (dir) {
        written[rootSig(null, dir)] = true;
        // The primary folder is ours to manage: create the layout so
        // downloads have somewhere to land.
        for (i = 0; i < COMFY_MODEL_SUBS.length; i++) {
          var d = path.join(dir, COMFY_MODEL_SUBS[i]);
          if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        }
        lines.push("aellama:");
        lines.push("  base_path: " + dir.replace(/\\/g, "/"));
        pushModelSubs(lines);
      }
      // Extra roots are the USER's folders — read from, never restructured.
      var n = 0;
      for (i = 0; i < roots.length; i++) {
        var raw = String(roots[i] || "").replace(/^\s+|\s+$/g, "");
        if (!raw) continue;
        // "kind=path" maps ONE kind; a drive letter ("D:\...") is not a
        // kind, so only [a-z_]+ before the first '=' counts.
        var m = raw.match(/^([a-z_]+)=(.+)$/);
        var kind = m ? m[1] : null;
        var root = (m ? m[2] : raw).replace(/^\s+|\s+$/g, "");
        if (!root) continue;
        written[rootSig(kind, root)] = true;
        lines.push("aellama_extra_" + n + ":");
        lines.push("  base_path: " + root.replace(/\\/g, "/"));
        if (kind) {
          lines.push("  " + kind + ": .");
          if (kind === "checkpoints") lines.push("  diffusion_models: .");
        } else {
          pushModelSubs(lines);
        }
        n++;
      }
      if (sharedStore) {
        lines.push("comfy_desktop_shared:");
        lines.push("  base_path: " + sharedStore.replace(/\\/g, "/"));
        pushModelSubs(lines);
        written[rootSig(null, sharedStore)] = true;
      }
      // Every OTHER root the panel prices from (Tools.comfyModelRoots):
      // the user's own ComfyUI's models tree and the roots its config
      // files declare. Without these a weight found only there is counted
      // present, priced, and skipped by the downloader, yet this backend
      // cannot load it (measured 2026-09-17, WORKPLAN NEXT UP 31: a
      // sentinel in Documents/ComfyUI/models/checkpoints was found by
      // findWeightFile and missing from CheckpointLoaderSimple). The
      // backend's own tree is its default already; a folder that does not
      // exist is skipped.
      var ownTree = rootSig(null, path.join(install.root, "ComfyUI", "models"));
      var known = [];
      try {
        known = global.Tools && global.Tools.comfyModelRoots
          ? global.Tools.comfyModelRoots(s) || [] : [];
      } catch (eT) { known = []; }
      var c = 0;
      for (i = 0; i < known.length; i++) {
        var kr = known[i] || {};
        if (!kr.path) continue;
        var kk = kr.kind === null || kr.kind === undefined ? null
          : String(kr.kind);
        if (kk !== null && !/^[a-z_]+$/.test(kk)) continue;
        var sig = rootSig(kk, kr.path);
        if (written[sig] || sig === ownTree) continue;
        if (!fs.existsSync(kr.path)) continue;
        written[sig] = true;
        lines.push("aellama_found_" + c + ":");
        lines.push("  base_path: " + String(kr.path).replace(/\\/g, "/"));
        if (kk) {
          lines.push("  " + kk + ": .");
          if (kk === "checkpoints") lines.push("  diffusion_models: .");
        } else {
          pushModelSubs(lines);
        }
        c++;
      }
      // Always written, even with every setting blank: the backend's OWN
      // models/checkpoints is not a diffusion_models folder by default,
      // and a user's sdxl checkpoint usually lands exactly there. LAST,
      // because ComfyUI searches sections in file order and every real
      // diffusion_models folder above must win a name clash. Relative, so
      // it resolves against this yaml's own folder.
      lines.push("aellama_managed:");
      lines.push("  diffusion_models: models/checkpoints");
      fs.writeFileSync(yamlPath, lines.join("\n") + "\n");
      return yamlPath;
    } catch (e2) {
      return null;
    }
  }

  /**
   * Ask ComfyUI to drop its cached models and free VRAM. After a
   * generation the models stay resident, and on exclusive tiers that
   * cache is exactly what blocks the chat model from coming back — the
   * arbiter calls this before restarting llama. Best effort: /free
   * exists in current builds, but an older backend answering 404 must
   * not break the resume, so cb(err|null) and the caller continues
   * either way.
   */
  function freeVram(comfyUrl, cb) {
    ensureNode();
    var base = parseBase(comfyUrl);
    requestJson(base, "POST", "/free",
      { unload_models: true, free_memory: true }, 10000,
      function (err, statusCode) {
        if (err) { cb(err); return; }
        cb(statusCode >= 200 && statusCode < 300
          ? null
          : new Error("ComfyUI /free answered HTTP " + statusCode));
      });
  }

  /**
   * Make sure a ComfyUI answers where this panel expects one.
   *
   * MANAGED mode: the panel owns its port. Something already answering
   * there is ours if we started it (this session, or a previous one whose
   * PID we remembered) — and, since §17q-e, also when the process holding
   * the port RUNS OUT OF the managed install folder. That last case is
   * adoption, and it is not the defect the old default shipped: that one
   * attached to any server at a URL, deciding from an HTTP answer. This
   * one asks the OS whose process it is and only takes back a backend
   * this panel's own install could have produced.
   *
   * Anything else is REFUSED, in today's wording, because the refusal is
   * what protects the owner's own ComfyUI on his own port (§17q-c).
   * Foreign instances on other ports are ignored here by design; status()
   * offers them as a mode switch instead.
   *
   * OWN mode: unchanged. Whatever answers at comfyUrl is used as-is, a
   * ComfyUI found on another local port is named rather than adopted,
   * and the vendor install is the fallback.
   */
  function ensureRunning(comfyUrl, onStatus, cb, settings) {
    ensureNode();
    var s = settings;
    if (!s) {
      try { s = global.Settings.get() || {}; } catch (eS0) { s = {}; }
    }
    var managed = backendMode(s) === "managed";
    var base = parseBase(comfyUrl);
    function say(t) { if (onStatus) onStatus(t); }
    isUp(base, function (up) {
      if (up) {
        if (!managed || ownsManagedBackend()) {
          cb(null, { started: false });
          return;
        }
        // Managed, the port answers, and the BOOKKEEPING says it is not
        // ours. Ask the OS before believing that: an orphan of our own
        // install looks identical from here (§17q-e).
        adoptablePid(base.port, function (pid) {
          if (pid) {
            rememberPid(pid);
            say("Reconnected to the hidden ComfyUI backend already " +
                "running on " + base.label + ".");
            cb(null, { started: false, adopted: true });
            return;
          }
          // Not ours. Refusing is the whole point of owning a port:
          // attaching here is the bug the mode exists to remove, wearing
          // a different port number.
          cb(new Error("Something is already answering on " + base.label +
            ", the port this panel's own ComfyUI uses, and the panel did " +
            "not start it. Change 'Managed backend port' in Settings → " +
            "ComfyUI, or switch to 'Use my own ComfyUI' and point the URL " +
            "at it."));
        });
        return;
      }
      if (managed) {
        bootManaged(base, say, cb);
        return;
      }
      // Before refusing, look: a running ComfyUI at another local port
      // makes both refusals below wrong advice.
      findLocalComfy(base, function (found) {
      if (found) {
        cb(new Error(elsewhereHint(base, found)));
        return;
      }
      if (base.host !== "127.0.0.1" && base.host !== "localhost") {
        cb(new Error("ComfyUI at " + base.label + " is not responding, " +
          "and a remote instance cannot be auto-started. Start it there, " +
          "or point the URL at 127.0.0.1 to use the hidden backend."));
        return;
      }
      bootManaged(base, say, cb);
      });   // findLocalComfy
    });
  }

  /**
   * Is the thing answering on the managed port OURS? We started it this
   * session (managedProc), or a previous session did and its PID is
   * still remembered — reapOrphan clears that key at init when the PID
   * is not a ComfyUI, so a stale one does not linger. There is no way to
   * ask a server over HTTP who started it, which is exactly why the
   * panel owns a port instead of asking.
   */
  function ownsManagedBackend() {
    if (managedProc) return true;
    var pid = null;
    try { pid = parseInt(global.localStorage.getItem(COMFY_PID_KEY), 10); }
    catch (e) {}
    return !!pid;
  }

  /**
   * Where the MANAGED backend is installed — the ownership predicate of
   * §17q-c, ASKED rather than re-derived. setup.js's comfyVendorDir() is
   * the folder bootstrapComfy() really extracts into; joining
   * dataRoot + "vendor" + "comfy" a second time here is exactly how two
   * copies drift apart, and a guard aimed at the wrong folder matches
   * nothing and is silent about it.
   *
   * null means "cannot prove ownership", and the one caller treats that
   * as REFUSE — never as "no restriction".
   */
  function managedRootDir() {
    try {
      return (global.Setup && global.Setup.comfyVendorDir)
        ? (global.Setup.comfyVendorDir() || null) : null;
    } catch (e) { return null; }
  }

  /** Does `cmdline` run out of `root`? Windows paths: case/slash-blind. */
  function commandLineIsUnder(cmdline, root) {
    if (!root) return false;
    function norm(v) {
      return String(v || "").replace(/\//g, "\\").toLowerCase();
    }
    return norm(cmdline).indexOf(norm(root)) !== -1;
  }

  /**
   * Is the process holding `port` a backend this panel may ADOPT?
   * cb(pid) when it is, cb(null) when it is not.
   *
   * §17q-e. `ownsManagedBackend()` answers from localStorage, and there
   * are three ordinary ways for that record to be gone while the process
   * on the port is unmistakably ours: the panel crashed with a backend
   * up, a second panel session (localStorage is per-host), or the
   * recycled-PID branch cleared the record while the real backend was
   * still booting. In every one of them the user got a refusal with no
   * path forward — generation bricked until someone killed a python
   * process they never launched.
   *
   * TWO guards, the same pair stopByPort uses and for the same reason:
   * the command-line SHAPE (/ComfyUI/i) is not ownership, because the
   * owner's own ComfyUI on the configured port is ComfyUI-shaped too. It
   * must also run out of the managed root. Adoption is the mirror of a
   * kill: both are "this process is ours", and getting it wrong here
   * hands a stranger's server the panel's trust.
   */
  function adoptablePid(port, cb) {
    ensureNode();
    var root = managedRootDir();
    if (!root) { cb(null); return; }
    var n = parseInt(port, 10);
    if (!(n > 0)) { cb(null); return; }
    child_process.execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "$p=(Get-NetTCPConnection -LocalPort " + n +
       " -State Listen -ErrorAction SilentlyContinue).OwningProcess; " +
       "if ($p) { (Get-CimInstance Win32_Process -Filter " +
       "\"ProcessId=$p\").CommandLine + '|' + $p }"],
      { timeout: 15000 },
      function (err, stdout) {
        if (err) { cb(null); return; }
        var out = String(stdout || "").trim();
        var cut = out.lastIndexOf("|");
        if (!out || cut === -1) { cb(null); return; }
        var cmdline = out.slice(0, cut);
        var pid = parseInt(out.slice(cut + 1).trim(), 10);
        if (!(pid > 0) || !/ComfyUI/i.test(cmdline)) { cb(null); return; }
        if (!commandLineIsUnder(cmdline, root)) { cb(null); return; }
        cb(pid);
      });
  }

  /**
   * The managed backend's command line. `--disable-pinned-memory` is
   * there because pinned staging is not safe under host-RAM pressure:
   * measured 2026-09-16 (WORKPLAN 18 P7c step 2g, 5a-4d), Wan 2.2 5B on
   * a box with 16 GB of RAM rendered a DIFFERENT clip on each of two
   * runs, one visibly degraded, with no error anywhere. The same box with
   * the flag was frame-identical, and the flag cost no measurable speed.
   * A wrong picture with no error is worse than a slow one, so it is
   * unconditional. Only OUR backend gets it; a user's own ComfyUI is left alone.
   */
  function managedBootArgs(install, base, ckAttention) {
    var a = ["-s", install.mainPy, "--windows-standalone-build",
             "--port", String(base.port), "--listen", "127.0.0.1",
             "--disable-auto-launch", "--disable-pinned-memory"];
    if (ckAttention) a.push("--use-ck-attention");
    return a;
  }

  /*
   * Can this machine run ComfyUI's core INT8 attention kernel
   * (`--use-ck-attention`)? Measured 2026-09-16 (WORKPLAN 13a, NEXT UP
   * 7/7a) on the managed ComfyUI 0.34.0: Wan 2.2 5B renders ~23 % faster
   * with no VRAM change and an equal-quality sample, and nothing is
   * installed -- comfy_kitchen is a core dependency.
   *
   * It is ASKED, never assumed, because the flag is FATAL where the
   * kernel is missing: attention.py logs "Comfy Kitchen attention is
   * unavailable" and calls exit(-1) before the server starts. Measured
   * the same night with CUDA hidden: the backend died at boot with the
   * flag and served without it. The kernel needs compute capability 7.5
   * (no GTX 10-series) or an AMD part with matrix cores -- the low-end
   * reach this tool is built for -- so a blanket flag would turn a slower
   * backend into no backend on exactly those cards.
   *
   * The answer is the vendor's own int8_attention_is_available(), asked
   * in the install's own python (~2 s, cached per python for the panel's
   * life). Any failure -- spawn error, timeout, output we do not
   * recognise -- answers NO, which is the boot that shipped before.
   */
  var ckAttentionAnswers = {};
  function probeCkAttention(install, cb) {
    var key = String(install.python || "");
    if (Object.prototype.hasOwnProperty.call(ckAttentionAnswers, key)) {
      cb(ckAttentionAnswers[key]);
      return;
    }
    var done = false;
    function answer(yes) {
      if (done) return;
      done = true;
      ckAttentionAnswers[key] = yes;
      cb(yes);
    }
    try {
      child_process.execFile(install.python,
        ["-s", "-c", "import comfy_kitchen as ck; print('AELL_CK_INT8=' + " +
                     "str(bool(ck.int8_attention_is_available())))"],
        { cwd: install.root, windowsHide: true, timeout: 60000 },
        function (err, stdout) {
          answer(!err && /AELL_CK_INT8=True/.test(String(stdout || "")));
        });
    } catch (e) {
      answer(false);
    }
  }

  /** Spawn the vendor install on `base`'s port and health-poll it up. */
  function bootManaged(base, say, cb) {
    ensureNode();
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
    probeCkAttention(install, function (ckAttention) {
      var errTail = "";
      // Detached: a file the child owns for its whole life (see
      // managedLogPath). Piped: the panel is alive to read the pipes.
      var logPath = managedDetached ? managedLogPath() : null;
      var logFd = logPath === null ? null : openManagedLog(logPath);
      function bootTail() {
        return logFd === null ? errTail : managedLogTail(logPath, 600);
      }
      var proc;
      try {
        proc = child_process.spawn(install.python,
          managedBootArgs(install, base, ckAttention),
          { cwd: install.root, windowsHide: true,
            detached: managedDetached,
            stdio: logFd === null
              ? ["ignore", "pipe", "pipe"]
              : ["ignore", logFd, logFd] });
      } catch (eS) {
        if (logFd !== null) { try { fs.closeSync(logFd); } catch (eC) {} }
        var early = startWaiters;
        startWaiters = null;
        for (var w = 0; w < early.length; w++) early[w](eS);
        return;
      }
      managedProc = proc;
      rememberPid(proc.pid);
      // Our own copy of the fd; the child inherited its own handle at
      // spawn, so this one is dead weight the moment spawn returns.
      if (logFd !== null) { try { fs.closeSync(logFd); } catch (eC2) {} }
      function tail(d) {
        errTail = (errTail + d.toString()).slice(-600);
      }
      if (proc.stdout) proc.stdout.on("data", tail);
      if (proc.stderr) proc.stderr.on("data", tail);
      // A spawned child with piped stdio holds THREE references on Node's
      // event loop — the process handle and both pipes — and a data
      // listener keeps the pipes active, so the parent cannot exit while
      // the backend runs. In the panel that is invisible (the host process
      // outlives everything). In a CLI it is fatal: measured 2026-09-08,
      // `scripts/comfy-install.js --boot` printed ALL CHECKS PASSED and
      // then sat at 100% of its work done for 11 minutes until it was
      // killed by hand — an unattended pass taking NEXT UP item 1 would
      // have spent the whole night there. unref() drops the three
      // references without detaching the child, so the poll timers below
      // still hold the loop open for as long as the boot actually needs.
      try {
        proc.unref();
        if (proc.stdout) proc.stdout.unref();
        if (proc.stderr) proc.stderr.unref();
      } catch (eU) {}
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
        var t = bootTail();
        finishBoot(new Error("Backend exited during startup (code " +
          code + ")" + (t ? " — " + t : "") +
          (logPath ? " [log: " + logPath + "]" : "")));
      });
      // First boot can take a while (model scans, torch warm-up).
      var deadline = new Date().getTime() + 240000;
      (function poll() {
        if (settledBoot) return;
        isUp(base, function (nowUp) {
          if (settledBoot) return;
          if (nowUp) {
            say("Hidden ComfyUI backend is up." +
                (logPath ? " Log: " + logPath : ""));
            finishBoot(null);
            return;
          }
          if (new Date().getTime() > deadline) {
            var t2 = bootTail();
            finishBoot(new Error("Backend did not come up within 4 " +
              "minutes" + (t2 ? " — " + t2 : "") +
              (logPath ? " [log: " + logPath + "]" : "")));
            try { proc.kill(); } catch (eK) {}
            return;
          }
          global.setTimeout(poll, 2500);
        });
      })();
    });
  }

  /*
   * Is `pid` still a running process?
   *
   * `process.kill(pid, 0)` sends no signal — on Windows it is the
   * documented existence test — and it costs no spawn, which matters on
   * the panel's unload path. EPERM means the process EXISTS and we are
   * not allowed to signal it, which is still ALIVE; only a real "no such
   * process" answers false.
   *
   * When there is no `process` at all it answers TRUE, "cannot tell".
   * That is the safe direction for the one thing this decides: the PID
   * record is then KEPT, and reapOrphan() finds the survivor at the next
   * panel init. Answering false would drop the record — which is exactly
   * the bug this whole function exists to close (§17q-d).
   */
  function pidAlive(pid) {
    var n = parseInt(pid, 10);
    if (!(n > 0)) return false;
    var P = (typeof process !== "undefined") ? process : null;
    if (!P || typeof P.kill !== "function") return true;
    try { P.kill(n, 0); return true; }
    catch (e) { return !!(e && e.code === "EPERM"); }
  }

  /**
   * Is `pid` a live backend THIS PANEL MAY KILL? Synchronous, because its
   * one caller is stopManaged() on the panel's `unload`.
   *
   * pidAlive() above answers "does a process with this id exist", which is
   * not the question a kill has. Windows recycles PIDs, and the record
   * this reads from is localStorage -- it outlives an AE crash, a force
   * kill, and every restart in between, because those are exactly the
   * paths on which `unload` never ran to clear it. Reported 2026-09-23
   * from the sales-preso pipeline: AE force-killed twice in a session,
   * and the stale record left behind is all it takes for the next clean
   * quit to `taskkill /T /F` whatever inherited the number -- a TREE
   * kill, on a process the panel never started.
   *
   * TWO guards, the same pair adoptablePid() and stopByPort() use, for
   * the reason written there: the command-line SHAPE (/ComfyUI/i) is not
   * ownership, because the OWNER's own ComfyUI is ComfyUI-shaped too. It
   * must also run out of the managed root. A kill and an adoption are the
   * same claim ("this process is ours") pointed in opposite directions,
   * and the cost of being wrong is higher here.
   *
   * A root we cannot work out REFUSES, like every other caller of
   * managedRootDir(). Refusing costs nothing: stopManaged() keeps the
   * record, and reapOrphan() reads that same key at the next init, so a
   * backend we declined to kill is collected on the next launch rather
   * than leaked forever.
   */
  function pidIsOwnedComfy(pid) {
    ensureNode();
    var n = parseInt(pid, 10);
    if (!(n > 0)) return false;
    var root = managedRootDir();
    if (!root) return false;
    var out = "";
    try {
      out = String(child_process.execFileSync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
         "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + n +
         "').CommandLine"],
        { timeout: OWNERSHIP_MS, encoding: "utf8" }) || "");
    } catch (e) { return false; }
    if (!/ComfyUI/i.test(out)) return false;
    return commandLineIsUnder(out, root);
  }

  /**
   * Shut the hidden backend down (panel close frees its VRAM).
   *
   * Returns TRUE only when the backend is confirmed gone — including the
   * "there was nothing to stop" case — and false when a pid was killed
   * and is still alive. A stop that cannot confirm must say so.
   *
   * Measured 2026-09-16 (§17q-d). This used to be
   *
   *     child_process.execFile("taskkill", [...], function () {});
   *     managedProc = null;
   *     forgetPid();
   *
   * — fire and forget, with the PID record destroyed immediately
   * afterwards. The 06:10:59 probe logged `stopped the managed backend
   * (pid 44324)` and deleted the record; pid 44324 was still LISTENING on
   * 8288 and holding 649 MiB of the card 70 minutes later, and with no
   * record left nothing could find it. It is worse than wasted VRAM: the
   * panel's own `ensureRunning` then refuses to generate ("Something is
   * already answering on 127.0.0.1:8288 ... and the panel did not start
   * it"), so a survivor BRICKS generation until someone kills it by hand.
   *
   * Three properties, and the order of the last two is the whole fix:
   *
   *   1. The kill is SYNCHRONOUS. A CLI exits milliseconds after this
   *      returns and a non-detached child dies inside the Windows job
   *      object with its parent (see setManagedDetached) — so an async
   *      taskkill in a script is a race it usually loses. The panel can
   *      afford the ~100 ms on unload.
   *   2. It is VERIFIED. taskkill returns when it has ASKED Windows to
   *      terminate, not when the process is gone.
   *   3. forgetPid() runs only AFTER that verification. A PID record
   *      outliving a failed kill is the only thing that can find the
   *      survivor.
   */
  function stopManaged() {
    ensureNode();
    var pid = managedProc ? managedProc.pid : null;
    if (!pid) {
      try { pid = parseInt(global.localStorage.getItem(COMFY_PID_KEY), 10); }
      catch (e) {}
    }
    managedProc = null;
    if (!pid) { forgetPid(); return true; }
    // Already gone: nothing to kill, and the record is just litter.
    if (!pidAlive(pid)) { forgetPid(); return true; }
    // Alive, but is it OURS? A number that outlived its process is the
    // one input this function cannot take on trust.
    if (!pidIsOwnedComfy(pid)) {
      forgetPid();
      return true;
    }
    try {
      child_process.execFileSync("taskkill",
        ["/PID", String(pid), "/T", "/F"], { timeout: KILL_MS });
    } catch (e2) {}
    // Only when the free check still sees it — one bounded wait, and it
    // is the only path here that costs a spawn.
    if (pidAlive(pid)) {
      try {
        child_process.execFileSync("powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command",
           "Wait-Process -Id " + parseInt(pid, 10) + " -Timeout " +
           Math.round(RESIDUAL_MS / 1000) + " -ErrorAction SilentlyContinue"],
          { timeout: RESIDUAL_MS * 2 });
      } catch (e3) {}
    }
    if (pidAlive(pid)) return false;
    forgetPid();
    return true;
  }

  global.Comfy = {
    listWorkflows: listWorkflows,
    readManifest: readManifest,
    backendUrl: backendUrl,
    backendMode: backendMode,
    managedPort: managedPort,
    describeWorkflows: describeWorkflows,
    resolveWorkflow: resolveWorkflow,
    _graphCarriesValue: graphCarriesValue,   // exposed for tests
    _timeoutProgressNote: timeoutProgressNote, // exposed for tests
    loadWorkflow: loadWorkflow,
    injectParams: injectParams,
    formatH3Prompt: formatH3Prompt,
    outputScaleFrom: outputScaleFrom,
    sizeForComp: sizeForComp,
    uploadImage: uploadImage,
    generate: generate,
    status: status,
    launch: launch,
    freeVram: freeVram,
    ensureRunning: ensureRunning,
    stopManaged: stopManaged,
    setManagedDetached: setManagedDetached,
    reapOrphan: reapOrphan,
    _adoptablePid: adoptablePid,                  // exposed for tests
    _commandLineIsUnder: commandLineIsUnder,      // exposed for tests
    _managedRootDir: managedRootDir,              // exposed for tests
    _pidIsOwnedComfy: pidIsOwnedComfy,            // exposed for tests
    bypassNode: bypassNode,
    substituteNode: substituteNode,
    expandFilenameTokens: expandFilenameTokens,
    classInstalled: classInstalled,
    missingWeights: missingWeights,
    validateGraphInputs: validateGraphInputs,
    resolveOptionalNodes: resolveOptionalNodes,
    MODEL_SUBS: COMFY_MODEL_SUBS,
    _openEventSocket: openEventSocket,           // exposed for tests
    _makeProgressTracker: makeProgressTracker,   // exposed for tests
    _applyExtraModelPaths: applyExtraModelPaths   // exposed for tests
  };

})(window);
