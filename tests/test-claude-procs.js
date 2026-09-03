// test-claude-procs.js - the loop must never kill the Claude desktop app.
//
// `Get-Process claude` matches the DESKTOP APP as well as our CLI. The
// app is Electron, so one running copy is a main process plus renderer,
// GPU, utility and crashpad children -- the owner reported seeing
// eleven and being sure ten were the app they were chatting in. Two
// places killed on that name: the loop reaped anything "new" during a
// pass (so opening a tab in the app could get it shot), and
// stop-local-agent.ps1 killed every one of them (so stopping the loop
// closed the owner's chat window).
//
// Two layers here. The static half reads the scripts and refuses a
// kill-by-name. The behavioural half runs scripts/lib/claude-procs.ps1
// under pwsh against a synthetic process table shaped like that
// machine, which is how the first version's bug was caught before it
// shipped: PowerShell's -match is case-insensitive, so a desktop-app
// guard written as '\\Claude\.exe$' also matched the CLI's own
// claude.exe and disabled reaping entirely.

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

// --- no killing by name -------------------------------------------------
["run-local-agent.ps1", "stop-local-agent.ps1"].forEach(function (f) {
  var text = fs.readFileSync(path.join(ROOT, "scripts", f), "utf8");
  var code = text.split("\n").filter(function (l) {
    return !/^\s*#/.test(l);
  }).join("\n");

  check(f + " does not select claude processes by name",
        !/Get-Process\s+(-Name\s+)?'?claude'?/i.test(code),
        "still matches on the process name");
  check(f + " uses the descent-based helper instead",
        /Get-AellCliPassProcesses/.test(code));
  check(f + " loads scripts/lib/claude-procs.ps1",
        /lib\\claude-procs\.ps1/.test(code));
});

// stop-local-agent must gather the in-flight passes BEFORE it kills the
// loop shells: afterwards their children are reparented and the walk
// cannot find them, which turns "stopped both" into "stopped the loop,
// left the pass running" -- the exact failure that script exists for.
var stop = fs.readFileSync(
  path.join(ROOT, "scripts", "stop-local-agent.ps1"), "utf8");
var gather = stop.indexOf("$passesInFlight");
var kill = stop.indexOf("Stopping loop PID");
check("stop-local-agent collects passes before killing their parents",
      gather !== -1 && kill !== -1 && gather < kill,
      "gather at " + gather + ", kill at " + kill);

// The desktop-app guard must not key on the executable NAME.
var lib = fs.readFileSync(
  path.join(ROOT, "scripts", "lib", "claude-procs.ps1"), "utf8");
var guard = lib.slice(lib.indexOf("function Test-AellDesktopApp"));
guard = guard.slice(0, guard.indexOf("\n}"));
var guardCode = guard.split("\n").filter(function (l) {
  return !/^\s*#/.test(l);
}).join("\n");
check("the desktop-app guard does not match on the executable name",
      !/Claude\\?\.exe/i.test(guardCode),
      "-match is case-insensitive, so this also matches the CLI");

// --- behaviour, under the real parser -----------------------------------
var pwsh = ["/opt/pwsh/pwsh", "pwsh", "powershell"].find(function (c) {
  try {
    cp.execSync(c + " -NoProfile -Command exit 0",
                { stdio: "ignore" });
    return true;
  } catch (e) { return false; }
});

if (!pwsh) {
  console.log("SKIP- no pwsh found; the behavioural half needs one.");
  console.log("      Install: https://learn.microsoft.com/powershell/" +
              "scripting/install/installing-powershell");
} else {
  var r = cp.spawnSync(pwsh,
    ["-NoProfile", "-File",
     path.join(ROOT, "scripts", "lib", "claude-procs.selftest.ps1")],
    { cwd: ROOT, encoding: "utf8" });
  var out = (r.stdout || "") + (r.stderr || "");
  out.split("\n").forEach(function (l) {
    if (l.trim()) { console.log("      " + l.trim()); }
  });
  check("the synthetic-machine self-test passes", r.status === 0,
        "exit " + r.status);
}

console.log("");
if (failures.length) {
  console.log(failures.length + " FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
