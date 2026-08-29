<#
.SYNOPSIS
  Downloads a prebuilt whisper.cpp Windows build plus a ggml model into
  %APPDATA%\AE-Llama\vendor\whisper.cpp (the panel's persistent data
  folder), then proves the binary transcribes.

  Same lifecycle as scripts\get-llama.ps1: acquire into vendor, find the
  exe, report the path the panel will use. WHICH file to take is decided
  in scripts\lib\whisper-assets.ps1 so it can be tested without a network.

.DESCRIPTION
  Layout, and why it is split in two:

    vendor\whisper.cpp\bin      the release archive; wiped on every run
    vendor\whisper.cpp\models   ggml-*.bin; NEVER wiped, kept across runs

  get-llama.ps1 can clear its whole vendor folder because a llama.cpp
  build is a 100 MB download. Here the 141 MB model outlives many 8 MB
  binary updates, so re-running to pick up a new build must not cost it.

  The default variant is CPU, deliberately. base.en on CPU transcribes
  far faster than real time, while the CUDA build is a 640 MB download
  whose VRAM would come out of the same budget the tier arbiter in
  tools.js rations between the chat model and ComfyUI. Ask for
  -Variant cublas when you want to spend that.

.EXAMPLE
  .\scripts\get-whisper.ps1                     # CPU build + ggml-base.en
  .\scripts\get-whisper.ps1 -Model small.en     # a bigger model
  .\scripts\get-whisper.ps1 -Variant cublas     # GPU build (640 MB)
  .\scripts\get-whisper.ps1 -SkipVerify         # acquire only
#>
[CmdletBinding()]
param(
    [ValidateSet('cpu', 'blas', 'cublas')]
    [string]$Variant = 'cpu',
    [string]$Tag = '',
    [string]$Model = 'base.en',
    [switch]$SkipModel,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
# The progress bar makes Invoke-WebRequest 10-50x slower on WinPS 5.1.
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5 defaults to TLS 1.0/1.1, which GitHub rejects.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

. (Join-Path $PSScriptRoot 'lib\whisper-assets.ps1')

$root      = Join-Path $env:APPDATA 'AE-Llama\vendor\whisper.cpp'
$binDir    = Join-Path $root 'bin'
$modelsDir = Join-Path $root 'models'

# --------------------------------------------------------------- detection

function Get-AellDriverCuda {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return '' }
    $out = ''
    try { $out = (& nvidia-smi) | Out-String } catch { return '' }
    return (Get-AellCudaVersionFromSmi -Text $out)
}

$driverCuda = ''
if ($Variant -eq 'cublas') {
    $driverCuda = Get-AellDriverCuda
    if ($driverCuda) {
        Write-Host "Driver CUDA version: $driverCuda"
    } else {
        Write-Warning ('nvidia-smi did not report a CUDA version - taking ' +
                       'the newest published CUDA build. If it fails to ' +
                       'load, re-run with -Variant cpu.')
    }
}

# ----------------------------------------------------------- release query

$headers = @{ 'User-Agent' = 'ae-llama-setup' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

function Invoke-AellGitHub([string]$url) {
    try {
        return Invoke-RestMethod -Uri $url -Headers $headers
    } catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        if ($status -eq 403 -or $status -eq 429) {
            throw ("GitHub API rate limit hit (HTTP $status). Set a " +
                   "GITHUB_TOKEN environment variable (any fine-grained " +
                   "token works) or retry in an hour.")
        }
        if ($status -eq 404) {
            throw ("Not found: $url - check " +
                   "https://github.com/ggml-org/whisper.cpp/releases")
        }
        throw
    }
}

if ($Tag) {
    $url = "https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/$Tag"
    Write-Host "Querying release info: $url"
} else {
    # The LIST, not /releases/latest: a release can be published with no
    # assets at all (v1.9.3 was, on 2026-08-29), and the choice has to be
    # able to walk past it. See lib\whisper-assets.ps1.
    $url = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15'
    Write-Host "Querying releases: $url"
}
# Deliberately NOT wrapped in @(): Invoke-RestMethod hands back a JSON
# array as one object, so @() would nest it and the walk below would see
# a single "release" whose .assets is every release's assets pooled.
# Select-AellWhisperRelease flattens whatever shape this is.
$releases = Invoke-AellGitHub $url

