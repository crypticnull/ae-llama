// Regression test: AE's crash-recovery prompt must be PREVENTED.
//
// Why this exists (WORKPLAN section 21).
//
// Measured 2026-09-08 on AE 26.3, the crash-recovery dialog cannot be
// pressed by automation at all: a #32770 with an empty title whose whole
// content is one OS_ViewContainer, and UI Automation over every
// descendant returns a single Pane. No button HWND, no UIA element, so
// every Buttons list in host-dialogs.ps1 is unreachable. It blocked AE's
// main window for 878 seconds until a human clicked it.
//
// The trap is self-sustaining: run-ae-selftest.ps1 kills AE when it
// times out, and killing AE is what arms the prompt for the next launch.
//
// Three specific wrong turns are guarded here, because all three were
// either made or nearly made:
//
//   The install path. AE 26.3 lives in "Adobe After Effects 2026" while
//   its registry key is 26.3. Deriving the key from the folder name
//   would clear a key that does not exist and report success.
//
//   Clearing under a live AE. AE owns the key for its whole session and
//   rewrites it on exit, so a clear applied while it runs is silently
//   undone. A fix that reports success while being reverted is the
//   section 20 preflight lesson wearing a different hat.
//
//   Non-ASCII in a .ps1. CLAUDE.md requires pure ASCII; a stray escape
//   put a BEL byte in the dot-source path during this very change, and
//   it still parsed.
//
// Behaviour is exercised by invoking the REAL PowerShell functions. A JS
// re-implementation would be a copy that drifts, and a copy that drifts
// is what makes a green test meaningless. No shell means SKIP, loudly.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "scripts", "lib", "ae-crash-flag.ps1");
const HARNESS = path.join(ROOT, "scripts", "run-ae-selftest.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

// ---------------------------------------------------------------- shape
assert(fs.existsSync(LIB), "scripts/lib/ae-crash-flag.ps1 exists");
const src = fs.readFileSync(LIB, "utf8");
const harness = fs.readFileSync(HARNESS, "utf8");

assert(/CrashOccurred/.test(src), "it names the CrashOccurred value");
assert(/Remove-ItemProperty/.test(src),
  "it REMOVES the value rather than writing 0 - absent is what a healthy AE writes");
// An executable statement, not a mention: the file explains in a comment
// why it does NOT set StrictMode, and a naive substring match reads that
// explanation as the very thing it forbids.
assert(!/^\s*Set-StrictMode/m.test(src),
  "a dot-sourced lib does not set StrictMode into its caller's scope");
assert(/ProductVersion/.test(src),
  "the version key comes from ProductVersion, never the install folder's year");

// The .ps1 files must be pure ASCII (CLAUDE.md). A BEL byte got into the
// dot-source path here once and still parsed, so this is not theoretical.
for (const [name, text] of [["lib", src], ["harness", harness]]) {
  assert(!/[^\x09\x0a\x0d\x20-\x7e]/.test(text),
    "the " + name + " .ps1 is pure ASCII");
}

// It has to be WIRED, or it protects nothing.
assert(/ae-crash-flag\.ps1/.test(harness),
  "run-ae-selftest.ps1 dot-sources the crash-flag lib");
assert(harness.indexOf("ae-crash-flag.ps1") < harness.indexOf("Start-Process -FilePath $AfterFXPath"),
  "and clears the flag BEFORE launching AE, not after");

// ------------------------------------------------------------ behaviour
const shell = process.platform === "win32" ? "powershell.exe" : null;
if (!shell) {
  console.log("SKIP - behaviour needs Windows PowerShell; shape checks only");
} else {
  const key = "HKCU:\Software\_aell-crash-flag-test-" + process.pid;
  const ps = [
    ". '" + LIB.replace(/'/g, "''") + "'",
    "$k = '" + key + "'",
    "New-Item -Path $k -Force | Out-Null",
    // Re-arm before EVERY clear. The first version of this test set the
    // value once and assumed the unforced call would refuse, which is
    // only true while AE happens to be running -- it passed the night it
    // was written and failed the next morning once AE was closed, with
    // the unforced call quietly consuming the value the -Force case
    // needed. A test that reads ambient machine state as fixture is the
    // same class of mistake as diagnosing a pass off CPU.
    "function Arm { New-ItemProperty -Path $k -Name CrashOccurred -Value 1 -PropertyType DWord -Force | Out-Null }",
    "Arm",
    "Write-Output ('READ=' + (Get-AellAeCrashFlag -VersionKey $k))",
    "$refuse = Clear-AellAeCrashFlag -VersionKey $k",
    "Write-Output ('AERUNNING=' + (Test-AellAeRunning))",
    "Write-Output ('REFUSED=' + (-not $refuse.Cleared) + '|' + $refuse.Reason)",
    "Arm",
    "$done = Clear-AellAeCrashFlag -VersionKey $k -Force",
    "Write-Output ('CLEARED=' + $done.Cleared + '|BEFORE=' + $done.Before)",
    "Write-Output ('AFTER=' + $(if ($null -eq (Get-AellAeCrashFlag -VersionKey $k)) { 'ABSENT' } else { 'STILLTHERE' }))",
    "$again = Clear-AellAeCrashFlag -VersionKey $k -Force",
    "Write-Output ('SECOND=' + $again.Cleared + '|' + $again.Reason)",
    "$missing = Clear-AellAeCrashFlag -VersionKey 'HKCU:\Software\_aell-no-such-key'",
    "Write-Output ('MISSING=' + $missing.Cleared + '|' + $missing.Reason)",
    "Remove-Item -Path $k -Recurse -Force -ErrorAction SilentlyContinue"
  ].join("; ");

  const run = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8" });
  const out = (run.stdout || "") + (run.stderr || "");
  const field = (n) => {
    const m = out.match(new RegExp("^" + n + "=(.*)$", "m"));
    return m ? m[1].trim() : null;
  };

  assert(field("READ") === "1", "it reads a DWord CrashOccurred of 1");

  // The refusal only happens while AE is up, so which branch is checked
  // depends on the machine. Both are asserted, neither is skipped.
  if (field("AERUNNING") === "True") {
    assert(/^True\|/.test(field("REFUSED") || ""),
      "it REFUSES to clear while After Effects is running");
    assert(/rewrites it on exit/.test(field("REFUSED") || ""),
      "and the reason says why, because that string lands in the loop log");
  } else {
    assert(/^False\|removed CrashOccurred/.test(field("REFUSED") || ""),
      "with AE closed the unforced call clears it - no -Force needed on a cold machine");
  }

  assert(field("CLEARED") === "True|BEFORE=1",
    "with -Force it clears, and reports the value it found");
  assert(field("AFTER") === "ABSENT",
    "the value is gone afterwards, not set to 0");
  assert(/^False\|no CrashOccurred value/.test(field("SECOND") || ""),
    "clearing an already-clean key is not a failure");
  assert(/^False\|no version key/.test(field("MISSING") || ""),
    "and a missing key is reported, not treated as an error - a fresh install has none");
}

console.log("");
if (failed) { console.error(failed + " CHECK(S) FAILED"); process.exit(1); }
console.log("ALL TESTS PASSED");
