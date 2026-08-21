# run-ae-selftest.ps1 - drive REAL After Effects through the panel's
# self-test suite from the command line, no panel and no LLM involved.
# Meant for a local agent (or a human) iterating on this repo:
#
#   powershell -ExecutionPolicy Bypass -File scripts/run-ae-selftest.ps1
#
# Exit codes: 0 = all passed, 1 = failures, 2 = AfterFX.exe not found,
# 3 = no results (AE not running / scripting file access disabled),
# 4 = AE is blocked on a modal dialog (its text is printed).
#
# Requirements:
# - After Effects installed (auto-detected under Program Files, or pass
#   -AfterFXPath). AE may already be running; -r reuses the instance.
# - AE preference enabled: Preferences > Scripting & Expressions >
#   "Allow Scripts to Write Files and Access Network".

param(
  [string]$AfterFXPath = "",
  [string]$RepoRoot = "",
  [int]$TimeoutSec = 240
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path $RepoRoot).Path

if (-not $AfterFXPath) {
  $adobe = "C:\Program Files\Adobe"
  if (Test-Path $adobe) {
    $dirs = Get-ChildItem $adobe -Directory -Filter "Adobe After Effects*" |
      Sort-Object Name -Descending
    foreach ($d in $dirs) {
      $exe = Join-Path $d.FullName "Support Files\AfterFX.exe"
      if (Test-Path $exe) { $AfterFXPath = $exe; break }
    }
  }
}
if (-not $AfterFXPath -or -not (Test-Path $AfterFXPath)) {
  Write-Host "AfterFX.exe not found - pass -AfterFXPath 'C:\...\AfterFX.exe'"
  exit 2
}

. (Join-Path $PSScriptRoot "lib\ae-dialog-triage.ps1")

$out = Join-Path $env:TEMP "aell-selftest-results.json"
Remove-Item $out -ErrorAction SilentlyContinue

$repoFs = $RepoRoot -replace "\\", "/"
$outFs = $out -replace "\\", "/"

