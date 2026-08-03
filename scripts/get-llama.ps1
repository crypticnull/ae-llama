<#
.SYNOPSIS
  Downloads llama.cpp prebuilt Windows binaries (llama-server.exe) into
  extension\vendor\llama.cpp.

.EXAMPLE
  .\scripts\get-llama.ps1                 # CPU build (works everywhere)
  .\scripts\get-llama.ps1 -Variant cuda   # NVIDIA GPU build (+ CUDA runtime DLLs)
  .\scripts\get-llama.ps1 -Variant cuda -CudaVersion 13  # force a toolkit line
  .\scripts\get-llama.ps1 -Tag b6099      # pin a specific release tag
#>
[CmdletBinding()]
param(
    [ValidateSet('cpu', 'cuda')]
    [string]$Variant = 'cpu',
    [string]$Tag = 'latest',
    # Major CUDA toolkit line to prefer (e.g. '12' or '13'). Default prefers
    # the lowest published line: newer toolkits drop older GPUs (Maxwell/
    # Pascal/Volta) and demand newer drivers, so lowest is the safe default.
    [string]$CudaVersion = ''
)

$ErrorActionPreference = 'Stop'
# The progress bar makes Invoke-WebRequest 10-50x slower on WinPS 5.1.
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5 defaults to TLS 1.0/1.1, which GitHub rejects.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot  = Split-Path -Parent $PSScriptRoot
$vendorDir = Join-Path $repoRoot 'extension\vendor\llama.cpp'

if ($Tag -eq 'latest') {
    $apiUrl = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
} else {
    $apiUrl = "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$Tag"
}

$headers = @{ 'User-Agent' = 'ae-llama-setup' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

Write-Host "Querying release info: $apiUrl"
try {
    $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers
} catch {
    $status = $null
    try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    if ($status -eq 403 -or $status -eq 429) {
        throw ("GitHub API rate limit hit (HTTP $status). Set a GITHUB_TOKEN " +
               "environment variable (any fine-grained token works) or retry in an hour.")
    }
    if ($status -eq 404) {
        throw "Release tag '$Tag' not found. Check https://github.com/ggml-org/llama.cpp/releases"
    }
    throw
}
Write-Host "Release: $($release.tag_name)"

# Asset naming has changed over the years:
#   modern : llama-b7399-bin-win-cpu-x64.zip / llama-b7399-bin-win-cuda-12.4-x64.zip
#   older  : llama-b3660-bin-win-avx2-x64.zip / llama-b3660-bin-win-cuda-cu12.2.0-x64.zip
function ConvertTo-PaddedVersion([string]$v) {
    # [version] needs at least two parts: pad '13' -> 13.0, '12.2.0' stays.
    $parts = $v.Split('.')
    while ($parts.Count -lt 2) { $parts += '0' }
    return [version]($parts -join '.')
}

$assets = @($release.assets)
$toDownload = @()

if ($Variant -eq 'cpu') {
    $main = $assets | Where-Object { $_.name -match '^llama-.*-bin-win-cpu-x64\.zip$' } |
            Select-Object -First 1
    if (-not $main) {
        $main = $assets | Where-Object { $_.name -match '^llama-.*-bin-win-avx2-x64\.zip$' } |
                Select-Object -First 1
    }
    if (-not $main) { throw "No Windows CPU x64 asset found in $($release.tag_name). Check https://github.com/ggml-org/llama.cpp/releases" }
    $toDownload += $main
} else {
    $cudaRegex = '^llama-.*-bin-win-cuda-(?:cu)?(\d+(?:\.\d+){0,2})-x64\.zip$'
    $cudaAssets = $assets | Where-Object { $_.name -match $cudaRegex } |
        ForEach-Object {
            $ver = [regex]::Match($_.name, $cudaRegex).Groups[1].Value
            [pscustomobject]@{ Asset = $_; VerString = $ver; Ver = ConvertTo-PaddedVersion $ver }
        }
    if (-not $cudaAssets) { throw "No Windows CUDA x64 asset found in $($release.tag_name)." }

    if ($CudaVersion) {
        $pick = $cudaAssets | Where-Object { $_.VerString -like "$CudaVersion*" } |
                Sort-Object Ver | Select-Object -Last 1
        if (-not $pick) {
            $available = ($cudaAssets | ForEach-Object VerString) -join ', '
            throw "No CUDA $CudaVersion asset in this release. Available: $available"
        }
    } else {
        # Lowest published line = broadest GPU/driver compatibility.
        $pick = $cudaAssets | Sort-Object Ver | Select-Object -First 1
    }
    $toDownload += $pick.Asset
    Write-Host "CUDA toolkit line: $($pick.VerString)  (older GPUs need lower lines; newer GPUs may want -CudaVersion 13)"

    $cudartRegex = "^cudart-llama-bin-win-(?:cuda-)?(?:cu)?$([regex]::Escape($pick.VerString))-x64\.zip$"
    $cudart = $assets | Where-Object { $_.name -match $cudartRegex } | Select-Object -First 1
    if ($cudart) {
        $toDownload += $cudart
    } else {
        Write-Warning "No cudart bundle found for CUDA $($pick.VerString). If llama-server.exe complains about missing DLLs, install that CUDA runtime."
    }
}

# A running server from the panel locks its exe -- clearing vendor would
# half-delete the old install and then fail.
$running = Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue |
           Where-Object { $_.Path -and $_.Path -like "$vendorDir*" }
if ($running) {
    Write-Host 'Stopping the running llama-server from a previous install...'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 1
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
        Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
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
