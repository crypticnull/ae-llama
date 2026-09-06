/*
 * test-comfy-install.js — the headless managed-backend installer.
 *
 * scripts/comfy-install.js exists because Setup.bootstrapComfy had ONE
 * caller: a button in Settings (main.js). So the backend a buyer gets
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
//    installs (that IS §17c — dogfooding the buyer's backend beside the
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

// 4. The PID survives BETWEEN invocations.
//
// This is the bug this block exists for. The panel's localStorage is
// CEP's and persists, which is what makes Comfy.stopManaged() work
// across panel sessions — it looks the backend's PID up by key. The
// script's shim was a plain object, so a SEPARATE `--stop` run started
// with an empty store, found no PID, and silently killed nothing while
// reporting a stop. Found the hard way 2026-09-06: a backend was booted,
// the owner went to play a game, and --stop would have been a no-op.
{
  const fs = require("fs");
  const os = require("os");
  const tmp = path.join(os.tmpdir(), "aell-install-pid-" + process.pid);
  const root = path.join(tmp, "AE-Llama");
  fs.mkdirSync(root, { recursive: true });
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

  // With nothing remembered it must NOT claim a stop it did not make.
  const r2 = run({ APPDATA: tmp }, ["--check", "--stop"]);
  assert(/no managed backend found to stop/.test(r2.out),
         "with nothing remembered it says so rather than reporting success");
  assert(!/stopped the managed backend/.test(r2.out),
         "a stop is never reported without a PID behind it");
}

console.log(failures ? "\n" + failures + " FAILED" : "\nALL TESTS PASSED");
process.exitCode = failures ? 1 : 0;
