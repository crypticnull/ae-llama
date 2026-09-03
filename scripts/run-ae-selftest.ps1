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
  [int]$TimeoutSec = 240,
  # Leave a pre-existing wordless dialog alone instead of answering it
  # (see Clear-AellStaleDialog below). For a human who wants to look at
  # whatever AE is showing before anything touches it.
  [switch]$NoDismissStale
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
    [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out UIntPtr res);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] private static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    public struct RECT { public int Left, Top, Right, Bottom; }

    private static StringBuilder found;
    private static int target;
    private static IntPtr appWindow;
    private static IntPtr progressWindow;
    private static int popups;
    private static int closed;
    private static bool hasWords;
    private static StringBuilder harvest;
    private static int moved;
    private static int screenL, screenT, screenR, screenB;

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
        // Which window is AE's "Executing Script ..." progress window?
        // Found in a pass of its own because EnumWindows walks the
        // Z-ORDER, top first: anything the running script raises sits
        // IN FRONT of the progress window and is therefore enumerated
        // BEFORE it, so a single pass could never have the handle in
        // hand at the moment it needs it.
        progressWindow = IntPtr.Zero;
        EnumWindows(new EnumProc(OnFindProgress), IntPtr.Zero);
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
    // AE's own script-progress window, by the title it has always been
    // recognised by everywhere else in this harness. If AE ever stops
    // calling it that, this simply finds nothing and every window is
    // judged exactly as it was before -- the annotation below is added
    // evidence, never a precondition.
    private static bool OnFindProgress(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        if (ClassOf(h) != "#32770") { return true; }
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        if (t.ToString().Trim().StartsWith("Executing Script")) {
            progressWindow = h;
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
        // Is this window even ALLOWED to be the thing that disabled AE's
        // main window? Two extended styles answer that, and both were
        // measured against real After Effects on 2026-08-30:
        //
        //   WS_EX_NOACTIVATE (0x08000000) - the window can never become
        //     the active window. It cannot hold the keyboard focus, so
        //     it cannot be a dialog waiting for an answer. Every idle AE
        //     on this machine has one: a top-level, wordless, zero-sized
        //     "DroverLord - Window Class" popup host parked at 0,0,0,0
        //     that AE re-uses for whatever floats.
        //   WS_EX_TOOLWINDOW (0x00000080) - carried by BOTH pieces of
        //     Windows chrome that cost the 2026-08-30 pass a run
        //     (tooltips_class32 ex=00080088, SysShadow ex=000800A8).
        //
        // And the two real AE modals measured the same night carry
        // NEITHER: a Script Alert and the save-changes prompt are both
        // #32770 ex=00010101, owned by the main window, activatable.
        // So this is the property that made the old two-class list safe,
        // stated as the property instead of as two names -- the names
        // are kept below as a rail, because a proven-in-the-field filter
        // is not deleted on the strength of a better theory.
        //
        // Such a window is LISTED, with its flags, and deliberately not
        // COUNTED: the popup counter is what decides whether the probe
        // falls through to "main window is disabled but no popup text
        // could be read", and a run blocked by something only chrome is
        // standing next to must still reach that honest answer.
        string cls = ClassOf(h);
        uint ex = (uint)GetWindowLong(h, -20);
        bool nonModal = (ex & 0x08000000) != 0 || (ex & 0x00000080) != 0 ||
                        cls == "SysShadow" || cls == "tooltips_class32";
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        if (nonModal) {
            found.Append("  [" + cls + "] {nonmodal ex=" + ex.ToString("X8") +
                         " owner=" + GetWindow(h, 4).ToInt64().ToString("X") +
                         "} " + t.ToString().Trim() + NL);
            return true;
        }
        // WHO OWNS IT. A dialog raised by After Effects while it works
        // on OUR script is owned by the script-progress window; a
        // question meant for a human is owned by the MAIN window. Both
        // halves measured on AE 2026, 2026-08-30, on this machine:
        //
        //   Analyzing Audio...  #32770 ex=00090121 owner=<progress hwnd>
        //   Script Alert        #32770 ex=00010101 owner=<main hwnd>
        //   Auto-Save Project   #32770 ex=00010101 owner=<main hwnd>
        //   Executing Script    #32770 ex=00010101 owner=<main hwnd>
        //
        // The Analyzing Audio one is the reason this exists: the suite's
        // audio_to_keyframes step raises it for ~7.5s of every run, its
        // window TITLE is empty (the name lives in an `Edit` four levels
        // down, which only WM_GETTEXT can read), and a wordless popup is
        // `unreadable` -- eight of those in a row is exit 4 on a suite
        // that is passing. So every run has spent a fifth of itself
        // looking like it might be stuck on After Effects doing what the
        // suite asked it to do.
        //
        // ANNOTATED, not hidden, and still COUNTED and read for its
        // children: this is a real dialog, unlike the chrome above, and
        // the verdict layer only lets the annotation speak for a window
        // that has nothing to say. One that says something is judged on
        // its words, which is what keeps a hypothetical script-owned
        // QUESTION blocking.
        if (progressWindow != IntPtr.Zero && h != progressWindow &&
            GetWindow(h, 4) == progressWindow) {
            popups++;
            found.Append("  [" + cls + "] {scriptowner ex=" +
                         ex.ToString("X8") + " owner=" +
                         progressWindow.ToInt64().ToString("X") + "} " +
                         t.ToString().Trim() + NL);
            EnumChildWindows(h, new EnumProc(OnChild), IntPtr.Zero);
            return true;
        }
        popups++;
        found.Append("  [" + cls + "] " + t.ToString().Trim() + NL);
        EnumChildWindows(h, new EnumProc(OnChild), IntPtr.Zero);
        return true;
    }
    // Answer a WORDLESS dialog. WHEN this may be called at all is
    // Get-AellStaleDialogPlan's decision, not this method's -- but the
    // safety rail is repeated here in code, because a Win32 call that
    // closes windows must not depend on its caller being careful: only a
    // top-level #32770 of this process, with no title of its own and no
    // child carrying readable text (AE's containers report their class
    // as their text, hence the OS_ prefix check), is ever touched.
    //
    // WM_CLOSE on AE's "Save changes to ...?" prompt is Cancel: it calls
    // off the quit and changes nothing else. Posted rather than sent, so
    // a dialog whose thread is wedged cannot wedge the harness too.
    public static int CloseWordlessDialogs(int processId) {
        target = processId;
        closed = 0;
        EnumWindows(new EnumProc(OnClose), IntPtr.Zero);
        return closed;
    }
    private static bool OnClose(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        if (ClassOf(h) != "#32770") { return true; }
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        if (t.ToString().Trim().Length > 0) { return true; }
        hasWords = false;
        EnumChildWindows(h, new EnumProc(OnWordCheck), IntPtr.Zero);
        if (hasWords) { return true; }
        PostMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
        closed++;
        return true;
    }
    private static bool OnWordCheck(IntPtr h, IntPtr lp) {
        StringBuilder t = new StringBuilder(1024);
        GetWindowTextW(h, t, 1024);
        string s = t.ToString().Trim();
        if (s.Length > 0 && !s.StartsWith("OS_")) { hasWords = true; return false; }
        return true;
    }
    // Answer a KNOWN-SAFE dialog by clicking a named button.
    //
    // WM_CLOSE (CloseWordlessDialogs above) is CANCEL on the save-changes
    // prompt: the window goes away, the project stays dirty, and the next
    // quit asks again. That is what the owner hit - After Effects parked
    // on "Save changes to Untitled Project.aep before closing?" while an
    // unattended pass waited on it. A forced close then brings up the
    // crash-recovery prompt on the NEXT launch, so both need answering.
    //
    // Deliberately table-driven from PowerShell rather than hardcoded
    // here: the rules are readable where they are decided, and this
    // method cannot click anything a caller did not name. It clicks only
    // when EVERY fragment in mustContain appears in the dialog's own
    // text, and only a button whose own label is in buttonLabels.
    //
    // Returns the label it clicked, or "" if it clicked nothing.
    public static string AnswerDialog(int processId, string[] mustContain,
                                      string[] buttonLabels) {
        target = processId;
        wantText = mustContain;
        wantButtons = buttonLabels;
        clickedText = "";
        EnumWindows(new EnumProc(OnKnownDialog), IntPtr.Zero);
        return clickedText;
    }
    private static string[] wantText = new string[0];
    private static string[] wantButtons = new string[0];
    private static string clickedText = "";

    private static bool OnKnownDialog(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        if (ClassOf(h) != "#32770") { return true; }

        // What does it SAY? GetWindowTextW is empty across processes, so
        // the sentence only comes back through WM_GETTEXT.
        dlgText = new StringBuilder();
        EnumChildWindows(h, new EnumProc(OnCollectText), IntPtr.Zero);
        string said = dlgText.ToString();
        for (int i = 0; i < wantText.Length; i++) {
            if (said.IndexOf(wantText[i], StringComparison.OrdinalIgnoreCase) < 0) {
                return true;
            }
        }

        wantedButton = IntPtr.Zero;
        wantedLabel = "";
        EnumChildWindows(h, new EnumProc(OnWantedButton), IntPtr.Zero);
        if (wantedButton == IntPtr.Zero) { return true; }

        // BM_CLICK, posted: a wedged dialog thread must not wedge this.
        PostMessageW(wantedButton, 0x00F5, IntPtr.Zero, IntPtr.Zero);
        clickedText = wantedLabel;
        return false;
    }

    private static StringBuilder dlgText = new StringBuilder();
    private static bool OnCollectText(IntPtr h, IntPtr lp) {
        dlgText.Append(ReadText(h)).Append(" ");
        return true;
    }

    private static IntPtr wantedButton = IntPtr.Zero;
    private static string wantedLabel = "";
    private static bool OnWantedButton(IntPtr h, IntPtr lp) {
        if (ClassOf(h) != "Button") { return true; }
        string t = ReadText(h).Trim();
        if (t.Length == 0) { return true; }
        for (int i = 0; i < wantButtons.Length; i++) {
            if (Flatten(t) == Flatten(wantButtons[i])) {
                wantedButton = h;
                wantedLabel = t;
                return false;
            }
        }
        return true;
    }

    // AE renders the apostrophe in "Don't Save" as U+2019, not ASCII, and
    // pads labels with spaces. Compare on letters only, so either
    // spelling matches and a localised build simply fails to match
    // rather than matching the WRONG button.
    private static string Flatten(string s) {
        StringBuilder o = new StringBuilder();
        foreach (char c in s) {
            if (char.IsLetterOrDigit(c)) { o.Append(char.ToLowerInvariant(c)); }
        }
        return o.ToString();
    }

    // Every dialog this process is showing, with its text and the exact
    // label of every button on it. This is how an UNKNOWN dialog stops
    // costing a guess: the first time one appears its real strings are
    // in the log, and a rule can be written from them.
    public static string DescribeDialogs(int processId) {
        target = processId;
        describe = new StringBuilder();
        EnumWindows(new EnumProc(OnDescribe), IntPtr.Zero);
        return describe.ToString();
    }
    private static StringBuilder describe = new StringBuilder();
    private static bool OnDescribe(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        if (ClassOf(h) != "#32770") { return true; }
        dlgText = new StringBuilder();
        EnumChildWindows(h, new EnumProc(OnCollectText), IntPtr.Zero);
        describe.Append("dialog: ").Append(dlgText.ToString().Trim()).Append(NL);
        buttonList = new StringBuilder();
        EnumChildWindows(h, new EnumProc(OnListButton), IntPtr.Zero);
        describe.Append("  buttons: ").Append(buttonList.ToString()).Append(NL);
        return true;
    }
    private static StringBuilder buttonList = new StringBuilder();
    private static bool OnListButton(IntPtr h, IntPtr lp) {
        if (ClassOf(h) != "Button") { return true; }
        string t = ReadText(h).Trim();
        if (t.Length > 0) { buttonList.Append("[").Append(t).Append("] "); }
        return true;
    }

    private static string ReadText(IntPtr h) {
        StringBuilder sb = new StringBuilder(1024);
        UIntPtr res;
        IntPtr ok = SendMessageTimeoutW(h, 0x000D, (IntPtr)1024, sb,
                                        0x0002, 400, out res);
        if (ok == IntPtr.Zero) { return ""; }
        return sb.ToString();
    }

    // --- reading a dialog, instead of guessing at it -----------------
    // GetWindowTextW returns EMPTY for a control owned by ANOTHER
    // process, which is why every AE dialog has always reached the
    // triage as "no readable text" and cost blind re-runs to identify.
    // WM_GETTEXT on the very same child returns the whole sentence
    // (measured 2026-08-28 on AE 2026, first try: the save-changes
    // prompt keeps its text in an `Edit` child whose GetWindowTextW is
    // empty). This is EVIDENCE only -- what the runner answers is
    // decided by Get-AellStaleDialogPlan exactly as before, because a
    // dialog we can suddenly read must not become one we refuse to
    // clear.
    //
    // SendMessageTimeout with ABORTIFHUNG, never SendMessage: this runs
    // unattended, and a dialog whose thread is wedged must not wedge the
    // harness with it. A control that does not answer is recorded as
    // <no answer> rather than skipped, so a failed read cannot pass for
    // a dialog with nothing to say.
    public static string HarvestDialogText(int processId) {
        target = processId;
        harvest = new StringBuilder();
        EnumWindows(new EnumProc(OnHarvestTop), IntPtr.Zero);
        return harvest.ToString();
    }
    private static bool OnHarvestTop(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        // #32770 is the standard dialog class, and it is what every AE
        // popup captured before 2026-08-30 turned out to be. It is NOT
        // all of them: on 2026-08-30 a run was stopped by a
        // "DroverLord - Window Class" popup -- Adobe's own toolkit shell
        // -- carrying the same three containers as the save prompt, and
        // because the harvester only read #32770 the evidence it printed
        // was AE's progress window standing innocently next to it. The
        // harness reported on the one window in the room that was not
        // the problem.
        //
        // Widened for READING only. CloseWordlessDialogs still posts to
        // #32770 alone: what may be ANSWERED unattended is a much
        // narrower question than what may be looked at, and a DroverLord
        // popup is one nobody has identified yet.
        string hcls = ClassOf(h);
        if (hcls != "#32770" && hcls.IndexOf("DroverLord") < 0) {
            return true;
        }
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        string title = t.ToString().Trim();
        if (title.Length > 0) { harvest.Append(title + NL); }
        EnumChildWindows(h, new EnumProc(OnHarvestChild), IntPtr.Zero);
        return true;
    }
    private static bool OnHarvestChild(IntPtr h, IntPtr lp) {
        StringBuilder sb = new StringBuilder(1024);
        UIntPtr res;
        // SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT, 400ms
        IntPtr ok = SendMessageTimeoutW(h, 0x000D, (IntPtr)1024, sb,
                                        0x0002 | 0x0020, 400, out res);
        if (ok == IntPtr.Zero) { harvest.Append("<no answer>" + NL); return true; }
        string s = sb.ToString().Trim();
        if (s.Length > 0) { harvest.Append(s + NL); }
        return true;
    }
    // Put a dialog where a screenshot will show ALL of it, and on top.
    //
    // AE draws its dialog frame OFFSET from the window rect Win32
    // reports -- measured 2026-08-28: rect 60,60 with the visible dialog
    // starting near 133,127. That cost two attempts. First a crop to the
    // rect, which captured the desktop behind the dialog. Then "move it
    // only if the rect leaves the screen", which left a dialog whose
    // RECT fitted and whose PICTURE ran off the bottom-right corner --
    // the error text was cut off mid-sentence in the evidence PNG.
    //
    // So every dialog is moved to the top-left, unconditionally, and
    // staggered so two of them do not stack. This only ever runs when
    // the harness is already taking evidence on a dialog it is about to
    // answer, and a picture that is missing the words is not evidence.
    public static int RaiseDialogs(int processId, int vx, int vy, int vw, int vh) {
        target = processId;
        screenL = vx; screenT = vy; screenR = vx + vw; screenB = vy + vh;
        moved = 0;
        EnumWindows(new EnumProc(OnRaise), IntPtr.Zero);
        return moved;
    }
    private static bool OnRaise(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        if (ClassOf(h) != "#32770") { return true; }
        RECT r;
        if (GetWindowRect(h, out r)) {
            MoveWindow(h, screenL + 20 + (moved * 60),
                       screenT + 20 + (moved * 40),
                       r.Right - r.Left, r.Bottom - r.Top, true);
            moved++;
        }
        BringWindowToTop(h);
        SetForegroundWindow(h);
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

# --- evidence, gathered before anything is answered -------------------
#
# Same popups the probe above already found, read a different way. The
# probe uses GetWindowText, which returns EMPTY for another process's
# controls, so an AE dialog reaches the triage wordless; WM_GETTEXT on
# the same controls returns the sentence. Kept apart from the verdict on
# purpose (see ae-dialog-triage.ps1): the answer below is gated on the
# `unreadable` verdict, and a dialog we can now READ must not become one
# the harness refuses to clear.
function Get-AellDialogHarvest {
  if (-not $canProbe) { return '' }
  $all = ''
  foreach ($proc in @(Get-Process AfterFX -ErrorAction SilentlyContinue)) {
    try { $all = $all + [AellWin]::HarvestDialogText($proc.Id) } catch { }
  }
  return $all
}

# A picture, for the dialogs words cannot describe. The WHOLE virtual
# screen, never the dialog's rect: AE draws its frame offset from the
# rect Win32 reports (measured 2026-08-28 -- rect 60,60, visible dialog
# near 133,127), so both rect crops captured the desktop behind it. The
# dialog is raised and given 1.2s to repaint first, also measured: a
# capture taken immediately after a move caught the window that had not
# redrawn yet.
#
# Best effort by construction. An unattended run must never fail because
# it could not take a screenshot.
function Save-AellDialogShot {
  if (-not $canProbe) { return '' }
  try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    foreach ($proc in @(Get-Process AfterFX -ErrorAction SilentlyContinue)) {
      try {
        [AellWin]::RaiseDialogs($proc.Id, $vs.X, $vs.Y, $vs.Width,
          $vs.Height) | Out-Null
      } catch { }
    }
    Start-Sleep -Milliseconds 1200
    $dir = Join-Path $RepoRoot 'logs\dialogs'
    if (-not (Test-Path $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $stamp = (Get-Date).ToString("yyyy-MM-dd'T'HH-mm-ss")
    $png = Join-Path $dir ($stamp + '.png')
    $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.X, $vs.Y, 0, 0,
      (New-Object System.Drawing.Size($vs.Width, $vs.Height)))
    $g.Dispose()
    $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return $png
  } catch {
    Write-Host ('  (no screenshot: ' + $_.Exception.Message + ')')
    return ''
  }
}

# Read the dialog, print what it says, and say so LOUDLY when it says
# something this harness does not know. The run proceeds either way --
# the change is evidence, not behaviour -- but 'UNRECOGNIZED DIALOG' in
# a pass log is what makes the morning review look at the picture.
function Write-AellDialogEvidence {
  param([string]$Context = '', [switch]$AlwaysShoot)
  $harvest = Get-AellDialogHarvest
  $class = Get-AellHarvestClass -Harvest $harvest
  $words = @(Get-AellHarvestWords -Harvest $harvest)
  if ($words.Count -gt 0) {
    Write-Host '  what it says (WM_GETTEXT):'
    foreach ($w in $words) { Write-Host ('    ' + $w) }
  } else {
    Write-Host '  it says nothing Win32 can read, even with WM_GETTEXT.'
  }
  # A dialog this harness fully understands does not need its picture
  # taken -- the save-changes prompt turns up on most runs and AE's
  # progress window is up for all of every run. Everything else does,
  # INCLUDING the wordless one, which is exactly the case a screenshot
  # exists for: known, and yet with nothing to say.
  #
  # -AlwaysShoot overrides all of that, and the run that is FAILING
  # passes it. What the harvest recognised is not the same question as
  # what stopped the run: the harvest reads dialog-shell windows, the
  # verdict judges every popup the probe can see, and on 2026-08-30
  # those two disagreed -- a benign-looking harvest beside a popup that
  # cost the run its night. A failing run gets its picture, always.
  $png = ''
  if ($AlwaysShoot -or -not $class.Known -or $class.Label -eq 'wordless') {
    $png = Save-AellDialogShot
    if ($png) { Write-Host ('  screenshot: ' + $png) }
  }
  if (-not $class.Known) {
    Write-Host ''
    Write-Host ('UNRECOGNIZED DIALOG ' + $Context)
    Write-Host ('  text: ' + $class.Unknown)
    if ($png) { Write-Host ('  picture: ' + $png) }
    Write-Host '  Not the save-changes prompt, and not the wordless popup'
    Write-Host '  the harness knows. It was handled the usual way so the'
    Write-Host '  run could proceed -- a human should read the above.'
  }
  return $png
}

# The dialog that costs an unattended pass its whole run is not one this
# run raised -- it is the save-changes prompt the PREVIOUS run left up.
# The suite always leaves AE dirty (scratch comps), so when the cold-run
# launcher exits and AE is asked to close, AE asks whether to save; that
# prompt then swallows every -r script the NEXT pass sends while AE still
# reports as healthy. Both ways out were filed for a human in
# WORKPLAN-LOG 2026-08-21 and neither was taken, so the loop kept paying
# one lost pass each time. This takes the first of them: answer it.
#
# Narrow by construction -- Get-AellStaleDialogPlan refuses unless AE is
# fully started, running nothing, and showing a popup with no words on
# it, and CloseWordlessDialogs re-checks that in Win32 before posting
# anything. A dialog a human should read has words, and words are exactly
# what stops this. Runs BEFORE the launch, so a dialog it sees cannot be
# ours; and it never runs on the wait loop's findings, where a wordless
# popup may still be our own progress window tearing down.
<#
  KNOWN-SAFE dialogs, and the button to click on each.

  Two of these cost the owner real time on 2026-09-02. WM_CLOSE below is
  CANCEL on the save-changes prompt: the window goes, the project stays
  dirty, and the next quit asks the same question, so an unattended pass
  can sit on it indefinitely. And once a forced close happens, the NEXT
  launch opens the crash-recovery prompt instead.

  Every rule is narrow on purpose:
   - the save prompt is answered ONLY when the dialog's own text says
     UNTITLED. An untitled project here is a scratch project the suite
     made; a NAMED project is someone's work and is never answered for.
   - the crash prompt's exact wording on AE 2026 has not been measured
     here, so its fragments and buttons are candidates, and an unmatched
     dialog gets DESCRIBED into the log (text plus every button label)
     rather than guessed at again. The first time one appears, its real
     strings are in the log and a rule can be written from them.
#>
$script:AellDialogRules = @(
  @{ Name    = 'save-changes on an untitled project'
     Contains = @('Save changes', 'Untitled')
     Buttons  = @("Don't Save", 'Dont Save', 'No') },
  @{ Name    = 'crash / auto-save recovery'
     Contains = @('recover')
     Buttons  = @("Don't Recover", 'Dont Recover', 'No', 'Cancel') },
  @{ Name    = 'unexpected quit notice'
     Contains = @('unexpectedly')
     Buttons  = @('OK', 'Close', 'Continue') }
)

# Try every rule against every AE process. Returns the number answered.
function Answer-AellKnownDialogs {
  $answered = 0
  foreach ($proc in @(Get-Process AfterFX -ErrorAction SilentlyContinue)) {
    foreach ($rule in $script:AellDialogRules) {
      try {
        $clicked = [AellWin]::AnswerDialog($proc.Id, $rule.Contains,
                                           $rule.Buttons)
      } catch { $clicked = '' }
      if ($clicked) {
        Write-Host ("  clicked [" + $clicked + "] on the " + $rule.Name +
                    " dialog")
        $answered++
        Start-Sleep -Milliseconds 600
      }
    }
  }
  return $answered
}

# Whatever is on screen that no rule matched, in full, so the next
# session can write a rule instead of another guess.
function Write-AellUnknownDialogs {
  foreach ($proc in @(Get-Process AfterFX -ErrorAction SilentlyContinue)) {
    $desc = ''
    try { $desc = [AellWin]::DescribeDialogs($proc.Id) } catch { }
    if ($desc -and $desc.Trim()) {
      Write-Host '  a dialog is up that no rule matched. Its exact text and'
      Write-Host '  buttons follow - add a rule to $AellDialogRules from these:'
      foreach ($line in ($desc -split "`r?`n")) {
        if ($line.Trim()) { Write-Host ("    " + $line.Trim()) }
      }
    }
  }
}

function Clear-AellStaleDialog {
  $announced = $false
  for ($round = 1; $round -le 2; $round++) {
    $plan = Get-AellStaleDialogPlan -ProbeText (Get-BlockingDialog) `
      -ScriptName $wrapperName
    if (-not $plan.Dismiss) {
      if ($announced) { Write-Host "  cleared." }
      return
    }
    if (-not $announced) {
      $announced = $true
      Write-Host ("A dialog was already blocking After Effects before " +
        "this run started (" + $plan.Reason + ").")
    }
    # READ it before answering it. The answer does not depend on what
    # comes back -- unattended must proceed, and a wordless popup was
    # always answered here -- but a run that closes a dialog nobody ever
    # read is a run that can lose a whole night's evidence in one
    # PostMessage.
    Write-AellDialogEvidence -Context "answered before the launch" |
      Out-Null
    # Deliberately says what it DOES, not what it assumes it is talking
    # to: the harvest above already named the dialog, and this line used
    # to announce "the save-changes prompt" over the top of an error
    # alert it had just read out loud.
    # A KNOWN dialog is answered properly first: clicking Don't Save
    # actually resolves the save prompt, where WM_CLOSE only cancels the
    # quit and leaves it to ask again on the next one.
    $named = Answer-AellKnownDialogs
    if ($named -gt 0) {
      Start-Sleep -Seconds 2
      continue
    }

    Write-Host ("No rule matched it. Falling back to WM_CLOSE, which on " +
      "the save-changes prompt is Cancel and only calls off the quit.")
    $n = 0
    foreach ($proc in @(Get-Process AfterFX -ErrorAction SilentlyContinue)) {
      try { $n = $n + [AellWin]::CloseWordlessDialogs($proc.Id) } catch { }
    }
    Write-Host ("  answered " + $n + " dialog(s)")
    Start-Sleep -Seconds 2
  }
  Write-AellUnknownDialogs
  Write-Host ("  it did not clear -- running anyway, and the wait loop " +
    "below will report it.")
}
if ($canProbe -and -not $NoDismissStale) { Clear-AellStaleDialog }

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

# AE disables its main window for as long as the -r script runs, so the
# probe fires on every healthy run too -- what it finds has to be read,
# not just counted. Get-AellDialogVerdict separates AE's own progress
# window from a popup nobody asked for, and a verdict only stops the run
# once it has survived several consecutive polls: a modal waits forever,
# a teardown flicker does not.
#
# A known-safe dialog is also answered DURING the wait, not only before
# the launch. Clear-AellStaleDialog above runs once, before AE starts,
# so it can only see what a PREVIOUS run left behind -- and the two
# dialogs that actually cost the owner time come up after that point:
# the crash-recovery prompt appears on the launch this run just made
# (AE was force-closed, so its next start offers to recover), and the
# save-changes prompt can be raised by the suite itself. Neither was
# answerable here, so a run that met one burned the whole -TimeoutSec
# and exited 3 with nothing done. That is the "just sitting there" the
# owner reported on 2026-09-02.
#
# Narrow by construction, in three ways, because this clicks buttons in
# a run that may be perfectly healthy:
#   - only when something has been up for two consecutive polls (~4s),
#     so a teardown flicker is never clicked;
#   - only on the verdicts that mean "AE is behind something", never on
#     `running` or `progress`, which are AE working on our script;
#   - only a rule whose every text fragment is in the dialog and whose
#     button label is on the dialog. AE's progress windows say
#     "Executing Script", auto-save says "Auto-Save Project": no rule
#     matches either, so the healthy path cannot be clicked at all.
# And capped, so a rule that somehow matches something regenerating
# cannot spin for the whole timeout.
$midRunAnswers = 0
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$state = New-AellWaitState
while (-not (Test-Path $out) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $state = Update-AellWaitState -State $state `
    -ProbeText (Get-BlockingDialog) -ScriptName $wrapperName

  if ($canProbe -and -not $NoDismissStale -and $midRunAnswers -lt 4 -and
      $state.Streak -ge 2 -and
      ($state.LastVerdict -eq 'startup' -or
       $state.LastVerdict -eq 'unreadable' -or
       $state.LastVerdict -eq 'blocked')) {
    $answered = Answer-AellKnownDialogs
    if ($answered -gt 0) {
      $midRunAnswers = $midRunAnswers + $answered
      # The time this dialog ate is not time the suite got to run in,
      # so give it back rather than failing a run that was only ever
      # waiting on a prompt. Once per answer, capped with the answers.
      $deadline = $deadline.AddSeconds(60)
      # And forget the streak: it was counted against a dialog that no
      # longer exists, and carrying it forward would trip StopNow on
      # the poll right after we cleared the thing. Only the streak --
      # SawProgress and WorkingText are the run's history, and the
      # timeout messages below are written from them.
      $state.Streak = 0
      $state.LastVerdict = ''
      $state.StopNow = $false
      $state.BlockingText = ''
      continue
    }
  }

  if ($state.StopNow) { break }
}
if ($midRunAnswers -gt 0) {
  Write-Host ("Answered " + $midRunAnswers + " dialog(s) while waiting; " +
    "the deadline was extended by " + (60 * $midRunAnswers) + "s to " +
    "cover the time they held AE up.")
}
$blocking = $state.BlockingText
$sawRunning = $state.SawProgress
# What AE last said it was DOING, if it was one of its own named
# progress windows (saving, opening, exporting a template). Measured
# 2026-08-30: an export_mogrt puts five of these up in five seconds, and
# with `running` outranking `progress` a run wedged inside one would
# otherwise time out saying only "still executing the script".
$working = ($state.WorkingText -replace "`r?`n", " / ").Trim()

if ($blocking -and -not (Test-Path $out)) {
  Write-Host '----'
  Write-Host 'After Effects is BLOCKED on a modal dialog:'
  Write-Host $blocking
  Write-Host '----'
  # The probe text above is what GetWindowText could see, which for an AE
  # dialog is usually nothing. Ask the controls directly before telling a
  # human to go and look: the 2026-08-28 pass spent two blind re-runs on
  # a dialog that named its own cause in one WM_GETTEXT call.
  Write-AellDialogEvidence -Context 'blocking this run' -AlwaysShoot |
    Out-Null
  # The harvest says what it SAYS; this says what you could CLICK. A
  # rule in $AellDialogRules needs both, and without the button labels
  # the next attempt at one is a guess -- which is how the crash-prompt
  # rule below started life.
  Write-AellUnknownDialogs
  Write-Host '----'
  Write-Host 'This is not the scripting-file-access preference. Until the'
  Write-Host 'dialog is dismissed AE ignores every -r script while still'
  Write-Host 'reporting as healthy. Dismiss it, fix what it names, re-run.'
  Write-Host 'For ES3 reserved words specifically (the usual cause), run'
  Write-Host 'node tests/test-es3-syntax.js -- it catches them without AE.'
  if ($state.LastVerdict -eq 'unreadable') {
    # AE draws its own dialogs, so the window-text probe reads nothing
    # out of them (the harvest above asks the controls instead).
    # Measured on this machine: a 381x237 popup with no readable text is
    # AE asking "Save changes to Untitled Project.aep?" -- raised when
    # something asks a dirty AE to close, which is how every self-test
    # run ends (the suite leaves scratch comps behind, so the project is
    # always dirty). It survives into the NEXT run and blocks it.
    Write-Host ''
    Write-Host 'GetWindowText read nothing off that popup, which on'
    Write-Host 'this machine is usually AE asking to save changes to the'
    Write-Host 'scratch project a previous run left behind (the harvest'
    Write-Host 'above says so outright when a control answers). Answering it'
    Write-Host 'is the only way through -- Cancel is safe, it just calls'
    Write-Host 'off the quit -- and no -r script runs while it is up.'
    Write-Host 'A LEFTOVER one is answered automatically before the'
    Write-Host 'launch (pass -NoDismissStale to leave it alone), so'
    Write-Host 'seeing it here means it came up DURING this run, or came'
    Write-Host 'back after being answered. Dismiss it by hand and re-run.'
  }
  exit 4
}

if (-not (Test-Path $out)) {
  if ($sawRunning) {
    Write-Host ("No results after " + $TimeoutSec + "s, but AE was still " +
      "executing the script (its progress window was up). The suite is " +
      "running and just did not finish -- re-run with a larger " +
      "-TimeoutSec rather than hunting for a dialog.")
    if ($working) {
      Write-Host ("  The last thing After Effects named itself as doing: " +
        $working + ". If that window is still up, look at it: an export " +
        "raises a font question wearing the same kind of title, and " +
        "GetWindowText reads nothing out of another process's controls.")
    }
  } elseif ($state.SawStartup) {
    Write-Host ("No results after " + $TimeoutSec + "s: After Effects " +
      "never opened its main window, with a popup in front of it the " +
      "whole time. That is a dialog blocking STARTUP -- after AE is " +
      "killed, or crashes, it reopens with a recovery prompt, and " +
      "until that is dismissed AE never gets far enough to run a -r " +
      "script. Nothing to do with the scripting-file-access " +
      "preference: dismiss it and re-run.")
    if ($midRunAnswers -eq 0) {
      Write-Host ("  The recovery prompt is meant to be answered " +
        "automatically (see `$AellDialogRules). Nothing matched it, so " +
        "its real text and buttons follow -- write a rule from these " +
        "and it will never cost a run again.")
      Write-AellUnknownDialogs
    }
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
