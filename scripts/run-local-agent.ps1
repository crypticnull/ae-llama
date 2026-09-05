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
    [switch]$Detached,
    # Leave the hosts' dialogs alone. For watching what AE or Premiere
    # actually puts up, without anything answering it first.
    [switch]$NoDialogWatchdog
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
    $fwd = $fwd + ' -UntilHour ' + $UntilHour.ToString(
        [System.Globalization.CultureInfo]::InvariantCulture)
    if ($RepoRoot)   { $fwd = $fwd + ' -RepoRoot "' + $RepoRoot + '"' }
    if ($Branch)     { $fwd = $fwd + ' -Branch "' + $Branch + '"' }
    if ($ClaudePath) { $fwd = $fwd + ' -ClaudePath "' + $ClaudePath + '"' }
    if ($Model)      { $fwd = $fwd + ' -Model "' + $Model + '"' }
    if (-not $SkipPermissions) { $fwd = $fwd + ' -SkipPermissions:$false' }
    if ($NoDialogWatchdog) { $fwd = $fwd + ' -NoDialogWatchdog' }
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

function Write-Log([string]$msg) {
    $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + (Clean-Line $msg)
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding ASCII
}

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
4. Otherwise pick the SINGLE highest-priority unfinished workplan item.
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

$claudeArgs = @('-p', $prompt)
if ($SkipPermissions) { $claudeArgs += '--dangerously-skip-permissions' }
if ($Model) { $claudeArgs += @('--model', $Model) }

Write-Log ('repo   : ' + $RepoRoot)
Write-Log ('claude : ' + $ClaudePath)
Write-Log ('model  : ' + $(if ($Model) { $Model } else { '(CLI default)' }))
Write-Log ('branch : ' + $Branch)
Write-Log ('log    : ' + $logFile)
Write-Log ('plan   : ' + $Iterations + ' iterations, ' + $PauseSec + 's pause')

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
        param($lib, $owned, $procs, $everySec, $log)
        . $lib
        function Note([string]$m) {
            $line = ((Get-Date -Format 'HH:mm:ss') + '  [watchdog] ' + $m)
            try { Add-Content -Path $log -Value $line -Encoding ASCII } catch { }
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
        $logFile
    Write-Log ('Dialog watchdog running (job ' + $watchdog.Id + '): a ' +
               'save-changes prompt on a project this harness owns is ' +
               'answered Do not Save; anything else is cancelled, which ' +
               'unblocks the host and keeps its changes.')
}

# Consecutive waits spent on a usage limit (see the check below). Reset
# whenever a pass actually lands a commit.
$limitWaits = 0

for ($i = 1; $i -le $Iterations; $i++) {

    if ($stopAt -and (Get-Date) -ge $stopAt) {
        Write-Log ('Reached stop time ' + $stopAt.ToString('HH:mm') + '. Done.')
        break
    }

    Write-Log ('===== pass ' + $i + ' of ' + $Iterations + ' =====')

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
    $passLines = New-Object System.Collections.Generic.List[string]
    try {
        & $ClaudePath @claudeArgs 2>&1 | ForEach-Object {
            $line = Clean-Line ([string]$_)
            $passLines.Add($line)
            Add-Content -Path $logFile -Value $line -Encoding ASCII
            Write-Host $line
        }
    } catch {
        Write-Log ('Session error: ' + $_.Exception.Message)
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
                break
            }
            Write-Log ('Usage limit hit -- waiting 20 minutes, then retrying. ' +
                       '(wait ' + $limitWaits + ', iteration not consumed)')
            Start-Sleep -Seconds 1200
            $i--
            continue
        }
        Write-Log 'Pass produced no commit (nothing done, or it stopped early).'
    } else {
        Write-Log ('Pass committed ' + $after.Substring(0, 8))
        $limitWaits = 0
    }

    Start-Sleep -Seconds $PauseSec
}

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

Write-Log 'Loop finished.'
Write-Log ('Full log: ' + $logFile)
Write-Log 'Recent work:'
& git log --oneline -15 | ForEach-Object {
    Add-Content -Path $logFile -Value ([string]$_) -Encoding ASCII
    Write-Host ([string]$_)
}
exit 0
