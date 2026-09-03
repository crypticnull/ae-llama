# host-dialogs.ps1 - answer the modal dialogs an Adobe host puts up, in
# BOTH hosts, by clicking a named button on a dialog we can prove is ours.
#
# Why this is shared rather than living in the AE runner.
#
# The first version of this gated the save-changes prompt on the literal
# word "Untitled", on the reasoning that an untitled project is one the
# harness made and a NAMED one is somebody's work. The second half of
# that is right and is the rail this file keeps. The first half was
# wrong: "untitled" is not the same question as "ours", and the harness
# saves NAMED projects in both hosts.
#
# AE really does sit on
#
#     Save changes to "Untitled Project.aep" before closing?
#
# after a plain self-test run -- the suite never saves. But
# scripts/mogrt-verify-probe.jsx does app.project.save() into the repo's
# logs/ folder, because export_mogrt cannot run from a project that was
# never saved, and from then on AE's prompt names
# mogrt-probe-scratch.aep. The owner spotted that named file on
# 2026-09-03, against a rule that could only ever have matched
# "Untitled".
#
# Premiere was never untitled at all. run-ppro-probe.ps1 saves its
# scratch project with `saveAs` to a path it chose itself:
#
#     %APPDATA%\AE-Llama\probes\AELL_PROBE_SCRATCH.prproj
#
# so Premiere's prompt carries THAT name, and never the word Untitled. A
# rule that matched on "Untitled" could not answer the one dialog the
# Premiere probe actually raises. Stop-OurPremiere then did what it does
# with any prompt it cannot answer: waited out its 20 s grace and forced
# the process -- and a forced close is exactly what makes the NEXT launch
# open a crash-recovery prompt. One unanswerable dialog per pass, and the
# pass after it starts behind a second one.
#
# So the identity test is no longer a hardcoded word. It is a list of
# project names the CALLER declares it owns, and the caller is the script
# that created them, which is the only thing that can know. AE passes
# "Untitled Project" and "mogrt-probe-scratch"; the Premiere probe passes
# its own scratch base name.
#
# And a project on NEITHER list is no longer a hang. It is somebody's
# work, so its changes are never discarded -- but the last rule cancels
# that prompt, which unblocks the host and keeps every unsaved change.
# Discarding needs proof of ownership; cancelling needs none, because it
# cannot lose anything.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

