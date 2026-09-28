// Regression test: WHICH ffmpeg download scripts/get-ffmpeg.ps1 takes,
// and what the verification round-trip will and will not accept.
// WORKPLAN 6.2 Pass A.
//
// Two bug classes, both found while writing the thing they gate.
//
// (1) THE ASSET NAMES ARE NOT ONE SCHEME, THEY ARE TWO. BtbN/FFmpeg-Builds
//     publishes a rolling `latest` tag whose files are named
//     `ffmpeg-n9.0-latest-win64-gpl-9.0.zip`, and dated autobuild releases
//     whose IDENTICAL builds are named
//     `ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip` and
//     `ffmpeg-N-126313-g1ae4048218-win64-gpl.zip`. The first version of
//     ffmpeg-assets.ps1 matched `-latest-` literally. It chose correctly
//     from `latest` -- so every positive test passed -- while reading
//     every dated release as carrying NOTHING: the fallback that exists
//     for the day `latest` lacks a build could never fire, and the
//     grounded error listed those tags as empty while looking perfectly
//     well-formed. So the cases below run the choice over BOTH schemes
//     and assert the fallback actually lands on a dated release.
//
//     Two smaller traps in the same names: `-like '*gpl*'` matches the
//     LGPL build (a different licence AND a different codec set), and
//     `n10` sorts before `n9` as a string, which is invisible today and
//     silently picks the older build the day an n10 series is published.
//
// (2) NOTHING IN THE OBVIOUS SUCCESS PATH IS A CHECK. Measured on this
//     machine 2026-08-30 against ffmpeg 8.1:
//       * `ffmpeg -t 0` writes a 262-byte MP4 with ZERO streams and
//         exits 0. ffprobe then exits 0 on it, prints valid JSON, writes
//         NOTHING to stderr and scores probe_score 100.
//       * ffmpeg exits 0 when it REFUSES to overwrite an existing output
//         ("File ... already exists. Exiting."), leaving the old file
//         byte-for-byte in place. Real errors do return non-zero (-22 for
//         a bad filter, -2 for a missing input), which is what makes the
//         0 so easy to believe.
//       * without -nostdin that same case is an interactive prompt and
//         ffmpeg HANGS FOREVER (measured: killed at a 10 s timeout).
//       * ffprobe -select_streams v exits 0 with `{"streams":[]}` on an
//         audio-only file, and exits 1 on a non-media file while still
//         printing parseable JSON.
//     So the checker is driven here over a real file with no video
//     stream and asserted to REJECT it. A Test-AellFfmpegClip that
//     returned $true unconditionally passes every other check in the
//     verify script; this is the one that fails it.
//
// The decision and the round trip both live in PowerShell because the
// acquirer does; this test drives those same functions, so it gates the
// scripts rather than a paraphrase of them. Everything needing the
// 140 MB install is gated on it being there and skips cleanly otherwise
// -- CI has no binary.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "scripts", "lib", "ffmpeg-assets.ps1");
const VERIFY = path.join(ROOT, "scripts", "lib", "ffmpeg-verify.ps1");
const SHARED = path.join(ROOT, "scripts", "lib", "gh-releases.ps1");
const GET = path.join(ROOT, "scripts", "get-ffmpeg.ps1");
const RUNNER = path.join(ROOT, "scripts", "verify-ffmpeg.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

if (process.platform !== "win32") {
  console.log("skip - the acquirer and its checks are PowerShell, Windows-only");
  process.exit(0);
}

// --- captured from the GitHub API 2026-08-30 --------------------------
// BtbN/FFmpeg-Builds /releases, trimmed to the fields the choice reads
// and to the win64 + one linux asset per release. The two naming schemes
// are the real published state, not a contrived case.
const RELEASES = [
  {
    tag_name: "latest", prerelease: false, assets: [
      { name: "checksums.sha256", size: 4096 },
      { name: "ffmpeg-master-latest-win64-gpl-shared.zip", size: 76970393 },
      { name: "ffmpeg-master-latest-win64-gpl.zip", size: 170710691 },
      { name: "ffmpeg-master-latest-win64-lgpl-shared.zip", size: 67736268 },
      { name: "ffmpeg-master-latest-win64-lgpl.zip", size: 148479283 },
      { name: "ffmpeg-master-latest-linux64-gpl.tar.xz", size: 128561234 },
      { name: "ffmpeg-n8.1-latest-win64-gpl-8.1.zip", size: 168292361 },
      { name: "ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip", size: 80111222 },
      { name: "ffmpeg-n8.1-latest-win64-lgpl-8.1.zip", size: 146067374 },
      { name: "ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip", size: 70780108 },
      { name: "ffmpeg-n9.0-latest-win64-gpl-9.0.zip", size: 169238528 },
      { name: "ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip", size: 76446105 },
      { name: "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip", size: 146992108 },
      { name: "ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip", size: 67213721 },
      { name: "ffmpeg-n9.0-latest-winarm64-lgpl-9.0.zip", size: 44880000 }
    ]
  },
  {
    // The SAME builds under the dated tag's completely different scheme.
    tag_name: "autobuild-2026-08-29-13-12", prerelease: false, assets: [
      { name: "checksums.sha256", size: 4096 },
      { name: "ffmpeg-N-126313-g1ae4048218-win64-gpl-shared.zip", size: 76970001 },
      { name: "ffmpeg-N-126313-g1ae4048218-win64-gpl.zip", size: 170710002 },
      { name: "ffmpeg-N-126313-g1ae4048218-win64-lgpl.zip", size: 148479003 },
      { name: "ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip", size: 168292004 },
      { name: "ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-8.1.zip", size: 146067005 }
    ]
  },
  // A release carrying nothing for win64 at all: the walk must step past
  // it rather than stopping, and the grounded error must say so.
  {
    tag_name: "autobuild-2026-08-28-17-08", prerelease: false, assets: [
      { name: "checksums.sha256", size: 4096 },
      { name: "ffmpeg-N-126308-gd411d9e752-linux64-gpl.tar.xz", size: 128500000 }
    ]
  }
];

/**
 * Run one PowerShell script that dot-sources a library, so a whole batch
 * of cases costs a single spawn. The captured release list is handed over
 * as JSON and rebuilt with ConvertFrom-Json, which produces exactly the
 * PSCustomObject shape Invoke-RestMethod would.
 */
function runPs(lib, body) {
  const preamble =
    ". '" + lib.replace(/'/g, "''") + "'\n" +
    "$ErrorActionPreference = 'Stop'\n" +
    "$RAW = @'\n" + JSON.stringify(RELEASES) + "\n'@\n" +
    "$RELEASES = ConvertFrom-Json $RAW\n";
  const file = path.join(
    process.env.TEMP || ".", "aell-ffmpeg-test-" + process.pid + ".ps1");
  fs.writeFileSync(file, preamble + body, "ascii");
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file
    ], { encoding: "utf8" });
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
}

