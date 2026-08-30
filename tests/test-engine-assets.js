// Regression test: how the panel chooses a llama.cpp engine build.
//
// Two defects, both measured in the field on 2026-08-30 and both silent:
//
//  1. `nvidia-smi` on this machine (driver 616.56, RTX 5090) prints
//     "CUDA UMD Version: 13.4", not "CUDA Version:". The shipped regex
//     matched nothing, detectGpu answered cudaVersion:null, and
//     pickAssets fell through to its conservative "no driver info ->
//     oldest published line" branch. Measured: CUDA 12.4 (239 MB) on a
//     machine whose driver runs the 13.3 build (140 MB).
//
//  2. ggml-org/llama.cpp's /releases/latest is `v0.3.0`, whose entire
//     asset list is one `nightly-tag.txt`. Every release carrying
//     Windows binaries is a `bNNNNN` PRERELEASE, and /releases/latest
//     never returns a prerelease -- so the panel's one-click engine
//     install ended at "No suitable Windows build found in release
//     v0.3.0" for every user. The fix is the same release WALK the
//     whisper and ffmpeg acquirers already do.
//
// Everything below is real captured field data: the banners are this
// machine's, the asset lists are the GitHub API's on 2026-08-30.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aell-engine-"));

let failed = 0;
function assert(cond, msg) {
  if (cond === true) { console.log("ok  -", msg); return; }
  console.error("FAIL:", msg, cond === false ? "" : "(" + cond + ")");
  failed++;
  process.exitCode = 1;
}

// ---------------------------------------------------------------- fixtures

// Captured verbatim from `nvidia-smi` on the AE machine, 2026-08-30.
const BANNER_UMD = [
  "Sun Aug 30 05:53:32 2026",
  "+-----------------------------------------------------------------+",
  "| NVIDIA-SMI 616.56      KMD Version: 616.56   CUDA UMD Version: 13.4  |",
  "+-----------------------------------------+-----------------------+"
].join("\n");

// The spelling every older driver prints, which must keep working.
const BANNER_CLASSIC = [
  "Tue Mar 11 09:00:00 2025",
  "+-----------------------------------------------------------------+",
  "| NVIDIA-SMI 550.54.14   Driver Version: 550.54.14   CUDA Version: 12.4 |",
  "+-----------------------------------------+-----------------------+"
].join("\n");

// A banner with no CUDA line at all -- a legitimate answer, not an error.
const BANNER_NONE = "some driver tool that says nothing about CUDA";

function asset(name, size) {
  return { name: name, size: size || 1000,
           browser_download_url: "https://example.invalid/" + name };
}

// github.com/ggml-org/llama.cpp /releases/latest on 2026-08-30.
const RELEASE_LATEST = {
  tag_name: "v0.3.0", prerelease: false, draft: false,
  assets: [asset("nightly-tag.txt", 12)]
};

// github.com/ggml-org/llama.cpp /releases/tags/b10690 on 2026-08-30,
// Windows x64 subset plus the two arm64 traps that must NOT be picked.
const RELEASE_B10690 = {
  tag_name: "b10690", prerelease: true, draft: false,
  assets: [
    asset("cudart-llama-bin-win-cuda-12.4-x64.zip", 391000000),
    asset("cudart-llama-bin-win-cuda-13.3-x64.zip", 391000000),
    asset("cudart-llama-bin-win-cuda-13.4-arm64.zip", 153000000),
    asset("llama-b10690-bin-win-cpu-arm64.zip", 11000000),
    asset("llama-b10690-bin-win-cpu-x64.zip", 17000000),
    asset("llama-b10690-bin-win-cuda-12.4-x64.zip", 250000000),
    asset("llama-b10690-bin-win-cuda-13.3-x64.zip", 146000000),
    asset("llama-b10690-bin-win-cuda-13.4-arm64.zip", 140000000),
    asset("llama-b10690-bin-win-vulkan-x64.zip", 34000000),
    asset("llama-b10690-bin-ubuntu-x64.tar.gz", 16000000)
  ]
};

// This machine, as detectGpu reports it once the banner is read.
const GPU_5090 = { hasNvidia: true, name: "NVIDIA GeForce RTX 5090",
                   cudaVersion: "13.4", computeCap: 12, vramGB: 32 };

// ------------------------------------------------------- load setup.js

function loadSetup(smiBanner) {
  const calls = [];
  const fakeCp = {
    execFile: function (file, args, opts, cb) {
      calls.push([file].concat(args || []).join(" "));
      if (!args || args.length === 0) { cb(null, smiBanner, ""); return; }
      const q = args.join(" ");
      if (/compute_cap/.test(q)) {
        cb(null, "NVIDIA GeForce RTX 5090, 12.0, 32607\n", "");
        return;
      }
      cb(new Error("unexpected nvidia-smi query: " + q));
    }
  };
  const window = {
    AEBridge: {
      nodeRequire: (m) => (m === "child_process" ? fakeCp : require(m)),
      getExtensionPath: () => tmpRoot
    },
    Settings: { dataRoot: () => tmpRoot },
    AELL: { VERSION: "0.0.0", UPDATE_MANIFEST_URL: "http://localhost/x" },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout
  };
  eval(fs.readFileSync(path.join(ROOT, "extension", "js", "setup.js"), "utf8"));
  return { Setup: window.Setup, calls: calls };
}