# Separate class name from run-ae-selftest.ps1's AellWin on purpose: both
# may be loaded in one session, and Add-Type refuses a redefinition.
if (-not ('AellDlg' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class AellDlg {
    private delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out UIntPtr res);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr h, out RECT r);
    public struct RECT { public int Left, Top, Right, Bottom; }

    private static readonly string NL = Environment.NewLine;
    private static int target = 0;

    private static string ClassOf(IntPtr h) {
        StringBuilder c = new StringBuilder(256);
        GetClassNameW(h, c, 256);
        return c.ToString();
    }

    // GetWindowTextW returns EMPTY for a control owned by ANOTHER
    // process, which is why every Adobe dialog used to arrive at this
    // harness as "no readable text". WM_GETTEXT returns the whole
    // sentence. Timed out rather than sent outright, so a dialog whose
    // thread is wedged cannot wedge us.
    private static string ReadText(IntPtr h) {
        StringBuilder sb = new StringBuilder(1024);
        UIntPtr res;
        IntPtr ok = SendMessageTimeoutW(h, 0x000D, (IntPtr)1024, sb,
                                        0x0002, 400, out res);
        if (ok == IntPtr.Zero) { return ""; }
        return sb.ToString();
    }

    // Compare on letters and digits only. After Effects renders the
    // apostrophe in "Don't Save" as U+2019, not ASCII, and pads labels
    // with spaces, so an exact match fails on the one button that
    // matters. A localised build simply fails to match under this,
    // rather than matching the WRONG button, which is the behaviour we
    // want when in doubt.
    private static string Flatten(string s) {
        StringBuilder o = new StringBuilder();
        foreach (char c in s) {
            if (char.IsLetterOrDigit(c)) { o.Append(char.ToLowerInvariant(c)); }
        }
        return o.ToString();
    }

    private static string[] wantText = new string[0];
    private static string[] wantAny = new string[0];
    private static string[] wantButtons = new string[0];
    private static string clickedText = "";
    private static StringBuilder dlgText = new StringBuilder();
    private static IntPtr wantedButton = IntPtr.Zero;
    private static string wantedLabel = "";

    // Click a button on a dialog we can prove is the one we mean.
    //
    //   mustContain  every one of these must appear in the dialog's text
    //   mustContainAny  at least one of these must appear, when non-empty.
    //                   This is where the owned-project names go: the
    //                   dialog must name a project THIS harness created.
    //   buttonLabels  only a button whose own label is one of these is
    //                 ever clicked
    //
    // Returns the label it clicked, or "" if it clicked nothing.
    public static string AnswerDialog(int processId, string[] mustContain,
                                      string[] mustContainAny,
                                      string[] buttonLabels) {
        target = processId;
        wantText = mustContain == null ? new string[0] : mustContain;
        wantAny = mustContainAny == null ? new string[0] : mustContainAny;
        wantButtons = buttonLabels == null ? new string[0] : buttonLabels;
        clickedText = "";
        EnumWindows(new EnumProc(OnKnownDialog), IntPtr.Zero);
        return clickedText;
    }

    private static bool OnKnownDialog(IntPtr h, IntPtr lp) {
        uint wid;
        GetWindowThreadProcessId(h, out wid);
        if ((int)wid != target) { return true; }
        if (!IsWindowVisible(h)) { return true; }
        if (ClassOf(h) != "#32770") { return true; }

        dlgText = new StringBuilder();
        EnumChildWindows(h, new EnumProc(OnCollectText), IntPtr.Zero);
        string said = dlgText.ToString();

        for (int i = 0; i < wantText.Length; i++) {
            if (said.IndexOf(wantText[i], StringComparison.OrdinalIgnoreCase) < 0) {
                return true;
            }
        }
        if (wantAny.Length > 0) {
            bool hit = false;
            for (int i = 0; i < wantAny.Length; i++) {
                if (said.IndexOf(wantAny[i], StringComparison.OrdinalIgnoreCase) >= 0) {
                    hit = true;
                    break;
                }
            }
            if (!hit) { return true; }
        }

        wantedButton = IntPtr.Zero;
        wantedLabel = "";
        EnumChildWindows(h, new EnumProc(OnWantedButton), IntPtr.Zero);
        if (wantedButton == IntPtr.Zero) { return true; }

        ClickIt(wantedButton);
        clickedText = wantedLabel + " [" + wantedClass + "]";
        return false;
    }

    private static bool OnCollectText(IntPtr h, IntPtr lp) {
        dlgText.Append(ReadText(h)).Append(" ");
        return true;
    }

    // Match on the LABEL, not the window class.
    //
    // This required ClassOf(h) == "Button" and found nothing on AE 2026.
    // The measured note in scripts/lib/ae-dialog-triage.ps1 describes
    // the save prompt as three DroverLord containers plus one Edit
    // child -- nobody ever measured a Win32 Button on it, because only
    // its TEXT had ever been read. So the answering matched the dialog,
    // matched the sentence, then found nothing it was willing to press
    // and gave up without a word. The owner watched that happen on a
    // fresh run, twice.
    //
    // A child whose own text IS "Don't Save" is the Don't Save button
    // whatever class it reports. The rail is unchanged -- the label
    // still has to be one the rule named -- and the class is recorded
    // so the click can be delivered the way that control understands.
    private static bool OnWantedButton(IntPtr h, IntPtr lp) {
        string t = ReadText(h).Trim();
        if (t.Length == 0) { return true; }
        for (int i = 0; i < wantButtons.Length; i++) {
            if (Flatten(t) == Flatten(wantButtons[i])) {
                wantedButton = h;
                wantedLabel = t;
                wantedClass = ClassOf(h);
                return false;
            }
        }
        return true;
    }
    private static string wantedClass = "";

    // BM_CLICK is only understood by a real Button. A custom-drawn
    // control ignores it and needs the mouse messages a click actually
    // produces, aimed at its own centre in CLIENT coordinates. Both are
    // POSTED, so a wedged dialog thread cannot wedge us.
    private static void ClickIt(IntPtr h) {
        if (wantedClass == "Button") {
            PostMessageW(h, 0x00F5, IntPtr.Zero, IntPtr.Zero);  // BM_CLICK
            return;
        }
        RECT r;
        if (!GetClientRect(h, out r)) { return; }
        int x = (r.Right - r.Left) / 2;
        int y = (r.Bottom - r.Top) / 2;
        IntPtr pos = (IntPtr)((y << 16) | (x & 0xFFFF));
        PostMessageW(h, 0x0201, (IntPtr)1, pos);   // WM_LBUTTONDOWN
        PostMessageW(h, 0x0202, IntPtr.Zero, pos); // WM_LBUTTONUP
    }

    // Every dialog this process is showing, with its text and the exact
    // label of every button on it. This is how an UNKNOWN dialog stops
    // costing a guess: the first time one appears its real strings are
    // in the log, and a rule can be written from them instead of
    // invented.
    private static StringBuilder describe = new StringBuilder();
    private static StringBuilder buttonList = new StringBuilder();

    public static string DescribeDialogs(int processId) {
        target = processId;
        describe = new StringBuilder();
        EnumWindows(new EnumProc(OnDescribe), IntPtr.Zero);
        return describe.ToString();
    }

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
        describe.Append("  clickable children: ").Append(buttonList.ToString()).Append(NL);
        return true;
    }

    // EVERY child with text, and the class each one reports. Listing
    // only class-"Button" children is what hid the bug above: the dump
    // said "buttons:" and nothing followed, which read as "this dialog
    // has no buttons" rather than "I am only willing to look at one
    // kind of control".
    private static bool OnListButton(IntPtr h, IntPtr lp) {
        string t = ReadText(h).Trim();
        if (t.Length == 0) { return true; }
        if (t.StartsWith("OS_")) { return true; }
        buttonList.Append("[").Append(t).Append(" {")
                  .Append(ClassOf(h)).Append("}] ");
        return true;
    }
}
'@
}

