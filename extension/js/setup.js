/*
 * setup.js — hands-off first-run bootstrap and update channel.
 *
 * On first launch the panel (not the user) detects the GPU, picks the right
 * llama.cpp Windows build, downloads it into %APPDATA%\AE-Llama\vendor and
 * extracts it — no scripts, no terminal. The same machinery powers the
 * "Update engine" button, the optional starter-model download, and the
 * aescripts.com update banner (via the hosted update.json manifest).
 */
(function (global) {
  "use strict";

  var http = null;
  var https = null;
  var fs = null;
  var path = null;
  var child_process = null;
  var NodeBuffer = null;
  var crypto = null;

  function ensureNode() {
    if (http) return;
    http = global.AEBridge.nodeRequire("http");
    https = global.AEBridge.nodeRequire("https");
    fs = global.AEBridge.nodeRequire("fs");
    path = global.AEBridge.nodeRequire("path");
    child_process = global.AEBridge.nodeRequire("child_process");
    NodeBuffer = global.AEBridge.nodeRequire("buffer").Buffer;
    crypto = global.AEBridge.nodeRequire("crypto");
  }

  // ------------------------------------------------------------ data dirs

  /**
   * sha1 of a file's bytes with CRLF normalized to LF — the same identity
   * scripts/workflow-hash-history.js records. Normalizing matters: git
   * checks these templates out with the platform's line endings, so the
   * installed copy of a template can be byte-different from the bundled
   * one and still be the identical shipped version (measured on the dev
   * machine 2026-08-28: the H3 i2v template differed in raw bytes and in
   * nothing else).
   */
  function shippedHash(buf) {
    var norm = NodeBuffer.from(buf).toString("latin1").replace(/\r\n/g, "\n");
    return crypto.createHash("sha1").update(norm, "latin1").digest("hex");
  }

  /** The bundle's append-only hash record, or null when unreadable. */
  function loadHashHistory(srcDir) {
    try {
      var p = path.join(srcDir, ".hash-history.json");
      if (!fs.existsSync(p)) return null;
      var j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!j || !j.files || typeof j.files !== "object") return null;
      return j.files;
    } catch (e) { return null; }
  }

  /**
   * Create the persistent data tree and seed workflow templates.
   *
   * Seeding used to be "copy anything missing, never touch anything
   * present", which froze every install on the templates it first saw —
   * this machine was still running the H3 manifest from five releases
   * earlier. Overwriting unconditionally is not the fix either: users are
   * invited to edit these templates. So the bundle ships a hash history of
   * every version it ever published, and an installed file is refreshed
   * only when its hash is one of ours (an unedited, stale shipped copy).
   * An unknown hash is a human's work and is left alone. With no readable
   * history the old never-overwrite behaviour stands.
   *
   * Returns a summary of what happened, for the tests and the log.
   */
  function ensureDataDirs() {
    ensureNode();
    var root = global.Settings.dataRoot();
    var dirs = ["", "vendor", "models", "generated", "comfy-workflows"];
    for (var i = 0; i < dirs.length; i++) {
      var d = dirs[i] ? path.join(root, dirs[i]) : root;
      try {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      } catch (e) {}
    }
    var summary = { seeded: [], refreshed: [], preserved: [], current: [] };
    try {
      var src = path.join(global.AEBridge.getExtensionPath(), "comfy-workflows");
      var dst = path.join(root, "comfy-workflows");
      if (!fs.existsSync(src)) return summary;
      var history = loadHashHistory(src);
      var entries = fs.readdirSync(src);
      for (var j = 0; j < entries.length; j++) {
        var name = entries[j];
        // Dotfiles are bundle metadata (the history itself), not templates.
        if (name.charAt(0) === ".") continue;
        var from = path.join(src, name);
        try { if (!fs.statSync(from).isFile()) continue; } catch (e2) { continue; }
        var to = path.join(dst, name);
        if (!fs.existsSync(to)) {
          fs.writeFileSync(to, fs.readFileSync(from));
          summary.seeded.push(name);
          continue;
        }
        if (!history) { summary.preserved.push(name); continue; }
        var known = history[name];
        if (!known || !known.length) { summary.preserved.push(name); continue; }
        var have = shippedHash(fs.readFileSync(to));
        var mine = shippedHash(fs.readFileSync(from));
        if (have === mine) { summary.current.push(name); continue; }
        var isOurs = false;
        for (var k = 0; k < known.length; k++) {
          if (known[k] === have) { isOurs = true; break; }
        }
        if (!isOurs) { summary.preserved.push(name); continue; }
        fs.writeFileSync(to, fs.readFileSync(from));
        summary.refreshed.push(name);
      }
    } catch (e) {}
    return summary;
  }

  // -------------------------------------------------------- GPU detection

  /**
   * Detect NVIDIA capability via nvidia-smi (ships with the driver).
   * cb({hasNvidia, cudaVersion: "12.8"|null, computeCap: 8.6|null,
   *     vramGB: 32|null})
   */
  function detectGpu(cb) {
    ensureNode();
    child_process.execFile("nvidia-smi", [], { timeout: 15000 },
      function (err, stdout) {
        if (err) {
          cb({ hasNvidia: false, cudaVersion: null, computeCap: null,
               vramGB: null });
          return;
        }
        var cuda = null;
        // The banner does NOT always say "CUDA Version:". Measured on
        // this machine 2026-08-30 (driver 616.56, RTX 5090):
        //   | NVIDIA-SMI 616.56  KMD Version: 616.56  CUDA UMD Version: 13.4 |
        // The old /CUDA Version:/ found nothing there, so cudaVersion was
        // null on a perfectly ordinary NVIDIA box and pickAssets fell
        // through to its "be conservative, oldest line" branch — CUDA 12.4
        // on a card whose driver runs 13.3. The word between CUDA and
        // Version is optional.
        var m = String(stdout).match(/CUDA(?:\s+\w+)?\s+Version\s*:\s*([\d.]+)/);
        if (m) cuda = m[1];
        child_process.execFile("nvidia-smi",
          ["--query-gpu=name,compute_cap,memory.total",
           "--format=csv,noheader,nounits"],
          { timeout: 15000 },
          function (err2, stdout2) {
            var name = null;
            var cc = null;
            var vramGB = null;
            if (!err2) {
              var parts = String(stdout2).split(/\r?\n/)[0].split(",");
              if (parts[0] && parts[0].trim()) name = parts[0].trim();
              if (parts[1] && /^\d+(\.\d+)?$/.test(parts[1].trim())) {
                cc = parseFloat(parts[1].trim());
              }
              if (parts[2] && /^\d+$/.test(parts[2].trim())) {
                vramGB = Math.round(parseInt(parts[2].trim(), 10) / 1024);
              }
            }
            cb({ hasNvidia: true, name: name, cudaVersion: cuda,
                 computeCap: cc, vramGB: vramGB });
          });
      });
  }

  /**
   * Current total VRAM in use (all processes), in MB. The arbiter polls
   * this to VERIFY a handoff actually released memory — a fixed sleep
   * after kill is hope, not verification. cb(err, usedMB).
   */
  function queryVramUsedMB(cb) {
    ensureNode();
    child_process.execFile("nvidia-smi",
      ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
      { timeout: 10000 },
      function (err, stdout) {
        if (err) { cb(err); return; }
        var line = String(stdout || "").split(/\r?\n/)[0].trim();
        if (!/^\d+$/.test(line)) {
          cb(new Error("nvidia-smi returned no memory figure"));
          return;
        }
        cb(null, parseInt(line, 10));
      });
  }

  /**
   * Pick the best catalog model for this machine. The logic lives in
   * tiers.js (the single tier source both catalogs derive from); this
   * export keeps the historical call shape and feeds it the live
   * settings so vramOverrideGB is honored everywhere at once.
   */
  function recommendModel(catalog, gpu) {
    return global.Tiers.recommendChat(catalog, gpu, currentSettings());
  }

  function currentSettings() {
    try {
      return (global.Settings && global.Settings.get())
        || {};
    } catch (e) { return {}; }
  }

  // --------------------------------------------------------------- http(s)

  function fetchJson(url, timeoutMs, cb, redirects) {
    ensureNode();
    redirects = redirects || 0;
    var u;
    try { u = new URL(url); } catch (e) { cb(e); return; }
    var mod = u.protocol === "https:" ? https : http;
    var req = mod.request({
      host: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: { "User-Agent": "ae-llama-panel", "Accept": "application/json" }
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 &&
          res.headers.location && redirects < 5) {
        res.resume();
        fetchJson(res.headers.location, timeoutMs, cb, redirects + 1);
        return;
      }
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var text = NodeBuffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          cb(new Error("HTTP " + res.statusCode + " from " + u.hostname));
          return;
        }
        try { cb(null, JSON.parse(text)); }
        catch (e) { cb(new Error("Invalid JSON from " + u.hostname)); }
      });
      res.on("error", function (e) { cb(e); });
    });
    req.on("error", function (e) { cb(e); });
    req.setTimeout(timeoutMs, function () {
      req.destroy(new Error("Request timed out: " + u.hostname));
    });
    req.end();
  }

  /**
   * Download url to destPath, following redirects (GitHub/HF assets 302 to
   * a CDN). onProgress(receivedBytes, totalBytes|0) fires per chunk.
   * Returns a controller: {cancel()} aborts the transfer (across redirects),
   * deletes the partial file, and calls cb with err.cancelled = true.
   */
  function downloadToFile(url, destPath, onProgress, cb, redirects, ctrl) {
    ensureNode();
    redirects = redirects || 0;
    if (!ctrl) {
      ctrl = {
        cancelled: false,
        _req: null,
        cancel: function () {
          ctrl.cancelled = true;
          try {
            if (ctrl._req) ctrl._req.destroy(new Error("cancelled"));
          } catch (e) {}
        }
      };
    }
    var settled = false;
    function done(err, result) {
      if (settled) return;
      settled = true;
      if (err && ctrl.cancelled) {
        err = new Error("Download cancelled");
        err.cancelled = true;
      }
      if (err) { try { fs.unlinkSync(destPath); } catch (e) {} }
      cb(err, result);
    }

    var u;
    try { u = new URL(url); } catch (e) { done(e); return ctrl; }
    var mod = u.protocol === "https:" ? https : http;
    var req = mod.request({
      host: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: { "User-Agent": "ae-llama-panel" }
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 &&
          res.headers.location && redirects < 5) {
        res.resume();
        settled = true;   // hand off to the redirect leg
        downloadToFile(res.headers.location, destPath, onProgress, cb,
                       redirects + 1, ctrl);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        done(new Error("Download failed (HTTP " + res.statusCode + ")"));
        return;
      }
      var total = parseInt(res.headers["content-length"] || "0", 10);
      var received = 0;
      var out = fs.createWriteStream(destPath);
      res.on("data", function (c) {
        received += c.length;
        if (onProgress && !ctrl.cancelled) onProgress(received, total);
      });
      res.pipe(out);
      out.on("finish", function () { out.close(); done(null, destPath); });
      out.on("error", function (e) { try { out.destroy(); } catch (e2) {} done(e); });
      res.on("error", function (e) { try { out.destroy(); } catch (e2) {} done(e); });
    });
    ctrl._req = req;
    req.on("error", function (e) { done(e); });
    // No idle timeout on multi-GB downloads; errors/aborts still fire.
    req.end();
    return ctrl;
  }

  function extractZip(zipPath, destDir, cb) {
    ensureNode();
    try {
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    } catch (e) { cb(e); return; }
    // tar.exe ships with Windows 10+ and extracts zips; fall back to
    // PowerShell (-Command is not gated by script execution policy).
    child_process.execFile("tar", ["-xf", zipPath, "-C", destDir],
      { timeout: 300000 },
      function (err) {
        if (!err) { cb(null); return; }
        child_process.execFile("powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command",
           "Expand-Archive -LiteralPath '" + zipPath.replace(/'/g, "''") +
           "' -DestinationPath '" + destDir.replace(/'/g, "''") + "' -Force"],
          { timeout: 300000 },
          function (err2) {
            cb(err2 ? new Error("Could not extract " + zipPath + ": " +
                                err2.message) : null);
          });
      });
  }

  // ------------------------------------------------------- asset selection

  function paddedVersion(v) {
    var parts = String(v).split(".").map(function (x) {
      return parseInt(x, 10) || 0;
    });
    while (parts.length < 3) parts.push(0);
    return parts[0] * 1000000 + parts[1] * 1000 + parts[2];
  }

  /**
   * Choose the best assets from a llama.cpp release for this machine.
   * Returns {assets: [asset...], label} or null when nothing fits.
   */
  function pickAssets(release, gpu) {
    var assets = release.assets || [];
    var i;

    function find(regex) {
      for (i = 0; i < assets.length; i++) {
        if (regex.test(assets[i].name)) return assets[i];
      }
      return null;
    }

    var cpu = find(/^llama-.*-bin-win-cpu-x64\.zip$/) ||
              find(/^llama-.*-bin-win-avx2-x64\.zip$/);

    if (!gpu || !gpu.hasNvidia) {
      return cpu ? { assets: [cpu], label: "CPU" } : null;
    }

    var cudaRegex = /^llama-.*-bin-win-cuda-(?:cu)?(\d+(?:\.\d+){0,2})-x64\.zip$/;
    var candidates = [];
    for (i = 0; i < assets.length; i++) {
      var m = assets[i].name.match(cudaRegex);
      if (m) candidates.push({ asset: assets[i], ver: m[1],
                               n: paddedVersion(m[1]) });
    }
    // Driver supports toolkits up to its reported CUDA version; CUDA 13
    // builds additionally drop GPUs below compute capability 7.5.
    var maxN = gpu.cudaVersion ? paddedVersion(gpu.cudaVersion) : 0;
    var eligible = [];
    for (i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (maxN && c.n > maxN) continue;
      if (gpu.computeCap !== null && gpu.computeCap < 7.5 &&
          c.n >= paddedVersion("13")) continue;
      eligible.push(c);
    }
    // Driver didn't report a CUDA version — be conservative, oldest line.
    if (eligible.length === 0 && !gpu.cudaVersion) eligible = candidates;
    if (eligible.length === 0) {
      return cpu ? { assets: [cpu], label: "CPU (no compatible CUDA build)" }
                 : null;
    }
    eligible.sort(function (a, b) { return a.n - b.n; });
    var best = eligible[gpu.cudaVersion ? eligible.length - 1 : 0];

    var out = [best.asset];
    var esc = best.ver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var cudart = find(new RegExp(
      "^cudart-llama-bin-win-(?:cuda-)?(?:cu)?" + esc + "-x64\\.zip$"));
    if (cudart) out.push(cudart);
    return { assets: out, label: "CUDA " + best.ver };
  }

  /**
   * Pick the newest release that actually CARRIES a Windows build.
   *
   * Measured 2026-08-30: ggml-org/llama.cpp's /releases/latest answers
   * `v0.3.0`, whose entire asset list is one `nightly-tag.txt`. Every
   * real Windows build lives in a `bNNNNN` release and every one of
   * those is flagged PRERELEASE, which /releases/latest never returns.
   * So the panel's one-click engine install ended at "No suitable
   * Windows build found in release v0.3.0" for every user — pointing at
   * a single release is the bug, not the asset matching.
   *
   * Same rule the whisper and ffmpeg acquirers already use (see
   * scripts/lib/whisper-assets.ps1): walk the LIST and take the first
   * release that has what this machine needs.
   *
   * releases: one release object or an array of them.
   * Returns {release, picked} or {err} naming the tags it looked at.
   */
  function pickReleaseAssets(releases, gpu) {
    var list = [];
    (function flatten(x) {
      if (!x) return;
      if (Object.prototype.toString.call(x) === "[object Array]") {
        for (var j = 0; j < x.length; j++) flatten(x[j]);
      } else { list.push(x); }
    })(releases);

    var seen = [], i, picked;
    for (i = 0; i < list.length; i++) {
      if (list[i].draft) continue;
      picked = pickAssets(list[i], gpu);
      if (picked) return { release: list[i], picked: picked };
      seen.push(list[i].tag_name || "(untagged)");
    }
    if (!seen.length) return { err: "GitHub returned no llama.cpp releases." };
    return { err: "No Windows llama-server build in the " + seen.length +
             " newest llama.cpp release(s): " + seen.join(", ") + "." };
  }

  // ------------------------------------------------------------- bootstrap

  var bootstrapBusy = false;

  /**
   * Full hands-off engine install/update.
   * opts: {force?: bool, tag?: string ("latest" or a release tag)}
   * onStatus(text) — human-readable progress for the chat.
   * cb(err, {serverPath})
   */
  function bootstrapEngine(opts, onStatus, cb) {
    ensureNode();
    // Controller returned to the caller; cancel() aborts the in-flight
    // download and stops the asset queue.
    var ctrl = {
      cancelled: false,
      _dl: null,
      cancel: function () {
        ctrl.cancelled = true;
        try { if (ctrl._dl) ctrl._dl.cancel(); } catch (e) {}
      }
    };
    if (bootstrapBusy) {
      cb(new Error("Setup is already running"));
      return ctrl;
    }
    opts = opts || {};
    function status(t) { if (onStatus) onStatus(t); }

    ensureDataDirs();
    var vendorRoot = path.join(global.Settings.dataRoot(), "vendor");
    var vendorDir = path.join(vendorRoot, "llama.cpp");

    var existing = global.Llama.findServerExe(global.Settings.get().serverPath);
    if (existing && !opts.force) {
      cb(null, { serverPath: existing, skipped: true });
      return ctrl;
    }

    bootstrapBusy = true;
    function finish(err, res) {
      bootstrapBusy = false;
      cb(err, res);
    }

    status("Detecting GPU…");
    detectGpu(function (gpu) {
      status(gpu.hasNvidia
        ? "NVIDIA GPU found (driver CUDA " + (gpu.cudaVersion || "?") +
          (gpu.computeCap !== null ? ", compute " + gpu.computeCap : "") +
          (gpu.vramGB ? ", " + gpu.vramGB + " GB VRAM" : "") + ")"
        : "No NVIDIA GPU detected — using the CPU build");

      var tag = opts.tag || "latest";
      // The LIST, not /releases/latest — llama.cpp's "latest" is an
      // asset-less v0.3.0 and every Windows build is a prerelease.
      // See pickReleaseAssets.
      var api = tag === "latest"
        ? "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15"
        : "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/" + tag;

      status("Fetching llama.cpp release info…");
      fetchJson(api, 30000, function (err, body) {
        if (err) { finish(new Error("Could not reach GitHub: " + err.message)); return; }
        var choice = pickReleaseAssets(body, gpu);
        if (choice.err) { finish(new Error(choice.err)); return; }
        var release = choice.release;
        var picked = choice.picked;
        status("Selected " + picked.label + " build from " +
               (release.tag_name || tag));

        // Fresh directory so build variants never mix.
        try {
          if (fs.existsSync(vendorDir)) {
            fs.rmSync(vendorDir, { recursive: true, force: true });
          }
          fs.mkdirSync(vendorDir, { recursive: true });
        } catch (e) {
          finish(new Error("Cannot prepare " + vendorDir + ": " + e.message));
          return;
        }

        var queue = picked.assets.slice();
        (function nextAsset() {
          if (queue.length === 0) {
            var exe = global.Llama.findServerExe("");
            if (!exe) {
              finish(new Error("Extraction finished but llama-server.exe " +
                               "was not found"));
              return;
            }
            global.Settings.set({ serverPath: exe });
            status("Engine ready: " + exe);
            finish(null, { serverPath: exe });
            return;
          }
          if (ctrl.cancelled) {
            var ce = new Error("Download cancelled");
            ce.cancelled = true;
            finish(ce);
            return;
          }
          var asset = queue.shift();
          var zipPath = path.join(vendorRoot, asset.name);
          var mb = Math.round((asset.size || 0) / 1048576);
          status("Downloading " + asset.name +
                 (mb ? " (" + mb + " MB)…" : "…"));
          ctrl._dl = downloadToFile(asset.browser_download_url, zipPath,
            function (rec, total) {
              if (opts.onProgress) {
                opts.onProgress(rec, total || asset.size || 0);
              }
            },
            function (derr) {
              if (derr) { finish(derr); return; }
              status("Extracting " + asset.name + "…");
              extractZip(zipPath, vendorDir, function (xerr) {
                try { fs.unlinkSync(zipPath); } catch (e) {}
                if (xerr) { finish(xerr); return; }
                nextAsset();
              });
            });
        })();
      });
    });
    return ctrl;
  }

  // -------------------------------------------------------- starter model

  /** The live model catalog: hosted override, else the built-in list. */
  function modelCatalog(manifest) {
    if (manifest && manifest.modelCatalog instanceof Array &&
        manifest.modelCatalog.length > 0) {
      return manifest.modelCatalog;
    }
    return global.AELL.MODEL_CATALOG;
  }

  /**
   * The live GENERATION catalog: hosted override, else the built-in
   * list. Feed-driven exactly like the chat catalog, so corrections
   * (URLs, measured VRAM figures) ship without a panel release.
   */
  function comfyCatalog(manifest) {
    if (manifest && manifest.comfyCatalog instanceof Array &&
        manifest.comfyCatalog.length > 0) {
      return manifest.comfyCatalog;
    }
    return global.AELL.COMFY_CATALOG || [];
  }

  /**
   * The combined, tier-derived first-run recommendation: one detection,
   * one tier, chat AND generation picks from it, plus the honest
   * one-line copy. Pure over its inputs (gpu from detectGpu, manifest
   * from checkForUpdates) so it is stub-testable.
   */
  function recommendSetup(manifest, gpu) {
    var s = currentSettings();
    var chat = global.Tiers.recommendChat(modelCatalog(manifest), gpu, s);
    var gen = global.Tiers.recommendGen(comfyCatalog(manifest), gpu, s);
    var res = global.Tiers.resolveTier(gpu, s);
    return {
      tier: res.tier, vramGB: res.vramGB, overridden: res.overridden,
      arch: res.arch, chat: chat, gen: gen,
      copy: global.Tiers.describeSetup({ gpu: gpu, settings: s,
                                         chat: chat, gen: gen })
    };
  }

  /**
   * Download a catalog model into the models folder.
   * ui: {status(text)?, progress(receivedBytes, totalBytes)?}
   * Returns the download controller ({cancel()}).
   */
  function downloadModel(model, ui, cb) {
    ensureNode();
    ensureDataDirs();
    ui = ui || {};
    if (!model || !model.url || !model.name) {
      cb(new Error("No model configured"));
      return null;
    }
    var dest = path.join(global.Settings.dataRoot(), "models", model.name);
    if (fs.existsSync(dest)) { cb(null, dest); return null; }
    var tmp = dest + ".part";
    if (ui.status) {
      ui.status("Downloading " + model.name +
        (model.sizeMB ? " (~" + Math.round(model.sizeMB / 1024 * 10) / 10 +
         " GB — this can take a while)…" : "…"));
    }
    return downloadToFile(model.url, tmp, function (rec, total) {
      if (ui.progress) {
        ui.progress(rec, total || (model.sizeMB ? model.sizeMB * 1048576 : 0));
      }
    }, function (err) {
      if (err) {
        try { fs.unlinkSync(tmp); } catch (e) {}
        cb(err);
        return;
      }
      try { fs.renameSync(tmp, dest); } catch (e) { cb(e); return; }
      cb(null, dest);
    });
  }

  /**
   * Where one GENERATION weight lands: the Settings models folder when
   * set, else the hidden backend's own tree — the two panel-managed
   * roots, which is exactly the set the settings Remove button may later
   * reap. Pure path arithmetic (no download), so the refusal for "no
   * place to put it" is testable without a network.
   */
  function genWeightDest(u) {
    ensureNode();
    if (!u || !u.url) {
      return { err: "This model's download links are not pinned yet — " +
                    "they ship via the update feed." };
    }
    var s = currentSettings();
    var root = s.comfyModelsDir ? String(s.comfyModelsDir) : null;
    if (!root) {
      var install = findComfyInstall();
      if (install && install.root) {
        root = path.join(install.root, "ComfyUI", "models");
      }
    }
    if (!root) {
      return { err: "No place to put it: set a Models folder in " +
                    "Settings (ComfyUI section) or install the hidden " +
                    "backend first." };
    }
    var base = String(u.url).split("?")[0].split("#")[0];
    base = base.slice(base.lastIndexOf("/") + 1);
    if (!base) {
      return { err: "The pinned URL has no filename: " + String(u.url) };
    }
    return { root: root,
             dest: path.join(root, String(u.dir || ""), base) };
  }

  /**
   * Download ONE generation weight (an entry of a catalog model's
   * urls[]) into the panel-managed models tree.
   * ui: {status(text)?, progress(receivedBytes, totalBytes)?}
   * Returns the download controller ({cancel()}), or null when nothing
   * had to be downloaded (already present, or refused).
   */
  function downloadGenWeight(u, ui, cb) {
    ensureNode();
    ui = ui || {};
    var plan = genWeightDest(u);
    if (plan.err) { cb(new Error(plan.err)); return null; }
    var dest = plan.dest;
    try {
      var destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    } catch (eD) { cb(eD); return null; }
    if (fs.existsSync(dest)) { cb(null, dest); return null; }
    var base = path.basename(dest);
    var tmp = dest + ".part";
    if (ui.status) {
      ui.status("Downloading " + base +
        (u.sizeMB ? " (~" + Math.round(u.sizeMB / 1024 * 10) / 10 +
         " GB — this can take a while)…" : "…"));
    }
    return downloadToFile(u.url, tmp, function (rec, total) {
      if (ui.progress) {
        ui.progress(rec, total || (u.sizeMB ? u.sizeMB * 1048576 : 0));
      }
    }, function (err) {
      if (err) {
        try { fs.unlinkSync(tmp); } catch (e) {}
        cb(err);
        return;
      }
      try { fs.renameSync(tmp, dest); } catch (e) { cb(e); return; }
      cb(null, dest);
    });
  }

  // ------------------------------------------------------------- updates

  function compareVersions(a, b) {
    var pa = String(a || "0").split(".");
    var pb = String(b || "0").split(".");
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10) || 0;
      var nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  }

  /**
   * The sentence a dev can act on when the repo refuses to update.
   * git's stderr is kept as WHOLE lines (a hard byte cut mid-word cost
   * an owner the file list, 2026-09-01), and the two states this repo
   * actually gets into are answered with their fix — "update the repo
   * manually" helped nobody:
   * - uncommitted changes (a stopped agent pass mid-bump is the field
   *   case) block the merge; the overnight agent salvage-stashes these
   *   at its next pass start, so the message says that AND the manual
   *   stash for whoever will not wait;
   * - the dev branch was reset upstream (house policy after merges),
   *   so ff-only refuses; the fix is re-aligning onto origin, never
   *   merging the old history back in.
   */
  function gitPullProblem(raw) {
    var lines = String(raw).split(/\r?\n/), keep = [], len = 0, i;
    for (i = 0; i < lines.length && keep.length < 8; i++) {
      var ln = lines[i].replace(/\s+$/, "");
      if (!ln) continue;
      // Fetch progress ("From https://…", ref updates) is not the
      // problem statement — in the field it ate the whole budget and
      // the error line arrived amputated.
      if (/^From /.test(ln) || /^ *[0-9a-f]+\.\.[0-9a-f]+ /.test(ln) ||
          /^ \* \[new /.test(ln)) continue;
      if (len + ln.length > 400) break;
      keep.push(ln);
      len += ln.length;
    }
    var msg = "git pull failed: " + keep.join(" | ");
    if (/would be overwritten|local changes/i.test(raw)) {
      return msg + " — the repo has uncommitted local changes (usually " +
        "an agent pass stopped mid-work). The overnight agent salvages " +
        "them at its next pass start; to update now, stash them " +
        "(git stash push -u) and reopen the panel.";
    }
    if (/fast-forward|diverge/i.test(raw)) {
      return msg + " — the local branch has commits origin no longer " +
        "has (the dev branch is reset upstream after merges). Salvage " +
        "anything unpushed, then: git fetch origin && git checkout -B " +
        "<branch> origin/<branch>, and reopen the panel.";
    }
    return msg + " — update the repo manually.";
  }

  /**
   * How is this panel installed?
   * - "git": the extension folder is (a junction into) a git checkout —
   *   updating means `git pull` in the repo root.
   * - "package": an extracted ZXP — updating means downloading the
   *   manifest's panelPackageUrl and extracting it over ourselves.
   */
  function detectInstallKind() {
    ensureNode();
    var ext = global.AEBridge.getExtensionPath();
    var real = ext;
    try { real = fs.realpathSync(ext); } catch (e) {}
    try {
      var repoRoot = path.dirname(real);
      if (fs.existsSync(path.join(repoRoot, ".git"))) {
        return { kind: "git", repoRoot: repoRoot, extensionReal: real };
      }
    } catch (e2) {}
    return { kind: "package", extensionReal: real };
  }

  /**
   * Pull the newest panel code in, matching the install kind. The updated
   * files load on the next panel open (CEP reads the extension at launch),
   * so the caller should tell the user to reopen the panel / restart AE.
   * cb(err, {kind, changed, output?})
   */
  function installUpdate(manifest, onStatus, cb) {
    ensureNode();
    var install = detectInstallKind();
    function status(t) { if (onStatus) onStatus(t); }

    if (install.kind === "git") {
      status("Dev install detected — git pull in " + install.repoRoot + "…");
      child_process.execFile("git", ["pull", "--ff-only"],
        { cwd: install.repoRoot, timeout: 120000 },
        function (err, stdout, stderr) {
          if (err) {
            cb(new Error(gitPullProblem(String(stderr || err.message))));
            return;
          }
          var out = String(stdout || "").replace(/\s+$/, "");
          cb(null, { kind: "git", output: out.slice(-300),
                     changed: !/Already up to date/i.test(out) });
        });
      return;
    }

    var url = manifest && manifest.panelPackageUrl;
    if (!url) {
      cb(new Error("This update has no direct install package — get it " +
                   "from " + ((manifest && manifest.panelUrl) || "the store") +
                   " and reinstall the ZXP."));
      return;
    }
    var tmp = path.join(global.Settings.dataRoot(), "panel-update.zip");
    status("Downloading panel update…");

    // Freshly published files can 404 for a few minutes while GitHub's raw
    // CDN propagates — and that 404 gets negatively cached per exact URL.
    // A per-attempt cache-buster makes every retry a brand-new cache entry,
    // and we retry on our own so propagation lag self-heals.
    var attempt = 0;
    var MAX_ATTEMPTS = 4;
    var RETRY_MS = 45000;

    function tryDownload() {
      attempt++;
      var sep = url.indexOf("?") === -1 ? "?" : "&";
      var freshUrl = url + sep + "r=" + new Date().getTime();
      var lastPct = -10;
      downloadToFile(freshUrl, tmp, function (rec, total) {
        if (!total) return;
        var pct = Math.floor((rec / total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          status("Panel update: " + pct + "%");
        }
      }, function (err) {
        if (err && /HTTP 404/.test(err.message) && attempt < MAX_ATTEMPTS) {
          status("Update file still propagating (404) — retrying in " +
                 Math.round(RETRY_MS / 1000) + "s (attempt " + attempt +
                 "/" + (MAX_ATTEMPTS - 1) + ")…");
          global.setTimeout(tryDownload, RETRY_MS);
          return;
        }
        afterDownload(err);
      });
    }

    function afterDownload(err) {
      if (err) {
        if (/HTTP 404/.test(err.message)) {
          err = new Error("Update package not reachable after " +
            MAX_ATTEMPTS + " attempts (HTTP 404) — the feed may not have " +
            "published yet. It will retry on the next panel launch.");
        }
        cb(err);
        return;
      }
      status("Installing into " + install.extensionReal + "…");
      // A .zxp is a zip; extracting over the live extension folder is fine
      // on Windows — CEP loads files at panel launch and holds no locks.
      extractZip(tmp, install.extensionReal, function (xerr) {
        try { fs.unlinkSync(tmp); } catch (e) {}
        if (xerr) { cb(xerr); return; }
        cb(null, { kind: "package", changed: true });
      });
    }

    tryDownload();
  }

  /**
   * Fetch the hosted update manifest. cb(err, {manifest, panelUpdate})
   * where panelUpdate is set when a newer panel version is published.
   * The cache-buster keeps the CDN from serving a stale manifest.
   */
  function checkForUpdates(cb) {
    var mUrl = global.AELL.UPDATE_MANIFEST_URL;
    mUrl += (mUrl.indexOf("?") === -1 ? "?" : "&") +
            "r=" + new Date().getTime();
    fetchJson(mUrl, 15000,
      function (err, manifest) {
        if (err || !manifest) { cb(err || new Error("No manifest")); return; }
        var panelUpdate = null;
        if (manifest.panelVersion &&
            compareVersions(manifest.panelVersion, global.AELL.VERSION) > 0) {
          panelUpdate = {
            version: manifest.panelVersion,
            url: manifest.panelUrl || "",
            notes: manifest.notes || ""
          };
        }
        cb(null, { manifest: manifest, panelUpdate: panelUpdate });
      });
  }

  // --------------------------------------------- hidden ComfyUI backend

  /*
   * Where the managed backend is installed. EXPORTED since §17q-e,
   * because it is also the OWNERSHIP predicate — comfy.js asks this
   * rather than joining the same three components again, and two
   * spellings of an ownership test drift into a guard that matches
   * nothing (the failure 17q-c was filed for).
   *
   * ensureNode() because an exported function may now be the FIRST thing
   * a caller touches; every other entry point here already calls it, and
   * without it `path` is still null and this throws (measured in the
   * adoption test before it was added).
   */
  function comfyVendorDir() {
    ensureNode();
    return path.join(global.Settings.dataRoot(), "vendor", "comfy");
  }

  /**
   * Locate a portable ComfyUI install under vendor/comfy: a folder holding
   * ComfyUI/main.py plus the embedded python. Returns {root, python,
   * mainPy} or null.
   */
  function findComfyInstall() {
    ensureNode();
    var base = comfyVendorDir();
    var candidates = [base];
    try {
      var entries = fs.readdirSync(base);
      for (var i = 0; i < entries.length; i++) {
        candidates.push(path.join(base, entries[i]));
      }
    } catch (e) {}
    for (var j = 0; j < candidates.length; j++) {
      var root = candidates[j];
      var mainPy = path.join(root, "ComfyUI", "main.py");
      var python = path.join(root, "python_embeded", "python.exe");
      try {
        if (fs.existsSync(mainPy) && fs.existsSync(python)) {
          return { root: root, python: python, mainPy: mainPy };
        }
      } catch (e2) {}
    }
    return null;
  }

  /** Pick the portable release asset for this machine (pure, testable). */
  function pickComfyAsset(assets, hasNvidia) {
    if (!assets || !assets.length) return null;
    function find(re) {
      for (var i = 0; i < assets.length; i++) {
        if (re.test(String(assets[i].name || ""))) return assets[i];
      }
      return null;
    }
    if (hasNvidia) {
      return find(/windows.*portable.*nvidia.*\.7z$/i) ||
             find(/portable.*nvidia.*\.7z$/i) ||
             find(/portable.*\.7z$/i);
    }
    return find(/windows.*portable.*cpu.*\.7z$/i) ||
           find(/portable.*cpu.*\.7z$/i) ||
           find(/portable.*\.7z$/i);
  }

  /** Extract a .7z via Windows' bundled bsdtar (libarchive reads 7z). */
  function extract7z(archivePath, destDir, cb) {
    ensureNode();
    try {
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    } catch (e) { cb(e); return; }
    child_process.execFile("tar", ["-xf", archivePath, "-C", destDir],
      { timeout: 1800000 },
      function (err) {
        cb(err ? new Error("Could not extract the ComfyUI package (" +
          err.message + "). Windows 10+ tar.exe reads .7z; if this " +
          "persists, extract the archive manually into " + destDir)
          : null);
      });
  }

  function comfyCancelErr() {
    var e = new Error("Cancelled");
    e.cancelled = true;
    return e;
  }

  var comfyBusy = false;

  /**
   * Download + install the official portable ComfyUI build into
   * vendor/comfy so image generation can run as an invisible local
   * backend. Returns a controller with cancel(); onStatus gets step text,
   * onProgress gets (receivedBytes, totalBytes).
   */
  function bootstrapComfy(onStatus, onProgress, cb) {
    ensureNode();
    var ctrl = {
      cancelled: false,
      _dl: null,
      cancel: function () {
        ctrl.cancelled = true;
        try { if (ctrl._dl) ctrl._dl.cancel(); } catch (e) {}
      }
    };
    function status(t) { if (onStatus) onStatus(t); }
    function finish(err, res) {
      comfyBusy = false;
      cb(err, res);
    }
    if (comfyBusy) {
      cb(new Error("A backend install is already running"));
      return ctrl;
    }
    comfyBusy = true;
    ensureDataDirs();
    var existing = findComfyInstall();
    if (existing) {
      finish(null, { root: existing.root, alreadyInstalled: true });
      return ctrl;
    }
    status("Checking your GPU…");
    detectGpu(function (gpu) {
      if (ctrl.cancelled) { finish(comfyCancelErr()); return; }
      status("Finding the latest ComfyUI portable build…");
      fetchJson("https://api.github.com/repos/comfyanonymous/ComfyUI/" +
                "releases/latest", 20000, function (err, rel) {
        if (ctrl.cancelled) { finish(comfyCancelErr()); return; }
        if (err || !rel || !rel.assets) {
          finish(new Error("Could not read the ComfyUI release list" +
                           (err ? ": " + err.message : "")));
          return;
        }
        var asset = pickComfyAsset(rel.assets, gpu.hasNvidia);
        if (!asset) {
          finish(new Error("No portable ComfyUI package found in release " +
                           (rel.tag_name || "?")));
          return;
        }
        var sizeGB = asset.size
          ? Math.round(asset.size / 1e8) / 10 : null;
        status("Downloading " + asset.name +
               (sizeGB ? " (~" + sizeGB + " GB)…" : "…"));
        try {
          if (!fs.existsSync(comfyVendorDir())) {
            fs.mkdirSync(comfyVendorDir(), { recursive: true });
          }
        } catch (eM) {}
        var tmp = path.join(comfyVendorDir(),
                            "_dl-" + new Date().getTime() + ".7z");
        ctrl._dl = downloadToFile(asset.browser_download_url, tmp,
          onProgress, function (dErr) {
            ctrl._dl = null;
            if (dErr) {
              try { fs.unlinkSync(tmp); } catch (eU) {}
              finish(dErr);
              return;
            }
            status("Extracting (this can take a few minutes)…");
            extract7z(tmp, comfyVendorDir(), function (xErr) {
              try { fs.unlinkSync(tmp); } catch (eU2) {}
              if (xErr) { finish(xErr); return; }
              var inst = findComfyInstall();
              if (!inst) {
                finish(new Error("Extracted, but no ComfyUI install was " +
                                 "found under " + comfyVendorDir()));
                return;
              }
              status("Hidden ComfyUI backend installed.");
              finish(null, { root: inst.root });
            });
          });
      });
    });
    return ctrl;
  }

  global.Setup = {
    ensureDataDirs: ensureDataDirs,
    detectGpu: detectGpu,
    queryVramUsedMB: queryVramUsedMB,
    bootstrapEngine: bootstrapEngine,
    pickEngineAssets: pickAssets,
    pickEngineRelease: pickReleaseAssets,
    downloadModel: downloadModel,
    downloadGenWeight: downloadGenWeight,
    _genWeightDest: genWeightDest,    // exposed for tests
    modelCatalog: modelCatalog,
    comfyCatalog: comfyCatalog,
    recommendModel: recommendModel,
    recommendSetup: recommendSetup,
    checkForUpdates: checkForUpdates,
    detectInstallKind: detectInstallKind,
    installUpdate: installUpdate,
    findComfyInstall: findComfyInstall,
    comfyVendorDir: comfyVendorDir,
    pickComfyAsset: pickComfyAsset,
    bootstrapComfy: bootstrapComfy,
    isBusy: function () { return bootstrapBusy || comfyBusy; }
  };

})(window);
