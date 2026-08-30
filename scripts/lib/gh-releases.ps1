# gh-releases.ps1 - the one piece of GitHub-API shape handling that every
# acquirer in this repo needs, kept in one file so there is one place to
# get it wrong.
#
# Extracted from whisper-assets.ps1 on 2026-08-30 when ffmpeg-assets.ps1
# needed the same thing. Both dot-source this; nothing else moved.
#
# The trap it exists for, measured 2026-08-29:
#
#   Invoke-RestMethod on a JSON ARRAY emits ONE object that IS the array;
#   it does not enumerate into the pipeline the way nearly every other
#   cmdlet does. So `@(Invoke-RestMethod .../releases)` yields a
#   one-element array holding every release, `foreach` runs ONCE with the
#   loop variable bound to the whole list, and PowerShell's property
#   flattening silently turns $r.assets into every asset of every release
#   pooled together. The first version of get-whisper.ps1 did exactly
#   that: it downloaded a real archive out of that soup -- from no
#   particular release -- and printed "Release: System.Object[]". A pass
#   that only read the transcript would have called it green.

function Expand-AellReleaseList {
  <#
    Flatten nested arrays down to one release per element. The caller
    cannot tell by looking whether it holds 15 releases or one array of
    15, and getting it wrong does not throw.
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
