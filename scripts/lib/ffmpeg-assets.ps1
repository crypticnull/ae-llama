# ffmpeg-assets.ps1 - decide WHICH ffmpeg download to take.
#
# Kept away from the I/O in get-ffmpeg.ps1 so tests/test-ffmpeg-acquire.js
# can feed it the asset list captured from the real GitHub API without
# pulling 140 MB (or needing a network at all). Same split as
# whisper-assets.ps1 / whisper-verify.ps1 and ae-dialog-triage.ps1.
#
# The source is BtbN/FFmpeg-Builds, not gyan.dev: it publishes through the
# GitHub releases API, which is the same shape get-whisper.ps1 already
# walks, and it ships an LGPL build alongside the GPL one -- which this
# product needs to be able to choose (see get-ffmpeg.ps1's header).
#
# Four things measured on 2026-08-30 against the real release list, each
# of which breaks the obvious implementation:
#
#  1. `-like '*gpl*'` MATCHES THE LGPL BUILD. Every asset name ends in
#     either `-gpl` or `-lgpl`, and "lgpl" contains "gpl", so the obvious
#     wildcard filter for the GPL build silently accepts the LGPL one --
#     a build with a DIFFERENT codec set and a different licence. The
#     match here is an anchored regex over the whole name, and the parse
#     is tested against both spellings.
#
#  2. THE VERSION SUFFIX IS ONLY ON THE RELEASE-SERIES BUILDS, AND IT IS
#     THE ONLY RELIABLE WAY TO TELL THEM APART. Master is
#     `ffmpeg-master-latest-win64-gpl.zip`; the 9.0 series is
#     `ffmpeg-n9.0-latest-win64-gpl-9.0.zip` -- the same fields, plus the
#     series repeated at the END. A regex that puts `\.zip$` straight
#     after the licence field matches master and misses every release
#     build, which is exactly the half this script prefers.
#
#     Worse, and only visible if you look past the newest tag: the
#     `-latest-` infix EXISTS ONLY ON THE ROLLING `latest` TAG. The dated
#     autobuild releases -- 49 assets each, the fallback if `latest` ever
#     lacks a build -- name the same files
#     `ffmpeg-N-126313-g1ae4048218-win64-gpl.zip` and
#     `ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip`. The first version
#     of this file matched `-latest-` literally, so it parsed `latest`
#     correctly and read every dated release as carrying NOTHING: the
#     fallback could never fire, and the grounded error printed an empty
#     list for those tags while looking perfectly well-formed. So the
#     build field is not parsed at all; the trailing series suffix is,
#     and its ABSENCE is what means master, in both naming schemes.
#
#  3. `-shared` IS NOT A SMALLER BUILD OF THE SAME THING. The shared
#     win64 zips are less than half the size (64 MB vs 141 MB) because
#     the codecs moved into ~20 DLLs the exe then has to find. The panel
#     spawns this binary from a vendor folder, so static is the default:
#     one file that still works when it is moved. Shared is reachable
#     but never picked by accident.
#
#  4. n10 WILL SORT BEFORE n9 AS A STRING. There is no n10 series today,
#     so a string sort over `n8.1` / `n9.0` looks correct and will start
#     picking the OLDER build the day one is published. The series is
#     compared as a padded [version], the same way the CUDA lines are in
#     whisper-assets.ps1.
#
# And one about the repo rather than the names: the newest tag is
# literally `latest`, a ROLLING tag republished on every autobuild, so the
# tag records nothing about what was installed. get-ffmpeg.ps1 reads the
# real version out of `ffmpeg -version` afterwards instead of trusting it.

. (Join-Path $PSScriptRoot 'gh-releases.ps1')

$script:AellFfmpegRepo = 'BtbN/FFmpeg-Builds'

# The two files that make an install. ffplay.exe is in the archive too and
# is deliberately NOT required: it is a GUI player this panel never runs.
$script:AellFfmpegExe  = 'ffmpeg.exe'
$script:AellFfprobeExe = 'ffprobe.exe'

# Encoders WORKPLAN 6.2 Pass B cares about, asked for by name after an
# install so the licence choice has a visible consequence instead of an
# assumed one. gif is native to every build; the rest are not.
$script:AellFfmpegEncodersOfInterest = @(
  'gif', 'libx264', 'libx265', 'libopenh264',
  'h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf',
  'libvpx-vp9', 'aac', 'libmp3lame'
)

function ConvertTo-AellFfmpegSeriesVersion([string]$Series) {
  <#
    'n9.0' -> [version]9.0.0, 'master' -> [version]0.0.0.

    Padded to three parts because [version] fills a missing part with -1,
    not 0, so [version]'9.0' compares LESS than [version]'9.0.0'. Master
    sorts BELOW every numbered series on purpose: it is a nightly of
    unreleased code, and the choice prefers a release series unless it is
    asked for master by name. See note 4 at the top.
  #>
  if (-not $Series -or $Series -eq 'master') { return [version]'0.0.0' }
  $parts = ($Series -replace '^n', '').Split('.')
  while ($parts.Count -lt 3) { $parts += '0' }
  return [version]($parts -join '.')
}

