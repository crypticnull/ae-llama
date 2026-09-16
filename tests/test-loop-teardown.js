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


// ======================================================================
// 17q-d: a kill nobody waited for was reported as a success
// ======================================================================
//
// The three items above verify the SCRIPTS around the stop -- which exit
// calls it, which process it is allowed to kill. None of them verified
// that the process actually DIED, and on 2026-09-16 one did not: the
// 06:10:59 probe logged `stopped the managed backend (pid 44324)`,
// deleted the PID record, and pid 44324 was still LISTENING on 8288 and
// holding the card when the next night's 02:19 pass found it 70 minutes
// later. With the record gone, nothing could find it -- and the panel's
// own ensureRunning then REFUSES to generate against an orphan on its
// port, so a survivor bricks generation until a human kills it.
//
// It is a race (the same path run by hand three minutes later did kill
// its backend), so a source-shape assertion is not enough on its own:
// these drive the real functions with a kill that does not take.
const cp = require("child_process");
const realExecSync = cp.execFileSync;

// A pid that is GONE, for real: spawnSync has already reaped it by the
// time it returns, and a recycle inside these milliseconds is not a
// thing. `process.pid` is the living counterpart -- taskkill is stubbed,
// so nothing is ever actually killed here.
const DEAD_PID = cp.spawnSync(process.execPath, ["-e", ""]).pid;
const LIVE_PID = process.pid;
assert(DEAD_PID > 0 && DEAD_PID !== LIVE_PID,
  "the fixture has a really-dead pid and a really-live one");

// ------------------------------------------------- comfy.js stopManaged()
{
  const EXT = path.join(ROOT, "extension");
  const panel = function (pid) {
    const calls = [];
    const store = {};
    if (pid) store["aell-comfy-pid"] = String(pid);
    const stubCp = {
      execFileSync: function (file, args) {
        calls.push(String(file).toLowerCase() + " " + (args || []).join(" "));
        return "";
      },
      execFile: function (file, args, a, b) {
        calls.push("ASYNC " + String(file).toLowerCase());
        const done = typeof a === "function" ? a : b;
        if (done) done(null, "", "");
      },
      spawn: function () { throw new Error("not used in this test"); }
    };
    const win = {
      console: { log: function () {}, error: function () {} },
      setTimeout: setTimeout, clearTimeout: clearTimeout,
      setInterval: setInterval, clearInterval: clearInterval,
      localStorage: {
        getItem: function (k) {
          return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
        },
        setItem: function (k, v) { store[k] = String(v); },
        removeItem: function (k) { delete store[k]; }
      },
      AEBridge: {
        nodeRequire: function (m) {
          return m === "child_process" ? stubCp : require(m);
        },
        getExtensionPath: function () { return EXT; },
        evalScript: function (s, cb) { if (cb) cb("", "no AE here"); }
      }
    };
    win.window = win;
    new Function("window",
      fs.readFileSync(path.join(EXT, "js", "comfy.js"), "utf8"))(win);
    return { Comfy: win.Comfy, calls: calls, store: store };
  };

  // (a) the kill takes
  {
    const p = panel(DEAD_PID);
    const r = p.Comfy.stopManaged();
    assert(r === true, "stopManaged() confirms a kill that took", "got " + r);
    assert(p.calls.some(function (c) { return /^taskkill/.test(c); }),
      "having really run taskkill for the remembered pid");
    assert(!p.calls.some(function (c) { return /^ASYNC/.test(c); }),
      "SYNCHRONOUSLY -- an async taskkill is a race a CLI loses (17q-d)");
    assert(p.store["aell-comfy-pid"] === undefined,
      "and only then is the PID record dropped");
  }

  // (b) the kill does NOT take -- the 17q-d case itself
  {
    const p = panel(LIVE_PID);
    const r = p.Comfy.stopManaged();
    assert(r === false,
      "stopManaged() reports FALSE when the process is still alive after " +
      "the kill -- a stop that cannot confirm must say so", "got " + r);
    assert(p.store["aell-comfy-pid"] === String(LIVE_PID),
      "and KEEPS the PID record: it is the only thing that can find the " +
      "survivor, and reapOrphan() reads exactly this key at init");
  }

  // (c) nothing to stop is not a failure
  {
    const p = panel(0);
    assert(p.Comfy.stopManaged() === true,
      "with nothing remembered, stopManaged() answers true, not a failure");
  }
}

