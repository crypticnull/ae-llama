/*
 * comfy-install.js — install and verify the MANAGED ComfyUI backend
 * headlessly, through the panel's own code.
 *
 * Why this exists: `Setup.bootstrapComfy` had exactly ONE caller —
 * `btn-comfy-install` in Settings (main.js). So the only way to install
 * the backend a buyer gets was for a human to open After Effects, open
 * the panel, open Settings and click. That made WORKPLAN §17c — "dogfood
 * the shipped backend on the dev machine" — impossible for an unattended
 * pass, and §17c gates every template pass in §18.
 *
 * It runs the SHIPPED code, not a copy: settings.js + setup.js + comfy.js
 * loaded into a window shim, the same pattern comfy-probe.js uses. What
 * this script owns is the sequence and the verdicts; every decision
 * (which asset, where it lands, how it boots) stays in the panel.
 *
 *   node scripts/comfy-install.js                 # install if absent, then verify
 *   node scripts/comfy-install.js --check         # report only, install nothing
 *   node scripts/comfy-install.js --boot          # also boot it and confirm it answers
 *   node scripts/comfy-install.js --stop          # stop a backend this script booted
 *   node scripts/comfy-install.js --port 8288     # override the managed port
 *
 * Exit 0 only when every verdict passed.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const EXT = path.join(REPO, "extension");

// ------------------------------------------------------------------- args

const OPT = { check: false, boot: false, stop: false, port: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--check") OPT.check = true;
  else if (a === "--boot") OPT.boot = true;
  else if (a === "--stop") OPT.stop = true;
  else if (a === "--port") OPT.port = parseInt(process.argv[++i], 10);
  else if (a === "--help" || a === "-h") {
    console.log(fs.readFileSync(__filename, "utf8")
      .split("\n").slice(1, 25).join("\n"));
    process.exit(0);
  } else {
    console.error("Unknown option: " + a);
    process.exit(2);
  }
}

let failures = 0;
function verdict(ok, label, detail) {
  console.log((ok ? "ok  - " : "FAIL- ") + label +
              (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
}
function say(kind, msg) { console.log("[" + kind + "] " + msg); }

// -------------------------------------------------------- the panel, in Node

// The panel's localStorage is CEP's and really persists, which is what
// makes Comfy.stopManaged() and reapOrphan() work across panel sessions:
// they look up the backend's PID by key. A script shim backed by a plain
// object does NOT persist — it dies with the process — so a SEPARATE
// `--stop` invocation would find no PID and silently kill nothing. Found
// the hard way 2026-09-06: the owner booted a backend, went to play a
// game, and --stop would have been a no-op.
//
// So exactly one key gets a file, and only that one. Everything else
// stays in memory on purpose: if settings lived here too, Settings.set
// would start writing them and `origin()` would report "localStorage"
// where the truth for a script is the settings.json on disk — and gate 0
// below depends on origin() telling that truth.
const PID_KEY = "aell-comfy-pid";
const storage = {};
let pidFile = null;            // set once Settings.dataRoot() is loadable

function readPid() {
  if (!pidFile) return null;
  try { return fs.readFileSync(pidFile, "utf8").trim() || null; }
  catch (e) { return null; }
}
const window = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  localStorage: {
    getItem(k) {
      if (k === PID_KEY) return readPid();
      return Object.prototype.hasOwnProperty.call(storage, k)
        ? storage[k] : null;
    },
    setItem(k, v) {
      if (k === PID_KEY) {
        if (!pidFile) return;
        try {
          fs.mkdirSync(path.dirname(pidFile), { recursive: true });
          fs.writeFileSync(pidFile, String(v));
        } catch (e) {}
        return;
      }
      storage[k] = String(v);
    },
    removeItem(k) {
      if (k === PID_KEY) {
        if (pidFile) { try { fs.unlinkSync(pidFile); } catch (e) {} }
        return;
      }
      delete storage[k];
    }
  },
  AEBridge: {
    nodeRequire: require,
    getExtensionPath() { return EXT; },
    evalScript(script, cb) { if (cb) cb("", "no AE in this script"); }
  }
};
window.window = window;

function loadPanelFile(rel) {
  const src = fs.readFileSync(path.join(EXT, "js", rel), "utf8");
  new Function("window", src)(window);
}
loadPanelFile("settings.js");
loadPanelFile("tiers.js");
loadPanelFile("comfy.js");
loadPanelFile("setup.js");

const Settings = window.Settings;
const Comfy = window.Comfy;
const Setup = window.Setup;

// Now that Settings is loaded, the PID key has somewhere durable to live
// — beside settings.json, by the panel's own dataRoot rule rather than a
// second copy of it.
try {
  pidFile = path.join(Settings.dataRoot(), "comfy-managed.pid");
} catch (e) { pidFile = null; }

// ------------------------------------------------------------- gate 0
//
// Every path below is dataRoot()-relative, and dataRoot falls through
// APPDATA -> USERPROFILE -> the extension folder. Measured 2026-09-02: an
// unattended pass in the WMI-detached loop had no APPDATA, so dataRoot()
// landed somewhere holding no settings.json, load() returned pure
// defaults, and the pass reported the DEFAULT port as the owner's
// setting. A run that cannot see the real settings must say so rather
// than install into a folder nobody will look in.

const origin = Settings.origin();
say("info", "settings: from=" + origin.from + " saved=" + origin.saved +
            " dataRoot=" + origin.dataRoot);
if (!origin.appdata) {
  console.error("\nAPPDATA is empty, so the data root is a guess and this " +
    "would install somewhere the panel may never look. Run this from a " +
    "session that has APPDATA set (see WORKPLAN §18 'gate 0').");
  process.exit(2);
}

const s = Settings.get();
const port = OPT.port || Comfy.managedPort(s);
const url = "http://127.0.0.1:" + port;

say("info", "backend mode: " + Comfy.backendMode(s) +
            "  |  managed port: " + port);
if (Comfy.backendMode(s) !== "managed") {
  say("info", "NOTE: this machine is set to 'own' — the managed backend " +
              "is being installed anyway (that is what §17c is), but the " +
              "panel will keep talking to " + (s.comfyUrl || "?") +
              " until the mode is switched in Settings.");
}

// ------------------------------------------------------------------ steps

function dirSizeMB(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try { total += fs.statSync(p).size; } catch (e2) {}
      }
    }
  }
  return Math.round(total / 1048576);
}

function reportInstall(inst) {
  verdict(!!inst, "the managed backend is installed",
          inst ? inst.root : "not found under the panel's vendor folder");
  if (!inst) return;
  // The standing disk cost of the buyer's path, which NOBODY has
  // measured — §17c asks for this number, and it decides whether the
  // dogfooding arrangement is permanent or per-test.
  const mb = dirSizeMB(inst.root);
  say("info", "extracted size: " + mb + " MB (" +
              (Math.round(mb / 1024 * 10) / 10) + " GB) at " + inst.root);
  verdict(fs.existsSync(inst.python), "it carries its own python",
          inst.python);
  verdict(fs.existsSync(inst.mainPy), "and ComfyUI's main.py", inst.mainPy);
  // The torch/python this build pins is §13a step 1's measurement, taken
  // here for free — the wheel selection keys on exactly these numbers.
  try {
    const out = require("child_process").execFileSync(inst.python,
      ["-c", "import sys, torch; print(sys.version.split()[0]); " +
             "print(torch.__version__); print(torch.version.cuda)"],
      { timeout: 120000, encoding: "utf8" }).trim().split(/\r?\n/);
    say("info", "environment: python " + out[0] + ", torch " + out[1] +
                ", built against CUDA " + out[2]);
    say("info", "  ^ that is §13a step 1 — record it in docs/measured/");
  } catch (e) {
    say("warn", "could not read the interpreter's python/torch versions: " +
                String(e.message).slice(0, 160));
  }
}

function step2Boot(inst, done) {
  if (!OPT.boot) { done(); return; }
  if (!inst) { verdict(false, "boot skipped — nothing installed"); done(); return; }
  say("info", "booting the managed backend on " + url + "…");
  Comfy.ensureRunning(url, function (m) { say("boot", m); },
    function (err, res) {
      if (err) {
        verdict(false, "the managed backend boots", err.message);
        done();
        return;
      }
      verdict(true, "the managed backend boots",
              res && res.started ? "started by this script" : "already up");
      Comfy.status(url, function (sErr, st) {
        verdict(!!(st && st.online), "and answers its own port",
                st ? st.target : String(sErr));
        done();
      });
    }, { comfyBackend: "managed", comfyManagedPort: port });
}

/*
 * Kill whatever is holding the managed port, when the PID file cannot
 * answer (deleted, a backend booted before this file existed, or a
 * machine that was rebooted). The PID-recycling guard is the same one
 * reapOrphan uses: only kill a process whose command line really is
 * ComfyUI's.
 */
