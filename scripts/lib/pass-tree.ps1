# pass-tree.ps1 - reap what a pass STARTED, not only the pass itself.
# WORKPLAN NEXT UP 31.
#
# Why this exists.
#
# Measured 2026-09-16: pass 24 was killed at its 45-minute bound. The loop
# reaped the CLI (Get-AellCliPassProcesses), but the bash runner that CLI
# had started -- a `for cfg` loop over five KV configs -- and that runner's
# chat-probe.js and kv-quant-probe.js --serve all survived. At 13:20,
# eighteen minutes into the NEXT pass, they were still building rigs in the
# owner's AE project through `AfterFX -r` and holding llama-server on 8737,
# and the next pass's own probes shared that server and failed on it.
#
# The descent walk in claude-procs.ps1 cannot see them afterwards: when the
# CLI dies its children are re-parented, so "descendant of the CLI" is only
# answerable WHILE the CLI is alive. Hence two halves:
#
#  1. A SNAPSHOT, taken every few seconds while the pass runs (the timeout
#     guard job does it) and once more at the reap: every process under the
#     pass's CLI, keyed by pid AND creation time so a reused pid is never
#     mistaken for a member.
#  2. An ORPHAN rule for what started and was orphaned between two
#     snapshots: a known probe (or llama-server, or an nvidia-smi sampling
#     loop) created after the pass began whose parent is gone.
#
# NEVER reaped, whatever the snapshot says (Test-AellReapProtected):
#  - After Effects and anything whose LIVE ancestry reaches it (CEP, the
#    panel's own llama-server). A pass may cold-launch AE, which makes AE a
#    descendant of the pass -- and quitting AE is the one thing the brief
#    forbids outright.
#  - The managed ComfyUI backend (AE-Llama\vendor\comfy). It is detached ON
#    PURPOSE so the next pass finds it warm; the loop's teardown
#    (comfy-teardown.ps1, 17q) owns stopping it.
#  - The Claude desktop app (claude-procs.ps1 Test-AellDesktopApp).
#  - The loop shell itself.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

. (Join-Path $PSScriptRoot 'claude-procs.ps1')

# Creation time as a comparable string. CIM gives a DateTime; a missing
# one (a process we cannot open) is '0', which never matches a real key.
function Get-AellCreatedKey {
  param($Proc)
  if ($null -eq $Proc.CreationDate) { return '0' }
  try {
    return [string](([datetime]$Proc.CreationDate).ToUniversalTime().Ticks)
  } catch { return '0' }
}

# AE, CEP and anything else of Adobe's, the managed backend, the desktop
# app. Also the test for "lives under something that is not ours".
function Test-AellHostProcess {
  param($Proc)
  $name = [string]$Proc.Name
  $cmd = [string]$Proc.CommandLine
  $exe = [string]$Proc.ExecutablePath
  if ($name -match '^(AfterFX|CEPHtmlEngine|Adobe Premiere Pro)') { return $true }
  if ($exe -match '\\Adobe\\' -or $cmd -match '\\Adobe\\') { return $true }
  if ($exe -match 'AE-Llama\\vendor\\comfy' -or
      $cmd -match 'AE-Llama\\vendor\\comfy') { return $true }
  if (Test-AellDesktopApp -Proc $Proc) { return $true }
  return $false
}

function Test-AellReapProtected {
  param($Proc)
  if (Test-AellHostProcess -Proc $Proc) { return $true }
  if ([string]$Proc.CommandLine -match 'run-local-agent\.ps1') { return $true }
  return $false
}

# Every process under this loop's CLI pass(es), CLI included, pruned at a
# protected process (so an AE the pass launched, and CEP under it, are not
# members). Returns @{ProcessId; Created; Name} records.
function Get-AellPassTree {
  param(
    [int]$RootId,
    $Table = $null
  )
  if (-not $Table) { $Table = Get-AellProcessTable }

  $byParent = @{}
  foreach ($p in $Table) {
    $key = [string]$p.ParentProcessId
    if (-not $byParent.ContainsKey($key)) { $byParent[$key] = @() }
    $byParent[$key] += $p
  }

  $out = @()
  $seen = @{}
  $queue = New-Object System.Collections.Queue
  foreach ($cli in @(Get-AellCliPassProcesses -RootId $RootId -Table $Table)) {
    $queue.Enqueue($cli)
  }
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    $id = [string]$p.ProcessId
    if ($seen.ContainsKey($id)) { continue }
    $seen[$id] = $true
    if (Test-AellReapProtected -Proc $p) { continue }
    $out += New-Object PSObject -Property @{
      ProcessId = [int]$p.ProcessId
      Created   = (Get-AellCreatedKey -Proc $p)
      Name      = [string]$p.Name
    }
    if ($byParent.ContainsKey($id)) {
      foreach ($c in $byParent[$id]) {
        # A child cannot predate its parent; one that does holds a reused
        # parent pid and is somebody else's.
        $cc = Get-AellCreatedKey -Proc $c
        $pc = Get-AellCreatedKey -Proc $p
        if ($cc -ne '0' -and $pc -ne '0' -and
            ([decimal]$cc) -lt ([decimal]$pc)) { continue }
        $queue.Enqueue($c)
      }
    }
  }
  return @($out)
}

