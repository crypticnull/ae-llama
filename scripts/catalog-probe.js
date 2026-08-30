/*
 * catalog-probe.js — WORKPLAN item 7, bullet 4: is the shipped catalog
 * honest?
 *
 * Both catalogs in extension/js/version.js were written from training, not
 * from the network: every URL is a guess at a repo path and every sizeMB is
 * a guess at a file. The remote session could not check either (no HF from
 * there). This machine can, and neither check needs a GPU, a generation, or
 * a single byte of the weights downloaded:
 *
 *   - a HEAD against each URL says whether the file is STILL THERE, and
 *     HuggingFace answers the redirect with `x-linked-size`, the exact byte
 *     count of the file the download would have fetched;
 *   - the panel's own model roots say whether this machine already HAS the
 *     file, in which case the size on disk settles it with no network at
 *     all — and that is the same number the arbiter measures at generation
 *     time (tools.js modelFileMB), so it is the number the catalog should
 *     have been quoting.
 *
 * Units are the whole point of the size half. Everything downstream of the
 * catalog counts in MiB: nvidia-smi reports MiB, modelFileMB divides by
 * 1048576, planHandoff multiplies vramGB by 1024. A catalog quoting decimal
 * MB overstates every file by 4.9%, which is 2 GB on the H3 stack.
 *
 * Reads only. Writes a markdown transcript to logs/ and exits non-zero if
 * any URL is dead or any size is wrong by more than the tolerance.
 *
 *   node scripts/catalog-probe.js
 *   node scripts/catalog-probe.js --no-net      # disk + internal checks only
 *   node scripts/catalog-probe.js --tolerance 2 # percent
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const OPT = {
  net: argv.indexOf("--no-net") === -1,
  tolerancePct: parseFloat(argValue("--tolerance", "2"))
};

// --------------------------------------------------------- the panel, in Node

const storage = {};
const window = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  localStorage: {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null;
    },
    setItem(k, v) { storage[k] = String(v); },
    removeItem(k) { delete storage[k]; }
  },
  AEBridge: {
    nodeRequire: require,
    getExtensionPath() { return EXT; },
    evalScript(script, cb) { if (cb) cb("", true); }
  }
};
window.window = window;
function loadPanelFile(rel) {
  const src = fs.readFileSync(path.join(EXT, "js", rel), "utf8");
  new Function("window", src)(window);
}
loadPanelFile("version.js");
loadPanelFile("settings.js");
loadPanelFile("tiers.js");
loadPanelFile("setup.js");

const AELL = window.AELL;
const Settings = window.Settings;
const Setup = window.Setup;

// --------------------------------------------------------------- reporting

const transcript = [];
let failures = 0;
function say(kind, text) {
  transcript.push({ kind: kind, text: text });
  const tag = { info: "--", row: "  ", verdict: "==", error: "!!" }[kind] || "  ";
  console.log(tag + " " + String(text).replace(/\n/g, "\n   "));
}
function verdict(ok, label, detail) {
  if (!ok) failures++;
  say("verdict", (ok ? "PASS " : "FAIL ") + label + (detail ? " - " + detail : ""));
}

const MIB = 1048576;
function mib(bytes) { return Math.round(bytes / MIB); }
function decMB(bytes) { return Math.round(bytes / 1e6); }

// ------------------------------------------------------------- model roots

/* The panel's OWN root list, not a hand-written one: comfyModelRoots is
 * private to tools.js, so this mirrors its inputs (settings.comfyModelRoots,
 * settings.comfyDir, Setup.findComfyInstall) plus the Desktop app's shared
 * store, which docs/COMFY_LOCAL_INVENTORY.md found is a third root. */
function modelRoots() {
  const s = Settings.get();
  const roots = [];
  const list = s.comfyModelRoots;
  if (list) {
    String(list).split(/[;\n]/).forEach(function (raw) {
      const p = raw.trim();
      if (p) roots.push(p);
    });
  }
  if (s.comfyDir) roots.push(path.join(s.comfyDir, "models"));
  try {
    const install = Setup.findComfyInstall && Setup.findComfyInstall();
    if (install && install.root) {
      roots.push(path.join(install.root, "ComfyUI", "models"));
    }
  } catch (e) {}
  const home = process.env.USERPROFILE || "";
  if (home) {
    roots.push(path.join(home, "Documents", "ComfyUI", "models"));
    roots.push(path.join(home, "AppData", "Local", "Comfy-Desktop",
                         "ComfyUI-Shared", "models"));
  }
  const seen = {};
  return roots.filter(function (p) {
    if (!p || seen[p]) return false;
    seen[p] = true;
    return true;
  });
}
const ROOTS = modelRoots();

/** Bytes of `dir/file` under any known root, or null. */
function onDisk(dir, file) {
  for (const r of ROOTS) {
    const candidates = [path.join(r, String(dir || ""), file), path.join(r, file)];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          const b = fs.statSync(c).size;
          if (b > 0) return { bytes: b, path: c };
        }
      } catch (e) {}
    }
  }
  return null;
}

// ------------------------------------------------------------------ network

