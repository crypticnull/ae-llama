// Regression test: WHICH whisper.cpp download scripts/get-whisper.ps1
// takes, and from which release.
//
// The bug this exists for: Invoke-RestMethod hands a JSON array back as
// ONE object rather than enumerating it into the pipeline, so the first
// version of get-whisper.ps1 wrote `@(Invoke-RestMethod .../releases)`
// and got a one-element array holding all 15 releases. `foreach` then ran
// exactly once with $r bound to the whole list, and PowerShell's property
// flattening turned $r.assets into every asset of every release pooled
// together. The script downloaded a real whisper-bin-x64.zip out of that
// soup -- from no particular release -- transcribed a WAV correctly, and
// printed "Release: System.Object[]". Everything looked green except six
// characters of the log line. The walk that exists to skip an asset-less
// release had never run at all.
//
// So the assertions here are about the RELEASE the asset came from, not
// just about finding an asset: a test that only checked "we picked
// whisper-bin-x64.zip" passes on the broken version.
//
// The release lists below are captured verbatim from the GitHub API on
// 2026-08-29, which is why the newest entry is a prerelease with zero
// assets -- that is the real published state, not a contrived case.
//
// The decision lives in scripts/lib/whisper-assets.ps1 because the
// acquirer is PowerShell; this test drives those same functions, so it
// gates the script rather than a paraphrase of it.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "scripts", "lib", "whisper-assets.ps1");
const SCRIPT = path.join(ROOT, "scripts", "get-whisper.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// --- captured from the GitHub API 2026-08-29 --------------------------
// ggml-org/whisper.cpp /releases?per_page=15, trimmed to the fields the
// choice reads. v1.9.3 is the NEWEST tag and carries nothing.
const RELEASES = [
  { tag_name: "v1.9.3", prerelease: true, assets: [] },
  {
    tag_name: "b4938", prerelease: false, assets: [
      { name: "whisper-b4938-xcframework.zip", size: 53582336 },
      { name: "whisper-bin-ubuntu-arm64.tar.gz", size: 4613734 },
      { name: "whisper-bin-ubuntu-x64.tar.gz", size: 9541222 },
      { name: "whisper-bin-Win32.zip", size: 5347737 },
      { name: "whisper-bin-x64.zip", size: 8361840 },
      { name: "whisper-blas-bin-Win32.zip", size: 12373196 },
      { name: "whisper-blas-bin-x64.zip", size: 21181235 },
      { name: "whisper-cublas-11.8.0-bin-x64.zip", size: 269898342 },
      { name: "whisper-cublas-12.4.0-bin-x64.zip", size: 671088640 }
    ]
  },
  {
    tag_name: "v1.9.2", prerelease: false, assets: [
      { name: "whisper-bin-x64.zip", size: 8300000 },
      { name: "whisper-blas-bin-x64.zip", size: 21000000 },
      { name: "whisper-cublas-11.8.0-bin-x64.zip", size: 269000000 },
      { name: "whisper-cublas-12.4.0-bin-x64.zip", size: 670000000 }
    ]
  }
];

if (process.platform !== "win32") {
  console.log("skip - PowerShell decision library is Windows-only");
  process.exit(0);
}

/**
 * Run one PowerShell script that dot-sources the asset library, so a
 * whole batch of cases costs a single spawn. The captured release list is
 * handed over as JSON and rebuilt with ConvertFrom-Json, which produces
 * exactly the PSCustomObject shape Invoke-RestMethod would.
 */
function runPs(body) {
  const preamble =
    ". '" + LIB.replace(/'/g, "''") + "'\n" +
    "$ErrorActionPreference = 'Stop'\n" +
    "$RAW = @'\n" + JSON.stringify(RELEASES) + "\n'@\n" +
    "$RELEASES = ConvertFrom-Json $RAW\n";
  const file = path.join(
    process.env.TEMP || ".", "aell-whisper-test-" + process.pid + ".ps1");
  fs.writeFileSync(file, preamble + body, "ascii");
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file
    ], { encoding: "utf8" });
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
}

