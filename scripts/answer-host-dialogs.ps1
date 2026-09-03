# answer-host-dialogs.ps1 - clear the modal After Effects or Premiere is
# sitting on, right now, without starting a self-test or a loop.
#
#   powershell -ExecutionPolicy Bypass -File scripts\answer-host-dialogs.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\answer-host-dialogs.ps1 -Watch
#   powershell -ExecutionPolicy Bypass -File scripts\answer-host-dialogs.ps1 -WhatIsUp
#
# Why this exists as its own script. The dialog answering was built twice
# INSIDE run-ae-selftest.ps1 -- once before its launch, once during its
# wait loop -- and both times it missed the case the owner kept hitting,
# because nothing in this repo asks After Effects to quit. The prompt
#
#     Save changes to "Untitled Project.aep" before closing?
#
# was appearing when no self-test was running, so no code of ours was
# looking. run-local-agent.ps1 now carries a watchdog for the whole life
# of an overnight loop; this is the same thing for a machine that is NOT
# in a loop, or for clearing one that is up this second.
#
# The rules are the shared ones (scripts/lib/host-dialogs.ps1), so the
# rail is the same: a save prompt is answered "Don't Save" only for a
# project this harness created, and any OTHER project's prompt is
# CANCELLED -- which unblocks the host and keeps every unsaved change.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

[CmdletBinding()]
param(
    # Keep answering until stopped with Ctrl-C, instead of once.
    [switch]$Watch,
    [int]$EverySec = 10,
    # Answer NOTHING. Just print what each host is showing, with the
    # exact label of every button on it. Use this before adding a rule,
    # or when a dialog is not being answered and you need its real
    # strings rather than a guess at them.
    [switch]$WhatIsUp
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\host-dialogs.ps1')

# Every project name this repo's scripts create and therefore own. Keep
# in step with the callers:
#   Untitled Project     AE's cold-launch project (the self-test never saves)
#   mogrt-probe-scratch  scripts/mogrt-verify-probe.jsx saves this itself
#   AELL_PROBE_SCRATCH   scripts/run-ppro-probe.ps1 saves this itself
# Anything not on this list is somebody's work: no rule discards it.
$owned = @('Untitled Project', 'mogrt-probe-scratch', 'AELL_PROBE_SCRATCH')
$procs = @('AfterFX', 'Adobe Premiere Pro', 'Adobe Premiere')

$live = @()
foreach ($p in $procs) {
    if (@(Get-Process -Name $p -ErrorAction SilentlyContinue).Count -gt 0) {
        $live += $p
    }
}
if ($live.Count -eq 0) {
    Write-Host 'Neither After Effects nor Premiere is running. Nothing to do.'
    exit 0
}
Write-Host ('Running: ' + ($live -join ', '))

if ($WhatIsUp) {
    Write-Host 'Reading dialogs only. Nothing will be clicked.'
    Write-AellUnknownDialogs -ProcessNames $procs
    Write-Host ''
    Write-Host 'If a dialog above is not being answered automatically, add a'
    Write-Host 'rule to Get-AellDialogRules in scripts\lib\host-dialogs.ps1'
    Write-Host 'using the text and button labels exactly as printed.'
    exit 0
}

function Sweep {
    $n = Answer-AellKnownDialogs -ProcessNames $procs -OwnedProjects $owned
    if ($n -gt 0) {
        Write-Host ((Get-Date -Format 'HH:mm:ss') + '  answered ' + $n +
                    ' dialog(s)') -ForegroundColor Green
    }
    return $n
}

if (-not $Watch) {
    $n = Sweep
    if ($n -eq 0) {
        Write-Host 'Nothing matched. What the hosts are actually showing:'
        Write-AellUnknownDialogs -ProcessNames $procs
        Write-Host ''
        Write-Host 'No output above that line means no dialog is up at all.'
        exit 1
    }
    exit 0
}

Write-Host ('Watching every ' + $EverySec + 's. Ctrl-C to stop.')
Write-Host 'A prompt for a project this harness did not create is CANCELLED,'
Write-Host 'never discarded -- it keeps its changes and the host unblocks.'
while ($true) {
    [void](Sweep)
    Start-Sleep -Seconds $EverySec
}
