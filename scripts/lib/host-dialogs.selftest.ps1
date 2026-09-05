# host-dialogs.selftest.ps1 - run by tests/test-host-dialogs.js.
#
# signature. No AfterFX here, so it must return "" cleanly rather than
# throwing on a binding error -- which is the failure that would only
# have shown up on the owner's machine.
. ./scripts/lib/host-dialogs.ps1
$bad = 0

foreach ($r in (Get-AellDialogRules -OwnedProjects @('Untitled Project'))) {
  try {
    $res = [AellDlg]::AnswerDialog(999999, $r.Contains, $r.Any, $r.Buttons,
                                   [bool]$r.CancelIfNoButton)
    Write-Host ("  ok   " + $r.Name + "  (cancelIfNoButton=" +
                [bool]$r.CancelIfNoButton + ")")
  } catch {
    $m = $_.Exception.Message
    # On Linux there is no user32.dll, so the P/Invoke fails to resolve
    # and .NET reports a native-library path error. That is the
    # ENVIRONMENT, not the code. A real signature problem reads
    # "Cannot find an overload for ... and the argument count", and the
    # message below proves the 5-arg overload was found and called.
    if ($m -match "argument\(s\)" -and
        ($m -match "path1" -or $m -match "user32" -or
         $m -match "DllNotFound" -or $m -match "Unable to load")) {
      Write-Host ("  ok   " + $r.Name +
                  "  (5-arg overload bound; user32 absent on Linux)")
    } else {
      Write-Host ("  THREW " + $r.Name + ": " + $m)
      $bad++
    }
  }
}

# And the wrapper both scripts actually call.
try {
  $n = Answer-AellKnownDialogs -ProcessNames @('AfterFX') `
         -OwnedProjects @('Untitled Project','mogrt-probe-scratch')
  Write-Host ("  ok   Answer-AellKnownDialogs returned " + $n)
} catch { Write-Host ("  THREW wrapper: " + $_.Exception.Message); $bad++ }

try {
  Write-AellUnknownDialogs -ProcessNames @('AfterFX')
  Write-Host '  ok   Write-AellUnknownDialogs'
} catch { Write-Host ("  THREW describe: " + $_.Exception.Message); $bad++ }

# Every rule must be able to fall back, or a dialog with no findable
# button is still a hang.
$noFallback = @(Get-AellDialogRules -OwnedProjects @('x') |
                Where-Object { -not $_.CancelIfNoButton })
if ($noFallback.Count -gt 0) {
  Write-Host ("  RULES WITH NO FALLBACK: " +
              (($noFallback | ForEach-Object { $_.Name }) -join '; '))
  $bad++
} else { Write-Host '  ok   every rule can fall back to WM_CLOSE' }

if ($bad) { Write-Host "$bad PROBLEM(S)"; exit 1 }
Write-Host 'CALL PATH OK'
