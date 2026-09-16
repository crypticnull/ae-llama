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
 * Where a MANAGED backend lives on disk: `<dataRoot>/vendor/comfy`, the
 * folder setup.js's own `comfyVendorDir()` installs into. Returns null
 * when it cannot be worked out, and every caller treats null as "cannot
 * prove ownership" rather than "no restriction".
 *
 * It is spelled here rather than at three call sites because all three
 * stop paths need it, and a second spelling is how the copies drift.
 * `tests/test-comfy-managed-ownership.js` ties it to what setup.js
 * actually does, so a move of the install folder cannot leave this
 * matching nothing — a check that silently matches nothing is precisely
 * the failure 17q was.
 */
function managedRoot(Settings) {
  try {
    const root = Settings && Settings.dataRoot ? Settings.dataRoot() : null;
    if (!root) return null;
    return path.join(String(root), "vendor", "comfy");
  } catch (e) { return null; }
}

/** Does `cmdline` run out of `root`? Windows paths: case- and slash-blind. */
function commandLineIsUnder(cmdline, root) {
  if (!root) return false;
  function norm(v) {
    return String(v || "").replace(/\//g, "\\").toLowerCase();
  }
  return norm(cmdline).indexOf(norm(root)) !== -1;
}

/**
 * Kill whatever holds `port`, when the PID record cannot answer.
 *
 * Returns a STRING, because the caller's wording depends on which of
 * these happened and a boolean collapsed three of them into "false":
 *
 *   "killed"  - it was ours and it is gone
 *   "none"    - nothing is listening on that port
 *   "foreign" - something IS, and it is not the managed backend
 *   "failed"  - it was ours and taskkill did not take
 *
 * TWO guards, not one (WORKPLAN 17q-c). The command-line shape
 * (/ComfyUI/i) was the only one until 2026-09-16, and shape is not
 * ownership: the owner's OWN ComfyUI on the configured port is
 * ComfyUI-shaped too. That was theoretical while this path lived inside
 * the overnight loop, where the thing on the port is nearly always the
 * loop's own backend. 17q-b ended that — `stop-local-agent.ps1` now
 * reaches this code, and it is a command the OWNER types, during the day,
 * about a port that is HIS setting. So the port holder must also run out
 * of `ownRoot`; anything else is reported and left alone.
 *
 * A refusal is always a SENTENCE. Silence here reads exactly like "there
 * was nothing to stop", and the two need different actions from whoever
 * is reading the log.
 */
function stopByPort(port, say, ownRoot) {
  let out = "";
  try {
    out = cp.execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "$p=(Get-NetTCPConnection -LocalPort " + parseInt(port, 10) +
       " -State Listen -ErrorAction SilentlyContinue).OwningProcess; " +
       "if ($p) { (Get-CimInstance Win32_Process -Filter " +
       "\"ProcessId=$p\").CommandLine + '|' + $p }"],
      { timeout: 30000, encoding: "utf8" }).trim();
  } catch (e) { return "none"; }
  if (!out) return "none";
  const cut = out.lastIndexOf("|");
  const cmdline = cut === -1 ? "" : out.slice(0, cut);
  const pid = cut === -1 ? "" : out.slice(cut + 1).trim();
  if (!pid || !/ComfyUI/i.test(cmdline)) {
    if (say) {
      say("warn", "something holds port " + port + " but its command " +
                  "line is not ComfyUI — NOT killing it: " +
                  cmdline.slice(0, 120));
    }
    return "foreign";
  }
  if (!ownRoot) {
    if (say) {
      say("warn", "a ComfyUI holds port " + port + " (pid " + pid + ") but " +
                  "this run cannot work out where the managed backend is " +
                  "installed, so it cannot tell whether that is ours — " +
                  "NOT killing it.");
    }
    return "foreign";
  }
  if (!commandLineIsUnder(cmdline, ownRoot)) {
    if (say) {
      say("warn", "a ComfyUI holds port " + port + " (pid " + pid + ") and " +
                  "it is NOT ours — it does not run from the managed " +
                  "backend at " + ownRoot + " — NOT killing it: " +
                  cmdline.slice(0, 120));
    }
    return "foreign";
  }
  try {
    cp.execFileSync("taskkill", ["/PID", pid, "/T", "/F"],
                    { timeout: 30000 });
    if (say) {
      say("info", "stopped the backend holding port " + port +
                  " (pid " + pid + ").");
    }
    return "killed";
  } catch (e) {
    if (say) say("warn", "taskkill failed for pid " + pid + ": " + e.message);
    return "failed";
  }
}

