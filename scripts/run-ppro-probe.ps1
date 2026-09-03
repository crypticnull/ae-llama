# run-ppro-probe.ps1 - measure Premiere UNATTENDED. One command, one
# launch, one report. Nobody clicks anything in Premiere.
#
#   powershell -ExecutionPolicy Bypass -File scripts\run-ppro-probe.ps1
#
# How it works: a job file is dropped in %APPDATA%\AE-Llama\probes\, then
# Premiere is launched. TWO independent things race to claim that job,
# so a failure in either one still produces a result:
#
#   1. the visible probe panel, which Premiere reopens because it is in
#      the saved workspace, and
#   2. the invisible door-3 runner, which fires on the host's startup
#      event whether or not any panel is open.
#
# Whichever claims it first (renameSync is atomic) runs the WHOLE
# battery -- host facts, QE, undo/History, sequence creation, MOGRT
# accept read-back -- and writes job-result.json. Every step inside the
# battery is independently try/caught, so one pass reports ALL of its
# failures instead of one per launch. That is the entire design goal:
# this project spent a day learning one defect per round trip on the
# only machine that can test.
#
# Exit codes: 0 = every battery step passed, 1 = ran but some steps
# failed (the report says which), 2 = Premiere not found, 3 = no result
# (neither door claimed the job -- Premiere cannot be driven this way),
# 4 = prerequisites missing.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

[CmdletBinding()]
param(
    [string]$PremierePath = '',
    [int]$TimeoutSec = 300,
    # Premiere reads extensions at LAUNCH, so a running instance never
    # sees a new job. Closing is graceful (CloseMainWindow): if Premiere
    # asks to save something, this script gives up rather than forcing.
    [switch]$NoClose,
    # Leave Premiere open when the run finishes.
    [switch]$KeepOpen,
    [switch]$SkipInstall,
    [string]$MogrtPath = '',
    # Names of battery steps to skip, for when a previous run reported one
    # of them as HUNG. e.g. -Skip mogrt,history
    [string[]]$Skip = @()
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\json-io.ps1')
. (Join-Path $PSScriptRoot 'lib\host-dialogs.ps1')

$repoRoot  = Split-Path -Parent $PSScriptRoot
$probeData = Join-Path $env:APPDATA 'AE-Llama\probes'
$jobFile   = Join-Path $probeData 'job.json'
$runFile   = Join-Path $probeData 'job.running.json'
$resFile   = Join-Path $probeData 'job-result.json'
$scratch   = Join-Path $probeData 'AELL_PROBE_SCRATCH.prproj'

New-Item -ItemType Directory -Force -Path $probeData | Out-Null

function Say([string]$m) { Write-Host $m }
function Good([string]$m) { Write-Host $m -ForegroundColor Green }
function Bad([string]$m) { Write-Host $m -ForegroundColor Red }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }

# The projects THIS script may answer a save-changes prompt for. Note
# that it is a NAME, not "untitled": this script saves its scratch
# project with saveAs to $scratch, on purpose, so Premiere's prompt
# carries AELL_PROBE_SCRATCH and never the word Untitled. That is the
# whole reason Get-AellDialogRules takes the owned names from the caller
# instead of hardcoding a word -- the AE runner's projects genuinely are
# untitled, and this one's genuinely are not.
$script:AellOwnedProjects = @([System.IO.Path]::GetFileNameWithoutExtension($scratch))
$script:AellHostProcesses = @('Adobe Premiere Pro', 'Adobe Premiere')

<#
  Close the Premiere WE started, and do not sit on a modal.

  CloseMainWindow() is polite: if Premiere asks "save changes?" it waits
  for an answer that is never coming, and an unattended pass just burns
  its whole budget staring at a dialog.

  Forcing it was the old answer, and it was a bad one: a forced close is
  precisely what makes the NEXT launch open a crash-recovery prompt, so
  one unanswerable dialog cost this pass 20 s AND started the next pass
  behind a second dialog. Now the prompt gets ANSWERED -- Don't Save, on
  a dialog that names this script's own scratch project and nothing
  else. The grace wait and the force are still there behind it, because
  a dialog no rule matches must not become a hang either; but the force
  is now the last resort it was always described as, rather than the
  usual path.
