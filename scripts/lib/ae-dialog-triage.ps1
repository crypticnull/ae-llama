# ae-dialog-triage.ps1 - decide what After Effects' popup windows MEAN.
#
# The window probe in run-ae-selftest.ps1 lists every visible popup on the
# AfterFX process whenever AE's main window is DISABLED. A disabled main
# window is not proof that AE is stuck: for exactly as long as a -r script
# runs, AE puts up its own progress window ("Executing Script <file>...")
# and disables the main window behind it. Measured on a cold launch, the
# self-test suite spends its last ~2s of a ~24s run in that state -- and
# reading it as a modal reported a green 109/109 suite as "BLOCKED", exit
# 4, with the results file landing one second later.
#
# So the progress window is evidence of the OPPOSITE of stuck: the script
# is running. Only a popup we did not put there stops the run, and only
# after it has persisted, because a real modal never goes away while a
# transient teardown window does.
#
# Verdicts:
#   clear      - nothing on screen (or main window enabled); keep waiting
#   running    - only AE's own script-progress window; keep waiting
#   progress   - one of AE's OWN named progress windows, and not the
#                script one: AE is working, but nothing here proves it
#                is working on OUR script. Never blocks on sight, and
#                escalated only by lasting (see the title list below).
#   startup    - AE has not opened its application window yet and
#                something is up in front of it. A healthy cold launch
#                looks exactly like this for ~5s (measured: two untitled
#                popups at t=3-5s, application window at t=7s), so it can
#                never abort a run -- it only lets the timeout say which
#                kind of nothing happened.
#   unreadable - main window disabled behind something with no readable
#                text; ambiguous, so it needs a long persistence run
#   blocked    - a popup with text we did not put there
#
# Kept in its own file so tests/test-selftest-runner.js can feed it the
# probe strings captured from real AE without needing AE.

# After Effects' OWN progress windows. Each is a #32770 with a real
# TITLE and nothing inside it but a container, so it looks to the probe
# exactly like a dialog that named itself.
#
# Measured 2026-08-30 (WORKPLAN 5.9) by listing AE's windows every 150 ms
# while a real export_mogrt ran, twice, with the save split out into its
# own timestamped step so each window could be attributed:
#
#   Save Project                        app.project.save(), ~550 ms; any
#                                       tool that saves raises it
#   Open Project                        raised by the EXPORT - AE reopens
#                                       the project, which is why a
#                                       successful export invalidates the
#                                       held app.project reference
#   Creating Motion Graphics Template   the export
#   Verifying Adobe Fonts...            the export
#   Exporting Motion Graphics Template  the export
#
# Before this list existed every one of them read as `blocked`, and
# `blocked` gives up after 3 consecutive polls: five progress windows
# across a ~5 s export is three blocked samples in a row on a 2 s poll,
# which is exit 4 on a run that is working perfectly.
#
# Matched as a PREFIX, because AE appends to these: the script window
# carries the file name and the font one carries an ellipsis.
# Two more, measured 2026-08-30 by watching a real self-test run's
# windows every 250 ms for four consecutive runs
# (scripts/ae-window-census.ps1):
#
#   Auto-Save Project   AE's own timed auto-save, which fires DURING a
#                       run and disables the script-progress window
#                       behind it. Seen in every one of the four runs,
#                       up ~2.5 s each time. It has a real title, so
#                       until it was named here it read as `blocked` --
#                       and `blocked` gives up after 3 polls, which is
#                       6 s on a 2 s poll. It has not cost a run on this
#                       machine yet; on a heavier project, where saving
#                       takes longer, it is exactly the failure the five
#                       titles above were added for.
#   Analyzing Audio     raised by the suite's audio_to_keyframes step.
#                       Named here for the EVIDENCE layer only, and it
#                       is worth being precise about why: this dialog's
#                       window title is EMPTY and its name lives in an
#                       `Edit` child, so Get-AellDialogVerdict (which
#                       reads titles) cannot see it and still calls it
#                       `unreadable`. Get-AellHarvestClass (which asks
#                       with WM_GETTEXT) can, and without this line it
#                       headlines a healthy run UNRECOGNIZED DIALOG.
#                       The verdict half is a separate, open problem --
#                       see WORKPLAN item 1.
function Get-AellProgressTitles {
  return @(
    "Executing Script",
    "Save Project",
    "Open Project",
    "Auto-Save Project",
    "Analyzing Audio",
    "Creating Motion Graphics Template",
    "Exporting Motion Graphics Template",
    "Verifying Adobe Fonts"
  )
}

