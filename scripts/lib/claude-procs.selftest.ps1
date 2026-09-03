# claude-procs.selftest.ps1 - run by tests/test-claude-procs.js.
#
# Exercises the descent walk and the desktop-app filter against a
# synthetic process table shaped like the owner's machine: one loop shell with a
# CLI pass under it, plus a Claude desktop app (Electron: a main process
# and four children) that must never be touched.
. ./scripts/lib/claude-procs.ps1

$table = @(
  [pscustomobject]@{ ProcessId=100; ParentProcessId=1;   Name='powershell.exe'; CommandLine='powershell -File run-local-agent.ps1 -Detached'; ExecutablePath='C:\WINDOWS\powershell.exe' }
  [pscustomobject]@{ ProcessId=101; ParentProcessId=100; Name='cmd.exe';        CommandLine='cmd /c claude.cmd -p ...';                       ExecutablePath='C:\WINDOWS\cmd.exe' }
  [pscustomobject]@{ ProcessId=102; ParentProcessId=101; Name='claude.exe';     CommandLine='claude -p "..." --dangerously-skip-permissions'; ExecutablePath='C:\Users\m\.local\bin\claude.exe' }
  # The desktop app: main + four Electron children, all named claude.
  [pscustomobject]@{ ProcessId=200; ParentProcessId=1;   Name='claude.exe';     CommandLine='"C:\...\AnthropicClaude\claude.exe"';             ExecutablePath='C:\Users\m\AppData\Local\AnthropicClaude\claude.exe' }
  [pscustomobject]@{ ProcessId=201; ParentProcessId=200; Name='claude.exe';     CommandLine='claude.exe --type=renderer';                      ExecutablePath='C:\Users\m\AppData\Local\AnthropicClaude\claude.exe' }
  [pscustomobject]@{ ProcessId=202; ParentProcessId=200; Name='claude.exe';     CommandLine='claude.exe --type=gpu-process';                   ExecutablePath='C:\Users\m\AppData\Local\AnthropicClaude\claude.exe' }
  [pscustomobject]@{ ProcessId=203; ParentProcessId=200; Name='claude.exe';     CommandLine='claude.exe --type=utility';                       ExecutablePath='C:\Users\m\AppData\Local\AnthropicClaude\claude.exe' }
  [pscustomobject]@{ ProcessId=204; ParentProcessId=200; Name='claude.exe';     CommandLine='claude.exe --type=crashpad-handler';              ExecutablePath='C:\Users\m\AppData\Local\AnthropicClaude\claude.exe' }
  # An interactive CLI the owner started themselves. Not our descendant.
  [pscustomobject]@{ ProcessId=300; ParentProcessId=1;   Name='claude.exe';     CommandLine='claude';                                          ExecutablePath='C:\Users\m\.local\bin\claude.exe' }
)

$bad = 0
$ours = @(Get-AellCliPassProcesses -RootId 100 -Table $table)
Write-Host ("ours: " + (($ours | ForEach-Object { $_.ProcessId }) -join ', '))
if (@($ours).Count -ne 1 -or $ours[0].ProcessId -ne 102) {
  Write-Host 'FAIL: should be exactly the CLI pass, pid 102'; $bad++
} else { Write-Host 'ok  - finds the leaked CLI pass under the loop' }

foreach ($id in 200,201,202,203,204) {
  if (@($ours | Where-Object { $_.ProcessId -eq $id }).Count -gt 0) {
    Write-Host ("FAIL: desktop app pid " + $id + " would be killed"); $bad++
  }
}
if ($bad -eq 0) { Write-Host 'ok  - no desktop-app process is ever selected' }

if (@($ours | Where-Object { $_.ProcessId -eq 300 }).Count -gt 0) {
  Write-Host 'FAIL: the owner''s own interactive CLI would be killed'; $bad++
} else { Write-Host "ok  - the owner's own interactive CLI is left alone" }

$c = Get-AellClaudeCensus -RootId 100 -Table $table
Write-Host ("census: " + $c.NamedTotal + " named claude, " + $c.Ours + " ours")
if ($c.NamedTotal -ne 7 -or $c.Ours -ne 1) {
  Write-Host 'FAIL: census wrong'; $bad++
} else { Write-Host 'ok  - census separates the count the owner sees from ours' }

# And the killed-parent limit is real, so assert it is the SAFE direction.
$orphaned = @(Get-AellCliPassProcesses -RootId 101 -Table $table)
if (@($orphaned).Count -eq 1) { Write-Host 'ok  - walks through an intermediate shim process' }
else { Write-Host 'FAIL: does not walk through cmd.exe'; $bad++ }

if ($bad) { Write-Host ''; Write-Host "$bad PROBLEM(S)"; exit 1 }
Write-Host ''
Write-Host 'PROCESS IDENTIFICATION OK'