function Get-AellFfmpegAssetInfo {
  <#
    Parse one asset name into its fields, or return $null when it is not
    an ffmpeg build at all (checksums.sha256 is in every release).

    Returns Build / Series / Ver / Platform / License / Shared / Ext. The
    licence alternation is anchored between literal dashes rather than
    searched for, which is what keeps note 1 from happening, and the
    build field is matched lazily and never interpreted -- it is
    `master-latest` on one tag and `N-126313-g1ae4048218` on the next,
    and the SERIES SUFFIX is what actually says which branch this is
    (note 2).
  #>
  param([string]$Name = '')

  $rx = '^ffmpeg-(.+?)-' +
        '(win64|winarm64|linux64|linuxarm64)-' +
        '(lgpl|gpl)(-shared)?' +
        '(?:-([0-9]+(?:\.[0-9]+)*))?' +
        '\.(zip|tar\.xz)$'
  $m = [regex]::Match($Name, $rx)
  if (-not $m.Success) { return $null }

  # No trailing series suffix means master, in BOTH naming schemes:
  # ffmpeg-master-latest-win64-gpl.zip and
  # ffmpeg-N-126313-g1ae4048218-win64-gpl.zip.
  $series = 'master'
  if ($m.Groups[5].Success) { $series = 'n' + $m.Groups[5].Value }

  return [pscustomobject]@{
    Name     = $Name
    Build    = $m.Groups[1].Value
    Series   = $series
    Ver      = ConvertTo-AellFfmpegSeriesVersion $series
    Platform = $m.Groups[2].Value
    License  = $m.Groups[3].Value
    Shared   = ($m.Groups[4].Value -eq '-shared')
    Ext      = $m.Groups[6].Value
  }
}

function Select-AellFfmpegAsset {
  <#
    Pick the one asset to download from a release's asset list.

    Returns $null when the release carries nothing matching -- the caller
    walks on to an older release rather than failing, so this is a normal
    answer and not an error.

    -Series 'release' takes the HIGHEST numbered series present and never
    master; 'master' takes master only; an explicit 'n9.0' takes that one.
  #>
  param(
    $Assets,
    [ValidateSet('lgpl', 'gpl')]
    [string]$License = 'lgpl',
    [string]$Platform = 'win64',
    [ValidateSet('static', 'shared')]
    [string]$Linking = 'static',
    # 'release' (highest numbered), 'master', or a literal series name.
    [string]$Series = 'release'
  )

  $wantShared = ($Linking -eq 'shared')
  $cands = @()
  foreach ($a in @($Assets)) {
    if (-not $a) { continue }
    $info = Get-AellFfmpegAssetInfo -Name $a.name
    if (-not $info) { continue }
    if ($info.Platform -ne $Platform) { continue }
    if ($info.License -ne $License) { continue }
    if ($info.Shared -ne $wantShared) { continue }
    if ($Series -eq 'release') {
      if ($info.Series -eq 'master') { continue }
    } elseif ($Series -ne '') {
      if ($info.Series -ne $Series) { continue }
    }
    $info | Add-Member -NotePropertyName Asset -NotePropertyValue $a
    $cands += $info
  }
  if ($cands.Count -eq 0) { return $null }

  # Sort on Ver, not on Series: see note 4. The Name tiebreak keeps the
  # choice deterministic if a release ever publishes the same series twice.
  $pick = $cands | Sort-Object Ver, Name | Select-Object -Last 1
  return $pick.Asset
}

function Select-AellFfmpegRelease {
  <#
    Walk releases newest-first and return the first that HAS a matching
    build, as @{ Release = ...; Asset = ... }. Throws with the tags it
    looked at and what they carried when none do -- the grounded-error
    rule: never say "not found" without saying what is.
  #>
  param(
    $Releases,
    [ValidateSet('lgpl', 'gpl')]
    [string]$License = 'lgpl',
    [string]$Platform = 'win64',
    [ValidateSet('static', 'shared')]
    [string]$Linking = 'static',
    [string]$Series = 'release'
  )

  $seen = @()
  foreach ($r in @(Expand-AellReleaseList $Releases)) {
    $asset = Select-AellFfmpegAsset -Assets $r.assets -License $License `
                                    -Platform $Platform -Linking $Linking `
                                    -Series $Series
    if ($asset) {
      return [pscustomobject]@{ Release = $r; Asset = $asset }
    }
    # Report the SERIES each release carried for this platform, not all 49
    # asset names: the list is the same 49 every time, and the useful
    # difference between two releases is which series are in them.
    # $seriesSeen, NOT $series: PowerShell variable names are CASE-
    # INSENSITIVE, so a local `$series` here IS the `$Series` parameter
    # and quietly overwrites it. The symptom was only in the error text
    # -- "Series 'master n8.1 n9.0' was asked for by name" -- but the
    # same shadowing would have changed the WALK if this loop had run the
    # filter again after building the list.
    $seriesSeen = @(@($r.assets) | ForEach-Object {
                      Get-AellFfmpegAssetInfo -Name $_.name } |
                    Where-Object { $_ -and $_.Platform -eq $Platform } |
                    ForEach-Object { $_.Series } | Select-Object -Unique |
                    Sort-Object)
    if ($seriesSeen.Count -eq 0) {
      $seen += ("{0} (no {1} builds)" -f $r.tag_name, $Platform)
    } else {
      $seen += ("{0} ({1})" -f $r.tag_name, ($seriesSeen -join ', '))
    }
  }

  $hint = ''
  if (@('release', 'master', '') -notcontains $Series) {
    $hint = (" Series '$Series' was asked for by name; pass " +
             "-Series release to take the newest published one.")
  }
  throw ("No ffmpeg $Platform $License $Linking build in any of the " +
         "releases checked.$hint Looked at: " + ($seen -join ' | '))
}