/**
 * Stop a managed backend. Returns true only when something was really
 * killed — a stop is never REPORTED without a process behind it, which
 * is the whole point of the PID verification.
 *
 * `ownRoot` is `managedRoot(Settings)`; see stopByPort for why the port
 * fallback needs it. Omitting it is safe in the only direction that
 * matters: the fallback then refuses rather than killing by shape.
 */
function stop(Comfy, storage, port, say, ownRoot) {
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
  const byPort = stopByPort(port, say, ownRoot);
  if (byPort === "killed") return true;
  // "foreign" and "failed" have each already said their specific thing.
  // Saying "nothing ComfyUI-shaped on port N" on top of "a ComfyUI holds
  // port N and it is not ours" would contradict it in the same log.
  if (say && byPort === "none") {
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

/**
 * Is the backend at `url` actually answering? cb(down, st).
 *
 * §17n, measured 2026-09-09: `Comfy.status` does NOT report a down
 * backend as an error. It calls back `cb(null, {online:false, hint:...})`
 * on purpose, because the PANEL wants the hint text rather than an
 * exception. Every probe here tested only `if (err)`, so nothing
 * listening took the SUCCESS path and printed
 *
 *     == PASS ComfyUI reachable - queue running=0 pending=0
 *
 * where both counts are the `|| 0` on an undefined, not a reading. One
 * run then contradicted itself two verdicts later with "ComfyUI is not
 * running". Worse, `--boot` lived inside the same dead `if (err)`
 * branch, so it could never boot the backend it exists to boot.
 *
 * `down` is a STRING when the backend is not answering - the transport
 * error, or Comfy's own hint, which is the actionable half - and null
 * when it is up. Asked in ONE place so the probes cannot drift apart
 * again.
 */
function reachable(Comfy, url, settings, cb) {
  Comfy.status(url, function (err, st) {
    if (err) { cb(err.message || String(err), st || null); return; }
    if (!st || !st.online) {
      cb((st && st.hint) || ("nothing is answering at " + url), st || null);
      return;
    }
    cb(null, st);
  }, settings);
}

/**
 * The settings patch that makes `--url` REAL. Merge it into the override
 * object a probe already layers over Settings.get().
 *
 * §17m, measured 2026-09-09: every probe did `OVERRIDE.comfyUrl = OPT.url`
 * and then resolved its target with `Comfy.backendUrl(S)` — which in
 * MANAGED mode returns the managed port and never consults `comfyUrl` at
 * all. So the flag was accepted, printed nothing, and the probe measured
 * the managed backend anyway:
 *
 *     node scripts/comfy-probe.js --no-ae --url http://127.0.0.1:8299
 *     -- ComfyUI at http://127.0.0.1:8288  (backend: managed)
 *
 * The fix is not to make `backendUrl` consult `comfyUrl` — that
 * resolution is deliberate and load-bearing (see the comment above it in
 * comfy.js). It is that an explicit URL names an INSTANCE, so it selects
 * the mode that means "the instance at this URL" as well as the address.
 * `backendMode`'s own doc says exactly that: "a caller handing us an
 * explicit URL predates the setting and means the instance at that URL."
 *
 * Both fields, or neither: setting `comfyUrl` alone is the bug, and
 * setting `comfyBackend` alone would point "own" mode at whatever
 * `comfyUrl` happened to hold. Consequence of getting it wrong is not a
 * wrong port but a wrong MEASUREMENT — handoff/oom exist to watch one
 * backend take the card, and pointed elsewhere they report numbers about
 * a different process.
 */
function urlOverride(url) {
  return { comfyUrl: String(url), comfyBackend: "own" };
}

module.exports = {
  PID_KEY: PID_KEY,
  makeStorage: makeStorage,
  pidIsComfy: pidIsComfy,
  managedRoot: managedRoot,
  commandLineIsUnder: commandLineIsUnder,
  stopByPort: stopByPort,
  stop: stop,
  boot: boot,
  reachable: reachable,
  urlOverride: urlOverride
};
