# install-probe.ps1 - install the P0 feasibility probe bundle for the
# current user, in whichever manifest shape is being measured.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-probe.ps1
#   ... -Shape B            one <Extension>, both hosts, loader ScriptPath
#   ... -Harness            also install the dev-only door-3 runner
#   ... -Uninstall          remove everything this script installed
#
# What it does:
#   1. Snapshots which HKCU\Software\Adobe\CSXS.* keys already exist
#      (that snapshot IS a measurement: it says which CEP runtimes the
#      installed Adobe apps have registered), then sets PlayerDebugMode
#      on CSXS.10 through CSXS.14. 13/14 are written defensively: a
#      third-party installer claims Premiere 2026 needs them, no Adobe
#      source says so, and Adobe's own table stops at "Premiere 25.0 =
#      CEP 12".
#   2. Junctions probe\com.cptk.aellama.probe into the per-user CEP
#      extensions folder - the same folder scripts\install.ps1 uses, and
#      the one every CEP host scans.
#
# The probe bundle has its own ExtensionBundleId and lives OUTSIDE
# extension\, so it can never collide with the panel and can never be
# staged by scripts\package-zxp.ps1.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

[CmdletBinding()]
param(
    # B is the default because it is the only shape with field evidence:
    # every shipped multi-host CEP manifest found in the wild uses one
    # HostList on one extension. Shape A (per-extension HostList) is
    # documented by Adobe but nobody has been seen shipping it.
    # NOTE: neither shape has ever actually been PARSED by CEP - both
    # shipped with an illegal XML comment on 2026-09-02 - so the shape
    # question is still open. See docs\PREMIERE-PLATFORM.md.
    [ValidateSet('A', 'B')]
    [string]$Shape = 'B',
    [switch]$Harness,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent $PSScriptRoot
$probeSrc  = Join-Path $repoRoot 'probe\com.cptk.aellama.probe'
$harnSrc   = Join-Path $repoRoot 'probe\com.cptk.aellama.harness'
$extDir    = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$probeLink = Join-Path $extDir 'com.cptk.aellama.probe'
$harnLink  = Join-Path $extDir 'com.cptk.aellama.harness'
$probeData = Join-Path $env:APPDATA 'AE-Llama\probes'

function Remove-Link([string]$linkPath) {
    $existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
    if (-not $existing) { return $false }
    if ($existing.LinkType) {
        # Delete the link, never the target contents.
        $existing.Delete()
    } else {
        Remove-Item -Recurse -Force $linkPath
    }
    return $true
}

# ------------------------------------------------------------ uninstall
if ($Uninstall) {
    foreach ($p in @($probeLink, $harnLink)) {
        if (Remove-Link $p) { Write-Host "Removed $p" }
    }
    Write-Host ''
    Write-Host 'Probe removed. PlayerDebugMode keys were left alone (the'
    Write-Host 'panel install needs them too).' -ForegroundColor Green
    exit 0
}

if (-not (Test-Path (Join-Path $probeSrc 'CSXS\manifest.xml'))) {
    throw "Probe bundle not found at $probeSrc"
}

# --------------------------------------------- 1. CSXS keys (measured)
$keySnapshot = @()
foreach ($v in 9, 10, 11, 12, 13, 14, 15) {
    $keyPath = "HKCU:\Software\Adobe\CSXS.$v"
    $existed = Test-Path $keyPath
    $before = $null
    if ($existed) {
        $before = (Get-ItemProperty -Path $keyPath -Name 'PlayerDebugMode' `
                   -ErrorAction SilentlyContinue).PlayerDebugMode
    }
    $keySnapshot += [pscustomobject]@{
        csxs = $v; existedBefore = $existed; playerDebugModeBefore = $before
    }
}

foreach ($v in 10, 11, 12, 13, 14) {
    $keyPath = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $keyPath)) { New-Item -Path $keyPath -Force | Out-Null }
    New-ItemProperty -Path $keyPath -Name 'PlayerDebugMode' -Value '1' `
        -PropertyType String -Force | Out-Null
}
Write-Host 'PlayerDebugMode=1 set in CSXS.10 through CSXS.14'

Write-Host ''
Write-Host 'CSXS keys BEFORE this run (which CEP runtimes are registered):'
foreach ($row in $keySnapshot) {
    $mark = if ($row.existedBefore) { 'present' } else { 'absent ' }
    Write-Host ("  CSXS." + $row.csxs.ToString().PadRight(2) + '  ' + $mark +
                '  PlayerDebugMode=' + $(if ($null -eq $row.playerDebugModeBefore)
                                         { '(unset)' }
                                         else { $row.playerDebugModeBefore }))
}

New-Item -ItemType Directory -Force -Path $probeData | Out-Null
$snapshotFile = Join-Path $probeData 'csxs-keys.json'
$keySnapshot | ConvertTo-Json -Depth 4 | Set-Content $snapshotFile -Encoding UTF8
Write-Host "Snapshot written to $snapshotFile"

# ------------------------------------------------- 2. select the shape
$manifestPath  = Join-Path $probeSrc 'CSXS\manifest.xml'
$shapeAPath    = Join-Path $probeSrc 'CSXS\manifest-shape-a.xml'
$shapeBPath    = Join-Path $probeSrc 'CSXS\manifest-shape-b.xml'

# CEP demands the file be called CSXS\manifest.xml, so switching shapes
# means overwriting it. Both shapes are committed beside it, and -Shape A
# restores byte for byte -- but note that a -Shape B install leaves the
# working tree dirty until you run -Shape A again.
if (-not (Test-Path $shapeAPath)) { throw "Missing $shapeAPath" }
if ($Shape -eq 'B') {
    if (-not (Test-Path $shapeBPath)) { throw "Missing $shapeBPath" }
    Copy-Item $shapeBPath $manifestPath -Force
    Write-Host 'Manifest shape B in place (one Extension, AEFT+PPRO, loader).'
} else {
    Copy-Item $shapeAPath $manifestPath -Force
    Write-Host 'Manifest shape A in place (two Extensions, per-extension HostList).'
    Write-Host 'NOTE: shape A did not list in After Effects on 2026-09-02.' -ForegroundColor Yellow
    Write-Host 'Use it only to re-test that; -Shape B is the working default.' -ForegroundColor Yellow
}

# Read the menu labels back OUT of the manifest just installed, rather
# than printing what the shape is assumed to use. The first version of
# this script told the owner to look for a menu name its own manifest
# did not contain, which is the least helpful possible instruction.
$menus = @()
try {
    $xmlDoc = [xml](Get-Content -Raw $manifestPath)
    foreach ($node in $xmlDoc.SelectNodes('//Menu')) { $menus += $node.InnerText }
} catch {
    Write-Host "Could not read the menu name back: $($_.Exception.Message)"
}
$menuText = if ($menus.Count -gt 0) { '"' + ($menus -join '" / "') + '"' }
            else { '(no <Menu> in the manifest - it will not be listed)' }

# ----------------------------------------------------- 3. the junctions
New-Item -ItemType Directory -Force -Path $extDir | Out-Null

Remove-Link $probeLink | Out-Null
New-Item -ItemType Junction -Path $probeLink -Target $probeSrc | Out-Null
Write-Host "Linked $probeLink -> $probeSrc" -ForegroundColor Green

if ($Harness) {
    Remove-Link $harnLink | Out-Null
    New-Item -ItemType Junction -Path $harnLink -Target $harnSrc | Out-Null
    Write-Host "Linked $harnLink -> $harnSrc (door 3, dev only)" -ForegroundColor Green
} else {
    if (Remove-Link $harnLink) {
        Write-Host "Removed the door-3 runner (pass -Harness to keep it)"
    }
}

Write-Host ''
Write-Host ("Installed shape " + $Shape + '. Next steps:') -ForegroundColor Green
Write-Host '  1. Fully quit After Effects AND Premiere (CEP reads extensions at launch).'
Write-Host ('  2. Start After Effects. Window > Extensions > ' + $menuText)
Write-Host '     Press "Run all read-only probes", then "Engine soak".'
Write-Host '  3. Start Premiere. Same menu, same two buttons.'
Write-Host '     Opening AE FIRST matters: the localStorage question is'
Write-Host '     answered by whether Premiere can see the key AE wrote.'
Write-Host ('  4. Both write into ' + $probeData)
Write-Host '  5. Then: node scripts\ppro-probe-report.js'
Write-Host ''
Write-Host 'If it is NOT in that menu after a FULL restart, run:'
Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\probe-doctor.ps1'
Write-Host 'It reads CEP''s own log and says which of the six causes it was.'