<#
  The rules, built around the project names the caller says it owns.

  -OwnedProjects is the whole safety rail. The save-changes rule fires
  ONLY on a dialog that names one of them, so:
    * run-ae-selftest.ps1 passes 'Untitled Project'   (AE's own cold-launch
      project; the suite never saves, so this is always what it is)
    * run-ppro-probe.ps1 passes 'AELL_PROBE_SCRATCH'  (the scratch project
      that script saved itself, by that name, on purpose)
  A project on neither list is somebody's work, no rule matches it, and
  the caller is told what it says instead of having a button pressed on
  it.

  The other two rules carry no project name because they are not about a
  project: a crash-recovery prompt and an unexpected-quit notice are
  about the LAST session, and both appear before any project is open.

  HONESTY: only the save-changes rule is written from measured strings
  (harvested 2026-08-28 off AE 2026, and confirmed by the owner's own
  screenshot 2026-09-02). The recovery and unexpected-quit wordings on
  AE 2026 and Premiere 26.3.2 have NOT been measured here -- their
  fragments and button labels are candidates. That is what
  Write-AellUnknownDialogs exists for: anything unmatched gets its real
  text and every real button label into the log, and the next session
  writes an exact rule instead of a second guess.
#>
function Get-AellDialogRules {
  param([string[]]$OwnedProjects = @())

  return @(
    @{ Name     = 'save-changes on a project this harness created'
       Contains = @('Save changes')
       Any      = $OwnedProjects
       # DISCARDS unsaved work, so it may never run without an owned
       # name to match on. Flagged rather than inferred from the rule's
       # name: this is the one property that must not be got wrong.
       RequiresOwned = $true
       Buttons  = @("Don't Save", 'Dont Save', 'No') },
    @{ Name     = 'crash / auto-save recovery'
       Contains = @('recover')
       Any      = @()
       RequiresOwned = $false
       Buttons  = @("Don't Recover", 'Dont Recover', 'No', 'Cancel') },
    @{ Name     = 'unexpected quit notice'
       Contains = @('unexpectedly')
       Any      = @()
       RequiresOwned = $false
       Buttons  = @('OK', 'Close', 'Continue') },

    # LAST, and it must stay last: a save prompt naming a project that
    # is NOT ours. Cancel, never Don't Save.
    #
    # This is the case the owned-name list cannot cover by design -- the
    # AE suite runs in whatever project is open, so the prompt can name
    # the owner's work, and no list here can be allowed to answer for
    # that. Cancel calls off the quit and changes NOTHING: the project
    # keeps every unsaved change, and AE stops being modal, which is all
    # the harness ever needed. It costs a re-ask on the next quit, and
    # nothing in this harness quits AE.
    #
    # Ordered after the owned rule so a project we DO own still gets the
    # answer that resolves it permanently; this one only picks up what
    # that missed. Cancel is also what WM_CLOSE was doing, except this
    # presses the actual button instead of relying on the window manager
    # to map the message, and it says which project it declined to
    # discard.
    @{ Name     = 'save-changes on a project that is NOT ours (cancelled, not discarded)'
       Contains = @('Save changes')
       Any      = @()
       RequiresOwned = $false
       Buttons  = @('Cancel') }
  )
}

