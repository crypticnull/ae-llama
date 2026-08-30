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
  progress is tracked in docs/WORKPLAN-LOG.md (append-only). Each pass
  reads the log first so it picks up where the previous pass stopped
  instead of redoing item 1 forever.

.EXAMPLE
  .\scripts\run-local-agent.ps1
  .\scripts\run-local-agent.ps1 -Iterations 40 -PauseSec 15
  .\scripts\run-local-agent.ps1 -UntilHour 7   # stop at 7am

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
    [int]$UntilHour = -1,
    [string]$RepoRoot = '',
    [string]$Branch = 'claude/ae-plugin-llama-cpp-f13g3x',
    [string]$ClaudePath = '',
    [switch]$SkipPermissions = $true,
    [switch]$Detached
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
    $fwd = $fwd + ' -UntilHour ' + $UntilHour
    if ($RepoRoot)   { $fwd = $fwd + ' -RepoRoot "' + $RepoRoot + '"' }
    if ($Branch)     { $fwd = $fwd + ' -Branch "' + $Branch + '"' }
    if ($ClaudePath) { $fwd = $fwd + ' -ClaudePath "' + $ClaudePath + '"' }
    if (-not $SkipPermissions) { $fwd = $fwd + ' -SkipPermissions:$false' }
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
        Write-Host ('To stop it early: Stop-Process -Id ' + $spawn.ProcessId +
                    '  (PID also saved to logs\local-agent.pid)')
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

1. Read CLAUDE.md, then docs/WORKPLAN.md.
2. Read docs/WORKPLAN-LOG.md (create it if it does not exist). It is the
   record of what earlier passes already finished. Do NOT redo finished
   work.
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
   is blocked or needs a human eye.
8. Commit and push to the development branch. Small, clear message.

Hard limits for this session:
- Do exactly ONE item, then stop. The loop will start you again.
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

Write-Log ('repo   : ' + $RepoRoot)
Write-Log ('claude : ' + $ClaudePath)
Write-Log ('branch : ' + $Branch)
Write-Log ('log    : ' + $logFile)
Write-Log ('plan   : ' + $Iterations + ' iterations, ' + $PauseSec + 's pause')

# Consecutive waits spent on a usage limit (see the check below). Reset
# whenever a pass actually lands a commit.
$limitWaits = 0

for ($i = 1; $i -le $Iterations; $i++) {

    if ($UntilHour -ge 0 -and (Get-Date).Hour -eq $UntilHour) {
        Write-Log ('Reached stop hour ' + $UntilHour + '. Done.')
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
    # And snapshot the claude processes alive BEFORE the pass: each pass
    # leaks one lingering claude.exe (measured 2026-08-29 -- ten passes,
    # ten zombies, and the loop died of the pile at pass 11). Any claude
    # process born during the pass is the pass's leak and is reaped once
    # the pass returns. Consequence, documented: do not run your own
    # interactive claude session while the loop is working -- a session
    # started mid-pass is indistinguishable from a leak.
    $claudeBefore = @(Get-Process claude -ErrorAction SilentlyContinue |
                      Select-Object -ExpandProperty Id)
    Write-Log ('claude processes before pass: ' + $claudeBefore.Count)
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
    foreach ($cp in @(Get-Process claude -ErrorAction SilentlyContinue)) {
        if ($claudeBefore -notcontains $cp.Id) {
            try {
                Stop-Process -Id $cp.Id -Force -ErrorAction Stop
                Write-Log ('Reaped lingering claude pid ' + $cp.Id)
            } catch {
                Write-Log ('Could not reap claude pid ' + $cp.Id + ': ' +
                           $_.Exception.Message)
            }
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

Write-Log 'Loop finished.'
Write-Log ('Full log: ' + $logFile)
Write-Log 'Recent work:'
& git log --oneline -15 | ForEach-Object {
    Add-Content -Path $logFile -Value ([string]$_) -Encoding ASCII
    Write-Host ([string]$_)
}
exit 0
