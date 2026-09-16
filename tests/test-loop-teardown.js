// Regression test: the overnight loop must release the GPU when it ends,
// on EVERY path out -- including the one the OWNER takes -- and must say
// whether it worked.
//
// Why this exists (WORKPLAN 17q and 17q-b, NEXT UP items 1 and 1a).
//
// The bug this guards is not "is there a teardown" -- there was one, with
// a paragraph of measured justification above it -- but WHERE IT SITS.
// Twice now:
//
//   1. The 2026-09-09 fix for 17q was pasted inside the `-PreflightOnly`
//      early exit: the single path on which no pass has run and no
//      backend can exist. It read perfectly in a diff and was unreachable
//      from a real overnight loop, so for a week the card kept whatever
//      the night booted while the queue's top item was "confirm the
//      teardown worked".
//   2. The 2026-09-16 fix for that put the teardown on all three of the
//      loop's own exits -- and the owner takes none of them. He runs
//      `stop-local-agent.ps1`, which Stop-Processes the loop shell, and a
//      killed process runs no teardown. The documented way to cut a night
//      short was a silent 27 GB leak (17q-b): the word `comfy` appeared
//      zero times in all 111 lines of that script.
//
// Three properties make that class impossible to repeat, and this file
// asserts all three:
//
//   a. ONE definition, in scripts/lib, at top level. A teardown inlined
//      at one exit is a teardown missing from the others, and a copy per
//      script is how one copy ends up in the wrong branch again.
//   b. EVERY exit that can follow a pass calls it -- in both scripts.
//   c. The script writes its OWN verdict. NEXT UP item 1 originally asked
//      a PASS to confirm the teardown, which no pass can do: every
//      unattended pass runs INSIDE the loop whose exit it is asked to
//      observe, so the line cannot exist yet. A check a pass performs on
//      the loop containing it is not a check.
//
// Plus the driver fact the verdict had to be built around, measured
// 2026-09-16 on this machine (driver 616.56, RTX 5090, WDDM):
// `nvidia-smi --query-compute-apps=used_memory` answers `[N/A]` for every
// process, including the 27 GB ComfyUI of 17q. Per-process VRAM does not
// exist here, so a check written against that column is silent by
// construction -- and silence reads like success.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOOP = path.join(ROOT, "scripts", "run-local-agent.ps1");
const STOP = path.join(ROOT, "scripts", "stop-local-agent.ps1");
const LIB = path.join(ROOT, "scripts", "lib", "comfy-teardown.ps1");
const GPU = path.join(ROOT, "scripts", "lib", "gpu-detect.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

const loop = fs.readFileSync(LOOP, "utf8");
const stop = fs.readFileSync(STOP, "utf8");
const lib = fs.readFileSync(LIB, "utf8");
const gpu = fs.readFileSync(GPU, "utf8");
const lines = loop.split(/\r?\n/);
const stopLines_ = stop.split(/\r?\n/);
const libLines = lib.split(/\r?\n/);

// A brace depth per line, counting the braces that OPEN before it. Good
// enough for these files: they have no braces inside string literals on
// the lines that matter, and the alternative (a real parser) is what
// test-powershell-syntax.js is for.
function depths(src) {
  const out = [];
  let d = 0;
  for (const line of src.split(/\r?\n/)) {
    const bare = line.replace(/#.*$/, "");
    out.push(d);
    for (const ch of bare) {
      if (ch === "{") d++;
      else if (ch === "}") d--;
    }
  }
  return out;
}
const depth = depths(loop);
const stopDepth = depths(stop);
const libDepth = depths(lib);

// --------------------------------- ONE definition, in lib, at top level
const defIdx = libLines.findIndex((l) => /^function Stop-AellLoopBackend/.test(l));
assert(defIdx >= 0,
  "the backend teardown is a named function in scripts/lib, not inlined " +
  "at one exit");
if (defIdx >= 0) {
  assert(libDepth[defIdx] === 0,
    "and it is defined at top level, so every caller can reach it");
}
// 17q-b: the fix for the second caller must not be a second copy.
for (const [name, src] of [["run-local-agent.ps1", loop],
                           ["stop-local-agent.ps1", stop]]) {
  assert(!/^function Stop-AellLoopBackend/m.test(src),
    name + " does not define its own copy of the teardown");
  assert(/lib\\comfy-teardown\.ps1/.test(src),
    name + " dot-sources the shared teardown");
}

const invocations = [];
libLines.forEach((l, i) => {
  // An INVOCATION, not the advice line that prints the same command for
  // a human to run by hand.
  if (/& node .*comfy-install\.js'\) --stop/.test(l)) invocations.push(i);
});
assert(invocations.length === 1,
  "`comfy-install.js --stop` is invoked in exactly ONE place (" +
  invocations.length + ")");
if (invocations.length === 1 && defIdx >= 0) {
  assert(invocations[0] > defIdx,
    "and that place is inside Stop-AellLoopBackend");
}
for (const [name, src] of [["run-local-agent.ps1", loop],
                           ["stop-local-agent.ps1", stop]]) {
  assert(!/& node .*comfy-install\.js'\) --stop/.test(src),
    name + " invokes --stop through the shared function, not by hand");
}

// ------------------------------- THE original bug, stated as its own test
//
// Find the `if ($PreflightOnly) {` block and its matching close, then
// assert the teardown CALL there is a call and not the definition -- the
// 2026-09-09 mistake was the whole stop block living inside that branch,
// which made it unreachable from a real loop. Nothing else in this file
// would have caught it, because every other property held.
const pfIdx = lines.findIndex((l) => /if \(\$PreflightOnly\)\s*\{/.test(l));
assert(pfIdx >= 0, "the -PreflightOnly early exit is still there to test against");
if (pfIdx >= 0) {
  const open = depth[pfIdx];
  let close = lines.length;
  for (let i = pfIdx + 1; i < lines.length; i++) {
    if (depth[i] <= open) { close = i; break; }
  }
  const inBlock = (i) => i > pfIdx && i < close;
  const sourced = lines.findIndex((l) => /lib\\comfy-teardown\.ps1/.test(l));
  assert(sourced >= 0 && !inBlock(sourced) && depth[sourced] === 0,
    "the teardown is dot-sourced at top level, not inside the " +
    "-PreflightOnly block (that is the 17q bug: unreachable from a real loop)");
}

// ---------------------------------------------- called from EVERY exit
//
// Two `exit`s precede the loop machinery -- the WMI detach handoff and
// "CLI not found" -- and no backend can exist at either, so only the
// exits after the dot-source are required to tear down. A new early exit
// added after it is required to, and that is the point.
const sourceIdx = lines.findIndex((l) => /lib\\comfy-teardown\.ps1/.test(l));
const calls = [];
lines.forEach((l, i) => {
  if (/Stop-AellLoopBackend/.test(l) && !/^\s*\.\s/.test(l)) calls.push(i);
});
assert(calls.length >= 3,
  "the loop calls the teardown from at least three exits (found " +
  calls.length + ")");

const exits = [];
lines.forEach((l, i) => { if (/^\s*exit \d/.test(l)) exits.push(i); });
for (const e of exits) {
  if (sourceIdx < 0 || e < sourceIdx) continue;
  const near = calls.some((c) => c < e && e - c <= 30);
  assert(near,
    "the exit on line " + (e + 1) + " tears the backend down first");
}
// The fall-through end of the script is an exit too, and the one that
// matters most: it is how a finished overnight loop ends.
const finished = lines.findIndex((l) => /Write-Log 'Loop finished\.'/.test(l));
assert(finished >= 0 && calls.some((c) => c < finished),
  "the normal end of the loop tears the backend down before finishing");

// ------------------------------------- 17q-b: the owner's path, too
//
// This script is what the loop's own detach message tells the owner to
// run. It kills the loop shell, so none of the exits tested above ever
// executes; the teardown has to happen HERE or not at all.
assert(/stop-local-agent/.test(loop),
  "the loop still points the owner at stop-local-agent.ps1 to stop a night");
const stopCalls = [];
stopLines_.forEach((l, i) => {
  if (/Stop-AellLoopBackend/.test(l) && !/^\s*\.\s/.test(l)) stopCalls.push(i);
});
assert(stopCalls.length === 1,
  "stop-local-agent.ps1 tears the backend down, in exactly one place (" +
  stopCalls.length + ")");
if (stopCalls.length === 1) {
  const c = stopCalls[0];
  // It must not be buried in a branch that a normal run skips -- the 17q
  // bug in miniature. The ONE condition it may sit under is -KeepBackend.
  let guard = -1;
  for (let i = c - 1; i >= 0; i--) {
    if (stopDepth[i] < stopDepth[c]) { guard = i; break; }
  }
  assert(stopDepth[c] <= 1,
    "and it is not nested deep in branches (depth " + stopDepth[c] + ")");
  assert(stopDepth[c] === 0 || (guard >= 0 && /\$KeepBackend/.test(stopLines_[guard])),
    "the only condition it sits under is -KeepBackend" +
    (guard >= 0 ? " (found: " + stopLines_[guard].trim() + ")" : ""));
  // Killing comes first: a pass killed mid-boot is still writing the PID
  // record that --stop has to read.
  const killIdx = stopLines_.findIndex((l) => /Stop-Process -Id \$p\.ProcessId/.test(l));
  assert(killIdx >= 0 && killIdx < c,
    "the processes are stopped before the backend is, not after");
  for (const e of stopLines_.reduce((acc, l, i) => {
    if (/^\s*exit \d/.test(l)) acc.push(i);
    return acc;
  }, [])) {
    assert(e > c,
      "no exit on line " + (e + 1) + " leaves before the teardown runs");
  }
}
assert(/\[switch\]\$KeepBackend/.test(stop),
  "and there is an explicit opt-out for the one case where stopping is wrong");
// The measurement that opened 17q-b: `comfy` appeared zero times here.
assert((stop.match(/comfy/gi) || []).length > 0,
  "stop-local-agent.ps1 knows the backend exists at all (17q-b was: it did not)");

// ------------------------------------------------ it writes a real verdict
assert(/\$gpuFloor = Get-AellGpuMemoryMB/.test(loop),
  "the card is read BEFORE any pass runs, so there is a baseline to compare");
const floorIdx = lines.findIndex((l) => /\$gpuFloor = Get-AellGpuMemoryMB/.test(l));
assert(floorIdx >= 0 && sourceIdx >= 0 && floorIdx < calls[0],
  "and the baseline is taken before the teardown, not inside it");
assert(/Stop-AellLoopBackend -Floor \$gpuFloor/.test(loop),
  "every loop call passes that baseline in");
assert(/gpu-detect\.ps1/.test(lib),
  "the teardown dot-sources the GPU helpers rather than re-deriving them");

const fn = lib.slice(lib.indexOf("function Stop-AellLoopBackend"));
assert(/Get-AellGpuProcesses/.test(fn),
  "the verdict asks whether a managed PROCESS is still on the card");
assert(/STILL ON THE CARD/.test(fn),
  "and says so loudly when one is -- the owner reads this log, not a diff");
assert(/card is back/.test(fn),
  "and confirms the clean case, so 'no line' cannot be read as 'fine'");
assert(/NOT VERIFIED/.test(fn),
  "an unreadable card is reported as unverified, never as success");
// The 2026-09-06 failure was the opposite direction: --stop found no
// record and killed nothing while a backend held 27 GB. "Nothing to stop"
// plus "a process is on the card" is a distinct bug and must read as one.
assert(/PID record did not survive/.test(fn),
  "a no-record stop with a process still on the card names the PID-record bug");
// Every sentence --stop can answer with must be recognised, or the
// verdict falls through to "said nothing recognisable" on a real stop.
// comfy-managed.js has THREE: the remembered PID, the port fallback, and
// nothing to stop.
const managed = fs.readFileSync(
  path.join(ROOT, "scripts", "lib", "comfy-managed.js"), "utf8");
const matchLine = fn.match(/-match '([^']+)'/);
assert(matchLine, "the verdict filters --stop's output with one -match");
for (const phrase of ["stopped the managed backend (pid ",
                      "stopped the backend holding port ",
                      "no managed backend found to stop ("]) {
  assert(managed.indexOf(phrase) >= 0,
    "comfy-managed.js still says \"" + phrase.trim() + "\"");
  assert(matchLine && new RegExp(matchLine[1]).test(phrase),
    "and the verdict recognises it");
}

// -------------------------------------- never the [N/A] column (measured)
// These files SPELL the column in prose, explaining why it is not used --
// so the check has to look at code, not at the file. Comments out first.
// `<# ... #>` help blocks count as comments too; the first version of
// this check only stripped `#` lines and tripped over a doc-comment.
const uncommented = (src) => src.replace(/<#[\s\S]*?#>/g, "")
  .split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
assert(!/used_memory/.test(uncommented(gpu)),
  "the helpers never query per-process used_memory -- it is [N/A] under WDDM");
assert(!/used_memory/.test(uncommented(lib)), "and neither does the teardown");
assert(!/used_memory/.test(uncommented(loop)), "and neither does the loop");
assert(/query-gpu=memory\.used/.test(gpu),
  "device total-used is what they read instead");
assert(/query-compute-apps=pid,process_name/.test(gpu),
  "and the process LIST, which is the only other trustworthy column");

// ------------------------------------------------- the helpers' contract
const memFn = gpu.slice(gpu.indexOf("function Get-AellGpuMemoryMB"),
                        gpu.indexOf("function Get-AellGpuProcesses"));
assert(/if \(-not \$smi\) \{ return \$null \}/.test(memFn),
  "no nvidia-smi answers $null, not 0 -- 0 would read as an empty card");
assert((memFn.match(/return \$null/g) || []).length >= 4,
  "and so does every other unreadable answer (" +
  (memFn.match(/return \$null/g) || []).length + " paths)");
const procFn = gpu.slice(gpu.indexOf("function Get-AellGpuProcesses"));
assert(/IndexOf\(',' ?\)|\$line\.IndexOf\(','\)/.test(procFn),
  "the CSV is split on the FIRST comma -- a Windows path can hold one");

// ------------------------- the path fragment must match the real install
//
// A fragment that matches nothing is silent, which is this file's whole
// subject. Tie it to the two places that actually build the path.
const frag = fn.match(/\$fragment = '([^']+)'/);
assert(frag, "the teardown names the managed vendor path fragment");
if (frag) {
  const settings = fs.readFileSync(
    path.join(ROOT, "extension", "js", "settings.js"), "utf8");
  const setup = fs.readFileSync(
    path.join(ROOT, "extension", "js", "setup.js"), "utf8");
  assert(/path\.join\(base, "AE-Llama"\)/.test(settings),
    "settings.js still puts the data root in an AE-Llama folder");
  assert(/dataRoot\(\), "vendor", "comfy"\)/.test(setup),
    "setup.js still puts the managed backend in vendor/comfy under it");
  assert(frag[1] === "AE-Llama\\vendor\\comfy",
    "and the fragment spells exactly that (" + frag[1] + ")");
}

// --------------------------------------------------------- ASCII, always
for (const [name, src] of [["run-local-agent.ps1", loop],
                           ["stop-local-agent.ps1", stop],
                           ["lib/comfy-teardown.ps1", lib],
                           ["lib/gpu-detect.ps1", gpu]]) {
  const bad = src.split("").findIndex((c) => c.charCodeAt(0) > 126);
  assert(bad < 0, name + " is pure ASCII (PS 5.1 rule)" +
    (bad < 0 ? "" : " -- offender at offset " + bad));
}

console.log(failed ? "\n" + failed + " TEST(S) FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