function Test-AellProgressWord {
  param([string]$Word = "", [string]$ScriptName = "")
  $w = $Word.Trim()
  if ($w.Length -eq 0) { return $false }
  if ($ScriptName -and $w.Contains($ScriptName)) { return $true }
  foreach ($p in (Get-AellProgressTitles)) {
    if ($w.StartsWith($p)) { return $true }
  }
  return $false
}

function Get-AellDialogVerdict {
  param(
    [string]$ProbeText = "",
    [string]$ScriptName = ""
  )

  $blockingLines = @()
  $workingLines = @()
  $sawProgress = $false
  $sawWorking = $false
  $sawUnreadable = $false
  $sawStartup = $false

  # Blocks: a header line ("  [class] title") owns the indented child
  # lines that follow it. Anything else (the probe's own
  # "main window is disabled but no popup text could be read" note) is a
  # block of its own.
  $blocks = @()
  $current = $null
  foreach ($raw in ($ProbeText -split "`r?`n")) {
    if ($raw.Trim().Length -eq 0) { continue }
    if ($raw -match '^\s{0,3}\[') {
      if ($current) { $blocks += ,$current }
      $current = @($raw)
    } elseif ($current -and $raw -match '^\s{4,}') {
      $current += $raw
    } else {
      if ($current) { $blocks += ,$current; $current = $null }
      $blocks += ,@($raw)
    }
  }
  if ($current) { $blocks += ,$current }

  foreach ($block in $blocks) {
    $joined = ($block -join " ")

    # A popup carrying no words -- empty title, children that report only
    # their container class - tells us nothing. AE shows one for a moment
    # as the progress window tears down, so it must not be mistaken for a
    # modal on sight; it is escalated only by lasting.
    if ($joined -match 'has not opened its main window') {
      $sawStartup = $true
      continue
    }
    if ($joined -match 'no popup text could be read') {
      $sawUnreadable = $true
      continue
    }
    $words = @()
    foreach ($line in $block) {
      $t = $line.Trim()
      $t = $t -replace '^\[[^\]]*\]', ''
      # The probe's non-modal annotation is a FACT ABOUT the window, not
      # something the window said. Stripped before the words are counted,
      # so an annotated popup with nothing to say still reaches the
      # wordless branch below -- and one that DOES say something is still
      # judged on what it says, which is the whole point of annotating
      # rather than hiding it.
      $t = $t -replace '\{nonmodal[^}]*\}', ''
      $t = $t.Trim()
      if ($t.Length -eq 0) { continue }
      if ($t -match '^OS_[A-Za-z0-9_]+$') { continue }
      $words += $t
    }
    if ($words.Count -eq 0) {
      # Not every wordless top-level window of the AfterFX process is a
      # window After Effects put there. Windows draws the drop SHADOW
      # under a dialog (SysShadow) and the TOOLTIP over a control
      # (tooltips_class32) as visible top-level windows owned by the
      # same process, and both carry no text at all -- so they arrive
      # here looking exactly like a dialog nobody can read.
      #
      # Measured 2026-08-30 on a cold launch driving a 26s script: at
      # t=28..31s the probe saw [tooltips_class32], [SysShadow] and a
      # perfectly healthy "[#32770] Executing Script sleep.jsx...". A
      # wordless block outranks a running script, so the verdict was
      # `unreadable` for three consecutive polls -- and eight of those
      # in a row is exit 4 on a suite that is running fine. That is what
      # cost the 2026-08-30 pass its first harness run; its evidence
      # screenshot shows the progress window at 17 seconds, which is
      # eight 2s polls plus the time to take the picture.
      #
      # Judged on CLASS, and only for a block with nothing to say: a
      # window of either class that somehow carries words is still read
      # for its words below, because the point is to ignore Windows'
      # chrome, not to grow a list of things the harness will not look at.
      if ($block[0] -match '^\s*\[(SysShadow|tooltips_class32)\]') {
        continue
      }
      # The same answer arrived at from the window's own declaration
      # instead of from its name. The probe marks a top-level window
      # that carries WS_EX_NOACTIVATE or WS_EX_TOOLWINDOW: the first
      # cannot become the active window, so it cannot be a dialog
      # waiting for an answer, and the second is what both pieces of
      # Windows chrome above turned out to be.
      #
      # Measured in real AE 2026 on 2026-08-30, all four in one sitting:
      #
      #   Script Alert          #32770  ex=00010101  owner=main window
      #   save-changes prompt   #32770  ex=00010101  owner=main window
      #   tooltips_class32              ex=00080088  TOOLWINDOW
      #   SysShadow                     ex=000800A8  TOOLWINDOW
      #   DroverLord popup host         ex=08000000  NOACTIVATE
      #
      # The two real modals carry neither flag and both disable the main
      # window; the DroverLord popup host is a wordless, zero-sized,
      # unowned top-level window that sits hidden in EVERY running After
      # Effects, waiting to be re-used -- exactly the shape of the
      # SysShadow bug, one class further on.
      #
      # This is a rule about what may BLOCK, never about what may be
      # ANSWERED: CloseWordlessDialogs still posts WM_CLOSE to #32770
      # alone. And it is deliberately toothless in the worst case -- if
      # a real modal ever declared itself non-activatable, it would be
      # the only thing on screen, the probe's popup counter would stay
      # at zero, and the run would still stop on "no popup text could be
      # read". The only behaviour that changes is a marked window
      # standing NEXT to AE's own "I am executing your script".
      if ($block[0] -match '\{nonmodal') {
        continue
      }
      $sawUnreadable = $true
      continue
    }

    # Is EVERY word this popup says one of AE's own progress titles? The
    # test is on all of them, never on the joined text: a popup that
    # names itself "Verifying Adobe Fonts..." and then says something
    # else as well is a popup that said something else, and the words it
    # added are the whole reason a human would want to see it.
    $allProgress = $true
    $isScript = $false
    foreach ($w in $words) {
      if (-not (Test-AellProgressWord -Word $w -ScriptName $ScriptName)) {
        $allProgress = $false
        break
      }
      if ($w -match '^Executing Script' -or
          ($ScriptName -and $w.Contains($ScriptName))) {
        $isScript = $true
      }
    }
    if ($allProgress) {
      # AE's script window is PROOF our script is alive; any other
      # progress window only says AE is busy. Kept apart so the second
      # kind can still be escalated by lasting.
      if ($isScript) { $sawProgress = $true }
      else { $sawWorking = $true; $workingLines += $block }
      continue
    }

    $blockingLines += $block
  }

  # A popup WITH WORDS is judged on its words whatever else is up. Short
  # of that, "AE is still starting" outranks "something unreadable is on
  # screen", because during startup the unreadable thing is AE itself.
  # `running` outranks `progress` deliberately: when AE's script window
  # is up beside "Exporting Motion Graphics Template" (the measured
  # normal case), the strongest thing on screen is AE saying it is
  # executing our script, and a run must not be given up on while that
  # is true. `progress` is what is left when only AE's own work is
  # visible, and that is the one with a clock on it.
  $verdict = "clear"
  if ($blockingLines.Count -gt 0) { $verdict = "blocked" }
  elseif ($sawStartup) { $verdict = "startup" }
  elseif ($sawUnreadable) { $verdict = "unreadable" }
  elseif ($sawProgress) { $verdict = "running" }
  elseif ($sawWorking) { $verdict = "progress" }

  $text = ""
  if ($verdict -eq "blocked") { $text = ($blockingLines -join "`r`n") }
  elseif ($verdict -eq "unreadable") { $text = $ProbeText }
  elseif ($verdict -eq "progress") { $text = ($workingLines -join "`r`n") }

  return New-Object PSObject -Property @{
    Verdict = $verdict
    Text = $text
    SawProgress = $sawProgress
    SawStartup = $sawStartup
    SawWorking = $sawWorking
    WorkingText = ($workingLines -join "`r`n")
  }
}