# Single-quoted here-string: nothing interpolates; placeholders are
# replaced explicitly so ExtendScript's $.global survives untouched.
$wrapperTemplate = @'
$.global.AELL_TEST_REPO = "__REPO__";
$.global.AELL_TEST_OUT = "__OUT__";
try {
  $.evalFile(new File("__REPO__/scripts/ae-selftest.jsx"));
} catch (e) {
  // Best effort only: a COMPILE error in the target may surface as an AE
  // modal rather than a catchable exception, which is why this script
  // also watches for a blocking dialog. When it is catchable, this turns
  // a silent timeout into a real message.
  try {
    var f = new File("__OUT__");
    f.encoding = "UTF-8";
    f.open("w");
    f.write('{"passed":0,"total":0,"text":"Runner failed to load: ' +
            String(e).replace(/[\\"\r\n]/g, " ") + '"}');
    f.close();
  } catch (e2) {}
}
'@
$wrapper = Join-Path $env:TEMP "aell-selftest-run.jsx"
$wrapperName = Split-Path $wrapper -Leaf
$wrapperTemplate.Replace("__REPO__", $repoFs).Replace("__OUT__", $outFs) |
  Set-Content -Path $wrapper -Encoding ASCII

# Start-Process, NOT `& $exe ... | Out-Null`. When AE is already running,
# `-r` hands the script to that instance and the launcher exits at once,
# so the call operator looked fine for months. On a COLD machine there is
# no instance to hand to: the process PowerShell just started IS After
# Effects, it holds its stdout open (GPU warnings, asio logs) for as long
# as AE lives, and the pipeline waits for it. Measured: the suite wrote
# its 109/109 results file in 24s and the harness was still blocked ten
# minutes later, never reaching the wait loop below. That is the exact
# case an unattended pass runs in.
Write-Host ("Running self-test via " + $AfterFXPath)
Start-Process -FilePath $AfterFXPath -ArgumentList @("-r", $wrapper) |
  Out-Null

# A compile error inside the runner produces NO results file, because the
# try/catch meant to report it never executes either -- symptom identical
# to "scripting file access is disabled". AE compounds it by DISABLING
# its main window behind the resulting modal, so every later -r launch is
# swallowed while the process still reports as healthy. Reading the
# dialog is the only way to tell these two apart.
$win32 = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AellWin {
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr h);

    private static StringBuilder found;
    private static int target;
    private static IntPtr appWindow;
    private static int popups;

    // A DISABLED main window is the authoritative signal that AE is stuck
    // behind something modal -- true whatever class the popup happens to
    // be. Keying off the dialog class alone would miss AE's own
    // DroverLord-classed windows, so the class is used only to decide
    // which popups are worth reading text from.
    //
    // AE's window has to be FOUND, not taken from the caller. Before AE
    // finishes starting there is no application window at all, and
    // Windows then hands out whatever popup is up as the process's
    // MainWindowHandle -- an ENABLED window, which read as "healthy".
    // That is why a recovery dialog blocking startup (what AE opens after
    // it is killed or crashes) was reported as the scripting-file-access
    // preference: the one state where AE can never run a -r script was
    // the one state the probe could not see. Measured on a healthy cold
    // launch of AE 2026: no application window for ~6s, two untitled
    // #32770 popups at 3-5s, AE_CApplication_26.3 up at 7s.
    public static string FindDialog(int processId, IntPtr main) {
        target = processId;
        appWindow = IntPtr.Zero;
        EnumWindows(new EnumProc(OnFindApp), IntPtr.Zero);
        if (appWindow == IntPtr.Zero && main != IntPtr.Zero &&
            IsWindowVisible(main) && ClassOf(main) != "#32770") {
            // An AE build whose window class we do not recognise: fall
            // back to what the caller was told, as long as it is not
            // itself a popup.
            appWindow = main;
        }
        if (appWindow != IntPtr.Zero && IsWindowEnabled(appWindow)) {
            return "";
        }
        found = new StringBuilder();
        popups = 0;
        if (appWindow == IntPtr.Zero) {
            found.Append("  (After Effects has not opened its main " +
                         "window yet)" + NL);
        }
        EnumWindows(new EnumProc(OnTop), IntPtr.Zero);
        if (popups == 0 && appWindow != IntPtr.Zero) {
            found.Append("  (main window is disabled but no popup text " +
                         "could be read)" + NL);
        }
        return found.ToString();
    }
    // Built from character codes, not an escape: this C# lives inside a
    // PowerShell here-string inside a repo full of tooling that rewrites
    // these files, and a backslash escape only has to lose one backslash
    // to become a newline in a string constant -- which does not fail at
    // run time, it fails to COMPILE, and the probe then degrades to the
    // silent timeout it exists to prevent.
    private static string NL = ((char)13).ToString() + ((char)10).ToString();
    private static string ClassOf(IntPtr h) {
        StringBuilder cn = new StringBuilder(128);
        GetClassNameW(h, cn, 128);
        return cn.ToString();
    }
    private static bool OnFindApp(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        if (ClassOf(h).StartsWith("AE_CApplication")) {
            appWindow = h;
            return false;
        }
        return true;
    }
    private static bool OnTop(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (h == appWindow) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        popups++;
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        found.Append("  [" + ClassOf(h) + "] " + t.ToString().Trim() + NL);
        EnumChildWindows(h, new EnumProc(OnChild), IntPtr.Zero);
        return true;
    }
    private static bool OnChild(IntPtr h, IntPtr lp) {
        StringBuilder t = new StringBuilder(1024);
        GetWindowTextW(h, t, 1024);
        string s = t.ToString().Trim();
        if (s.Length > 0) { found.Append("    " + s + NL); }
        return true;
    }
}
'@

# The probe must never fail SILENTLY. A diagnostic that degrades into
# "no dialog found" is indistinguishable from a healthy run, which is
# precisely the class of bug it exists to expose -- so every failure
# here is announced rather than swallowed.
$canProbe = $true
if (-not ([System.Management.Automation.PSTypeName]'AellWin').Type) {
  try {
    Add-Type -TypeDefinition $win32
  } catch {
    $canProbe = $false
    Write-Host ('WARNING: could not compile the dialog probe (' +
      $_.Exception.Message + '). A modal-blocked AE will time out as ' +
      'exit 3 instead of reporting exit 4.')
  }
}

$probeWarned = $false
function Get-BlockingDialog {
  if (-not $canProbe) { return '' }
  $procs = @()
  try {
    $procs = @(Get-Process AfterFX -ErrorAction SilentlyContinue)
  } catch {
    return ''
  }
  foreach ($proc in $procs) {
    try { $proc.Refresh() } catch { }
    # No MainWindowHandle does NOT mean nothing to see: that is exactly
    # what a still-starting -- or startup-blocked -- AE looks like.
    $handle = [IntPtr]::Zero
    try { $handle = $proc.MainWindowHandle } catch { continue }
    try {
      $text = [AellWin]::FindDialog($proc.Id, $handle)
      if ($text) { return $text }
    } catch {
      if (-not $script:probeWarned) {
        $script:probeWarned = $true
        Write-Host ('WARNING: dialog probe threw (' +
          $_.Exception.Message + '); cannot detect a modal-blocked AE.')
      }
    }
  }
  return ''
}

# AE disables its main window for as long as the -r script runs, so the
# probe fires on every healthy run too -- what it finds has to be read,
# not just counted. Get-AellDialogVerdict separates AE's own progress
# window from a popup nobody asked for, and a verdict only stops the run
# once it has survived several consecutive polls: a modal waits forever,
# a teardown flicker does not.
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$state = New-AellWaitState
while (-not (Test-Path $out) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $state = Update-AellWaitState -State $state `
    -ProbeText (Get-BlockingDialog) -ScriptName $wrapperName
  if ($state.StopNow) { break }
}
$blocking = $state.BlockingText
$sawRunning = $state.SawProgress

if ($blocking -and -not (Test-Path $out)) {
  Write-Host '----'
  Write-Host 'After Effects is BLOCKED on a modal dialog:'
  Write-Host $blocking
  Write-Host '----'
  Write-Host 'This is not the scripting-file-access preference. Until the'
  Write-Host 'dialog is dismissed AE ignores every -r script while still'
  Write-Host 'reporting as healthy. Dismiss it, fix what it names, re-run.'
  Write-Host 'For ES3 reserved words specifically (the usual cause), run'
  Write-Host 'node tests/test-es3-syntax.js -- it catches them without AE.'
  if ($state.LastVerdict -eq 'unreadable') {
    # AE draws its own dialogs, so Win32 can read nothing out of them.
    # Measured on this machine: a 381x237 popup with no readable text is
    # AE asking "Save changes to Untitled Project.aep?" -- raised when
    # something asks a dirty AE to close, which is how every self-test
    # run ends (the suite leaves scratch comps behind, so the project is
    # always dirty). It survives into the NEXT run and blocks it.
    Write-Host ''
    Write-Host 'The popup above has no readable text, which on this'
    Write-Host 'machine is usually AE asking to save changes to the'
    Write-Host 'scratch project a previous run left behind. Answering it'
    Write-Host 'is the only way through -- Cancel is safe, it just calls'
    Write-Host 'off the quit -- and nothing can be scripted around it,'
    Write-Host 'because no -r script runs while it is up.'
  }
  exit 4
}

if (-not (Test-Path $out)) {
  if ($sawRunning) {
    Write-Host ("No results after " + $TimeoutSec + "s, but AE was still " +
      "executing the script (its progress window was up). The suite is " +
      "running and just did not finish -- re-run with a larger " +
      "-TimeoutSec rather than hunting for a dialog.")
  } elseif ($state.SawStartup) {
    Write-Host ("No results after " + $TimeoutSec + "s: After Effects " +
      "never opened its main window, with a popup in front of it the " +
      "whole time. That is a dialog blocking STARTUP -- after AE is " +
      "killed, or crashes, it reopens with a recovery prompt, and " +
      "until that is dismissed AE never gets far enough to run a -r " +
      "script. Nothing to do with the scripting-file-access " +
      "preference: dismiss it and re-run.")
  } else {
    Write-Host ("No results after " + $TimeoutSec + "s, and no blocking " +
      "dialog found. Checks: is AE running/launching? Is 'Allow Scripts " +
      "to Write Files and Access Network' enabled in Preferences > " +
      "Scripting & Expressions?")
  }
  exit 3
}

$res = Get-Content $out -Raw | ConvertFrom-Json
Write-Host "----"
Write-Host $res.text
Write-Host "----"
if ($res.total -gt 0 -and $res.passed -eq $res.total) {
  Write-Host "SELF-TEST PASSED"
  exit 0
}
Write-Host "SELF-TEST FAILED"
exit 1
