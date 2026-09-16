// Regression test: the bypass flag must reach the CLI as a REAL flag.
//
// Why this exists (WORKPLAN section 20d).
//
// Four nights (2026-09-05 to 09-08) ran every pass read-only. The brief
// went in on the command line; Windows PowerShell 5.1 shredded it into
// argv fragments at its double quotes, one fragment was the bare `--`
// from "SUPERSEDES: <lines> -- <what changed>", and the CLI honours a
// bare `--` as end-of-options. The trailing --dangerously-skip-permissions
// became prompt text. Nothing errored: the string WAS in argv the whole
// time, which is why "the flag is in argv" is not the assertion here.
// The assertion is that an argument parser, reading argv the way the CLI
// does, sees it as an OPTION.
//
// The brief and the flag array are read out of run-local-agent.ps1 and
// executed, never copied into this file: a test that passes against a
// stale copy of the thing it guards is the preflight mistake again. The
// executable is swapped for a stub that records its argv and stdin; the
// pipeline shape is the loop's own line.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LOOP = path.join(ROOT, "scripts", "run-local-agent.ps1");
const BYPASS = "--dangerously-skip-permissions";

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

const loop = fs.readFileSync(LOOP, "utf8").replace(/\r\n/g, "\n");

// ------------------------------------------------------------- wiring
assert(/\[switch\]\$SkipPermissions = \$true/.test(loop),
  "-SkipPermissions still defaults ON, so an unattended loop gets the bypass");

const blockStart = loop.indexOf("$prompt = @'");
const blockEndRe = /^\$claudeArgs = \$claudeFlags \+ @\('-p'\)$/m;
const endMatch = blockEndRe.exec(loop);
assert(blockStart > -1 && endMatch && endMatch.index > blockStart,
  "the brief, the flag array and $claudeArgs are still one contiguous block");
const block = (blockStart > -1 && endMatch)
  ? loop.slice(blockStart, endMatch.index + endMatch[0].length) : "";

// The flags that take a value, read from how the loop builds them, so a
// new `@('--x', $X)` pair is parsed correctly without editing this file.
const valued = new Set();
{
  const re = /@\('(--[a-z-]+)',/g;
  let m;
  while ((m = re.exec(block))) valued.add(m[1]);
}
assert(valued.has("--settings") && valued.has("--model"),
  "value-taking flags were read from the block (" + Array.from(valued).join(" ") + ")");

// Every CLI invocation passes flags and a bare -p, and nothing else.
const calls = loop.match(/& \$ClaudePath [^\n|]*/g) || [];
assert(calls.length >= 2, "found the preflight and the pass invocations (" + calls.length + ")");
for (const c of calls) {
  const argsPart = c.replace(/^& \$ClaudePath\s+/, "").replace(/\s*2>&1\s*$/, "").trim();
  assert(argsPart === "@claudeArgs" || argsPart === "@($claudeFlags + @('-p'))",
    "`" + c.trim() + "` passes only the flag array and -p");
}
const passLine = /Get-Content -Raw \$promptFile \|\s*& \$ClaudePath @claudeArgs 2>&1/.exec(loop);
assert(passLine, "the pass reads its prompt from the prompt file on STDIN");
assert(/Get-Content -Raw \$probeFile \|\s*& \$ClaudePath @\(\$claudeFlags \+ @\('-p'\)\) 2>&1/.test(loop),
  "and so does the preflight, the same way");

// ----------------------------------------------------- argv, as the CLI
// reads it: `--` ends options, a valued flag eats the next token, a
// leading dash is an option, anything else is a positional (prompt text).
function parseCli(argv) {
  const opts = new Set(), positional = [];
  let ended = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (ended) { positional.push(t); continue; }
    if (t === "--") { ended = true; continue; }
    if (valued.has(t)) { opts.add(t); i++; continue; }
    if (/^-/.test(t)) { opts.add(t); continue; }
    positional.push(t);
  }
  return { opts: opts, positional: positional, ended: ended };
}
{
  // The parser itself must tell the two cases apart, or nothing below means anything.
  const broken = parseCli(["-p", "SUPERSEDES:", "<lines>", "--", "<what", BYPASS]);
  const fixed = parseCli([BYPASS, "--settings", "x.json", "-p"]);
  assert(!broken.opts.has(BYPASS) && broken.positional.indexOf(BYPASS) > -1,
    "parser: a bypass after a bare -- is prompt text, even though it is in argv");
  assert(fixed.opts.has(BYPASS) && fixed.positional.length === 0,
    "parser: flags then a bare -p is a real bypass and no prompt text");
}

// -------------------------------------------------------- real behaviour
function findPowerShell() {
  const candidates = ["powershell", "pwsh", "/opt/pwsh/pwsh",
                      "/usr/bin/pwsh", "/usr/local/bin/pwsh"];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-NoProfile", "-Command",
                              "$PSVersionTable.PSVersion.Major"],
                          { encoding: "utf8", timeout: 30000 });
      if (r.status === 0 && /^\d+/.test(String(r.stdout).trim())) {
        return { exe: c, major: parseInt(String(r.stdout).trim(), 10) };
      }
    } catch (e) { /* next */ }
  }
  return null;
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

