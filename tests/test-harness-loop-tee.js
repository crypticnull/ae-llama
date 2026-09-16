// Regression test: the self-test's verdict must reach the LOOP log, not
// only the pass that ran it (WORKPLAN 20e, NEXT UP 19).
//
// A pass runs scripts/run-ae-selftest.ps1 as its own child, so the
// harness's stdout goes to the pass, and the loop log only ever got the
// summary the pass wrote at the end. On 2026-09-09 the 20b timeout killed
// pass 16 at 45:48, the summary died with it, and "Running self-test via"
// and "Crash flag:" appeared ZERO times in the whole night's log.
//
// The fix: run-local-agent.ps1 exports AELL_LOOP_LOG (inherited by every
// pass and everything it spawns), and the harness appends its crash-flag,
// launch and verdict lines there directly as they happen.
//
// Two halves, same as test-loop-log-append.js:
//   - wiring: the loop exports the variable before any pass runs, and every
//     exit of the harness writes a verdict line through the tee first;
//   - behaviour: the REAL harness, pointed at an AfterFX.exe that does not
//     exist, exits 2 without going near After Effects and leaves its
//     verdict in the named log while a reader holds that log open.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LOOP = path.join(ROOT, "scripts", "run-local-agent.ps1");
const HARNESS = path.join(ROOT, "scripts", "run-ae-selftest.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

const code = function (s) { return s.replace(/^\s*#.*$/gm, ""); };
const loop = code(fs.readFileSync(LOOP, "utf8"));
const harness = code(fs.readFileSync(HARNESS, "utf8"));

// ------------------------------------------------------------- the loop
const exportAt = loop.search(/\$env:AELL_LOOP_LOG\s*=\s*\$logFile\b/);
const logFileAt = loop.search(/\$logFile\s*=\s*Join-Path/);
const passAt = loop.search(/&\s*\$ClaudePath\s+@claudeArgs/);
assert(exportAt > -1, "run-local-agent.ps1 exports AELL_LOOP_LOG = $logFile");
assert(logFileAt > -1 && exportAt > logFileAt,
       "the export comes after $logFile is assigned (not an empty path)");
assert(passAt > -1 && exportAt < passAt,
       "the export comes before the first pass is started, so the pass inherits it");

// ---------------------------------------------------------- the harness
const libAt = harness.search(/\.\s*\(Join-Path \(Join-Path \$PSScriptRoot "lib"\) "log-append\.ps1"\)/);
const fnAt = harness.search(/function\s+Write-AellHarnessLine/);
assert(libAt > -1, "the harness dot-sources lib/log-append.ps1 (readers must not block the tee)");
assert(fnAt > -1 && /\$env:AELL_LOOP_LOG/.test(harness.slice(fnAt, fnAt + 400)),
       "Write-AellHarnessLine writes to AELL_LOOP_LOG when it is set");

const exits = [];
const exitRe = /^\s*exit\s+(\d+)\s*$/gm;
let m;
while ((m = exitRe.exec(harness))) exits.push({ code: m[1], at: m.index });
const codes = exits.map(function (e) { return e.code; }).sort().join(",");
assert(codes === "0,1,2,3,4",
       "the harness still has exactly the exits 0-4 this test knows (got " + codes + ")");
assert(fnAt > -1 && exits.every(function (e) { return e.at > libAt && e.at > fnAt; }),
       "the tee is defined before the first exit");
for (const e of exits) {
  // The verdict line must be the last thing written before the exit.
  const before = harness.slice(0, e.at);
  const lastTee = before.lastIndexOf("Write-AellHarnessLine");
  const lastHost = before.lastIndexOf("Write-Host");
  const lastExit = Math.max.apply(null, [-1].concat(exits
    .filter(function (x) { return x.at < e.at; })
    .map(function (x) { return x.at; })));
  assert(lastTee > lastExit && lastTee > lastHost,
         "exit " + e.code + " writes its verdict through Write-AellHarnessLine last");
}
for (const phrase of ["Crash flag: ", "Running self-test via "]) {
  const bare = new RegExp("Write-Host\\s*\\(?\\s*\"" + phrase);
  const teed = new RegExp("Write-AellHarnessLine\\s*\\(?\\s*\"" + phrase);
  assert(!bare.test(harness) && teed.test(harness),
         "\"" + phrase.trim() + "\" goes through the tee, never bare Write-Host");
}

// -------------------------------------------------------- real behaviour
function findPowerShell() {
  const candidates = ["powershell", "pwsh", "/opt/pwsh/pwsh",
                      "/usr/bin/pwsh", "/usr/local/bin/pwsh"];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-NoProfile", "-Command",
                              "$PSVersionTable.PSVersion.Major"],
                          { encoding: "utf8", timeout: 30000 });
      if (r.status === 0 && /^\d+/.test(String(r.stdout).trim())) return c;
    } catch (e) { /* next */ }
  }
  return null;
}

const shell = findPowerShell();
if (!shell) {
  console.log("");
  console.log("SKIP - no PowerShell found, so the harness was not executed.");
  console.log("       Wiring above was checked.");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-harness-tee-"));
  const log = path.join(dir, "loop.log");
  const missingExe = path.join(dir, "no-such-dir", "AfterFX.exe");
  fs.writeFileSync(log, "===== pass 1 =====\n");
  const run = function (env) {
    return spawnSync(shell, ["-NoProfile", "-NonInteractive",
                             "-ExecutionPolicy", "Bypass", "-File", HARNESS,
                             "-AfterFXPath", missingExe],
                     { encoding: "utf8", timeout: 60000, env: env });
  };

  const withLog = Object.assign({}, process.env, { AELL_LOOP_LOG: log });
  const fd = fs.openSync(log, "r");   // someone watching the night
  let r;
  try { r = run(withLog); } finally { fs.closeSync(fd); }
  assert(r.status === 2, "the harness exits 2 on a missing AfterFX.exe (got " +
         r.status + (r.stderr ? ", stderr " + String(r.stderr).trim().slice(0, 200) : "") + ")");
  const lines = fs.readFileSync(log, "utf8").split(/\r?\n/);
  assert(lines[0] === "===== pass 1 =====", "the loop's own lines are left intact");
  assert(/^\[\d\d:\d\d:\d\d\] \[harness\] SELF-TEST NOT RUN \(exit 2\): AfterFX\.exe not found$/
           .test(lines[1] || ""),
         "the verdict landed in the loop log, stamped and tagged (got " +
         JSON.stringify(lines[1]) + ")");
  assert(/SELF-TEST NOT RUN \(exit 2\)/.test(String(r.stdout)),
         "the same line still reaches the harness's own stdout");

  const without = Object.assign({}, process.env);
  delete without.AELL_LOOP_LOG;
  const before = fs.readFileSync(log, "utf8");
  const r2 = run(without);
  assert(r2.status === 2 && fs.readFileSync(log, "utf8") === before,
         "with AELL_LOOP_LOG unset (a human run) nothing is written anywhere");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (failed) {
  console.error(failed + " TEST(S) FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
