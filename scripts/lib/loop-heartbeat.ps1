# loop-heartbeat.ps1 - prove a running pass is WORKING, not hung.
#
# Why this exists (WORKPLAN section 20a).
#
# `claude -p` returns its whole output in ONE block at the end, so a
# pass that is behaving perfectly writes nothing to the loop log for its
# entire 6-10 minute run. The loop logs "===== pass N =====" and then
# goes silent, and a silent loop and a wedged loop look identical. Two
# days were spent unable to answer "is it working right now?".
#
# CPU is NOT the answer and must never be used here. It was measured in
# both directions and was wrong both times: `claude -p` is API-bound and
# burns almost nothing while working (8.66 CPU-seconds over ten minutes
# is a NORMAL pass, which reads as dead), and the self-test deliberately
# leaves After Effects open and idle between steps, so a flat AfterFX
# counter is the DESIGNED state rather than a stall.
#
# What is carried instead is three facts that a merely-passing clock
# cannot fake:
#
#   1. the pass process still EXISTS (by descent, never by name -- the
#      Claude desktop app is Electron and owns many `claude` processes);
#   2. how long it has been running;
#   3. the repo's dirty file count.
#
# (3) is the one that distinguishes working from hung. The loop stashes
# the tree clean before each pass, so the count starts at 0; a pass that
# has begun editing shows a RISING count. Zero after ten minutes and one
# file after two are different situations, and from outside the process
# that difference was previously invisible.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

# Count the working tree's dirty entries. Deliberately tolerant: a
# heartbeat that throws is a heartbeat that stops, and then the loop is
# back to silence -- the exact condition this file exists to end. An
# unreadable repo reports -1 rather than killing the beat.
function Get-AellDirtyCount {
  param([string]$RepoRoot)
  try {
    $lines = @(& git -C $RepoRoot status --porcelain 2>$null)
    if ($LASTEXITCODE -ne 0) { return -1 }
    return @($lines | Where-Object { $_ -ne '' }).Count
  } catch {
    return -1
  }
}

# Elapsed seconds as mm:ss, FLOORED at both steps. [int] in PowerShell
# ROUNDS (to even), so the old `[int]($elapsed / 60)` carried the minute
# at 90 s and the clock read 00:30, 01:00, 02:31, 02:01 -- backwards
# (WORKPLAN NEXT UP 1). Pure, so a test can feed it synthetic spans.
function Format-AellElapsed {
  param([double]$Seconds)
  if ($Seconds -lt 0) { $Seconds = 0 }
  $total = [long][Math]::Floor($Seconds)
  $mm = [long][Math]::Floor($total / 60)
  $ss = $total % 60
  return ('{0:d2}:{1:d2}' -f $mm, $ss)
}

# One heartbeat line. Pure formatting plus two reads, so it can be
# called from a background job or straight from a test.
function Get-AellHeartbeatLine {
  param(
    [int]$RootId,
    [string]$RepoRoot,
    [datetime]$StartedAt,
    [string]$Label = 'pass'
  )
  $clock = Format-AellElapsed -Seconds ((Get-Date) - $StartedAt).TotalSeconds

  $procs = @()
  try { $procs = @(Get-AellCliPassProcesses -RootId $RootId) } catch { }

  if ($procs.Count -gt 0) {
    $pids = ($procs | ForEach-Object { [string]$_.ProcessId }) -join ','
    $alive = ('cli alive (pid ' + $pids + ')')
  } else {
    # Not necessarily a failure -- the pass may have just finished and
    # the pipeline not yet returned. Said plainly either way, because
    # "gone at 00:40" and "gone at 09:50" mean different things.
    $alive = 'cli GONE'
  }

  $dirty = Get-AellDirtyCount -RepoRoot $RepoRoot
  if ($dirty -lt 0) {
    $work = 'dirty ? (git unreadable)'
  } elseif ($dirty -eq 0) {
    $work = 'dirty 0 files (no edits yet)'
  } else {
    $work = ('dirty ' + $dirty + ' file(s)')
  }

  return ('[heartbeat] ' + $Label + '  elapsed ' + $clock + '  ' +
          $alive + '  ' + $work)
}