$choice = Select-AellWhisperRelease -Releases $releases -Variant $Variant `
                                    -DriverCuda $driverCuda
$release = $choice.Release
$asset   = $choice.Asset
Write-Host ("Release: {0} -> {1} ({2} MB)" -f
            $release.tag_name, $asset.name, [math]::Round($asset.size / 1MB, 1))

# ------------------------------------------------------ download & install

# A running whisper process from a previous install locks its exe, which
# would half-delete the folder and then fail. Same guard as get-llama.
$running = Get-Process -Name 'whisper-server', 'whisper-cli' -ErrorAction SilentlyContinue |
           Where-Object { $_.Path -and $_.Path -like "$root*" }
if ($running) {
    Write-Host 'Stopping a whisper process from a previous install...'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 1
}

if (Test-Path $binDir) {
    Write-Host "Clearing $binDir"
    Remove-Item -Recurse -Force $binDir
}
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

$tempDir = Join-Path ([IO.Path]::GetTempPath()) "ae-whisper-dl-$([IO.Path]::GetRandomFileName())"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
try {
    $zipPath = Join-Path $tempDir $asset.name
    Write-Host "Downloading $($asset.name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing
    Write-Host "Extracting into $binDir"
    Expand-Archive -Path $zipPath -DestinationPath $binDir -Force
} finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}

# The archive nests everything under Release\, and main.exe next to it is
# a deprecation shim -- whisper-cli.exe is the transcriber.
$cli = Get-ChildItem -Path $binDir -Recurse -Filter $script:AellWhisperExe |
       Select-Object -First 1
if (-not $cli) {
    $got = (Get-ChildItem -Path $binDir -Recurse -Filter '*.exe' |
            ForEach-Object { $_.Name }) -join ', '
    throw ("Extraction finished but $($script:AellWhisperExe) is not under " +
           "$binDir. Executables found: $got")
}
Write-Host "whisper-cli: $($cli.FullName)"

# ------------------------------------------------------------------ model

$modelPath = ''
if ($SkipModel) {
    Write-Host 'Skipping the model download (-SkipModel).'
} else {
    $m = Get-AellWhisperModelUrl -Model $Model
    $modelPath = Join-Path $modelsDir $m.FileName
    if (Test-Path $modelPath) {
        Write-Host ("Model already present: {0} ({1} MB)" -f
                    $modelPath, [math]::Round((Get-Item $modelPath).Length / 1MB, 1))
    } else {
        Write-Host "Downloading $($m.FileName) from $($m.Url) ..."
        # To a .part first: a half-written model left in place looks
        # acquired on the next run and fails at load instead.
        $part = "$modelPath.part"
        Invoke-WebRequest -Uri $m.Url -OutFile $part -UseBasicParsing
        Move-Item -Force $part $modelPath
        Write-Host ("Saved {0} ({1} MB)" -f
                    $modelPath, [math]::Round((Get-Item $modelPath).Length / 1MB, 1))
    }
}

# ----------------------------------------------------------------- verify

if (-not $SkipVerify -and $modelPath) {
    Write-Host ''
    Write-Host 'Verifying: synthesizing a WAV and transcribing it...'
    $phrase = 'the quick brown fox jumps over the lazy dog'
    $wav = Join-Path ([IO.Path]::GetTempPath()) "ae-whisper-check-$PID.wav"
    try {
        Add-Type -AssemblyName System.Speech
        # 16 kHz mono 16-bit is what whisper.cpp wants; the synthesizer's
        # own default is not, and whisper refuses anything else.
        $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
            16000,
            [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
            [System.Speech.AudioFormat.AudioChannel]::Mono)
        $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            $tts.SetOutputToWaveFile($wav, $fmt)
            $tts.Speak($phrase)
        } finally {
            $tts.SetOutputToNull()
            $tts.Dispose()
        }

        $sw = [Diagnostics.Stopwatch]::StartNew()
        $text = (& $cli.FullName -m $modelPath -f $wav -nt -np) | Out-String
        $sw.Stop()
        $flat = ($text -replace '[^a-zA-Z ]', ' ') -replace '\s+', ' '
        $flat = $flat.Trim().ToLower()
        Write-Host ("Transcript: [{0}] ({1} ms)" -f $flat, $sw.ElapsedMilliseconds)
        if ($flat -like "*$phrase*") {
            Write-Host 'Verify: PASS' -ForegroundColor Green
        } else {
            throw ("Verify FAILED: transcript does not contain the spoken " +
                   "phrase.  spoken: $phrase  heard: $flat")
        }
    } finally {
        Remove-Item -Force $wav -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host "Done. whisper-cli: $($cli.FullName)" -ForegroundColor Green
if ($modelPath) { Write-Host "       model: $modelPath" -ForegroundColor Green }