# How many consecutive polls a verdict must survive before the runner
# gives up on it. Readable popups are believed quickly; an unreadable one
# has to prove it is not a teardown flicker. A real modal outlasts both.
#
# `progress` gets the longest rope of the three that have one. A named
# AE progress window is not a question, so it must never stop a run for
# being slow -- the longest measured one is ~2.5 s and a heavy comp will
# beat that. But it cannot be infinite either: the font ALERT an export
# raises ("...fonts were not synced... Click OK to continue") is a
# QUESTION, and the probe layer cannot tell it from the progress window
# of the same name, because GetWindowText reads nothing out of another
# process's child controls. 15 polls is 30 s -- far past any progress
# window measured here, far short of the 240 s timeout, and the only
# thing standing between an unattended run and a dialog that waits
# forever wearing a working window's title. (The evidence layer at the
# bottom of this file CAN read that alert's sentence, and reports it.)
function Get-AellVerdictPatience {
  param([string]$Verdict)
  if ($Verdict -eq "blocked") { return 3 }
  if ($Verdict -eq "unreadable") { return 8 }
  if ($Verdict -eq "progress") { return 15 }
  return 0
}

# The waiting loop's decision, kept here so a test can drive it over a
# recorded timeline of probe samples instead of re-implementing it.
# State in, state out; StopNow is the only thing the runner asks about.
function New-AellWaitState {
  return New-Object PSObject -Property @{
    LastVerdict = ""
    Streak = 0
    SawProgress = $false
    SawStartup = $false
    SawWorking = $false
    WorkingText = ""
    StopNow = $false
    BlockingText = ""
  }
}

