<#
.SYNOPSIS
  Removes the AE Llama panel junction from the CEP extensions folder.
  Leaves PlayerDebugMode and this repository untouched.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$linkPath = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.cptk.aellama'

if (Test-Path $linkPath) {
    $item = Get-Item $linkPath -Force
    if ($item.LinkType) {
        $item.Delete()   # removes the junction only, target stays intact
    } else {
        Remove-Item -Recurse -Force $linkPath
    }
    Write-Host "Removed $linkPath" -ForegroundColor Green
} else {
    Write-Host "Nothing to remove at $linkPath"
}