function field(out, key) {
  const m = new RegExp("^" + key + "=([\\s\\S]*?)$", "m").exec(out);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------
// Name parsing: the two schemes, and the lgpl/gpl trap.
// ---------------------------------------------------------------------
const parse = runPs(ASSETS, [
  "function P($n) {",
  "  $i = Get-AellFfmpegAssetInfo -Name $n",
  "  if ($null -eq $i) { return 'null' }",
  "  return ('{0}|{1}|{2}|{3}' -f $i.Series, $i.Platform, $i.License, $i.Shared)",
  "}",
  // the rolling-tag scheme
  "Write-Output ('A=' + (P 'ffmpeg-master-latest-win64-gpl.zip'))",
  "Write-Output ('B=' + (P 'ffmpeg-master-latest-win64-lgpl.zip'))",
  "Write-Output ('C=' + (P 'ffmpeg-n9.0-latest-win64-gpl-9.0.zip'))",
  "Write-Output ('D=' + (P 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip'))",
  // the dated-tag scheme, same builds
  "Write-Output ('E=' + (P 'ffmpeg-N-126313-g1ae4048218-win64-gpl.zip'))",
  "Write-Output ('F=' + (P 'ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-8.1.zip'))",
  "Write-Output ('G=' + (P 'ffmpeg-N-126313-g1ae4048218-win64-lgpl-shared.zip'))",
  // not builds at all
  "Write-Output ('H=' + (P 'checksums.sha256'))",
  "Write-Output ('I=' + (P 'ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz'))",
  // the string-sort trap, stated as a version comparison
  "$v9 = ConvertTo-AellFfmpegSeriesVersion 'n9.0'",
  "$v10 = ConvertTo-AellFfmpegSeriesVersion 'n10.0'",
  "$vm = ConvertTo-AellFfmpegSeriesVersion 'master'",
  "Write-Output ('N10GT9=' + ($v10 -gt $v9))",
  "Write-Output ('STRSORT=' + ('n10.0' -gt 'n9.0'))",
  "Write-Output ('MASTERLOW=' + ($vm -lt $v9))"
].join("\n"));

assert(field(parse, "A") === "master|win64|gpl|False",
  "rolling scheme: master gpl static parses");
assert(field(parse, "B") === "master|win64|lgpl|False",
  "rolling scheme: the LGPL build is lgpl, not gpl (the '*gpl*' trap)");
assert(field(parse, "C") === "n9.0|win64|gpl|False",
  "rolling scheme: the release series comes from the trailing suffix");
assert(field(parse, "D") === "n9.0|win64|lgpl|True",
  "rolling scheme: -shared is read with the suffix still after it");
assert(field(parse, "E") === "master|win64|gpl|False",
  "dated scheme: no series suffix means master");
assert(field(parse, "F") === "n8.1|win64|lgpl|False",
  "dated scheme: n8.1.2-50-g<hash> is the n8.1 SERIES, from the suffix");
assert(field(parse, "G") === "master|win64|lgpl|True",
  "dated scheme: shared master parses too");
assert(field(parse, "H") === "null",
  "checksums.sha256 is not a build");
assert(field(parse, "I") === "n9.0|linux64|gpl|False",
  "a linux tar.xz parses, and is excluded by PLATFORM rather than by luck");
assert(field(parse, "N10GT9") === "True",
  "n10.0 compares GREATER than n9.0 as a version");
assert(field(parse, "STRSORT") === "False",
  "...and LESS as a string - the trap is real, not hypothetical");
assert(field(parse, "MASTERLOW") === "True",
  "master sorts below every numbered series");

// ---------------------------------------------------------------------
// The choice: licence, linking, series, platform, and the nested shape
// Invoke-RestMethod really delivers.
// ---------------------------------------------------------------------
const choose = runPs(ASSETS, [
  "function S($lic, $link, $ser, $plat) {",
  "  $c = Select-AellFfmpegRelease -Releases $RELEASES -License $lic " +
    "-Linking $link -Series $ser -Platform $plat",
  "  return ('{0}|{1}|{2}' -f $c.Release.tag_name, $c.Asset.name, $c.Asset.size)",
  "}",
  "Write-Output ('DEFAULT=' + (S 'lgpl' 'static' 'release' 'win64'))",
  "Write-Output ('GPL=' + (S 'gpl' 'static' 'release' 'win64'))",
  "Write-Output ('SHARED=' + (S 'lgpl' 'shared' 'release' 'win64'))",
  "Write-Output ('MASTER=' + (S 'lgpl' 'static' 'master' 'win64'))",
  "Write-Output ('PINNED=' + (S 'lgpl' 'static' 'n8.1' 'win64'))",
  "Write-Output ('ARM=' + (S 'lgpl' 'static' 'release' 'winarm64'))",
  // the nested shape @(Invoke-RestMethod ...) really produces
  "$wrapped = @(,$RELEASES)",
  "Write-Output ('WRAPPED_COUNT=' + $wrapped.Count)",
  "$n = Select-AellFfmpegRelease -Releases $wrapped -License lgpl",
  "Write-Output ('NEST=' + $n.Release.tag_name + '|' + $n.Asset.name + '|' + $n.Asset.size)"
].join("\n"));

assert(field(choose, "DEFAULT") ===
  "latest|ffmpeg-n9.0-latest-win64-lgpl-9.0.zip|146992108",
  "default is the highest release series, LGPL, static, from `latest`");
assert(field(choose, "GPL") ===
  "latest|ffmpeg-n9.0-latest-win64-gpl-9.0.zip|169238528",
  "-License gpl takes the GPL build, not the lgpl one that also matches '*gpl*'");
assert(field(choose, "SHARED") ===
  "latest|ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip|67213721",
  "-Linking shared is reachable and is never the default");
assert(field(choose, "MASTER") ===
  "latest|ffmpeg-master-latest-win64-lgpl.zip|148479283",
  "-Series master takes the nightly, which 'release' never does");
assert(field(choose, "PINNED") ===
  "latest|ffmpeg-n8.1-latest-win64-lgpl-8.1.zip|146067374",
  "an explicit series is honoured over the newer one");
assert(field(choose, "ARM") ===
  "latest|ffmpeg-n9.0-latest-winarm64-lgpl-9.0.zip|44880000",
  "platform is a filter, not a substring hope");
assert(field(choose, "WRAPPED_COUNT") === "1",
  "the wrapped shape really is one element (the trap is reproduced)");
// Pinning the SIZE is what separates "came from `latest`" from "came from
// a pool of every release's assets and this one sorted first".
assert(field(choose, "NEST") ===
  "latest|ffmpeg-n9.0-latest-win64-lgpl-9.0.zip|146992108",
  "nested list: the SAME release and asset, by size, not a pooled soup");

// ---------------------------------------------------------------------
// The fallback to a dated release, and the grounded error.
//
// This is the half the `-latest-` regex silently disabled: it passed
// every test above and could never reach these.
// ---------------------------------------------------------------------
const fallback = runPs(ASSETS, [
  // `latest` has no winarm64 GPL build, so the walk must go on. It finds
  // nothing in the dated ones either -> a grounded error naming all three.
  "try { Select-AellFfmpegRelease -Releases $RELEASES -License gpl " +
    "-Platform winarm64 | Out-Null; Write-Output 'ERR=none' }",
  "catch { Write-Output ('ERR=' + ($_.Exception.Message -replace '\\s+', ' ')) }",
  // Drop `latest` entirely: the choice must still work off a dated tag.
  "$dated = @($RELEASES[1], $RELEASES[2])",
  "$d = Select-AellFfmpegRelease -Releases $dated -License lgpl",
  "Write-Output ('DATED=' + $d.Release.tag_name + '|' + $d.Asset.name)",
  "$dm = Select-AellFfmpegRelease -Releases $dated -License gpl -Series master",
  "Write-Output ('DATEDMASTER=' + $dm.Asset.name)",
  // A release with no win64 assets at all takes the other error branch.
  "try { Select-AellFfmpegRelease -Releases @($RELEASES[2]) -License lgpl " +
    "| Out-Null; Write-Output 'ONLYLINUX=none' }",
  "catch { Write-Output ('ONLYLINUX=' + ($_.Exception.Message -replace '\\s+', ' ')) }",
  // A series that does not exist names itself in the hint. This also
  // guards a PowerShell trap: variable names are CASE-INSENSITIVE, so a
  // local $series inside the walk IS the $Series parameter and silently
  // overwrote it -- the hint used to read back the list of series it had
  // just built instead of what the caller asked for.
  "try { Select-AellFfmpegRelease -Releases $RELEASES -Series 'n7.0' " +
    "| Out-Null; Write-Output 'BADSERIES=none' }",
  "catch { Write-Output ('BADSERIES=' + ($_.Exception.Message -replace '\\s+', ' ')) }"
].join("\n"));

const err = field(fallback, "ERR") || "";
assert(/No ffmpeg winarm64 gpl static build/.test(err),
  "no match anywhere throws rather than returning a wrong asset");
// `latest` carries exactly one winarm64 build (n9.0, and it is lgpl), so
// the list is n9.0 alone. That it is NOT the win64 list is the point: the
// seen-list is scoped to the platform asked for rather than dumping all
// 49 asset names, which is what makes it readable at all.
assert(/latest \(n9\.0\)/.test(err),
  "the grounded error names what `latest` carried FOR THAT PLATFORM only");
assert(/autobuild-2026-08-29-13-12 \(no winarm64 builds\)/.test(err),
  "...and says plainly which releases had nothing for it");
assert(field(fallback, "DATED") ===
  "autobuild-2026-08-29-13-12|ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-8.1.zip",
  "with `latest` gone the choice falls back to a dated release build");
assert(field(fallback, "DATEDMASTER") ===
  "ffmpeg-N-126313-g1ae4048218-win64-gpl.zip",
  "...and can still tell master from a series there");
const onlyLinux = field(fallback, "ONLYLINUX") || "";
assert(/autobuild-2026-08-28-17-08 \(no win64 builds\)/.test(onlyLinux),
  "a release with no win64 assets says so, rather than printing '()'");
const badSeries = field(fallback, "BADSERIES") || "";
assert(/Series 'n7\.0' was asked for by name/.test(badSeries),
  "the hint quotes the series the CALLER asked for (the $Series/$series shadow)");
// This walk covers win64, where BOTH naming schemes have to parse. A
// regex keyed on `-latest-` rendered the dated tags as "()" right here
// while every positive test above still passed.
assert(/latest \(master, n8\.1, n9\.0\)/.test(badSeries),
  "the win64 listing reads the rolling tag's three series");
assert(/autobuild-2026-08-29-13-12 \(master, n8\.1\)/.test(badSeries),
  "...and the dated release's own scheme too, instead of calling it empty");

// ---------------------------------------------------------------------
// The checker's arithmetic, with no ffmpeg anywhere.
//
// Test-AellFfmpegClip is driven against files this test writes itself, so
// the comparison logic is gated on a CI runner that has no binary. A
// missing/zero-byte/non-media file must be REJECTED, and rejected for a
// reason that names the file.
// ---------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aell-ffcheck-"));
const zeroByte = path.join(tmp, "zero.mp4");
const notMedia = path.join(tmp, "text.mp4");
const missing = path.join(tmp, "nope.mp4");
fs.writeFileSync(zeroByte, "");
fs.writeFileSync(notMedia, "this is not a video");

function q(p) { return "'" + p.replace(/'/g, "''") + "'"; }

try {
  // ffprobe is only needed for the two that get that far; when there is
  // no ffmpeg at all the first two cases still run, because they are
  // decided before the process is ever started.
  const probeExe = "ffprobe.exe";
  const clip = runPs(VERIFY, [
    "$fp = " + q(probeExe),
    "function ClipCheck($p) {",
    "  $r = Test-AellFfmpegClip -Ffprobe $fp -Path $p -Width 160 -Height 120",
    "  return ('{0}|{1}' -f $r.Pass, ($r.Reason -replace '\\s+', ' '))",
    "}",
    "Write-Output ('MISSING=' + (ClipCheck " + q(missing) + "))",
    "Write-Output ('ZERO=' + (ClipCheck " + q(zeroByte) + "))",
    // Discovery must not throw when nothing is installed, and must say
    // where it looked.
    "$i = Find-AellFfmpegInstall -Root " + q(path.join(tmp, "no-such-root")) +
      " -VendorOnly",
    "Write-Output ('NOINSTALL=' + $i.Ok + '|' + ($i.Reason -replace '\\s+', ' '))",
    "Write-Output ('ROOTDEF=' + (Get-AellFfmpegRoot))"
  ].join("\n"));

  const miss = field(clip, "MISSING") || "";
  assert(/^False\|/.test(miss) && /wrote no file/.test(miss),
    "a file ffmpeg never wrote is rejected, and the reason says so");
  const zero = field(clip, "ZERO") || "";
  assert(/^False\|/.test(zero) && /zero-byte/.test(zero),
    "a zero-byte file is rejected before ffprobe is ever run");
  const noInstall = field(clip, "NOINSTALL") || "";
  assert(/^False\|/.test(noInstall),
    "a missing install is reported, not thrown");
  assert(/No ffmpeg install found in the vendor folder/.test(noInstall) &&
         /get-ffmpeg\.ps1/.test(noInstall),
    "...and the reason names where it looked and what to run");
  assert(/AE-Llama[\\/]vendor[\\/]ffmpeg$/.test(field(clip, "ROOTDEF") || ""),
    "the default root is the panel's vendor folder");

  // ------------------------------------------------------------------
  // With a real ffmpeg present (this machine has one; CI does not), run
  // the two facts that cannot be stubbed at all.
  // ------------------------------------------------------------------
  const have = runPs(VERIFY, [
    "$i = Find-AellFfmpegInstall",
    "Write-Output ('OK=' + $i.Ok + '|' + $i.Source)"
  ].join("\n"));
  const haveField = (field(have, "OK") || "").split("|");

  if (haveField[0] !== "True") {
    console.log("skip - no ffmpeg installed; the round-trip checks need one");
  } else {
    const live = runPs(VERIFY, [
      "$i = Find-AellFfmpegInstall",
      // 1. the positive round trip
      "$c = Invoke-AellFfmpegCheck -Install $i -Width 96 -Height 64 -Fps 8 -Seconds 1.5",
      "Write-Output ('CHK=' + $c.Pass + '|' + $c.Probe.Width + 'x' + $c.Probe.Height " +
        "+ '|' + $c.Probe.Frames + '|' + ($c.Reason -replace '\\s+', ' '))",
      // 2. THE fact: a valid file with no video stream, made on purpose
      "$n = Test-AellFfmpegCheckerRejectsEmpty -Install $i",
      "Write-Output ('NEG=' + $n.Pass + '|' + $n.Bytes + '|' + " +
        "($n.Rejection -replace '\\s+', ' '))",
      // 3. a build always has gif; that is what export_gif will stand on
      "$e = Get-AellFfmpegEncoders -Ffmpeg $i.Ffmpeg -Names @('gif')",
      "Write-Output ('GIF=' + $e['gif'])"
    ].join("\n"));

    const chk = (field(live, "CHK") || "").split("|");
    assert(chk[0] === "True", "the round trip passes on a real install: " + chk[3]);
    assert(chk[1] === "96x64",
      "the clip read back is the size that was asked for");
    // 8 fps x 1.5 s = 12 frames. A checker that ignored nb_frames would
    // pass this too, which is why the count is asserted separately.
    assert(chk[2] === "12",
      "...and has the 12 frames 8fps x 1.5s implies, read from the stream");

    const neg = (field(live, "NEG") || "").split("|");
    assert(neg[0] === "True",
      "the checker REJECTS a valid container with no video stream");
    assert(Number(neg[1]) > 0 && Number(neg[1]) < 2048,
      "...and that file is real and tiny (" + neg[1] + " bytes), not absent");
    assert(/NO video stream/.test(neg[2] || ""),
      "...for a reason that says what is wrong with it: " + neg[2]);
    assert(field(live, "GIF") === "True",
      "the gif encoder is present (export_gif's floor)");
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

// ---------------------------------------------------------------------
// The scripts themselves: the shape rules this repo enforces everywhere.
// ---------------------------------------------------------------------
const getSrc = fs.readFileSync(GET, "utf8");
const verifySrc = fs.readFileSync(VERIFY, "utf8");
const runnerSrc = fs.readFileSync(RUNNER, "utf8");

assert(/\.\s*\(Join-Path \$PSScriptRoot 'lib\\ffmpeg-verify\.ps1'\)/.test(getSrc),
  "the acquirer dot-sources the shared verification library");
assert(/Invoke-AellFfmpegCheck/.test(getSrc),
  "and its verify step calls the shared round trip");
assert(!/testsrc=/.test(getSrc),
  "it carries no second copy of the clip synthesizer");
assert(/Get-AellFfmpegEncoders/.test(getSrc),
  "it prints the encoder census, so the licence choice is measured not assumed");
assert(/\$License = 'lgpl'/.test(getSrc),
  "LGPL is the default: it keeps the build redistributable, and GPL is a human's call");
// -nostdin is the difference between a failed export and a hung pass.
const spawnCalls = verifySrc.match(/Invoke-AellFfmpegProcess -Exe [^\n]*\n?[\s\S]{0,400}?\)/g) || [];
assert(/-nostdin/.test(verifySrc) &&
  (verifySrc.match(/'-nostdin'/g) || []).length >= 4,
  "every ffmpeg invocation passes -nostdin (an overwrite prompt hangs forever)");
assert(/'-y'/.test(verifySrc),
  "and -y is explicit, because without it ffmpeg exits 0 having written nothing");
assert(/ReadToEndAsync/.test(verifySrc) && /WaitForExit/.test(verifySrc),
  "both pipes are drained asynchronously (ffmpeg's stderr fills and deadlocks)");
assert(/exit 2/.test(runnerSrc) && /-Require/.test(runnerSrc),
  "the standalone runner skips a missing install unless -Require");

for (const f of [ASSETS, VERIFY, SHARED, GET, RUNNER]) {
  const buf = fs.readFileSync(f);
  let bad = -1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) {
      bad = i; break;
    }
  }
  assert(bad === -1,
    path.basename(f) + " is pure ASCII (byte " + bad + ")");
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
