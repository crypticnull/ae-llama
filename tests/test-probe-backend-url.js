/*
 * test-probe-backend-url.js — a script must talk to the backend the
 * SETTINGS select, and `--url` must actually move it
 * (WORKPLAN §17m + §17h + §17o).
 *
 * Measured 2026-09-09:
 *
 *     node scripts/comfy-probe.js --no-ae --url http://127.0.0.1:8299
 *     -- ComfyUI at http://127.0.0.1:8288  (backend: managed)
 *
 * The flag was accepted, printed nothing, and the probe measured
 * somewhere else. Every probe did `OVERRIDE.comfyUrl = OPT.url` and then
 * resolved with `Comfy.backendUrl(S)`, which in MANAGED mode returns the
 * managed port and never consults `comfyUrl` at all. The same asymmetry
 * ran the other way in `weight-availability-probe.js` (§17h), which read
 * `comfyUrl` with no override at all and reported ECONNREFUSED against
 * the "own" port as a WEIGHT failure, and in `handoff-probe.js` /
 * `oom-probe.js` (§17o), whose whole purpose is to watch ONE backend take
 * the card.
 *
 * Both halves are one rule: `comfyUrl` is the "use my own ComfyUI"
 * SETTING, `Comfy.backendUrl(s)` is the backend, and an explicit `--url`
 * names an INSTANCE — so it has to set the mode as well as the address.
 * `managed.urlOverride()` is that patch, in one place.
 *
 * Three layers, because the fix has three ways to come undone:
 *   1. `managed.urlOverride` against the REAL `Comfy.backendUrl`, in both
 *      modes. A patch that only looks right is the bug it replaces.
 *   2. A source guard: no script may read `.comfyUrl` as a target, and
 *      the probes must resolve through `Comfy.backendUrl`. This is what
 *      catches the next probe written by copying an old one.
 *   3. End to end: comfy-probe in MANAGED mode with `--url` must name the
 *      URL it was given, and must not name the managed port. Layer 1 can
 *      be right while the probe still wires the flag to the dead field.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");
const { listFiles, ignoredAmong } = require("./lib/git-files");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const SCRIPTS = path.join(ROOT, "scripts");
const managed = require(path.join(SCRIPTS, "lib", "comfy-managed.js"));

let failures = 0;
function assert(cond, label, detail) {
  console.log((cond ? "ok  - " : "FAIL- ") + label +
              (detail ? "  (" + detail + ")" : ""));
  if (!cond) failures++;
}

// ------------------------------------- 1. the patch, against the real Comfy

/* The panel's own resolver, loaded the way the probes load it. A fake
 * `backendUrl` here would test the test: the claim is about what
 * comfy.js really does with these two fields. */
function loadComfy() {
  const win = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    AEBridge: { nodeRequire: require, getExtensionPath() { return EXT; },
                evalScript(s, cb) { if (cb) cb("", true); } }
  };
  win.window = win;
  const src = fs.readFileSync(path.join(EXT, "js", "comfy.js"), "utf8");
  new Function("window", src)(win);
  return win.Comfy;
}
const Comfy = loadComfy();

{
  const MANAGED = { comfyBackend: "managed", comfyManagedPort: 8288,
                    comfyUrl: "http://127.0.0.1:8188" };
  assert(Comfy.backendUrl(MANAGED) === "http://127.0.0.1:8288",
         "the premise: in managed mode comfyUrl is not the backend",
         Comfy.backendUrl(MANAGED));

  // The regression itself. Setting comfyUrl alone is what four probes did.
  const naive = Object.assign({}, MANAGED, { comfyUrl: "http://127.0.0.1:8299" });
  assert(Comfy.backendUrl(naive) === "http://127.0.0.1:8288",
         "setting comfyUrl ALONE leaves the target untouched — the defect",
         Comfy.backendUrl(naive));

  const fixed = Object.assign({}, MANAGED,
                              managed.urlOverride("http://127.0.0.1:8299"));
  assert(Comfy.backendUrl(fixed) === "http://127.0.0.1:8299",
         "urlOverride moves the RESOLVED target in managed mode",
         Comfy.backendUrl(fixed));
  assert(Comfy.backendMode(fixed) === "own",
         "because an explicit URL names an instance, which is 'own' mode");

  const OWN = { comfyBackend: "own", comfyUrl: "http://127.0.0.1:8188" };
  const fixedOwn = Object.assign({}, OWN,
                                 managed.urlOverride("http://10.0.0.4:8188"));
  assert(Comfy.backendUrl(fixedOwn) === "http://10.0.0.4:8188",
         "and it still overrides in own mode, where it always worked");

  // Both fields or neither: half a patch points "own" mode at whatever
  // comfyUrl happened to hold.
  const patch = managed.urlOverride("http://127.0.0.1:9");
  assert(patch.comfyUrl === "http://127.0.0.1:9" &&
         patch.comfyBackend === "own",
         "the patch carries BOTH fields", JSON.stringify(patch));
  assert(Object.keys(patch).length === 2,
         "and nothing else — it is an address, not a settings rewrite");
}