// ---------------------------------------------------------------------
// THE bug: the shape Invoke-RestMethod actually delivers.
//
// `$RELEASES` here is a proper 3-element array. `@($RELEASES)` after an
// Invoke-RestMethod is NOT -- it is one element holding all three. Both
// shapes must choose the same release, or the acquirer's behaviour
// depends on a wrapping detail nobody can see in the output.
// ---------------------------------------------------------------------
const nestedCases = runPs([
  // (a) flat, the shape the code was written for
  "$flat = Select-AellWhisperRelease -Releases $RELEASES -Variant cpu",
  "Write-Output ('FLAT_TAG=' + $flat.Release.tag_name)",
  "Write-Output ('FLAT_ASSET=' + $flat.Asset.name)",
  // (b) nested one deep -- what @(Invoke-RestMethod ...) really produces
  "$wrapped = @(,$RELEASES)",
  "Write-Output ('WRAPPED_COUNT=' + $wrapped.Count)",
  "$nest = Select-AellWhisperRelease -Releases $wrapped -Variant cpu",
  "Write-Output ('NEST_TAG=' + $nest.Release.tag_name)",
  "Write-Output ('NEST_ASSET=' + $nest.Asset.name)",
  "Write-Output ('NEST_SIZE=' + $nest.Asset.size)"
].join("\n"));

function field(out, key) {
  const m = new RegExp("^" + key + "=(.*)$", "m").exec(out);
  return m ? m[1].trim() : null;
}

assert(field(nestedCases, "WRAPPED_COUNT") === "1",
  "the wrapped shape really is one element (the trap is reproduced)");
assert(field(nestedCases, "FLAT_TAG") === "b4938",
  "flat list: skips the asset-less v1.9.3 and lands on b4938");
assert(field(nestedCases, "NEST_TAG") === "b4938",
  "nested list: the SAME release, not a pooled System.Object[]");
assert(field(nestedCases, "NEST_ASSET") === "whisper-bin-x64.zip",
  "nested list: the cpu asset");
// The pooled-assets bug picks a whisper-bin-x64.zip too -- b4938's, as it
// happens, because it sorts first. Pinning the SIZE is what separates
// "came from b4938" from "came from the soup and b4938 won the race":
// v1.9.2's asset has a different size, and a flattening regression that
// reorders lands on it silently.
assert(field(nestedCases, "NEST_SIZE") === "8361840",
  "nested list: the asset is b4938's own, by size");

// ---------------------------------------------------------------------
// Expand-AellReleaseList on its own.
// ---------------------------------------------------------------------
const expand = runPs([
  "Write-Output ('E1=' + @(Expand-AellReleaseList $RELEASES).Count)",
  "Write-Output ('E2=' + @(Expand-AellReleaseList @(,$RELEASES)).Count)",
  "Write-Output ('E3=' + @(Expand-AellReleaseList @(,@(,$RELEASES))).Count)",
  "Write-Output ('E4=' + @(Expand-AellReleaseList $RELEASES[1]).Count)",
  "Write-Output ('E5=' + @(Expand-AellReleaseList @()).Count)",
  "Write-Output ('E6=' + @(Expand-AellReleaseList $null).Count)",
  // One release must survive as an OBJECT, not be torn into properties.
  "Write-Output ('E7=' + @(Expand-AellReleaseList $RELEASES[1])[0].tag_name)"
].join("\n"));

assert(field(expand, "E1") === "3", "flat list of 3 stays 3");
assert(field(expand, "E2") === "3", "one level of nesting flattens to 3");
assert(field(expand, "E3") === "3", "two levels flatten to 3");
assert(field(expand, "E4") === "1",
  "a single release (the -Tag path) becomes a list of one");
