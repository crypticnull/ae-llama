# remote-sessions.ps1 -- keep the owner's Remote Control sessions alive.
#
# WHY THIS EXISTS
#
# Remote Control links are held by the CLAUDE DESKTOP APP. When the app
# restarts -- which it does to apply its own auto-updates, without asking
# -- every link drops at once. Measured 2026-09-17: the app restarted at
# 09:22:37 and again at 12:34:43 (every app process carries that start
# time, and a new bundled CLI, 2.1.274, appeared at 12:34). The machine
# never slept and the network never dropped. The owner opened his phone
# to an offline icon on every session, having changed nothing.
#
# A session started from the CLI with --remote-control belongs to its OWN
# process, so an app restart cannot take it down.
#
# THREE THINGS THIS GETS RIGHT, EACH MEASURED THE HARD WAY
#
# 1. The name is QUOTED. Passing the name as its own array element splits
#    it on the space, so the CLI sees the name "AE" and a stray argument
#    "Llama". Observed 2026-09-17: four sessions came up named AE,
#    Mealplan, Job and TES.
#
# 2. It RESUMES, with --continue. Without it a restarted session is a
#    stranger: the owner asked his phone to carry on with the meal-plan
#    UI work and it had no idea what he meant, because the durable state
#    (repo, memory index) survives a restart and the conversation does
#    not.
#
# 3. The started pid is REMEMBERED. Windows reports a NULL CommandLine
#    for the first seconds of a hidden process, so a check made right
#    after launch sees nothing, calls the session missing, and starts a
#    SECOND one. That happened here twice over.
#
# Each restart appends a version number ("Mealplan and Tracker v3") so a
# new session reads as the next in a series rather than competing with
# the last one on the account list.
#
# The project list is local\remote-sessions.json, which git ignores: the
# owner's other projects are not this repo's business.

param(
    [ValidateSet('Ensure', 'Watch', 'Stop', 'Status')]
    [string]$Action = 'Ensure',
    [int]$EverySec = 60,
    [string]$ConfigPath = '',
    [string]$ClaudePath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) { $ConfigPath = Join-Path $repoRoot 'local\remote-sessions.json' }
if (-not $ClaudePath) { $ClaudePath = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
$statePath = Join-Path (Split-Path -Parent $ConfigPath) 'remote-sessions.state.json'

function Write-Line($msg) { Write-Host ((Get-Date -Format 'HH:mm:ss') + '  ' + $msg) }

function Get-Projects {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw ('No project list at ' + $ConfigPath) }
    return @((Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).projects)
}

function Get-State {
    if (-not (Test-Path -LiteralPath $statePath)) { return @{} }
    try {
        $o = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $h = @{}
        foreach ($n in $o.PSObject.Properties.Name) {
            $h[$n] = @{
                pid        = [int]$o.$n.pid
                version    = [int]$o.$n.version
                fails      = [int]$o.$n.fails
                startedAt  = [string]$o.$n.startedAt
                retryAfter = [string]$o.$n.retryAfter
            }
        }
        return $h
    } catch { return @{} }
}

function Set-State($h) {
    $o = New-Object PSObject
    foreach ($k in $h.Keys) {
        $v = [pscustomobject]@{
            pid        = $h[$k].pid
            version    = $h[$k].version
            fails      = $h[$k].fails
            startedAt  = $h[$k].startedAt
            retryAfter = $h[$k].retryAfter
        }
        $o | Add-Member -NotePropertyName $k -NotePropertyValue $v
    }
    $o | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding ASCII
}

# Live means: that pid is still a claude.exe. Never match by process NAME
# alone -- the desktop app owns a dozen processes called claude, and
# killing by name would take the owner's editor down with the session.
function Test-Live($procId) {
    if (-not $procId) { return $false }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    return [bool]($p -and $p.ProcessName -eq 'claude')
}

