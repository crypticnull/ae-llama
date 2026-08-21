// Regression test: what the real-AE harness DECIDES about the popups it
// sees on the AfterFX process.
//
// The bug this exists for: After Effects disables its main window for as
// long as a `-r` script runs, and puts up its own progress window
// ("Executing Script <file>..."). scripts/run-ae-selftest.ps1 read a
// disabled main window as "AE is stuck on a modal", so on a COLD launch
// — where the suite takes ~24s and AE shows that progress window for the
// last couple of seconds — it printed "After Effects is BLOCKED on a
// modal dialog" and exited 4. The results file, 109/109 passed, landed
// one second later. An unattended pass reading exit 4 stops and files a
// human-needed note about a dialog that was never there.
//
// The samples below are verbatim probe output captured from AE 2026 on
// this machine, so a change to the triage rules is measured against what
// AE actually put on screen, not against what we imagine it does.
//
// The decision itself lives in scripts/lib/ae-dialog-triage.ps1 because
// the runner is PowerShell; this test drives those same functions, so it
// gates the runner rather than a paraphrase of it.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "scripts", "lib", "ae-dialog-triage.ps1");
const RUNNER = path.join(ROOT, "scripts", "run-ae-selftest.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// --- captured from real AE -------------------------------------------
// Cold launch, t=22s and t=23s of a 24s run: the suite is mid-flight.
const PROGRESS =
  "  [#32770] Executing Script aell-selftest-run.jsx...\r\n" +
  "    OS_ViewContainer\r\n";
// The same run at t=24s, the instant the results file appeared: a popup
// with no title and nothing but container children. Says nothing, lasts
// an instant — must not be believed on sight.
const TEARDOWN =
  "  [#32770] \r\n" +
  "    OS_ViewContainer\r\n" +
  "    OS_ViewContainer\r\n" +
  "    OS_EditTextContainer\r\n";
// The real thing: AE's warning when set_mask_path is fed keys with
// differing point counts (see docs/WORKPLAN-LOG.md, 2026-08-21). This
// one never goes away on its own and no script can dismiss it.
const MODAL =
  "  [#32770] After Effects\r\n" +
  "    Deleting points or feathers from an animated mask path deletes " +
  "them from all keyframes.\r\n" +
  "    OK\r\n";
// The probe's own fallback when it cannot read anything at all.
const UNREADABLE_NOTE =
  "  (main window is disabled but no popup text could be read)\r\n";
// A healthy cold launch at t=3..5s: AE has no application window yet and
// puts up two untitled popups of its own while it loads. The application
// window arrived at t=7s and the suite finished at t=11s. AE looks like
// this on the way UP, so it must never be read as stuck.
const STARTUP =
  "  (After Effects has not opened its main window yet)\r\n" +
  "  [#32770] \r\n" +
  "    OS_ViewContainer\r\n" +
  "  [#32770] \r\n" +
  "    OS_ViewContainer\r\n";

if (process.platform !== "win32") {
  console.log("SKIPPED - test-selftest-runner.js drives Windows PowerShell");
  console.log("          (the harness it gates is a .ps1). CI runs on");
  console.log("          windows-latest, where it is NOT skipped.");
  process.exit(0);
}

/**
 * Run one PowerShell script that dot-sources the triage library, so a
 * whole batch of cases costs a single spawn.
 */
function runPs(body) {
  const script = ". '" + LIB.replace(/'/g, "''") + "'\n" + body;
  const file = path.join(
    process.env.TEMP || ".", "aell-triage-test-" + process.pid + ".ps1");
  fs.writeFileSync(file, script, "ascii");
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file
    ], { encoding: "utf8" });
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
}

