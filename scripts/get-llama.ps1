<#
.SYNOPSIS
  Downloads llama.cpp prebuilt Windows binaries (llama-server.exe) into
  extension\vendor\llama.cpp.

.EXAMPLE
  .\scripts\get-llama.ps1                 # CPU build (works everywhere)
  .\scripts\get-llama.ps1 -Variant cuda   # NVIDIA GPU build (+ CUDA runtime DLLs)
  .\scripts\get-llama.ps1 -Tag b6099      # pin a specific release tag
#>
[CmdletBinding()]
param(
    [ValidateSet('cpu', 'cuda')]
    [string]$Variant = 'cpu',
    [string]$Tag = 'latest'
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5 defaults to TLS 1.0/1.1, which GitHub rejects.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot  = Split-Path -Parent $PSScriptRoot
$vendorDir = Join-Path $repoRoot 'extension\vendor\llama.cpp'

if ($Tag -eq 'latest') {
    $apiUrl = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
} else {
    $apiUrl = "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$Tag"
}

Write-Host "Querying release info: $apiUrl"
$release = Invoke-RestMethod -Uri $apiUrl -Headers @{ 'User-Agent' = 'ae-llama-setup' }
Write-Host "Release: $($release.tag_name)"

$assets = @($release.assets)
$toDownload = @()

if ($Variant -eq 'cpu') {
    $main = $assets | Where-Object { $_.name -match '^llama-.*-bin-win-cpu-x64\.zip$' } |
            Select-Object -First 1
    if (-not $main) {
        # Older releases used per-instruction-set names (avx2, etc.).
        $main = $assets | Where-Object { $_.name -match '^llama-.*-bin-win-avx2-x64\.zip$' } |
                Select-Object -First 1
    }
    if (-not $main) { throw "No Windows CPU x64 asset found in $($release.tag_name). Check https://github.com/ggml-org/llama.cpp/releases" }
    $toDownload += $main
} else {
    # Pick the highest CUDA toolkit version published for this release.
    $cudaAssets = $assets | Where-Object { $_.name -match '^llama-.*-bin-win-cuda-(\d+(\.\d+)?)-x64\.zip$' }
    if (-not $cudaAssets) { throw "No Windows CUDA x64 asset found in $($release.tag_name)." }
    $main = $cudaAssets | Sort-Object {
        [version]([regex]::Match($_.name, 'cuda-(\d+(\.\d+)?)-x64').Groups[1].Value + '.0')
    } | Select-Object -Last 1
    $toDownload += $main

    $cudaVer = [regex]::Match($main.name, 'cuda-(\d+(\.\d+)?)-x64').Groups[1].Value
    $cudart  = $assets | Where-Object { $_.name -match "^cudart-llama-bin-win-cuda-$([regex]::Escape($cudaVer))-x64\.zip$" } |
               Select-Object -First 1
    if ($cudart) {
        $toDownload += $cudart
    } else {
        Write-Warning "No cudart bundle found for CUDA $cudaVer. If llama-server.exe complains about missing DLLs, install the CUDA $cudaVer runtime."
    }
}

if (Test-Path $vendorDir) {
    Write-Host "Clearing $vendorDir"
    Remove-Item -Recurse -Force $vendorDir
}
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null

$tempDir = Join-Path ([IO.Path]::GetTempPath()) "ae-llama-dl-$([IO.Path]::GetRandomFileName())"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
try {
    foreach ($asset in $toDownload) {
        $zipPath = Join-Path $tempDir $asset.name
        Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)…"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing
        Write-Host "Extracting into $vendorDir"
        Expand-Archive -Path $zipPath -DestinationPath $vendorDir -Force
    }
} finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}

$serverExe = Get-ChildItem -Path $vendorDir -Recurse -Filter 'llama-server.exe' |
             Select-Object -First 1
if ($serverExe) {
    Write-Host ''
    Write-Host "Done. llama-server: $($serverExe.FullName)" -ForegroundColor Green
    Write-Host 'The panel finds this location automatically.'
} else {
    throw "Extraction finished but llama-server.exe was not found under $vendorDir"
}
