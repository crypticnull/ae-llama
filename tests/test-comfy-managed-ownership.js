// Regression test: `--stop` may only kill a ComfyUI the panel BOOTED.
//
// WORKPLAN 17q-c. `comfy-managed.js` stop() tries the remembered PID and
// falls back to stopByPort: whatever listens on the configured port gets
// `taskkill /T /F` if its command line matches /ComfyUI/i. That fallback
// covers a real failure -- the PID record not surviving (2026-09-06) --
// and while it lived only inside the overnight loop the thing on the port
// was nearly always the loop's own backend, so killing by SHAPE was a
// theoretical risk.
//
// 17q-b ended that. `stop-local-agent.ps1` calls the shared teardown,
// which calls `--stop`, and that is a command the OWNER types, during the
// day, about a port that is HIS setting (8288 by default). A motion
// designer with his own ComfyUI on 8288 would lose it to a command whose
// stated job is stopping the agent -- and the message would read like a
// success.
//
// The fix is ownership, not shape: the port holder has to run out of
// `<dataRoot>/vendor/comfy`. Two things can rot that check silently and
// both are asserted here:
//
//   a. The install could move out of vendor/comfy, leaving a guard that
//      matches nothing -- which would refuse to stop OUR backend, the
//      27 GB morning of 17q all over again. So the root this file trusts
//      is checked against what setup.js really does, on a real temp tree.
//   b. A refusal could be SILENT. "Nothing was stopped" and "something is
//      there and I would not touch it" need different actions from the
//      person reading the log at 8am, so a refusal must be a sentence,
//      and must not be followed by stop()'s "nothing ComfyUI-shaped on
//      port N", which contradicts it three lines later.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let failed = 0;
function assert(cond, msg, extra) {
  if (!cond) { console.error("FAIL:", msg, extra === undefined ? "" : extra); failed++; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------------------ the stub
//
// comfy-managed.js captures `require("child_process")` at module scope
// and calls `cp.execFileSync(...)` at call time, so patching the cached
// module's property reaches it. Every call is recorded: the assertion
// that matters most in this file is a taskkill that must NOT happen, and
// that can only be checked by watching the calls.
const cp = require("child_process");
const realExec = cp.execFileSync;
const calls = [];
let portHolder = "";          // what PowerShell reports for the port query
cp.execFileSync = function (file, args) {
  calls.push({ file: file, args: args });
  if (String(file).toLowerCase().indexOf("powershell") !== -1) return portHolder;
  if (String(file).toLowerCase().indexOf("taskkill") !== -1) return "";
  return "";
};

const managed = require(path.join(ROOT, "scripts", "lib", "comfy-managed.js"));

function run(fn) {
  calls.length = 0;
  const said = [];
  const r = fn(function (kind, msg) { said.push(kind + ": " + msg); });
  return {
    result: r,
    out: said.join("\n"),
    killed: calls.some(function (c) {
      return String(c.file).toLowerCase().indexOf("taskkill") !== -1;
    })
  };
}

const OURS = "C:\\Users\\mr\\AppData\\Roaming\\AE-Llama\\vendor\\comfy";

// ------------------------------------- 1. the owner's own ComfyUI lives
//
// The exact shape of the exposure: ComfyUI-shaped, on our port, not ours.
{
  portHolder = "D:\\tools\\ComfyUI\\python\\python.exe " +
               "D:\\tools\\ComfyUI\\main.py --port 8288|4242";
  const r = run(function (say) { return managed.stopByPort(8288, say, OURS); });
  assert(r.result === "foreign", "a ComfyUI that is not ours is refused",
         "got " + r.result);
  assert(!r.killed, "and NOTHING is killed -- the 17q-c exposure itself");
  assert(/NOT killing it/.test(r.out), "the refusal is a SENTENCE, not silence");
  assert(/8288/.test(r.out) && /4242/.test(r.out),
         "and it names the port and the pid it looked at");
  assert(r.out.indexOf(OURS) !== -1,
         "and says where it expected the managed backend to be");
}

// ---------------------------------------- 2. ours is still stopped
//
// The guard must not be so tight that it refuses the backend the loop
// booted: that is the 27 GB morning of 17q, reintroduced by the fix for
// 17q-c. Forward slashes and a different case on purpose -- Windows
// hands back either, and a path compare that is not blind to both is a
// guard that matches nothing.
{
  portHolder = "c:/users/mr/appdata/roaming/AE-Llama/Vendor/Comfy/" +
               "ComfyUI_windows_portable/python_embeded/python.exe -s " +
               "main.py --port 8288|777";
  const r = run(function (say) { return managed.stopByPort(8288, say, OURS); });
  assert(r.result === "killed", "the MANAGED backend is still stopped",
         "got " + r.result);
  assert(r.killed, "and taskkill really ran for it");
  assert(/stopped the backend holding port 8288/.test(r.out),
         "in the wording the loop's teardown verdict greps for");
}

// ------------------------------- 3. an unknown root proves nothing
//
// Null means "cannot tell", and cannot-tell must never mean "go ahead".
{
  portHolder = "c:/users/mr/appdata/roaming/AE-Llama/vendor/comfy/x/" +
               "python.exe main.py|777";
  const r = run(function (say) { return managed.stopByPort(8288, say, null); });
  assert(r.result === "foreign", "with no known root the fallback declines",
         "got " + r.result);
  assert(!r.killed, "and kills nothing on a root it could not work out");
  assert(/NOT killing it/.test(r.out), "saying so");
}

// ------------------------------- 4. the old shape guard still holds
{
  portHolder = "C:\\Windows\\System32\\svchost.exe -k netsvcs|900";
  const r = run(function (say) { return managed.stopByPort(8288, say, OURS); });
  assert(r.result === "foreign" && !r.killed,
         "a non-ComfyUI port holder is still left alone");
  assert(/not ComfyUI/.test(r.out), "with the original wording");
}

// ------------------------------- 5. an empty port is "none", not "foreign"
{
  portHolder = "";
  const r = run(function (say) { return managed.stopByPort(8288, say, OURS); });
  assert(r.result === "none", "an unlistened port answers none", "got " + r.result);
  assert(!r.killed, "and kills nothing");
}

// ------------------------- 6. stop() must not contradict its own refusal
//
// The bug this prevents is a log that says both "a ComfyUI holds port
// 8288 and it is not ours" and "nothing ComfyUI-shaped on port 8288".
// Whoever reads that at 8am cannot act on it.
{
  const storage = { getItem: function () { return null; },
                    removeItem: function () {} };
  portHolder = "D:\\tools\\ComfyUI\\python.exe main.py|4242";
  const r = run(function (say) {
    return managed.stop({}, storage, 8288, say, OURS);
  });
  assert(r.result === false, "stop() reports no stop when it refused one");
  assert(!r.killed, "and killed nothing");
  assert(/NOT killing it/.test(r.out), "the refusal is in the log");
  assert(!/nothing ComfyUI-shaped on port/.test(r.out),
         "and stop() does NOT then claim the port was empty");
}

// ------------------------- 6b. and still says its piece when it IS empty
{
  const storage = { getItem: function () { return null; },
                    removeItem: function () {} };
  portHolder = "";
  const r = run(function (say) {
    return managed.stop({}, storage, 8288, say, OURS);
  });
  assert(/no managed backend found to stop/.test(r.out),
         "an empty port still gets the wording the teardown greps for");
}

cp.execFileSync = realExec;

// ------------------- 7. managedRoot() is where setup.js really installs
//
// (a) above: a guard aimed at the wrong folder matches nothing, and a
// check that matches nothing is silent. Rather than compare two spellings
// of a path, build a portable install in a temp dataRoot and ask the
// SHIPPED setup.js to find it -- if findComfyInstall answers from
// somewhere managedRoot() does not cover, the guard is already broken.
{
  const tmp = path.join(os.tmpdir(), "aell-own-" + process.pid);
  const data = path.join(tmp, "AE-Llama");
  const inst = path.join(data, "vendor", "comfy", "ComfyUI_windows_portable");
  fs.mkdirSync(path.join(inst, "ComfyUI"), { recursive: true });
  fs.mkdirSync(path.join(inst, "python_embeded"), { recursive: true });
  fs.writeFileSync(path.join(inst, "ComfyUI", "main.py"), "");
  fs.writeFileSync(path.join(inst, "python_embeded", "python.exe"), "");

  const EXT = path.join(ROOT, "extension");
  const win = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    localStorage: { getItem: function () { return null; },
                    setItem: function () {}, removeItem: function () {} },
    AEBridge: {
      nodeRequire: require,
      getExtensionPath: function () { return EXT; },
      evalScript: function (s, cb) { if (cb) cb("", "no AE here"); }
    }
  };
  win.window = win;
  const had = process.env.APPDATA;
  process.env.APPDATA = tmp;
  for (const f of ["settings.js", "tiers.js", "comfy.js", "setup.js"]) {
    new Function("window", fs.readFileSync(path.join(EXT, "js", f), "utf8"))(win);
  }
  const root = managed.managedRoot(win.Settings);
  const found = win.Setup.findComfyInstall();
  if (had === undefined) delete process.env.APPDATA; else process.env.APPDATA = had;

  assert(root, "managedRoot() answers for a normal data root", root);
  assert(found, "setup.js finds a portable install under vendor/comfy");
  if (root && found) {
    assert(managed.commandLineIsUnder(found.python, root),
           "and the python setup.js would SPAWN sits under that root",
           found.python + " vs " + root);
    assert(managed.commandLineIsUnder(found.mainPy, root),
           "as does the main.py it passes -- so a real command line matches");
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

// -------- 8. no caller may reach the port fallback without a root
//
// The signature makes omitting `ownRoot` safe (it refuses), but safe is
// not the same as intended: a stop path that silently stopped working
// would be found by the owner, on the card, in the morning. Every
// managed.stop() in scripts/ passes one.
{
  const dir = path.join(ROOT, "scripts");
  const files = fs.readdirSync(dir).filter(function (f) { return /\.js$/.test(f); });
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // Non-greedy to the statement's `);` -- an argument list of its own
    // can hold a `)` (`Comfy.managedPort(S)`), so `[^)]*` would cut the
    // call in half and report every caller as broken.
    const re = /managed\.stop\(([\s\S]{0,300}?)\);/g;
    let m;
    while ((m = re.exec(src))) {
      if (!/managedRoot\(/.test(m[1])) bad.push(f + ": managed.stop(" + m[1] + ")");
    }
  }
  assert(bad.length === 0,
         "every managed.stop() in scripts/ passes managedRoot(Settings)",
         bad.join("; "));
}

// ------------- 9. the loop's teardown verdict can READ a refusal
//
// 17q-b's own lesson: a stop that WORKED read as "said nothing
// recognisable" because the verdict's regex had never been taught the
// wording. A refusal is rarer and more surprising, so it must not land in
// the same blind spot.
{
  const lib = fs.readFileSync(
    path.join(ROOT, "scripts", "lib", "comfy-teardown.ps1"), "utf8");
  assert(/NOT killing it/.test(lib),
         "comfy-teardown.ps1's verdict recognises a refusal to kill");
}

console.log(failed ? "\n" + failed + " TEST(S) FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