// -------------------------------------------- 2. source guard: no raw reads

/* `.comfyUrl` read out of a settings object is the wrong question in
 * managed mode. Files may still print the SETTING — that is what it is —
 * so the exceptions are enumerated here with their reason rather than
 * pattern-matched, which is how a new probe copied from an old one lands
 * in this list and has to justify itself. */
const RAW_READ_OK = {
  "scripts/chat-probe.js":
    "gate 0 prints the raw setting AND the resolved backend next to it",
  "scripts/comfy-install.js":
    "a message about the own-mode setting itself, not a request target",
  "scripts/lib/comfy-managed.js":
    "the helper that writes the field"
};

// What git would commit, not a readdirSync walk: `scripts/web/` holds
// gitignored .js a node pack writes on import (tests/lib/git-files.js).
const scriptFiles = listFiles(ROOT, { under: "scripts", exts: [".js"] });
{
  const ignored = scriptFiles.fromGit ? ignoredAmong(ROOT, scriptFiles) : [];
  assert(ignored.length === 0, "the guard reads no gitignored script",
         ignored[0]);
}

for (const f of scriptFiles) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  const bad = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(function (ln) {
    const code = ln.replace(/^\s*(\/\/|\*|\/\*).*$/, "");   // drop comments
    return /\.comfyUrl\b/.test(code);
  });
  if (!bad.length) continue;
  const why = RAW_READ_OK[rel];
  assert(!!why,
         rel + " reads .comfyUrl: " + (why || "NOT an enumerated exception " +
           "— resolve with Comfy.backendUrl, or justify it in RAW_READ_OK"),
         bad[0].trim().slice(0, 80));
}
assert(scriptFiles.length > 20, "the guard walked the scripts directory",
       scriptFiles.length + " file(s)");

/* Every script that talks to a ComfyUI must ASK which one. The list is
 * explicit: a probe silently dropping the resolution would otherwise
 * pass by no longer matching. */
for (const name of ["comfy-probe.js", "catalog-vram-probe.js",
                    "handoff-probe.js", "oom-probe.js",
                    "weight-availability-probe.js", "output-size-probe.js"]) {
  const src = fs.readFileSync(path.join(SCRIPTS, name), "utf8");
  assert(/Comfy\.backendUrl\s*\(/.test(src),
         name + " resolves its target with Comfy.backendUrl");
}

/* And a probe that offers --url must wire it through the shared patch. */
for (const name of ["comfy-probe.js", "catalog-vram-probe.js",
                    "weight-availability-probe.js", "output-size-probe.js"]) {
  const src = fs.readFileSync(path.join(SCRIPTS, name), "utf8");
  assert(/argValue\("--url"|OPT\.url/.test(src),
         name + " has a --url flag to wire");
  assert(/managed\.urlOverride\s*\(/.test(src),
         name + " wires --url through managed.urlOverride");
  assert(!/OVERRIDE\.comfyUrl\s*=/.test(src),
         name + " no longer assigns the field backendUrl ignores");
}

// ------------------------------------------------------------ 3. end to end

/* Two ports nothing is listening on: bound, read back, released. Asking
 * the OS beats picking numbers, which is how a test starts passing for
 * the wrong reason on the one machine running something there. */
function withDeadPorts(n, fn) {
  const ports = [];
  (function next() {
    if (ports.length === n) { fn(ports); return; }
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", function () {
      const p = srv.address().port;
      srv.close(function () { ports.push(p); next(); });
    });
  })();
}

withDeadPorts(2, function (ports) {
  const managedPort = ports[0];
  const askedPort = ports[1];
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "aell-url-"));
  const dir = path.join(appdata, "AE-Llama");
  fs.mkdirSync(dir, { recursive: true });
  // MANAGED mode on purpose: that is the mode in which --url was ignored,
  // and a managed port nothing is on keeps the run short and the verdict
  // independent of what this machine happens to be running.
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    comfyBackend: "managed",
    comfyManagedPort: managedPort,
    comfyUrl: "http://127.0.0.1:8188"
  }), "utf8");

  const r = spawnSync(process.execPath,
    [path.join(SCRIPTS, "comfy-probe.js"), "--no-ae",
     "--url", "http://127.0.0.1:" + askedPort],
    { env: Object.assign({}, process.env, { APPDATA: appdata }),
      encoding: "utf8", timeout: 180000 });
  const out = (r.stdout || "") + (r.stderr || "");

  assert(out.indexOf("127.0.0.1:" + askedPort) !== -1,
         "the probe names the URL --url gave it",
         "asked " + askedPort);
  assert(out.indexOf("127.0.0.1:" + managedPort) === -1,
         "and never the managed port it was told to leave — §17m exactly",
         "managed " + managedPort);
  assert(/FAIL ComfyUI reachable/.test(out),
         "it fails at reachability against the dead port it was pointed at");
  assert(r.status === 1, "and exits non-zero", "exit " + r.status);

  try { fs.rmSync(appdata, { recursive: true, force: true }); } catch (e) {}

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
});