/** Quote a JS string as a PowerShell double-quoted literal. */
function psString(s) {
  return '"' + s.replace(/`/g, "``").replace(/\$/g, "`$")
    .replace(/"/g, '`"').replace(/\r/g, "`r").replace(/\n/g, "`n") + '"';
}

// --- 1. one probe sample at a time -----------------------------------
const CASES = [
  ["empty", "", "clear", false],
  ["progress", PROGRESS, "running", true],
  ["teardown", TEARDOWN, "unreadable", false],
  ["modal", MODAL, "blocked", false],
  ["modal-behind-progress", PROGRESS + MODAL, "blocked", true],
  ["note", UNREADABLE_NOTE, "unreadable", false],
  ["startup", STARTUP, "startup", false],
  // A dialog we CAN read outranks "still starting" -- if AE names the
  // problem, the problem is what gets reported.
  ["startup-with-modal", STARTUP + MODAL, "blocked", false]
];

let body = "";
CASES.forEach(function (c) {
  body += "$v = Get-AellDialogVerdict -ProbeText " + psString(c[1]) +
    " -ScriptName 'aell-selftest-run.jsx'\n" +
    "Write-Host ('" + c[0] + "|' + $v.Verdict + '|' + $v.SawProgress +" +
    " '|' + ($v.Text -replace '\\s+', ' ').Trim())\n";
});

const verdicts = {};
runPs(body).split(/\r?\n/).forEach(function (line) {
  const p = line.split("|");
  if (p.length >= 4) verdicts[p[0]] = { v: p[1], prog: p[2], text: p[3] };
});

CASES.forEach(function (c) {
  const got = verdicts[c[0]];
  assert(got && got.v === c[2], c[0] + " reads as " + c[2] +
    (got ? " (got " + got.v + ")" : " (no output)"));
  if (got) {
    assert((got.prog === "True") === c[3], c[0] + " " +
      (c[3] ? "is" : "is not") + " evidence the script is running");
  }
});

// The message a human (or the next unattended pass) reads must not carry
// AE's progress window, or the report names the wrong window to dismiss.
assert(verdicts["modal-behind-progress"] &&
  verdicts["modal-behind-progress"].text.indexOf("Executing Script") === -1,
  "a real modal is reported without AE's progress window muddying it");
assert(verdicts["modal-behind-progress"] &&
  verdicts["modal-behind-progress"].text.indexOf("Deleting points") !== -1,
  "a real modal is reported with the text that names the problem");

// --- 2. the wait loop over a whole recorded timeline ------------------
// This is the assertion that would have caught the bug: the runner's own
// decision function, fed the cold-start timeline, must never stop.
function timeline(samples) {
  let b = "$s = New-AellWaitState\n$stopAt = -1\n";
  samples.forEach(function (sample, i) {
    b += "if ($stopAt -lt 0) { $s = Update-AellWaitState -State $s " +
      "-ProbeText " + psString(sample) +
      " -ScriptName 'aell-selftest-run.jsx'\n" +
      "  if ($s.StopNow) { $stopAt = " + i + " } }\n";
  });
  b += "Write-Host ('STOP|' + $stopAt + '|' + $s.SawProgress)\n";
  return b;
}

function stopIndex(samples) {
  const out = runPs(timeline(samples));
  const line = out.split(/\r?\n/).filter(function (l) {
    return l.indexOf("STOP|") === 0;
  })[0];
  if (!line) { return { at: NaN, sawProgress: false }; }
  const p = line.split("|");
  return { at: parseInt(p[1], 10), sawProgress: p[2] === "True" };
}

function repeat(sample, n) {
  const out = [];
  for (let i = 0; i < n; i++) { out.push(sample); }
  return out;
}

// 10 polls of AE still launching, then the progress window, then the
// teardown flicker — exactly what was measured on the cold start.
const cold = stopIndex(repeat("", 10).concat([PROGRESS, PROGRESS, TEARDOWN]));
assert(cold.at === -1,
  "the recorded cold-start timeline never reports a blocking dialog");
assert(cold.sawProgress,
  "the cold-start timeline is still recognised as AE executing the script");

const stuck = stopIndex([PROGRESS, MODAL, MODAL, MODAL, MODAL]);
assert(stuck.at === 3,
  "a real modal stops the run once it has persisted (3 polls, ~6s)");

// One reading is not enough, and a flicker must not be promoted just by
// being seen repeatedly with gaps between.
const flicker = stopIndex([MODAL, "", MODAL, "", MODAL, ""]);
assert(flicker.at === -1,
  "a popup that comes and goes never reports as a blocking modal");

const teardownOnce = stopIndex([PROGRESS, TEARDOWN, ""]);
assert(teardownOnce.at === -1,
  "the one-poll teardown popup is not mistaken for a modal");

const teardownStuck = stopIndex(repeat(TEARDOWN, 10));
assert(teardownStuck.at === 7,
  "an unreadable popup that never leaves is still reported (8 polls, ~16s)");

// The startup case is the one where patience must be INFINITE. AE after a
// crash or a hard kill opens a recovery prompt drawn in its own toolkit --
// no Win32 text to read, indistinguishable on sight from the popups a
// healthy launch shows. Aborting on it would abort healthy cold starts, so
// the run plays out and the timeout explains itself instead.
const starting = stopIndex(repeat(STARTUP, 40));
assert(starting.at === -1,
  "a startup popup never stops the run, however long it lasts");
const remembered = runPs([
  "$s = New-AellWaitState",
  "$s = Update-AellWaitState -State $s -ProbeText " + psString(STARTUP),
  "Write-Host ('SAW|' + $s.SawStartup)"
].join("\n"));
assert(remembered.indexOf("SAW|True") !== -1,
  "the run remembers it saw AE stuck before its main window opened");

// ...and a modal that appears DURING startup is still caught, on the
// normal schedule, because it has words.
const modalAtStartup = stopIndex(
  [STARTUP, STARTUP, STARTUP + MODAL, STARTUP + MODAL, STARTUP + MODAL]);
assert(modalAtStartup.at === 4,
  "a readable modal during startup is still reported once it persists");

// --- 3. the runner actually decides through this ---------------------
const runner = fs.readFileSync(RUNNER, "utf8");
assert(/\.\s*\(Join-Path \$PSScriptRoot "lib\\ae-dialog-triage\.ps1"\)/
  .test(runner), "run-ae-selftest.ps1 dot-sources the triage library");
assert(/Update-AellWaitState/.test(runner),
  "run-ae-selftest.ps1 decides through Update-AellWaitState");
assert(!/\$blocking = Get-BlockingDialog[\s\S]{0,80}if \(\$blocking\) \{ break \}/
  .test(runner), "run-ae-selftest.ps1 no longer breaks on raw probe text");
// Exit 3 must be able to say WHICH kind of nothing happened.
assert(/sawRunning/i.test(runner) || /SawProgress/.test(runner),
  "a timeout distinguishes 'still executing' from 'never started'");
assert(/SawStartup/.test(runner) && /blocking STARTUP/.test(runner),
  "a timeout names the startup-blocking dialog instead of the preference");
// The probe has to FIND AE's window: before AE finishes starting, Windows
// reports the blocking popup itself as MainWindowHandle, and it is
// enabled, so "is the main window disabled" answered no for the one state
// where AE can never run a script.
assert(/StartsWith\("AE_CApplication"\)/.test(runner),
  "the probe locates AE's application window by class, not by handle");
assert(!/if \(\$handle -eq \[IntPtr\]::Zero\) \{ continue \}/.test(runner),
  "a process with no main window handle is still probed");
// An unreadable popup is a real dead end, so the report has to say what
// it most likely is rather than print a blank and stop.
assert(/LastVerdict -eq 'unreadable'/.test(runner) &&
  /save changes/i.test(runner),
  "an unreadable popup is reported with its most likely cause");

// The probe is C# compiled at run time, and a compile error only WARNS --
// it degrades into the silent timeout the probe exists to prevent. One
// lost backslash in the here-string did exactly that, so compile it here.
const win32 = runner.split("$win32 = @'")[1].split("'@")[0];
const csFile = path.join(process.env.TEMP || ".",
  "aell-probe-" + process.pid + ".cs");
fs.writeFileSync(csFile, win32, "ascii");
let compiled = "";
try {
  compiled = runPs("$ErrorActionPreference = 'Stop'\n" +
    "try { Add-Type -TypeDefinition (Get-Content -Raw '" + csFile +
    "'); Write-Host 'CS|ok' } catch { Write-Host ('CS|' + $_.Exception.Message) }");
} finally {
  try { fs.unlinkSync(csFile); } catch (e) {}
}
assert(compiled.indexOf("CS|ok") !== -1,
  "the dialog probe's C# compiles: " +
  (compiled.split("CS|")[1] || "").split("\n")[0].trim());

// The other half of the same cold-start bug: `& $exe -r $f | Out-Null`
// returns instantly when AE is already up (the running instance takes the
// script), but on a cold machine the process PowerShell started IS After
// Effects and holds stdout open for its whole life, so the pipeline never
// finishes and the wait loop below it never runs. Measured: results file
// written in 24s, harness still blocked ten minutes later.
assert(!/&\s*\$AfterFXPath\b/.test(runner),
  "AE is not launched through the call operator (it blocks on a cold start)");
assert(/Start-Process -FilePath \$AfterFXPath/.test(runner),
  "AE is launched with Start-Process, which does not wait on AE's stdout");
assert(!/Start-Process[\s\S]{0,120}-Wait/.test(runner),
  "the launch does not -Wait for After Effects to exit");

// Windows PowerShell 5.1, BOM-less ASCII, per CLAUDE.md.
[LIB, RUNNER].forEach(function (f) {
  const buf = fs.readFileSync(f);
  let bad = -1;
  for (let i = 0; i < buf.length; i++) { if (buf[i] > 127) { bad = i; break; } }
  assert(bad === -1, path.basename(f) + " is pure ASCII (byte " + bad + ")");
});

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
