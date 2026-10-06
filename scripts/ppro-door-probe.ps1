# ppro-door-probe.ps1 - measure the three candidate HEADLESS DOORS into
# Premiere. P0 step 4 of docs\PREMIERE_PLAN.md; closes WORKPLAN item 11.
#
#   powershell -ExecutionPolicy Bypass -File scripts\ppro-door-probe.ps1
#   ... -Door 1              only the BridgeTalk door
#   ... -AllowAdminWrite     let door 2 create extendscriptprqe.txt
#   ... -ClosePremiere       let door 2 and 3 quit a running Premiere
#   ... -Census              photograph Premiere's windows while waiting
#
# The doors, in the order this script tries them:
#
#   1. BridgeTalk from an AfterFX.exe -r script to a RUNNING Premiere.
#      Cheapest by far if it answers: the existing AE harness gains a
#      second host with no install change and no restart.
#   2. "Adobe Premiere Pro.exe" /C es.processFile <jsx>, which needs a
#      file named extendscriptprqe.txt beside the executable. Launch-only
#      (each pass restarts Premiere) and Adobe calls it unsupported.
#   3. The dev-only invisible CEP extension (install-probe.ps1 -Harness),
#      which claims a job file at host launch and writes a result.
#
# ALL THREE EXECUTE EXTENDSCRIPT, whose support Adobe's own scripting
# guide says runs "through September 2026". A door that answers today is
# a bridge, not a foundation - that caveat belongs in whatever this
# result is used to justify.
#
# Exit codes: 0 = at least one door answered, 2 = Premiere not found
# (nothing measured), 3 = every door measured DEAD (a real finding),
# 4 = prerequisites missing for every door (nothing measured).
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

[CmdletBinding()]
param(
    [ValidateSet('1', '2', '3', 'all')]
    [string]$Door = 'all',
    [string]$PremierePath = '',
    [string]$AfterFXPath = '',
    [int]$TimeoutSec = 120,
    [switch]$AllowAdminWrite,
    [switch]$ClosePremiere,
    [switch]$Census
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\json-io.ps1')

$repoRoot  = Split-Path -Parent $PSScriptRoot
$probeData = Join-Path $env:APPDATA 'AE-Llama\probes'
New-Item -ItemType Directory -Force -Path $probeData | Out-Null

$results = New-Object System.Collections.ArrayList

function Add-Door([hashtable]$row) {
    [void]$results.Add([pscustomobject]$row)
    $verdict = $row.verdict
    $color = 'Yellow'
    if ($verdict -eq 'ALIVE') { $color = 'Green' }
    if ($verdict -eq 'DEAD') { $color = 'Red' }
    Write-Host ("door " + $row.door + ": " + $verdict + " - " + $row.detail) `
        -ForegroundColor $color
}

function Save-Results {
    $file = Join-Path $probeData 'doors.json'
    $payload = [pscustomobject]@{
        takenAt = (Get-Date).ToString('o')
        premierePath = $PremierePath
        afterFXPath = $AfterFXPath
        doors = @($results)
    }
    Write-AellJson -Path $file -Object $payload -Depth 6
    Write-Host ''
    Write-Host "Written to $file"
}

function Wait-ForFile([string]$path, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $path) {
            # Let the writer finish before anyone reads it.
            Start-Sleep -Milliseconds 400
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-PremiereProcesses {
    return @(Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue) +
           @(Get-Process -Name 'Adobe Premiere' -ErrorAction SilentlyContinue)
}

# Wait for Premiere to be GONE, on the real signal, not on a guess.
#
# Both call sites below used to be a flat `Start-Sleep -Seconds 8` after
# CloseMainWindow(). That is wrong in both directions: it waits 8 seconds
# when Premiere quit in one, and it gives up at 8 when Premiere needed
# twelve -- and the probe then reported SKIPPED, "Premiere would not
# quit", about an application that was closing perfectly normally.
#
# Owner's standing rule, 2026-10-06 (user-level CLAUDE.md): a wait ends on
# its real signal, read every 2 to 5 seconds, and a timeout is a cap for
# FAILURE, never the normal way a wait ends. The signal here is the
# process list going empty, which this file already knows how to ask for.
function Wait-PremiereGone {
    param([int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-PremiereProcesses).Count -gt 0) {
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Seconds 2
    }
    return $true
}

# ------------------------------------------------------- find the apps
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
    Write-Host 'Premiere not found - pass -PremierePath "C:\...\Adobe Premiere Pro.exe"'
    Write-Host 'Nothing was measured. This is not a result.'
    exit 2
}
Write-Host "Premiere: $PremierePath"

if (-not $AfterFXPath) {
    $adobe = 'C:\Program Files\Adobe'
    if (Test-Path $adobe) {
        $dirs = Get-ChildItem $adobe -Directory -Filter 'Adobe After Effects*' |
            Sort-Object Name -Descending
        foreach ($d in $dirs) {
            $exe = Join-Path $d.FullName 'Support Files\AfterFX.exe'
            if (Test-Path $exe) { $AfterFXPath = $exe; break }
        }
    }
}
if ($AfterFXPath) { Write-Host "After Effects: $AfterFXPath" }

$censusJob = $null
if ($Census) {
    $censusScript = Join-Path $PSScriptRoot 'ae-window-census.ps1'
    if (Test-Path $censusScript) {
        $censusOut = Join-Path $probeData 'premiere-window-census.txt'
        Write-Host "Window census -> $censusOut"
        $censusJob = Start-Job -ScriptBlock {
            param($s, $o)
            & powershell -ExecutionPolicy Bypass -File $s -ProcessName 'Adobe Premiere*' `
                -Seconds 180 -Out $o -IncludeHidden
        } -ArgumentList $censusScript, $censusOut
    }
}

