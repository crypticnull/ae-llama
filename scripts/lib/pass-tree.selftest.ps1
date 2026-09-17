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

# --- 5. the 2026-09-17 pass-20 shape (NEXT UP 43) ----------------------
# A background tool call ran `bash run34.sh`. Git Bash exec'd the runner
# into a NEW process and the middle one exited at once, so the runner's
# parent was dead while the CLI still lived: never a snapshot member, not
# a probe, and its children have a live parent. Only the tag finds them.
$toolSh  = P 202 102 'bash.exe' 'bash -c "bash local/q42b/run34.sh"' 'C:\Program Files\Git\usr\bin\bash.exe' (At 5)
$runner  = P 203 996 'bash.exe' 'bash local/q42b/run34.sh' 'C:\Program Files\Git\usr\bin\bash.exe' (At 5)
$rProbe  = P 204 203 'node.exe' 'node scripts/chat-probe.js --steps 34' 'C:\Program Files\nodejs\node.exe' (At 6)
$rSrv    = P 205 203 'llama-server.exe' 'llama-server.exe --port 8791' 'C:\x\llama-server.exe' (At 6)
$rCp     = P 206 203 'cp.exe' 'cp local/q42b/tools-D.js extension/js/tools.js' 'C:\Program Files\Git\usr\bin\cp.exe' (At 7)
$rSub    = P 207 203 'bash.exe' 'bash local/q42b/run34.sh' 'C:\Program Files\Git\usr\bin\bash.exe' (At 7)
$rNode2  = P 208 207 'node.exe' 'node scripts/chat-probe.js --steps 34' 'C:\Program Files\nodejs\node.exe' (At 7)
$oldPar  = P 220 1   'explorer.exe' 'C:\WINDOWS\explorer.exe' 'C:\WINDOWS\explorer.exe' (At -600)
$fromOld = P 221 220 'notepad.exe' 'notepad.exe' 'C:\WINDOWS\notepad.exe' (At 9)
$ownRun  = P 213 995 'bash.exe' 'bash my-own-script.sh' 'C:\Program Files\Git\usr\bin\bash.exe' (At 8)
$ownKid  = P 214 213 'node.exe' 'node scripts/chat-probe.js' 'C:\Program Files\nodejs\node.exe' (At 8)
$live20 = @($loop, $job, $cli, $toolSh, $ae, $cep, $panel, $runner, $rProbe, $rSrv, $rCp, $rSub, $rNode2, $oldPar, $fromOld, $ownRun, $ownKid)
$tree20 = @(Get-AellPassTree -RootId 100 -Table $live20)
$snap20 = @{}
Merge-AellPassTree -Snapshot $snap20 -Tree $tree20
Ok ((Ids $tree20) -eq '102,202') ('pass 20: the snapshot cannot see the exec''d runner (got ' + (Ids $tree20) + ')')
$gone20 = @($loop, $job, $ae, $cep, $panel, $runner, $rProbe, $rSrv, $rCp, $rSub, $rNode2, $oldPar, $fromOld, $ownRun, $ownKid)
$t = @(Get-AellPassReapTargets -Snapshot $snap20 -Table $gone20 -PassStartedAt (At 1) -LoopId 100)
Ok ((Ids $t) -eq '') ('pass 20 WITHOUT the tag: nothing is reaped, which is the bug (got ' + (Ids $t) + ')')

# Only NATIVE children carry the tag. Git Bash processes that bash spawned
# hold a minimal environment block (measured 2026-09-17: 1 777 chars, no
# AELL_PASS_TAG), so the runner bashes and cp read untagged here too.
$taggedIds = @{ '204' = 1; '205' = 1; '208' = 1; '221' = 1; '106' = 1; '107' = 1; '108' = 1; '100' = 1 }
$reader = { param($p, $entry) return ($entry -eq 'AELL_PASS_TAG=t20') -and $taggedIds.ContainsKey([string]$p.ProcessId) }
$tagged = Get-AellPassTaggedKeys -Table $gone20 -Entry 'AELL_PASS_TAG=t20' -PassStartedAt (At 1) -LoopId 100 -Reader $reader
$t = @(Get-AellPassReapTargets -Snapshot $snap20 -Table $gone20 -PassStartedAt (At 1) -LoopId 100 -Tagged $tagged)
Ok ((Ids $t) -eq '203,204,205,206,207,208,221') ('pass 20 WITH the tag: the untagged runner bashes and cp go with the tagged node and server (got ' + (Ids $t) + ')')
foreach ($keep in @(@(106,'After Effects a pass launched (tagged)'), @(107,'CEP (tagged)'),
                    @(108,'the panel''s llama-server (tagged)'), @(100,'the loop'),
                    @(220,'an old parent of a tagged process'), @(213,'the owner''s own orphaned runner'), @(214,'the owner''s own probe under it'))) {
  Ok (@($t | Where-Object { $_.ProcessId -eq $keep[0] }).Count -eq 0) ('tag rule never reaps ' + $keep[1])
}
Ok (@($t | Where-Object { $_.Reason -ne 'pass tag' }).Count -eq 0) 'tag targets say "pass tag"'
$t = @(Get-AellPassReapTargets -Snapshot $snap20 -Table $gone20 -PassStartedAt (At 1) -LoopId 100 `
         -Tagged (Get-AellPassTaggedKeys -Table $gone20 -Entry 'AELL_PASS_TAG=other' -PassStartedAt (At 1) -LoopId 100 -Reader $reader))
Ok ((Ids $t) -eq '') 'another pass''s tag matches nothing'

# --- 6. the real PEB reader, on Windows only ---------------------------
if ($env:OS -eq 'Windows_NT' -and [IntPtr]::Size -eq 8) {
  $tagValue = 'selftest-' + $PID + '-' + (Get-Date).Ticks
  $env:AELL_PASS_TAG = $tagValue
  $child = $null
  try {
    $child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
               -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 20' -PassThru -WindowStyle Hidden
  } finally { Remove-Item -LiteralPath 'Env:\AELL_PASS_TAG' -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  Ok (Test-AellProcessEnvEntry -ProcessId $child.Id -Entry ('AELL_PASS_TAG=' + $tagValue)) 'a real child carries the tag and it can be read'
  Ok (-not (Test-AellProcessEnvEntry -ProcessId $child.Id -Entry 'AELL_PASS_TAG=nope')) 'a different tag value does not match'
  Ok (-not (Test-AellProcessEnvEntry -ProcessId $PID -Entry ('AELL_PASS_TAG=' + $tagValue))) 'this process, its tag already cleared, does not match'
  Ok (-not (Test-AellProcessEnvEntry -ProcessId 999999 -Entry 'AELL_PASS_TAG=x')) 'a pid that does not exist answers false'
  Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
} else {
  Write-Host 'skip - the PEB reader is Windows-only'
}

if ($bad) { Write-Host ''; Write-Host "$bad PROBLEM(S)"; exit 1 }
Write-Host ''
Write-Host 'PASS TREE OK'
