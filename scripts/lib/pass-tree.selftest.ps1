# pass-tree.selftest.ps1 - run by tests/test-pass-tree.js.
#
# The 2026-09-16 pass-24 shape on a synthetic table: a loop shell, its
# guard job, a CLI pass that started a bash runner, which started
# chat-probe and a llama-server -- and also cold-launched After Effects,
# whose CEP started the PANEL's llama-server, and booted the managed
# backend. Then the CLI is killed and everything under it is re-parented.
# Only the runner, the probe and the probe's server may be reaped.
. ./scripts/lib/pass-tree.ps1

$T0 = [datetime]'2026-09-16T12:00:00'
function At([int]$min) { return $T0.AddMinutes($min) }
function P($id, $parent, $name, $cmd, $exe, $created) {
  return [pscustomobject]@{ ProcessId=$id; ParentProcessId=$parent; Name=$name
    CommandLine=$cmd; ExecutablePath=$exe; CreationDate=$created }
}

$loop  = P 100 1   'powershell.exe' 'powershell -File scripts\run-local-agent.ps1 -Detached' 'C:\WINDOWS\powershell.exe' (At 0)
$job   = P 110 100 'powershell.exe' 'powershell -s -NoLogo -NoProfile' 'C:\WINDOWS\powershell.exe' (At 1)
$cli   = P 102 100 'claude.exe' 'claude -p --dangerously-skip-permissions' 'C:\Users\m\.local\bin\claude.exe' (At 2)
$bash  = P 103 102 'bash.exe' 'bash -c for cfg in shipped q8_0; do node scripts/chat-probe.js; done' 'C:\Program Files\Git\usr\bin\bash.exe' (At 5)
$probe = P 104 103 'node.exe' 'node scripts/chat-probe.js --reuse-server' 'C:\Program Files\nodejs\node.exe' (At 6)
$srv   = P 105 104 'llama-server.exe' 'llama-server.exe --port 8737' 'C:\Users\m\AppData\Roaming\AE-Llama\vendor\llama\llama-server.exe' (At 6)
$ae    = P 106 102 'AfterFX.exe' '"C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe"' 'C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe' (At 3)
$cep   = P 107 106 'CEPHtmlEngine.exe' 'CEPHtmlEngine.exe --type=renderer' 'C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\CEP\CEPHtmlEngine\CEPHtmlEngine.exe' (At 4)
$panel = P 108 107 'llama-server.exe' 'llama-server.exe --port 8080' 'C:\Users\m\AppData\Roaming\AE-Llama\vendor\llama\llama-server.exe' (At 7)
$comfy = P 109 104 'python.exe' 'python main.py --port 8188' 'C:\Users\m\AppData\Roaming\AE-Llama\vendor\comfy\python\python.exe' (At 8)

$bad = 0
function Ok($cond, $msg) {
  if ($cond) { Write-Host ('ok  - ' + $msg) }
  else { Write-Host ('FAIL: ' + $msg); $script:bad++ }
}
function Ids($xs) { return ((@($xs) | ForEach-Object { [int]$_.ProcessId } | Sort-Object) -join ',') }

# --- 1. the snapshot while the CLI is alive --------------------------
$alive = @($loop, $job, $cli, $bash, $probe, $srv, $ae, $cep, $panel, $comfy)
$tree = @(Get-AellPassTree -RootId 100 -Table $alive)
Ok ((Ids $tree) -eq '102,103,104,105') ('snapshot is the CLI and what it started, not AE/CEP/panel/backend (got ' + (Ids $tree) + ')')

$snap = @{}
Merge-AellPassTree -Snapshot $snap -Tree $tree
$file = Join-Path ([System.IO.Path]::GetTempPath()) ('aell-pass-tree-selftest-' + $PID + '.txt')
Save-AellPassTreeFile -Snapshot $snap -Path $file
$back = @{}
$n = Import-AellPassTreeFile -Snapshot $back -Path $file
Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
$same = ($n -eq 4)
foreach ($k in $snap.Keys) { if (-not $back.ContainsKey($k)) { $same = $false } }
Ok $same ('the snapshot survives the file the guard job hands over (' + $n + ' lines)')

