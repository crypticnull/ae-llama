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
// Captured 2026-08-30, cold launch, t=28..31s of a 26s script: WINDOWS'
// own chrome standing next to a perfectly healthy progress window. The
// drop shadow under a dialog (SysShadow) and the tooltip over a control
// (tooltips_class32) are visible top-level windows of the AfterFX
// process, and both are wordless -- so they read as a dialog nobody
// could see. This exact sample was `unreadable` for three consecutive
// polls, and eight in a row is exit 4 on a suite that is running fine:
// it is what cost the 2026-08-30 pass its first harness run.
const CHROME =
  "  [tooltips_class32] \r\n" +
  "  [SysShadow] \r\n";
// Captured 2026-08-30 from the run that exited 4 while the suite was
// mid-flight. AE's OWN toolkit shell, not the standard dialog class,
// carrying the same three containers as the save prompt and no words.
// Nobody has identified it yet, so it is pinned here as what it is
// measured to be -- an unreadable popup, escalated only by lasting --
// rather than assumed benign because that run's re-run went green.
const DROVERLORD =
  "  [DroverLord - Window Class] \r\n" +
  "    OS_ViewContainer\r\n" +
  "    OS_ViewContainer\r\n" +
  "    OS_EditTextContainer\r\n";

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
  // UTF-8 with a BOM, not ASCII: AE's save-changes prompt carries
  // CURLY quotes, and writing them as ASCII masked them into control
  // characters -- the test would then prove the pattern matches garbage
  // rather than what AE actually says.
  fs.writeFileSync(file, "﻿" + script, "utf8");
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file
    ], { encoding: "utf8" });
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
}

/**
 * Quote a JS string as a PowerShell expression.
 *
 * CURLY quotes get their own treatment, and they have to: PowerShell
 * accepts U+201C/U+201D as string DELIMITERS, so pasting AE's real
 * save-changes text into a double-quoted literal ends the string
 * mid-sentence and the script does not parse at all. They are spliced
 * back in with [char] instead, which is why the result is wrapped in
 * parentheses -- it may be a concatenation, and it is used in argument
 * position.
 */