assert(field(expand, "E5") === "0", "an empty list stays empty");
assert(field(expand, "E6") === "0", "a null list is empty, not one null");
assert(field(expand, "E7") === "b4938",
  "a single release stays a release object");

// ---------------------------------------------------------------------
// Variant choice, including the CUDA line vs the driver.
// ---------------------------------------------------------------------
const variants = runPs([
  "Write-Output ('CPU=' + (Select-AellWhisperAsset -Assets $RELEASES[1].assets -Variant cpu).name)",
  "Write-Output ('BLAS=' + (Select-AellWhisperAsset -Assets $RELEASES[1].assets -Variant blas).name)",
  // No driver info: take the newest published line.
  "Write-Output ('CU_ANY=' + (Select-AellWhisperAsset -Assets $RELEASES[1].assets -Variant cublas).name)",
  // A driver on CUDA 13: 12.4.0 is the newest that still fits.
  "Write-Output ('CU_13=' + (Select-AellWhisperAsset -Assets $RELEASES[1].assets -Variant cublas -DriverCuda '13.0').name)",
  // A driver stuck on 11.8: must step DOWN, never take 12.4.
  "Write-Output ('CU_118=' + (Select-AellWhisperAsset -Assets $RELEASES[1].assets -Variant cublas -DriverCuda '11.8').name)",
  // Older than anything published: no asset, so the walk moves on.
  "$old = Select-AellWhisperAsset -Assets $RELEASES[1].assets -Variant cublas -DriverCuda '10.2'",
  "Write-Output ('CU_OLD=' + $(if ($null -eq $old) { 'null' } else { $old.name }))",
  // A driver reported bare ('13'), the shape nvidia-smi can print.
  "Write-Output ('CU_BARE=' + (Select-AellWhisperAsset -Assets $RELEASES[1].assets -Variant cublas -DriverCuda '13').name)",
  // An asset-less release answers null rather than throwing: walking on
  // is the normal path, not an error.
  "$none = Select-AellWhisperAsset -Assets $RELEASES[0].assets -Variant cpu",
  "Write-Output ('EMPTY=' + $(if ($null -eq $none) { 'null' } else { $none.name }))"
].join("\n"));

assert(field(variants, "CPU") === "whisper-bin-x64.zip", "cpu asset");
assert(field(variants, "BLAS") === "whisper-blas-bin-x64.zip", "blas asset");
assert(field(variants, "CU_ANY") === "whisper-cublas-12.4.0-bin-x64.zip",
  "no driver info: newest CUDA line");
assert(field(variants, "CU_13") === "whisper-cublas-12.4.0-bin-x64.zip",
  "CUDA 13 driver: 12.4.0 fits and is newest");
assert(field(variants, "CU_118") === "whisper-cublas-11.8.0-bin-x64.zip",
  "CUDA 11.8 driver steps DOWN to the 11.8.0 build");
assert(field(variants, "CU_OLD") === "null",
  "a driver older than every build picks nothing (the walk moves on)");
assert(field(variants, "CU_BARE") === "whisper-cublas-12.4.0-bin-x64.zip",
  "a bare '13' from nvidia-smi is padded, not rejected as a version");
assert(field(variants, "EMPTY") === "null",
  "an asset-less release answers null, it does not throw");

// ---------------------------------------------------------------------
// Reading the driver's CUDA version out of nvidia-smi.
//
// The banner below is captured verbatim from this machine on 2026-08-29
// (driver 616.56, RTX 5090). It says "CUDA UMD Version", so the
// "CUDA Version:" regex that scripts/get-llama.ps1 uses matches NOTHING
// and the driver ceiling silently stops applying. Both spellings must
// read, and a banner with neither must answer '' rather than guess.
// ---------------------------------------------------------------------
const NEW_BANNER =
  "Sat Aug 29 04:15:33 2026\n" +
  "+---------------------------------------------------------+\n" +
  "| NVIDIA-SMI 616.56    KMD Version: 616.56    CUDA UMD Version: 13.4 |\n";
