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

# --- what the card is HOLDING ------------------------------------------
#
# Added 2026-09-16 for WORKPLAN 17q / NEXT UP item 1: the overnight loop
# must verify its own teardown, and "the card came back" is the only
# verdict that matters. Kept here for the reason the file already gives
# -- one place to get nvidia-smi wrong.
#
# Trap 3, measured on this machine 2026-09-16 (driver 616.56, RTX 5090,
# WDDM): `--query-compute-apps=used_memory` returns the literal string
#
#     [N/A]
#
# for EVERY process, including the 27 GB ComfyUI of 17q. Per-process VRAM
# is simply not available under WDDM, so a check written against that
# column reports nothing at all and reads like a clean bill of health.
# Only two numbers are trustworthy: the DEVICE total-used (memory.used),
# and the process LIST. Both helpers below stick to those.

function Get-AellGpuMemoryMB {
  <#
    Total VRAM in use on GPU 0, in MiB, plus the card's capacity.

    Returns $null -- not 0 -- when there is no nvidia-smi, when it fails,
    or when it answers something unparseable. All three are legitimate
    (an AMD machine, a container, a driver mid-update) and none is an
    error a caller should die on. A verdict built on this must say
    "unknown" when it gets $null, never "fine": 0 would read as an empty
    card, which is the one answer that is certainly wrong.
  #>
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $smi) { return $null }
  $out = $null
  try {
    $out = & $smi.Source --query-gpu=memory.used,memory.total `
                         --format=csv,noheader,nounits
  } catch { return $null }
  $line = @($out | Where-Object { [string]$_ -match '\d' })[0]
  if (-not $line) { return $null }
  $parts = ([string]$line).Split(',')
  if ($parts.Count -lt 2) { return $null }
  $used = 0
  $total = 0
  if (-not [int]::TryParse($parts[0].Trim(), [ref]$used)) { return $null }
  if (-not [int]::TryParse($parts[1].Trim(), [ref]$total)) { return $null }
  return @{ UsedMB = $used; TotalMB = $total }
}

function Get-AellGpuProcesses {
  <#
    The processes the driver says are on the card, optionally only those
    whose executable path contains -PathFragment.

    No used_memory column -- see trap 3. What this answers is presence,
    which is the honest question for a teardown check: the managed
    backend either still has a process on the GPU or it does not.

    Returns an EMPTY array when nvidia-smi is missing or fails, so a
    caller must not read "none found" as proof on its own; pair it with
    Get-AellGpuMemoryMB, which returns $null in the same conditions.
  #>
  param([string]$PathFragment = '')

  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $smi) { return @() }
  $out = $null
  try {
    $out = & $smi.Source --query-compute-apps=pid,process_name `
                         --format=csv,noheader
  } catch { return @() }
  $found = New-Object System.Collections.Generic.List[object]
  foreach ($raw in @($out)) {
    $line = ([string]$raw).Trim()
    if (-not $line) { continue }
    $comma = $line.IndexOf(',')
    if ($comma -lt 1) { continue }
    $pid_ = 0
    if (-not [int]::TryParse($line.Substring(0, $comma).Trim(), [ref]$pid_)) {
      continue
    }
    # A Windows path can hold commas, so split ONCE on the first one.
    $exe = $line.Substring($comma + 1).Trim()
    if ($PathFragment -and
        $exe.ToLower().IndexOf($PathFragment.ToLower()) -lt 0) { continue }
    $found.Add(@{ ProcessId = $pid_; Path = $exe })
  }
  return $found.ToArray()
}