function stopByPort(port) {
  const cp = require("child_process");
  let out = "";
  try {
    out = cp.execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "$p=(Get-NetTCPConnection -LocalPort " + port + " -State Listen " +
       "-ErrorAction SilentlyContinue).OwningProcess; " +
       "if ($p) { (Get-CimInstance Win32_Process -Filter " +
       "\"ProcessId=$p\").CommandLine + '|' + $p }"],
      { timeout: 30000, encoding: "utf8" }).trim();
  } catch (e) { return false; }
  if (!out) return false;
  const cut = out.lastIndexOf("|");
  const cmdline = cut === -1 ? "" : out.slice(0, cut);
  const pid = cut === -1 ? "" : out.slice(cut + 1).trim();
  if (!pid || !/ComfyUI/i.test(cmdline)) {
    say("warn", "something holds port " + port + " but its command line " +
                "is not ComfyUI — NOT killing it: " + cmdline.slice(0, 120));
    return false;
  }
  try {
    cp.execFileSync("taskkill", ["/PID", pid, "/T", "/F"],
                    { timeout: 30000 });
    say("info", "stopped the backend holding port " + port +
                " (pid " + pid + ").");
    return true;
  } catch (e) {
    say("warn", "taskkill failed for pid " + pid + ": " + e.message);
    return false;
  }
}