const shell = block && passLine ? findPowerShell() : null;
if (!shell) {
  console.log("");
  console.log("SKIP - no PowerShell found (or the block was not found), so the");
  console.log("       invocation was not executed. Wiring above was checked.");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-pass-invocation-"));
  fs.mkdirSync(path.join(dir, "logs"));
  const stub = path.join(dir, "fake-cli.js");
  fs.writeFileSync(stub,
    "const fs = require('fs');\n" +
    "let input = '';\n" +
    "process.stdin.setEncoding('utf8');\n" +
    "process.stdin.on('data', function (d) { input += d; });\n" +
    "process.stdin.on('end', function () {\n" +
    "  fs.writeFileSync(process.env.AELL_FAKE_CLI_OUT,\n" +
    "    JSON.stringify({ argv: process.argv.slice(2), stdin: input }));\n" +
    "});\n");

  // Runs the loop's block, then the given invocation, with the CLI
  // swapped for `node fake-cli.js`. Node parses its command line with
  // the same MSVCRT rules the CLI binary does, so argv matches.
  const run = function (tag, invocation) {
    const out = path.join(dir, tag + ".json");
    const script = path.join(dir, tag + ".ps1");
    fs.writeFileSync(script, [
      "$ErrorActionPreference = 'Stop'",
      "$RepoRoot = " + psQuote(dir),
      "$SkipPermissions = $true",
      "$Model = 'test-model'",
      "$Effort = 'xhigh'",
      "$ClaudePath = " + psQuote(process.execPath),
      "$fakeCli = " + psQuote(stub),
      block,
      invocation + " | Out-Null",
      ""
    ].join("\r\n"));
    const r = spawnSync(shell.exe, ["-NoProfile", "-NonInteractive",
                                    "-ExecutionPolicy", "Bypass", "-File", script],
                        { encoding: "utf8", timeout: 60000,
                          env: Object.assign({}, process.env, { AELL_FAKE_CLI_OUT: out }) });
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(out, "utf8")); } catch (e) { /* none */ }
    return { r: r, rec: rec };
  };

  // The brief itself, as PowerShell holds it, for the stdin comparison.
  const briefBody = /\$prompt = @'\n([\s\S]*?)\n'@/.exec(block);
  assert(briefBody && / -- /.test(briefBody[1]) && /"/.test(briefBody[1]),
    "the real brief still carries both hazards (a bare -- and double quotes), so this run is the hard case");

  const pass = run("pass", passLine[0].replace("& $ClaudePath @claudeArgs",
                                              "& $ClaudePath $fakeCli @claudeArgs"));
  assert(pass.rec, "the loop's own block and pass pipeline ran the stub (" + shell.exe +
         " " + shell.major + (pass.rec ? "" : "; stderr " +
         String(pass.r.stderr).trim().slice(0, 300)) + ")");
  if (pass.rec) {
    const p = parseCli(pass.rec.argv);
    assert(p.opts.has(BYPASS),
      "the bypass is parsed as a real OPTION, not merely present (argv " +
      JSON.stringify(pass.rec.argv) + ")");
    assert(p.opts.has("-p") && pass.rec.argv[pass.rec.argv.length - 1] === "-p",
      "-p is the last argument and takes no value");
    assert(!p.ended && p.positional.length === 0,
      "no bare -- and no positional prompt text reached the command line");
    // Normalise BOTH sides. The stdin side was normalised and the source
    // side was not, so this comparison depended on how the checkout wrote
    // its line endings: green on a CRLF working copy, one character out on
    // an LF one (CI, 2026-09-16: "4850 chars of 4849"). The bug was in the
    // assertion, not the invocation -- every other check here passed,
    // including that the bypass parses as a real OPTION.
    const eol = function (t) {
      return String(t).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                      .replace(/\n+$/, "");
    };
    const got = eol(pass.rec.stdin);
    assert(briefBody && got === eol(briefBody[1]),
      "the CLI received the WHOLE brief on stdin (" + got.length + " chars" +
      (briefBody ? " of " + eol(briefBody[1]).length : "") + ")");
  }

  // Mutation: the pre-2026-09-08 shape, prompt on the command line ahead
  // of the flags. Only Windows PowerShell 5.1 shreds it; pwsh 7 passes
  // arguments correctly, so there the mutation is expected to survive.
  const mutant = run("mutant", "& $ClaudePath $fakeCli -p $prompt @claudeFlags 2>&1");
  if (mutant.rec && shell.major <= 5) {
    const m = parseCli(mutant.rec.argv);
    assert(!m.opts.has(BYPASS) && mutant.rec.argv.indexOf(BYPASS) > -1,
      "mutation check: on PS " + shell.major + " the old command-line prompt loses the bypass " +
      "while it is still in argv, and this test sees the difference");
  } else {
    console.log("note - mutation check not asserted: PowerShell " + shell.major +
                (mutant.rec ? " passes native arguments correctly" : " did not run the mutant"));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (failed) {
  console.error(failed + " check(s) failed.");
  process.exit(1);
}
console.log("All pass-invocation checks passed.");
