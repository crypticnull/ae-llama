# probe-doctor.ps1 - say WHY the P0 probe panel is or is not listed in a
# host, instead of leaving anyone to guess.
#
#   powershell -ExecutionPolicy Bypass -File scripts\probe-doctor.ps1
#
# "It does not appear under Window > Extensions" has at least six
# different causes and they need completely different fixes:
#
#   - the repo was never pulled, so the bundle is not on disk
#   - install-probe.ps1 was never run, so there is no junction
#   - the junction exists but points somewhere wrong
#   - the manifest is malformed or uses a shape this CEP build rejects,
#     in which case CEP drops the WHOLE bundle silently
#   - PlayerDebugMode is not set for the CEP runtime the host uses, so an
#     unsigned extension is refused
#   - the host was not restarted (CEP reads extensions at launch only)
#
# CEP itself writes down which one it was. This reads those logs, plus
# every fact that can be checked without opening an Adobe app, and ends
# with the single next step.
#
# Read-only: it changes nothing.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

[CmdletBinding()]
param(
    [int]$LogLines = 25
)

$ErrorActionPreference = 'Continue'

$repoRoot  = Split-Path -Parent $PSScriptRoot
$probeSrc  = Join-Path $repoRoot 'probe\com.cptk.aellama.probe'
$harnSrc   = Join-Path $repoRoot 'probe\com.cptk.aellama.harness'
$extDir    = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$probeLink = Join-Path $extDir 'com.cptk.aellama.probe'

$problems = New-Object System.Collections.ArrayList
function Fault([string]$what, [string]$fix) {
    [void]$problems.Add([pscustomobject]@{ what = $what; fix = $fix })
    Write-Host ("  FAULT  " + $what) -ForegroundColor Red
}
function Good([string]$what) { Write-Host ("  ok     " + $what) }
function Info([string]$what) { Write-Host ("  --     " + $what) -ForegroundColor DarkGray }

Write-Host ''
Write-Host '== 1. is the bundle on disk (did the repo get pulled)'
if (Test-Path (Join-Path $probeSrc 'CSXS\manifest.xml')) {
    Good "probe bundle present: $probeSrc"
} else {
    Fault "no probe bundle at $probeSrc" `
          "run: git pull --ff-only   (in $repoRoot)"
}
if (Test-Path (Join-Path $harnSrc 'CSXS\manifest.xml')) {
    Good 'door-3 harness bundle present (dev only)'
} else {
    Info 'door-3 harness bundle absent (only needed for -Harness)'
}

Write-Host ''
Write-Host '== 2. is it installed (the junction CEP would scan)'
if (-not (Test-Path $extDir)) {
    Fault "the per-user CEP extensions folder does not exist: $extDir" `
          'run: powershell -ExecutionPolicy Bypass -File scripts\install-probe.ps1'
} else {
    Good "CEP extensions folder: $extDir"
    $item = Get-Item -LiteralPath $probeLink -Force -ErrorAction SilentlyContinue
    if (-not $item) {
        Fault 'the probe is NOT installed (no com.cptk.aellama.probe there)' `
              'run: powershell -ExecutionPolicy Bypass -File scripts\install-probe.ps1'
    } else {
        $target = $item.Target
        if ($target -is [array]) { $target = $target[0] }
        if ($item.LinkType) {
            Good ("installed as a " + $item.LinkType + " -> " + $target)
        } else {
            Info 'installed as a real folder (a copy, not a junction)'
        }
        if (Test-Path (Join-Path $probeLink 'CSXS\manifest.xml')) {
            Good 'CSXS\manifest.xml is readable THROUGH the install path'
        } else {
            Fault 'no CSXS\manifest.xml through the install path' `
                  'the junction points at the wrong folder - re-run install-probe.ps1'
        }
        if (Test-Path (Join-Path $probeLink 'index.html')) {
            Good 'index.html is readable through the install path'
        } else {
            Fault 'no index.html through the install path' 're-run install-probe.ps1'
        }
    }
}

