// Regression test: one pass must not be able to eat the whole night.
//
// Why this exists (WORKPLAN section 20b).
//
// The pass is a BLOCKING pipeline -- `Get-Content $promptFile | & claude`
// -- and nothing bounded it. run-ae-selftest.ps1 carries -TimeoutSec 240
// and every other step carried nothing, so a wedged pass held the loop
// until a human noticed. Overnight, that is the rest of the night, and
// an entire week of nights was lost to the loop not running.
//
// The hazard this guards is not "does it kill something" but "does it
// kill the RIGHT something". The Claude desktop app is Electron and owns
// a dozen processes named claude; a guard that reaped by NAME would take
// the owner's editor down mid-session. Passes are found by DESCENT from
// the loop process, and Test-AellDesktopApp excludes the app explicitly.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LOOP = path.join(ROOT, "scripts", "run-local-agent.ps1");
const PROCS = path.join(ROOT, "scripts", "lib", "claude-procs.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

const loop = fs.readFileSync(LOOP, "utf8");

// ----------------------------------------------------------- the bound
const dflt = loop.match(/\[int\]\$PassTimeoutMin\s*=\s*(\d+)/);
assert(dflt, "run-local-agent.ps1 takes -PassTimeoutMin");
if (dflt) {
  const mins = parseInt(dflt[1], 10);
  // A normal pass is 6-10 minutes; NEXT UP item 1 is a ~2 GB download.
  // Too tight kills the work it exists to protect.
  assert(mins >= 30 && mins <= 120,
    "the default bound is generous but finite (" + mins + " min)");
}
assert(/\$fwd = \$fwd \+ ' -PassTimeoutMin ' \+ \$PassTimeoutMin/.test(loop),
  "the bound is forwarded to the WMI-detached child, or it only applies in-window");

// ------------------------------------------------- kills the right thing
assert(/Get-AellCliPassProcesses -RootId \$rootId/.test(loop),
  "the guard finds the pass by DESCENT from the loop process");
const guard = loop.slice(loop.indexOf("AellPassTimeout"), loop.indexOf("$passLines ="));
assert(!/Get-Process\s+(-Name\s+)?claude/i.test(guard),
  "and never by process name - the desktop app owns a dozen of those");
assert(/Stop-Process -Id \$cp\.ProcessId/.test(guard),
  "it stops specific pids, not a name pattern");

// ------------------------------------------------------ reports honestly
assert(/Pass TIMED OUT/.test(loop), "a timeout is logged as a timeout");
assert(loop.indexOf("Stop-Job -Job $guard") < loop.indexOf("Pass TIMED OUT"),
  "the guard is torn down before its sentinel is read");
assert(loop.indexOf("$timeoutFlag = Join-Path") < loop.indexOf("$passLines ="),
  "and the sentinel is armed BEFORE the blocking pipeline, not after");

// --------------------------------------------------------- live check
// The guard is only safe if Get-AellCliPassProcesses refuses to nominate
// the Claude desktop app. This process has no claude descendants, so the
// honest answer here is zero - and a non-zero answer means the guard
// would kill something that is not a pass.
if (process.platform !== "win32") {
  console.log("SKIP - descent check needs Windows PowerShell");
} else {
  const ps = [
    ". '" + PROCS.replace(/'/g, "''") + "'",
    "$found = @(Get-AellCliPassProcesses -RootId $PID)",
    "Write-Output ('COUNT=' + $found.Count)",
    "Write-Output ('CENSUS=' + (Get-AellClaudeCensus -RootId $PID).NamedTotal)"
  ].join("; ");
  const run = spawnSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  const out = (run.stdout || "") + (run.stderr || "");
  const count = (out.match(/^COUNT=(\d+)$/m) || [])[1];
  const census = (out.match(/^CENSUS=(\d+)$/m) || [])[1];

  assert(count === "0",
    "a process with no pass beneath it nominates nothing to kill");
  assert(census !== undefined && parseInt(census, 10) > 0,
    "while claude-named processes DO exist on this machine (" + census +
    ") - which is exactly why name matching would be catastrophic");
}

console.log("");
if (failed) { console.error(failed + " CHECK(S) FAILED"); process.exit(1); }
console.log("ALL TESTS PASSED");
