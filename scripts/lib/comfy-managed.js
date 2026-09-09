/*
 * comfy-managed.js — booting and stopping the MANAGED ComfyUI backend
 * from a script, shared by every script that needs to.
 *
 * Three scripts want this (comfy-install, comfy-probe,
 * catalog-vram-probe) and three copies of "boot it, stop what you
 * booted, never kill a recycled PID" is how the copies drift apart. The
 * hard-won parts live here once:
 *
 *   1. The PID has to SURVIVE the process. The panel's localStorage is
 *      CEP's and persists, which is what makes Comfy.stopManaged() work
 *      across panel sessions. A script shim backed by a plain object
 *      does not, so a separate `--stop` run finds no PID and silently
 *      kills nothing while reporting a stop. Found 2026-09-06: a backend
 *      was booted, the owner went to play a game, and --stop was a no-op.
 *
 *   2. A remembered PID can outlive the process it named — a crash, a
 *      reboot, or the owner killing it by hand. PIDs RECYCLE, so it must
 *      be verified as a live ComfyUI before anything is killed. reapOrphan
 *      guards this inside the panel; scripts have to as well.
 *
 *   3. Only ONE key gets a file. If settings lived there too,
 *      Settings.set would start writing them and origin() would report
 *      "localStorage" where the truth for a script is the settings.json
 *      on disk — and every local pass's gate 0 depends on origin()
 *      telling that truth.
 *
 * Windows-only in effect: the PID verification and the port lookup shell
 * to PowerShell. On anything else they answer "not ours", which makes
 * every stop path take the SAFE branch (clear the record, kill nothing).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const PID_KEY = "aell-comfy-pid";

/**
 * A localStorage shim where exactly the backend PID is file-backed.
 * `pidFileFor` is called lazily, because the path comes from
 * Settings.dataRoot() and Settings is not loaded when the shim is built.
 */
function makeStorage(pidFileFor) {
  const mem = {};
  function pidFile() {
    try { return pidFileFor(); } catch (e) { return null; }
  }
  return {
    PID_KEY: PID_KEY,
    readPid: function () {
      const f = pidFile();
      if (!f) return null;
      try { return fs.readFileSync(f, "utf8").trim() || null; }
      catch (e) { return null; }
    },
    getItem: function (k) {
      if (k === PID_KEY) return this.readPid();
      return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
    },
    setItem: function (k, v) {
      if (k === PID_KEY) {
        const f = pidFile();
        if (!f) return;
        try {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, String(v));
        } catch (e) {}
        return;
      }
      mem[k] = String(v);
    },
    removeItem: function (k) {
      if (k === PID_KEY) {
        const f = pidFile();
        if (f) { try { fs.unlinkSync(f); } catch (e) {} }
        return;
      }
      delete mem[k];
    }
  };
}

/** Is `pid` a LIVE ComfyUI? PIDs recycle; see the header. */
function pidIsComfy(pid) {
  const n = parseInt(pid, 10);
  if (!(n > 0)) return false;
  try {
    const out = cp.execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + n +
       "').CommandLine"],
      { timeout: 30000, encoding: "utf8" });
    return /ComfyUI/i.test(String(out || ""));
  } catch (e) { return false; }
}

/**
 * Kill whatever holds `port`, when the PID record cannot answer. Same
 * command-line guard: a process that is not ComfyUI is reported and left
 * alone, never killed for being in the way.
 */
function stopByPort(port, say) {
  let out = "";
  try {
    out = cp.execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "$p=(Get-NetTCPConnection -LocalPort " + parseInt(port, 10) +
       " -State Listen -ErrorAction SilentlyContinue).OwningProcess; " +
       "if ($p) { (Get-CimInstance Win32_Process -Filter " +
       "\"ProcessId=$p\").CommandLine + '|' + $p }"],
      { timeout: 30000, encoding: "utf8" }).trim();
  } catch (e) { return false; }
  if (!out) return false;
  const cut = out.lastIndexOf("|");
  const cmdline = cut === -1 ? "" : out.slice(0, cut);
  const pid = cut === -1 ? "" : out.slice(cut + 1).trim();
  if (!pid || !/ComfyUI/i.test(cmdline)) {
    if (say) {
      say("warn", "something holds port " + port + " but its command " +
                  "line is not ComfyUI — NOT killing it: " +
                  cmdline.slice(0, 120));
    }
    return false;
  }
  try {
    cp.execFileSync("taskkill", ["/PID", pid, "/T", "/F"],
                    { timeout: 30000 });
    if (say) {
      say("info", "stopped the backend holding port " + port +
                  " (pid " + pid + ").");
    }
    return true;
  } catch (e) {
    if (say) say("warn", "taskkill failed for pid " + pid + ": " + e.message);
    return false;
  }
}

/**
 * Stop a managed backend. Returns true only when something was really
 * killed — a stop is never REPORTED without a process behind it, which
 * is the whole point of the PID verification.
 */
function stop(Comfy, storage, port, say) {
  const known = storage.getItem(PID_KEY);
  if (known) {
    if (pidIsComfy(known)) {
      try { Comfy.stopManaged(); } catch (e) {}
      if (say) say("info", "stopped the managed backend (pid " + known + ").");
      return true;
    }
    if (say) {
      say("warn", "the remembered PID " + known + " is not a live ComfyUI " +
                  "— already stopped, or the number was recycled. " +
                  "Clearing the record instead of killing whatever " +
                  "inherited it.");
    }
    storage.removeItem(PID_KEY);
  }
  if (stopByPort(port, say)) return true;
  if (say) {
    say("info", "no managed backend found to stop (nothing remembered, " +
                "and nothing ComfyUI-shaped on port " + port + ").");
  }
  return false;
}

/**
 * Bring the managed backend up on `url`, if it is not already answering.
 * cb(err, {started}). The caller decides whether a failure is fatal —
 * a probe that cannot boot should say so and stop, not carry on against
 * nothing.
 */
function boot(Comfy, url, settings, say, cb) {
  // A script's backend must outlive the script. Without this the child
  // dies inside the Windows job object the moment node exits, so
  // `--boot` reported a running backend that was already gone and the
  // file-backed PID above named a corpse (measured 2026-09-09; the PID
  // half of this was fixed 2026-09-06). The panel does NOT set it: there
  // `unload` stops the backend so closing AE frees its VRAM.
  try { Comfy.setManagedDetached(true); } catch (e) {}
  Comfy.ensureRunning(url, function (m) { if (say) say("boot", m); },
    function (err, res) { cb(err, res); }, settings);
}

module.exports = {
  PID_KEY: PID_KEY,
  makeStorage: makeStorage,
  pidIsComfy: pidIsComfy,
  stopByPort: stopByPort,
  stop: stop,
  boot: boot
};