Write-Host ''
Write-Host '== 3. is the manifest one CEP will accept'
$manifestPath = Join-Path $probeLink 'CSXS\manifest.xml'
if (-not (Test-Path $manifestPath)) {
    $manifestPath = Join-Path $probeSrc 'CSXS\manifest.xml'
    Info 'reading the repo copy (nothing is installed)'
}
if (Test-Path $manifestPath) {
    $raw = Get-Content -Raw $manifestPath
    $xml = $null
    # LoadXml, not [xml]$raw: the cast failure embeds the ENTIRE file in
    # its message, so a one-character error printed 60 unreadable lines
    # twice. LoadXml throws an XmlException that names the line.
    try {
        $doc = New-Object System.Xml.XmlDocument
        $doc.LoadXml($raw)
        $xml = $doc
    } catch {
        $why = $_.Exception.Message
        if ($_.Exception.InnerException) { $why = $_.Exception.InnerException.Message }
        Fault ("manifest is not well-formed XML: " + $why) `
              'CEP drops the WHOLE bundle silently on a parse error, which looks exactly like a rejected manifest SHAPE. Fix the XML first.'
        # The trap that actually shipped, called out by name because the
        # generic parser message ("cannot contain") does not say which
        # comment or why anyone would write one.
        if ($why -match 'comment') {
            Info 'XML comments may not contain a double dash or end with a dash.'
            Info 'Every probe manifest shipped with one on 2026-09-02.'
            Info 'tests\test-manifest-xml.js catches this without an Adobe app.'
        }
    }
    if ($xml) {
        Good 'manifest is well-formed XML'
        $bundleId = $xml.ExtensionManifest.ExtensionBundleId
        $extCount = @($xml.ExtensionManifest.ExtensionList.Extension).Count
        Info ("bundle id: " + $bundleId + " with " + $extCount + " extension(s)")

        # Which shape is installed. This is the whole point of the two
        # files: per-extension HostList (shape A) is documented by Adobe
        # but every shipped multi-host manifest found in the wild uses
        # one HostList on one extension (shape B).
        $perExt = @($xml.ExtensionManifest.DispatchInfoList.Extension |
                    Where-Object { $_.HostList }).Count
        if ($perExt -gt 0) {
            Info ("SHAPE A installed: " + $perExt +
                  " extension(s) carry their own <HostList>")
            Info 'Documented by Adobe, but nobody has been seen shipping it.'
            Info 'If the panel does not list AND the XML parsed above, this'
            Info 'is the next suspect: re-run install-probe.ps1 for shape B.'
        } else {
            Info 'SHAPE B installed: one HostList for the whole bundle'
            Info '(the shape every shipped multi-host manifest uses)'
        }

        $hosts = @()
        foreach ($h in $xml.SelectNodes('//Host')) {
            $hosts += ($h.Name + ' ' + $h.Version)
        }
        Info ("hosts named: " + (($hosts | Select-Object -Unique) -join ' | '))

        $rr = $xml.ExtensionManifest.ExecutionEnvironment.RequiredRuntimeList.RequiredRuntime
        Info ("RequiredRuntime: " + $rr.Name + ' ' + $rr.Version)

        # Every Id in DispatchInfoList must exist in ExtensionList.
        $declared = @($xml.ExtensionManifest.ExtensionList.Extension |
                      ForEach-Object { $_.Id })
        $idsOk = $true
        foreach ($d in @($xml.ExtensionManifest.DispatchInfoList.Extension)) {
            if ($declared -notcontains $d.Id) {
                $idsOk = $false
                Fault ("DispatchInfoList declares an id that ExtensionList does not: " + $d.Id) `
                      'ids must match in both lists'
            }
        }
        if ($idsOk) { Good 'every DispatchInfo id is declared in ExtensionList' }

        $menus = @()
        foreach ($m in $xml.SelectNodes('//Menu')) { $menus += $m.InnerText }
        if ($menus.Count -gt 0) {
            Good ('menu name(s) to look for: "' + ($menus -join '" / "') + '"')
        } else {
            Fault 'the manifest has no <Menu>, so it can never be listed' `
                  'this manifest is for an invisible extension, not a panel'
        }
    }
}

Write-Host ''
Write-Host '== 4. PlayerDebugMode (unsigned extensions are refused without it)'
$anyDebug = $false
foreach ($v in 9, 10, 11, 12, 13, 14, 15) {
    $keyPath = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $keyPath)) { continue }
    $val = (Get-ItemProperty -Path $keyPath -Name 'PlayerDebugMode' -ErrorAction SilentlyContinue).PlayerDebugMode
    if ($val -eq '1') { $anyDebug = $true; Good ("CSXS.$v PlayerDebugMode=1") }
    else { Info ("CSXS.$v present, PlayerDebugMode=" + $(if ($null -eq $val) { '(unset)' } else { $val })) }
}
if (-not $anyDebug) {
    Fault 'no CSXS runtime has PlayerDebugMode=1' `
          'run: powershell -ExecutionPolicy Bypass -File scripts\install-probe.ps1'
}