function Update-AellWaitState {
  param(
    $State,
    [string]$ProbeText = "",
    [string]$ScriptName = ""
  )

  $triage = Get-AellDialogVerdict -ProbeText $ProbeText -ScriptName $ScriptName
  if ($triage.SawProgress) { $State.SawProgress = $true }
  if ($triage.SawStartup) { $State.SawStartup = $true }
  # Remembered, not just counted: a run that times out should be able to
  # say what AE last told it it was doing.
  if ($triage.SawWorking) {
    $State.SawWorking = $true
    $State.WorkingText = $triage.WorkingText
  }
  if ($triage.Verdict -eq $State.LastVerdict) {
    $State.Streak = $State.Streak + 1
  } else {
    $State.Streak = 1
  }
  $State.LastVerdict = $triage.Verdict

  $patience = Get-AellVerdictPatience -Verdict $triage.Verdict
  if ($patience -gt 0 -and $State.Streak -ge $patience) {
    $State.StopNow = $true
    $State.BlockingText = $triage.Text
  }
  return $State
}

# Before the harness launches anything, After Effects may ALREADY be
# sitting behind the save-changes prompt a PREVIOUS run left. Every cold
# run ends with AE dirty (the suite leaves its scratch comps behind), so
# whatever asks a dirty AE to close raises "Save changes to 'Untitled
# Project.aep'?" -- and no -r script runs while that is up. Pass N leaves
# it, pass N+1 exits 4 without executing a single step. Measured twice on
# this machine, and it cost the 2026-08-26 pass its first harness run.
#
# AE draws that prompt itself, so Win32 reads no text out of it: it
# cannot be identified by what it SAYS. This decides from the SITUATION
# instead, and the rule is deliberately narrow, because WM_CLOSE on the
# wrong window would answer a question a human should have seen:
#   - only the `unreadable` verdict; a popup WITH WORDS is never touched
#   - never while a script is executing -- the progress window's teardown
#     flicker is wordless too, and that one leaves on its own
#   - never during startup: with no application window up, the wordless
#     thing is AE's crash-recovery prompt, a different question whose
#     answer is not ours to give
#   - and only when a #32770 was actually FOUND. The probe's own "no
#     popup text could be read" note has no window behind it to answer.
function Get-AellStaleDialogPlan {
  param(
    [string]$ProbeText = "",
    [string]$ScriptName = ""
  )

  $triage = Get-AellDialogVerdict -ProbeText $ProbeText -ScriptName $ScriptName
  $dismiss = $false
  if ($triage.Verdict -ne "unreadable") {
    $reason = "verdict is '" + $triage.Verdict + "', not 'unreadable'"
  } elseif ($triage.SawProgress) {
    $reason = "After Effects is executing a script"
  } elseif ($triage.SawStartup) {
    $reason = "After Effects has not opened its main window yet"
  } elseif ($ProbeText -notmatch '\[#32770\]') {
    $reason = "no dialog window was found to answer"
  } else {
    $dismiss = $true
    $reason = "a wordless dialog is blocking a fully started After Effects"
  }

  return New-Object PSObject -Property @{
    Dismiss = $dismiss
    Reason = $reason
  }
}

# --- what the dialog SAYS -------------------------------------------------
#
# Everything above decides from the SITUATION, because for years nothing
# could read an After Effects dialog: GetWindowTextW on a control owned by
# another process returns EMPTY, so every AE alert arrived here as "no
# readable text" and the runner could only guess from context.
#
# It was never unreadable. Measured 2026-08-28 on AE 2026, first try:
# SendMessage(WM_GETTEXT) to the same child returns the whole sentence.
# The save-changes prompt is a #32770 with an empty title, three
# DroverLord containers that report their own class, and one `Edit` child
# whose GetWindowTextW is empty and whose WM_GETTEXT is
#
#     Save changes to "Untitled Project.aep" before closing?      (curly quotes)
#
# The harvest is EVIDENCE, not a new verdict. It deliberately does not
# feed Get-AellDialogVerdict: the stale-dialog answer below is gated on
# the `unreadable` verdict, so making the save prompt readable would flip
# it to `blocked` and the harness would stop answering the one dialog the
# whole mechanism exists to answer. Reading it must not make the runner
# more timid than it was when it was blind.

