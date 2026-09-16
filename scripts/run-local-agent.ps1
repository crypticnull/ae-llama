<#
.SYNOPSIS
  Drive an UNATTENDED Claude Code session on the After Effects machine
  through docs/WORKPLAN.md, one item per iteration.

  A normal Claude Code session is turn-based: it answers your prompt,
  finishes, and waits for input. It will not work through a backlog on
  its own. This script supplies the loop -- each pass starts a fresh
  headless session (claude -p), does ONE workplan item, verifies it,
  commits, pushes, and exits. The loop then pulls and starts the next.

  Because every pass is a fresh session with no memory of the last one,
  progress is tracked in docs/WORKPLAN-LOG.md (append-only). That log is
  now over a megabyte -- far past reading -- so each pass reads
  docs/MEMORY.md, the generated INDEX into it, and retrieves only the
  few entries it needs by line range. That is what stops a pass redoing
  item 1 forever without pretending it can read 260k tokens.

.EXAMPLE
  .\scripts\run-local-agent.ps1
  .\scripts\run-local-agent.ps1 -Iterations 40 -PauseSec 15
  .\scripts\run-local-agent.ps1 -UntilHour 7     # stop at 07:00
  .\scripts\run-local-agent.ps1 -UntilHour 9.5   # stop at 09:30

.NOTES
  Unattended means no one is there to answer permission prompts, so the
  session runs with permissions pre-granted (-SkipPermissions, default
  on). That is appropriate here: your own machine, your own repo, a
  branch this project already treats as disposable. Pass
  -SkipPermissions:$false to run with prompts and babysit it instead.

  Logs land in logs\local-agent-<timestamp>.log next to the repo. Paste
  a failing one into the remote chat session and it can diagnose.
#>
[CmdletBinding()]
param(
    [int]$Iterations = 20,
    [int]$PauseSec = 20,
    # Stop time as an hour of the day, fractions allowed: 7 = 07:00,
    # 9.5 = 09:30. -1 = run all Iterations.
    [double]$UntilHour = -1,
    [string]$RepoRoot = '',
    [string]$Branch = 'claude/ae-plugin-llama-cpp-f13g3x',
    [string]$ClaudePath = '',
    # Model for every pass, passed straight to `claude --model`. Empty =
    # the CLI's own default. Overnight verification passes run fine on a
    # cheaper tier; the expensive one is for daytime design and review.
    [string]$Model = '',
    [switch]$SkipPermissions = $true,
    # Upper bound on ONE pass (WORKPLAN 20b). A normal pass is 6-10
    # minutes. Before this there was no bound at all: run-ae-selftest.ps1
    # carries -TimeoutSec 240 and every other step carried nothing, so a
    # genuinely wedged pass held the loop until a human noticed. On an
    # overnight run that means the rest of the night.
    #
    # 45 rather than the 30 first proposed, because NEXT UP item 1
    # installs the managed ComfyUI backend -- a ~2 GB download -- and a
    # timeout that kills the item it exists to protect is worse than no
    # timeout. Lower it once that item is done.
    [int]$PassTimeoutMin = 45,
    # Reasoning effort for every pass, passed straight to `claude --effort`
    # (low, medium, high, xhigh, max). Empty = the CLI's own default.
    # Owner asked for "extra" on 2026-09-16, which is xhigh. Higher effort
    # costs more of the 5-hour window per pass, so a night trades pass
    # COUNT for pass depth -- the 2026-09-15 night hit the window once at
    # six passes on the default.
    [string]$Effort = '',
    # Skip the write-probe that runs before pass 1. Only for debugging
    # the loop itself -- the probe is one small CLI call and it is what
    # stands between a misconfigured machine and a wasted night.
    [switch]$SkipPreflight,
    # Run the preflight write-probe and STOP, without starting any
    # passes. The point is that it takes the SAME path a real run does --
    # including the WMI detach -- so it reproduces a pass's environment
    # in one small CLI call instead of one night of them. Use it after
    # anything changes about the machine, the CLI or the settings.
    [switch]$PreflightOnly,
    [switch]$Detached,
    # Leave the hosts' dialogs alone. For watching what AE or Premiere
    # actually puts up, without anything answering it first.
    [switch]$NoDialogWatchdog,
    # Carried across the WMI detach below. Win32_Process.Create takes no
    # environment, so the detached child inherits the WMI HOST's, not
    # this shell's -- and the WMI host has no APPDATA. Measured
    # 2026-09-02: a pass in that state had Settings.dataRoot() fall
    # through to a folder holding no settings.json, load() returned pure
    # defaults, and the pass reported the DEFAULT ComfyUI port as THE
    # OWNER'S SETTING. Two later sessions repeated the claim. Anything
    # reading the panel's real settings from a detached pass needs these.
    [string]$AppData = '',
    [string]$LocalAppData = '',
    [string]$UserProfile = ''
)

