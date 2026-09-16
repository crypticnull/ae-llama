// Regression test: the overnight loop says WHY it stopped, on every exit.
//
// Why this exists (WORKPLAN NEXT UP 2, reconstructed 2026-09-16).
//
// "The first loop died at 01:39 after six passes with no log line and no
// error." It did not die. git's reflog shows its `git checkout` every
// ~22 s from 01:25:14 to 01:37:47 -- passes 6 to 40, each a CLI that
// returned at once, then a normal end. Pass 5 had cleaned up after a test
// run of this script with `rm -f logs/pass-settings-*.json
// logs/pass-prompt-*.txt`, and the wildcard took the RUNNING loop's own
// inputs. `claude --settings <missing> -p` prints "Error: Settings file
// not found" and exits 1 in 0.13 s (measured), which matched neither the
// usage-limit nor the permissions check, so thirty-five passes were
// logged as idle. And the log carried none of it (a tail -F held it; see
// test-loop-log-append.js).
//
// So this pins three things: the loop rewrites its pass inputs before
// every pass; three passes in a row that return in under a minute with no
// commit stop the loop with the CLI's own words; and every exit writes
// "Loop exit: <why>" -- including exits nobody named, which say UNEXPECTED.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LOOP = path.join(ROOT, "scripts", "run-local-agent.ps1");
const STOP = path.join(ROOT, "scripts", "stop-local-agent.ps1");
const LIB = path.join(ROOT, "scripts", "lib", "loop-exit.ps1");
const APPEND = path.join(ROOT, "scripts", "lib", "log-append.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

const loop = fs.readFileSync(LOOP, "utf8");
const stop = fs.readFileSync(STOP, "utf8");
const lines = loop.split(/\r?\n/);

// ------------------------------------------------------ registration
const regLine = lines.findIndex((l) => /^Register-AellLoopExitReport -LogFile \$logFile/.test(l));
const logLine = lines.findIndex((l) => /^\$logFile = /.test(l));
assert(regLine > 0, "the loop registers its exit report at top level");
assert(logLine >= 0 && logLine < regLine,
  "after the log file is named, so the handler has somewhere to write");
assert(lines.findIndex((l) => /^\. \(Join-Path \$PSScriptRoot 'lib\\log-append\.ps1'\)|^\. \$logAppendLib/.test(l)) < regLine,
  "and after Add-AellLogLine is loaded, which the handler calls");

// ------------------------------------------- every named exit names why
// After registration, every bare `break` / `exit N` statement at the
// loop's level must set a reason just before it. The one exception is
// the final `exit 0`, whose reason is set in the teardown block.
const exits = [];
for (let i = regLine + 1; i < lines.length; i++) {
  if (/^\s*(break|exit \d+)\s*$/.test(lines[i])) exits.push(i);
}
const lastExit = exits[exits.length - 1];
assert(exits.length >= 7, "found the loop's exits to check (" + exits.length + ")");
for (const i of exits) {
  if (i === lastExit) continue;
  const before = lines.slice(Math.max(0, i - 8), i).join("\n");
  assert(/Set-AellLoopExitReason/.test(before),
    "line " + (i + 1) + " (`" + lines[i].trim() + "`) names its reason first");
}
const tear = loop.slice(loop.lastIndexOf("Set-AellLoopExitContext 'teardown"));
assert(/if \(-not \$global:AellLoopExitReason\)[\s\S]*iterations used/.test(tear),
  "running out of iterations is a named reason too, with pass counts");

// A reason built as ($int + 'text') throws in PowerShell: the left
// operand's type wins and 'text' is not a number.
const reasonCalls = loop.match(/Set-AellLoopExitReason \(\$\w+ \+/g) || [];
assert(reasonCalls.length === 0,
  "no reason starts with a bare variable (int + string throws): " + reasonCalls.join(", "));

// ------------------------------------------------ pass inputs restored
const pipe = loop.indexOf("Get-Content -Raw $promptFile |");
const rp = loop.indexOf("Restore-AellPassFile -Path $promptFile -Value $prompt");
const rs = loop.indexOf("Restore-AellPassFile -Path $styleFile -Value $styleJson");
assert(pipe > 0 && rp > 0 && rp < pipe, "the prompt file is rewritten if missing, before the pass reads it");
assert(rs > 0 && rs < pipe, "and the settings file, whose absence kills the CLI in 0.13 s");
assert(/\$claudeFlags \+= @\('--settings', \$styleFile\)\s+\$styleWritten = \$true/.test(loop),
  "only restored when the loop itself passed --settings");

// ---------------------------------------------------- the fast breaker
assert(/\$fastFailSec = 60\b/.test(loop) && /\$fastFailLimit = 3\b/.test(loop),
  "three passes under a minute with no commit is the bound");
const noCommit = loop.slice(loop.indexOf("Pass produced no commit"), loop.indexOf("Pass committed "));
assert(/\$passSec -lt \$fastFailSec/.test(noCommit) && /break/.test(noCommit),
  "the breaker sits on the no-commit path and stops the loop");
assert(/Its last output: /.test(noCommit),
  "and each fast pass logs what the CLI actually said");
const limitIdx = loop.indexOf("Usage limit hit -- waiting");
assert(limitIdx > 0 && limitIdx < loop.indexOf("$passSec -lt $fastFailSec"),
  "a usage-limit exit is checked first, so it waits instead of tripping the breaker");
assert(/\$fastFails = 0\s+\$passesCommitted\+\+/.test(loop),
  "a commit resets the count");

// ------------------------------------------------ killed from outside
const kill = stop.indexOf("Stop-Process -Id $p.ProcessId");
const note = stop.indexOf("Add-AellLoopKillNote");
assert(kill > 0 && note > kill, "stop-local-agent.ps1 writes the killed loop's last line");
assert(/lib\\loop-exit\.ps1/.test(stop) && /lib\\log-append\.ps1/.test(stop),
  "and loads what that needs");

// ---------------------------------------------------------- live runs
if (process.platform !== "win32") {
  console.log("SKIP - live exit-handler checks need Windows PowerShell");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-exit-"));
  const q = (p) => "'" + p.replace(/'/g, "''") + "'";

  function run(name, body, holdReader) {
    const log = path.join(dir, name + ".log");
    fs.writeFileSync(log, "start\r\n");
    const script = path.join(dir, name + ".ps1");
    fs.writeFileSync(script, [
      "$ErrorActionPreference = 'Continue'",
      ". " + q(APPEND),
      ". " + q(LIB),
      "Register-AellLoopExitReport -LogFile " + q(log),
      "Set-AellLoopExitContext 'pass 2 of 5'",
      body
    ].join("\r\n"));
    // A reader held open for the whole run, as a tail -F would.
    const fd = holdReader ? fs.openSync(log, "r") : null;
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8", timeout: 60000 });
    if (fd !== null) fs.closeSync(fd);
    const text = fs.readFileSync(log, "utf8").trim().split(/\r?\n/);
    return { code: r.status, last: text[text.length - 1] || "", all: text };
  }

  const named = run("named", "Set-AellLoopExitReason 'all 5 iterations used.'\r\nexit 0", true);
  assert(/\] Loop exit: all 5 iterations used\. \[at: pass 2 of 5\]$/.test(named.last),
    "a named exit writes its reason last, past a held reader: " + named.last);

  const thrown = run("thrown", "throw 'boom from pass 2'", true);
  assert(/Loop exit: UNEXPECTED/.test(thrown.last) && /boom from pass 2/.test(thrown.last),
    "an uncaught throw still leaves a line, with the error: " + thrown.last);
  assert(/\[at: pass 2 of 5\]/.test(thrown.last), "and where the loop was");

  const fell = run("fell", "$x = 1", false);
  assert(/Loop exit: UNEXPECTED/.test(fell.last),
    "falling off the end with no reason is called UNEXPECTED, not silence");

  const restore = run("restore", [
    "$f = " + q(path.join(dir, "pass-settings-1.json")),
    "Set-Content -LiteralPath $f -Value 'x' -Encoding ASCII",
    "$a = Restore-AellPassFile -Path $f -Value '{\"outputStyle\":\"default\"}'",
    "Remove-Item -LiteralPath $f",
    "$b = Restore-AellPassFile -Path $f -Value '{\"outputStyle\":\"default\"}'",
    "$c = (Get-Content -LiteralPath $f -Raw).Trim()",
    "Set-AellLoopExitReason ('restore a=' + $a + ' b=' + $b + ' c=' + $c)",
    "exit 0"
  ].join("\r\n"), false);
  assert(/restore a=False b=True c=\{"outputStyle":"default"\}/.test(restore.last),
    "Restore-AellPassFile leaves a present file alone and rewrites a deleted one: " + restore.last);

  const logs = path.join(dir, "logs");
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, "local-agent-20260101-000000.log"), "old\r\n");
  const newest = path.join(logs, "local-agent-20260916-013924.log");
  fs.writeFileSync(newest, "live\r\n");
  const now = new Date();
  fs.utimesSync(path.join(logs, "local-agent-20260101-000000.log"), new Date(now - 60000), new Date(now - 60000));
  run("kill", "$ok = Add-AellLoopKillNote -LogDir " + q(logs) +
      " -Note 'killed by hand'\r\nSet-AellLoopExitReason ('note ' + $ok)\r\nexit 0", false);
  const killed = fs.readFileSync(newest, "utf8");
  assert(/Loop exit: killed by hand/.test(killed),
    "the kill note lands in the NEWEST loop log");

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
}

if (failed) {
  console.error("\n" + failed + " FAILED");
  process.exit(1);
}
console.log("\nALL TESTS PASSED");
