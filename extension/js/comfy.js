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

  /**
   * Upload a local file into ComfyUI's input folder so a LoadImage node can
   * name it. LoadImage takes a FILENAME inside ComfyUI's own input dir, never
   * a path, so an AE-side render can only reach the graph this way.
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
    var name = String(path.basename(filePath)).replace(/["\\\r\n]/g, "_");
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

    // Last, so an explicit manifest target always wins over a guess.
    if (manifest && manifest.procedural) {
      injectProcedural(graph, params, manifest.procedural, applied);
    }
    return applied;
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

  /**
   * Drop node `id` and rewire its consumers to whatever fed its `passthrough`
   * input — ComfyUI's own mode-4 bypass semantics, except the pass-through
   * socket is DECLARED by the manifest rather than inferred from types: an
   * API-format graph carries no type information to infer from.
   * Returns {rewired: [...]}. Throws grounded errors; never guesses.
   */
  function bypassNode(graph, id, passthrough) {
    var nid = String(id);
    var node = graph[nid];
    if (!node) return null;
    var inputs = node.inputs || {};
    var names = [];
    for (var n in inputs) { if (inputs.hasOwnProperty(n)) names.push(n); }
    if (!passthrough) {
      throw new Error("Cannot bypass node " + nid + " (" + node.class_type +
        "): the manifest does not say which input passes through. Add " +
        "\"passthrough\" naming one of: " + names.join(", "));
    }
    if (!inputs.hasOwnProperty(passthrough)) {
      throw new Error("Cannot bypass node " + nid + " (" + node.class_type +
        "): it has no input named \"" + passthrough + "\". It has: " +
        (names.length ? names.join(", ") : "(none)"));
    }
    var source = inputs[passthrough];
    if (!isLink(source)) {
      // A literal cannot be handed to a downstream socket that wants a link,
      // so there is nothing to rewire TO. Say that instead of quietly
      // deleting the consumers' inputs and letting validation fail later.
      throw new Error("Cannot bypass node " + nid + " (" + node.class_type +
        "): its \"" + passthrough + "\" input is a literal value (" +
        JSON.stringify(source) + "), not a link from another node, so " +
        "consumers have nothing to rewire to.");
    }
    var rewired = [];
    for (var cid in graph) {
      if (!graph.hasOwnProperty(cid)) continue;
      var c = graph[cid];
      if (!c || !c.inputs || cid === nid) continue;
      for (var ck in c.inputs) {
        if (!c.inputs.hasOwnProperty(ck)) continue;
        if (isLink(c.inputs[ck]) && String(c.inputs[ck][0]) === nid) {
          c.inputs[ck] = [String(source[0]), source[1]];
          rewired.push(cid + "." + ck + " -> " + source[0] + ":" + source[1]);
        }
      }
    }
    delete graph[nid];
    return { rewired: rewired };
  }

  /**
   * Honour the manifest's `optionalNodes` block: a node the template can run
   * without, because the pack that defines it is not on every machine.
   * Each entry: {nodeId, class, passthrough, when?: "missing"|"always",
   *              reason?, keptNote?}.
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
      function doBypass(why) {
        var r;
        try { r = bypassNode(graph, nid, entry.passthrough); }
        catch (e) { cb(e); return; }
        applied.push("bypassed optional node " + nid + " (" + cls + "): " +
          why + (entry.reason ? " — " + entry.reason : "") +
          (r && r.rewired.length ? "; rewired " + r.rewired.join(", ") : ""));
        next();
      }
      if (entry.when === "always") { doBypass("manifest says always"); return; }
      classInstalled(base, cls, function (err, present) {
        if (err) { cb(err); return; }
        if (!present) { doBypass("not installed on this ComfyUI"); return; }
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
    // A prompt that lands nowhere means the render would use the template's
    // baked-in text — fail fast instead of burning GPU minutes on it.
    if (typeof params.prompt === "string" && params.prompt !== "") {
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
    var s = null;
    try { s = global.Settings.get() || {}; } catch (e) { s = {}; }
    var dir = String(s.comfyModelsDir || "");
    // ComfyUI veterans have models spread across drives — extra roots,
    // one per line in settings, each either a whole models tree or a
    // per-kind folder written as "kind=path" (e.g.
    // "checkpoints=D:\\SD\\ckpts").
    var roots = s.comfyModelRoots instanceof Array ? s.comfyModelRoots : [];
    var yamlPath = path.join(install.root, "ComfyUI",
                             "extra_model_paths.yaml");
    if (!dir && !roots.length) {
      // Setting cleared — remove a previously written mapping.
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
    readManifest: readManifest,
    loadWorkflow: loadWorkflow,
    injectParams: injectParams,
    uploadImage: uploadImage,
    generate: generate,
    status: status,
    launch: launch,
    freeVram: freeVram,
    ensureRunning: ensureRunning,
    stopManaged: stopManaged,
    reapOrphan: reapOrphan,
    bypassNode: bypassNode,
    classInstalled: classInstalled,
    resolveOptionalNodes: resolveOptionalNodes,
    _applyExtraModelPaths: applyExtraModelPaths   // exposed for tests
  };

})(window);