// ------------------------------------------- comfy-managed.js stop()
//
// stop() asks pidIsComfy on BOTH sides of the kill now. The stub decides
// what the second answer is, which is precisely the variable the old code
// never read.
{
  const managedLib = require(path.join(ROOT, "scripts", "lib", "comfy-managed.js"));
  const COMFY_CMDLINE = "C:\\Users\\mr\\AppData\\Roaming\\AE-Llama\\vendor\\" +
    "comfy\\ComfyUI_windows_portable\\python_embeded\\python.exe -s main.py";
  const OURS = "C:\\Users\\mr\\AppData\\Roaming\\AE-Llama\\vendor\\comfy";

  const runStop = function (stillComfyAfterKill) {
    const said = [];
    const pidQueries = [];
    const removed = [];
    let killed = 0;
    cp.execFileSync = function (file, args) {
      const f = String(file).toLowerCase();
      if (f.indexOf("powershell") !== -1) {
        const cmd = (args || []).join(" ");
        if (/Get-NetTCPConnection/i.test(cmd)) return "";   // the port fallback
        pidQueries.push(cmd);
        // Before the kill it must look alive, or stop() never kills at all.
        if (pidQueries.length === 1) return COMFY_CMDLINE;
        return stillComfyAfterKill ? COMFY_CMDLINE : "";
      }
      if (f.indexOf("taskkill") !== -1) { killed++; return ""; }
      return "";
    };
    const storage = {
      getItem: function () { return "44324"; },
      removeItem: function (k) { removed.push(k); }
    };
    const Comfy = { stopManaged: function () { killed++; } };
    const result = managedLib.stop(Comfy, storage, 8288,
      function (kind, msg) { said.push(kind + ": " + msg); }, OURS);
    return { result: result, out: said.join("\n"),
             queries: pidQueries.length, removed: removed, killed: killed };
  };

  // (a) the kill took
  {
    const r = runStop(false);
    assert(r.result === true, "stop() reports a stop it verified", "got " + r.result);
    assert(r.queries >= 2,
      "having asked whether the pid is a live ComfyUI on BOTH sides of the " +
      "kill (" + r.queries + " asks) -- asking once, before, IS 17q-d");
    assert(/stopped the managed backend \(pid 44324\)/.test(r.out),
      "in the wording the teardown verdict greps for");
    assert(!/FAILED/.test(r.out), "and says nothing about a failure");
  }

  // (b) the kill did NOT take
  {
    const r = runStop(true);
    assert(r.result === false,
      "stop() reports FALSE when the pid is STILL a live ComfyUI after the kill",
      "got " + r.result);
    assert(/FAILED to stop the managed backend \(pid 44324\)/.test(r.out),
      "with a FAILURE line, not a success line -- this is the whole of 17q-d");
    assert(!/stopped the managed backend \(pid 44324\)\./.test(r.out),
      "and never the success sentence beside it: the 06:10 log said exactly " +
      "that about a process that outlived it by 70 minutes");
    assert(r.removed.length === 0,
      "the PID record is KEPT so the survivor can still be found");
    assert(/taskkill \/PID 44324/.test(r.out),
      "and the log carries the command a human can finish the job with");
    assert(!/no managed backend found to stop/.test(r.out),
      "it does not then fall through and claim there was nothing to stop");
  }

  cp.execFileSync = realExecSync;
}

// ------------------------------------ and the verdict can READ the failure
//
// 17q-b's lesson, applied forward: a stop that reported a real problem
// must not land in the "said nothing recognisable" bucket, where it reads
// as noise at 8am.
{
  assert(managed.indexOf("FAILED to stop the managed backend (pid ") >= 0,
    "comfy-managed.js says \"FAILED to stop the managed backend (pid \"");
  assert(matchLine && new RegExp(matchLine[1])
           .test("FAILED to stop the managed backend (pid 1)"),
    "and the loop's teardown verdict recognises it");
}

// ------------------------------- no fire-and-forget kill is left anywhere
//
// The bug was ONE line and it is the kind a tidy-up pastes back in:
//
//     child_process.execFile("taskkill", [...], function () {});
//
// An empty callback on a taskkill is never right in this codebase. Both
// remaining kill sites are asserted by shape as well as by behaviour,
// because the behavioural tests above can only reach the paths that
// exist today.
{
  const comfySrc = fs.readFileSync(
    path.join(ROOT, "extension", "js", "comfy.js"), "utf8");
  const managedSrc = fs.readFileSync(
    path.join(ROOT, "scripts", "lib", "comfy-managed.js"), "utf8");

  // Nowhere: a taskkill whose callback body is empty. Comments out
  // first -- both files QUOTE the dead line in prose to explain it, the
  // same trap the [N/A] check above fell into.
  const uncommentedJs = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (const [name, src] of [["extension/js/comfy.js", comfySrc],
                             ["scripts/lib/comfy-managed.js", managedSrc]]) {
    assert(!/execFile\(\s*["']taskkill["'][\s\S]{0,120}?function \([^)]*\) \{\s*\}/
             .test(uncommentedJs(src)),
      name + " has no taskkill with an empty callback -- that one line IS 17q-d");
  }

  // stopManaged() specifically: a CLI exits milliseconds after it returns,
  // so its kill cannot be async at all.
  const sm = comfySrc.slice(comfySrc.indexOf("function stopManaged"));
  assert(/execFileSync\(\s*["']taskkill["']/.test(sm),
    "stopManaged() kills with execFileSync");
  assert(!/[^c]execFile\(/.test(sm.slice(0, sm.indexOf("global.Comfy ="))),
    "and nothing in it is asynchronous");

  // reapOrphan() may be async (it runs at init with a callback), but it
  // must still verify before it drops the record.
  const ro = comfySrc.slice(comfySrc.indexOf("function reapOrphan"),
                            comfySrc.indexOf("function isUp"));
  assert(/pidAlive\(/.test(ro),
    "reapOrphan() verifies the pid is really gone before forgetting it");
  assert(ro.indexOf("pidAlive(") < ro.lastIndexOf("forgetPid()"),
    "with the check ahead of the forget, which is the whole ordering");
}
console.log(failed ? "\n" + failed + " TEST(S) FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
