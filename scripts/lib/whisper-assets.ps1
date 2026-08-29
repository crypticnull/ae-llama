# whisper-assets.ps1 - decide WHICH whisper.cpp download to take.
#
# Kept in its own file, away from the I/O in get-whisper.ps1, so
# tests/test-whisper-acquire.js can feed it the asset lists captured from
# the real GitHub API without downloading 640 MB (or needing a network at
# all). Same split as ae-dialog-triage.ps1 / run-ae-selftest.ps1.
#
# Three things the probe on 2026-08-29 measured, each of which breaks the
# obvious implementation:
#
#  1. The NEWEST tag is not the one with the files. On that day
#     ggml-org/whisper.cpp's newest release was v1.9.3, a PRERELEASE with
#     ZERO assets; the newest release carrying Windows builds was b4938,
#     tagged the same day. /releases/latest happens to skip prereleases,
#     but an asset-less non-prerelease would sail straight past it, so
#     the choice walks the release LIST and takes the first one that
#     actually has a build for the requested variant.
#  2. The archive is not flat: every file sits under `Release/`, and the
#     transcriber is `whisper-cli.exe`. `main.exe` is still in the zip but
#     is a 27 KB deprecation shim, so "find main.exe" finds a stub that
#     prints a rename notice.
#  3. The MODEL lives under the `ggerganov` HuggingFace org, not
#     `ggml-org`. llama.cpp moved to ggml-org and the whisper REPO moved
#     with it, so ggml-org/whisper.cpp is the natural guess -- it answers
#     HTTP 401, not 404, which reads like an auth problem rather than a
#     wrong address.
#  4. Invoke-RestMethod on a JSON ARRAY emits ONE object that IS the
#     array; it does not enumerate into the pipeline the way nearly every
#     other cmdlet does. So `@(Invoke-RestMethod .../releases)` yields a
#     one-element array holding all 15 releases, `foreach` runs ONCE with
#     $r bound to the whole list, and $r.assets silently property-
#     flattens into every asset of every release. The first version of
#     this script did exactly that: it downloaded a real whisper-bin
#     archive out of the pooled list -- from no particular release -- and
#     printed "Release: System.Object[]". A pass that only checked the
#     transcript would have called it green. Expand-AellReleaseList is
#     the guard, and it runs INSIDE the choice so nothing can reach the
#     walk without it.

# The single file that proves an install works. See note 2 above.
$script:AellWhisperExe = 'whisper-cli.exe'

# HuggingFace org hosting the ggml model files. See note 3 above.
$script:AellWhisperModelRepo = 'ggerganov/whisper.cpp'

# Every model published in that repo, smallest first. Used to ground the
# error when someone asks for one that is not there.
$script:AellWhisperModels = @(
  'tiny.en', 'tiny', 'base.en', 'base', 'small.en', 'small',
  'medium.en', 'medium', 'large-v1', 'large-v2', 'large-v3',
  'large-v3-turbo'
)

function ConvertTo-AellPaddedVersion([string]$v) {
  # Padded to THREE parts, and that is not cosmetic. [version] fills a
  # missing part with -1, not 0, so [version]'11.8' compares LESS than
  # [version]'11.8.0' -- which made a driver reporting "11.8" reject the
  # whisper-cublas-11.8.0 build built exactly for it, and fall through to
  # "no compatible build". Padding both sides to 11.8.0 makes them equal.
  $parts = $v.Split('.')
  while ($parts.Count -lt 3) { $parts += '0' }
  return [version]($parts -join '.')
}

function Get-AellCudaVersionFromSmi {
  <#
    Pull the driver's CUDA version out of `nvidia-smi` banner text.

    Measured on this machine 2026-08-29, driver 616.56 / RTX 5090, the
    banner reads:

      | NVIDIA-SMI 616.56   KMD Version: 616.56   CUDA UMD Version: 13.4 |

    -- "CUDA UMD Version", not the "CUDA Version" every script (including
    scripts\get-llama.ps1) greps for. The old regex finds nothing and the
    caller quietly loses its driver ceiling, so the label is optional
    here. Returns '' when the banner says nothing, which is a legitimate
    answer: take the newest published build and let it speak for itself.
  #>
  param([string]$Text = '')

  if ($Text -match 'CUDA(?:\s+\w+)?\s+Version\s*:\s*([\d]+(?:\.[\d]+)*)') {
    return $Matches[1]
  }
  return ''
}

function Get-AellWhisperCublasAssets {
  param($Assets)
  # whisper-cublas-12.4.0-bin-x64.zip -> 12.4.0
  $rx = '^whisper-cublas-(\d+(?:\.\d+){0,2})-bin-x64\.zip$'
  $out = @()
  foreach ($a in @($Assets)) {
    if ($a.name -match $rx) {
      $ver = [regex]::Match($a.name, $rx).Groups[1].Value
      $out += [pscustomobject]@{
        Asset = $a; VerString = $ver; Ver = ConvertTo-AellPaddedVersion $ver
      }
    }
  }
  return $out
}

