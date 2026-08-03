<#
.SYNOPSIS
  Installs a .zxp manually -- no ZXP Installer app, no Creative Cloud login.

  A .zxp is a signed zip. This extracts it into the per-user CEP extensions
  folder, which Adobe apps scan on startup; the signature files inside
  (META-INF) travel with it, so the panel loads like any signed install.

  Use this when installer apps report "no compatible program available" or
  demand a Creative Cloud login you already have -- those come from the
  installer's Adobe-app detection failing, not from the .zxp itself.

.EXAMPLE
  .\scripts\install-zxp.ps1                                  # newest dist\*.zxp
  .\scripts\install-zxp.ps1 -ZxpPath $HOME\Downloads\AE-Llama-0.3.0.zxp
#>
[CmdletBinding()]
param(
    [string]$ZxpPath = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ZxpPath) {
    $found = Get-ChildItem (Join-Path $repoRoot 'dist') -Filter *.zxp -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime | Select-Object -Last 1
    if ($found) { $ZxpPath = $found.FullName }
}
if (-not $ZxpPath -or -not (Test-Path $ZxpPath)) {
    throw 'Pass -ZxpPath <path to the .zxp> (or place one in dist\).'
}

$destDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.cptk.aellama'

function Expand-ZipTo([string]$archive, [string]$dest) {
    # Expand-Archive insists on a .zip extension; a .zxp IS a zip.
    $tmpZip = Join-Path ([IO.Path]::GetTempPath()) `
              ("ae-llama-" + [IO.Path]::GetRandomFileName() + ".zip")
    Copy-Item -LiteralPath $archive -Destination $tmpZip
    try {
        Expand-Archive -LiteralPath $tmpZip -DestinationPath $dest -Force
    } finally {
        Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue
    }
}

# Replace any previous install (junction from install.ps1, or an old copy).
$existing = Get-Item -LiteralPath $destDir -Force -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.LinkType) { $existing.Delete() }
    else { Remove-Item -Recurse -Force $destDir }
}
New-Item -ItemType Directory -Force -Path $destDir | Out-Null

Expand-ZipTo $ZxpPath $destDir

# GitHub Actions artifacts arrive as a wrapper zip CONTAINING the .zxp --
# if that's what we were handed, unwrap one level.
if (-not (Test-Path (Join-Path $destDir 'CSXS\manifest.xml'))) {
    $inner = Get-ChildItem -LiteralPath $destDir -Filter *.zxp |
             Select-Object -First 1
    if ($inner) {
        Write-Host "That was the artifact wrapper zip - unwrapping $($inner.Name)..."
        $innerPath = $inner.FullName
        Get-ChildItem -LiteralPath $destDir -Exclude $inner.Name |
            Remove-Item -Recurse -Force
        Expand-ZipTo $innerPath $destDir
        Remove-Item -Force $innerPath
    }
}

if (-not (Test-Path (Join-Path $destDir 'CSXS\manifest.xml'))) {
    Remove-Item -Recurse -Force $destDir
    throw "No CSXS\manifest.xml found inside $ZxpPath - is that file really the panel .zxp?"
}

Write-Host "Installed to $destDir" -ForegroundColor Green
Write-Host 'Restart After Effects, then open: Window > Extensions > AE Llama'
