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
#  3. A TAG (NEXT UP 43). The loop sets AELL_PASS_TAG in its own
#     environment for exactly the life of the CLI pipeline, so everything
#     the pass starts inherits it, and a process whose environment block
#     carries this pass's tag is a member whatever its parentage says.
#     Measured 2026-09-17: Git Bash running `bash script.sh` from a
#     background tool call EXECs a new Windows process and the middle one
#     exits at once, so the runner's parent pid is dead within
#     milliseconds WHILE THE CLI IS STILL ALIVE. No snapshot can ever see
#     it under the CLI, and a runner is not a named probe, so rules 1 and
#     2 both missed pass 20's run34.sh, which then swapped tools.js and
#     drove AE under pass 21. Its children have a LIVE parent (the
#     runner), so they were not orphans either.
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

# Rule 3's reader. CIM has no environment, so it is read out of the
# process's PEB (ProcessParameters +0x20, Environment +0x80, its size
# +0x3F0; 64-bit targets only). Compiled on first use, not at dot-source,
# so the guard job and the stubbed suite never pay for it. Anything that
# cannot be opened or read answers false: a tag we cannot see is not a
# member.
$script:AellProcEnvSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AellProcEnv {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")]
  static extern bool IsWow64Process(IntPtr h, out bool wow);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr h, int cls, ref Pbi pbi, int len, out int retLen);
  [StructLayout(LayoutKind.Sequential)]
  struct Pbi { public IntPtr A; public IntPtr Peb; public IntPtr B; public IntPtr C; public IntPtr D; public IntPtr E; }

  static bool Read(IntPtr h, IntPtr at, byte[] buf) {
    IntPtr n;
    return ReadProcessMemory(h, at, buf, (IntPtr)buf.Length, out n) && (long)n == buf.Length;
  }

  // The whole environment block of a 64-bit process, or null.
  public static string Block(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x1000 | 0x0010, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      bool wow;
      if (IsWow64Process(h, out wow) && wow) return null;
      Pbi pbi = new Pbi(); int rl;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out rl) != 0) return null;
      byte[] p8 = new byte[8];
      if (!Read(h, IntPtr.Add(pbi.Peb, 0x20), p8)) return null;
      IntPtr pp = (IntPtr)BitConverter.ToInt64(p8, 0);
      if (!Read(h, IntPtr.Add(pp, 0x80), p8)) return null;
      IntPtr env = (IntPtr)BitConverter.ToInt64(p8, 0);
      if (!Read(h, IntPtr.Add(pp, 0x3F0), p8)) return null;
      long size = BitConverter.ToInt64(p8, 0);
      if (size <= 0 || size > (4 << 20)) return null;
      byte[] buf = new byte[size];
      if (!Read(h, env, buf)) return null;
      return Encoding.Unicode.GetString(buf);
    } catch { return null; } finally { CloseHandle(h); }
  }

  public static bool HasEntry(int pid, string entry) {
    string b = Block(pid);
    if (b == null) return false;
    return b.StartsWith(entry + "\0", StringComparison.OrdinalIgnoreCase) ||
           b.IndexOf("\0" + entry + "\0", StringComparison.OrdinalIgnoreCase) >= 0;
  }
}
'@

function Test-AellProcessEnvEntry {
  param([int]$ProcessId, [string]$Entry)
  try {
    if (-not ('AellProcEnv' -as [type])) {
      Add-Type -TypeDefinition $script:AellProcEnvSource -ErrorAction Stop
    }
    return [bool][AellProcEnv]::HasEntry($ProcessId, $Entry)
  } catch { return $false }
}

