# stop-local-agent.ps1 - stop the detached overnight loop, for real.
#
#   powershell -ExecutionPolicy Bypass -File scripts\stop-local-agent.ps1
#
# Why this exists: run-local-agent.ps1 prints a PID at launch and writes
# one to logs\local-agent.pid, and neither is reliable to kill by hand.
# The printed PID comes from the WMI spawn and can be stale by the time
# anyone reads it; the pid file is only as fresh as the last launch. So
# `Stop-Process -Id <that number>` cheerfully reports success having
# killed nothing, which is what happened on 2026-09-02.
#
# This finds the loop by COMMAND LINE instead, which cannot go stale,
# and also stops any `claude` pass already in flight -- killing the loop
# shell alone leaves its current child running to completion.
#
# It prints what it killed and what is left, so "it did nothing" is
# never a silent outcome.
#
# AND IT STOPS THE BACKEND (17q-b, 2026-09-16). The loop tears the managed
# ComfyUI down on its own three exits -- and none of those is how a night
# gets cut short. A `Stop-Process` from outside runs no teardown, so until
# today the documented way to stop the loop left a detached ComfyUI
# holding the card: exactly the 27,844-MiB morning of 17q, reached by the
# one path the detach message actually recommends. The word `comfy`
# appeared zero times in this file. The verdict itself is shared with the
# loop (scripts\lib\comfy-teardown.ps1), because two copies of it is how
# one of them ends up in the wrong branch again.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

[CmdletBinding()]
param(
    # Leave a running pass alone and only stop the loop, so no further
    # passes start after the current one finishes.
    [switch]$KeepCurrentPass,

    # Leave the managed ComfyUI running. For the one case where stopping
    # it is wrong: cutting a night short while deliberately keeping a
    # booted backend for whatever comes next. The default is to stop it,
    # because the default reason to run this script is "I want my machine
    # back" and a 27 GB leak is not that.
    [switch]$KeepBackend
)

$ErrorActionPreference = 'Continue'

. (Join-Path $PSScriptRoot 'lib\claude-procs.ps1')
. (Join-Path $PSScriptRoot 'lib\comfy-teardown.ps1')

function Find-Loop {
    return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" `
             -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like '*run-local-agent*' })
}

$loops = Find-Loop

# Collect the in-flight passes NOW, while their parent loops are still
# alive. Once a loop shell is killed its children are reparented and the
# descent walk can no longer find them -- which would silently turn
# "stopped both" into "stopped the loop, left the pass running", the
# exact failure this script was written for.
$passesInFlight = @()
if (-not $KeepCurrentPass) {
    foreach ($p in $loops) {
        $passesInFlight += @(Get-AellCliPassProcesses -RootId $p.ProcessId)
    }
}

if ($loops.Count -eq 0) {
    Write-Host 'No overnight loop is running.'
} else {
    foreach ($p in $loops) {
        Write-Host ("Stopping loop PID " + $p.ProcessId)
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Host ("  could not stop it: " + $_.Exception.Message)
        }
    }
}

if (-not $KeepCurrentPass) {
    # By DESCENT from each loop we just found, never by name.
    #
    # This used to be `Get-Process claude` and kill them all. The Claude
    # DESKTOP APP is Electron: one running copy is a main process plus
    # renderer, GPU and utility children, all named claude -- ten or
    # eleven of them while the owner is chatting in it. So "stop the
    # loop" also closed the window the owner was talking to us in.
    #
    # A pass in flight is a descendant of a loop shell. Nothing else is.
    $passes = $passesInFlight
    if ($passes.Count -eq 0) {
        Write-Host 'No claude pass in flight.'
    } else {
        foreach ($c in $passes) {
            Write-Host ("Stopping CLI pass PID " + $c.ProcessId)
            try {
                Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop
            } catch {
                Write-Host ("  could not stop it: " + $_.Exception.Message)
            }
        }
    }
    $desktop = @(Get-AellProcessTable |
                 Where-Object { [string]$_.Name -match '^claude' -and
                                (Test-AellDesktopApp -Proc $_) })
    if ($desktop.Count -gt 0) {
        Write-Host ("Left the Claude desktop app alone (" + $desktop.Count +
                    " processes). It is not part of the loop.")
    }
} else {
    Write-Host 'Leaving the current pass to finish (-KeepCurrentPass).'
}

Start-Sleep -Milliseconds 800

# 17q-b. After the processes are down, not before: a pass killed mid-boot
# can still be bringing a backend up, and the record it leaves is what
# --stop reads. Unconditional on whether a loop was found -- the case that
# cost the owner his morning was a backend with no loop left to own it.
Write-Host ''
if ($KeepBackend) {
    Write-Host 'Leaving the managed backend running (-KeepBackend).'
} else {
    Stop-AellLoopBackend -RepoRoot (Split-Path -Parent $PSScriptRoot)
}

$left = Find-Loop
Write-Host ''
if ($left.Count -eq 0) {
    Write-Host 'Loop stopped. Nothing left running.' -ForegroundColor Green
    exit 0
}
Write-Host 'STILL RUNNING:' -ForegroundColor Red
foreach ($p in $left) {
    Write-Host ("  PID " + $p.ProcessId + "  " + $p.CommandLine)
}
Write-Host 'Try an elevated PowerShell if these will not stop.'
exit 1