# A project's transcripts live in a folder named after its path with
# every non-alphanumeric character turned into a dash.
function Get-TranscriptDir($projectPath) {
    $slug = ($projectPath -replace '[^A-Za-z0-9]', '-')
    return (Join-Path $env:USERPROFILE (Join-Path '.claude\projects' $slug))
}

# --continue resumes the MOST RECENT conversation in the folder, which is
# not always a conversation nobody is using. Measured 2026-09-17: started
# for this repo while an interactive session was open here, it attached
# to that live session -- two processes on one transcript. So: if the
# newest transcript was written within FreshMin minutes, someone is in
# it, and this script leaves it alone rather than joining.
function Test-ProjectBusy($projectPath, $freshMin = 5) {
    $dir = Get-TranscriptDir $projectPath
    if (-not (Test-Path -LiteralPath $dir)) { return $false }
    $newest = Get-ChildItem -LiteralPath $dir -Filter *.jsonl -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $newest) { return $false }
    return ($newest.LastWriteTime -gt (Get-Date).AddMinutes(-$freshMin))
}

function Start-Session($p, $state) {
    if (-not (Test-Path -LiteralPath $p.path)) {
        Write-Line ('SKIP ' + $p.name + ': no folder at ' + $p.path)
        return $state
    }
    if (Test-ProjectBusy $p.path) {
        Write-Line ('SKIP ' + $p.name + ': someone is in that conversation right now')
        return $state
    }
    # Titles are UPPER CASE to match the ones the app already shows, and a
    # first start carries NO suffix. The version appears only when a
    # session has died and come back, which is the owner's rule: the
    # number is a record of a failure, not decoration.
    $version = 1
    $fails = 0
    if ($state.ContainsKey($p.name)) {
        $version = [int]$state[$p.name].version + 1
        $fails = [int]$state[$p.name].fails
    }
    $sessionName = $p.name.ToUpper()
    if ($version -gt 1) { $sessionName = $sessionName + ' v' + $version }
    $argLine = '--remote-control "' + $sessionName + '" --continue'
    try {
        $proc = Start-Process -FilePath $ClaudePath -ArgumentList $argLine -WorkingDirectory $p.path -WindowStyle Hidden -PassThru
        $state[$p.name] = @{
            pid        = $proc.Id
            version    = $version
            fails      = $fails
            startedAt  = (Get-Date).ToString('o')
            retryAfter = ''
        }
        Set-State $state
        Write-Line ('started "' + $sessionName + '"  pid ' + $proc.Id + '  (' + $p.path + ')')
    } catch {
        Write-Line ('FAILED to start ' + $p.name + ': ' + $_.Exception.Message)
    }
    return $state
}

# A session that dies within two minutes of starting did not "go offline",
# it failed to start -- a bad path, a CLI that will not launch, a config
# error. Restarting it every tick forever would spam the owner's account
# with dead session entries he has no way to delete, which is exactly the
# mess this script exists to prevent. So hold off: 1, 2, 4, 8, then 15
# minutes between attempts, and say so in the log. The hold NEVER becomes
# permanent -- a project that fails all night is still retried every 15
# minutes, because the owner's rule is that a session which goes down
# comes back.
function Test-ShouldHold($name, $state) {
    if (-not $state.ContainsKey($name)) { return $false }
    $e = $state[$name]
    $inv = [Globalization.CultureInfo]::InvariantCulture
    if ($e.retryAfter) {
        # This death is already counted; we are only waiting out the hold.
        if ((Get-Date) -lt [datetime]::Parse($e.retryAfter, $inv)) { return $true }
        return $false
    }
    if (-not $e.startedAt) { return $false }
    $lived = ((Get-Date) - [datetime]::Parse($e.startedAt, $inv)).TotalSeconds
    if ($lived -ge 120) {
        $e.fails = 0
        return $false
    }
    $e.fails = [int]$e.fails + 1
    $wait = [int][math]::Min(15, [math]::Pow(2, $e.fails - 1))
    $e.retryAfter = (Get-Date).AddMinutes($wait).ToString('o')
    Write-Line ('HOLD ' + $name + ': died ' + [int]$lived + 's after starting (failure ' +
                $e.fails + ') -- next try in ' + $wait + ' min')
    return $true
}