# --- 2. a CLI that lingers past its pass: its children still go ------
$t = @(Get-AellPassReapTargets -Snapshot $snap -Table $alive -PassStartedAt (At 1) -LoopId 100 -ExcludeIds @(102))
Ok ((Ids $t) -eq '103,104,105') ('lingering CLI: its runner, probe and server are reaped, the CLI left to the CLI reap (got ' + (Ids $t) + ')')

# --- 3. the CLI was killed; everything under it is re-parented --------
$reused  = P 120 1   'node.exe' 'node some-other-tool.js' 'C:\Program Files\nodejs\node.exe' (At 30)
$snap['120|' + (Get-AellCreatedKey -Proc (P 120 1 'x' '' '' (At 9)))] = 'node.exe'
$orphP   = P 130 999 'node.exe' 'node scripts/kv-quant-probe.js --serve' 'C:\Program Files\nodejs\node.exe' (At 20)
$oldSrv  = P 140 998 'llama-server.exe' 'llama-server.exe --port 8737' 'C:\x\llama-server.exe' (At -30)
$ownerCl = P 152 1   'claude.exe' 'claude' 'C:\Users\m\.local\bin\claude.exe' (At -60)
$ownerSh = P 151 152 'bash.exe' 'bash' 'C:\Program Files\Git\usr\bin\bash.exe' (At 21)
$ownerPr = P 150 151 'node.exe' 'node scripts/chat-probe.js' 'C:\Program Files\nodejs\node.exe' (At 22)
$smi     = P 160 997 'nvidia-smi.exe' 'nvidia-smi --query-gpu=memory.used -lms 25' 'C:\WINDOWS\system32\nvidia-smi.exe' (At 23)
$after = @($loop, $job, $bash, $probe, $srv, $ae, $cep, $panel, $comfy,
           $reused, $orphP, $oldSrv, $ownerCl, $ownerSh, $ownerPr, $smi)
$t = @(Get-AellPassReapTargets -Snapshot $snap -Table $after -PassStartedAt (At 1) -LoopId 100)
Ok ((Ids $t) -eq '103,104,105,130,160') ('after the kill: the pass tree plus orphaned probes, nothing else (got ' + (Ids $t) + ')')
foreach ($keep in @(@(106,'After Effects'), @(107,'CEP'), @(108,'the panel''s llama-server'),
                    @(109,'the managed backend'), @(100,'the loop'), @(110,'the loop''s own job'),
                    @(120,'a reused pid'), @(140,'a server older than the pass'),
                    @(150,'the owner''s own probe'))) {
  Ok (@($t | Where-Object { $_.ProcessId -eq $keep[0] }).Count -eq 0) ('never reaps ' + $keep[1])
}
$why = @{}
foreach ($x in $t) { $why[[string]$x.ProcessId] = $x.Reason }
Ok ($why['103'] -eq 'pass tree' -and $why['130'] -eq 'orphaned probe') 'each target says why'

# --- 4. AE even when the snapshot names it ----------------------------
$snap2 = @{}
$snap2['106|' + (Get-AellCreatedKey -Proc $ae)] = 'AfterFX.exe'
$t = @(Get-AellPassReapTargets -Snapshot $snap2 -Table $after -PassStartedAt (At 1) -LoopId 100)
Ok (@($t | Where-Object { $_.ProcessId -eq 106 }).Count -eq 0) 'After Effects is never reaped, even if a snapshot lists it'

if ($bad) { Write-Host ''; Write-Host "$bad PROBLEM(S)"; exit 1 }
Write-Host ''
Write-Host 'PASS TREE OK'
