// Regression test: the loop's log must keep writing while someone READS it.
//
// Why this exists (WORKPLAN NEXT UP 1, measured 2026-09-16).
//
// Both overnight runs of 2026-09-15/16 wrote 16 lines and then nothing,
// while passes ran and committed for hours. The cause was not a dead
// writer: Windows PowerShell 5.1 `Add-Content` is REFUSED ("being used
// by another process") whenever any other handle on the file is open,
// even a read-only one that allows writers - a Git-Bash `tail -F`, a
// Monitor, a Node fs.openSync(path, "r"). Every loop write site wrapped
// it in `catch { }` or ran it non-terminating, so the log simply stopped.
//
// Two halves, same as test-loop-heartbeat.js:
//   - wiring: no write to the loop log goes through Add-Content again;
//   - behaviour: with a reader HOLDING the file, the real lib appends.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "scripts", "lib", "log-append.ps1");
const LOOP = path.join(ROOT, "scripts", "run-local-agent.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

// ---------------------------------------------------------------- shape
assert(fs.existsSync(LIB), "scripts/lib/log-append.ps1 exists");
const lib = fs.readFileSync(LIB, "utf8");
const loop = fs.readFileSync(LOOP, "utf8");
const code = function (s) { return s.replace(/^\s*#.*$/gm, ""); };

assert(/function\s+Add-AellLogLine/i.test(lib), "the lib defines Add-AellLogLine");
assert(/FileShare\]::ReadWrite/.test(lib) && /FileMode\]::Append/.test(lib),
       "the lib appends with a ReadWrite share, which coexists with readers");
assert(!/Add-Content/.test(code(lib)), "the lib itself does not use Add-Content");

const raw = fs.readFileSync(LIB);
assert(!raw.some(function (b) { return b > 126; }), "log-append.ps1 is pure ASCII");
assert(!(raw[0] === 0xEF && raw[1] === 0xBB), "log-append.ps1 has no BOM");

// ------------------------------------------------------------- wiring
// The loop log is $logFile in the main script and $log inside its jobs.
assert(!/Add-Content\s+-Path\s+\$(logFile|log)\b/.test(code(loop)),
       "run-local-agent.ps1 never Add-Content's the loop log");
assert(/\.\s+\$logAppendLib/.test(loop), "the main script dot-sources the lib");

// Each job is a separate process: it must load the lib itself, or the
// call throws inside a job whose output nobody reads.
for (const name of ["AellDialogWatchdog", "AellPassHeartbeat"]) {
  const i = loop.indexOf("'" + name + "'");
  const block = i > -1 ? loop.slice(i, loop.indexOf("-ArgumentList", i) + 1200) : "";
  assert(i > -1, name + " job still exists");
  assert(/\.\s+\$appendLib/.test(block) && /\$logAppendLib/.test(block),
         name + " is handed the lib and dot-sources it");
}

// -------------------------------------------------------- real behaviour
function findPowerShell() {
  // Windows PowerShell 5.1 FIRST: the refusal is its behaviour.
  const candidates = ["powershell", "pwsh", "/opt/pwsh/pwsh",
                      "/usr/bin/pwsh", "/usr/local/bin/pwsh"];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-NoProfile", "-Command",
                              "$PSVersionTable.PSVersion.Major"],
                          { encoding: "utf8", timeout: 30000 });
      if (r.status === 0 && /^\d+/.test(String(r.stdout).trim())) return c;
    } catch (e) { /* next */ }
  }
  return null;
}

const shell = findPowerShell();
if (!shell) {
  console.log("");
  console.log("SKIP - no PowerShell found, so the appender was not executed.");
  console.log("       Shape and wiring above were checked.");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-logappend-"));
  const file = path.join(dir, "loop.log");
  fs.writeFileSync(file, "first\n");
  const q = function (s) { return "'" + s.replace(/'/g, "''") + "'"; };
  // The reader the loop met in the field: a handle held open for the
  // whole write.
  const fd = fs.openSync(file, "r");
  let r;
  try {
    const script =
      ". " + q(LIB) + "; " +
      "$a = Add-AellLogLine -Path " + q(file) + " -Value 'beat 1'; " +
      "$b = Add-AellLogLine -Path " + q(file) + " -Value ''; " +
      "$c = Add-AellLogLine -Path " + q(file) + " -Value 'beat 2'; " +
      "$old = 'ok'; try { Add-Content -Path " + q(file) +
      " -Value 'ac' -Encoding ASCII -ErrorAction Stop } catch { $old = 'refused' }; " +
      "'RESULT ' + $a + ' ' + $b + ' ' + $c + ' ADDCONTENT ' + $old";
    r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script],
                  { encoding: "utf8", timeout: 60000 });
  } finally {
    fs.closeSync(fd);
  }
  const out = String(r.stdout || "").trim();
  console.log("   " + out.split(/\r?\n/).pop());
  assert(/RESULT True True True/.test(out),
         "Add-AellLogLine reports success on every call while a reader holds the file");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  assert(lines[0] === "first" && lines[1] === "beat 1" && lines[2] === "" &&
         lines[3] === "beat 2",
         "the lines landed, in order, blank line included (got " +
         JSON.stringify(lines.slice(0, 4)) + ")");
  // Informational: the fact this lib exists for. Not asserted - it is
  // Windows PowerShell 5.1's behaviour, and pwsh on Linux does not share it.
  console.log("   note: plain Add-Content under the same reader was " +
              (/ADDCONTENT refused/.test(out) ? "REFUSED" : "accepted") +
              " on " + shell);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (failed) {
  console.error(failed + " TEST(S) FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
