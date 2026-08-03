<#
.SYNOPSIS
  Installs the AE Llama CEP panel for the current user:
    1. Enables PlayerDebugMode (unsigned-extension loading) for CEP 11/12.
    2. Junctions extension\ into %APPDATA%\Adobe\CEP\extensions.

  No admin rights required. Re-run safely any time; run uninstall.ps1 to undo.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$srcDir   = Join-Path $repoRoot 'extension'
$extDir   = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$linkPath = Join-Path $extDir 'com.cptk.aellama'

if (-not (Test-Path (Join-Path $srcDir 'CSXS\manifest.xml'))) {
    throw "Extension source not found at $srcDir"
}

# --- 1. PlayerDebugMode -----------------------------------------------------
# AE 2024 uses CEP 11 (CSXS.11); AE 2025/2026 use CEP 12 (CSXS.12).
foreach ($v in 11, 12) {
    $keyPath = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $keyPath)) {
        New-Item -Path $keyPath -Force | Out-Null
    }
    New-ItemProperty -Path $keyPath -Name 'PlayerDebugMode' -Value '1' `
        -PropertyType String -Force | Out-Null
    Write-Host "PlayerDebugMode=1 set in $keyPath"
}

# --- 2. Junction into the CEP extensions folder -----------------------------
New-Item -ItemType Directory -Force -Path $extDir | Out-Null

# Test-Path follows reparse points and reports $false for a DANGLING
# junction (repo moved/deleted since the last install) -- Get-Item -Force
# sees the link itself, so re-runs recover from that state too.
$existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.LinkType) {
        # A junction/symlink: remove the link only, never its target contents.
        $existing.Delete()
    } else {
        Write-Warning "Replacing existing folder (not a link) at $linkPath"
        Remove-Item -Recurse -Force $linkPath
    }
}

New-Item -ItemType Junction -Path $linkPath -Target $srcDir | Out-Null
Write-Host "Linked $linkPath -> $srcDir" -ForegroundColor Green

Write-Host ''
Write-Host 'Installed. Next steps:' -ForegroundColor Green
Write-Host '  1. If you have not yet: .\scripts\get-llama.ps1   (downloads llama-server)'
Write-Host '  2. Put one or more .gguf models into extension\models\ (or use Browse in the panel)'
Write-Host '  3. Restart After Effects, then open: Window > Extensions > AE Llama'
