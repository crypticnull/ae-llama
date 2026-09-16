# Why the overnight loop stopped -- said on EVERY exit, including the
# ones nobody wrote an exit for.
#
# Why this exists (WORKPLAN NEXT UP 2, reconstructed 2026-09-16).
#
# The 2026-09-15 23:23 loop "died at 01:39 after six passes with no log
# line and no error". It did not die. git's reflog shows the loop's
# `git checkout` every ~22 s from 01:25:14 to 01:37:47: thirty-five more
# iterations, each 20 s of -PauseSec plus a CLI that returned at once.
# The loop spent passes 6-40 in thirteen minutes and ended normally.
#
# The cause was a pass. Pass 5 tested the loop's exit path by running a
# second copy of this script, then cleaned up after it with
#   rm -f logs/pass-settings-*.json logs/pass-prompt-*.txt
# at 01:13:10. The wildcard also took the RUNNING loop's own per-PID
# prompt and settings files. Every later pass invoked
#   claude --settings <missing file> -p   (with an empty stdin)
# which prints "Error: Settings file not found: ..." and exits 1 in
# 0.13 s (measured) -- text that matches neither the usage-limit nor the
# denied-permissions check, so each one was logged as "no commit" and the
# next iteration began. The log carried none of it: a tail -F held the
# file and PS 5.1 Add-Content was refused (see log-append.ps1).
#
# So three things, all here:
#   Restore-AellPassFile     the loop rewrites its own pass inputs from
#                            memory before every pass, so a pass that
#                            deletes them costs one log line, not a night.
#   Set-AellLoopExitReason   every deliberate exit names itself.
#   Register-AellLoopExitReport
#                            one PowerShell.Exiting handler writes the
#                            reason as the log's LAST line -- and when no
#                            exit named one (an uncaught throw, a path
#                            nobody wrote), says UNEXPECTED with the last
#                            error, instead of nothing. Measured PS 5.1
#                            -File: the handler runs on `exit`, on
#                            falling off the end and on an uncaught
#                            throw. It does NOT run on Stop-Process /
#                            taskkill /F; stop-local-agent.ps1 writes
#                            that line itself (Add-AellLoopKillNote).
#
# The handler runs in its own scope: it cannot see $script: variables,
# which is why the state is $global:. Needs Add-AellLogLine (log-append).
#
# ASCII only (Windows PowerShell 5.1).

function Set-AellLoopExitReason {
  param([Parameter(Mandatory = $true)][string]$Reason)
  $global:AellLoopExitReason = $Reason
}

# What the loop was doing, so an UNEXPECTED exit can say where it was.
function Set-AellLoopExitContext {
  param([string]$Context = '')
  $global:AellLoopExitContext = $Context
}

function Register-AellLoopExitReport {
  param([Parameter(Mandatory = $true)][string]$LogFile)
  $global:AellLoopExitReason = $null
  $global:AellLoopExitContext = ''
  $global:AellLoopExitLog = $LogFile
  $null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    $why = $global:AellLoopExitReason
    if (-not $why) {
      $last = ''
      if ($global:Error.Count -gt 0) {
        $e = $global:Error[0]
        $last = ' Last error: ' + [string]$e
        if ($e.InvocationInfo -and $e.InvocationInfo.ScriptLineNumber) {
          $last = $last + ' (line ' + $e.InvocationInfo.ScriptLineNumber + ')'
        }
      }
      $why = 'UNEXPECTED -- the script ended without naming a reason' +
             ' (an uncaught error, or an exit path nobody wrote).' + $last
    }
    if ($global:AellLoopExitContext) {
      $why = $why + ' [at: ' + $global:AellLoopExitContext + ']'
    }
    $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] Loop exit: ' + $why
    try { [void](Add-AellLogLine -Path $global:AellLoopExitLog -Value $line) } catch { }
  }
}

# Rewrite a pass input the loop owns if something deleted it. Returns
# $true when it had to, so the caller can say so.
function Restore-AellPassFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )
  if (Test-Path -LiteralPath $Path) { return $false }
  Set-Content -LiteralPath $Path -Value $Value -Encoding ASCII
  return $true
}

# For stop-local-agent.ps1: a hard kill runs no Exiting handler, so the
# killer writes the loop's last line. The newest local-agent log is the
# running loop's (one loop at a time; the pid file is not trusted).
function Add-AellLoopKillNote {
  param(
    [Parameter(Mandatory = $true)][string]$LogDir,
    [Parameter(Mandatory = $true)][string]$Note
  )
  $newest = Get-ChildItem -Path $LogDir -Filter 'local-agent-*.log' `
              -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $newest) { return $false }
  $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] Loop exit: ' + $Note
  return (Add-AellLogLine -Path $newest.FullName -Value $line)
}