# --- detach: the loop must be nobody's child -------------------------
# Two nights died because the loop was launched from inside a Claude
# Code session and was killed with it. Do not rely on the human picking
# the right window: unless this IS the detached run, relaunch through
# WMI -- Win32_Process.Create parents the child to the WMI host, outside
# any process tree or job object that could take it down -- and return
# immediately. Closing the launching window, the CLI session ending, or
# its usage limit firing can no longer touch the loop.
if (-not $Detached) {
    $fwd = '-WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
           $PSCommandPath + '" -Detached'
    $fwd = $fwd + ' -Iterations ' + $Iterations
    $fwd = $fwd + ' -PauseSec ' + $PauseSec
    $fwd = $fwd + ' -PassTimeoutMin ' + $PassTimeoutMin
    if ($Effort) { $fwd = $fwd + ' -Effort "' + $Effort + '"' }
    $fwd = $fwd + ' -UntilHour ' + $UntilHour.ToString(
        [System.Globalization.CultureInfo]::InvariantCulture)
    if ($RepoRoot)   { $fwd = $fwd + ' -RepoRoot "' + $RepoRoot + '"' }
    if ($Branch)     { $fwd = $fwd + ' -Branch "' + $Branch + '"' }
    if ($ClaudePath) { $fwd = $fwd + ' -ClaudePath "' + $ClaudePath + '"' }
    if ($Model)      { $fwd = $fwd + ' -Model "' + $Model + '"' }
    if (-not $SkipPermissions) { $fwd = $fwd + ' -SkipPermissions:$false' }
    if ($SkipPreflight) { $fwd = $fwd + ' -SkipPreflight' }
    if ($PreflightOnly) { $fwd = $fwd + ' -PreflightOnly' }
    if ($NoDialogWatchdog) { $fwd = $fwd + ' -NoDialogWatchdog' }
    # Hand this shell's user folders to the detached child explicitly.
    if ($env:APPDATA) {
        $fwd = $fwd + ' -AppData "' + $env:APPDATA + '"'
    }
    if ($env:LOCALAPPDATA) {
        $fwd = $fwd + ' -LocalAppData "' + $env:LOCALAPPDATA + '"'
    }
    if ($env:USERPROFILE) {
        $fwd = $fwd + ' -UserProfile "' + $env:USERPROFILE + '"'
    }
    $spawn = $null
    try {
        $spawn = Invoke-CimMethod -ClassName Win32_Process `
            -MethodName Create `
            -Arguments @{ CommandLine = ('powershell.exe ' + $fwd) }
    } catch {
        Write-Host ('WMI detach failed: ' + $_.Exception.Message)
    }
    if ($spawn -and $spawn.ReturnValue -eq 0) {
        Write-Host ('Loop DETACHED as PID ' + $spawn.ProcessId +
                    ' -- closing this window or session cannot stop it.')
        Write-Host 'Live log: newest logs\local-agent-*.log in the repo.'
        # Not "Stop-Process -Id <that number>": the WMI PID can be stale
        # by the time anyone reads it, and killing this shell leaves the
        # claude pass it launched still running. stop-local-agent.ps1
        # finds the loop by command line and stops both.
        Write-Host ('To stop it: powershell -ExecutionPolicy Bypass -File ' +
                    'scripts\stop-local-agent.ps1')
        exit 0
    }
    Write-Host 'Detach unavailable -- running ATTACHED in this window.'
    Write-Host 'Do not close this window while the loop runs.'
}

# Restore the user folders the WMI host did not carry. Only ever FILLS a
# missing one -- never overwrites a real value, so an attached run and a
# detached one behave identically. Without this, everything that reads
# the panel's settings from a pass (scripts\comfy-install.js, the
# probes) either refuses at its own gate or, worse, quietly answers from
# defaults; the 2026-09-02 entry is what that costs.
if (-not $env:APPDATA -and $AppData) { $env:APPDATA = $AppData }
if (-not $env:LOCALAPPDATA -and $LocalAppData) {
    $env:LOCALAPPDATA = $LocalAppData
}
if (-not $env:USERPROFILE -and $UserProfile) {
    $env:USERPROFILE = $UserProfile
}
if (-not $env:APPDATA) {
    Write-Host ('WARNING: APPDATA is empty and none was passed in. ' +
                'Passes that read the panel settings will refuse ' +
                '(see scripts\comfy-install.js gate 0).')
}

# NOT 'Stop': git and the CLI both write ordinary progress to stderr, and
# under `2>&1` with -ErrorAction Stop PowerShell 5.1 turns those into
# terminating NativeCommandError exceptions. That would fail every pull
# and silently skip every pass -- exactly the do-nothing failure this
# script exists to prevent. Exit codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path $RepoRoot).Path
Set-Location $RepoRoot

# Telling OUR CLI passes apart from the Claude desktop app, which is
# Electron and runs many processes named claude. Loaded here because the
# reap below must never kill by name.
. (Join-Path $PSScriptRoot 'lib\claude-procs.ps1')

# Reading what the card is holding, for the teardown check below (17q).
. (Join-Path $PSScriptRoot 'lib\gpu-detect.ps1')

# --- locate the CLI -------------------------------------------------
if (-not $ClaudePath) {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) { $ClaudePath = $cmd.Source }
}
if (-not $ClaudePath) {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.local\bin\claude.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\claude.cmd'),
        (Join-Path $env:USERPROFILE '.local\bin\claude'),
        (Join-Path $env:APPDATA 'npm\claude.cmd')
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $ClaudePath = $c; break }
    }
}
if (-not $ClaudePath -or -not (Test-Path $ClaudePath)) {
    Write-Host 'Claude Code CLI not found. Install it, or pass -ClaudePath.'
    Write-Host 'Typical location: %USERPROFILE%\.local\bin\claude.exe'
    exit 2
}

$logDir = Join-Path $RepoRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir ("local-agent-" + $stamp + ".log")
# The detached run is windowless -- the pid file is how it gets stopped.
Set-Content -Path (Join-Path $logDir 'local-agent.pid') -Value $PID -Encoding ASCII

