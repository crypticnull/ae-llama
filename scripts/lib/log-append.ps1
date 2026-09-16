# Append a line to a log that someone else may be READING.
#
# Why this exists (WORKPLAN NEXT UP 1, measured 2026-09-16).
#
# The overnight loop's log went silent ~90 seconds into both runs of
# 2026-09-15/16 -- no pass output, no heartbeats, no verdicts -- while
# the passes kept committing for hours. The writer was not dead. Every
# write was being REFUSED, and every refusal was swallowed:
#
#   Windows PowerShell 5.1 `Add-Content` fails with "The process cannot
#   access the file ... because it is being used by another process"
#   whenever ANY other handle on the file is open, even a read-only one
#   that itself allows writers. Measured: a Git-Bash `tail -F` on the
#   log and a plain Node `fs.openSync(path, 'r')` both block it, every
#   call, for as long as they hold the file.
#
# Watching the log is exactly what a person (or an interactive session's
# Monitor) does once a loop has started, which is why a fresh
# 0-iteration run always logged fine and a watched night never did. The
# live 2026-09-16 09:32 run showed it to the second: last heartbeat at
# 09:32:40, a `tail -n 0 -F` on the log opened at 09:33:00, no line after.
#
# The fix is the share mode, not a retry: a FileStream opened for Append
# with FileShare ReadWrite|Delete coexists with readers (and with the
# loop's own jobs appending to the same file). A short retry is kept
# only for the rare writer-vs-writer race inside the same instant.
#
# Never throws. A log line must never cost a pass -- but a refusal is no
# longer silent either: it returns $false, so a caller that has nowhere
# else to say it can at least count it.
#
# ASCII, matching every other writer of these logs.

function Add-AellLogLine {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowEmptyString()][string]$Value = ''
  )
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  for ($try = 1; $try -le 5; $try++) {
    $fs = $null
    try {
      $fs = New-Object System.IO.FileStream($Path,
              [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write,
              $share)
      $sw = New-Object System.IO.StreamWriter($fs,
              (New-Object System.Text.ASCIIEncoding))
      $sw.WriteLine($Value)
      $sw.Flush()
      $sw.Dispose()
      $fs = $null
      return $true
    } catch {
      if ($fs) { try { $fs.Dispose() } catch { } }
      Start-Sleep -Milliseconds (40 * $try)
    }
  }
  return $false
}
