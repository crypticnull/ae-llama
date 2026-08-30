<#
.SYNOPSIS
  Proves the installed ffmpeg actually encodes, using clips this machine
  writes for itself. No sample media to ship, nothing to check in.

.DESCRIPTION
  For each clip shape: write it with ffmpeg from lavfi `testsrc`, read it
  back with ffprobe, and assert the WIDTH, HEIGHT, FRAME COUNT and
  duration are the ones that were asked for.

  Not "assert ffmpeg exited 0". Measured on 2026-08-30: `ffmpeg -t 0`
  writes a 262-byte MP4 with ZERO streams and exits 0, ffprobe then exits
  0 on it with valid JSON, an empty stderr and probe_score 100 -- so
  every layer of the obvious check reports success on a file with no
  video in it. And ffmpeg exits 0 when it REFUSES to overwrite an
  existing output, writing nothing at all. The last check in the run is
  the negative one: it builds that empty file on purpose and fails if the
  checker accepts it.

  With no install present this SKIPS and exits 0 - the normal state on a
  CI runner. Pass -Require to turn a missing install into a failure. The
  PATH fallback means a machine with its own ffmpeg is verified too;
  -VendorOnly restricts it to the copy get-ffmpeg.ps1 installed.

  Exit codes: 0 pass or skip, 1 a check failed, 2 no install under
  -Require.

.EXAMPLE
  .\scripts\verify-ffmpeg.ps1
  .\scripts\verify-ffmpeg.ps1 -VendorOnly -Require
#>
[CmdletBinding()]
param(
    # Install root; defaults to %APPDATA%\AE-Llama\vendor\ffmpeg.
    [string]$Root = '',
    # Ignore an ffmpeg on PATH and check only the vendored copy.
    [switch]$VendorOnly,
    # Treat "not installed" as a failure instead of a skip.
    [switch]$Require
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\ffmpeg-verify.ps1')

$run = Invoke-AellFfmpegVerify -Root $Root -VendorOnly:$VendorOnly

if ($run.Skipped) {
    if ($Require) {
        Write-Host "ffmpeg verify: FAILED (-Require)" -ForegroundColor Red
        Write-Host "  $($run.Reason)"
        exit 2
    }
    Write-Host "ffmpeg verify: SKIP - $($run.Reason)" -ForegroundColor Yellow
    exit 0
}

Write-Host "ffmpeg:  $($run.Install.Ffmpeg)"
Write-Host "ffprobe: $($run.Install.Ffprobe)"
Write-Host "source:  $($run.Install.Source)"
Write-Host "version: $($run.Version)"
Write-Host ''

foreach ($r in $run.Results) {
    if ($r.Pass) {
        Write-Host ("  ok   - {0} ({1} ms)" -f $r.Label, $r.Ms) -ForegroundColor Green
        if ($r.Detail) { Write-Host ("         rejected with: {0}" -f $r.Detail) }
    } else {
        Write-Host ("  FAIL - {0} ({1} ms)" -f $r.Label, $r.Ms) -ForegroundColor Red
        Write-Host ("         {0}" -f $r.Error)
    }
}

if ($run.Encoders) {
    Write-Host ''
    Write-Host 'Encoders present:'
    $yes = @(); $no = @()
    foreach ($k in $run.Encoders.Keys) {
        if ($run.Encoders[$k]) { $yes += $k } else { $no += $k }
    }
    Write-Host ("  yes: " + (($yes -join ', ')  -replace '^$', '(none)'))
    Write-Host ("  no:  " + (($no  -join ', ')  -replace '^$', '(none)'))
}

Write-Host ''
if ($run.Passed -eq $run.Total) {
    Write-Host ("ffmpeg verify: {0}/{1} PASSED" -f $run.Passed, $run.Total) `
               -ForegroundColor Green
    exit 0
}
Write-Host ("ffmpeg verify: {0}/{1} passed - FAILED" -f $run.Passed, $run.Total) `
           -ForegroundColor Red
exit 1
