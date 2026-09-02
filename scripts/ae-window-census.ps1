# ae-window-census.ps1 - photograph EVERY window After Effects owns.
#
# The harness's own probe (run-ae-selftest.ps1) lists only what it needs
# to decide "is AE stuck": visible top-level popups, and it reads text
# out of #32770 and DroverLord shells alone. That is the right amount of
# looking for an unattended gate and the wrong amount for a diagnosis --
# on 2026-08-30 a run was stopped by a "DroverLord - Window Class" popup
# and everything the harness printed about it was a different window.
#
# This is the diagnostic half: every top-level window of the AfterFX
# process (optionally the hidden ones too), with class, title, styles,
# owner, rect, and the whole descendant tree read BOTH ways -- the
# GetWindowTextW that returns empty across a process boundary and the
# WM_GETTEXT that does not.
#
# Modes:
#   (default)          one census to stdout
#   -Seconds <n>       watch for n seconds, logging every CHANGE
#   -Out <path>        write the watch log to a file as well
#   -IncludeHidden     list invisible top-level windows too. A tooltip
#                      or a dialog AE keeps cached lives here between
#                      appearances, which is how a window that is only
#                      ever on screen for 200 ms can still be identified.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

param(
  [int]$Seconds = 0,
  [int]$IntervalMs = 250,
  [string]$Out = "",
  [switch]$IncludeHidden,
  [int]$AeProcessId = 0,
  # Which app to photograph. Defaults to After Effects, which is what
  # this was written for; scripts\ppro-door-probe.ps1 -Census passes
  # "Adobe Premiere*" so a Premiere door that hangs on a dialog can be
  # diagnosed the same way. The dialog TRIAGE (lib\ae-dialog-triage.ps1)
  # is still AE-specific - its window titles were measured in AE - so a
  # Premiere census is a diagnostic, not a verdict.
  [string]$ProcessName = "AfterFX*"
)

$ErrorActionPreference = "Stop"

$census = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AellCensus {
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out UIntPtr res);
    public struct RECT { public int Left, Top, Right, Bottom; }

    private static StringBuilder sb;
    private static int target;
    private static bool wantHidden;
    private static bool deep;
    private static bool shallow;
    private static bool noApp;
    private static IntPtr topOf;
    private static string NL = ((char)13).ToString() + ((char)10).ToString();

    private static string ClassOf(IntPtr h) {
        StringBuilder cn = new StringBuilder(256);
        GetClassNameW(h, cn, 256);
        return cn.ToString();
    }
    private static string TitleOf(IntPtr h) {
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        return t.ToString().Trim();
    }
    // The read that works across a process boundary. Recorded as
    // <no answer> rather than dropped, so a control that timed out
    // cannot pass for a control with nothing to say.
    private static string AskText(IntPtr h) {
        StringBuilder t = new StringBuilder(1024);
        UIntPtr res;
        IntPtr ok = SendMessageTimeoutW(h, 0x000D, (IntPtr)1024, t,
                                        0x0002 | 0x0020, 300, out res);
        if (ok == IntPtr.Zero) { return "<no answer>"; }
        return t.ToString().Trim();
    }
    private static int DepthOf(IntPtr h) {
        int d = 0;
        IntPtr p = GetParent(h);
        while (p != IntPtr.Zero && p != topOf && d < 12) {
            d++;
            p = GetParent(p);
        }
        return d + 1;
    }

    // topsOnly / skipApp exist for the WATCH loop. Walking the whole
    // application window and asking every descendant for its text is
    // ~60 cross-process SendMessages, and the watch runs BESIDE a real
    // harness run -- against an After Effects that is executing a
    // script and whose UI thread is exactly the thing being measured.
    // So the poll that decides "did anything change" is cheap and
    // top-level only, and the expensive read happens once, on the
    // sample where something appeared.
    public static string Census(int processId, bool includeHidden,
                                bool readText, bool topsOnly, bool skipApp) {
        target = processId;
        wantHidden = includeHidden;
        deep = readText;
        shallow = topsOnly;
        noApp = skipApp;
        sb = new StringBuilder();
        EnumWindows(new EnumProc(OnTop), IntPtr.Zero);
        return sb.ToString();
    }

    private static bool OnTop(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        bool vis = IsWindowVisible(h);
        if (!vis && !wantHidden) { return true; }
        if (noApp && ClassOf(h).StartsWith("AE_CApplication")) { return true; }
        RECT r;
        GetWindowRect(h, out r);
        string fg = (GetForegroundWindow() == h) ? " FOREGROUND" : "";
        sb.Append("TOP hwnd=" + h.ToInt64().ToString("X") +
                  " cls=[" + ClassOf(h) + "]" +
                  " vis=" + (vis ? "1" : "0") +
                  " en=" + (IsWindowEnabled(h) ? "1" : "0") +
                  " style=" + ((uint)GetWindowLong(h, -16)).ToString("X8") +
                  " ex=" + ((uint)GetWindowLong(h, -20)).ToString("X8") +
                  " owner=" + GetWindow(h, 4).ToInt64().ToString("X") +
                  " rect=" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom +
                  fg +
                  " title='" + TitleOf(h) + "'" + NL);
        if (shallow) { return true; }
        topOf = h;
        EnumChildWindows(h, new EnumProc(OnChild), IntPtr.Zero);
        return true;
    }

    private static bool OnChild(IntPtr h, IntPtr lp) {
        string pad = new string(' ', 2 * DepthOf(h));
        string line = pad + "[" + ClassOf(h) + "]" +
                      " vis=" + (IsWindowVisible(h) ? "1" : "0") +
                      " gwt='" + TitleOf(h) + "'";
        if (deep) { line = line + " wm='" + AskText(h) + "'"; }
        sb.Append(line + NL);
        return true;
    }
}
'@

