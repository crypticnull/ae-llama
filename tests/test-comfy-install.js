/*
 * test-comfy-install.js — the headless managed-backend installer.
 *
 * scripts/comfy-install.js exists because Setup.bootstrapComfy had ONE
 * caller: a button in Settings (main.js). So the backend a user gets
 * could only be installed by a human opening After Effects, opening the
 * panel and clicking — which made WORKPLAN §17c impossible for an
 * unattended pass, and §17c gates every template pass in §18.
 *
 * What is pinned here is the part with a silent failure mode: GATE 0.
 * Every path the installer touches is Settings.dataRoot()-relative, and
 * dataRoot falls through APPDATA -> USERPROFILE -> the extension folder.
 * Measured 2026-09-02: an unattended pass in the WMI-detached loop had
 * no APPDATA, dataRoot() landed somewhere holding no settings.json,
 * load() returned pure defaults, and the pass reported the DEFAULT port
 * as THE OWNER'S SETTING. Two later sessions repeated the claim.
 *
 * An installer that inherits that bug does not report a wrong number —
 * it downloads gigabytes into a folder nobody will ever look in, and
 * then reports success. So it must REFUSE, and refusing is what this
 * file proves.
 *
 * No network, no ComfyUI, no GPU: the run never gets past the gate, and
 * the --check path never downloads.
 */
"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "comfy-install.js");

let failures = 0;
function assert(cond, label, detail) {
  console.log((cond ? "ok  - " : "FAIL- ") + label +
              (detail ? "  (" + detail + ")" : ""));
  if (!cond) failures++;
}