#>
function Stop-OurPremiere {
    param($Proc, [int]$GraceSec = 20)
    if (-not $Proc) { return }
    try { if ($Proc.HasExited) { return } } catch { return }

    try { [void]$Proc.CloseMainWindow() } catch {}
    $deadline = (Get-Date).AddSeconds($GraceSec)
    $tried = 0
    while ((Get-Date) -lt $deadline) {
        try { if ($Proc.HasExited) { Say 'Premiere closed.'; return } } catch { return }
        Start-Sleep -Milliseconds 500
        # Give the prompt a moment to appear before reaching for it, and
        # cap the attempts so a dialog that regenerates cannot spin out
        # the whole grace window clicking at it.
        if ($tried -lt 3 -and ((Get-Date) -gt $deadline.AddSeconds(-$GraceSec + 3))) {
            $n = Answer-AellKnownDialogs `
                   -ProcessNames $script:AellHostProcesses `
                   -OwnedProjects $script:AellOwnedProjects
            if ($n -gt 0) { $tried++ }
        }
    }

    Say ("Premiere did not close in " + $GraceSec + "s and no rule matched " +
         "what it is showing. Forcing OUR instance, PID " + $Proc.Id + ".")
    # Say what it IS before killing it: a forced close leaves a recovery
    # prompt for the next launch, so the dialog that caused this needs to
    # reach the log as real strings, not as an inference.
    Write-AellUnknownDialogs -ProcessNames $script:AellHostProcesses
    try {
        Stop-Process -Id $Proc.Id -Force -ErrorAction Stop
        Say 'Forced.'
    } catch {
        Warn ("Could not force-close PID " + $Proc.Id + ": " +
              $_.Exception.Message)
    }
}

function Get-PremiereProcesses {
    return @(Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue) +
           @(Get-Process -Name 'Adobe Premiere' -ErrorAction SilentlyContinue)
}

# ------------------------------------------------------------ find the app
if (-not $PremierePath) {
    $adobe = 'C:\Program Files\Adobe'
    if (Test-Path $adobe) {
        $dirs = Get-ChildItem $adobe -Directory |
            Where-Object { $_.Name -like 'Adobe Premiere*' } |
            Sort-Object Name -Descending
        foreach ($d in $dirs) {
            foreach ($exeName in @('Adobe Premiere Pro.exe', 'Adobe Premiere.exe')) {
                $exe = Join-Path $d.FullName $exeName
                if (Test-Path $exe) { $PremierePath = $exe; break }
            }
            if ($PremierePath) { break }
        }
    }
}
if (-not $PremierePath -or -not (Test-Path $PremierePath)) {
    Bad 'Premiere not found. Pass -PremierePath "C:\...\Adobe Premiere Pro.exe".'
    exit 2
}
Say "Premiere: $PremierePath"

