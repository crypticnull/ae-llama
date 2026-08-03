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

  function ensureNode() {
    if (http) return;
    http = global.AEBridge.nodeRequire("http");
    https = global.AEBridge.nodeRequire("https");
    fs = global.AEBridge.nodeRequire("fs");
    path = global.AEBridge.nodeRequire("path");
    child_process = global.AEBridge.nodeRequire("child_process");
    NodeBuffer = global.AEBridge.nodeRequire("buffer").Buffer;
  }

  // ------------------------------------------------------------ data dirs

  /** Create the persistent data tree and seed workflow templates. */
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
    // Seed bundled ComfyUI templates on first run (never overwrite edits).
    try {
      var src = path.join(global.AEBridge.getExtensionPath(), "comfy-workflows");
      var dst = path.join(root, "comfy-workflows");
      if (fs.existsSync(src)) {
        var entries = fs.readdirSync(src);
        for (var j = 0; j < entries.length; j++) {
          var to = path.join(dst, entries[j]);
          if (!fs.existsSync(to)) {
            fs.writeFileSync(to, fs.readFileSync(path.join(src, entries[j])));
          }
        }
      }
    } catch (e) {}
  }

  // -------------------------------------------------------- GPU detection

  /**
   * Detect NVIDIA capability via nvidia-smi (ships with the driver).
   * cb({hasNvidia, cudaVersion: "12.8"|null, computeCap: 8.6|null})
   */
  function detectGpu(cb) {
    ensureNode();
    child_process.execFile("nvidia-smi", [], { timeout: 15000 },
      function (err, stdout) {
        if (err) {
          cb({ hasNvidia: false, cudaVersion: null, computeCap: null });
          return;
        }
        var cuda = null;
        var m = String(stdout).match(/CUDA Version:\s*([\d.]+)/);
        if (m) cuda = m[1];
        child_process.execFile("nvidia-smi",
          ["--query-gpu=compute_cap", "--format=csv,noheader"],
          { timeout: 15000 },
          function (err2, stdout2) {
            var cc = null;
            if (!err2) {
              var line = String(stdout2).split(/\r?\n/)[0].trim();
              if (/^\d+(\.\d+)?$/.test(line)) cc = parseFloat(line);
            }
            cb({ hasNvidia: true, cudaVersion: cuda, computeCap: cc });
          });
      });
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
   * a CDN). onProgress(receivedBytes, totalBytes|0) throttled by caller.
   */
  function downloadToFile(url, destPath, onProgress, cb, redirects) {
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
      headers: { "User-Agent": "ae-llama-panel" }
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 &&
          res.headers.location && redirects < 5) {
        res.resume();
        downloadToFile(res.headers.location, destPath, onProgress, cb,
                       redirects + 1);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        cb(new Error("Download failed (HTTP " + res.statusCode + ")"));
        return;
      }
      var total = parseInt(res.headers["content-length"] || "0", 10);
      var received = 0;
      var out = fs.createWriteStream(destPath);
      res.on("data", function (c) {
        received += c.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(out);
      out.on("finish", function () { out.close(); cb(null, destPath); });
      out.on("error", function (e) { cb(e); });
      res.on("error", function (e) { cb(e); });
    });
    req.on("error", function (e) { cb(e); });
    // No idle timeout on multi-GB downloads; errors/aborts still fire.
    req.end();
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
    if (bootstrapBusy) { cb(new Error("Setup is already running")); return; }
    opts = opts || {};
    function status(t) { if (onStatus) onStatus(t); }

    ensureDataDirs();
    var vendorRoot = path.join(global.Settings.dataRoot(), "vendor");
    var vendorDir = path.join(vendorRoot, "llama.cpp");

    var existing = global.Llama.findServerExe(global.Settings.get().serverPath);
    if (existing && !opts.force) {
      cb(null, { serverPath: existing, skipped: true });
      return;
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
          (gpu.computeCap !== null ? ", compute " + gpu.computeCap : "") + ")"
        : "No NVIDIA GPU detected — using the CPU build");

      var tag = opts.tag || "latest";
      var api = tag === "latest"
        ? "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
        : "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/" + tag;

      status("Fetching llama.cpp release info…");
      fetchJson(api, 30000, function (err, release) {
        if (err) { finish(new Error("Could not reach GitHub: " + err.message)); return; }
        var picked = pickAssets(release, gpu);
        if (!picked) {
          finish(new Error("No suitable Windows build found in release " +
                           (release.tag_name || tag)));
          return;
        }
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
          var asset = queue.shift();
          var zipPath = path.join(vendorRoot, asset.name);
          var mb = Math.round((asset.size || 0) / 1048576);
          status("Downloading " + asset.name +
                 (mb ? " (" + mb + " MB)…" : "…"));
          var lastPct = -10;
          downloadToFile(asset.browser_download_url, zipPath,
            function (rec, total) {
              if (!total) return;
              var pct = Math.floor((rec / total) * 100);
              if (pct >= lastPct + 10) {
                lastPct = pct;
                status(asset.name + ": " + pct + "%");
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
  }

  // -------------------------------------------------------- starter model

  function downloadStarterModel(manifest, onStatus, cb) {
    ensureNode();
    ensureDataDirs();
    var model = (manifest && manifest.starterModel) ||
                global.AELL.FALLBACK_STARTER_MODEL;
    if (!model || !model.url) {
      cb(new Error("No starter model configured"));
      return;
    }
    var dest = path.join(global.Settings.dataRoot(), "models", model.name);
    if (fs.existsSync(dest)) { cb(null, dest); return; }
    var tmp = dest + ".part";
    if (onStatus) {
      onStatus("Downloading " + model.name +
        (model.sizeMB ? " (~" + Math.round(model.sizeMB / 1024 * 10) / 10 +
         " GB — this can take a while)…" : "…"));
    }
    var lastPct = -5;
    downloadToFile(model.url, tmp, function (rec, total) {
      if (!total || !onStatus) return;
      var pct = Math.floor((rec / total) * 100);
      if (pct >= lastPct + 5) {
        lastPct = pct;
        onStatus(model.name + ": " + pct + "%");
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
   * Fetch the hosted update manifest. cb(err, {manifest, panelUpdate})
   * where panelUpdate is set when a newer panel version is published.
   */
  function checkForUpdates(cb) {
    fetchJson(global.AELL.UPDATE_MANIFEST_URL, 15000,
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

  global.Setup = {
    ensureDataDirs: ensureDataDirs,
    detectGpu: detectGpu,
    bootstrapEngine: bootstrapEngine,
    downloadStarterModel: downloadStarterModel,
    checkForUpdates: checkForUpdates,
    isBusy: function () { return bootstrapBusy; }
  };

})(window);
