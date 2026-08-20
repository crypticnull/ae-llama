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
        var m = String(stdout).match(/CUDA Version:\s*([\d.]+)/);
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
   * Pick the best catalog model for this machine: the largest entry whose
   * VRAM floor the GPU clears; the cpuDefault entry when there's no NVIDIA
   * GPU (or VRAM is unknown); the smallest entry as a last resort.
   */
  function recommendModel(catalog, gpu) {
    if (!catalog || catalog.length === 0) return null;
    var best = null;
    var i;
    function smallest() {
      var s = catalog[0];
      for (var j = 1; j < catalog.length; j++) {
        if (catalog[j].sizeMB < s.sizeMB) s = catalog[j];
      }
      return s;
    }
    var vram = gpu && typeof gpu.vramGB === "number" ? gpu.vramGB : null;
    if (gpu && gpu.hasNvidia && vram) {
      for (i = 0; i < catalog.length; i++) {
        if (vram >= catalog[i].minVramGB &&
            (!best || catalog[i].sizeMB > best.sizeMB)) {
          best = catalog[i];
        }
      }
      return best || smallest();   // tiny GPU: lightest model, not CPU pick
    }
    for (i = 0; i < catalog.length; i++) {
      if (catalog[i].cpuDefault) best = catalog[i];
    }
    return best || smallest();
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
            cb(new Error("git pull failed: " +
               String(stderr || err.message).slice(0, 300) +
               " — update the repo manually."));
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

  function comfyVendorDir() {
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
    bootstrapEngine: bootstrapEngine,
    downloadModel: downloadModel,
    modelCatalog: modelCatalog,
    recommendModel: recommendModel,
    checkForUpdates: checkForUpdates,
    detectInstallKind: detectInstallKind,
    installUpdate: installUpdate,
    findComfyInstall: findComfyInstall,
    pickComfyAsset: pickComfyAsset,
    bootstrapComfy: bootstrapComfy,
    isBusy: function () { return bootstrapBusy || comfyBusy; }
  };

})(window);