# The CLI's output arrives with ANSI color escapes and UTF-8 punctuation.
# Echoed raw on Windows PowerShell 5.1 that renders as garbage (ESC[36m,
# mojibake for dashes/quotes), and -Encoding ASCII turns every non-ASCII
# char into '?'. Scrub each line once: drop escape sequences and control
# chars, transliterate the common punctuation, '?' only as the last
# resort. The log stays readable in Notepad AND in the console.
$script:escChar = [char]27
$script:ansiRe = New-Object System.Text.RegularExpressions.Regex `
    ([string]$script:escChar + '\[[0-9;?]*[A-Za-z]')
function Clean-Line([string]$s) {
    if ($null -eq $s) { return '' }
    $s = $script:ansiRe.Replace($s, '')
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $s.ToCharArray()) {
        $c = [int]$ch
        if ($c -lt 32 -and $c -ne 9) { continue }
        if ($c -le 126) { [void]$sb.Append($ch); continue }
        switch ($c) {
            0x2013 { [void]$sb.Append('-') }
            0x2014 { [void]$sb.Append('--') }
            0x2018 { [void]$sb.Append("'") }
            0x2019 { [void]$sb.Append("'") }
            0x201C { [void]$sb.Append('"') }
            0x201D { [void]$sb.Append('"') }
            0x2022 { [void]$sb.Append('*') }
            0x2026 { [void]$sb.Append('...') }
            0x2192 { [void]$sb.Append('->') }
            default { [void]$sb.Append('?') }
        }
    }
    return $sb.ToString()
}

# Every write to $logFile goes through Add-AellLogLine, never Add-Content:
# PS 5.1 Add-Content is REFUSED while anyone has the log open to read it
# (a tail -F, a Monitor), and that silenced two whole nights. See the lib.
$logAppendLib = Join-Path $PSScriptRoot 'lib\log-append.ps1'
. $logAppendLib

function Write-Log([string]$msg) {
    $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + (Clean-Line $msg)
    Write-Host $line
    [void](Add-AellLogLine -Path $logFile -Value $line)
}

# WORKPLAN 20e: every pass inherits this, and so does the self-test it
# runs. run-ae-selftest.ps1 appends its crash-flag, launch and verdict
# lines here directly, so a pass killed by the timeout still leaves the
# harness verdict in this log instead of dying with the pass summary.
$env:AELL_LOOP_LOG = $logFile

# Every exit from here on writes "Loop exit: <why>" as the log's last
# line -- and an exit nobody named says UNEXPECTED with the last error.
# The 2026-09-16 01:39 "silent death" was a loop spending 35 iterations
# in 13 minutes on a CLI that could not start; see lib\loop-exit.ps1.
. (Join-Path $PSScriptRoot 'lib\loop-exit.ps1')
Register-AellLoopExitReport -LogFile $logFile

# --- the per-iteration brief ----------------------------------------
# Single-quoted here-string: nothing interpolates, so the prompt reaches
# the CLI exactly as written.
$prompt = @'
You are the local agent on the machine with real After Effects. No human
is watching this session -- do not ask questions, make the call yourself
and write down what you assumed.

1. Read CLAUDE.md, then docs/MEMORY.md.
2. docs/MEMORY.md is the INDEX into docs/WORKPLAN-LOG.md. Do NOT read
   the log itself -- it is over a megabyte, roughly 260k tokens, and
   reading "some of it" is how a pass ends up acting on a fact that was
   corrected 200 entries later. Work from the index:
     - its corrections table first, so you do not trust a superseded
       claim;
     - then retrieve the two or three entries it points at, by line
       range: sed -n 'START,ENDp' docs/WORKPLAN-LOG.md
     - its subsystem list tells you which entries touch what you are
       about to change.
   Read the SECTION of docs/WORKPLAN.md you are working in, not the
   whole file (it is ~46k tokens).
   Do NOT redo finished work.
3. Run the harness once to see where things stand:
   powershell -ExecutionPolicy Bypass -File scripts/run-ae-selftest.ps1
   If it is red, fixing it IS this pass's item -- stop reading the
   workplan and fix that.
4. Otherwise open docs/WORKPLAN.md and read the "NEXT UP" block at the
   TOP of it. Take the FIRST item there whose "needs" are satisfied,
   then read only that item's own section for the detail. That block
   exists because step 2 tells you not to read the whole file: without
   it you would be guessing which of nineteen sections holds live work,
   and sections 1-16 are almost entirely struck through.
   If an item fails for an ENVIRONMENTAL reason -- no disk, no network,
   a download that will not finish, no backend -- write that in the log
   and take the NEXT item. Do not spend the whole night retrying one.
5. Do it. Fix at the host-tool root (extension/jsx/hostscript.jsx or the
   panel JS), never by loosening the test. Then back-fill the stubbed
   Node test in tests/ so the same bug class is caught without AE.
6. Verify: node tests/test-<name>.js for everything you touched, then
   the harness again. Both must pass before you commit.
7. Append a dated entry to docs/WORKPLAN-LOG.md with: the item, what you
   changed, the harness result (passed/total), and anything you hit that
   is blocked or needs a human eye. Then:
     - if the entry CORRECTS an earlier one, open with a marker line
       "SUPERSEDES: <lines> -- <what changed>" so the index can carry it
       (a correction only findable by reading the whole log is not a
       correction);
     - run: node scripts/memory-index.js
       The index is generated and CI fails if it is stale.
     - if you found anything that implies WORK, file it in
       docs/WORKPLAN.md as well. The log is the audit trail; the loop
       takes work from the QUEUE, so a finding written only to the log
       is a finding nothing will ever act on. This has already happened
       once.
8. Commit and push to the development branch. Small, clear message.

Hard limits for this session:
- Do exactly ONE item, then stop. The loop will start you again.
- NEVER quit or close After Effects, and never close its project. Not as
  cleanup, not to "leave the machine tidy", not between steps. Leave AE
  running exactly as you found it: the suite already deletes the scratch
  comps it made, and that is the whole of the cleanup you owe.
  Quitting it costs the next pass a cold launch, and -- because the
  project is dirty by design -- raises "Save changes to Untitled
  Project.aep before closing?", which is a MODAL: no -r script runs
  while it is up, so the pass after yours does nothing at all. Two
  nights were lost to exactly this. If AE is wedged, say so in the log
  and stop; do not close it.
- One failed attempt per item per night: if the log shows an item was
  already attempted tonight and blocked, do NOT retry it -- pick the
  next unfinished item instead. A blocked item is a log entry and a
  commit, never a stopped pass and never a second attempt: the human
  is asleep, and the night is for the items that CAN move.
- When you push a fix you VERIFIED in real AE, bump the patch version
  first: node scripts/bump-version.js patch. Without it CI publishes a
  feed the panel ignores, so the fix never reaches a real panel.
- BUT: a pass that never touches extension/ (harness scripts, tests,
  docs, workplan bookkeeping) must NOT bump. A bump with no panel
  change publishes an update that installs nothing new, and every
  test user pays the reinstall for it. Bump exactly when extension/
  changed, skip exactly when it did not.
- Do not bump minor/major, do not merge to main, do not open or merge a
  PR. Those belong to the remote session.
- If the harness cannot run at all (AE closed, scripting file access
  disabled), write that into docs/WORKPLAN-LOG.md, commit that, and stop.
  Do not spend the pass guessing.
'@

# Flags only, kept apart from the prompt so the PREFLIGHT below can run
# the CLI exactly the way a pass will. A preflight that ran with
# different flags would prove nothing about the passes.
$claudeFlags = @()
if ($SkipPermissions) { $claudeFlags += '--dangerously-skip-permissions' }
if ($Model) { $claudeFlags += @('--model', $Model) }
if ($Effort) { $claudeFlags += @('--effort', $Effort) }

# Force the OUTPUT STYLE back to default for passes.
#
# Measured 2026-09-08: the owner's %USERPROFILE%\.claude\settings.json
# carries "outputStyle": "Learning", which asks the session to hand
# design decisions back as TODO(human) blocks. That is a fine style for
# a human at a keyboard and exactly wrong for an unattended pass -- the
# brief tells a pass there is no human watching and not to ask
# questions, so the two instructions contradict each other and the pass
# has to notice and resolve it. One did, and said so; another may just
# leave a TODO(human) in shipped code.
#
# Passed as a FILE rather than an inline JSON string: PowerShell 5.1
# mangles embedded double quotes when it builds a native command line,
# and a silently-corrupted --settings argument is worse than none.
$styleFile = Join-Path $RepoRoot ('logs\pass-settings-' + $PID + '.json')
$styleJson = '{"outputStyle":"default"}'
$styleWritten = $false
try {
    Set-Content -Path $styleFile -Encoding ASCII -Value $styleJson
    $claudeFlags += @('--settings', $styleFile)
    $styleWritten = $true
} catch {
    Write-Host ('Could not write the pass settings file (' +
                $_.Exception.Message + ') -- passes will run with ' +
                'whatever output style the user settings carry.')
}

# THE PROMPT GOES IN ON STDIN, NOT ON THE COMMAND LINE.
#
# Measured 2026-09-08, and it cost two nights. The brief above contains
# seven double-quote characters ("NEXT UP", "needs", "some of it" ...).
# Windows PowerShell 5.1 wraps a native argument in quotes WITHOUT
# escaping the quotes inside it, so the command line it builds ends the
# -p argument at the first interior quote and everything after it --
# INCLUDING the trailing --dangerously-skip-permissions -- lands as
# stray positional arguments that never register as flags. The session
# then runs with no bypass: Read, Grep and Glob work, every Edit, Write
# and Bash call is auto-denied, which is exactly what the passes
# reported.
#
# The proof was in the loop's own log. The preflight, whose prompt has
# NO quotes in it, wrote its file and reported "Preflight OK" -- and
# pass 1, eight seconds later with the identical flag array, had no
# bypass at all. Same flags, same directory, same process; the only
# difference was the prompt.
#
# `claude -p` with no value reads the prompt from stdin, so this takes
# the prompt off the command line entirely and no amount of quoting in
# the brief can reach the argument parser. The flags also go FIRST now,
# so they are parsed before anything else can go wrong.
$promptFile = Join-Path $RepoRoot ('logs\pass-prompt-' + $PID + '.txt')
Set-Content -Path $promptFile -Value $prompt -Encoding ASCII
$claudeArgs = $claudeFlags + @('-p')

Write-Log ('repo   : ' + $RepoRoot)
Write-Log ('claude : ' + $ClaudePath)
# LOG THE FLAGS. 2026-09-08: a night was lost to passes that could read
# but not write or execute, and the log did not record what the CLI was
# actually invoked with -- so the first question ("did the bypass flag
# reach it?") could not be answered from the log at all. It costs one
# line.
Write-Log ('flags  : ' + $(if ($claudeFlags.Count) { $claudeFlags -join ' ' }
                          else { '(none)' }))
Write-Log ('model  : ' + $(if ($Model) { $Model } else { '(CLI default)' }))
Write-Log ('effort : ' + $(if ($Effort) { $Effort } else { '(CLI default)' }))
Write-Log ('branch : ' + $Branch)
Write-Log ('log    : ' + $logFile)
Write-Log ('plan   : ' + $Iterations + ' iterations, ' + $PauseSec + 's pause')

# The card as it was BEFORE the loop touched anything (17q / NEXT UP 1).
#
# Read here and not in the teardown because the whole point is a
# comparison, and the only honest baseline is the one taken before any
# pass could boot a backend. Recorded even when it is $null (no
# nvidia-smi): a teardown that cannot compare must SAY so.
$gpuFloor = Get-AellGpuMemoryMB
if ($gpuFloor) {
    Write-Log ('GPU    : floor ' + $gpuFloor.UsedMB + ' MiB used of ' +
               $gpuFloor.TotalMB + ' before any pass ran')
} else {
    Write-Log 'GPU    : no nvidia-smi reading -- the teardown cannot verify the card'
}

# The stop time, computed once.
#
# The old check was `(Get-Date).Hour -eq $UntilHour`, which only matched
# if a pass happened to START inside that one hour. A pass that ran long
# could step straight over it and the loop would keep going all day. A
# real timestamp cannot be jumped over.
$stopAt = $null
if ($UntilHour -ge 0) {
    $h = [int][Math]::Floor($UntilHour)
    $m = [int][Math]::Round(($UntilHour - $h) * 60)
    if ($m -ge 60) { $h = $h + 1; $m = 0 }
    $today = (Get-Date).Date.AddHours($h).AddMinutes($m)
    # Overnight: a stop time that has already passed means tomorrow.
    $stopAt = if ($today -gt (Get-Date)) { $today } else { $today.AddDays(1) }
    Write-Log ('Will stop at ' + $stopAt.ToString('yyyy-MM-dd HH:mm'))
}

# ---------------------------------------------------------------- watchdog
#
# Answer the hosts' modal dialogs for the WHOLE life of the loop, in a
# background job, not just while a particular script happens to be
# running.
#
# This exists because the first two attempts at the save-changes prompt
# both put the answering INSIDE run-ae-selftest.ps1 -- once before its
# launch, then also during its wait loop. Both are real improvements and
# both miss the case the owner kept hitting, for a simple reason:
# NOTHING IN THIS REPO ASKS AFTER EFFECTS TO QUIT. Grep it. So the
# prompt in the owner's photo was not raised by the self-test at all,
# and a self-test that is not running cannot answer it. AE sat on
#
#     Save changes to "Untitled Project.aep" before closing?
#
# with the panel visible behind it, between passes, where no code of
# ours was looking. The answering had to stop being a feature of one
# script and become a property of the loop.
#
# The job runs the same shared rules (scripts/lib/host-dialogs.ps1) and
# so inherits the same rail: it may DISCARD changes only on a project
# this harness declares it owns, and on anything else it clicks Cancel,
# which unblocks the host and keeps every unsaved change. It also never
# consults the wait-loop triage, which is a second reason the in-run
# answering could miss: a save prompt that AE's script-progress window
# owns reads as the verdict `running`, and `running` means keep
# waiting.
$watchdog = $null
if (-not $NoDialogWatchdog) {
    $watchdog = Start-Job -Name 'AellDialogWatchdog' -ScriptBlock {
        param($lib, $owned, $procs, $everySec, $log, $appendLib)
        . $lib
        . $appendLib
        function Note([string]$m) {
            $line = ((Get-Date -Format 'HH:mm:ss') + '  [watchdog] ' + $m)
            [void](Add-AellLogLine -Path $log -Value $line)
        }
        Note 'started'
        $sweeps = 0
        while ($true) {
            try {
                $n = Answer-AellKnownDialogs -ProcessNames $procs `
                       -OwnedProjects $owned
                if ($n -gt 0) { Note ('answered ' + $n + ' dialog(s)') }
            } catch {
                Note ('sweep failed: ' + $_.Exception.Message)
            }
            $sweeps++
            # A heartbeat every ~5 minutes. Without one, "the watchdog
            # did not work" and "the watchdog never ran" look identical
            # in the log, and this has already cost a night twice.
            if (($sweeps % 60) -eq 0) { Note ('alive, ' + $sweeps + ' sweeps') }
            Start-Sleep -Seconds $everySec
        }
    } -ArgumentList `
        (Join-Path $PSScriptRoot 'lib\host-dialogs.ps1'),
        @('Untitled Project', 'mogrt-probe-scratch', 'AELL_PROBE_SCRATCH'),
        @('AfterFX', 'Adobe Premiere Pro', 'Adobe Premiere'),
        # 5s, not 10. A sweep is cheap -- it enumerates top-level
        # windows and only reads text out of an actual #32770 -- and
        # the window that matters is the one between a pass asking AE
        # to close and that pass giving up on it.
        5,
        $logFile,
        $logAppendLib
    Write-Log ('Dialog watchdog running (job ' + $watchdog.Id + '): a ' +
               'save-changes prompt on a project this harness owns is ' +
               'answered Do not Save; anything else is cancelled, which ' +
               'unblocks the host and keeps its changes.')
}

# ------------------------------------------------- backend teardown (17q)
#
# Stop a managed ComfyUI the night's passes booted (owner, 2026-09-09) and
# CHECK that stopping it worked. The whole verdict, and the reasoning it
# was built from, is scripts\lib\comfy-teardown.ps1 -- ONE definition,
# because 17q-b showed there is a second caller: the owner stops a night
# by hand with stop-local-agent.ps1, which kills this shell and therefore
# runs none of the exits below.
. (Join-Path $PSScriptRoot 'lib\comfy-teardown.ps1')

# --- preflight: can a pass WRITE? ------------------------------------
#
# 2026-09-08: a full night's loop was started and every pass came back
# read-only -- Edit, Write, Bash and git all auto-denied, while Read,
# Grep and Glob worked. The passes were articulate about it and the loop
# did not care: it logged "Pass produced no commit", slept 20 seconds,
# and started the next one. Thirty iterations of essays.
#
# The loop cannot fix that condition, but it must never spend a night on
# it. One tiny CLI call, with the SAME flags a pass gets, that has to
# come back with a file on disk. No file means no pass can commit, so
# there is nothing to run: stop and say what to check.
#
# It is deliberately a WRITE probe rather than a version or config read.
# The failure is about what the CLI is permitted to do, and only doing
# it proves anything -- a settings file that looks right and a session
# that cannot write are the exact pair that cost the night.
if (-not $SkipPreflight) {
    $probe = Join-Path $RepoRoot ('logs\preflight-' + $PID + '.txt')
    Remove-Item -Path $probe -Force -ErrorAction SilentlyContinue
    Write-Log 'Preflight: checking that a pass can write a file...'
    # The probe prompt carries DOUBLE QUOTES on purpose, and goes in the
    # same way a pass's does. 2026-09-08: the first version of this
    # probe used a quote-free prompt passed on the command line, so it
    # sailed through while every real pass -- whose brief has seven
    # quotes in it -- ran with no bypass. A preflight that exercises an
    # easier path than the thing it is clearing is worse than none: it
    # converts "broken" into "verified working".
    $probePrompt = 'Use the Write tool to create the file "' + $probe +
                   '" containing exactly the word READY. Then reply ' +
                   '"DONE". Do nothing else.'
    $probeFile = Join-Path $RepoRoot ('logs\preflight-prompt-' + $PID + '.txt')
    Set-Content -Path $probeFile -Value $probePrompt -Encoding ASCII
    $probeOut = New-Object System.Collections.Generic.List[string]
    try {
        Get-Content -Raw $probeFile |
            & $ClaudePath @($claudeFlags + @('-p')) 2>&1 |
            ForEach-Object {
                $line = Clean-Line ([string]$_)
                $probeOut.Add($line)
                [void](Add-AellLogLine -Path $logFile -Value ('  probe| ' + $line))
            }
    } catch {
        Write-Log ('Preflight error: ' + $_.Exception.Message)
    }
    if (Test-Path $probe) {
        Remove-Item -Path $probe -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $probeFile -Force -ErrorAction SilentlyContinue
        Write-Log 'Preflight OK -- passes can write.'
        if ($PreflightOnly) {
            Write-Log 'PreflightOnly: not starting passes. Environment is good.'
            Stop-AellLoopBackend -Floor $gpuFloor -RepoRoot $RepoRoot `
                -Log ${function:Write-Log}
            Remove-Item -Path $styleFile -Force -ErrorAction SilentlyContinue
            if ($watchdog) {
                try {
                    Stop-Job -Job $watchdog -ErrorAction Stop
                    Remove-Job -Job $watchdog -Force -ErrorAction SilentlyContinue
                } catch {}
            }
            Write-Log ('Full log: ' + $logFile)
            Set-AellLoopExitReason 'PreflightOnly -- environment checked, no passes by design.'
            exit 0
        }
    } else {
        Write-Log ''
        Write-Log 'PREFLIGHT FAILED: the CLI could not write a file, so no'
        Write-Log 'pass can edit code, run a test, or commit. Not starting'
        Write-Log ('the loop -- ' + $Iterations + ' passes would each ' +
                   'produce a report and no work.')
        Write-Log ''
        Write-Log ('Flags used: ' + $(if ($claudeFlags.Count) {
                   $claudeFlags -join ' ' } else { '(none)' }))
        Write-Log 'Check, in this order:'
        Write-Log ('  1. ' + $env:USERPROFILE +
                   '\.claude\settings.json  -- a permissions block, or an')
        Write-Log '     outputStyle, will both change how a pass behaves.'
        Write-Log '  2. C:\ProgramData\ClaudeCode\managed-settings.json'
        Write-Log '     -- managed settings OVERRIDE command-line flags.'
        Write-Log '  3. The CLI version: a newer one may gate the bypass'
        Write-Log '     flag behind --allow-dangerously-skip-permissions.'
        Write-Log 'Reproduce it by hand with the flags printed above:'
        Write-Log ('  & "' + $ClaudePath + '" -p ' +
                   $(if ($claudeFlags.Count) { ($claudeFlags -join ' ') + ' ' }
                     else { '' }) + '"write ok.txt containing OK"')
        # No pass ran, so there should be nothing to stop -- but a
        # PREVIOUS night's detached backend can still be on the card, and
        # this is the one exit that used to leave without looking.
        Stop-AellLoopBackend -Floor $gpuFloor -RepoRoot $RepoRoot `
            -Log ${function:Write-Log}
        if ($watchdog) {
            try {
                Stop-Job -Job $watchdog -ErrorAction Stop
                Remove-Job -Job $watchdog -Force -ErrorAction SilentlyContinue
            } catch {}
        }
        Write-Log ('Full log: ' + $logFile)
        Set-AellLoopExitReason 'PREFLIGHT FAILED -- the CLI could not write a file; no pass started.'
        exit 3
    }
}

# Consecutive waits spent on a usage limit (see the check below). Reset
# whenever a pass actually lands a commit.
$limitWaits = 0

# Passes in a row that returned within $fastFailSec having committed
# nothing. 2026-09-16 01:25-01:38: thirty-five of these, 0.13 s each
# ("Error: Settings file not found"), read as thirty-five idle passes.
# A real pass reads the index and the queue before it can decide there
# is nothing to do, so a minute is far below any honest one.
$fastFails = 0
$fastFailSec = 60
$fastFailLimit = 3
$passesCommitted = 0
$passesEmpty = 0

for ($i = 1; $i -le $Iterations; $i++) {

    if ($stopAt -and (Get-Date) -ge $stopAt) {
        Write-Log ('Reached stop time ' + $stopAt.ToString('HH:mm') + '. Done.')
        Set-AellLoopExitReason ('reached the stop time ' +
            $stopAt.ToString('yyyy-MM-dd HH:mm') + ' before pass ' + $i + '.')
        break
    }

    Write-Log ('===== pass ' + $i + ' of ' + $Iterations + ' =====')
    Set-AellLoopExitContext ('pass ' + $i + ' of ' + $Iterations)

    $dirty = & git status --porcelain
    if ($dirty) {
        # A pass that died mid-edit leaves a dirty tree. Stopping the
        # whole loop here protected the work but killed the night --
        # unattended, salvage the changes to a stash (nothing is lost,
        # the morning review can inspect or pop it) and keep going.
        Write-Log 'Working tree is dirty; a previous pass left changes behind.'
        foreach ($d in $dirty) { Write-Log ('  ' + [string]$d) }
        $stamp2 = Get-Date -Format 'yyyyMMdd-HHmmss'
        & git stash push -u -m ('loop-salvage-' + $stamp2) 2>&1 | Out-Null
        $still = & git status --porcelain
        if ($still) {
            Write-Log 'Stash could not clean the tree. Stopping to protect it.'
            Set-AellLoopExitReason ('the working tree was dirty before pass ' +
                $i + ' and git stash could not clean it.')
            break
        }
        Write-Log ('Salvaged to stash "loop-salvage-' + $stamp2 +
                   '" -- review it in the morning. Continuing.')
    }

    # Pull first: the remote session force-resets this branch onto main
    # after each merge, so the local clone goes stale regularly.
    $pulled = $false
    for ($try = 1; $try -le 4; $try++) {
        try {
            & git fetch origin $Branch 2>&1 | Out-Null
            & git checkout $Branch 2>&1 | Out-Null
            & git pull --rebase origin $Branch 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $pulled = $true; break }
        } catch {
            Write-Log ('pull attempt ' + $try + ' failed: ' + $_.Exception.Message)
        }
        Start-Sleep -Seconds ([math]::Pow(2, $try))
    }
    if (-not $pulled) {
        Write-Log 'Could not sync the branch after 4 tries. Skipping this pass.'
        Start-Sleep -Seconds $PauseSec
        continue
    }

    $before = [string](& git rev-parse HEAD)
    $before = $before.Trim()

    # Keep the pass's output in memory too: a pass that hit the USAGE
    # LIMIT exits fast with a message instead of doing work, and only
    # the text tells that apart from a genuinely idle pass.
    #
    # Each pass leaks one lingering CLI process (measured 2026-08-29 --
    # ten passes, ten zombies, and the loop died of the pile at pass
    # 11), so a leak is reaped once the pass returns.
    #
    # Identified by DESCENT, never by name. `Get-Process claude` also
    # matches the Claude DESKTOP APP, which is Electron and so runs a
    # main process plus renderer, GPU and utility children all named
    # claude -- the owner sees ten or eleven while chatting in it. The
    # old code snapshotted that list and killed anything new, so opening
    # a tab in the desktop app mid-pass could get it shot and logged as
    # "Reaped lingering claude pid N". A leak of ours is a DESCENDANT of
    # this shell; the desktop app is not, and its Electron markers are
    # excluded on top. See scripts/lib/claude-procs.ps1.
    #
    # The old caveat is gone with the old test: an interactive claude
    # session the owner starts is not our descendant, so the loop no
    # longer has any claim on it.
    $census = Get-AellClaudeCensus -RootId $PID
    Write-Log ('claude-named processes on this machine: ' +
               $census.NamedTotal + ' (' + $census.Ours + ' of them ours; ' +
               'the rest are the Claude desktop app, which is an Electron ' +
               'app and runs many processes under that name)')
    # --- heartbeat while the pass runs (WORKPLAN 20a) ----------------
    #
    # `claude -p` hands back its output in ONE block at the end, so a
    # pass that is working normally writes nothing here for 6-10
    # minutes. The loop logged the pass start and then went silent, and
    # a silent pass and a wedged pass looked exactly the same from
    # outside -- two days were lost to that. Every 30s, say the three
    # things a passing clock cannot fake: the CLI process still exists,
    # how long it has run, and how many files the tree is dirty by. The
    # tree was stashed clean above, so a pass that has started editing
    # shows a RISING count and a pass that has not shows zero.
    #
    # NOT cpu. See the header of scripts/lib/loop-heartbeat.ps1: it was
    # measured to be wrong in both directions here, which is the whole
    # reason this exists.
    $passStartedAt = Get-Date
    $beat = $null
    try {
        $beat = Start-Job -Name 'AellPassHeartbeat' -ScriptBlock {
            param($procLib, $beatLib, $rootId, $repo, $log, $label,
                  $startedAt, $everySec, $appendLib)
            . $procLib
            . $beatLib
            . $appendLib
            while ($true) {
                # Sleep FIRST: the '===== pass N =====' line above
                # already stamps t=0, and a beat at 00:00 says nothing.
                Start-Sleep -Seconds $everySec
                try {
                    $line = Get-AellHeartbeatLine -RootId $rootId `
                              -RepoRoot $repo -StartedAt $startedAt `
                              -Label $label
                } catch {
                    $line = '[heartbeat] failed: ' + $_.Exception.Message
                }
                $stamped = ((Get-Date -Format 'HH:mm:ss') + '  ' + $line)
                [void](Add-AellLogLine -Path $log -Value $stamped)
            }
        } -ArgumentList `
            (Join-Path $PSScriptRoot 'lib\claude-procs.ps1'),
            (Join-Path $PSScriptRoot 'lib\loop-heartbeat.ps1'),
            $PID,
            $RepoRoot,
            $logFile,
            ('pass ' + $i + '/' + $Iterations),
            $passStartedAt,
            30,
            $logAppendLib
    } catch {
        # A missing heartbeat must never cost the pass. Say so and run.
        Write-Log ('Heartbeat could not start: ' + $_.Exception.Message)
    }

    # --- per-pass timeout (WORKPLAN 20b) ------------------------------
    #
    # The pass below is a BLOCKING pipeline. If `claude -p` wedges, this
    # loop waits forever, and nothing bounded it before now.
    #
    # A job rather than a timer on the pipeline, and the pass is found by
    # DESCENT from this process (Get-AellCliPassProcesses), never by
    # name: the Claude desktop app is Electron and owns a dozen processes
    # called claude, so killing by name would take the owner's own editor
    # down with the pass.
    #
    # Killing the child is what unblocks the pipeline, so the loop
    # resumes on its own once this fires. The sentinel file is how the
    # code after the pipeline tells "timed out" from "finished" -- a job
    # that has been stopped cannot be asked.
    $timeoutFlag = Join-Path $RepoRoot ('logs\pass-timeout-' + $PID + '-' + $i + '.flag')
    Remove-Item -LiteralPath $timeoutFlag -Force -ErrorAction SilentlyContinue
    $guard = $null
    try {
        $guard = Start-Job -Name 'AellPassTimeout' -ScriptBlock {
            param($procLib, $rootId, $flag, $limitSec)
            . $procLib
            Start-Sleep -Seconds $limitSec
            $killed = @()
            foreach ($cp in @(Get-AellCliPassProcesses -RootId $rootId)) {
                try {
                    Stop-Process -Id $cp.ProcessId -Force -ErrorAction Stop
                    $killed += $cp.ProcessId
                } catch { }
            }
            $what = 'nothing'
            if ($killed.Count) { $what = ($killed -join ',') }
            Set-Content -Path $flag -Encoding ASCII -Value (
                'ran past ' + $limitSec + 's; killed pid ' + $what)
        } -ArgumentList `
            (Join-Path $PSScriptRoot 'lib\claude-procs.ps1'),
            $PID,
            $timeoutFlag,
            ($PassTimeoutMin * 60)
    } catch {
        # A missing guard must never cost the pass, same as the beat.
        Write-Log ('Pass timeout guard could not start: ' + $_.Exception.Message)
    }

    # The pass inputs live under logs\ with a PID in the name, and a pass
    # cleaning up after its own test run once deleted them with a
    # wildcard (2026-09-16 01:13). Rewritten from memory, never trusted.
    try {
        if (Restore-AellPassFile -Path $promptFile -Value $prompt) {
            Write-Log ('Pass prompt file was MISSING and has been rewritten: ' +
                       $promptFile + '. Something deleted it -- a pass ' +
                       'cleaning logs\pass-*? Those files belong to this loop.')
        }
        if ($styleWritten -and
            (Restore-AellPassFile -Path $styleFile -Value $styleJson)) {
            Write-Log ('Pass settings file was MISSING and has been rewritten: ' +
                       $styleFile + '. Without it every pass exits at once ' +
                       'with "Settings file not found".')
        }
    } catch {
        Write-Log ('Could not restore the pass input files: ' +
                   $_.Exception.Message)
    }

    $passLines = New-Object System.Collections.Generic.List[string]
    $passT0 = Get-Date
    try {
        Get-Content -Raw $promptFile |
            & $ClaudePath @claudeArgs 2>&1 | ForEach-Object {
            $line = Clean-Line ([string]$_)
            $passLines.Add($line)
            [void](Add-AellLogLine -Path $logFile -Value $line)
            Write-Host $line
        }
    } catch {
        Write-Log ('Session error: ' + $_.Exception.Message)
    }
    $passSec = [int]((Get-Date) - $passT0).TotalSeconds
    $passExit = $LASTEXITCODE

    # Stop the beat BEFORE the reap, or the last line can claim a cli
    # process that is being killed as it is written.
    if ($beat) {
        $beatFor = [int]((Get-Date) - $passStartedAt).TotalSeconds
        Stop-Job -Job $beat -ErrorAction SilentlyContinue
        Remove-Job -Job $beat -Force -ErrorAction SilentlyContinue
        Write-Log ('Pass ran ' + $beatFor + 's.')
    }

    if ($guard) {
        Stop-Job -Job $guard -ErrorAction SilentlyContinue
        Remove-Job -Job $guard -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $timeoutFlag) {
        $why = (Get-Content -LiteralPath $timeoutFlag -Raw).Trim()
        Write-Log ('Pass TIMED OUT: ' + $why + '. The bound is ' +
                   '-PassTimeoutMin ' + $PassTimeoutMin +
                   '. Taking the next iteration.')
        Remove-Item -LiteralPath $timeoutFlag -Force -ErrorAction SilentlyContinue
    }

    foreach ($cp in @(Get-AellCliPassProcesses -RootId $PID)) {
        try {
            Stop-Process -Id $cp.ProcessId -Force -ErrorAction Stop
            Write-Log ('Reaped lingering CLI pass pid ' + $cp.ProcessId)
        } catch {
            Write-Log ('Could not reap CLI pass pid ' + $cp.ProcessId + ': ' +
                       $_.Exception.Message)
        }
    }

    $after = [string](& git rev-parse HEAD)
    $after = $after.Trim()
    if ($before -eq $after -or $after.Length -lt 8) {
        # Headless passes do NOT wait out a usage limit the way the
        # interactive CLI does ("continuing automatically at ...") --
        # they exit immediately. Without this check an overnight loop
        # that hit the 5-hour limit would burn every remaining
        # iteration in minutes and be long dead when the window reset.
        $passText = ($passLines -join ' ')
        if ($passText -match '(usage|session|rate).{0,3}limit|limit (reached|will reset)|hit your') {
            $limitWaits++
            if ($limitWaits -gt 21) {
                Write-Log 'Usage limit still in force after ~7 hours of waiting. Stopping.'
                Set-AellLoopExitReason ('usage limit still in force after ' +
                    '~7 hours of waiting, at pass ' + $i + '.')
                break
            }
            Write-Log ('Usage limit hit -- waiting 20 minutes, then retrying. ' +
                       '(wait ' + $limitWaits + ', iteration not consumed)')
            Start-Sleep -Seconds 1200
            $i--
            continue
        }
        # The preflight above catches a machine that is read-only BEFORE
        # the loop starts. This catches the same thing appearing MID-RUN
        # -- a settings change, an expired grant, a CLI self-update
        # between passes. Same reasoning: the loop cannot fix it, so
        # continuing only spends iterations producing reports.
        if ($passText -match 'requires approval|permission not granted|' +
                             'auto-denied|denied automatically|' +
                             'permission to use|not permitted to') {
            Write-Log ''
            Write-Log 'Pass reported DENIED PERMISSIONS and committed'
            Write-Log 'nothing. The preflight passed, so this appeared'
            Write-Log 'mid-run. Stopping rather than spending the'
            Write-Log 'remaining iterations on reports.'
            Write-Log 'See the PREFLIGHT FAILED notes in this script for'
            Write-Log 'what to check.'
            Set-AellLoopExitReason ('pass ' + $i + ' reported DENIED ' +
                'PERMISSIONS mid-run and committed nothing.')
            break
        }
        Write-Log 'Pass produced no commit (nothing done, or it stopped early).'
        $passesEmpty++
        if ($passSec -lt $fastFailSec) {
            $fastFails++
            $tail = @($passLines | Where-Object { $_ -and $_.Trim() } |
                      Select-Object -Last 3) -join ' | '
            if (-not $tail) { $tail = '(no output at all)' }
            Write-Log ('Pass returned in ' + $passSec + 's (CLI exit ' +
                       $passExit + '), too fast to have worked (' +
                       $fastFails + ' in a row). Its last output: ' + $tail)
            if ($fastFails -ge $fastFailLimit) {
                Write-Log ''
                Write-Log ('STOPPING: ' + $fastFails + ' passes in a row ' +
                           'returned in under ' + $fastFailSec + 's with no ' +
                           'commit. The CLI is failing to start a session, ' +
                           'and every further iteration would fail the ' +
                           'same way in seconds. Reproduce it by hand ' +
                           'with the flags printed at the top of this log.')
                Set-AellLoopExitReason (([string]$fastFails) + ' passes in a row ' +
                    'returned in under ' + $fastFailSec + 's with no commit ' +
                    '(last at pass ' + $i + ', CLI exit ' + $passExit +
                    '): ' + $tail)
                break
            }
        } else {
            $fastFails = 0
        }
    } else {
        Write-Log ('Pass committed ' + $after.Substring(0, 8))
        $limitWaits = 0
        $fastFails = 0
        $passesCommitted++
    }

    Start-Sleep -Seconds $PauseSec
}

# The real exit, and the one that matters: the passes are done and the
# machine is about to be the owner's again.
Set-AellLoopExitContext 'teardown after the last pass'
if (-not $global:AellLoopExitReason) {
    Set-AellLoopExitReason ('all ' + $Iterations + ' iterations used.')
}
$global:AellLoopExitReason = $global:AellLoopExitReason + ' Passes: ' +
    $passesCommitted + ' committed, ' + $passesEmpty + ' without a commit.'
Stop-AellLoopBackend -Floor $gpuFloor -RepoRoot $RepoRoot `
    -Log ${function:Write-Log}

if ($watchdog) {
    # The job holds no state worth keeping; it exists only while the
    # loop does. Left running it would answer dialogs on a machine
    # nobody is driving any more.
    try {
        Stop-Job -Job $watchdog -ErrorAction Stop
        Remove-Job -Job $watchdog -Force -ErrorAction SilentlyContinue
        Write-Log 'Dialog watchdog stopped.'
    } catch {
        Write-Log ('Could not stop the dialog watchdog: ' +
                   $_.Exception.Message)
    }
}

Remove-Item -Path $styleFile -Force -ErrorAction SilentlyContinue
Remove-Item -Path $promptFile -Force -ErrorAction SilentlyContinue

Write-Log 'Loop finished.'
Write-Log ('Full log: ' + $logFile)
Write-Log 'Recent work:'
& git log --oneline -15 | ForEach-Object {
    [void](Add-AellLogLine -Path $logFile -Value ([string]$_))
    Write-Host ([string]$_)
}
exit 0
