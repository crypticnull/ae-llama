#!/usr/bin/env node
/*
 * bump-version.js — set the panel version everywhere it is declared.
 *
 *   node scripts/bump-version.js 0.9.1
 *   node scripts/bump-version.js patch     (0.9.0 -> 0.9.1)
 *   node scripts/bump-version.js minor     (0.9.3 -> 0.10.0)
 *
 * The version lives in FOUR places and package-zxp.ps1 fails the build if
 * they disagree, so editing them by hand is a reliable way to waste a CI
 * run. More importantly the version is what actually SHIPS: CI publishes
 * the update feed on every push (main and claude/**), and the panel only
 * takes an update when feed.panelVersion is strictly greater than its own.
 * Push without bumping and the work reaches the repo but never the panel.
 *
 * Node rather than PowerShell on purpose: this runs the same everywhere,
 * and it can be tested without a Windows box.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILES = {
  version: path.join(ROOT, "extension", "js", "version.js"),
  manifest: path.join(ROOT, "extension", "CSXS", "manifest.xml"),
  update: path.join(ROOT, "update.json")
};

function read(p) { return fs.readFileSync(p, "utf8"); }

/**
 * Every version string a CEP manifest declares: the bundle's, and one
 * per <Extension> in <ExtensionList>. Exported so tests can drive it
 * with a two-entry manifest — the shape docs/PREMIERE_PLAN.md adds and
 * the shape the old single-match check could not see.
 */
function manifestVersions(xml) {
  const out = [];
  const bundle = /ExtensionBundleVersion="([\d.]+)"/g;
  let m;
  while ((m = bundle.exec(xml)) !== null) {
    out.push({ what: "bundle", version: m[1] });
  }
  // Attribute order is not fixed by the schema, so match the TAG and
  // read its attributes separately rather than assuming Id comes first.
  const tag = /<Extension\b([^>]*)>/g;
  while ((m = tag.exec(xml)) !== null) {
    const attrs = m[1];
    const ver = /\bVersion="([\d.]+)"/.exec(attrs);
    if (!ver) { continue; }          // DispatchInfoList entries carry no version
    const id = /\bId="([^"]*)"/.exec(attrs);
    out.push({ what: "extension " + (id ? id[1] : "(no id)"),
               version: ver[1] });
  }
  return out;
}

/**
 * Set every version a CEP manifest declares. GLOBAL replaces on purpose:
 * see manifestVersions above for what the non-global form let through.
 */
function bumpManifest(xml, next) {
  return xml
    .replace(/ExtensionBundleVersion="[\d.]+"/g,
             'ExtensionBundleVersion="' + next + '"')
    .replace(/(<Extension\b[^>]*\bVersion=")[\d.]+(")/g, "$1" + next + "$2");
}

function currentVersion() {
  const m = read(FILES.version).match(/VERSION:\s*"([\d.]+)"/);
  if (!m) { throw new Error("no VERSION in version.js"); }
  return m[1];
}

function bump(cur, kind) {
  const p = cur.split(".").map(Number);
  while (p.length < 3) { p.push(0); }
  if (kind === "major") { return [p[0] + 1, 0, 0].join("."); }
  if (kind === "minor") { return [p[0], p[1] + 1, 0].join("."); }
  return [p[0], p[1], p[2] + 1].join(".");
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node scripts/bump-version.js <x.y.z|patch|minor|major>");
    process.exit(2);
  }
  const cur = currentVersion();
  const next = /^\d+\.\d+\.\d+$/.test(arg) ? arg : bump(cur, arg);

  if (next === cur) {
    console.error("Refusing: " + next + " is already the current version. " +
                  "An equal version ships nothing — the panel only updates " +
                  "when the feed is strictly newer.");
    process.exit(1);
  }

  // version.js
  let s = read(FILES.version);
  const before = s;
  s = s.replace(/VERSION:\s*"[\d.]+"/, 'VERSION: "' + next + '"');
  if (s === before) { throw new Error("version.js not updated"); }
  fs.writeFileSync(FILES.version, s);

  // manifest.xml — ExtensionBundleVersion AND EVERY Extension's own
  // Version. Both regexes are GLOBAL on purpose: a CEP bundle may carry
  // more than one <Extension> (docs/PREMIERE_PLAN.md adds a Premiere
  // one), and the non-global form bumped only the first while the check
  // below read only the first too — so a stale second entry would have
  // shipped silently, with the file disagreeing with itself.
  fs.writeFileSync(FILES.manifest, bumpManifest(read(FILES.manifest), next));

  // update.json — CI overwrites panelVersion from the manifest, but
  // package-zxp.ps1 cross-checks this file, so it has to agree.
  s = read(FILES.update);
  s = s.replace(/("panelVersion":\s*")[\d.]+(")/, "$1" + next + "$2");
  fs.writeFileSync(FILES.update, s);

  // Verify rather than assume: a silent miss here fails the build later.
  const manifestNow = read(FILES.manifest);
  const found = {
    "version.js": (read(FILES.version).match(/VERSION:\s*"([\d.]+)"/) || [])[1],
    "update.json": (read(FILES.update)
      .match(/"panelVersion":\s*"([\d.]+)"/) || [])[1]
  };
  // EVERY version the manifest declares, not just the first — one entry
  // per <Extension> plus the bundle. package-zxp.ps1 only cross-checks
  // the bundle version, so a stale Extension version has nothing else
  // standing between it and a release.
  manifestVersions(manifestNow).forEach((v, i) => {
    found["manifest " + v.what] = v.version;
  });
  const wrong = Object.keys(found).filter(k => found[k] !== next);
  if (wrong.length) {
    console.error("MISMATCH after write: " + JSON.stringify(found));
    process.exit(1);
  }

  console.log(cur + " -> " + next);
  Object.keys(found).forEach(k => console.log("  " + k + ": " + found[k]));
  console.log("\nPush to any branch and CI publishes the feed; the panel " +
              "picks it up on next launch.");
}

// Guarded so tests can require this file for manifestVersions/bumpManifest
// without bumping the repo's real version as a side effect.
if (require.main === module) { main(); }

module.exports = { manifestVersions, bumpManifest, bump };