const OLD_BANNER =
  "+---------------------------------------------------------+\n" +
  "| NVIDIA-SMI 551.61   Driver Version: 551.61   CUDA Version: 12.4 |\n";

// Wrapped in parentheses: the result is a CONCATENATION (newlines are
// spliced back with [char]10), and in argument position `-Text 'a' +
// [char]10 + 'b'` binds only 'a' and leaves the rest as stray arguments.
function psQuote(s) {
  return "('" +
    String(s).replace(/'/g, "''").replace(/\n/g, "' + [char]10 + '") + "')";
}

const smi = runPs([
  "Write-Output ('NEW=' + (Get-AellCudaVersionFromSmi -Text " + psQuote(NEW_BANNER) + "))",
  "Write-Output ('OLD=' + (Get-AellCudaVersionFromSmi -Text " + psQuote(OLD_BANNER) + "))",
  "Write-Output ('NONE=<' + (Get-AellCudaVersionFromSmi -Text 'no gpu here') + '>')",
  "Write-Output ('EMPTY=<' + (Get-AellCudaVersionFromSmi -Text '') + '>')"
].join("\n"));

assert(field(smi, "NEW") === "13.4",
  "'CUDA UMD Version: 13.4' is read (this machine's real banner)");
assert(field(smi, "OLD") === "12.4",
  "the classic 'CUDA Version: 12.4' banner still reads");
assert(field(smi, "NONE") === "<>",
  "a banner with no CUDA version answers empty, it does not guess");
assert(field(smi, "EMPTY") === "<>", "no banner at all answers empty");

// ---------------------------------------------------------------------
// Grounded errors: never "not found" without saying what IS there.
// ---------------------------------------------------------------------
const errs = runPs([
  "function Try-It([scriptblock]$b) { try { & $b; 'NOERROR' } catch { $_.Exception.Message } }",
  "Write-Output ('ERR_ARM=<' + (Try-It { Select-AellWhisperRelease -Releases $RELEASES[0] -Variant cpu }) + '>')",
  "Write-Output ('ERR_CUDA=<' + (Try-It { Select-AellWhisperRelease -Releases $RELEASES -Variant cublas -DriverCuda '10.2' }) + '>')",
  "Write-Output ('ERR_MODEL=<' + (Try-It { Get-AellWhisperModelUrl -Model 'base-en' }) + '>')"
].join("\n"));

const errArm = field(errs, "ERR_ARM") || "";
assert(/no assets/.test(errArm) && /v1\.9\.3/.test(errArm),
  "a release with nothing is named, and said to have no assets");
const errCuda = field(errs, "ERR_CUDA") || "";
assert(/whisper-cublas-11\.8\.0-bin-x64\.zip/.test(errCuda),
  "the CUDA refusal lists the builds that WERE published");
assert(/CUDA 10\.2/.test(errCuda) && /-Variant cpu/.test(errCuda),
  "the CUDA refusal names the driver version and the way out");

// ---------------------------------------------------------------------
// Model URLs. The org is the trap: llama.cpp moved to ggml-org and the
// whisper REPO moved with it, so ggml-org/whisper.cpp is the natural
// guess for the models too -- measured 2026-08-29 it answers HTTP 401,
// which reads like a token problem rather than a wrong address.
// ---------------------------------------------------------------------
const models = runPs([
  "$m = Get-AellWhisperModelUrl -Model 'base.en'",
  "Write-Output ('URL=' + $m.Url)",
  "Write-Output ('FILE=' + $m.FileName)",
  "Write-Output ('NAME=' + $m.Name)",
  "Write-Output ('URL2=' + (Get-AellWhisperModelUrl -Model 'ggml-small.en.bin').Url)",
  "Write-Output ('NAME2=' + (Get-AellWhisperModelUrl -Model 'ggml-small.en.bin').Name)",
  "Write-Output ('URL3=' + (Get-AellWhisperModelUrl -Model 'large-v3-turbo').Url)"
].join("\n"));