Write-Host ''
Write-Host '== 5. what else is in that folder (the control)'
if (Test-Path $extDir) {
    $others = Get-ChildItem $extDir -Force -ErrorAction SilentlyContinue
    if (-not $others) {
        Info 'the folder is empty apart from anything listed above'
    }
    foreach ($o in $others) {
        $kind = if ($o.LinkType) { $o.LinkType } else { 'folder' }
        Write-Host ("  --     " + $o.Name + "  (" + $kind + ")") -ForegroundColor DarkGray
    }
    if ($others.Name -contains 'com.cptk.aellama') {
        Info 'the AE Llama PANEL is installed from this same folder. If the'
        Info 'panel lists in AE and the probe does not, the environment is'
        Info 'fine and the difference is the probe MANIFEST - go to shape B.'
    }
}

Write-Host ''
Write-Host '== 6. what CEP itself said (the authoritative answer)'
$logDirs = @($env:TEMP, (Join-Path $env:LOCALAPPDATA 'Temp')) |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$logs = @()
foreach ($d in $logDirs) {
    $logs += Get-ChildItem $d -Filter '*.log' -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -match 'CEP|csxs' }
}
$logs = $logs | Sort-Object LastWriteTime -Descending | Select-Object -First 12
if (-not $logs) {
    Info 'no CEP logs found. They appear after a host has launched at least'
    Info 'once with PlayerDebugMode set. Start AE, quit it, and re-run this.'
} else {
    foreach ($l in $logs) {
        $hit = Select-String -Path $l.FullName -Pattern 'aellama' `
               -SimpleMatch -ErrorAction SilentlyContinue
        if ($hit) {
            Write-Host ''
            Write-Host ("  --- " + $l.Name + " (" + $l.LastWriteTime + ")") -ForegroundColor Cyan
            $hit | Select-Object -Last $LogLines | ForEach-Object {
                Write-Host ("      " + $_.Line.Trim())
            }
        }
    }
    $named = @($logs | ForEach-Object { $_.Name })
    Info ("CEP logs seen: " + ($named -join ', '))
    Info 'A line mentioning the probe id with an error is the real answer.'
    Info 'No mention at all = CEP never even tried to load it (manifest'
    Info 'rejected, or the host has not been restarted since installing).'
}

Write-Host ''
Write-Host '== 7. is a host running (CEP reads extensions at LAUNCH only)'
$running = @()
foreach ($n in 'AfterFX', 'Adobe Premiere Pro', 'Adobe Premiere') {
    foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) {
        $running += $p.ProcessName
    }
}
if ($running.Count -gt 0) {
    Info ("running now: " + (($running | Select-Object -Unique) -join ', '))
    Info 'An app that was already open when the junction was made will NOT'
    Info 'see it. Quit it completely and start it again.'
} else {
    Good 'no Adobe host is running, so the next launch will rescan'
}

Write-Host ''
Write-Host '== verdict'
if ($problems.Count -gt 0) {
    Write-Host 'Fix these, in order:' -ForegroundColor Yellow
    $i = 1
    foreach ($p in $problems) {
        Write-Host ("  " + $i + ". " + $p.what)
        Write-Host ("     " + $p.fix)
        $i++
    }
    exit 1
}

Write-Host 'Everything checkable without opening an Adobe app is correct:' -ForegroundColor Green
Write-Host 'the bundle is on disk, installed where every CEP host scans, its'
Write-Host 'manifest parses and names a menu entry, and PlayerDebugMode is set.'
Write-Host ''
Write-Host 'If it is STILL not listed after a full restart of the host, paste'
Write-Host 'this whole output back - especially section 6. Nothing above is a'
Write-Host 'guess, so the next move comes from what CEP logged, not from more'
Write-Host 'speculation about the manifest.'
exit 0
