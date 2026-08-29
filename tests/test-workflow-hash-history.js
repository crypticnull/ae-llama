/*
 * test-workflow-hash-history.js — the bundle's .hash-history.json must
 * cover every template the bundle currently ships.
 *
 * This is CI enforcement in the same spirit as test-capability-doc.js, and
 * it guards something quieter: the history is what tells an unedited-but-
 * stale install from a user's edit. Change a bundled template without
 * recording its new hash and nothing breaks loudly — the next release
 * simply reads every existing install as "user-edited" and stops updating
 * it, which is precisely the bug the history was written to end. So a
 * template edit that forgets the script fails the build.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}

const REPO = path.join(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "workflow-hash-history.js");

function run(args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args),
                   { encoding: "utf8", cwd: REPO });
}

// ------------------------------------------- 1. the shipped bundle is clean

{
  const r = run(["--check"]);
  assert(r.status === 0,
         "the shipped bundle's hashes are all recorded" +
         (r.status === 0 ? "" : ": " + (r.stderr || r.stdout || "").trim()));
}

// ---------------------------------------------- 2. against a throwaway dir

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aell-hist-"));
const DIR = path.join(TMP, "wf");
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, "a.json"), '{"v":1}\n');
fs.writeFileSync(path.join(DIR, "b.json"), '{"v":1}\n');

{
  const missing = run(["--check", "--dir", DIR]);
  assert(missing.status === 1, "--check fails when the history does not exist yet");
  assert(/Missing/.test(missing.stderr), "and says the file is missing");
}

{
  const r = run(["--dir", DIR]);
  assert(r.status === 0, "a plain run writes the history");
  const h = JSON.parse(fs.readFileSync(path.join(DIR, ".hash-history.json"), "utf8"));
  assert(Object.keys(h.files).length === 2, "one entry per bundled file");
  assert(h.files["a.json"].length === 1, "one hash recorded for a fresh file");
  assert(run(["--check", "--dir", DIR]).status === 0, "--check now passes");
}

const firstHash = JSON.parse(
  fs.readFileSync(path.join(DIR, ".hash-history.json"), "utf8")).files["a.json"][0];

{
  // The failure this whole test exists for: a template changed, unrecorded.
  fs.writeFileSync(path.join(DIR, "a.json"), '{"v":2}\n');
  const r = run(["--check", "--dir", DIR]);
  assert(r.status === 1, "--check fails on a bundled file whose hash is unrecorded");
  assert(/a\.json/.test(r.stderr), "and names the file that changed");
  assert(!/b\.json/.test(r.stderr), "without accusing the untouched one");
}

{
  run(["--dir", DIR]);
  const h = JSON.parse(fs.readFileSync(path.join(DIR, ".hash-history.json"), "utf8"));
  assert(h.files["a.json"].length === 2, "the new version is appended");
  assert(h.files["a.json"][0] === firstHash,
         "APPEND-ONLY: the old hash survives (some install is still on it)");
  assert(run(["--check", "--dir", DIR]).status === 0, "--check passes again");
}

{
  // Line endings: git hands a Windows checkout CRLF, so a raw-byte hash
  // would fail --check on one platform and pass on the other.
  fs.writeFileSync(path.join(DIR, "b.json"), '{"v":1}\r\n');
  assert(run(["--check", "--dir", DIR]).status === 0,
         "a CRLF rewrite of an unchanged file still passes --check");
  const h = JSON.parse(fs.readFileSync(path.join(DIR, ".hash-history.json"), "utf8"));
  run(["--dir", DIR]);
  const h2 = JSON.parse(fs.readFileSync(path.join(DIR, ".hash-history.json"), "utf8"));
  assert(h2.files["b.json"].length === h.files["b.json"].length,
         "and records no phantom version for it");
}

{
  // Dotfiles are bundle metadata, not templates: the history must not try
  // to record itself.
  const h = JSON.parse(fs.readFileSync(path.join(DIR, ".hash-history.json"), "utf8"));
  assert(!h.files[".hash-history.json"], "the history does not record itself");
}

fs.rmSync(TMP, { recursive: true, force: true });

if (failures) {
  console.log("\n" + failures + " TESTS FAILED");
  process.exitCode = 1;
} else {
  console.log("\nALL TESTS PASSED");
}
