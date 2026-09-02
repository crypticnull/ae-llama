// Regression test: every .ps1 in this repo must PARSE.
//
// Why this exists. The remote session writes Windows PowerShell it
// cannot execute, so a syntax error does not surface here - it surfaces
// on the owner's machine, as a wasted launch of After Effects or
// Premiere. On 2026-09-02 a single day of Premiere probing cost five
// separate round trips, each teaching exactly one defect. Parse errors
// are the cheapest member of that family to kill outright: the
// PowerShell parser is a library call, and it needs no Adobe app, no
// Windows, and no user.
//
// PowerShell 7 is cross-platform, so this runs anywhere pwsh is
// installed - including CI's windows-latest, where it is always present.
// When no PowerShell can be found the suite SKIPS loudly rather than
// failing: a Linux container without pwsh should not turn red, but it
// must not quietly pretend the files were checked either.
//
// To make it run in a bare container:
//   curl -fsSL https://github.com/PowerShell/PowerShell/releases/download/\
//     v7.4.6/powershell-7.4.6-linux-x64.tar.gz -o /tmp/ps.tar.gz
//   mkdir -p /opt/pwsh && tar -xzf /tmp/ps.tar.gz -C /opt/pwsh
//   chmod +x /opt/pwsh/pwsh
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

function findPowerShell() {
  const candidates = ["pwsh", "powershell", "/opt/pwsh/pwsh",
                      "/usr/bin/pwsh", "/usr/local/bin/pwsh"];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
                          { encoding: "utf8", timeout: 30000 });
      if (r.status === 0 && /^\d+/.test(String(r.stdout).trim())) {
        return { exe: c, major: String(r.stdout).trim() };
      }
    } catch (e) { /* next */ }
  }
  return null;
}

function ps1Files(dir, out) {
  out = out || [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  entries.forEach(function (e) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") {
      return;
    }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { ps1Files(p, out); }
    else if (/\.ps1$/i.test(e.name)) { out.push(p); }
  });
  return out;
}

const files = ps1Files(ROOT);
assert(files.length >= 10, "found " + files.length + " .ps1 files");

// --------------------------------------------- checks that need no shell
// CLAUDE.md: pure ASCII, no BOM, Windows PowerShell 5.1. A BOM or a
// smart quote from an editor breaks 5.1 in ways that look like logic
// bugs, and neither needs a parser to catch.
files.forEach(function (f) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  const buf = fs.readFileSync(f);
  const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB &&
              buf[2] === 0xBF;
  assert(!bom, rel + " has no UTF-8 BOM");
  const nonAscii = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b > 126 || (b < 32 && b !== 9 && b !== 10 && b !== 13)) {
      nonAscii.push(i);
      if (nonAscii.length > 3) { break; }
    }
  }
  assert(nonAscii.length === 0,
         rel + " is pure ASCII" +
         (nonAscii.length ? " (byte " + buf[nonAscii[0]] + " at offset " +
                            nonAscii[0] + ")" : ""));
});

// ------------------------------------------------------ the real parse
const shell = findPowerShell();
if (!shell) {
  console.log("");
  console.log("SKIP - no PowerShell found, so NOTHING was parsed.");
  console.log("      The ASCII and BOM checks above did run.");
  console.log("      Install pwsh (see the header of this file) to get the");
  console.log("      parse check, which is the half that catches the errors");
  console.log("      that otherwise cost a trip to the owner's machine.");
  console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED (parse skipped)");
  process.exitCode = failed ? 1 : 0;
} else {
  console.log("using " + shell.exe + " (PowerShell " + shell.major + ")");

  // One pwsh launch for every file: startup dominates the cost, and a
  // per-file launch would make this the slowest suite in the repo.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$out = @()",
    "foreach ($p in $args) {",
    "  $errs = $null",
    "  $null = [System.Management.Automation.Language.Parser]::ParseFile(" +
      "$p, [ref]$null, [ref]$errs)",
    "  if ($errs -and $errs.Count -gt 0) {",
    "    foreach ($e in $errs) {",
    "      $out += ($p + '|' + $e.Extent.StartLineNumber + '|' + $e.Message)",
    "    }",
    "  }",
    "}",
    "$out -join [Environment]::NewLine"
  ].join("\n");

  const tmp = path.join(os.tmpdir(), "aell-ps-parse-" + process.pid + ".ps1");
  fs.writeFileSync(tmp, script, "utf8");
  let stdout = "";
  try {
    stdout = execFileSync(shell.exe,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp].concat(files),
      { encoding: "utf8", timeout: 180000 });
  } catch (e) {
    stdout = String(e.stdout || "") + String(e.stderr || "");
  }
  fs.unlinkSync(tmp);

  const problems = {};
  String(stdout).split(/\r?\n/).forEach(function (line) {
    if (!line.trim()) { return; }
    const parts = line.split("|");
    if (parts.length < 3) { return; }
    const rel = path.relative(ROOT, parts[0]).replace(/\\/g, "/");
    if (!problems[rel]) { problems[rel] = []; }
    problems[rel].push("line " + parts[1] + ": " + parts.slice(2).join("|"));
  });

  files.forEach(function (f) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const p = problems[rel];
    assert(!p, rel + " parses" + (p ? ": " + p.slice(0, 3).join("; ") : ""));
  });

  console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
  process.exitCode = failed ? 1 : 0;
}