if (-not ("AellCensus" -as [type])) { Add-Type -TypeDefinition $census -Language CSharp }

function Get-AellCensusPids {
  param([int]$Explicit = 0)
  if ($Explicit -gt 0) { return @($Explicit) }
  $ids = @()
  foreach ($p in @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)) {
    $ids += $p.Id
  }
  return $ids
}

function Get-AellCensus {
  param(
    [switch]$Hidden,
    [switch]$ReadText,
    [switch]$TopsOnly,
    [switch]$SkipApp,
    [int]$Explicit = 0
  )
  $out = ""
  foreach ($id in (Get-AellCensusPids -Explicit $Explicit)) {
    $out = $out + "== pid " + $id + " ==" + [char]13 + [char]10
    $out = $out + [AellCensus]::Census($id, [bool]$Hidden, [bool]$ReadText,
                                       [bool]$TopsOnly, [bool]$SkipApp)
  }
  return $out
}

# The change KEY deliberately drops the rect and the hwnd: a window that
# moves or is recreated with the same class, title and visibility is the
# same window as far as "what is on screen" is concerned, and logging
# every mouse-driven repaint would bury the one appearance that matters.
function Get-AellCensusKey {
  param([string]$Text = "")
  $keep = @()
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match '^TOP ') {
      $k = $line -replace ' hwnd=[0-9A-F]+', ''
      $k = $k -replace ' owner=[0-9A-F]+', ''
      $k = $k -replace ' rect=[-0-9,]+', ''
      $k = $k -replace ' FOREGROUND', ''
      $keep += $k
    }
  }
  return ($keep -join "|")
}

if ($Seconds -le 0) {
  Write-Output (Get-AellCensus -Hidden:$IncludeHidden -ReadText -Explicit $AeProcessId)
  exit 0
}
if (-not $IncludeHidden) {
  # A window that is only ever on screen for one poll is still in the
  # list the rest of the time, hidden. Watching without it is watching
  # for a coincidence.
  Write-Output "note: -IncludeHidden is what makes a transient window identifiable"
}

$log = @()
$deadline = (Get-Date).AddSeconds($Seconds)
$lastKey = "<none>"
$samples = 0
Write-Output ("Watching " + $ProcessName + " windows for " + $Seconds + "s every " + $IntervalMs + "ms")
while ((Get-Date) -lt $deadline) {
  $tops = Get-AellCensus -Hidden:$IncludeHidden -TopsOnly -Explicit $AeProcessId
  $samples++
  $key = Get-AellCensusKey -Text $tops
  if ($key -ne $lastKey) {
    $stamp = (Get-Date).ToString("HH:mm:ss.fff")
    # The deep read skips the application window's own tree: the change
    # being investigated is always something BESIDE it, and reading a
    # busy AE's whole panel hierarchy is what would perturb the run.
    $deep = Get-AellCensus -Hidden:$IncludeHidden -ReadText -SkipApp -Explicit $AeProcessId
    $entry = "---- " + $stamp + " (sample " + $samples + ") ----" + [char]13 + [char]10 +
             $tops + "-- popups, read --" + [char]13 + [char]10 + $deep
    $log += $entry
    Write-Output $entry
    $lastKey = $key
  }
  Start-Sleep -Milliseconds $IntervalMs
}
Write-Output ("Done: " + $samples + " samples, " + $log.Count + " distinct states")
if ($Out) {
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  ($log -join ([char]13 + [char]10)) | Out-File -FilePath $Out -Encoding ascii
  Write-Output ("Wrote " + $Out)
}