function Invoke-Ensure {
    $state = Get-State
    $started = 0
    foreach ($p in (Get-Projects)) {
        if ($state.ContainsKey($p.name) -and (Test-Live $state[$p.name].pid)) { continue }
        if (Test-ShouldHold $p.name $state) { Set-State $state; continue }
        $before = -1
        if ($state.ContainsKey($p.name)) { $before = $state[$p.name].pid }
        $state = Start-Session $p $state
        # Count what actually started. A skip (busy conversation, missing
        # folder) must not be reported as a start -- a count that lies is
        # how a silent failure reads as success.
        $after = -1
        if ($state.ContainsKey($p.name)) { $after = $state[$p.name].pid }
        if ($after -ne $before) { $started++ }
    }
    return $started
}

function Invoke-Status {
    $state = Get-State
    foreach ($p in (Get-Projects)) {
        if ($state.ContainsKey($p.name) -and (Test-Live $state[$p.name].pid)) {
            $shown = $p.name.ToUpper()
            if ([int]$state[$p.name].version -gt 1) { $shown = $shown + ' v' + $state[$p.name].version }
            Write-Host ('  ' + $p.name.PadRight(24) + ' running  pid ' + $state[$p.name].pid + '  as "' + $shown + '"')
        } else {
            Write-Host ('  ' + $p.name.PadRight(24) + ' NOT running')
        }
    }
}

function Invoke-Stop {
    $state = Get-State
    foreach ($p in (Get-Projects)) {
        if (-not $state.ContainsKey($p.name)) { continue }
        $id = $state[$p.name].pid
        if (Test-Live $id) {
            try {
                Stop-Process -Id $id -Force -ErrorAction Stop
                Write-Line ('stopped ' + $p.name + ' pid ' + $id)
            } catch {
                Write-Line ('could not stop ' + $p.name + ' pid ' + $id + ': ' + $_.Exception.Message)
            }
        }
    }
}

# The CLI updates itself in place. A session launched from the old binary
# keeps running the old build, which is harmless: it picks up the new one
# the next time it restarts on its own.
#
# This used to STOP every session when the binary changed, to cycle them
# onto the new build. Measured 2026-09-17, that fired three times in seven
# hours and each time it took down four conversations the owner was using,
# bumped every title a version, and left four more dead entries on his
# account that he cannot delete. The stamp is now recorded and logged and
# nothing is killed for it. A new build is a nicety; a live conversation
# is the product.
function Get-CliStamp {
    if (-not (Test-Path -LiteralPath $ClaudePath)) { return 'missing' }
    $f = Get-Item -LiteralPath $ClaudePath
    return ($f.LastWriteTimeUtc.ToString('o') + '|' + $f.Length)
}

switch ($Action) {
    'Status' { Invoke-Status }
    'Stop'   { Invoke-Stop }
    'Ensure' {
        $n = Invoke-Ensure
        Write-Line ('ensure: started ' + $n + ' session(s)')
        Start-Sleep -Seconds 2
        Invoke-Status
    }
    'Watch' {
        Write-Line ('watching ' + (Get-Projects).Count + ' project(s) every ' + $EverySec + 's')
        $stamp = Get-CliStamp
        Invoke-Ensure | Out-Null
        while ($true) {
            Start-Sleep -Seconds $EverySec
            $now = Get-CliStamp
            if ($now -ne $stamp) {
                Write-Line 'the claude CLI updated on disk -- live sessions keep the build they started with'
                $stamp = $now
            }
            $n = Invoke-Ensure
            if ($n -gt 0) { Write-Line ('restarted ' + $n + ' session(s) that had gone') }
        }
    }
}
