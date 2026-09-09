/*
 * test-probe-reachability.js — a probe may not report a backend it
 * cannot reach as reachable (WORKPLAN §17n).
 *
 * Measured 2026-09-09, with nothing on the port:
 *
 *     == PASS ComfyUI reachable — queue running=0 pending=0
 *     == FAIL generation completed — ComfyUI is not running and the
 *        hidden backend is not installed.
 *
 * Two verdicts, one run, flatly contradicting each other. The cause is
 * a deliberate asymmetry in `Comfy.status`: a DOWN backend is not an
 * error there, it is `cb(null, {online:false, hint:…})`, because the
 * panel wants the hint text rather than an exception. Four probes
 * tested only `if (err)`, so the down case took the SUCCESS path and
 * printed counts that were the `|| 0` on an undefined.
 *
 * The worse half was invisible in the transcript: `--boot` lived inside
 * that same dead `if (err)` branch, so `comfy-probe.js --boot` could
 * never boot a backend that was down — the only situation it exists
 * for. A whole class of "the pass measured nothing and reported a
 * generation failure" follows from that one test.
 *
 * Three layers here, because the fix has three ways to come undone:
 *   1. `managed.reachable` itself — the one place the question is now
 *      asked. Fakes only; no ports, no ComfyUI, no GPU.
 *   2. A source guard: any script that calls `Comfy.status` directly
 *      must test `.online`. This is what catches the FIFTH probe
 *      someone writes next month by copying the fourth.
 *   3. End to end: comfy-probe.js pointed at a port nothing is on must
 *      FAIL its reachability verdict and exit non-zero. Layer 1 can be
 *      right while the probe still calls the old thing.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "scripts");
const managed = require(path.join(SCRIPTS, "lib", "comfy-managed.js"));

let failures = 0;
function assert(cond, label, detail) {
  console.log((cond ? "ok  - " : "FAIL- ") + label +
              (detail ? "  (" + detail + ")" : ""));
  if (!cond) failures++;
}

/** A Comfy whose status() answers exactly what the real one would. */
function fakeComfy(answer) {
  return {
    seen: null,
    status: function (url, cb, settings) {
      this.seen = { url: url, settings: settings };
      answer(cb);
    }
  };
}

// ---------------------------------------------------- 1. managed.reachable

// The regression itself: online:false is DOWN, however cheerfully it is
// reported.
{
  const C = fakeComfy(function (cb) {
    cb(null, { online: false, url: "http://127.0.0.1:8288",
               target: "127.0.0.1:8288",
               hint: "Hidden backend installed — it boots automatically." });
  });
  let got;
  managed.reachable(C, "http://127.0.0.1:8288", { comfyBackend: "managed" },
                    function (down, st) { got = { down: down, st: st }; });
  assert(typeof got.down === "string" && got.down,
         "online:false is reported DOWN, not as a success",
         JSON.stringify(got.down));
  assert(/boots automatically/.test(got.down || ""),
         "and the reason handed up is Comfy's own hint — the actionable half");
  assert(got.st && got.st.online === false,
         "the status object is still passed through for anything else to read");
}

// No hint (an older/leaner status answer) must still be DOWN, and must
// still say something. An empty string here would print "FAIL ... — "
// and send the reader back to guessing.
{
  const C = fakeComfy(function (cb) { cb(null, { online: false }); });
  let got;
  managed.reachable(C, "http://127.0.0.1:9999", null,
                    function (down) { got = down; });
  assert(typeof got === "string" && got.length > 0,
         "a hintless down answer is still DOWN and still explains itself",
         JSON.stringify(got));
  assert(/9999/.test(got || ""),
         "naming the URL nothing answered on");
}

// A missing status object is down too — never a silent PASS.
{
  const C = fakeComfy(function (cb) { cb(null, null); });
  let got = "unset";
  managed.reachable(C, "http://127.0.0.1:9999", null,
                    function (down) { got = down; });
  assert(typeof got === "string" && got.length > 0,
         "a null status object is DOWN, not an implicit success");
}

