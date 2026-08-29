/*
 * test-workflow-seeding.js — ensureDataDirs must UPDATE a stale shipped
 * template and never touch one the user edited.
 *
 * The bug this pins: seeding was "copy what is missing, touch nothing that
 * exists", so an install froze on whatever templates it first saw. Measured
 * on the dev machine 2026-08-28 — the H3 i2v manifest there was the version
 * shipped five releases earlier, missing the node attribution corrections
 * and the removal rules, while every push since had "shipped" it.
 *
 * The fix cannot simply overwrite: the panel invites users to edit these
 * templates, and an update that eats an edit is a worse bug than a stale
 * file. So the bundle carries .hash-history.json (every version we ever
 * published) and the installed copy is refreshed only when its hash is one
 * of ours.
 *
 * The stub deliberately reproduces two real-world shapes that would
 * otherwise pass by accident:
 *   - a CRLF copy of a template (git checks these out with the platform's
 *     line endings, so the installed bytes and the bundled bytes routinely
 *     differ while the version is identical — this is what the dev machine
 *     actually had);
 *   - a bundle with no readable history at all (an older ZXP, or a build
 *     that failed to package the dotfile), which must fall back to the old
 *     never-overwrite behaviour rather than to overwriting blindly.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}
function eq(actual, expected, label) {
  assert(actual === expected, label + " [" + JSON.stringify(actual) + "]");
}
function sameSet(actual, expected, label) {
  const a = (actual || []).slice().sort().join(",");
  const b = expected.slice().sort().join(",");
  assert(a === b, label + " [" + a + " vs " + b + "]");
}

const REPO = path.join(__dirname, "..");

// --------------------------------------------------------------- the rig

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aell-seed-"));
let BUNDLE = path.join(TMP, "bundle");
let DATA = path.join(TMP, "data");

const window = {
  AEBridge: {
    nodeRequire: require,
    getExtensionPath: () => BUNDLE
  },
  Settings: { dataRoot: () => DATA },
  Tiers: {},
  setTimeout, clearTimeout, setInterval, clearInterval
};
eval(fs.readFileSync(path.join(REPO, "extension", "js", "setup.js"), "utf8"));
const Setup = window.Setup;

function hashOf(text) {
  return crypto.createHash("sha1")
    .update(String(text).replace(/\r\n/g, "\n"), "latin1").digest("hex");
}

/** Fresh bundle + data root for one case. Returns the bundle's wf dir. */
function rig(caseName, opts) {
  BUNDLE = path.join(TMP, "bundle-" + caseName);
  DATA = path.join(TMP, "data-" + caseName);
  const wf = path.join(BUNDLE, "comfy-workflows");
  fs.mkdirSync(wf, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  const files = opts.bundled;                 // {name: content}
  const history = { files: {} };
  for (const name of Object.keys(files)) {
    fs.writeFileSync(path.join(wf, name), files[name]);
    history.files[name] = (opts.priorVersions && opts.priorVersions[name] || [])
      .map(hashOf).concat([hashOf(files[name])]);
  }
  if (opts.historyText !== undefined) {
    if (opts.historyText !== null) {
      fs.writeFileSync(path.join(wf, ".hash-history.json"), opts.historyText);
    }
  } else {
    fs.writeFileSync(path.join(wf, ".hash-history.json"),
                     JSON.stringify(history, null, 2));
  }
  const installedDir = path.join(DATA, "comfy-workflows");
  if (opts.installed) {
    fs.mkdirSync(installedDir, { recursive: true });
    for (const name of Object.keys(opts.installed)) {
      fs.writeFileSync(path.join(installedDir, name), opts.installed[name]);
    }
  }
  return { wf, installedDir };
}

function installed(dir, name) {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

const V1 = '{"nodes":{"1":{"class_type":"OldSampler"}}}\n';
const V2 = '{"nodes":{"1":{"class_type":"NewSampler"}}}\n';
const CURRENT = '{"nodes":{"1":{"class_type":"CurrentSampler"}}}\n';
const MINE = '{"nodes":{"1":{"class_type":"UserPickedThis"}}}\n';

// ------------------------------------------------- 1. first run: seed all

{
  const r = rig("fresh", { bundled: { "a.json": CURRENT, "README.md": "hi\n" } });
  const s = Setup.ensureDataDirs();
  sameSet(s.seeded, ["a.json", "README.md"], "fresh install seeds every bundled file");
  sameSet(s.refreshed, [], "fresh install refreshes nothing");
  sameSet(s.preserved, [], "fresh install preserves nothing");
  eq(installed(r.installedDir, "a.json"), CURRENT, "seeded content is the bundled content");
  assert(!fs.existsSync(path.join(r.installedDir, ".hash-history.json")),
         "the hash history itself is bundle metadata and is NOT seeded");
  assert(fs.existsSync(path.join(DATA, "vendor")) &&
         fs.existsSync(path.join(DATA, "models")) &&
         fs.existsSync(path.join(DATA, "generated")),
         "the rest of the data tree is still created");
}

// ------------------------------- 2. the bug: a stale but UNEDITED template

{
  const r = rig("stale", {
    bundled: { "a.json": CURRENT },
    priorVersions: { "a.json": [V1, V2] },
    installed: { "a.json": V1 }              // shipped five releases ago
  });
  const s = Setup.ensureDataDirs();
  sameSet(s.refreshed, ["a.json"], "a stale shipped copy is refreshed");
  sameSet(s.preserved, [], "and is not mistaken for a user edit");
  eq(installed(r.installedDir, "a.json"), CURRENT, "the install now holds the current template");

  const again = Setup.ensureDataDirs();
  sameSet(again.refreshed, [], "the second run refreshes nothing");
  sameSet(again.current, ["a.json"], "the second run reports it as current (idempotent)");
}

// The intermediate version counts too: an install that updated once and
// then stopped is the ordinary case, not the first-ever version.
{
  const r = rig("stale-mid", {
    bundled: { "a.json": CURRENT },
    priorVersions: { "a.json": [V1, V2] },
    installed: { "a.json": V2 }
  });
  const s = Setup.ensureDataDirs();
  sameSet(s.refreshed, ["a.json"], "any recorded version is refreshable, not just the first");
  eq(installed(r.installedDir, "a.json"), CURRENT, "refreshed to current from the middle version");
}

// ----------------------------------------- 3. a user edit is never touched

{
  const r = rig("edited", {
    bundled: { "a.json": CURRENT, "b.json": CURRENT },
    priorVersions: { "a.json": [V1] },
    installed: { "a.json": MINE, "b.json": MINE }
  });
  const s = Setup.ensureDataDirs();
  sameSet(s.preserved, ["a.json", "b.json"], "an unrecognised hash is a user edit");
  sameSet(s.refreshed, [], "nothing is overwritten");
  eq(installed(r.installedDir, "a.json"), MINE, "the user's file is byte-identical afterwards");
  eq(installed(r.installedDir, "b.json"), MINE, "including a file with no recorded prior versions");
}

// --------------------------- 4. CRLF: the same version, different bytes

{
  const r = rig("crlf", {
    bundled: { "a.json": CURRENT },
    installed: { "a.json": CURRENT.replace(/\n/g, "\r\n") }
  });
  const s = Setup.ensureDataDirs();
  sameSet(s.current, ["a.json"], "a CRLF copy of the current template is recognised as current");
  sameSet(s.preserved, [], "line endings alone do not make it a user edit");
  sameSet(s.refreshed, [], "and do not trigger a needless rewrite");
}

// A CRLF copy of an OLD version is still stale, not an edit.
{
  const r = rig("crlf-stale", {
    bundled: { "a.json": CURRENT },
    priorVersions: { "a.json": [V1] },
    installed: { "a.json": V1.replace(/\n/g, "\r\n") }
  });
  const s = Setup.ensureDataDirs();
  sameSet(s.refreshed, ["a.json"], "a CRLF copy of a stale shipped version is still refreshed");
}

// ------------------------------- 5. no usable history: never overwrite

{
  const r = rig("no-history", {
    bundled: { "a.json": CURRENT },
    historyText: null,
    installed: { "a.json": V1 }
  });
  const s = Setup.ensureDataDirs();
  sameSet(s.preserved, ["a.json"], "with no history file the old never-overwrite rule stands");
  eq(installed(r.installedDir, "a.json"), V1, "a bundle that lost its history eats nothing");
}

{
  const r = rig("broken-history", {
    bundled: { "a.json": CURRENT },
    historyText: "{ this is not json",
    installed: { "a.json": V1 }
  });
  const s = Setup.ensureDataDirs();
  sameSet(s.preserved, ["a.json"], "an unparseable history is treated as no history");
  eq(installed(r.installedDir, "a.json"), V1, "and still eats nothing");
}

{
  const r = rig("history-missing-entry", {
    bundled: { "a.json": CURRENT, "b.json": CURRENT },
    installed: { "b.json": V1 }
  });
  // Drop b.json's entry: a bundle whose history forgot one file must not
  // let that one file be overwritten.
  const hp = path.join(r.wf, ".hash-history.json");
  const h = JSON.parse(fs.readFileSync(hp, "utf8"));
  delete h.files["b.json"];
  fs.writeFileSync(hp, JSON.stringify(h));
  const s = Setup.ensureDataDirs();
  sameSet(s.seeded, ["a.json"], "the file that was absent is still seeded");
  sameSet(s.preserved, ["b.json"], "a file the history forgot is left alone");
  eq(installed(r.installedDir, "b.json"), V1, "an unrecorded file is not overwritten on a guess");
}

// --------------------------------- 6. a missing bundle is not a crash

{
  BUNDLE = path.join(TMP, "bundle-absent");
  DATA = path.join(TMP, "data-absent");
  fs.mkdirSync(DATA, { recursive: true });
  const s = Setup.ensureDataDirs();
  sameSet(s.seeded, [], "no bundled workflow dir seeds nothing");
  assert(fs.existsSync(path.join(DATA, "comfy-workflows")),
         "and the data tree is still created");
}

// ------------------------------- 7. the real bundle drives the real rule

{
  BUNDLE = path.join(REPO, "extension");
  DATA = path.join(TMP, "data-real");
  fs.mkdirSync(path.join(DATA, "comfy-workflows"), { recursive: true });
  const realWf = path.join(REPO, "extension", "comfy-workflows");
  const names = fs.readdirSync(realWf).filter((n) => n.charAt(0) !== ".");
  const hist = JSON.parse(fs.readFileSync(
    path.join(realWf, ".hash-history.json"), "utf8"));
  // Install the SHIPPED bytes of every bundled file, then re-seed. Every
  // one must read as current: if any shipped file's own hash were missing
  // from the history, a real install of it would read as a user edit and
  // never update again — the exact failure this mechanism exists to end.
  for (const n of names) {
    fs.writeFileSync(path.join(DATA, "comfy-workflows", n),
                     fs.readFileSync(path.join(realWf, n)));
  }
  const s = Setup.ensureDataDirs();
  sameSet(s.current, names, "every shipped file matches the shipped bundle");
  sameSet(s.preserved, [], "no shipped file reads as a user edit against the real history");
  let recorded = 0;
  for (const n of names) recorded += (hist.files[n] || []).length;
  assert(recorded >= names.length,
         "the real history records " + recorded + " versions of " +
         names.length + " bundled files");
}

fs.rmSync(TMP, { recursive: true, force: true });

if (failures) {
  console.log("\n" + failures + " TESTS FAILED");
  process.exitCode = 1;
} else {
  console.log("\nALL TESTS PASSED");
}