# Snapshot = hashtable keyed "pid|created". Merge adds, never removes: a
# member that already exited costs nothing, and one that was re-parented
# is exactly what the snapshot is for.
function Merge-AellPassTree {
  param([hashtable]$Snapshot, $Tree)
  foreach ($m in @($Tree)) {
    if ($null -eq $m) { continue }
    $Snapshot[([string]$m.ProcessId + '|' + [string]$m.Created)] = [string]$m.Name
  }
}

# The guard job and the loop are different processes, so the snapshot
# crosses as a file: one "pid<TAB>created<TAB>name" line per member,
# written to a temp name and moved, so a reader never sees half a file.
function Save-AellPassTreeFile {
  param([hashtable]$Snapshot, [string]$Path)
  $lines = @()
  foreach ($k in $Snapshot.Keys) {
    $parts = $k.Split('|')
    $lines += ($parts[0] + "`t" + $parts[1] + "`t" + $Snapshot[$k])
  }
  $tmp = $Path + '.tmp'
  Set-Content -Path $tmp -Value $lines -Encoding ASCII
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Import-AellPassTreeFile {
  param([hashtable]$Snapshot, [string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $n = 0
  foreach ($line in @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
    $f = ([string]$line).Split("`t")
    if ($f.Count -lt 2 -or $f[0] -notmatch '^\d+$') { continue }
    $name = ''
    if ($f.Count -ge 3) { $name = $f[2] }
    $Snapshot[($f[0] + '|' + $f[1])] = $name
    $n++
  }
  return $n
}

# Does this process run one of the repo's GPU/AE probes, or a server or
# sampler they leave behind? Only these qualify for the orphan rule.
function Test-AellProbeProcess {
  param($Proc)
  $name = [string]$Proc.Name
  $cmd = [string]$Proc.CommandLine
  if ($cmd -match '(chat-probe|kv-quant-probe|catalog-vram-probe|comfy-probe|weight-availability-probe|variants-compare)\.js') { return $true }
  if ($cmd -match 'run-ae-selftest\.ps1') { return $true }
  if ($name -match '^llama-server') { return $true }
  if ($name -match '^nvidia-smi' -and $cmd -match '\s-(lms|l)\s') { return $true }
  return $false
}

# What to kill at the end of a pass. Each result carries ProcessId, Name
# and Reason ('pass tree' | 'orphaned probe'). -ExcludeIds are left for
# the caller (the CLI processes, which the existing reap logs by name).
function Get-AellPassReapTargets {
  param(
    [hashtable]$Snapshot,
    $Table,
    [datetime]$PassStartedAt,
    [int]$LoopId,
    [int[]]$ExcludeIds = @()
  )
  $byId = @{}
  foreach ($p in $Table) { $byId[[string]$p.ProcessId] = $p }
  $skip = @{}
  foreach ($x in $ExcludeIds) { $skip[[string]$x] = $true }

  $out = @()
  foreach ($p in $Table) {
    $id = [string]$p.ProcessId
    if ([int]$p.ProcessId -eq $LoopId -or $skip.ContainsKey($id)) { continue }
    if ([int]$p.ProcessId -le 4) { continue }
    if (Test-AellReapProtected -Proc $p) { continue }

    # Walk the LIVE ancestry: anything under AE, CEP or the backend is
    # not ours to reap, even if a snapshot says so. A parent younger than
    # its child is a reused pid, and ends the walk -- if it is the first
    # hop, that process is an orphan. The loop shell ends the walk too;
    # its own jobs are never snapshot members and are never orphans.
    $underProtected = $false
    $orphan = $false
    $cur = $p
    $hops = 0
    while ($hops -lt 64) {
      $hops++
      $parent = $byId[[string]$cur.ParentProcessId]
      if ($null -eq $parent -or [int]$cur.ParentProcessId -le 4) {
        if ($hops -eq 1) { $orphan = $true }
        break
      }
      $pc = Get-AellCreatedKey -Proc $parent
      $cc = Get-AellCreatedKey -Proc $cur
      if ($pc -ne '0' -and $cc -ne '0' -and
          ([decimal]$pc) -gt ([decimal]$cc)) {
        if ($hops -eq 1) { $orphan = $true }
        break
      }
      if ([int]$parent.ProcessId -eq $LoopId) { break }
      if (Test-AellHostProcess -Proc $parent) { $underProtected = $true; break }
      $cur = $parent
    }
    if ($underProtected) { continue }

    $key = $id + '|' + (Get-AellCreatedKey -Proc $p)
    if ($Snapshot.ContainsKey($key)) {
      $out += New-Object PSObject -Property @{
        ProcessId = [int]$p.ProcessId; Name = [string]$p.Name
        Reason = 'pass tree'
      }
      continue
    }
    if ($orphan -and (Test-AellProbeProcess -Proc $p) -and
        $null -ne $p.CreationDate -and
        ([datetime]$p.CreationDate) -ge $PassStartedAt) {
      $out += New-Object PSObject -Property @{
        ProcessId = [int]$p.ProcessId; Name = [string]$p.Name
        Reason = 'orphaned probe'
      }
    }
  }
  return @($out)
}