/* Is `pid` a LIVE ComfyUI? The same guard reapOrphan uses, and for the
 * same reason: PIDs recycle, so a remembered one that has since died —
 * a crash, a reboot, or the owner killing it by hand — names whatever
 * inherited the number. Killing that is worse than not stopping. */
function pidIsComfy(pid) {
  try {
    const out = require("child_process").execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "(Get-CimInstance Win32_Process -Filter 'ProcessId=" +
       String(parseInt(pid, 10)) + "').CommandLine"],
      { timeout: 30000, encoding: "utf8" });
    return /ComfyUI/i.test(String(out || ""));
  } catch (e) { return false; }
}

function finish() {
  if (OPT.stop) {
    // Read it the way comfy.js does — through the storage shim, not the
    // file — so this reports what stopManaged() will actually find.
    const knownPid = window.localStorage.getItem(PID_KEY);
    let stopped = false;
    try {
      if (knownPid) {
        if (pidIsComfy(knownPid)) {
          Comfy.stopManaged();
          say("info", "stopped the managed backend (pid " + knownPid + ").");
          stopped = true;
        } else {
          say("warn", "the remembered PID " + knownPid + " is not a live " +
                      "ComfyUI — already stopped, or the number was " +
                      "recycled. Clearing the record instead of killing " +
                      "whatever inherited it.");
          window.localStorage.removeItem(PID_KEY);
        }
      }
      // Either nothing was remembered, or what was remembered is gone.
      // The port is the other place a live backend can be found.
      if (!stopped && !stopByPort(port)) {
        say("info", "no managed backend found to stop (nothing " +
                    "remembered, and nothing ComfyUI-shaped on port " +
                    port + ").");
      }
    } catch (e) { say("warn", "stop failed: " + e.message); }
  } else if (OPT.boot) {
    say("info", "the backend is STILL RUNNING. Stop it with --stop, or " +
                "leave it — the panel reaps it on next launch.");
  }
  console.log(failures ? "\n" + failures + " FAILED" : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
}

// ------------------------------------------------------------------- run

const existing = Setup.findComfyInstall();

if (OPT.check) {
  reportInstall(existing);
  step2Boot(existing, finish);
} else if (existing) {
  say("info", "already installed — nothing to download.");
  reportInstall(existing);
  step2Boot(existing, finish);
} else {
  say("info", "no managed backend yet; downloading the portable build. " +
              "This is a multi-gigabyte download and extraction.");
  let lastPct = -1;
  Setup.bootstrapComfy(
    function (t) { say("setup", t); },
    function (received, total) {
      if (!total) return;
      const pct = Math.floor(received / total * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        say("dl", pct + "%  (" + Math.round(received / 1048576) + " / " +
                  Math.round(total / 1048576) + " MB)");
      }
    },
    function (err, res) {
      if (err) {
        verdict(false, "the managed backend installs", err.message);
        // The failure this is most likely to be, and the check that
        // settles it in one call — /releases/latest returns the latest
        // NON-prerelease, and 0.10.16 measured llama.cpp's answering
        // with a release carrying no Windows binaries at all.
        if (/release|asset|package/i.test(String(err.message))) {
          say("hint", "check what the release endpoint actually offers:");
          say("hint", "  curl -s https://api.github.com/repos/" +
                      "comfyanonymous/ComfyUI/releases/latest | " +
                      "findstr /i \"tag_name portable\"");
          say("hint", "if the portable .7z only appears on PRERELEASES, " +
                      "bootstrapComfy needs the release WALK that " +
                      "pickEngineRelease already does for llama.cpp " +
                      "(WORKPLAN-LOG 2026-08-30, 0.10.16).");
        }
        finish();
        return;
      }
      say("info", "installed at " + (res && res.root));
      reportInstall(Setup.findComfyInstall());
      step2Boot(Setup.findComfyInstall(), finish);
    });
}
