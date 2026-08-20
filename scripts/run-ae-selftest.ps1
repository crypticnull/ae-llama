# run-ae-selftest.ps1 - drive REAL After Effects through the panel's
# self-test suite from the command line, no panel and no LLM involved.
# Meant for a local agent (or a human) iterating on this repo:
#
#   powershell -ExecutionPolicy Bypass -File scripts/run-ae-selftest.ps1
#
# Exit codes: 0 = all passed, 1 = failures, 2 = AfterFX.exe not found,
# 3 = no results (AE not running / scripting file access disabled).
#
# Requirements:
# - After Effects installed (auto-detected under Program Files, or pass
#   -AfterFXPath). AE may already be running; -r reuses the instance.
# - AE preference enabled: Preferences > Scripting & Expressions >
#   "Allow Scripts to Write Files and Access Network".

param(
  [string]$AfterFXPath = "",
  [string]$RepoRoot = "",
  [int]$TimeoutSec = 240
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path $RepoRoot).Path

if (-not $AfterFXPath) {
  $adobe = "C:\Program Files\Adobe"
  if (Test-Path $adobe) {
    $dirs = Get-ChildItem $adobe -Directory -Filter "Adobe After Effects*" |
      Sort-Object Name -Descending
    foreach ($d in $dirs) {
      $exe = Join-Path $d.FullName "Support Files\AfterFX.exe"
      if (Test-Path $exe) { $AfterFXPath = $exe; break }
    }
  }
}
if (-not $AfterFXPath -or -not (Test-Path $AfterFXPath)) {
  Write-Host "AfterFX.exe not found - pass -AfterFXPath 'C:\...\AfterFX.exe'"
  exit 2
}

$out = Join-Path $env:TEMP "aell-selftest-results.json"
Remove-Item $out -ErrorAction SilentlyContinue

$repoFs = $RepoRoot -replace "\\", "/"
$outFs = $out -replace "\\", "/"

# Single-quoted here-string: nothing interpolates; placeholders are
# replaced explicitly so ExtendScript's $.global survives untouched.
$wrapperTemplate = @'
$.global.AELL_TEST_REPO = "__REPO__";
$.global.AELL_TEST_OUT = "__OUT__";
$.evalFile(new File("__REPO__/scripts/ae-selftest.jsx"));
'@
$wrapper = Join-Path $env:TEMP "aell-selftest-run.jsx"
$wrapperTemplate.Replace("__REPO__", $repoFs).Replace("__OUT__", $outFs) |
  Set-Content -Path $wrapper -Encoding ASCII

Write-Host ("Running self-test via " + $AfterFXPath)
& $AfterFXPath -r $wrapper | Out-Null

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path $out) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
}
if (-not (Test-Path $out)) {
  Write-Host ("No results after " + $TimeoutSec + "s. Checks: is AE " +
    "running/launching? Is 'Allow Scripts to Write Files and Access " +
    "Network' enabled in Preferences > Scripting & Expressions?")
  exit 3
}

$res = Get-Content $out -Raw | ConvertFrom-Json
Write-Host "----"
Write-Host $res.text
Write-Host "----"
if ($res.total -gt 0 -and $res.passed -eq $res.total) {
  Write-Host "SELF-TEST PASSED"
  exit 0
}
Write-Host "SELF-TEST FAILED"
exit 1
