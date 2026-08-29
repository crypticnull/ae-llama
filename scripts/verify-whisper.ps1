<#
.SYNOPSIS
  Proves the installed whisper.cpp actually transcribes, with audio this
  machine speaks to itself. No recording to ship, no microphone, nothing
  to check in.

.DESCRIPTION
  For each phrase: synthesize a WAV with the Windows speech synthesizer,
  run whisper-cli over it, and assert the SPOKEN PHRASE comes back.

  Not "assert something came back": two seconds of digital silence
  transcribes as " You" on this build, so a non-empty check passes on a
  file with no speech in it at all. The whole point of the harness is to
  catch exactly that.

  With no install present this SKIPS and exits 0 - that is the normal
  state on a CI runner, which has no 150 MB model. Pass -Require to turn
  a missing install into a failure.

  Exit codes: 0 pass or skip, 1 a phrase failed, 2 no install under
  -Require.

.EXAMPLE
  .\scripts\verify-whisper.ps1
  .\scripts\verify-whisper.ps1 -Phrase 'render the composition'
  .\scripts\verify-whisper.ps1 -Model small.en -Require
#>
[CmdletBinding()]
param(
    # Install root; defaults to %APPDATA%\AE-Llama\vendor\whisper.cpp.
    [string]$Root = '',
    # Bare size ('base.en') or file name. Empty takes the smallest present.
    [string]$Model = '',
    # One or more phrases to speak. Empty uses the built-in three.
    [string[]]$Phrase = @(),
    # Treat "not installed" as a failure instead of a skip.
    [switch]$Require,
    [int]$TimeoutMs = 120000
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\whisper-verify.ps1')

$run = Invoke-AellWhisperVerify -Root $Root -Model $Model -Phrases $Phrase `
                                -TimeoutMs $TimeoutMs

if ($run.Skipped) {
    if ($Require) {
        Write-Host "whisper verify: FAILED (-Require)" -ForegroundColor Red
        Write-Host "  $($run.Reason)"
        exit 2
    }
    Write-Host "whisper verify: SKIP - $($run.Reason)" -ForegroundColor Yellow
    exit 0
}

Write-Host "whisper-cli: $($run.Install.Cli)"
Write-Host "      model: $($run.Install.Model)"
Write-Host ''

foreach ($r in $run.Results) {
    if ($r.Pass) {
        Write-Host ("  ok   - [{0}] ({1} ms)" -f $r.Phrase, $r.Ms) -ForegroundColor Green
    } else {
        Write-Host ("  FAIL - [{0}] ({1} ms)" -f $r.Phrase, $r.Ms) -ForegroundColor Red
        Write-Host ("         {0}" -f $r.Error)
    }
}

Write-Host ''
if ($run.Passed -eq $run.Total) {
    Write-Host ("whisper verify: {0}/{1} PASSED" -f $run.Passed, $run.Total) `
               -ForegroundColor Green
    exit 0
}
Write-Host ("whisper verify: {0}/{1} passed - FAILED" -f $run.Passed, $run.Total) `
           -ForegroundColor Red
exit 1
