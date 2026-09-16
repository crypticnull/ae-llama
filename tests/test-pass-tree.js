// test-pass-tree.js - a killed pass must not leave its runners driving AE.
//
// WORKPLAN NEXT UP 31. Measured 2026-09-16: pass 24 hit its 45-minute
// bound, the loop reaped the CLI, and the bash runner the CLI had started
// -- with its chat-probe.js and kv-quant-probe.js --serve -- kept building
// rigs in the owner's AE project and holding llama-server on 8737 for 18
// minutes into the next pass. The CLI reap cannot see them: a dead CLI's
// children are re-parented, so the tree has to be SNAPSHOT while it lives.
//
// Static half: run-local-agent.ps1 snapshots in the guard job, hands the
// snapshot over as a file, and reaps it BEFORE the CLI reap (killing the
// CLI first would orphan a lingering pass's children before the last
// snapshot). Behavioural half: scripts/lib/pass-tree.selftest.ps1 under a
// real PowerShell against the pass-24 shape, which is where "never After
// Effects, never the panel's llama-server, never the managed backend" is
// actually proven.

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var ROOT = path.join(__dirname, "..");
var failures = [];
function check(name, ok, detail) {
  if (ok) { console.log("ok  - " + name); }
  else {
    console.log("FAIL- " + name + (detail ? ": " + detail : ""));
    failures.push(name);
  }
}
function code(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8").split("\n")
    .filter(function (l) { return !/^\s*#/.test(l); }).join("\n");
}

var loop = code("scripts/run-local-agent.ps1");
check("the loop loads scripts/lib/pass-tree.ps1",
      /lib\\pass-tree\.ps1/.test(loop));

var guardAt = loop.indexOf("'AellPassTimeout'");
var guardEnd = loop.indexOf("} -ArgumentList", guardAt);
var guard = loop.slice(guardAt, guardEnd);
check("the timeout guard snapshots the pass tree",
      /Get-AellPassTree/.test(guard) && /Save-AellPassTreeFile/.test(guard));
check("the guard snapshots once more BEFORE it kills the CLI",
      guard.lastIndexOf("Save-AellPassTreeFile") <
        guard.indexOf("Stop-Process") && guard.indexOf("Stop-Process") !== -1);
check("the guard is handed the tree lib and the file",
      /lib\\pass-tree\.ps1'\),\s*\$treeFile/.test(loop.slice(guardEnd, guardEnd + 600)));

var reap = loop.indexOf("Get-AellPassReapTargets");
var cliReap = loop.indexOf("Reaped lingering CLI pass pid");
check("leftovers are reaped before the CLI reap",
      reap !== -1 && cliReap !== -1 && reap < cliReap,
      "targets at " + reap + ", CLI reap at " + cliReap);
check("the reap reads the guard's snapshot",
      /Import-AellPassTreeFile/.test(loop.slice(reap - 800, reap)));
check("the reap is wrapped, so a failure never costs the loop",
      /Pass leftover reap failed/.test(loop));

var lib = code("scripts/lib/pass-tree.ps1");
check("the process table carries CreationDate (pid-reuse guard)",
      /CreationDate/.test(code("scripts/lib/claude-procs.ps1")));
check("AE, CEP and the managed backend are host processes in the lib",
      /AfterFX\|CEPHtmlEngine/.test(lib) && /AE-Llama\\\\vendor\\\\comfy/.test(lib));
check("nothing in the lib kills: it only selects",
      !/Stop-Process|taskkill/i.test(lib));

var pwsh = ["/opt/pwsh/pwsh", "pwsh", "powershell"].find(function (c) {
  try {
    cp.execSync(c + " -NoProfile -Command exit 0", { stdio: "ignore" });
    return true;
  } catch (e) { return false; }
});
if (!pwsh) {
  console.log("SKIP- no pwsh found; the behavioural half needs one.");
} else {
  var r = cp.spawnSync(pwsh,
    ["-NoProfile", "-File",
     path.join(ROOT, "scripts", "lib", "pass-tree.selftest.ps1")],
    { cwd: ROOT, encoding: "utf8" });
  ((r.stdout || "") + (r.stderr || "")).split("\n").forEach(function (l) {
    if (l.trim()) { console.log("      " + l.trim()); }
  });
  check("the pass-24 synthetic machine self-test passes", r.status === 0,
        "exit " + r.status);
}

console.log("");
if (failures.length) {
  console.log(failures.length + " FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
