/**
 * Probe: what engine build does the SHIPPED panel pick on this machine?
 *
 * Drives the real extension/js/setup.js (detectGpu + pickEngineAssets)
 * against the real nvidia-smi and the real llama.cpp release asset list,
 * then repeats the pick with the driver's CUDA version supplied by hand
 * so the two answers can be compared. No downloads, no AE.
 *
 *   node scripts/engine-asset-probe.js [--tag b1234]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execFile } = require("child_process");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aell-engine-probe-"));
const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => tmpRoot },
  Settings: { dataRoot: () => tmpRoot },
  AELL: { VERSION: "0.0.0", UPDATE_MANIFEST_URL: "http://localhost/x" },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout
};
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "setup.js"), "utf8"));
const Setup = window.Setup;

const tagArg = (() => {
  const i = process.argv.indexOf("--tag");
  return i > 0 ? process.argv[i + 1] : "latest";
})();

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({ "User-Agent": "ae-llama-probe" },
        process.env.GITHUB_TOKEN
          ? { Authorization: "Bearer " + process.env.GITHUB_TOKEN } : {})
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(getJson(res.headers.location));
        return;
      }
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error("HTTP " + res.statusCode + ": " + body.slice(0, 200)));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
  });
}

function rawSmi() {
  return new Promise((resolve) => {
    execFile("nvidia-smi", [], { timeout: 15000 },
      (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

(async function main() {
  console.log("== 1. the nvidia-smi banner this machine prints ==");
  const smi = await rawSmi();
  const banner = smi.split(/\r?\n/).slice(0, 4).join("\n");
  console.log(banner || "(nvidia-smi not available)");
  const shipped = smi.match(/CUDA Version:\s*([\d.]+)/);
  const widened = smi.match(/CUDA(?:\s+\w+)?\s+Version\s*:\s*([\d.]+)/);
  console.log("  shipped regex /CUDA Version:/ ->",
              shipped ? shipped[1] : "NO MATCH");
  console.log("  widened regex               ->",
              widened ? widened[1] : "NO MATCH");

  console.log("\n== 2. Setup.detectGpu (the shipped path) ==");
  const gpu = await new Promise((r) => Setup.detectGpu(r));
  console.log(" ", JSON.stringify(gpu));

  console.log("\n== 3. the real llama.cpp release ==");
  const api = tagArg === "latest"
    ? "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
    : "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/" + tagArg;
  const release = await getJson(api);
  const cuda = release.assets
    .map((a) => a.name)
    .filter((n) => /^llama-.*-bin-win-cuda-/.test(n));
  console.log("  tag:", release.tag_name, "| CUDA assets:", cuda.join(", "));

  console.log("\n== 4. what the panel picks ==");
  const asIs = Setup.pickEngineAssets(release, gpu);
  console.log("  with detectGpu as it stands :", asIs && asIs.label,
              "->", asIs && asIs.assets.map((a) => a.name).join(" + "));
  const fixed = Setup.pickEngineAssets(release, Object.assign({}, gpu, {
    cudaVersion: widened ? widened[1] : gpu.cudaVersion
  }));
  console.log("  with the driver CUDA read   :", fixed && fixed.label,
              "->", fixed && fixed.assets.map((a) => a.name).join(" + "));

  console.log("\n== 5. the release WALK (what /releases/latest cannot do) ==");
  const list = await getJson(
    "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15");
  console.log("  releases returned:",
              list.map((r) => r.tag_name + (r.prerelease ? "*" : "")).join(", "));
  const latest = await getJson(
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest");
  console.log("  /releases/latest  :", latest.tag_name, "->",
              latest.assets.map((a) => a.name).join(", ") || "(no assets)");
  const oneShot = Setup.pickEngineRelease(latest, gpu);
  console.log("  walk over /latest alone :",
              oneShot.err ? "REFUSED - " + oneShot.err
                          : oneShot.release.tag_name + " " + oneShot.picked.label);
  const walked = Setup.pickEngineRelease(list, gpu);
  console.log("  walk over the list      :",
              walked.err ? "REFUSED - " + walked.err
                         : walked.release.tag_name + " " + walked.picked.label +
                           " -> " + walked.picked.assets.map((a) => a.name).join(" + "));

  console.log("\n== verdict ==");
  if (!gpu.hasNvidia) {
    console.log("  no NVIDIA GPU here - nothing to compare.");
  } else if (asIs && fixed && asIs.label === fixed.label) {
    console.log("  SAME pick either way on this release.");
  } else {
    console.log("  DIFFERENT: the unread driver version costs the panel " +
                (asIs && asIs.label) + " where it should install " +
                (fixed && fixed.label) + ".");
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
})().catch((e) => {
  console.error("probe failed:", e.message);
  process.exitCode = 1;
});