# =================================================== DOOR 1: BridgeTalk
if ($Door -eq '1' -or $Door -eq 'all') {
    $running = Get-PremiereProcesses
    if (-not $AfterFXPath) {
        Add-Door @{ door = 1; verdict = 'SKIPPED'
                    detail = 'After Effects not found; door 1 is driven from AE' }
    } elseif ($running.Count -eq 0) {
        Add-Door @{ door = 1; verdict = 'SKIPPED'
                    detail = 'Premiere is not running. Start Premiere, open any project, then re-run -Door 1' }
    } else {
        $out = Join-Path $probeData 'door1-bridgetalk.json'
        $touch = Join-Path $probeData 'door1-touch.txt'
        Remove-Item $out, $touch -ErrorAction SilentlyContinue

        $doorJsx = (Join-Path $PSScriptRoot 'ppro-door-bridgetalk.jsx') -replace '\\', '/'
        $outFs = $out -replace '\\', '/'
        $touchFs = $touch -replace '\\', '/'

        $wrapper = @'
$.global.AELLP_DOOR_OUT = "__OUT__";
$.global.AELLP_DOOR_TOUCH = "__TOUCH__";
try {
  $.evalFile(new File("__JSX__"));
} catch (e) {
  try {
    var f = new File("__OUT__");
    f.encoding = "UTF-8"; f.open("w");
    f.write('{"door":1,"crashed":"' + String(e).replace(/[\\"\r\n]/g, " ") + '"}');
    f.close();
  } catch (e2) {}
}
'@
        $wrapper = $wrapper.Replace('__OUT__', $outFs).Replace('__TOUCH__', $touchFs).Replace('__JSX__', $doorJsx)
        $wrapperPath = Join-Path $env:TEMP 'aellp-door1.jsx'
        # BOM-less: ExtendScript is handed this file directly and a BOM
        # at the head of a script is one more thing that can go wrong for
        # no benefit (see scripts\lib\json-io.ps1 for the JSON case that
        # actually cost two unattended runs).
        [System.IO.File]::WriteAllText($wrapperPath, $wrapper,
            (New-Object System.Text.UTF8Encoding($false)))

        Write-Host 'door 1: asking After Effects to BridgeTalk Premiere...'
        Start-Process -FilePath $AfterFXPath -ArgumentList @('-r', $wrapperPath) | Out-Null

        $gotOut = Wait-ForFile $out $TimeoutSec
        $gotTouch = Wait-ForFile $touch 15
        $targets = ''
        if ($gotOut) {
            try {
                $j = Read-AellJson -Path $out
                $targets = [string]$j.targets
            } catch {}
        }
        if ($gotTouch) {
            $body = (Get-Content -Raw $touch).Trim()
            Add-Door @{ door = 1; verdict = 'ALIVE'
                        detail = "Premiere executed the BridgeTalk body and wrote: $body. Targets AE listed: $targets" }
        } elseif ($gotOut) {
            Add-Door @{ door = 1; verdict = 'DEAD'
                        detail = "AE sent without throwing but Premiere never wrote the touch file (accepted and dropped, or no such target). Targets AE listed: $targets" }
        } else {
            Add-Door @{ door = 1; verdict = 'DEAD'
                        detail = 'the AE side produced no result file at all within the timeout (AE busy, scripting file access off, or a modal)' }
        }
    }
}

# ================================================ DOOR 2: es.processFile
if ($Door -eq '2' -or $Door -eq 'all') {
    $exeDir = Split-Path -Parent $PremierePath
    $flagFile = Join-Path $exeDir 'extendscriptprqe.txt'
    $haveFlag = Test-Path $flagFile

    if (-not $haveFlag -and $AllowAdminWrite) {
        try {
            Set-Content -Path $flagFile -Value 'enabled' -Encoding ASCII
            $haveFlag = Test-Path $flagFile
        } catch {
            Write-Host "  could not write $flagFile (needs an elevated shell)"
        }
    }

    if (-not $haveFlag) {
        Add-Door @{ door = 2; verdict = 'SKIPPED'
                    detail = "no extendscriptprqe.txt beside the exe. In an ADMIN PowerShell: Set-Content -Path '$flagFile' -Value 'enabled' -Encoding ASCII   (then re-run with -Door 2)" }
    } else {
        $running = Get-PremiereProcesses
        if ($running.Count -gt 0 -and -not $ClosePremiere) {
            Add-Door @{ door = 2; verdict = 'SKIPPED'
                        detail = 'Premiere is running and this door only works at LAUNCH. Quit Premiere and re-run, or pass -ClosePremiere' }
        } else {
            if ($running.Count -gt 0) {
                Write-Host 'door 2: closing Premiere (asked with -ClosePremiere)...'
                foreach ($p in $running) {
                    [void]$p.CloseMainWindow()
                }
                [void](Wait-PremiereGone)
                foreach ($p in (Get-PremiereProcesses)) {
                    Write-Host '  Premiere is still up - it may be asking to save. Answer it and re-run.'
                }
            }
            if ((Get-PremiereProcesses).Count -gt 0) {
                Add-Door @{ door = 2; verdict = 'SKIPPED'
                            detail = 'Premiere would not quit (unsaved work?). Close it by hand and re-run -Door 2' }
            } else {
                $out = Join-Path $probeData 'door2-cli.json'
                Remove-Item $out -ErrorAction SilentlyContinue
                $probeJsx = (Join-Path $repoRoot 'probe\com.cptk.aellama.probe\jsx\probe.jsx') -replace '\\', '/'
                $src = Get-Content -Raw (Join-Path $PSScriptRoot 'ppro-door-cli.jsx')
                $src = $src.Replace('__OUT__', ($out -replace '\\', '/')).Replace('__PROBE__', $probeJsx)
                $runJsx = Join-Path $env:TEMP 'aellp-door2.jsx'
                [System.IO.File]::WriteAllText($runJsx, $src,
                    (New-Object System.Text.UTF8Encoding($false)))

                Write-Host 'door 2: launching Premiere with /C es.processFile...'
                Start-Process -FilePath $PremierePath `
                    -ArgumentList @('/C', 'es.processFile', $runJsx) | Out-Null

                if (Wait-ForFile $out $TimeoutSec) {
                    $stage = ''
                    try { $stage = [string]((Get-Content -Raw $out | ConvertFrom-Json).stage) } catch {}
                    if ($stage -eq 'done') {
                        Add-Door @{ door = 2; verdict = 'ALIVE'
                                    detail = 'Premiere ran the .jsx handed to it at launch and the probe answered. Cost: one admin file, and a Premiere restart per pass' }
                    } else {
                        Add-Door @{ door = 2; verdict = 'PARTIAL'
                                    detail = "Premiere started the script (stage=$stage) but the probe did not complete - see $out" }
                    }
                } else {
                    Add-Door @{ door = 2; verdict = 'DEAD'
                                detail = 'Premiere launched but never ran the script (no result file). The /C es.processFile hook is not honoured on this build' }
                }
            }
        }
    }
}

# ================================================== DOOR 3: CEP harness
if ($Door -eq '3' -or $Door -eq 'all') {
    $harnLink = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.cptk.aellama.harness'
    if (-not (Test-Path $harnLink)) {
        Add-Door @{ door = 3; verdict = 'SKIPPED'
                    detail = 'the dev-only runner is not installed. Run: scripts\install-probe.ps1 -Harness' }
    } else {
        $running = Get-PremiereProcesses
        if ($running.Count -gt 0 -and -not $ClosePremiere) {
            Add-Door @{ door = 3; verdict = 'SKIPPED'
                        detail = 'Premiere is running and this door fires at LAUNCH. Quit Premiere and re-run, or pass -ClosePremiere' }
        } else {
            foreach ($p in $running) { [void]$p.CloseMainWindow() }
            if ($running.Count -gt 0) { [void](Wait-PremiereGone) }

            $job = Join-Path $probeData 'job.json'
            $jobResult = Join-Path $probeData 'job-result.json'
            Remove-Item $jobResult, (Join-Path $probeData 'job.running.json') -ErrorAction SilentlyContinue
            $probeJsx = (Join-Path $repoRoot 'probe\com.cptk.aellama.probe\jsx\probe.jsx') -replace '\\', '/'
            Write-AellJson -Path $job -Depth 4 -Object ([pscustomobject]@{
                probeJsx = $probeJsx; probe = 'hostFacts'; args = @{} })

            Write-Host 'door 3: launching Premiere with a job file waiting...'
            Start-Process -FilePath $PremierePath | Out-Null

            if (Wait-ForFile $jobResult $TimeoutSec) {
                $ok = $false
                try { $ok = [bool]((Get-Content -Raw $jobResult | ConvertFrom-Json).ok) } catch {}
                if ($ok) {
                    Add-Door @{ door = 3; verdict = 'ALIVE'
                                detail = 'the invisible extension claimed the job at launch and the probe answered. Dev-only: never ship this bundle' }
                } else {
                    Add-Door @{ door = 3; verdict = 'PARTIAL'
                                detail = "the runner fired and wrote a result but the probe did not succeed - see $jobResult" }
                }
            } else {
                Add-Door @{ door = 3; verdict = 'DEAD'
                            detail = 'no result file - the invisible extension did not load, or StartOn never fired on this build' }
                Remove-Item $job -ErrorAction SilentlyContinue
            }
        }
    }
}

if ($censusJob) {
    Write-Host ''
    Write-Host 'Stopping the window census...'
    Stop-Job $censusJob -ErrorAction SilentlyContinue
    Remove-Job $censusJob -Force -ErrorAction SilentlyContinue
}

Save-Results

$alive = @($results | Where-Object { $_.verdict -eq 'ALIVE' })
$measured = @($results | Where-Object { $_.verdict -ne 'SKIPPED' })

Write-Host ''
if ($alive.Count -gt 0) {
    Write-Host ("A door answered: " + (($alive | ForEach-Object { 'door ' + $_.door }) -join ', ')) -ForegroundColor Green
    Write-Host 'Premiere CAN be driven unattended - build scripts\run-ppro-selftest.ps1 on it.'
    exit 0
}
if ($measured.Count -eq 0) {
    Write-Host 'Nothing was measured - every door was skipped for a missing prerequisite.'
    Write-Host 'Read the SKIPPED lines above; each names exactly what it needs.'
    exit 4
}
Write-Host 'Every door measured DEAD. That is a real finding, not a failure:' -ForegroundColor Yellow
Write-Host 'Premiere verification stays a click in the panel (rung 2), the'
Write-Host 'overnight loop cannot cover Premiere, and QE-backed tools must not'
Write-Host 'ship. Write it into CLAUDE.md and docs\PREMIERE-PLATFORM.md.'
exit 3
