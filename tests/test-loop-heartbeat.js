// Regression test: the loop must PROVE a running pass is working.
//
// Why this exists (WORKPLAN section 20a).
//
// `claude -p` returns its whole output in one block at the end, so a
// healthy pass writes nothing to the loop log for 6-10 minutes. The
// loop logged "===== pass N =====" and then went silent, and from
// outside a working pass and a wedged one were indistinguishable. Two
// days were spent unable to answer "is it working right now?".
//
// Two specific wrong answers are guarded here, because both were
// actually given and both were wrong:
//
//   CPU. `claude -p` is API-bound and burns almost nothing while
//   working (8.66 CPU-seconds over ten minutes is a NORMAL pass), and
//   the self-test deliberately leaves AE open and idle between steps,
//   so a flat AfterFX counter is the designed state. The same
//   instrument was read in both directions and lied both times, so a
//   heartbeat that reaches for CPU fails this test outright.
//
//   Process NAME. The Claude desktop app is Electron and owns ten or
//   eleven processes called claude; a pass must be found by DESCENT
//   (scripts/lib/claude-procs.ps1), never by name.
//
// The line's real behaviour is exercised by invoking the actual
// PowerShell function where a shell exists - a JS re-implementation of
// the format would be a copy that drifts, and a copy that drifts is
// what makes a green test meaningless. No shell means SKIP, loudly.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "scripts", "lib", "loop-heartbeat.ps1");
const LOOP = path.join(ROOT, "scripts", "run-local-agent.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

// ---------------------------------------------------------------- shape
assert(fs.existsSync(LIB), "scripts/lib/loop-heartbeat.ps1 exists");
const lib = fs.readFileSync(LIB, "utf8");
const loop = fs.readFileSync(LOOP, "utf8");

assert(/function\s+Get-AellHeartbeatLine/i.test(lib),
       "the lib defines Get-AellHeartbeatLine");
assert(/function\s+Get-AellDirtyCount/i.test(lib),
       "the lib defines Get-AellDirtyCount");

// The three proofs. Elapsed time alone is a clock, not a heartbeat:
// it advances just as happily on a hung pass.
assert(/Get-AellCliPassProcesses/.test(lib),
       "existence is read by DESCENT (Get-AellCliPassProcesses), not by name");
assert(/StartedAt/.test(lib) && /TotalSeconds/.test(lib),
       "elapsed time is carried");
assert(/status\s+--porcelain/.test(lib),
       "the dirty file count is carried - the one signal a hung pass cannot fake");

// The prohibition, stated as a test so it cannot be quietly undone.
const cpuish = /\bCPU\b|TotalProcessorTime|PercentProcessorTime|UserProcessorTime/i;
assert(!cpuish.test(lib.replace(/^\s*#.*$/gm, "")),
       "the heartbeat does not read CPU (measured uninformative in BOTH directions)");

// Pure ASCII, no BOM - Windows PowerShell 5.1 (CLAUDE.md).
const raw = fs.readFileSync(LIB);
assert(!raw.some(function (b) { return b > 126; }),
       "loop-heartbeat.ps1 is pure ASCII");
assert(!(raw[0] === 0xEF && raw[1] === 0xBB), "loop-heartbeat.ps1 has no BOM");

// ------------------------------------------------------------- wiring
// A heartbeat that starts after the pass, or never stops, is no
// heartbeat at all: the pipeline BLOCKS, so anything sequenced after it
// runs only once the pass is already over.
const iStart = loop.indexOf("AellPassHeartbeat");
const iPipe = loop.indexOf("& $ClaudePath @claudeArgs");
const iStop = loop.indexOf("Stop-Job -Job $beat");
assert(iStart > -1, "run-local-agent.ps1 starts the pass heartbeat job");
assert(iPipe > -1, "run-local-agent.ps1 still runs the pass through the CLI");
assert(iStop > -1, "run-local-agent.ps1 stops the heartbeat job");
assert(iStart > -1 && iPipe > -1 && iStart < iPipe,
       "the heartbeat starts BEFORE the blocking pass pipeline");
assert(iStop > -1 && iPipe > -1 && iStop > iPipe,
       "the heartbeat is stopped AFTER the pass returns");

const iReap = loop.indexOf("Reaped lingering CLI pass pid");
assert(iStop > -1 && iReap > -1 && iStop < iReap,
       "the heartbeat stops before the reap, so no line claims a dying process");

// The interval. 30s is what the item asked for; anything over a minute
// puts the log back to looking silent.
const beatBlock = loop.slice(iStart, iStop > iStart ? iStop : loop.length);
// A bare number in the -ArgumentList, with or without a trailing comma.
const interval = beatBlock.match(/^\s+(\d+)\s*,?\s*$/m);
assert(interval && Number(interval[1]) > 0 && Number(interval[1]) <= 60,
       "the heartbeat interval is at most 60s (found " +
       (interval ? interval[1] : "none") + ")");

// -------------------------------------------------------- real behaviour
function findPowerShell() {
  const candidates = ["pwsh", "powershell", "/opt/pwsh/pwsh",
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
  console.log("SKIP - no PowerShell found, so the heartbeat line itself was");
  console.log("       not executed. Shape and wiring above were checked.");
} else {
  const procLib = path.join(ROOT, "scripts", "lib", "claude-procs.ps1");
  // A process id that cannot exist: the pass is GONE and the line must
  // say so rather than throw or go blank.
  const script = ". '" + procLib.replace(/'/g, "''") + "'; " +
                 ". '" + LIB.replace(/'/g, "''") + "'; " +
                 "Get-AellHeartbeatLine -RootId 999999 -RepoRoot '" +
                 ROOT.replace(/'/g, "''") + "' " +
                 "-StartedAt (Get-Date).AddSeconds(-125) -Label 'pass 2/7'";
  const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script],
                      { encoding: "utf8", timeout: 60000 });
  const out = String(r.stdout || "").trim();
  console.log("   line: " + out);
  assert(/^\[heartbeat\] pass 2\/7\b/.test(out),
         "the line names the pass it is beating for");
  assert(/elapsed 02:05/.test(out),
         "elapsed is rendered mm:ss from the pass start (02:05)");
  assert(/cli GONE/.test(out),
         "a pass process that does not exist reads GONE, not silence");
  assert(/dirty \d+ file|dirty 0 files|dirty \? /.test(out),
         "the dirty count is present in the rendered line");

  // The clock over synthetic spans (WORKPLAN NEXT UP 1). Observed on a
  // healthy loop at 30 s beats: 00:30, 01:00, 02:31, 02:01, 03:31 -
  // PowerShell's [int] ROUNDS, so 90.6 s carried the minute and the
  // next beat read LESS. Beats land a fraction of a second late, which
  // is exactly what these spans model.
  const spans = [0, 29.9, 30.6, 59.5, 60.6, 90.6, 120.6, 150.6, 180.6,
                 3599.5, 3600, 6000.9, -3];
  const want = ["00:00", "00:29", "00:30", "00:59", "01:00", "01:30",
                "02:00", "02:30", "03:00", "59:59", "60:00", "100:00",
                "00:00"];
  const fmt = ". '" + LIB.replace(/'/g, "''") + "'; " +
              spans.map(function (x) {
                return "Format-AellElapsed -Seconds " + x;
              }).join("; ");
  const f = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", fmt],
                      { encoding: "utf8", timeout: 60000 });
  const got = String(f.stdout || "").trim().split(/\r?\n/)
                .map(function (l) { return l.trim(); });
  console.log("   spans: " + got.join(" "));
  assert(got.length === want.length,
         "Format-AellElapsed returned one clock per span (" + got.length + ")");
  for (let i = 0; i < want.length; i++) {
    assert(got[i] === want[i],
           "elapsed " + spans[i] + " s reads " + want[i] + " (got " + got[i] + ")");
  }
  function secs(c) { const p = String(c).split(":"); return +p[0] * 60 + +p[1]; }
  let monotone = true;
  for (let i = 1; i < 11; i++) if (secs(got[i]) < secs(got[i - 1])) monotone = false;
  assert(monotone, "the clock never runs backwards over increasing spans");
}

console.log("");
if (failed) {
  console.error(failed + " TEST(S) FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