# Try every rule against every process with these names. Returns the
# number of dialogs answered, so a caller can tell "nothing was up" from
# "something was up and I could not answer it" -- the two outcomes that
# used to look identical and cost the owner a night.
function Answer-AellKnownDialogs {
  param(
    [string[]]$ProcessNames = @('AfterFX'),
    [string[]]$OwnedProjects = @()
  )

  $rules = Get-AellDialogRules -OwnedProjects $OwnedProjects
  $answered = 0
  foreach ($name in $ProcessNames) {
    foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      foreach ($rule in $rules) {
        # A rule that DISCARDS work, with an empty owned list, would
        # match any project at all -- the one thing this must never do.
        # Keyed on the rule's own RequiresOwned flag, not on its name:
        # the Cancel rule below is also a save-changes rule and MUST
        # still run with no owned names, because cancelling is what
        # protects a project we do not own.
        if ($rule.RequiresOwned -and @($rule.Any).Count -eq 0) { continue }
        try {
          $clicked = [AellDlg]::AnswerDialog($proc.Id, $rule.Contains,
                                             $rule.Any, $rule.Buttons)
        } catch { $clicked = '' }
        if ($clicked) {
          Write-Host ("  clicked [" + $clicked + "] on the " + $rule.Name +
                      " dialog")
          $answered++
          Start-Sleep -Milliseconds 600
        }
      }
    }
  }
  return $answered
}

# Whatever is on screen that no rule matched, in full, so the next
# session can write a rule from real strings instead of another guess.
function Write-AellUnknownDialogs {
  param([string[]]$ProcessNames = @('AfterFX'))

  foreach ($name in $ProcessNames) {
    foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      $desc = ''
      try { $desc = [AellDlg]::DescribeDialogs($proc.Id) } catch { }
      if ($desc -and $desc.Trim()) {
        Write-Host ('  a dialog is up on ' + $name + ' that no rule ' +
                    'matched. Its exact text and buttons follow - a rule')
        Write-Host '  can be written from these:'
        foreach ($line in ($desc -split "`r?`n")) {
          if ($line.Trim()) { Write-Host ("    " + $line.Trim()) }
        }
      }
    }
  }
}
