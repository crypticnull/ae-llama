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
$wrapperTemplate.Replace("__REPO__", $repoFs).Replace("__OUT__", $outFs) |
  Set-Content -Path $wrapper -Encoding ASCII

Write-Host ("Running self-test via " + $AfterFXPath)
& $AfterFXPath -r $wrapper | Out-Null

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
    private static IntPtr mainWindow;

    // A DISABLED main window is the authoritative signal that AE is stuck
    // behind something modal -- true whatever class the popup happens to
    // be. Keying off the dialog class alone would miss AE's own
    // DroverLord-classed windows, so the class is used only to decide
    // which popups are worth reading text from.
    public static string FindDialog(int processId, IntPtr main) {
        if (main == IntPtr.Zero) { return ""; }
        if (IsWindowEnabled(main)) { return ""; }
        found = new StringBuilder();
        target = processId;
        mainWindow = main;
        EnumWindows(new EnumProc(OnTop), IntPtr.Zero);
        if (found.Length == 0) {
            found.Append("  (main window is disabled but no popup text " +
                         "could be read)\r\n");
        }
        return found.ToString();
    }
    private static bool OnTop(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (h == mainWindow) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        StringBuilder cn = new StringBuilder(64);
        GetClassNameW(h, cn, 64);
        string cls = cn.ToString();
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        found.Append("  [" + cls + "] " + t.ToString().Trim() + "\r\n");
        EnumChildWindows(h, new EnumProc(OnChild), IntPtr.Zero);
        return true;
    }
    private static bool OnChild(IntPtr h, IntPtr lp) {
        StringBuilder t = new StringBuilder(1024);
        GetWindowTextW(h, t, 1024);
        string s = t.ToString().Trim();
        if (s.Length > 0) { found.Append("    " + s + "\r\n"); }
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
    $handle = [IntPtr]::Zero
    try { $handle = $proc.MainWindowHandle } catch { continue }
    if ($handle -eq [IntPtr]::Zero) { continue }
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

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$blocking = ''
while (-not (Test-Path $out) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $blocking = Get-BlockingDialog
  if ($blocking) { break }
}

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
  exit 4
}

if (-not (Test-Path $out)) {
  Write-Host ("No results after " + $TimeoutSec + "s, and no blocking " +
    "dialog found. Checks: is AE running/launching? Is 'Allow Scripts " +
    "to Write Files and Access Network' enabled in Preferences > " +
    "Scripting & Expressions?")
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