# The keys ("pid|created") of the processes this pass's tag proves are
# ours. Protected processes and the loop are never read or added: AE
# cold-launched by a pass inherits the tag too, and must still never be a
# target. -Reader replaces the PEB read (the self-test's synthetic table).
#
# Reading the tag is not enough on its own. Measured 2026-09-17: a Git
# Bash process that bash itself spawned (the exec'd runner, the subshell
# of its `for` loop) has only a minimal Windows environment block, 1 777
# chars with no AELL_PASS_TAG, while the node and llama-server it starts
# carry the full one. So from each tagged process this also takes
#  - its live ANCESTORS, while each was created since the pass began and
#    is not protected (the runner bash above a tagged chat-probe; an old
#    parent such as explorer ends the walk and is not taken), and
#  - the live DESCENDANTS of everything taken (the runner's cp.exe),
#    pruned at a protected process.
function Get-AellPassTaggedKeys {
  param(
    $Table,
    [string]$Entry,
    [datetime]$PassStartedAt,
    [int]$LoopId,
    [scriptblock]$Reader = $null
  )
  $out = @{}
  if (-not $Entry) { return $out }

  $byId = @{}
  $byParent = @{}
  foreach ($p in $Table) {
    $byId[[string]$p.ProcessId] = $p
    $pk = [string]$p.ParentProcessId
    if (-not $byParent.ContainsKey($pk)) { $byParent[$pk] = @() }
    $byParent[$pk] += $p
  }
  $isNew = {
    param($q)
    return ([int]$q.ProcessId -gt 4 -and [int]$q.ProcessId -ne $LoopId -and
            $null -ne $q.CreationDate -and
            ([datetime]$q.CreationDate) -ge $PassStartedAt -and
            -not (Test-AellReapProtected -Proc $q))
  }
  $taken = @{}
  $add = {
    param($q)
    $taken[[string]$q.ProcessId] = $q
  }

  foreach ($p in $Table) {
    if (-not (& $isNew $p)) { continue }
    if ($Reader) { $has = [bool](& $Reader $p $Entry) }
    else { $has = Test-AellProcessEnvEntry -ProcessId ([int]$p.ProcessId) -Entry $Entry }
    if (-not $has) { continue }
    & $add $p
    $cur = $p
    for ($hop = 0; $hop -lt 64; $hop++) {
      $parent = $byId[[string]$cur.ParentProcessId]
      if ($null -eq $parent -or -not (& $isNew $parent)) { break }
      if (([datetime]$parent.CreationDate) -gt ([datetime]$cur.CreationDate)) { break }
      & $add $parent
      $cur = $parent
    }
  }

  $queue = New-Object System.Collections.Queue
  foreach ($q in @($taken.Values)) { $queue.Enqueue($q) }
  while ($queue.Count -gt 0) {
    $q = $queue.Dequeue()
    $kids = $byParent[[string]$q.ProcessId]
    if (-not $kids) { continue }
    foreach ($c in $kids) {
      if ($taken.ContainsKey([string]$c.ProcessId)) { continue }
      if (-not (& $isNew $c)) { continue }
      if ($null -ne $q.CreationDate -and
          ([datetime]$c.CreationDate) -lt ([datetime]$q.CreationDate)) { continue }
      & $add $c
      $queue.Enqueue($c)
    }
  }

  foreach ($q in @($taken.Values)) {
    $out[([string]$q.ProcessId + '|' + (Get-AellCreatedKey -Proc $q))] = [string]$q.Name
  }
  return $out
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
# and Reason ('pass tree' | 'pass tag' | 'orphaned probe'). -Tagged is
# Get-AellPassTaggedKeys. -ExcludeIds are left for the caller (the CLI
# processes, which the existing reap logs by name).
function Get-AellPassReapTargets {
  param(
    [hashtable]$Snapshot,
    $Table,
    [datetime]$PassStartedAt,
    [int]$LoopId,
    [int[]]$ExcludeIds = @(),
    [hashtable]$Tagged = @{}
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
    if ($Tagged.ContainsKey($key)) {
      $out += New-Object PSObject -Property @{
        ProcessId = [int]$p.ProcessId; Name = [string]$p.Name
        Reason = 'pass tag'
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
