// Regression test: bump-version.js must set EVERY version a CEP manifest
// declares, and its own post-write check must be able to see them all.
//
// The defect this pins (found by the PREMIERE_PLAN audit, 2026-09-02,
// before a second <Extension> existed to trip it):
//
//   s.replace(/(<Extension\b[^>]*\bVersion=")[\d.]+(")/, ...)   // no /g
//
// A CEP bundle may carry more than one <Extension> — that is exactly the
// mechanism docs/PREMIERE_PLAN.md uses to put a Premiere panel in the
// same ZXP. With the non-global form, `bump-version.js patch` would
// have updated the FIRST entry only, and the verification block read
// only the first match too, so it would have reported success over a
// manifest that disagreed with itself. package-zxp.ps1 cross-checks the
// BUNDLE version against version.js and nothing else, so nothing
// downstream would have caught it either.
//
// "BUMP OR IT DOES NOT SHIP" (CLAUDE.md) is the reason this matters:
// the version is the only gate between a push and a panel, and a bumper
// that lies about what it wrote is worse than no bumper.
"use strict";
const fs = require("fs");
const path = require("path");

const bumper = require("../scripts/bump-version.js");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

// ------------------------------------------- a two-extension manifest
// Hand-built rather than read from the repo: this must keep working the
// day the real manifest grows its second entry AND on the day it does
// not, so the fixture carries the shape, not the file.
const TWO = [
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
  '<ExtensionManifest ExtensionBundleId="com.example.bundle"',
  '                   ExtensionBundleVersion="1.2.3"',
  '                   Version="7.0">',
  '  <ExtensionList>',
  '    <Extension Id="com.example.aeft" Version="1.2.3"/>',
  '    <Extension Id="com.example.ppro" Version="1.2.3"/>',
  '  </ExtensionList>',
  '  <DispatchInfoList>',
  '    <Extension Id="com.example.aeft">',
  '      <DispatchInfo><Resources>',
  '        <MainPath>./index.html</MainPath>',
  '      </Resources></DispatchInfo>',
  '    </Extension>',
  '    <Extension Id="com.example.ppro">',
  '      <DispatchInfo><Resources>',
  '        <MainPath>./index.html</MainPath>',
  '      </Resources></DispatchInfo>',
  '    </Extension>',
  '  </DispatchInfoList>',
  '</ExtensionManifest>'
].join("\n");

{
  const v = bumper.manifestVersions(TWO);
  assert(v.length === 3,
         "manifestVersions sees the bundle AND both extensions: " + v.length);
  assert(v.filter(r => r.what === "bundle").length === 1,
         "one bundle row");
  assert(v.some(r => r.what === "extension com.example.aeft") &&
         v.some(r => r.what === "extension com.example.ppro"),
         "both extensions are named, so a mismatch report says WHICH");
  assert(v.every(r => r.version === "1.2.3"),
         "and every row reads its own version");
}

{
  // The DispatchInfoList entries carry no Version attribute; counting
  // them would make the check demand a version that does not exist.
  const v = bumper.manifestVersions(TWO);
  assert(v.length === 3,
         "DispatchInfoList <Extension> entries are not counted (no Version)");
}

{
  const bumped = bumper.bumpManifest(TWO, "9.9.9");
  const v = bumper.manifestVersions(bumped);
  assert(v.length === 3 && v.every(r => r.version === "9.9.9"),
         "bumpManifest sets ALL of them: " +
         v.map(r => r.what + "=" + r.version).join(", "));
  assert(!/1\.2\.3/.test(bumped),
         "no old version survives anywhere in the file");
  assert(/Version="7\.0"/.test(bumped),
         "the manifest SCHEMA version (Version=\"7.0\") is left alone — " +
         "bumping it would change which CEP manifest grammar Adobe applies");
}

{
  // The exact regression: the old non-global replace.
  const oldWay = TWO
    .replace(/ExtensionBundleVersion="[\d.]+"/, 'ExtensionBundleVersion="9.9.9"')
    .replace(/(<Extension\b[^>]*\bVersion=")[\d.]+(")/, "$19.9.9$2");
  const stale = bumper.manifestVersions(oldWay)
    .filter(r => r.version !== "9.9.9");
  assert(stale.length === 1 && stale[0].what === "extension com.example.ppro",
         "the pre-fix single-match replace left the SECOND extension at " +
         "1.2.3 — this is the bug, reproduced");
}

// ------------------------------------------------ the shipping manifest
{
  const real = fs.readFileSync(
    path.join(__dirname, "..", "extension", "CSXS", "manifest.xml"), "utf8");
  const v = bumper.manifestVersions(real);
  assert(v.length >= 2, "the real manifest declares at least bundle+extension");
  const versions = v.map(r => r.version);
  assert(versions.every(x => x === versions[0]),
         "and every version in it agrees: " +
         v.map(r => r.what + "=" + r.version).join(", "));

  const versionJs = fs.readFileSync(
    path.join(__dirname, "..", "extension", "js", "version.js"), "utf8");
  const declared = (versionJs.match(/VERSION:\s*"([\d.]+)"/) || [])[1];
  assert(declared === versions[0],
         "version.js agrees with the manifest (" + declared + " vs " +
         versions[0] + ") — package-zxp.ps1 fails the build otherwise");

  const update = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "update.json"), "utf8"));
  assert(update.panelVersion === versions[0],
         "update.json agrees too (" + update.panelVersion + ")");
}

// --------------------------------------------------- the bump arithmetic
{
  assert(bumper.bump("0.11.15", "patch") === "0.11.16", "patch bumps the third");
  assert(bumper.bump("0.11.15", "minor") === "0.12.0", "minor zeroes the patch");
  assert(bumper.bump("0.11.15", "major") === "1.0.0", "major zeroes both");
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