// A transport error keeps working the way it always did.
{
  const C = fakeComfy(function (cb) { cb(new Error("connect ECONNREFUSED")); });
  let got;
  managed.reachable(C, "http://127.0.0.1:9999", null,
                    function (down) { got = down; });
  assert(got === "connect ECONNREFUSED",
         "a real transport error is passed up unchanged", String(got));
}

// The UP case must stay up, with the counts intact — a fix that fails
// closed on everything is not a fix.
{
  const C = fakeComfy(function (cb) {
    cb(null, { online: true, running: 2, pending: 5 });
  });
  let got;
  managed.reachable(C, "http://127.0.0.1:8288", { comfyBackend: "own" },
                    function (down, st) { got = { down: down, st: st }; });
  assert(got.down === null, "an online backend is NOT down", String(got.down));
  assert(got.st.running === 2 && got.st.pending === 5,
         "and its real queue counts reach the caller");
  assert(C.seen.settings && C.seen.settings.comfyBackend === "own",
         "the caller's settings are forwarded to status(), not re-read " +
         "from a global the probes have already overridden");
}

// ------------------------------------------------- 2. no more `if (err)` only

// Every script that asks Comfy.status directly has to test `.online`.
// This is the layer that catches a new probe copied from an old one:
// comfy-install.js already did it right, and the four that did not all
// looked like each other.
{
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".js")) files.push(p);
    }
  })(SCRIPTS);

  const direct = files.filter(function (f) {
    return /Comfy\.status\s*\(/.test(fs.readFileSync(f, "utf8"));
  });
  assert(direct.length > 0,
         "the guard found scripts calling Comfy.status at all",
         direct.length + " file(s)");
  for (const f of direct) {
    const src = fs.readFileSync(f, "utf8");
    assert(/\.online/.test(src),
           path.relative(ROOT, f).replace(/\\/g, "/") +
           " calls Comfy.status and tests .online");
  }
}

// And the four probes §17n names must go through the shared helper, so
// the answer cannot drift back into four copies.
for (const name of ["comfy-probe.js", "catalog-vram-probe.js",
                    "handoff-probe.js", "oom-probe.js"]) {
  const src = fs.readFileSync(path.join(SCRIPTS, name), "utf8");
  assert(/managed\.reachable\s*\(/.test(src),
         name + " asks the shared reachability helper");
  assert(!/Comfy\.status\s*\(/.test(src),
         name + " no longer asks Comfy.status directly");
}

// -------------------------------------------------------- 3. end to end

/* A TCP port nothing is listening on: bound, read back, released. Asking
 * the OS beats picking a number, which is how a test starts passing for
 * the wrong reason on the one machine that happens to run something
 * there. (listen() is async, hence the callback — everything inside it
 * is spawnSync, so the ordering with the summary below is still plain.) */
function withDeadPort(fn) {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", function () {
    const port = srv.address().port;
    srv.close(function () { fn(port); });
  });
}

withDeadPort(function (port) {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "aell-reach-"));
  const dir = path.join(appdata, "AE-Llama");
  fs.mkdirSync(dir, { recursive: true });
  // "own" mode on purpose: in "managed" mode the probe resolves to the
  // managed port, which on the machine this test also runs on may
  // genuinely be UP — and a test whose verdict depends on that is worse
  // than no test.
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    comfyBackend: "own",
    comfyUrl: "http://127.0.0.1:" + port
  }), "utf8");

  const r = spawnSync(process.execPath,
    [path.join(SCRIPTS, "comfy-probe.js"), "--no-ae"],
    { env: Object.assign({}, process.env, { APPDATA: appdata }),
      encoding: "utf8", timeout: 180000 });
  const out = (r.stdout || "") + (r.stderr || "");

  assert(/FAIL ComfyUI reachable/.test(out),
         "with nothing on the port the reachability verdict FAILS");
  assert(!/PASS ComfyUI reachable/.test(out),
         "and does not ALSO pass — the two contradictory verdicts of §17n");
  assert(!/running=0 pending=0/.test(out),
         "no queue counts are printed from a backend that never answered");
  assert(r.status === 1, "the probe exits non-zero", "exit " + r.status);
  assert(!/generation completed/.test(out),
         "it stops at the reachability failure instead of failing later " +
         "with a message about something else");

  try { fs.rmSync(appdata, { recursive: true, force: true }); } catch (e) {}

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
});
