<#
.SYNOPSIS
  Downloads a static ffmpeg Windows build into
  %APPDATA%\AE-Llama\vendor\ffmpeg (the panel's persistent data folder),
  then proves it encodes by writing a clip and reading it back with
  ffprobe.

  Same lifecycle as scripts\get-llama.ps1 and scripts\get-whisper.ps1:
  acquire into vendor, find the exe, report the path the panel will use.
  WHICH file to take is decided in scripts\lib\ffmpeg-assets.ps1 so it can
  be tested without a network; the round trip lives in
  scripts\lib\ffmpeg-verify.ps1 so the acquirer, scripts\verify-ffmpeg.ps1
  and the Node test all run the SAME check.

.DESCRIPTION
  Layout:

    vendor\ffmpeg\bin    the release archive; wiped on every run

  One folder, not two. get-whisper.ps1 splits bin from models because a
  141 MB model outlives many 8 MB binary updates; ffmpeg has no model, so
  a re-run is simply a fresh download.

  THE LICENCE IS A DELIBERATE DEFAULT, AND IT IS NOT THE OBVIOUS ONE.
  BtbN publishes each build twice, GPL and LGPL. The GPL build carries
  libx264 and libx265; the LGPL one does not. The panel is a personal
  tool, not for sale (owner, 2026-09-28), but its repo is public, and
  publishing -- or bundling an installer that fetches -- GPL binaries
  alongside it is still a licensing question for a human, not a default
  for a script. So LGPL is the default and -License gpl is
  an explicit, logged choice.

  That default has a cost, and the point of printing the encoder census
  at the end is that the cost is MEASURED on the binary rather than
  assumed from the name: whatever H.264 encoder WORKPLAN 6.2 Pass B ends
  up using for export_social has to be one this build actually has.

  If ffmpeg is already on PATH, this script still installs a private copy
  (that is what it is for), but scripts\verify-ffmpeg.ps1 and
  Find-AellFfmpegInstall will use the PATH one when no vendored copy
  exists -- this machine already had ffmpeg 8.1 in C:\Program Files.

.EXAMPLE
  .\scripts\get-ffmpeg.ps1                    # LGPL static win64 (140 MB)
  .\scripts\get-ffmpeg.ps1 -License gpl       # adds libx264/libx265
  .\scripts\get-ffmpeg.ps1 -Series master     # nightly instead of n9.0
  .\scripts\get-ffmpeg.ps1 -SkipVerify        # acquire only
#>
[CmdletBinding()]
param(
    [ValidateSet('lgpl', 'gpl')]
    [string]$License = 'lgpl',
    [ValidateSet('static', 'shared')]
    [string]$Linking = 'static',
    # 'release' (highest numbered series), 'master', or e.g. 'n8.1'.
    [string]$Series = 'release',
    [string]$Platform = 'win64',
    [string]$Tag = '',
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
# The progress bar makes Invoke-WebRequest 10-50x slower on WinPS 5.1.
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5 defaults to TLS 1.0/1.1, which GitHub rejects.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ffmpeg-verify.ps1 dot-sources ffmpeg-assets.ps1 itself (the download
# choice), so this one line brings in both.
. (Join-Path $PSScriptRoot 'lib\ffmpeg-verify.ps1')

$root   = Get-AellFfmpegRoot
$binDir = Join-Path $root 'bin'

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
                   "https://github.com/$($script:AellFfmpegRepo)/releases")
        }
        throw
    }
}

if ($Tag) {
    $url = ("https://api.github.com/repos/{0}/releases/tags/{1}" -f
            $script:AellFfmpegRepo, $Tag)
    Write-Host "Querying release info: $url"
} else {
    # The LIST, not /releases/latest. `latest` here is a real rolling tag
    # that is normally first, but the dated autobuild releases carry the
    # same 49 assets under a DIFFERENT naming scheme, and the walk has to
    # be able to reach them. See lib\ffmpeg-assets.ps1 note 2.
    $url = ("https://api.github.com/repos/{0}/releases?per_page=10" -f
            $script:AellFfmpegRepo)
    Write-Host "Querying releases: $url"
}
# Deliberately NOT wrapped in @(): Invoke-RestMethod hands back a JSON
# array as one object, so @() would nest it and the walk below would see a
# single "release" whose .assets is every release's assets pooled.
# Expand-AellReleaseList (lib\gh-releases.ps1) flattens whatever this is.
$releases = Invoke-AellGitHub $url

