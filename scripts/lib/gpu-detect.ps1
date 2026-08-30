# gpu-detect.ps1 - reading what the NVIDIA driver says, and comparing it
# with what an asset name says, kept in one file so there is one place to
# get it wrong.
#
# Extracted from whisper-assets.ps1 on 2026-08-30 when get-llama.ps1
# needed the same two helpers. Same move as gh-releases.ps1; nothing but
# these two functions changed hands.
#
# The two traps they exist for, both measured in the field:
#
#  1. The nvidia-smi banner does NOT always say "CUDA Version:". On this
#     machine (driver 616.56, RTX 5090, measured 2026-08-29 and again
#     2026-08-30) it reads:
#
#       | NVIDIA-SMI 616.56  KMD Version: 616.56  CUDA UMD Version: 13.4 |
#
#     The regex every acquirer here used to grep with matches NOTHING
#     there, and the caller silently loses its driver ceiling. Silently
#     is the whole problem: the fallback is "be conservative", so the
#     symptom is a working install of the WRONG build, not an error.
#
#  2. [version] fills a missing part with -1, not 0. [version]'11.8' is
#     therefore LESS than [version]'11.8.0', which made a driver
#     reporting "11.8" reject the build made exactly for it. Pad BOTH
#     sides to three parts and they compare equal.

function ConvertTo-AellPaddedVersion([string]$v) {
  # See note 2 above. Padding to three is not cosmetic.
  $parts = $v.Split('.')
  while ($parts.Count -lt 3) { $parts += '0' }
  return [version]($parts -join '.')
}

function Get-AellCudaVersionFromSmi {
  <#
    Pull the driver's CUDA version out of `nvidia-smi` banner text.
    See note 1 above: the word between CUDA and Version is optional.

    Returns '' when the banner says nothing, which is a legitimate
    answer and not an error -- the caller decides what to do without a
    ceiling.
  #>
  param([string]$Text = '')

  if ($Text -match 'CUDA(?:\s+\w+)?\s+Version\s*:\s*([\d]+(?:\.[\d]+)*)') {
    return $Matches[1]
  }
  return ''
}
