<#
.SYNOPSIS
  Removes the AE Llama panel junction from the CEP extensions folder.
  Leaves PlayerDebugMode and this repository untouched.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$linkPath = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.cptk.aellama'

# Get-Item -Force (not Test-Path, which follows the link) so a DANGLING
# junction -- repo already moved or deleted -- is still found and removed.
$item = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
if ($item) {
    if ($item.LinkType) {
        $item.Delete()   # removes the junction only, target stays intact
    } else {
        Remove-Item -Recurse -Force $linkPath
    }
    Write-Host "Removed $linkPath" -ForegroundColor Green
} else {
    Write-Host "Nothing to remove at $linkPath"
}