function Select-AellWhisperAsset {
  <#
    Pick the one asset to download from a release's asset list.

    Variant cpu / blas are exact names. cublas picks the HIGHEST toolkit
    line the driver can run: a build newer than the driver's CUDA version
    fails at load time, and there is no way to tell that apart from a
    missing DLL once it happens.

    Returns $null when the release has nothing for this variant -- the
    caller walks on to an older release rather than failing, so this is a
    normal answer and not an error.
  #>
  param(
    $Assets,
    [ValidateSet('cpu', 'blas', 'cublas')]
    [string]$Variant = 'cpu',
    # Driver CUDA version, e.g. '13.0'. Empty = take the newest published.
    [string]$DriverCuda = ''
  )

  $all = @($Assets)
  if ($Variant -eq 'cpu') {
    return ($all | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } |
            Select-Object -First 1)
  }
  if ($Variant -eq 'blas') {
    return ($all | Where-Object { $_.name -eq 'whisper-blas-bin-x64.zip' } |
            Select-Object -First 1)
  }

  $cuda = @(Get-AellWhisperCublasAssets $all)
  if (-not $cuda) { return $null }
  if ($DriverCuda) {
    $max = ConvertTo-AellPaddedVersion $DriverCuda
    $fit = @($cuda | Where-Object { $_.Ver -le $max })
    if (-not $fit) { return $null }
    $cuda = $fit
  }
  $pick = $cuda | Sort-Object Ver | Select-Object -Last 1
  return $pick.Asset
}

function Expand-AellReleaseList {
  <#
    Flatten nested arrays down to one release per element. See note 4 at
    the top: the caller cannot tell by looking whether it holds 15
    releases or one array of 15, and getting it wrong does not throw --
    it quietly pools every release's assets together.
  #>
  param($Releases)

  $out = @()
  foreach ($r in @($Releases)) {
    if ($null -eq $r) { continue }
    if ($r -is [System.Array]) { $out += @(Expand-AellReleaseList $r) }
    else { $out += $r }
  }
  # Emitted WITHOUT a leading comma, so `@(Expand-AellReleaseList $x)` is
  # the count of releases. Returning `,$out` instead hands back a single
  # object that IS the array, and then the caller's own @() re-wraps it
  # into one element -- the exact nesting this function exists to undo.
  # Safe here only because no element of $out is itself an array.
  return $out
}

function Select-AellWhisperRelease {
  <#
    Walk releases newest-first and return the first that HAS a build for
    this variant, as @{ Release = ...; Asset = ... }. Throws with the tags
    it looked at and what they carried when none of them do -- the
    grounded-error rule: never say "not found" without saying what is.
  #>
  param(
    $Releases,
    [ValidateSet('cpu', 'blas', 'cublas')]
    [string]$Variant = 'cpu',
    [string]$DriverCuda = ''
  )

  $seen = @()
  foreach ($r in @(Expand-AellReleaseList $Releases)) {
    $asset = Select-AellWhisperAsset -Assets $r.assets -Variant $Variant `
                                     -DriverCuda $DriverCuda
    if ($asset) {
      return [pscustomobject]@{ Release = $r; Asset = $asset }
    }
    # Where-Object, not just the projection: a release with an empty JSON
    # assets list yields $null here, and @($null) is a ONE-element array
    # holding nothing -- which printed the release as "b4938 ()" instead
    # of saying it had no assets at all.
    $names = @(@($r.assets) | ForEach-Object { $_.name } |
               Where-Object { $_ })
    if ($names.Count -eq 0) {
      $seen += ("{0} (no assets)" -f $r.tag_name)
    } else {
      $seen += ("{0} ({1})" -f $r.tag_name, ($names -join ', '))
    }
  }

  $hint = ''
  if ($Variant -eq 'cublas' -and $DriverCuda) {
    $hint = (" Every published CUDA build is newer than this driver's " +
             "CUDA $DriverCuda; update the NVIDIA driver or use " +
             "-Variant cpu.")
  }
  throw ("No whisper.cpp Windows x64 '$Variant' build in any of the " +
         "releases checked.$hint Looked at: " + ($seen -join ' | '))
}

function Get-AellWhisperModelUrl {
  <#
    Direct-download URL for a ggml model. Grounds a typo with the real
    list rather than letting HuggingFace answer 401/404 for it.
  #>
  param([string]$Model = 'base.en')

  $m = $Model
  # Accept the file name as well as the bare size, since that is what the
  # whisper docs print and what a user will paste.
  $m = $m -replace '^ggml-', ''
  $m = $m -replace '\.bin$', ''

  if ($script:AellWhisperModels -notcontains $m) {
    throw ("Unknown whisper model '$Model'. Available: " +
           ($script:AellWhisperModels -join ', '))
  }
  return [pscustomobject]@{
    Name = $m
    FileName = "ggml-$m.bin"
    Url = ("https://huggingface.co/{0}/resolve/main/ggml-{1}.bin" -f
           $script:AellWhisperModelRepo, $m)
  }
}
