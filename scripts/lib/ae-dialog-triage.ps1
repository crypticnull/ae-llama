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

function Get-AellDialogVerdict {
  param(
    [string]$ProbeText = "",
    [string]$ScriptName = ""
  )

  $blockingLines = @()
  $sawProgress = $false
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
    $isProgress = $joined -match 'Executing Script'
    if (-not $isProgress -and $ScriptName -and $joined.Contains($ScriptName)) {
      $isProgress = $true
    }
    if ($isProgress) { $sawProgress = $true; continue }

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
      $t = $t.Trim()
      if ($t.Length -eq 0) { continue }
      if ($t -match '^OS_[A-Za-z0-9_]+$') { continue }
      $words += $t
    }
    if ($words.Count -eq 0) { $sawUnreadable = $true; continue }

    $blockingLines += $block
  }

  # A popup WITH WORDS is judged on its words whatever else is up. Short
  # of that, "AE is still starting" outranks "something unreadable is on
  # screen", because during startup the unreadable thing is AE itself.
  $verdict = "clear"
  if ($blockingLines.Count -gt 0) { $verdict = "blocked" }
  elseif ($sawStartup) { $verdict = "startup" }
  elseif ($sawUnreadable) { $verdict = "unreadable" }
  elseif ($sawProgress) { $verdict = "running" }

  $text = ""
  if ($verdict -eq "blocked") { $text = ($blockingLines -join "`r`n") }
  elseif ($verdict -eq "unreadable") { $text = $ProbeText }

  return New-Object PSObject -Property @{
    Verdict = $verdict
    Text = $text
    SawProgress = $sawProgress
    SawStartup = $sawStartup
  }
}

# How many consecutive polls a verdict must survive before the runner
# gives up on it. Readable popups are believed quickly; an unreadable one
# has to prove it is not a teardown flicker. A real modal outlasts both.
function Get-AellVerdictPatience {
  param([string]$Verdict)
  if ($Verdict -eq "blocked") { return 3 }
  if ($Verdict -eq "unreadable") { return 8 }
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