function run(env, args) {
  // A clean env, so the runner's own APPDATA cannot decide the result —
  // the same lesson test-comfy-backend.js records about LOCALAPPDATA: a
  // test that cannot fail for the right reason on one machine teaches
  // everyone to skip its failures.
  const base = { PATH: process.env.PATH, HOME: process.env.HOME,
                 SystemRoot: process.env.SystemRoot || "" };
  const r = spawnSync(process.execPath, [SCRIPT].concat(args || []),
                      { env: Object.assign(base, env), encoding: "utf8",
                        timeout: 120000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// 1. No APPDATA -> refuse, loudly, before anything is downloaded.
{
  const r = run({}, ["--check"]);
  assert(r.code === 2, "with no APPDATA the installer REFUSES", "exit " + r.code);
  assert(/APPDATA is empty/.test(r.out),
         "and says why, naming the variable the data root depends on");
  assert(!/downloading|installed at/i.test(r.out),
         "nothing was downloaded or installed on the way to refusing");
}

// 2. With APPDATA set it proceeds, and --check reports without installing.
{
  const tmp = path.join(require("os").tmpdir(),
                        "aell-install-" + process.pid);
  const r = run({ APPDATA: tmp }, ["--check"]);
  assert(r.code === 1, "--check with no backend present exits non-zero",
         "exit " + r.code);
  assert(/the managed backend is installed/.test(r.out),
         "the verdict names what it looked for");
  assert(!/downloading/i.test(r.out),
         "--check never downloads — it is safe to run on any machine");
  assert(/managed port: 8288/.test(r.out),
         "and it reports the port the managed backend owns");
}

// 3. The mode is REPORTED, not assumed. A machine set to "own" still
//    installs (that IS §17c — dogfooding the user's backend beside the
//    owner's own), but the run must say the panel will keep talking to
//    the other one until the mode is switched.
{
  const tmp = path.join(require("os").tmpdir(),
                        "aell-install-own-" + process.pid);
  const fs = require("fs");
  fs.mkdirSync(path.join(tmp, "AE-Llama"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "AE-Llama", "settings.json"),
    JSON.stringify({ comfyBackend: "own",
                     comfyUrl: "http://127.0.0.1:8000" }));
  const r = run({ APPDATA: tmp }, ["--check"]);
  assert(/backend mode: own/.test(r.out),
         "it reads the real saved mode rather than the default");
  assert(/127\.0\.0\.1:8000/.test(r.out),
         "and names the instance the panel is actually talking to");
}

/* A TCP port nothing is listening on: bound, read back, released. Asking
 * the OS beats picking a number — a hardcoded one is how this file spent
 * a week killing the machine's REAL backend (WORKPLAN §17p). */
function withDeadPort(fn) {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", function () {
    const port = srv.address().port;
    srv.close(function () { fn(port); });
  });
}

withDeadPort(function (deadPort) {

// 4. The PID survives BETWEEN invocations.
//
// This is the bug this block exists for. The panel's localStorage is
// CEP's and persists, which is what makes Comfy.stopManaged() work
// across panel sessions — it looks the backend's PID up by key. The
// script's shim was a plain object, so a SEPARATE `--stop` run started
// with an empty store, found no PID, and silently killed nothing while
// reporting a stop. Found the hard way 2026-09-06: a backend was booted,
// the owner went to play a game, and --stop would have been a no-op.
//
// THE PORT IS NOT DECORATION HERE (§17p, measured 2026-09-09). After
// managed.stop() clears the stale PID it FALLS THROUGH to
// stopByPort(port) — and with no `comfyManagedPort` in these temp
// settings the port defaulted to 8288, which on the machine that runs
// this test is the live managed backend. stopByPort's command-line guard
// cannot help: the victim really is ComfyUI, so it was really killed,
// `taskkill /T /F`, which is why its log ended mid-line with no last
// words. Four unexplained backend deaths were this test passing. So the
// fixture names a port the OS has just told us nothing owns.
{
  const tmp = path.join(os.tmpdir(), "aell-install-pid-" + process.pid);
  const root = path.join(tmp, "AE-Llama");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({
    comfyBackend: "managed",
    comfyManagedPort: deadPort
  }), "utf8");
  // Exactly what a previous --boot leaves behind.
  fs.writeFileSync(path.join(root, "comfy-managed.pid"), "424242");

  const r = run({ APPDATA: tmp }, ["--check", "--stop"]);
  // The PID reaches comfy.js through the storage shim — the run reads it
  // the way stopManaged() does, so this failing means the shim is not
  // file-backed, which is the whole bug.
  assert(/424242/.test(r.out),
         "a PID written by an earlier run is READ by a later one");

  // 424242 is not a live ComfyUI here, so the run must say so and clear
  // the record — never taskkill a number that has been recycled. This is
  // the case the owner hit on 2026-09-06: they killed the backend by
  // hand, which leaves exactly this state behind.
  assert(/not a live ComfyUI/.test(r.out),
         "a remembered PID that is not a running ComfyUI is NOT killed");
  assert(!/stopped the managed backend/.test(r.out),
         "and no stop is claimed for it");
  assert(!fs.existsSync(path.join(root, "comfy-managed.pid")),
         "the stale record is cleared rather than left for the next run");

  // Now the fall-through, which had NO assertion at all. `stopped the
  // managed backend` above is a DIFFERENT string from the one stopByPort
  // prints, which is exactly how the kill hid: it was reported in full,
  // beside an assertion that could not see it. Both halves are checked
  // now — nothing was killed BY PORT, and the port it reached for is the
  // dead one this fixture chose.
  assert(!/stopped the backend holding port/.test(r.out),
         "and nothing is killed by PORT either — the hole §17p came through");
  assert(new RegExp("nothing ComfyUI-shaped on port " + deadPort).test(r.out),
         "the stop looked at the port the fixture named", "want " + deadPort);
  assert(!/8288/.test(r.out),
         "the DEFAULT managed port is never reached by a run that stops — " +
         "on the machine this test runs on, 8288 is a real backend");

  // With nothing remembered it must NOT claim a stop it did not make.
  const r2 = run({ APPDATA: tmp }, ["--check", "--stop"]);
  assert(/no managed backend found to stop/.test(r2.out),
         "with nothing remembered it says so rather than reporting success");
  assert(!/stopped the managed backend/.test(r2.out),
         "a stop is never reported without a PID behind it");
  assert(!/stopped the backend holding port/.test(r2.out),
         "nor by port on the second run");
  assert(!/8288/.test(r2.out),
         "and the second run cannot reach the default port either");
}

// 5. No test in this repo may drive a stop path on a DEFAULTED port.
//
// §17p asked whether any other test could reach stopByPort or taskkill
// with a port it never chose. Today only this file can — and a fact like
// that decays the moment someone writes the next probe test. A test that
// hands a real script `--stop` is choosing which process dies; if it
// names no port, the default chooses, and the default is a live backend.
{
  const all = fs.readdirSync(__dirname).filter(function (f) {
    return /^test-.*\.js$/.test(f);
  });
  const offenders = all.filter(function (f) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    // The port must be SET, not merely mentioned: a prose `comfyManagedPort`
    // in a comment satisfied the first draft of this guard, which is the
    // same shape of hole as the assertion §17p came through.
    return /["']--stop["']/.test(src) &&
           !/comfyManagedPort\s*[:=]|["']--port["']/.test(src);
  });
  assert(offenders.length === 0,
         "every test that drives --stop also names the port it may kill",
         offenders.length ? offenders.join(", ")
                          : all.length + " test files scanned");
}

console.log(failures ? "\n" + failures + " FAILED" : "\nALL TESTS PASSED");
process.exitCode = failures ? 1 : 0;

});