assert(field(models, "URL") ===
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  "base.en resolves to the ggerganov repo, not ggml-org");
assert(!/ggml-org\/whisper\.cpp/.test(models),
  "no model URL points at ggml-org (that host answers 401)");
assert(field(models, "FILE") === "ggml-base.en.bin", "model file name");
assert(field(models, "NAME") === "base.en", "model short name");
assert(field(models, "URL2") ===
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
  "a pasted file name is accepted, not double-prefixed");
assert(field(models, "NAME2") === "small.en",
  "the ggml- prefix and .bin suffix are stripped once");
assert(field(models, "URL3") ===
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  "a hyphenated model name survives the stripping");

const errModel = field(errs, "ERR_MODEL") || "";
assert(/base-en/.test(errModel) && /base\.en/.test(errModel),
  "an unknown model is quoted back and the real list is offered");

// ---------------------------------------------------------------------
// The acquirer itself: the facts the probe paid for.
// ---------------------------------------------------------------------
const script = fs.readFileSync(SCRIPT, "utf8");
const lib = fs.readFileSync(LIB, "utf8");

// main.exe is still shipped and is a 27 KB deprecation shim; the 479 KB
// whisper-cli.exe is the transcriber. Finding "main.exe" finds the stub.
assert(/AellWhisperExe\s*=\s*'whisper-cli\.exe'/.test(lib),
  "the exe looked for is whisper-cli.exe, not the main.exe shim");
assert(/-Recurse -Filter \$script:AellWhisperExe/.test(script),
  "the exe is found RECURSIVELY (the archive nests it under Release\\)");

// The regression itself, in the acquirer: no @() around the API call.
assert(!/@\(Invoke-AellGitHub/.test(script),
  "the API result is not wrapped in @() (that is what nested it)");

// The model must not be inside the folder the binary update wipes.
assert(/\$binDir\s*=\s*Join-Path \$root 'bin'/.test(script) &&
       /\$modelsDir\s*=\s*Join-Path \$root 'models'/.test(script),
  "binaries and models live in separate folders");
assert(/Remove-Item -Recurse -Force \$binDir/.test(script) &&
       !/Remove-Item -Recurse -Force \$modelsDir/.test(script) &&
       !/Remove-Item -Recurse -Force \$root\b/.test(script),
  "re-running wipes the 8 MB binaries and never the 141 MB model");

// A half-written model must not look acquired on the next run.
assert(/\$part = "\$modelPath\.part"/.test(script) &&
       /Move-Item -Force \$part \$modelPath/.test(script),
  "the model downloads to .part and is renamed only when complete");

// The verify step moved into scripts/lib/whisper-verify.ps1 on 6.1 Pass B
// so the acquirer, scripts/verify-whisper.ps1 and tests/test-whisper-
// verify.js all run the SAME round-trip. What this file still owes is
// that the acquirer did not keep a private second copy of it: the two
// would drift, and the one that ships is whichever the user happened to
// run. (16 kHz mono, the phrase comparison and the silence trap are
// asserted in tests/test-whisper-verify.js.)
assert(/lib.whisper-verify\.ps1/.test(script),
  "the acquirer dot-sources the shared verification library");
assert(/Invoke-AellWhisperCheck/.test(script),
  "and its verify step calls the shared round-trip");
assert(!/SpeechAudioFormatInfo/.test(script) && !/-like "\*\$phrase\*"/.test(script),
  "it carries no second copy of the synthesizer or the comparison");

// Windows PowerShell 5.1, BOM-less ASCII, per CLAUDE.md.
[LIB, SCRIPT].forEach(function (f) {
  const buf = fs.readFileSync(f);
  let bad = -1;
  for (let i = 0; i < buf.length; i++) { if (buf[i] > 127) { bad = i; break; } }
  assert(bad === -1, path.basename(f) + " is pure ASCII (byte " + bad + ")");
});

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