# --------------------------------------------------------------- install
if (-not $SkipInstall) {
    Say 'Installing the probe and the door-3 runner...'
    & powershell -ExecutionPolicy Bypass -File `
        (Join-Path $PSScriptRoot 'install-probe.ps1') -Harness | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Bad 'install-probe.ps1 failed; run it on its own to see why.'
        exit 4
    }
    Good 'Installed.'
}

# ------------------------------------------------- pick a REAL .mogrt
# logs\mogrt-verify\ is a TEST folder: it holds deliberately damaged
# fixtures beside real exports, and picking the newest one landed on
# truncated.mogrt, which Premiere then silently refused. Validate first.
function Test-Capsule([string]$p) {
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $zip = [System.IO.Compression.ZipFile]::OpenRead($p)
        try {
            $has = $false
            foreach ($e in $zip.Entries) {
                if ($e.FullName -eq 'definition.json') { $has = $true }
            }
            return $has
        } finally { $zip.Dispose() }
    } catch {
        return $false
    }
}

if (-not $MogrtPath) {
    $mogrtDir = Join-Path $repoRoot 'logs\mogrt-verify'
    if (Test-Path $mogrtDir) {
        $cands = Get-ChildItem $mogrtDir -Filter *.mogrt -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending
        foreach ($c in $cands) {
            $okCap = Test-Capsule $c.FullName
            Say ("  " + $(if ($okCap) { 'usable ' } else { 'damaged' }) + "  " + $c.Name)
            if ($okCap -and -not $MogrtPath) { $MogrtPath = $c.FullName }
        }
    }
}
if ($MogrtPath) {
    Good "MOGRT to test: $MogrtPath"
} else {
    Warn 'No usable .mogrt found - the MOGRT step will be skipped.'
    Warn 'Export one from the AE panel to measure Premiere acceptance.'
}

# ------------------------------------------------------------ the job
# Clear every breadcrumb, or a stale one from the last run reads as this
# run's result.
Remove-Item $resFile, $runFile,
            (Join-Path $probeData 'job-claimed.json'),
            (Join-Path $probeData 'job-progress.json') -ErrorAction SilentlyContinue
$job = [ordered]@{
    probeJsx       = ((Join-Path $repoRoot 'probe\com.cptk.aellama.probe\jsx\probe.jsx') -replace '\\', '/')
    probe          = 'battery'
    allowMutate    = $true
    scratchProject = ($scratch -replace '\\', '/')
    makeSequence   = $true
    # A still the repo already ships. createNewSequenceFromClips derives
    # the sequence from a clip, so it needs no preset and opens no
    # dialog - unlike newBarsAndTone, which answered "Illegal Parameter
    # type" to every timebase tried on 26.3.2.
    seedMedia      = ((Join-Path $repoRoot 'extension\icons\icon-normal.png') -replace '\\', '/')
    readyTimeoutMs = 30000
    skip           = $Skip
    mogrtPath      = $(if ($MogrtPath) { $MogrtPath -replace '\\', '/' } else { $null })
    createdAt      = (Get-Date).ToString('o')
}
# Write-AellJson, never Set-Content -Encoding UTF8: on Windows
# PowerShell 5.1 that writes a BOM, JSON.parse throws on it, and the CEP
# claimer died in a silent catch AFTER consuming the job. Two unattended
# runs produced nothing because of this one line.
Write-AellJson -Path $jobFile -Object $job -Depth 5
Say "Job written: $jobFile"
Say 'Everything mutating happens in a scratch project, never in yours.'

# ------------------------------------------------------- restart Premiere
$running = Get-PremiereProcesses
if ($running.Count -gt 0) {
    if ($NoClose) {
        Warn 'Premiere is already running and -NoClose was passed. It will not'
        Warn 'see the job: extensions load at launch. Quit it and re-run.'
        exit 4
    }
    Say 'Premiere is running; asking it to quit (it will prompt if unsaved)...'
    foreach ($p in $running) { [void]$p.CloseMainWindow() }
    $deadline = (Get-Date).AddSeconds(45)
    $tried = 0
    while ((Get-Date) -lt $deadline -and (Get-PremiereProcesses).Count -gt 0) {
        Start-Sleep -Milliseconds 700
        # A save prompt naming OUR scratch project is one a previous pass
        # left, so answering it is not a liberty. Deliberately still no
        # force here, unlike Stop-OurPremiere: this instance may be one
        # the owner started, holding their work, and a prompt naming
        # THEIR project matches no rule and is left alone for them.
        if ($tried -lt 3) {
            $n = Answer-AellKnownDialogs `
                   -ProcessNames $script:AellHostProcesses `
                   -OwnedProjects $script:AellOwnedProjects
            if ($n -gt 0) { $tried++ }
        }
    }
    if ((Get-PremiereProcesses).Count -gt 0) {
        Bad 'Premiere did not quit - it is probably asking to save something.'
        Bad 'Answer that dialog, then re-run this script. Nothing was forced.'
        Bad 'What it is showing, in its own words:'
        Write-AellUnknownDialogs -ProcessNames $script:AellHostProcesses
        exit 4
    }
    Good 'Premiere closed.'
}

# Launch Premiere PLAIN, with no project argument.
#
# Measured 2026-09-02: app.newProject returned but wrote no file (its
# name and path both read back empty), so Premiere kept a path in its
# recent list that does not exist and greeted the NEXT launch with
# "the file path does not exist at this location" - a modal, on open,
# with nobody there. Handing Premiere a project path is a liability with
# no upside now: waitForReady plus the reuse-the-open-empty-project rule
# gets a usable project without creating one.
# A scratch project that REALLY EXISTS is passed on the command line; a
# stale or empty one is deleted first.
#
# Both halves were learned the hard way on 2026-09-02. app.newProject
# returned without writing a file, so Premiere kept a dead path in its
# recent list and greeted the next launch with "the file path does not
# exist at this location" - a modal, on open, with nobody there. Then
# launching PLAIN turned out to be worse: Premiere sits on the Home
# screen and never opens a project at all, so app.project.name stayed
# empty for the full 30s wait and every project-dependent step failed.
#
# So: create it once (the battery does that and saves it), and from then
# on hand it to Premiere directly.
$haveScratch = $false
if (Test-Path $scratch) {
    $size = (Get-Item $scratch).Length
    if ($size -lt 1024) {
        Say "Deleting a stale scratch project ($size bytes) - Premiere would"
        Say 'greet the next launch with a "file path does not exist" modal.'
        Remove-Item $scratch -Force -ErrorAction SilentlyContinue
    } else {
        $haveScratch = $true
    }
}
# -PassThru so the PID is known. Everything that force-closes below
# targets THIS process and no other: an instance the owner started, with
# their own work in it, must never be killed by this script.
if ($haveScratch) {
    Say 'Launching Premiere with the scratch project...'
    $ours = Start-Process -FilePath $PremierePath -ArgumentList @($scratch) -PassThru
} else {
    Say 'Launching Premiere (no scratch project yet: the battery makes one)...'
    $ours = Start-Process -FilePath $PremierePath -PassThru
}

# ------------------------------------------------------------- wait
Say ("Waiting up to " + $TimeoutSec + "s for a result (first launch is slow)...")
$started = Get-Date
$deadline = $started.AddSeconds($TimeoutSec)
$lastTick = 0
while ((Get-Date) -lt $deadline) {
    if (Test-Path $resFile) { Start-Sleep -Milliseconds 800; break }
    Start-Sleep -Milliseconds 1000
    $elapsed = [int](((Get-Date) - $started).TotalSeconds)
    if ($elapsed - $lastTick -ge 20) {
        $lastTick = $elapsed
        $claimed = if (Test-Path $runFile) { ' (job claimed, running)' } else { '' }
        Say ("  ... " + $elapsed + "s" + $claimed)
    }
}

if (-not (Test-Path $resFile)) {
    Bad ''
    Bad 'No result.'
    Say ''

    # The progress file is written BEFORE each step runs, so it names the
    # step that never returned. Without this the only output was "it hung
    # somewhere", which is what the first version of this script produced
    # after 300 seconds of waiting.
    $claimFile = Join-Path $probeData 'job-claimed.json'
    $progFile  = Join-Path $probeData 'job-progress.json'
    if (Test-Path $claimFile) {
        try {
            $c = Read-AellJson -Path $claimFile
            Say ("Claimed by: " + $c.via + "  (host " + $c.host + ", at " + $c.at + ")")
        } catch { Say "Claim file present but unreadable." }
    } else {
        Say 'Nothing claimed the job: no claim breadcrumb was written.'
    }

    if (Test-Path $progFile) {
        try {
            $pr = Read-AellJson -Path $progFile
            Say ''
            Say '-- how far it got'
            foreach ($s in $pr.steps) {
                if ($s.skipped) { Say ("  skip  " + $s.step) }
                elseif ($s.ok)  { Say ("  ok    " + $s.step) }
                else            { Bad ("  FAIL  " + $s.step + " : " + $s.error) }
            }
            if ($pr.current) {
                Bad ("  HUNG  " + $pr.current + "  <-- this step never returned")
                Say ''
                Say ("Re-run skipping it:  ... run-ppro-probe.ps1 -Skip " + $pr.current)
            }
        } catch { Say "Progress file present but unreadable: $progFile" }
    } else {
        Say 'No progress file - the battery never started a step.'
    }

    Say ''
    Say 'What to check:'
    if (Test-Path $runFile) {
        Say '  - the job WAS claimed but never finished: look in Premiere'
        Say '    for a modal dialog sitting behind the main window.'
    } else {
        Say '  - the job was never claimed, so neither the visible panel nor'
        Say '    the invisible runner loaded. Either the panel is not in'
        Say '    Premiere''s saved workspace (open it once, leave it open,'
        Say '    quit Premiere, re-run this), or the startup event does not'
        Say '    fire on this build.'
    }
    Say '  - scripts\probe-doctor.ps1 reads what CEP logged about both.'
    if (-not $KeepOpen) { Stop-OurPremiere -Proc $ours }
    exit 3
}

# ------------------------------------------------------------- report
Good ''
Good 'Result received.'
$res = $null
try { $res = Read-AellJson -Path $resFile } catch {
    Bad "The result file is not readable JSON: $($_.Exception.Message)"
    exit 1
}

Say ''
# The two claimers write different shapes: the visible panel nests host
# facts under .panel, the invisible runner under .host. Reading only one
# printed a blank "host:   claimed by:" line on the first successful run.
$hostName = $null; $hostVer = $null; $claimedBy = $null
if ($res.panel) { $hostName = $res.panel.appName; $hostVer = $res.panel.appVersion }
elseif ($res.host) { $hostName = $res.host.appName; $hostVer = $res.host.appVersion }
if ($res.job -and $res.job.via) { $claimedBy = $res.job.via }
elseif ($res.via) { $claimedBy = $res.via }
Say ("host: " + $(if ($hostName) { "$hostName $hostVer" } else { '(not recorded)' }) +
     "   claimed by: " + $(if ($claimedBy) { $claimedBy } else { '(not recorded)' }))
Say ''

$failedSteps = 0
$battery = $null
if ($res.battery) { $battery = $res.battery }
elseif ($res.parsed -and $res.parsed.data) { $battery = $res.parsed.data }

# Print WHAT WAS MEASURED, not just which steps ran. The first
# successful run printed eight "ok" lines and nothing else, so the
# actual findings still had to be dug out of a JSON file by hand -
# which is exactly the sort of extra step this script exists to remove.
function Show-Fact([string]$label, $value) {
    if ($null -eq $value -or "$value" -eq '') { return }
    Say ("        " + $label.PadRight(26) + "$value")
}

if ($battery -and $battery.steps) {
    Say '-- battery'
    foreach ($s in $battery.steps) {
        if ($s.skipped) { Say ("  skip  " + $s.step); continue }
        if (-not $s.ok) {
            $failedSteps++
            Bad ("  FAIL  " + $s.step + " : " + $s.error)
            continue
        }
        Say ("  ok    " + $s.step)
        $d = $s.data
        if ($null -eq $d) { continue }

        switch ($s.step) {
            'ping' {
                Show-Fact 'ExtendScript' ("$($d.esVersion) build $($d.esBuild)")
                Show-Fact 'engine' $d.engineName
            }
            'hostFacts' {
                Show-Fact 'app version' $d.appVersion
                Show-Fact 'BridgeTalk name' $d.btAppName
                Show-Fact 'BridgeTalk specifier' $d.btSpecifier
                Show-Fact 'beginUndoGroup' $d.beginUndoGroup
                Show-Fact 'executeCommand' $d.executeCommand
                Show-Fact 'AME status' $d.ameStatus
                if ($d.btTargets) { Show-Fact 'BridgeTalk targets' ($d.btTargets -join ' ') }
            }
            'qe' {
                Show-Fact 'enableQE' $d.enableQE
                Show-Fact 'qe.project' $d.qeProject
                Show-Fact 'QE version' $d.qeVersion
                Show-Fact 'effects listed' $d.effectCount
            }
            'waitForReady' {
                Show-Fact 'ready' $d.ready
                Show-Fact 'waited (ms)' $d.waitedMs
                Show-Fact 'project name' $d.projectName
                Show-Fact 'note' $d.note
            }
            'project' {
                Show-Fact 'via' $d.via
                Show-Fact 'name' $d.name
                Show-Fact 'path' $d.path
                Show-Fact 'items' $d.items
                Show-Fact 'saved to' $d.savedTo
                Show-Fact 'note' $d.note
                foreach ($t in $d.tried) {
                    $mark = if ($t.ok) { 'WORKED ' } else { 'failed ' }
                    Say ("        " + $mark + $t.how +
                         $(if ($t.error) { " -- " + $t.error } else { '' }))
                }
            }
            'sequence' {
                Show-Fact 'via' $d.via
                Show-Fact 'active sequence' $d.active
                Show-Fact 'video tracks' $d.videoTracks
                foreach ($t in $d.tried) {
                    $mark = if ($t.ok) { 'WORKED ' } else { 'failed ' }
                    Say ("        " + $mark + $t.how +
                         $(if ($t.error) { " -- " + $t.error } else { '' }))
                }
            }
            'history' {
                Show-Fact 'mutated' $d.mutated
                if ($d.created) { Show-Fact 'created' ($d.created -join ', ') }
                Show-Fact 'skipped' $d.skipped
                Show-Fact 'error' $d.error
            }
            'mogrt' {
                Show-Fact 'clips before / after' ("$($d.before) -> $($d.after)")
                Show-Fact 'LANDED' $d.landed
                Show-Fact 'clip name' $d.clipName
                Show-Fact 'controllers' $d.controllerCount
                Show-Fact 'names readable' $d.namesReadable
                Show-Fact 'error' $d.error
                if ($d.controllers) {
                    foreach ($c in $d.controllers) {
                        Say ("          - " + $c.name + " = " + $c.value)
                    }
                }
            }
            'cleanup' {
                if ($d.removed) { Show-Fact 'removed' ($d.removed -join ', ') }
                Show-Fact 'scratch project saved' $d.savedScratchProject
            }
        }
    }
} else {
    Warn 'The result carries no battery steps - see the raw file.'
    $failedSteps++
}

# And keep a copy in the repo, so the measurements are committed with
# everything else instead of living only in AppData.
try {
    $measuredDir = Join-Path $repoRoot 'docs\measured'
    New-Item -ItemType Directory -Force -Path $measuredDir | Out-Null
    $stamp = (Get-Date).ToString('yyyy-MM-dd-HHmm')
    $copy = Join-Path $measuredDir ("ppro-probe-" + $stamp + ".json")
    Copy-Item $resFile $copy -Force
    Say ''
    Say "Copied into the repo: $copy"
} catch {
    Warn "Could not copy the result into docs\measured: $($_.Exception.Message)"
}

Say ''
Say "Full result: $resFile"
Say 'Grade it with:  node scripts\ppro-probe-report.js'

if (-not $KeepOpen) {
    Say ''
    Say 'Closing Premiere...'
    Stop-OurPremiere -Proc $ours
}

if ($failedSteps -gt 0) {
    Say ''
    Warn ("$failedSteps step(s) failed. They are listed above, ALL of them,")
    Warn 'from one launch - paste this output and they get fixed together.'
    exit 1
}
Good ''
Good 'Every battery step passed.'
exit 0