function detect(banner) {
  const { Setup } = loadSetup(banner);
  let out = null;
  Setup.detectGpu(function (g) { out = g; });
  return out;
}

// 1. reading the driver's CUDA version -----------------------------------

const umd = detect(BANNER_UMD);
assert(umd.cudaVersion === "13.4",
       "'CUDA UMD Version: 13.4' is read as 13.4 (was null: the bug)");
assert(umd.hasNvidia === true && umd.computeCap === 12 && umd.vramGB === 32,
       "the rest of the detection is unchanged (cc 12, 32 GB)");
assert(detect(BANNER_CLASSIC).cudaVersion === "12.4",
       "the classic 'CUDA Version: 12.4' spelling still reads");
assert(detect(BANNER_NONE).cudaVersion === null,
       "a banner with no CUDA line answers null, not a wrong number");

// The widened regex must not swallow the DRIVER version sitting beside it
// on the classic banner -- "Driver Version: 550.54.14" is one word away
// from "CUDA Version" and a lazy pattern picks it up.
assert(detect(BANNER_CLASSIC).cudaVersion !== "550.54.14",
       "'Driver Version:' is never mistaken for the CUDA version");

// The whole point, end to end: the object detectGpu actually returns for
// this machine's banner, handed straight to the asset chooser. This is
// the field measurement -- CUDA 12.4 (250 MB) where 13.3 (146 MB) runs.
{
  const { Setup: S } = loadSetup(BANNER_UMD);
  let live = null;
  S.detectGpu(function (g) { live = g; });
  const picked = S.pickEngineAssets(RELEASE_B10690, live);
  assert(picked.label === "CUDA 13.3",
         "detectGpu -> pickAssets on this machine ends at CUDA 13.3, " +
         "not the 12.4 the unread banner used to buy");
}

// 2. the release walk ----------------------------------------------------

const { Setup } = loadSetup(BANNER_UMD);

const aloneAtLatest = Setup.pickEngineRelease(RELEASE_LATEST, GPU_5090);
assert(aloneAtLatest.err && /v0\.3\.0/.test(aloneAtLatest.err),
       "the asset-less v0.3.0 alone is refused, and the refusal names it");
assert(aloneAtLatest.err && !aloneAtLatest.picked,
       "a refusal never hands back a half-answer to download");

const walked = Setup.pickEngineRelease([RELEASE_LATEST, RELEASE_B10690],
                                       GPU_5090);
assert(!walked.err && walked.release.tag_name === "b10690",
       "the walk steps past v0.3.0 onto the release that has the build");
assert(walked.picked && walked.picked.label === "CUDA 13.3",
       "and picks the newest CUDA line the 13.4 driver can run");
assert(walked.picked &&
       walked.picked.assets.map((a) => a.name).join(" + ") ===
       "llama-b10690-bin-win-cuda-13.3-x64.zip + " +
       "cudart-llama-bin-win-cuda-13.3-x64.zip",
       "the matching cudart bundle rides along with it");

// A prerelease is exactly what we are walking TO -- never a reason to skip.
assert(!Setup.pickEngineRelease([RELEASE_B10690], GPU_5090).err,
       "a prerelease is eligible (every llama.cpp Windows build is one)");
// A draft is not published and its assets are not downloadable.
const draftOnly = Setup.pickEngineRelease(
  [Object.assign({}, RELEASE_B10690, { draft: true })], GPU_5090);
assert(draftOnly.err && /no llama\.cpp releases/i.test(draftOnly.err),
       "a draft release is skipped and the refusal says the list was empty");

// Invoke-RestMethod's nesting trap has a JS twin: fetchJson hands back
// whatever GitHub sent, and the caller cannot tell one release from a
// list of one by looking.
assert(!Setup.pickEngineRelease([[RELEASE_LATEST], [[RELEASE_B10690]]],
                                GPU_5090).err,
       "a nested array of releases is flattened, not treated as one release");
assert(Setup.pickEngineRelease([], GPU_5090).err ===
       "GitHub returned no llama.cpp releases.",
       "an empty list is refused with its own sentence");

// 3. the CUDA line, now that the driver version is actually known --------

function pickWith(gpu) {
  const p = Setup.pickEngineAssets(RELEASE_B10690, gpu);
  return p ? p.label : null;
}

assert(pickWith(GPU_5090) === "CUDA 13.3",
       "driver 13.4 takes the 13.3 build, the newest it can run");
assert(pickWith(Object.assign({}, GPU_5090, { cudaVersion: "12.8" })) ===
       "CUDA 12.4",
       "driver 12.8 stops at 12.4 - a newer toolkit build fails at load");