/** HEAD, following redirects. Resolves {status, bytes, finalUrl, err}. */
function head(rawUrl, hops) {
  hops = hops || 0;
  return new Promise(function (resolve) {
    let u;
    try { u = new URL(rawUrl); } catch (e) {
      resolve({ status: 0, bytes: null, err: "unparseable URL" });
      return;
    }
    const req = https.request(u, { method: "HEAD" }, function (res) {
      res.resume();
      const h = res.headers;
      // HF puts the real file size on the REDIRECT, not on the CDN reply.
      const linked = parseInt(h["x-linked-size"], 10);
      const clen = parseInt(h["content-length"], 10);
      if (res.statusCode >= 300 && res.statusCode < 400 && h.location) {
        if (linked > 0) {
          resolve({ status: res.statusCode, bytes: linked,
                    finalUrl: h.location, via: "x-linked-size" });
          return;
        }
        if (hops >= 5) {
          resolve({ status: res.statusCode, bytes: null,
                    err: "too many redirects" });
          return;
        }
        const next = new URL(h.location, u).toString();
        head(next, hops + 1).then(resolve);
        return;
      }
      resolve({ status: res.statusCode,
                bytes: linked > 0 ? linked : (clen > 0 ? clen : null),
                via: linked > 0 ? "x-linked-size" : "content-length" });
    });
    req.on("error", function (e) {
      resolve({ status: 0, bytes: null, err: e.message });
    });
    req.setTimeout(30000, function () {
      req.destroy();
      resolve({ status: 0, bytes: null, err: "timeout" });
    });
    req.end();
  });
}

// --------------------------------------------------------------------- run

function pct(a, b) { return Math.abs(a - b) / b * 100; }

async function checkFile(label, entryMB, url, dir, file) {
  const disk = file ? onDisk(dir, file) : null;
  let net = null;
  if (OPT.net && url) net = await head(url);
  const bytes = disk ? disk.bytes : (net && net.bytes ? net.bytes : null);
  const src = disk ? "disk" : (net && net.bytes ? "HEAD" : null);

  if (url && net) {
    const alive = net.status === 200 ||
                  (net.status >= 300 && net.status < 400);
    if (!alive || net.err) {
      verdict(false, "URL " + label,
              "HTTP " + net.status + (net.err ? " " + net.err : "") +
              "\n     " + url);
    } else {
      say("row", "url ok  " + label + "  HTTP " + net.status);
    }
  }
  if (bytes === null) {
    say("row", "size ?  " + label + "  (no disk copy, no size from the network)");
    return { label: label, bytes: null };
  }
  const realMiB = mib(bytes), realMB = decMB(bytes);
  say("row", "size    " + label + "  " + bytes + " B = " + realMiB +
             " MiB / " + realMB + " MB(dec)  [" + src + "]" +
             (disk ? "\n     " + disk.path : ""));
  if (typeof entryMB === "number" && entryMB > 0) {
    const offMiB = pct(entryMB, realMiB);
    const looksDecimal = pct(entryMB, realMB) <= OPT.tolerancePct &&
                         offMiB > OPT.tolerancePct;
    verdict(offMiB <= OPT.tolerancePct, "sizeMB " + label,
            "catalog " + entryMB + " vs " + realMiB + " MiB (" +
            offMiB.toFixed(1) + "% off)" +
            (looksDecimal ? " - the catalog number is DECIMAL MB" : ""));
  }
  return { label: label, bytes: bytes, mib: realMiB };
}

(async function main() {
  say("info", "catalog-probe " + new Date().toISOString());
  say("info", "model roots searched:\n     " + ROOTS.join("\n     "));
  say("info", "tolerance " + OPT.tolerancePct + "%, network " +
              (OPT.net ? "on" : "OFF"));

  say("info", "--- MODEL_CATALOG (chat GGUFs) ---");
  for (const m of AELL.MODEL_CATALOG) {
    await checkFile(m.name, m.sizeMB, m.url, null, m.name);
  }

  say("info", "--- COMFY_CATALOG (generation weights) ---");
  for (const e of AELL.COMFY_CATALOG) {
    say("info", e.name + " (" + e.label + ") sizeMB=" + e.sizeMB +
                " minVramGB=" + e.minVramGB + " measured=" + !!e.measured);
    const urls = e.urls || [];
    let sum = 0, allKnown = urls.length > 0;
    for (const u of urls) {
      const file = decodeURIComponent(
        String(u.url).split("/").pop().split("?")[0]);
      const r = await checkFile(e.name + "/" + file, u.sizeMB, u.url,
                                u.dir, file);
      if (r.bytes === null) allKnown = false; else sum += r.mib;
    }
    // Files the entry names but does not link (krea2 registers by name).
    for (const f of (e.files || [])) {
      const d = onDisk(null, f);
      say("row", "file    " + e.name + "/" + f + "  " +
                 (d ? mib(d.bytes) + " MiB  " + d.path
                    : "not on this machine"));
    }
    if (urls.length) {
      // The entry's own sizeMB must be the sum of the files it downloads:
      // it is the only number a user sees before agreeing to the download.
      const declared = urls.reduce(function (a, u) {
        return a + (typeof u.sizeMB === "number" ? u.sizeMB : NaN);
      }, 0);
      if (typeof e.sizeMB === "number" && !isNaN(declared)) {
        verdict(e.sizeMB === declared, "sum " + e.name,
                "entry sizeMB " + e.sizeMB + " vs sum of its urls " + declared);
      }
      if (allKnown) {
        say("row", "real total for " + e.name + ": " + sum + " MiB");
      }
    }
  }

  const md = ["# catalog-probe " + new Date().toISOString(), ""];
  transcript.forEach(function (r) {
    md.push("    " + r.text.replace(/\n/g, "\n    "));
  });
  const outDir = path.join(ROOT, "logs");
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
  const out = path.join(outDir, "catalog-probe-" +
    new Date().toISOString().replace(/[:.]/g, "-") + ".md");
  fs.writeFileSync(out, md.join("\n"), "utf8");
  say("info", "transcript: " + out);
  say("info", failures ? failures + " FAILURE(S)" : "all checks passed");
  process.exit(failures ? 1 : 0);
})();
