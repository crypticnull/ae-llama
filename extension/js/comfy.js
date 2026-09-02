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
   *          checked}). NEVER guesses: a class the server does not know, an
   * input that is not a combo, and a value that is not a weight filename
   * are all passed over in silence, so this can only ever report a weight
   * ComfyUI itself would reject at queue time — never a false refusal.
   */
  function missingWeights(comfyUrl, graph, cb) {
    var base;
    try { base = parseBase(comfyUrl); } catch (e) { cb(e); return; }
    var ids = [], k;
    for (k in graph) {
      if (Object.prototype.hasOwnProperty.call(graph, k)) ids.push(k);
    }
    ids.sort();
    var defs = {};                 // class_type -> definition|null, once each
    var missing = [], checked = 0;
    (function next(i) {
      if (i >= ids.length) {
        cb(null, { missing: missing, checked: checked });
        return;
      }
      var nid = ids[i];
      var node = graph[nid] || {};
      var cls = node.class_type;
      var inputs = node.inputs || {};
      var names = [], n;
      for (n in inputs) {
        if (!Object.prototype.hasOwnProperty.call(inputs, n)) continue;
        if (typeof inputs[n] === "string" && WEIGHT_FILE_RE.test(inputs[n])) {
          names.push(n);
        }
      }
      if (!cls || !names.length) { next(i + 1); return; }
      function withDef(def) {
        for (var j = 0; j < names.length; j++) {
          var name = names[j];
          var choices = comboChoices(def, name);
          if (!choices) continue;
          checked++;
          var hit = false;
          for (var c = 0; c < choices.length; c++) {
            if (choices[c] === inputs[name]) { hit = true; break; }
          }
          if (!hit) {
            missing.push({ node: nid, classType: cls, input: name,
                           value: inputs[name], choiceCount: choices.length });
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
   * End-to-end generation.
   * opts: {comfyUrl, workflowFile, params, outDir, timeoutSec}
   * onProgress(secondsElapsed) fires periodically while waiting.
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
        applied = injectParams(graph, params, manifest);
      } catch (e) {
        cb(e);
        return;
      }
      // Optional nodes are resolved against the LIVE server, so this has to
      // happen after grafting and before queueing — it is the only step that
      // can tell whether a pack the template names exists on THIS machine.
      resolveOptionalNodes(base, graph, manifest, applied, function (oErr) {
        if (oErr) { cb(oErr); return; }
        queueIt();
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
    if (typeof params.prompt === "string" && params.prompt !== "" &&
        !graphCarriesValue(graph, params.prompt)) {
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
        // Surface what was skipped alongside the eventual result — and
        // keep it, because when EVERY output branch is dropped this is the
        // only account of why the run produced nothing.
        var skipped = "";
        if (json.node_errors) {
          skipped = describeNodeErrors(json.node_errors);
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
        var cancelling = false;
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
            // Stop looking AND stop the job — see cancelPrompt. The cancel
            // is awaited before settling so the arbiter's resume, which
            // runs next and waits for the card to come back to the floor,
            // is waiting for something that can actually happen.
            if (cancelling) return;
            cancelling = true;
            var secs = Math.round(elapsed / 1000);
            cancelPrompt(base, promptId, function (note) {
              settle(new Error("Generation timed out after " + secs +
                               "s (prompt " + promptId + ")" + note));
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
          // A ComfyUI on this machine at another port outranks both
          // canned hints: it is the one thing the user can act on in one
          // setting change.
          findLocalComfy(base, function (found) {
            cb(null, { online: false, url: comfyUrl, target: base.label,
                       hiddenBackendInstalled: hasHidden,
                       foundAt: found ? found.url : null,
                       hint: found
                         ? elsewhereHint(base, found)
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
  function elsewhereHint(base, found) {
    return "Nothing is listening at " + base.label + ", but a ComfyUI IS " +
      "answering at " + found.label + ". Set the ComfyUI URL in Settings " +
      "to " + found.url + " — the panel will not switch to it on its own.";
  }

  /**
   * Point the hidden backend at the user's external models folder (they
   * get big) via ComfyUI's own extra_model_paths.yaml mechanism. The yaml
   * lives inside OUR vendor install, so it is safe to (re)write on every
   * boot; blank setting = the backend's built-in models folder only —
   * plus the Comfy-Desktop shared store below, when the machine has one.
   */
  var COMFY_MODEL_SUBS = ["checkpoints", "diffusion_models", "text_encoders",
    "clip", "clip_vision", "vae", "loras", "controlnet", "upscale_models",
    "embeddings"];
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
    if (!dir && !roots.length && !sharedStore) {
      // Setting cleared and nothing shared to point at — remove a
      // previously written mapping.
      try { if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath); }
      catch (eU) {}
      return null;
    }
    try {
      var i, k;
      var lines = [
        "# Managed by AE Llama — external model folders (panel settings)"
      ];
      if (dir) {
        // The primary folder is ours to manage: create the layout so
        // downloads have somewhere to land.
        for (i = 0; i < COMFY_MODEL_SUBS.length; i++) {
          var d = path.join(dir, COMFY_MODEL_SUBS[i]);
          if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        }
        lines.push("aellama:");
        lines.push("  base_path: " + dir.replace(/\\/g, "/"));
        for (i = 0; i < COMFY_MODEL_SUBS.length; i++) {
          lines.push("  " + COMFY_MODEL_SUBS[i] + ": " +
                     COMFY_MODEL_SUBS[i]);
        }
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
        lines.push("aellama_extra_" + n + ":");
        lines.push("  base_path: " + root.replace(/\\/g, "/"));
        if (kind) {
          lines.push("  " + kind + ": .");
        } else {
          for (k = 0; k < COMFY_MODEL_SUBS.length; k++) {
            lines.push("  " + COMFY_MODEL_SUBS[k] + ": " +
                       COMFY_MODEL_SUBS[k]);
          }
        }
        n++;
      }
      if (sharedStore) {
        lines.push("comfy_desktop_shared:");
        lines.push("  base_path: " + sharedStore.replace(/\\/g, "/"));
        for (k = 0; k < COMFY_MODEL_SUBS.length; k++) {
          lines.push("  " + COMFY_MODEL_SUBS[k] + ": " +
                     COMFY_MODEL_SUBS[k]);
        }
      }
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
      });   // findLocalComfy
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
    readManifest: readManifest,
    loadWorkflow: loadWorkflow,
    injectParams: injectParams,
    outputScaleFrom: outputScaleFrom,
    uploadImage: uploadImage,
    generate: generate,
    status: status,
    launch: launch,
    freeVram: freeVram,
    ensureRunning: ensureRunning,
    stopManaged: stopManaged,
    reapOrphan: reapOrphan,
    bypassNode: bypassNode,
    substituteNode: substituteNode,
    expandFilenameTokens: expandFilenameTokens,
    classInstalled: classInstalled,
    missingWeights: missingWeights,
    resolveOptionalNodes: resolveOptionalNodes,
    MODEL_SUBS: COMFY_MODEL_SUBS,
    _applyExtraModelPaths: applyExtraModelPaths   // exposed for tests
  };

})(window);
