# comfy-teardown.ps1 - stop the managed ComfyUI a script's passes booted,
# and CHECK that stopping it worked. WORKPLAN 17q / 17q-b.
#
# `comfy-install.js --boot` opts into setManagedDetached(true) on purpose,
# so the backend outlives the script that started it and is there for the
# NEXT pass. That is right during a run and wrong the moment the run ends.
#
# Measured 2026-09-09: the overnight loop finished at 10:15 and the backend
# was still holding 27,844 MiB of the card's 32,607 at 11:31, at 0 percent
# utilisation, leaving about 4.7 GB for anything else. The owner found it
# by trying to play a game. Nothing in the product does this to a user
# (the panel spawns non-detached, so Windows' job object takes the child
# when the panel goes, and unload plus reapOrphan sit on top) -- it is
# the SCRIPT path, and the script path had no owner once the loop ended.
#
# The rule the dialog watchdog already follows: nothing a loop started for
# its own convenience may outlive it on a machine nobody is driving.
#
# WHY IT LIVES IN lib/, AND WHY IT VERIFIES. Three lessons, all paid for:
#
#  1. The 2026-09-09 fix was pasted into run-local-agent.ps1's
#     -PreflightOnly early exit -- the one path on which no pass has run
#     and no backend can exist. It was never reachable from a real
#     overnight loop, and stayed that way for a week while the queue's top
#     item was "confirm it worked".
#
#  2. NEXT UP item 1 asked a PASS to confirm the teardown, which no pass
#     can do: every unattended pass runs INSIDE the loop whose exit it is
#     asked to observe, so the line it looks for cannot exist yet. The
#     verdict has to be written by the thing being verified.
#
#  3. 17q-b, measured 2026-09-16: fixing it in the LOOP fixed the exits a
#     loop takes, and the owner does not take any of them. He runs
#     stop-local-agent.ps1, which Stop-Processes the loop -- and a killed
#     process runs no teardown, so the 27 GB morning came back by the one
#     path the detach message actually recommends. Hence one definition,
#     here, dot-sourced by both scripts; a third caller gets it free.
#
# The verdict keys on the managed backend's own PROCESS, not on a memory
# threshold, because the overnight loop leaves After Effects RUNNING by
# design (a cold launch costs the next pass minutes, and closing the dirty
# scratch project raises a modal that blocks the pass after it). So the
# card is legitimately not back at its floor when the loop ends, and a
# threshold would either cry wolf about AE or stay silent about a 27 GB
# ComfyUI. The delta is logged as information; the assertion is presence.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

# Reading what the card is holding. Dot-sourced here rather than assumed,
# so a caller that only wants the teardown gets a working one.
. (Join-Path $PSScriptRoot 'gpu-detect.ps1')

function Stop-AellLoopBackend {
    <#
      -Floor    a Get-AellGpuMemoryMB reading taken before any pass ran,
                or $null. Information only; the verdict never keys on it.
      -RepoRoot where scripts\comfy-install.js lives. Defaults to this
                file's own repo, which is right for every caller so far.
      -Log      how to emit a line. Defaults to Write-Host; the loop
                passes ${function:Write-Log} so the lines land in the
                night's log the owner reads in the morning.
    #>
    param(
        $Floor,
        [string]$RepoRoot = '',
        [scriptblock]$Log = $null
    )

    if (-not $RepoRoot) {
        $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    if (-not $Log) { $Log = { param($m) Write-Host ([string]$m) } }

    # The managed vendor root, as the driver spells it in a process path.
    # If setManagedRoot ever moves out of %APPDATA%\AE-Llama\vendor\comfy,
    # this fragment moves with it -- a check that silently matches nothing
    # is exactly the failure mode being fixed here, so it is asserted by
    # tests/test-loop-teardown.js against extension/js/settings.js.
    $fragment = 'AE-Llama\vendor\comfy'

    $before = Get-AellGpuMemoryMB
    $saidNone = $false
    try {
        $stopOut = & node (Join-Path $RepoRoot 'scripts\comfy-install.js') --stop 2>&1
        $said = @($stopOut) | Where-Object {
            [string]$_ -match 'stopped the managed|stopped the backend holding|no managed backend found|NOT killing it'
        }
        if ($said) {
            foreach ($line in $said) {
                & $Log ('Backend: ' + [string]$line)
                if ([string]$line -match 'no managed backend found') {
                    $saidNone = $true
                }
            }
        } else {
            & $Log 'Backend: --stop said nothing recognisable; check by hand.'
        }
    } catch {
        & $Log ('Could not stop the managed backend: ' + $_.Exception.Message)
    }

    # --- and now the part that makes it a verdict rather than a hope ---
    $after = Get-AellGpuMemoryMB
    $left = @(Get-AellGpuProcesses -PathFragment $fragment)

    if (-not $after) {
        & $Log ('Backend: card NOT VERIFIED -- no nvidia-smi reading. ' +
                'Check by hand that no AE-Llama python holds VRAM.')
        return
    }

    if ($before) {
        $freed = $before.UsedMB - $after.UsedMB
        & $Log ('GPU    : ' + $before.UsedMB + ' -> ' + $after.UsedMB +
                ' MiB used of ' + $after.TotalMB + ' (freed ' + $freed + ')')
    } else {
        & $Log ('GPU    : ' + $after.UsedMB + ' MiB used of ' +
                $after.TotalMB + ' after the stop')
    }
    if ($Floor) {
        # Usually positive, because After Effects is still running on
        # purpose. Logged so a morning reader can see the shape of what
        # is left rather than guess -- and worded for BOTH signs: the
        # first real run came out 698 MiB UNDER its own floor (the loop
        # started with a previous night's backend already on the card),
        # and "-698 MiB above it" is not a sentence anyone should have to
        # parse at 8am.
        $delta = $after.UsedMB - $Floor.UsedMB
        if ($delta -ge 0) {
            & $Log ('GPU    : floor was ' + $Floor.UsedMB + ' MiB; ' +
                    $delta + ' MiB still held above it (AE is still ' +
                    'running by design)')
        } else {
            & $Log ('GPU    : floor was ' + $Floor.UsedMB + ' MiB; the ' +
                    'card is ' + [Math]::Abs($delta) + ' MiB BELOW the ' +
                    'floor now -- something was already on it at launch')
        }
    }

    if ($left.Count -eq 0) {
        & $Log 'Backend: card is back -- no AE-Llama process left on the GPU.'
        return
    }

    # The loud case. Two different bugs land here and the log must say
    # which: --stop reporting nothing to stop while a process is plainly
    # on the card is the PID RECORD not surviving (measured 2026-09-06,
    # see scripts/lib/comfy-managed.js), not a failed kill.
    if ($saidNone) {
        & $Log ('Backend: STILL ON THE CARD and --stop found no record ' +
                'to stop -- the managed PID record did not survive.')
    } else {
        & $Log 'Backend: STILL ON THE CARD after --stop -- the kill did not take.'
    }
    foreach ($p in $left) {
        & $Log ('Backend:   pid ' + $p.ProcessId + '  ' + $p.Path)
    }
    & $Log ('Backend: the owner wakes up to a held GPU. Stop it by hand: ' +
            'node scripts\comfy-install.js --stop')
}