function psString(s) {
  const parts = s.split(/([“”])/).filter(function (p) {
    return p.length > 0;
  }).map(function (p) {
    if (p === "“") { return "[char]0x201c"; }
    if (p === "”") { return "[char]0x201d"; }
    return '"' + p.replace(/`/g, "``").replace(/\$/g, "`$")
      .replace(/"/g, '`"').replace(/\r/g, "`r").replace(/\n/g, "`n") + '"';
  });
  if (parts.length === 0) { return '("")'; }
  return "(" + parts.join(" + ") + ")";
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
  ["startup-with-modal", STARTUP + MODAL, "blocked", false],
  // The 2026-08-30 regression, in one line: AE's own drop shadow must
  // not outvote AE's own "I am executing your script".
  ["chrome-beside-progress", CHROME + PROGRESS, "running", true],
  // Windows' chrome on its own says nothing about AE either way.
  ["chrome-alone", CHROME, "clear", false],
  // ...and it must not launder anything standing next to it. A real
  // modal is still a real modal with a drop shadow in front of it --
  // which is always, because that shadow is the modal's own.
  ["chrome-beside-modal", CHROME + MODAL, "blocked", false],
  // Nor may it hide a genuinely unreadable AE popup: the teardown
  // flicker is still escalated by lasting, shadow or no shadow.
  ["chrome-beside-teardown", CHROME + TEARDOWN, "unreadable", false],
  // AE's own toolkit shell is a popup like any other. The chrome filter
  // is a list of two Windows classes, deliberately, and widening it to
  // "anything wordless" would swallow this one.
  ["droverlord", DROVERLORD, "unreadable", false],
  ["droverlord-beside-progress", PROGRESS + DROVERLORD, "unreadable", true]
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

// The 2026-08-30 lost run, replayed. A long suite with Windows' chrome
// up beside the progress window the whole time is a HEALTHY run, and
// before the chrome was recognised this stopped at poll 8 -- exit 4 on a
// suite that went on to pass 514/514.
const chromeRun = stopIndex(repeat(CHROME + PROGRESS, 20));
assert(chromeRun.at === -1,
  "AE's own drop shadow never outvotes AE's own progress window");
assert(chromeRun.sawProgress,
  "the chrome timeline is still recognised as AE executing the script");

// The other half of that: chrome must not buy a real modal any patience
// it did not have. A dialog draws a shadow, so this is what EVERY real
// modal actually looks like to the probe.
const modalWithChrome = stopIndex(repeat(CHROME + MODAL, 6));
assert(modalWithChrome.at === 2,
  "a real modal still stops the run on schedule with its shadow up");

// ...and a modal that appears DURING startup is still caught, on the
// normal schedule, because it has words.
const modalAtStartup = stopIndex(
  [STARTUP, STARTUP, STARTUP + MODAL, STARTUP + MODAL, STARTUP + MODAL]);
assert(modalAtStartup.at === 4,
  "a readable modal during startup is still reported once it persists");

// --- 2b. which popups the harness may ANSWER by itself ----------------
// Every cold run leaves AE dirty, so when the launcher exits AE asks to
// save; that prompt then swallows the NEXT pass's -r script entirely.
// The harness now answers a LEFTOVER one before it launches, and the
// whole safety of that lives in this decision: a popup with words on it
// is a question for a human, and must never be closed from here.
const STALE_CASES = [
  // The save-changes prompt: AE fully up, running nothing, one wordless
  // #32770. Verbatim probe output from the 2026-08-26 pass, where it had
  // survived from the previous run and cost that run its first harness
  // attempt (exit 4, zero steps executed).
  ["teardown", TEARDOWN, true],
  // Words on screen = a human's question. Never answered from here.
  ["modal", MODAL, false],
  // Wordless, but a script is executing -- this is our own progress
  // window tearing down, and it leaves on its own.
  ["progress-plus-teardown", PROGRESS + TEARDOWN, false],
  ["progress", PROGRESS, false],
  // No application window yet: the wordless thing is AE's crash-recovery
  // prompt, a different question whose answer is not ours to give.
  ["startup", STARTUP, false],
  // Unreadable, but the probe found no window at all to post to.
  ["note", UNREADABLE_NOTE, false],
  ["empty", "", false]
];

let staleBody = "";
STALE_CASES.forEach(function (c) {
  staleBody += "$p = Get-AellStaleDialogPlan -ProbeText " + psString(c[1]) +
    " -ScriptName 'aell-selftest-run.jsx'\n" +
    "Write-Host ('" + c[0] + "|' + $p.Dismiss + '|' + $p.Reason)\n";
});
const plans = {};
runPs(staleBody).split(/\r?\n/).forEach(function (line) {
  const p = line.split("|");
  if (p.length >= 3) plans[p[0]] = { d: p[1] === "True", why: p[2] };
});
STALE_CASES.forEach(function (c) {
  const got = plans[c[0]];
  assert(got && got.d === c[2], c[0] + " is " +
    (c[2] ? "answered automatically" : "left alone") +
    (got ? " (reason: " + got.why + ")" : " (no output)"));
});

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

// Windows' chrome is filtered in BOTH layers, and on purpose. The triage
// stops it being read as a dialog (that half is driven above with real
// captured probe text); this stops it being LISTED as a popup, which
// matters because a probe that counts only chrome would otherwise emit
// "main window is disabled but no popup text could be read" -- the same
// wrong answer arriving by a different road.
assert(/cls == "SysShadow" \|\| cls == "tooltips_class32"/.test(win32),
  "the probe does not list Windows' own shadow and tooltip as popups");
assert(/popups\+\+/.test(win32.split('cls == "SysShadow"')[1] || ""),
  "chrome is skipped BEFORE the popup counter, not after it");

// Evidence is for the dialogs this harness cannot name. A known one
// costs a screenshot, 1.2s and a raise-to-front of AE's windows on every
// single run, so it is taken for the wordless popup and the unknown --
// and not for the two the harness can read.
assert(/if \(\$AlwaysShoot -or -not \$class\.Known -or \$class\.Label -eq 'wordless'\)/
  .test(runner),
  "a dialog the harness recognises does not get its picture taken");
// ...except on the run that is failing, where the two questions come
// apart: what the HARVEST recognised is not what STOPPED the run. On
// 2026-08-30 a benign harvest (AE's progress window) stood beside the
// popup that cost the run its night, and the picture was skipped.
assert(/-Context 'blocking this run' -AlwaysShoot/.test(runner),
  "a blocked run photographs the screen whatever the harvest recognised");
assert(!/-Context "answered before the launch"[\s\S]{0,40}-AlwaysShoot/
  .test(runner),
  "the pre-launch path still skips the picture for a dialog it knows");

// The harvest reads AE's OWN dialog shell too, not just the standard
// dialog class. Measured 2026-08-30: a run was stopped by a
// "DroverLord - Window Class" popup and the harvest, looking only at
// #32770, reported the progress window standing next to it.
assert(/hcls != "#32770" && hcls\.IndexOf\("DroverLord"\) < 0/.test(win32),
  "the harvest reads AE's DroverLord dialog shell as well as #32770");
// Reading is widened; ANSWERING is not. WM_CLOSE still goes to the
// standard dialog class alone -- a DroverLord popup is one nobody has
// identified, and it is not for an unattended run to close it.
const onClose = win32.split("private static bool OnClose(")[1].split("private static bool")[0];
assert(/ClassOf\(h\) != "#32770"/.test(onClose) &&
  onClose.indexOf("DroverLord") === -1,
  "what may be ANSWERED unattended is still #32770 and nothing else");

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

// The stale-dialog answer is only safe BEFORE the launch: after it, a
// wordless popup may be our own progress window tearing down, and the
// wait loop is what is allowed to judge those. Ordering is the rail.
const clearAt = runner.indexOf("Clear-AellStaleDialog }");
const launchAt = runner.indexOf("Start-Process -FilePath $AfterFXPath");
assert(clearAt !== -1 && launchAt !== -1 && clearAt < launchAt,
  "a leftover dialog is answered BEFORE After Effects is launched");
assert(runner.indexOf("Update-AellWaitState") > launchAt,
  "the wait loop still runs after the launch, judging this run's popups");
assert(/Get-AellStaleDialogPlan/.test(runner),
  "the runner decides what to answer through Get-AellStaleDialogPlan");
assert(/NoDismissStale/.test(runner),
  "a human can opt out of the automatic answer (-NoDismissStale)");
// The Win32 side must repeat the rail rather than trust its caller: it
// posts only to a wordless top-level #32770 of AE's own process.
assert(/ClassOf\(h\) != "#32770"/.test(runner),
  "only a #32770 is ever closed, never AE's application window");
assert(/hasWords/.test(runner) && /StartsWith\("OS_"\)/.test(runner),
  "a dialog with readable child text is never closed");
assert(/PostMessageW\(h, 0x0010/.test(runner),
  "WM_CLOSE is POSTED, so a wedged dialog cannot wedge the harness");
assert(!/Stop-Process/.test(runner),
  "AE is never killed - a hard kill is what raises the startup " +
  "recovery dialog next launch");

// --- 4. what the harness READS off a dialog before it answers --------
// For years nothing could read an After Effects dialog: GetWindowTextW
// returns EMPTY for a control owned by another process, so every AE
// alert arrived at the triage as "no readable text" and a human (or an
// unattended pass) had to guess from context -- the 2026-08-28 pass burnt
// two blind re-runs on a dialog that named its own cause the moment
// WM_GETTEXT was tried. These are the harvests measured on AE 2026 with
// SendMessageTimeout(WM_GETTEXT) on every child of the #32770.

// The save-changes prompt, verbatim (2026-08-28): an empty title, three
// DroverLord containers reporting their own class, and one `Edit` child
// carrying the sentence. The curly quotes are AE's; this file is UTF-8
// but the .ps1 that matches it is ASCII, so the pattern must reach
// AROUND them.
const HARVEST_SAVE =
  "OS_ViewContainer\r\n" +
  "OS_ViewContainer\r\n" +
  "OS_EditTextContainer\r\n" +
  "Save changes to \u201cUntitled Project.aep\u201d before closing?\r\n";
// The wordless popup: AE's progress window tearing down, or any dialog
// even WM_GETTEXT cannot reach. Benign because it is exactly what the
// runner has always answered blind.
const HARVEST_WORDLESS =
  "OS_ViewContainer\r\n" +
  "OS_ViewContainer\r\n";
// A control that did not answer in time is RECORDED, not dropped -- a
// failed read must not pass for a dialog with nothing to say -- but it
// is not something the dialog said either.
const HARVEST_NOANSWER = "OS_ViewContainer\r\n<no answer>\r\n";
// The alert that cost the 2026-08-28 pass its probe, read in one call.
const HARVEST_ERROR =
  "OS_ViewContainer\r\n" +
  "Unable to execute script at line 35. After Effects error: Unable to " +
  "call \"addComp\" because the call requires 6 parameters.\r\n";

// AE's own script-progress window, harvested 2026-08-30: two lines, and
// the only one with words in it is AE saying it is busy. It is up for
// every second of every -r run this harness makes, so until it was named
// the evidence path headlined UNRECOGNIZED DIALOG over the top of it and
// pointed the morning review at the wrong window.
const HARVEST_PROGRESS =
  "Executing Script aell-selftest-run.jsx...\r\n" +
  "OS_ViewContainer\r\n";

const HARVEST_CASES = [
  // name, harvest, known-benign?, label
  ["save", HARVEST_SAVE, true, "save-changes prompt"],
  ["wordless", HARVEST_WORDLESS, true, "wordless"],
  ["noanswer", HARVEST_NOANSWER, true, "wordless"],
  ["empty", "", true, "wordless"],
  ["error", HARVEST_ERROR, false, "unrecognized"],
  ["progress", HARVEST_PROGRESS, true, "script-progress window"],
  // Both benign windows at once -- the save prompt a previous run left
  // and the progress window of the script asking about it. Named, both
  // of them, rather than one of them standing in for the pair.
  ["save-plus-progress", HARVEST_SAVE + HARVEST_PROGRESS, true,
    "save-changes prompt + script-progress window"],
  // Two popups at once: the save prompt standing next to an error alert
  // must NOT launder it. Judged line by line, never on the joined text.
  ["save-plus-error", HARVEST_SAVE + HARVEST_ERROR, false, "unrecognized"],
  // The same rule for the progress window: a script that is running AND
  // has raised an alert is a run that is stuck, and the alert is what
  // the morning review has to see.
  ["progress-plus-error", HARVEST_PROGRESS + HARVEST_ERROR, false,
    "unrecognized"]
];

let harvestBody = "";
HARVEST_CASES.forEach(function (c) {
  harvestBody += "$c = Get-AellHarvestClass -Harvest " + psString(c[1]) +
    "\nWrite-Host ('" + c[0] + "|' + $c.Known + '|' + $c.Label + '|' + " +
    "$c.Unknown)\n";
});
const classes = {};
runPs(harvestBody).split(/\r?\n/).forEach(function (line) {
  const p = line.split("|");
  if (p.length >= 4) classes[p[0]] = { known: p[1] === "True", label: p[2],
    unknown: p.slice(3).join("|") };
});
HARVEST_CASES.forEach(function (c) {
  const got = classes[c[0]];
  assert(got && got.known === c[2] && got.label === c[3],
    "harvest '" + c[0] + "' is " + (c[2] ? "known-benign" : "UNRECOGNIZED") +
    " (" + c[3] + ")" + (got ? " - got " + got.label : " (no output)"));
});
assert(classes["error"] &&
  classes["error"].unknown.indexOf("addComp") !== -1,
  "an unrecognized dialog is reported with the words it actually said");
assert(classes["save-plus-error"] &&
  classes["save-plus-error"].unknown.indexOf("Save changes") === -1 &&
  classes["save-plus-error"].unknown.indexOf("addComp") !== -1,
  "only the line nobody recognised is named as unknown");
assert(classes["progress-plus-error"] &&
  classes["progress-plus-error"].unknown.indexOf("Executing Script") === -1 &&
  classes["progress-plus-error"].unknown.indexOf("addComp") !== -1,
  "an alert beside the progress window is reported without it");

// The noise filter: AE's containers report their CLASS as their text, so
// they are not words a dialog said. If this stopped filtering, every
// wordless popup would report as UNRECOGNIZED and the morning review
// would learn to ignore the marker.
const wordsOut = runPs([
  "$w = @(Get-AellHarvestWords -Harvest " + psString(HARVEST_SAVE) + ")",
  "Write-Host ('WORDS|' + $w.Count + '|' + ($w -join '~'))"
].join("\n"));
assert(/WORDS\|1\|Save changes to/.test(wordsOut),
  "container children are not counted as something the dialog said");

// The whole point of reading before answering: this must NOT become a
// reason to refuse. The save-changes prompt is readable now, and it is
// still the dialog the harness answers by itself -- the verdict that
// gates that answer is deliberately not fed the harvest.
assert(plans["teardown"] && plans["teardown"].d === true,
  "reading a dialog did not make the harness refuse to clear it");
const lib = fs.readFileSync(LIB, "utf8");
assert(!/Get-AellHarvestClass|Get-AellHarvestWords/
  .test(lib.split("function Get-AellDialogVerdict")[1]
    .split("function Get-AellHarvestWords")[0]),
  "the verdict is still decided from the situation, not from the harvest");

// The runner side: read with WM_GETTEXT, and never with a call that can
// block forever -- this runs unattended, and a wedged dialog must not
// wedge the harness with it.
assert(/SendMessageTimeoutW/.test(runner) && /0x000D/.test(runner),
  "the harvest asks controls for their text with WM_GETTEXT");
assert(!/private static extern IntPtr SendMessageW/.test(runner),
  "the harvest cannot block on a wedged dialog (SendMessageTimeout only)");
assert(/0x0002 \| 0x0020/.test(runner),
  "the WM_GETTEXT send aborts if the dialog's thread is hung");
assert(/<no answer>/.test(runner),
  "a control that does not answer is recorded, not silently skipped");
// Evidence is gathered BEFORE the PostMessage that answers the dialog:
// afterwards there is nothing left to read.
const evidenceAt = runner.indexOf("Write-AellDialogEvidence -Context \"answered");
const answerAt = runner.indexOf("CloseWordlessDialogs($proc.Id)");
assert(evidenceAt !== -1 && answerAt !== -1 && evidenceAt < answerAt,
  "the dialog is read BEFORE it is answered");
assert(/UNRECOGNIZED DIALOG/.test(runner),
  "a dialog the harness does not know is marked in the pass log");
// The screenshot is of the whole virtual screen. AE draws its dialog
// frame offset from the rect Win32 reports (measured: rect 60,60, dialog
// drawn near 133,127), so two rect crops captured the desktop behind it.
assert(/CopyFromScreen\(\$vs\.X, \$vs\.Y/.test(runner),
  "the screenshot captures the whole screen, not the dialog's rect");
assert(/logs.dialogs/.test(runner),
  "screenshots land in logs\\dialogs, which is gitignored");
// A run must never fail because it could not take a picture.
assert(/function Save-AellDialogShot[\s\S]{0,1400}\} catch \{/.test(runner),
  "a failed screenshot cannot break the run");

// Windows PowerShell 5.1, BOM-less ASCII, per CLAUDE.md.
[LIB, RUNNER].forEach(function (f) {
  const buf = fs.readFileSync(f);
  let bad = -1;
  for (let i = 0; i < buf.length; i++) { if (buf[i] > 127) { bad = i; break; } }
  assert(bad === -1, path.basename(f) + " is pure ASCII (byte " + bad + ")");
});

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