$choice = Select-AellFfmpegRelease -Releases $releases -License $License `
                                   -Platform $Platform -Linking $Linking `
                                   -Series $Series
$release = $choice.Release
$asset   = $choice.Asset
Write-Host ("Release: {0} -> {1} ({2} MB)" -f
            $release.tag_name, $asset.name, [math]::Round($asset.size / 1MB, 1))
if ($release.tag_name -eq 'latest') {
    Write-Host ("Note: 'latest' is a rolling tag. The version installed is " +
                "read from the binary below, not from the tag.")
}

# ------------------------------------------------------ download & install

# A running ffmpeg from a previous install locks its exe, which would
# half-delete the folder and then fail. Same guard as get-whisper.
$running = Get-Process -Name 'ffmpeg', 'ffprobe' -ErrorAction SilentlyContinue |
           Where-Object { $_.Path -and $_.Path -like "$root*" }
if ($running) {
    Write-Host 'Stopping an ffmpeg process from a previous install...'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 1
}

if (Test-Path $binDir) {
    Write-Host "Clearing $binDir"
    Remove-Item -Recurse -Force $binDir
}
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$tempDir = Join-Path ([IO.Path]::GetTempPath()) "ae-ffmpeg-dl-$([IO.Path]::GetRandomFileName())"
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

# The archive nests everything under ffmpeg-<build>-win64-<lic>\bin\, so
# the lookup is recursive -- and it wants BOTH binaries, because ffprobe
# is what every check in this repo reads results with.
$install = Find-AellFfmpegInstall -Root $root -VendorOnly
if (-not $install.Ok) {
    $got = ''
    if (Test-Path $binDir) {
        $got = (Get-ChildItem -Path $binDir -Recurse -Filter '*.exe' `
                              -ErrorAction SilentlyContinue |
                ForEach-Object { $_.Name }) -join ', '
    }
    if (-not $got) { $got = '(none)' }
    throw ("Extraction finished but the install is incomplete. " +
           "$($install.Reason) Executables found: $got")
}
Write-Host "ffmpeg:  $($install.Ffmpeg)"
Write-Host "ffprobe: $($install.Ffprobe)"

# ----------------------------------------------------------------- verify

if (-not $SkipVerify) {
    Write-Host ''
    Write-Host 'Verifying: writing a clip and reading it back...'
    # The round trip lives in lib\ffmpeg-verify.ps1 so this, the
    # standalone scripts\verify-ffmpeg.ps1 and the Node test all run the
    # SAME check. It asserts the clip's width, height and FRAME COUNT --
    # not that ffmpeg exited 0, which it also does when it refuses to
    # overwrite an existing file and writes nothing at all.
    $check = Invoke-AellFfmpegCheck -Install $install
    if ($check.Pass) {
        # The format string is built FIRST and fed to -f as one operand.
        # Written as ("a{0}" + "b{1}" -f $x, $y) the -f binds to the
        # second literal alone, and the first half prints its braces
        # verbatim -- which is exactly what this line did on its first
        # real run: "Wrote and read back {0}x{1}, {2} frames".
        $fmt = ("Wrote and read back {0}x{1}, {2} frames, {3}s, codec {4} " +
                "({5} bytes, {6} ms)")
        Write-Host ($fmt -f
                    $check.Probe.Width, $check.Probe.Height, $check.Probe.Frames,
                    $check.Probe.Seconds, $check.Probe.Codec, $check.Bytes, $check.Ms)
        Write-Host "ffmpeg version: $($check.Version)"
        Write-Host 'Verify: PASS' -ForegroundColor Green
    } else {
        throw "Verify FAILED: $($check.Reason)"
    }

    # The licence choice, measured rather than assumed. See the header.
    Write-Host ''
    Write-Host "Encoders in this $License build:"
    $enc = Get-AellFfmpegEncoders -Ffmpeg $install.Ffmpeg
    foreach ($k in $enc.Keys) {
        $mark = if ($enc[$k]) { 'yes' } else { 'NO ' }
        Write-Host ("  {0}  {1}" -f $mark, $k)
    }
}

Write-Host ''
Write-Host "Done. ffmpeg: $($install.Ffmpeg)" -ForegroundColor Green
Write-Host "     ffprobe: $($install.Ffprobe)" -ForegroundColor Green
