<#
.SYNOPSIS
  Builds a signed ZXP of the panel for installing outside a dev junction.

  - Stages extension\ into a clean temp copy (dev-only files excluded).
  - Verifies the version in CSXS\manifest.xml matches js\version.js.
  - Signs with ZXPSignCmd (Adobe's tool, from Adobe-CEP/CEP-Resources on
    GitHub). A self-signed cert is created on first run and reused -- fine
    for CEP: the ZXP installs with any ZXP installer or install-zxp.ps1,
    no PlayerDebugMode needed.

.EXAMPLE
  .\scripts\package-zxp.ps1
  .\scripts\package-zxp.ps1 -ZxpSignCmd C:\tools\ZXPSignCmd.exe
  .\scripts\package-zxp.ps1 -CertFile my.p12 -CertPassword secret
#>
[CmdletBinding()]
param(
    [string]$ZxpSignCmd = '',
    [string]$CertFile = '',
    [string]$CertPassword = 'ae-llama-selfsign',
    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$srcDir   = Join-Path $repoRoot 'extension'
$distDir  = Join-Path $repoRoot 'dist'

# ------------------------------------------------------------ find signer

if (-not $ZxpSignCmd) {
    $candidates = @(
        (Get-Command ZXPSignCmd -ErrorAction SilentlyContinue).Source,
        (Join-Path $repoRoot 'tools\ZXPSignCmd.exe'),
        'C:\tools\ZXPSignCmd.exe'
    ) | Where-Object { $_ -and (Test-Path $_) }
    $ZxpSignCmd = $candidates | Select-Object -First 1
}
if (-not $ZxpSignCmd -or -not (Test-Path $ZxpSignCmd)) {
    throw ("ZXPSignCmd.exe not found. Download it from " +
           "https://github.com/Adobe-CEP/CEP-Resources (ZXPSignCMD folder), " +
           "then pass -ZxpSignCmd <path> or drop it in <repo>\tools\.")
}

# --------------------------------------------------------- version checks

$manifestPath = Join-Path $srcDir 'CSXS\manifest.xml'
$manifestText = Get-Content -Raw $manifestPath
if ($manifestText -notmatch 'ExtensionBundleVersion="([\d\.]+)"') {
    throw "Could not read ExtensionBundleVersion from $manifestPath"
}
$version = $Matches[1]

$versionJs = Get-Content -Raw (Join-Path $srcDir 'js\version.js')
if ($versionJs -notmatch 'VERSION:\s*"([\d\.]+)"') {
    throw "Could not read VERSION from js\version.js"
}
if ($Matches[1] -ne $version) {
    throw ("Version mismatch: manifest.xml says $version but version.js says " +
           "$($Matches[1]). Bump both together (and update.json when publishing).")
}

# ----------------------------------------------------------------- staging

$stageDir = Join-Path ([IO.Path]::GetTempPath()) "ae-llama-zxp-$([IO.Path]::GetRandomFileName())"
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
try {
    # Dev/user data never ships: .debug enables remote debugging; vendor/,
    # models/, generated/ may hold gigabytes on a dev machine.
    $exclude = @('.debug')
    $excludeDirs = @('vendor', 'models', 'generated')
    Get-ChildItem -LiteralPath $srcDir -Force | ForEach-Object {
        if ($_.PSIsContainer -and $excludeDirs -contains $_.Name) { return }
        if (-not $_.PSIsContainer -and $exclude -contains $_.Name) { return }
        Copy-Item -LiteralPath $_.FullName -Destination $stageDir -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $distDir | Out-Null

    # ------------------------------------------------------------- signing
    if (-not $CertFile) {
        $CertFile = Join-Path $distDir 'ae-llama-selfsigned.p12'
        if (-not (Test-Path $CertFile)) {
            Write-Host 'Creating self-signed certificate (one time)...'
            & $ZxpSignCmd -selfSignedCert US NY 'CPTK' 'AE Llama' $CertPassword $CertFile
            if ($LASTEXITCODE -ne 0) { throw 'Certificate creation failed.' }
        }
    }

    $outZxp = Join-Path $distDir "AE-Llama-$version.zxp"
    if (Test-Path $outZxp) { Remove-Item -Force $outZxp }

    Write-Host "Signing $outZxp ..."
    & $ZxpSignCmd -sign $stageDir $outZxp $CertFile $CertPassword -tsa $TimestampUrl
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outZxp)) {
        # Timestamp servers flake; retry once without -tsa so a build is
        # never blocked on a third-party service.
        Write-Warning 'Signing with timestamp failed - retrying without -tsa.'
        & $ZxpSignCmd -sign $stageDir $outZxp $CertFile $CertPassword
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outZxp)) { throw 'Signing failed.' }
    }

    # ------------------------------------------------------- verification
    # Adobe's own tool reading back what we just wrote. A ZXP whose
    # signature does not verify installs from a junction and fails from
    # the store, which is the worst possible place to find out --
    # especially once the bundle carries more than one <Extension>
    # (docs/PREMIERE_PLAN.md), since the manifest is signed DATA and a
    # second entry changes those bytes.
    & $ZxpSignCmd -verify $outZxp -certinfo
    if ($LASTEXITCODE -ne 0) {
        throw "ZXPSignCmd -verify rejected $outZxp - do not publish it."
    }
    Write-Host 'Signature verified.' -ForegroundColor Green

    $size = [math]::Round((Get-Item $outZxp).Length / 1MB, 2)
    Write-Host ''
    Write-Host "Done: $outZxp ($size MB)" -ForegroundColor Green
    Write-Host 'Next: upload to aescripts.com, then publish the matching'
    Write-Host 'panelVersion in your hosted update.json so installed panels'
    Write-Host 'show the update banner.'
} finally {
    Remove-Item -Recurse -Force $stageDir -ErrorAction SilentlyContinue
}