# The words a human would actually read, out of a raw harvest. AE's
# container children report their CLASS as their text (OS_ViewContainer
# and friends) and a control that did not answer in time is recorded as
# <no answer>; neither is something a dialog says.
function Get-AellHarvestWords {
  param([string]$Harvest = "")
  $words = @()
  foreach ($raw in ($Harvest -split "`r?`n")) {
    $t = $raw.Trim()
    if ($t.Length -eq 0) { continue }
    if ($t -match '^OS_[A-Za-z0-9_]+$') { continue }
    if ($t -eq '<no answer>') { continue }
    $words += $t
  }
  # Plain $words, never ,$words: the comma wraps an EMPTY array in a
  # one-element array, so a dialog with nothing to say came back with
  # one (empty) word and classified as the save prompt. Callers wrap the
  # call in @() instead, which is right for none, one and many.
  return $words
}

# Four harvests are known-benign, and everything else is worth a
# human's eye in the morning:
#   - nothing readable at all: the wordless popup the runner has always
#     answered (AE's teardown flicker, or a dialog even WM_GETTEXT cannot
#     reach). Unchanged from the blind behaviour, so still benign.
#   - the save-changes prompt: the leftover this machinery exists for.
#   - AE's script-progress window: proof the suite is RUNNING, and up
#     for the whole of every -r run this harness makes.
#   - AE's other progress windows (saving, opening, exporting a template)
#     when they say nothing but their own name.
#
# Judged LINE BY LINE, never on the joined text: two popups can be up at
# once, and "the save prompt is in there somewhere" must not launder an
# error alert standing next to it.
#
# The pattern reaches AROUND the project name rather than through it --
# the real text carries curly quotes and this file is ASCII by rule
# (CLAUDE.md), so the quotes are never matched literally.
function Get-AellHarvestClass {
  param([string]$Harvest = "")

  $words = @(Get-AellHarvestWords -Harvest $Harvest)
  if ($words.Count -eq 0) {
    return New-Object PSObject -Property @{
      Known = $true
      Label = "wordless"
      Text = ""
      Unknown = ""
    }
  }

  $unknown = @()
  $kinds = @()
  foreach ($w in $words) {
    if ($w -match 'Save changes to .* before closing') {
      if ($kinds -notcontains "save-changes prompt") {
        $kinds += "save-changes prompt"
      }
      continue
    }
    # AE's OWN script-progress window, which is up for every second of
    # every -r run this harness makes. Measured 2026-08-30: it harvests
    # as exactly two lines, "Executing Script <file>..." and
    # OS_ViewContainer. Until it was named here, any evidence taken
    # while a script was running was headlined UNRECOGNIZED DIALOG over
    # the top of AE reporting that it was busy doing what it was asked
    # -- which on 2026-08-30 pointed the morning review at the one
    # window in the picture that was not the problem.
    if ($w -match '^Executing Script') {
      if ($kinds -notcontains "script-progress window") {
        $kinds += "script-progress window"
      }
      continue
    }
    # AE's other progress windows -- the ones an export or a save raises
    # (see Get-AellProgressTitles). Named here for the same reason the
    # script one is: five of them go by during one export_mogrt, and
    # every run that took evidence while one was up was headlined
    # UNRECOGNIZED DIALOG over the top of AE saying it was busy.
    #
    # Safe to recognise HERE in a way it is not in the verdict layer:
    # this reads children with WM_GETTEXT, which cross-process
    # GetWindowText cannot, so the font ALERT's own sentence arrives as
    # a line of its own and lands in $unknown. A progress window that
    # says nothing but its name is benign; one that says anything else
    # is not, and that difference is only visible from here.
    if (Test-AellProgressWord -Word $w) {
      if ($kinds -notcontains "progress window") {
        $kinds += "progress window"
      }
      continue
    }
    $unknown += $w
  }
  if ($unknown.Count -eq 0) {
    return New-Object PSObject -Property @{
      Known = $true
      Label = ($kinds -join " + ")
      Text = ($words -join " / ")
      Unknown = ""
    }
  }
  return New-Object PSObject -Property @{
    Known = $false
    Label = "unrecognized"
    Text = ($words -join " / ")
    Unknown = ($unknown -join " / ")
  }
}
