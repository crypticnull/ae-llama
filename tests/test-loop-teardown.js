// Regression test: the overnight loop must release the GPU when it ends,
// on EVERY path out, and must say whether it worked.
//
// Why this exists (WORKPLAN 17q, NEXT UP item 1).
//
// The bug this guards is not "is there a teardown" -- there was one, with
// a paragraph of measured justification above it -- but WHERE IT SITS.
// The 2026-09-09 fix for 17q was pasted inside the `-PreflightOnly` early
// exit: the single path on which no pass has run and no backend can
// exist. It read perfectly in a diff and was unreachable from a real
// overnight loop, so for a week the card kept whatever the night booted
// while the queue's top item was "confirm the teardown worked".
//
// Two properties make that impossible to repeat, and this file asserts
// both:
//
//   1. ONE definition, at top level, called from every exit. A teardown
//      inlined at one exit is a teardown missing from the others.
//   2. The loop writes its OWN verdict. NEXT UP item 1 originally asked a
//      PASS to confirm the teardown by reading the morning log, which no
//      pass can do: every unattended pass runs INSIDE the loop whose exit
//      it is asked to observe, so the line cannot exist yet. A check a
//      pass performs on the loop containing it is not a check.
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
const GPU = path.join(ROOT, "scripts", "lib", "gpu-detect.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

const loop = fs.readFileSync(LOOP, "utf8");
const gpu = fs.readFileSync(GPU, "utf8");
const lines = loop.split(/\r?\n/);

// A brace depth per line, counting the braces that OPEN before it. Good
// enough for this file: it has no braces inside string literals on the
// lines that matter, and the alternative (a real parser) is what
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

// ------------------------------------------- one definition, at top level
const defIdx = lines.findIndex((l) => /^function Stop-AellLoopBackend/.test(l));
assert(defIdx >= 0,
  "the backend teardown is a named function, not inlined at one exit");
if (defIdx >= 0) {
  assert(depth[defIdx] === 0,
    "and it is defined at top level, so every exit can reach it");
}

const stopLines = [];
lines.forEach((l, i) => {
  // An INVOCATION, not the advice line that prints the same command for
  // a human to run by hand.
  if (/& node .*comfy-install\.js'\) --stop/.test(l)) stopLines.push(i);
});
assert(stopLines.length === 1,
  "`comfy-install.js --stop` is invoked in exactly ONE place (" +
  stopLines.length + ")");
if (stopLines.length === 1 && defIdx >= 0) {
  assert(stopLines[0] > defIdx,
    "and that place is inside Stop-AellLoopBackend");
}

// ------------------------------- THE original bug, stated as its own test
//
// Find the `if ($PreflightOnly) {` block and its matching close, then
// assert the stop call is not in it. This is the exact shape of the
// 2026-09-09 mistake; nothing else in this file would have caught it,
// because every other property held.
const pfIdx = lines.findIndex((l) => /if \(\$PreflightOnly\)\s*\{/.test(l));
assert(pfIdx >= 0, "the -PreflightOnly early exit is still there to test against");
if (pfIdx >= 0) {
  const open = depth[pfIdx];
  let close = lines.length;
  for (let i = pfIdx + 1; i < lines.length; i++) {
    if (depth[i] <= open) { close = i; break; }
  }
  const inBlock = (i) => i > pfIdx && i < close;
  assert(!stopLines.some(inBlock),
    "the --stop call is NOT buried inside the -PreflightOnly block " +
    "(that is the 17q bug: unreachable from a real loop)");
  assert(defIdx < 0 || !inBlock(defIdx),
    "and neither is the function definition");
}

// ---------------------------------------------- called from EVERY exit
//
// Two `exit`s precede the loop machinery -- the WMI detach handoff and
// "CLI not found" -- and no backend can exist at either, so only the
// exits after the function definition are required to tear down. A new
// early exit added after it is required to, and that is the point.
const calls = [];
lines.forEach((l, i) => {
  if (/Stop-AellLoopBackend/.test(l) && !/^function /.test(l)) calls.push(i);
});
assert(calls.length >= 3,
  "the teardown is called from at least three exits (found " +
  calls.length + ")");

const exits = [];
lines.forEach((l, i) => { if (/^\s*exit \d/.test(l)) exits.push(i); });
for (const e of exits) {
  if (defIdx < 0 || e < defIdx) continue;
  const near = calls.some((c) => c < e && e - c <= 30);
  assert(near,
    "the exit on line " + (e + 1) + " tears the backend down first");
}
// The fall-through end of the script is an exit too, and the one that
// matters most: it is how a finished overnight loop ends.
const finished = lines.findIndex((l) => /Write-Log 'Loop finished\.'/.test(l));
assert(finished >= 0 && calls.some((c) => c < finished),
  "the normal end of the loop tears the backend down before finishing");

// ------------------------------------------------ it writes a real verdict
assert(/\$gpuFloor = Get-AellGpuMemoryMB/.test(loop),
  "the card is read BEFORE any pass runs, so there is a baseline to compare");
const floorIdx = lines.findIndex((l) => /\$gpuFloor = Get-AellGpuMemoryMB/.test(l));
assert(floorIdx >= 0 && floorIdx < defIdx,
  "and the baseline is taken before the teardown, not inside it");
assert(/Stop-AellLoopBackend -Floor \$gpuFloor/.test(loop),
  "every call passes that baseline in");
assert(/lib\\gpu-detect\.ps1/.test(loop),
  "the loop dot-sources the GPU helpers rather than re-deriving them");

const body = defIdx >= 0
  ? loop.slice(loop.indexOf("function Stop-AellLoopBackend"))
  : "";
const fnEnd = body.indexOf("\n# --- preflight");
const fn = fnEnd > 0 ? body.slice(0, fnEnd) : body;
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

// -------------------------------------- never the [N/A] column (measured)
// Both files SPELL the column in prose, explaining why it is not used --
// so the check has to look at code, not at the file. Comments out first.
// `<# ... #>` help blocks count as comments too; the first version of
// this check only stripped `#` lines and tripped over a doc-comment.
const uncommented = (src) => src.replace(/<#[\s\S]*?#>/g, "")
  .split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
assert(!/used_memory/.test(uncommented(gpu)),
  "the helpers never query per-process used_memory -- it is [N/A] under WDDM");
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
                           ["lib/gpu-detect.ps1", gpu]]) {
  const bad = src.split("").findIndex((c) => c.charCodeAt(0) > 126);
  assert(bad < 0, name + " is pure ASCII (PS 5.1 rule)" +
    (bad < 0 ? "" : " -- offender at offset " + bad));
}

console.log(failed ? "\n" + failed + " TEST(S) FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
