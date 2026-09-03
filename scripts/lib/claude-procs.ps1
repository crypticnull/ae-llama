# claude-procs.ps1 - tell OUR Claude Code CLI passes apart from the
# Claude desktop app.
#
# Why this exists.
#
# `Get-Process claude` matches the DESKTOP APP too. It is an Electron
# application, so a single running copy is many processes named claude
# -- a main process plus a renderer, GPU, utility and network child for
# good measure -- and the owner sees ten or eleven of them while
# chatting in it. Two places in this repo were counting and, worse,
# KILLING on that name:
#
#   run-local-agent.ps1  snapshotted every `claude` process before a
#                        pass and force-killed any that appeared during
#                        it, as the pass's leak. Electron spawns and
#                        respawns children in normal use -- open a tab,
#                        load a page -- so a desktop app the owner was
#                        actively using could be shot at any time, and
#                        the log would call it "Reaped lingering claude
#                        pid N".
#   stop-local-agent.ps1 killed EVERY process named claude. That does
#                        not risk the desktop app, it closes it.
#
# Neither was reported as a crash because Electron restarts its children
# quietly. The reap is still wanted -- a pass really does leak a CLI
# process, ten passes left ten of them, and the loop died of the pile at
# pass 11 (2026-08-29) -- so the fix is to identify the leak precisely
# rather than to stop reaping.
#
# The test used here is DESCENT, not name: a process this loop leaked is
# a descendant of the loop's own shell. The desktop app is not a
# descendant of anything we started. Name is only a secondary filter,
# and the desktop app's own markers are excluded explicitly on top.
#
# Known limit, stated rather than papered over: if an INTERMEDIATE
# process dies, its children are reparented and drop out of the walk, so
# a leak can be missed. Missing a leak costs a stray process; killing
# the wrong thing costs the owner their chat window. This errs the safe
# way on purpose.
#
# ASCII only, Windows PowerShell 5.1 (CLAUDE.md).

# One CIM query, reused. Get-Process cannot answer this: it exposes no
# parent, and .Path throws for a process we lack rights to open.
function Get-AellProcessTable {
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
           Select-Object ProcessId, ParentProcessId, Name, CommandLine,
                         ExecutablePath)
}

# Every descendant of RootId, breadth-first. RootId itself is not
# included.
function Get-AellDescendantIds {
  param(
    [int]$RootId,
    $Table = $null
  )
  if (-not $Table) { $Table = Get-AellProcessTable }

  $byParent = @{}
  foreach ($p in $Table) {
    $key = [string]$p.ParentProcessId
    if (-not $byParent.ContainsKey($key)) { $byParent[$key] = @() }
    $byParent[$key] += $p.ProcessId
  }

  $found = New-Object System.Collections.Generic.List[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($RootId)
  $seen = @{}
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    $key = [string]$id
    if (-not $byParent.ContainsKey($key)) { continue }
    foreach ($child in $byParent[$key]) {
      # A cycle is impossible in a real process tree, but PID reuse can
      # fake one, and an infinite loop here would hang the whole script.
      if ($seen.ContainsKey([string]$child)) { continue }
      $seen[[string]$child] = $true
      $found.Add([int]$child)
      $queue.Enqueue([int]$child)
    }
  }
  return $found.ToArray()
}

# Does this process look like the DESKTOP APP rather than the CLI?
# Belt to the descent braces: even if the desktop app somehow appeared
# under our tree (launched from a pass, say), it is not reaped.
function Test-AellDesktopApp {
  param($Proc)
  $cmd = [string]$Proc.CommandLine
  $exe = [string]$Proc.ExecutablePath
  # Electron gives every child process a --type= (renderer, gpu-process,
  # utility, crashpad-handler). The CLI never has one.
  if ($cmd -match '--type=') { return $true }
  # The installed app, wherever it lives. Its install folder is the only
  # reliable marker; the EXECUTABLE NAME is not one, and must not be
  # used. PowerShell's -match is case-INSENSITIVE, so a rule like
  # '\\Claude\.exe$' meant to catch the app's capitalised binary also
  # matches the CLI's own claude.exe -- which excluded every process
  # from the reap and silently turned the leak-reaping off altogether.
  # Caught by tests/test-claude-procs.js before it shipped.
  if ($exe -match 'AnthropicClaude') { return $true }
  if ($cmd -match 'AnthropicClaude') { return $true }
  return $false
}

# The CLI pass processes THIS root started: descendants, named like the
# CLI or its shim, and not the desktop app.
function Get-AellCliPassProcesses {
  param(
    [int]$RootId,
    $Table = $null
  )
  if (-not $Table) { $Table = Get-AellProcessTable }

  $ids = @{}
  foreach ($id in (Get-AellDescendantIds -RootId $RootId -Table $Table)) {
    $ids[[string]$id] = $true
  }

  $out = @()
  foreach ($p in $Table) {
    if (-not $ids.ContainsKey([string]$p.ProcessId)) { continue }
    $name = [string]$p.Name
    # claude.exe, and node.exe running the CLI through its shim.
    $looksCli = ($name -match '^claude') -or
                (($name -match '^node') -and
                 ([string]$p.CommandLine -match 'claude'))
    if (-not $looksCli) { continue }
    if (Test-AellDesktopApp -Proc $p) { continue }
    $out += $p
  }
  return @($out)
}

# For the log line the owner reads. Says how many of the machine's
# claude-named processes are ours, so "11 claude processes" stops
# looking like eleven of our leaks.
function Get-AellClaudeCensus {
  param(
    [int]$RootId,
    $Table = $null
  )
  if (-not $Table) { $Table = Get-AellProcessTable }
  $named = @($Table | Where-Object { [string]$_.Name -match '^claude' })
  $ours = @(Get-AellCliPassProcesses -RootId $RootId -Table $Table)
  return New-Object PSObject -Property @{
    NamedTotal = $named.Count
    Ours       = $ours.Count
    OurIds     = @($ours | ForEach-Object { $_.ProcessId })
  }
}