assert(pickWith(Object.assign({}, GPU_5090, { cudaVersion: null })) ===
       "CUDA 12.4",
       "an unreadable driver is still conservative: the OLDEST line " +
       "(which is what the UMD bug made this machine do)");
assert(pickWith(Object.assign({}, GPU_5090,
                              { cudaVersion: "13.4", computeCap: 6.1 })) ===
       "CUDA 12.4",
       "compute capability under 7.5 is barred from the CUDA 13 line");
assert(pickWith({ hasNvidia: false }) === "CPU",
       "no NVIDIA GPU takes the CPU build");
assert(Setup.pickEngineAssets(RELEASE_B10690, { hasNvidia: false })
         .assets[0].name === "llama-b10690-bin-win-cpu-x64.zip",
       "and it is the x64 CPU zip, never the arm64 one sitting beside it");
assert(pickWith(Object.assign({}, GPU_5090, { cudaVersion: "11.8" })) ===
       "CPU (no compatible CUDA build)",
       "a driver older than every published line falls back to the CPU " +
       "build, labelled with WHY, rather than installing one it cannot load");

// The arm64 CUDA zip is 13.4 - the driver's own number - so a regex that
// forgot the -x64 suffix would prefer it over the build that runs here.
assert(walked.picked.assets.every((a) => !/arm64/.test(a.name)) === true,
       "no arm64 asset can be picked on an x64 machine");

// 4. the PowerShell half: get-llama.ps1 must use the shared helpers ------

const psLib = path.join(ROOT, "scripts", "lib", "gpu-detect.ps1");
assert(fs.existsSync(psLib), "scripts/lib/gpu-detect.ps1 exists");
const libBytes = fs.readFileSync(psLib);
assert(libBytes.every((b) => b < 128) === true,
       "gpu-detect.ps1 is pure ASCII (Windows PowerShell 5.1)");

const getLlama = fs.readFileSync(path.join(ROOT, "scripts", "get-llama.ps1"),
                                 "utf8");
assert(/gpu-detect\.ps1/.test(getLlama),
       "get-llama.ps1 dot-sources the shared GPU helpers");
assert(!/CUDA Version:\\s/.test(getLlama),
       "and no longer carries its own 'CUDA Version:' regex");
assert(!/function ConvertTo-PaddedVersion/.test(getLlama),
       "nor its own two-part version padder");
// The comment above it explains /releases/latest, so this looks at the
// URL the script actually builds, not at the word appearing anywhere.
assert(/apiUrl = '[^']*releases\?per_page=\d+'/.test(getLlama) &&
       !/apiUrl = '[^']*releases\/latest'/.test(getLlama),
       "it queries the release LIST, never /releases/latest");
assert(/Expand-AellReleaseList/.test(getLlama),
       "and flattens what Invoke-RestMethod hands back");

const whisperAssets = fs.readFileSync(
  path.join(ROOT, "scripts", "lib", "whisper-assets.ps1"), "utf8");
assert(/gpu-detect\.ps1/.test(whisperAssets) &&
       !/function Get-AellCudaVersionFromSmi/.test(whisperAssets),
       "whisper-assets.ps1 uses the shared copy rather than a second one");

// Run the helpers for real -- they are the half a JS regex cannot prove.
function ps(script) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive",
                                     "-Command", script],
                      { encoding: "utf8", timeout: 60000 }).trim();
}
const dot = ". '" + psLib.replace(/'/g, "''") + "'\n";
try {
  assert(ps(dot + "Get-AellCudaVersionFromSmi -Text @'\n" + BANNER_UMD +
            "\n'@") === "13.4",
         "PowerShell: the UMD banner reads 13.4 as well");
  assert(ps(dot + "Get-AellCudaVersionFromSmi -Text @'\n" + BANNER_CLASSIC +
            "\n'@") === "12.4",
         "PowerShell: the classic banner still reads 12.4");
  assert(ps(dot + "'[' + (Get-AellCudaVersionFromSmi -Text 'nothing') + ']'") ===
         "[]",
         "PowerShell: no CUDA line answers empty, not a wrong number");
  assert(ps(dot + "if ((ConvertTo-AellPaddedVersion '11.8') -eq " +
            "(ConvertTo-AellPaddedVersion '11.8.0')) { 'equal' } else " +
            "{ 'NOT equal' }") === "equal",
         "PowerShell: 11.8 and 11.8.0 compare EQUAL (the -1 padding trap)");
  assert(ps(dot + "if ((ConvertTo-AellPaddedVersion '13.4') -gt " +
            "(ConvertTo-AellPaddedVersion '13.3')) { 'newer' } else " +
            "{ 'NOT newer' }") === "newer",
         "PowerShell: 13.4 is still newer than 13.3");
} catch (e) {
  assert("powershell unavailable: " + e.message,
         "the PowerShell helpers run");
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
