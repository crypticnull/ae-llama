#!/usr/bin/env node
/*
 * ppro-probe-report.js -- grade the P0 probe results and say, in one
 * screen, whether Gate G0 passed.
 *
 * Run it after the probe panels and the door probe have written their
 * JSON:
 *
 *   node scripts/ppro-probe-report.js
 *   node scripts/ppro-probe-report.js --dir <folder>   (or a copy of it)
 *   node scripts/ppro-probe-report.js --out docs/measured/ppro-probe-<date>.json
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a missing measurement is never
 * a pass. The panel already shipped one field failure of exactly that
 * shape -- an unattended probe read pure defaults with no APPDATA and
 * filed them as the owner's setting -- so every row here is one of
 * MEASURED / MISSING / FAILED, and G0 can only pass on MEASURED rows.
 *
 * Exit codes: 0 = G0 PASS, 1 = G0 FAIL (measured), 2 = nothing measured.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

function defaultDir() {
  const base = process.env.APPDATA || process.env.USERPROFILE || "";
  return base ? path.join(base, "AE-Llama", "probes") : "";
}

/** Read one JSON file, or null. A parse failure is a finding, not a throw. */
function readJson(file) {
  try {
    if (!fs.existsSync(file)) { return null; }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { __unreadable: String(e.message || e), __file: file };
  }
}

/** Collect every probe artifact a run can produce. */
function collect(dir) {
  const byHost = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { names = []; }
  names.forEach(function (n) {
    const m = /^runtime-(.+)\.json$/.exec(n);
    if (m) { byHost[m[1]] = readJson(path.join(dir, n)); }
  });
  return {
    dir: dir,
    exists: fs.existsSync(dir),
    hosts: byHost,
    doors: readJson(path.join(dir, "doors.json")),
    csxs: readJson(path.join(dir, "csxs-keys.json")),
    jobResult: readJson(path.join(dir, "job-result.json"))
  };
}

// A row is what the plan's "unverified" table asked for, one per line.
function row(claim, state, value) {
  return { claim: claim, state: state, value: value === undefined ? null : value };
}

/** MEASURED only when the value is really there; null/undefined is MISSING. */
function measured(claim, value, badWhen) {
  if (value === null || typeof value === "undefined" || value === "") {
    return row(claim, "MISSING", null);
  }
  if (typeof value === "string" && value.indexOf("throws:") === 0) {
    return row(claim, "FAILED", value);
  }
  if (typeof badWhen === "function" && badWhen(value)) {
    return row(claim, "FAILED", value);
  }
  return row(claim, "MEASURED", value);
}

function gradeHost(hostKey, r) {
  const rows = [];
  if (!r) {
    return { host: hostKey, present: false, rows: [
      row("the probe panel ran in this host", "MISSING", null)
    ] };
  }
  if (r.__unreadable) {
    return { host: hostKey, present: false, rows: [
      row("the probe panel's result file parses", "FAILED", r.__unreadable)
    ] };
  }
  const panel = r.panel || {};
  const facts = r.hostFacts || {};
  const node = panel.node || {};

  rows.push(measured("CEP runtime present (__adobe_cep__)",
                     panel.cepPresent === true ? "yes" : null));
  rows.push(measured("appName the panel must branch on", panel.appName));
  rows.push(measured("appVersion", panel.appVersion));
  rows.push(measured("CEP API version", panel.cepApiVersion &&
                     JSON.stringify(panel.cepApiVersion)));
  rows.push(measured("Node: child_process (llama-server, ComfyUI, ffmpeg)",
                     node.child_process === true ? "yes" : node.child_process));
  rows.push(measured("Node: fs", node.fs === true ? "yes" : node.fs));
  rows.push(measured("Node: http", node.http === true ? "yes" : node.http));
  rows.push(measured("APPDATA visible to the panel", panel.appdata));
  rows.push(measured("probe.jsx loaded into the host engine",
                     r.probeLoad && (r.probeLoad.typeofCall
                       ? ("FAILED: typeof AELLP_call was " +
                          r.probeLoad.typeofCall)
                       : ("via " + r.probeLoad.via)),
                     function (v) { return /^FAILED/.test(String(v)); }));
  // The manifest's ScriptPath is evaluated, but $.fileName inside it
  // names the HOST's folder, so a ScriptPath loader cannot resolve its
  // own siblings. Recorded because it decides whether a dual-host panel
  // can branch in ScriptPath at all (docs/PREMIERE-PLATFORM.md).
  rows.push(measured("$.fileName inside the manifest's ScriptPath",
                     r.scriptPath && r.scriptPath.dollarFileName));
  rows.push(measured("evalScript round-trips a JSON envelope",
                     r.evalScript && r.evalScript.ok === true ? "yes" : null,
                     function () { return r.evalScript && r.evalScript.ok === false; }));
  rows.push(measured("ExtendScript engine name", facts.engineName ||
                     (r.evalScript && r.evalScript.ping &&
                      r.evalScript.ping.engineName)));
  rows.push(measured("BridgeTalk.appName (the door-1 target)",
                     facts.btAppName));
  rows.push(measured("BridgeTalk targets this host can see",
                     facts.btTargets && facts.btTargets.join(" ")));
  rows.push(measured("undo grouping (app.beginUndoGroup)",
                     facts.beginUndoGroup));
  rows.push(measured("app.executeCommand (AE's undo/redo menu ids)",
                     facts.executeCommand));
  rows.push(measured("app.enableQE", facts.enableQE));
  rows.push(measured("QE reachable after enableQE",
                     r.qe && (r.qe.qeProject || r.qe.error)));
  rows.push(measured("manifest shape installed",
                     r.shape && (r.shape.guess || r.shape.error)));
  rows.push(measured("localStorage scoping across hosts",
                     r.storage && r.storage.note));
  rows.push(measured("engine soak (500 round-trips)",
                     r.soak && r.soak.verdict,
                     function (v) { return /DEGRADED/.test(String(v)); }));
  rows.push(measured("History entries for 3 scripted mutations",
                     r.history && (r.history.instruction ? "ran; owner reads " +
                       "the History panel" : (r.history.skipped ||
                       r.history.error))));
  rows.push(measured("MOGRT: Premiere accepted what AE wrote",
                     r.mogrtAccept && (r.mogrtAccept.error ||
                       (r.mogrtAccept.landed === true ?
                        ("landed, " + r.mogrtAccept.controllerCount +
                         " controllers, names readable: " +
                         r.mogrtAccept.namesReadable) : null)),
                     function (v) { return !/^landed/.test(String(v)); }));
  return { host: hostKey, present: true, rows: rows, raw: r };
}

/**
 * Gate G0 from docs/PREMIERE_PLAN.md: the panel is LISTED and OPENS in
 * Premiere, evalScript round-trips, and Node works. Everything else in
 * the report is information; these four are the gate.
 */
function gradeG0(collected) {
  const ppro = collected.hosts.PPRO || collected.hosts.ppro || null;
  const checks = [];
  function check(name, pass, detail) {
    checks.push({ name: name, pass: pass === true, unmeasured: pass === null,
                  detail: detail });
  }
  if (!ppro || ppro.__unreadable) {
    check("the probe panel opened in Premiere", null,
          "no runtime-PPRO.json in " + collected.dir + " -- either the " +
          "panel is not listed under Window > Extensions in Premiere, or " +
          "it was never opened and pressed. Those are different answers: " +
          "look at the menu before recording a verdict.");
    return { pass: false, measured: false, checks: checks };
  }
  const panel = ppro.panel || {};
  const node = panel.node || {};
  check("the probe panel opened in Premiere", panel.cepPresent === true,
        "appName=" + String(panel.appName) + " appVersion=" +
        String(panel.appVersion));
  check("evalScript reaches Premiere's ExtendScript engine",
        !!(ppro.evalScript && ppro.evalScript.ok === true),
        ppro.evalScript && ppro.evalScript.error ? ppro.evalScript.error :
        "envelope parsed");
  check("CEP Node is available (the whole engine/ComfyUI stack needs it)",
        node.child_process === true && node.fs === true && node.http === true,
        "child_process=" + String(node.child_process) + " fs=" +
        String(node.fs) + " http=" + String(node.http));
  // A soak that was SKIPPED (the probe never loaded) is unmeasured, not
  // a degraded engine. The panel's first run reported "DEGRADED at
  // round 1" when probe.jsx had simply never been evaluated, and a gate
  // that cannot tell those apart would have failed G0 for the wrong
  // reason.
  check("the engine survives a realistic session (soak)",
        (ppro.soak && !ppro.soak.skipped) ? ppro.soak.failedAt === null : null,
        ppro.soak ? (ppro.soak.skipped || ppro.soak.verdict)
                  : "soak not run -- press \"Engine soak\"");
  const anyUnmeasured = checks.some(function (c) { return c.unmeasured; });
  return {
    pass: checks.every(function (c) { return c.pass; }),
    measured: !anyUnmeasured,
    checks: checks
  };
}

function gradeDoors(doors) {
  if (!doors) {
    return { state: "MISSING",
             detail: "doors.json not found -- run scripts\\ppro-door-probe.ps1" };
  }
  if (doors.__unreadable) {
    return { state: "FAILED", detail: doors.__unreadable };
  }
  const list = doors.doors || [];
  const alive = list.filter(function (d) { return d.verdict === "ALIVE"; });
  const measuredDoors = list.filter(function (d) { return d.verdict !== "SKIPPED"; });
  if (alive.length) {
    return { state: "ALIVE", detail: alive.map(function (d) {
      return "door " + d.door + ": " + d.detail; }).join(" | "), list: list };
  }
  if (!measuredDoors.length) {
    return { state: "MISSING",
             detail: "every door was SKIPPED for a missing prerequisite -- " +
                     "nothing was measured", list: list };
  }
  return { state: "DEAD",
           detail: "every door measured dead: Premiere verification stays a " +
                   "click in the panel (rung 2), the overnight loop cannot " +
                   "cover Premiere, and QE-backed tools must not ship",
           list: list };
}

function report(collected) {
  const hosts = Object.keys(collected.hosts).sort();
  const graded = hosts.map(function (h) { return gradeHost(h, collected.hosts[h]); });
  // AE is graded too: the seam must not regress the shipping product,
  // and an AE row that changes is the first sign it did.
  if (hosts.indexOf("AEFT") === -1) {
    graded.unshift(gradeHost("AEFT", null));
  }
  if (hosts.indexOf("PPRO") === -1) {
    graded.push(gradeHost("PPRO", null));
  }
  return {
    takenAt: new Date().toISOString(),
    dir: collected.dir,
    dirExists: collected.exists,
    csxsKeys: collected.csxs,
    hosts: graded,
    doors: gradeDoors(collected.doors),
    g0: gradeG0(collected)
  };
}

function print(rep) {
  const W = 52;
  function pad(s) {
    s = String(s);
    return s.length >= W ? s : s + " ".repeat(W - s.length);
  }
  console.log("P0 probe report -- " + rep.takenAt);
  console.log("probes folder: " + rep.dir +
              (rep.dirExists ? "" : "  (DOES NOT EXIST)"));
  console.log("");

  if (rep.csxsKeys && Array.isArray(rep.csxsKeys)) {
    const present = rep.csxsKeys.filter(function (k) { return k.existedBefore; })
      .map(function (k) { return "CSXS." + k.csxs; });
    console.log("CEP runtimes registered before install: " +
                (present.length ? present.join(", ") : "(none)"));
    console.log("");
  }

  rep.hosts.forEach(function (h) {
    console.log("== " + h.host + (h.present ? "" : "   (no result file)"));
    h.rows.forEach(function (r) {
      const mark = r.state === "MEASURED" ? "ok  " :
                   (r.state === "FAILED" ? "FAIL" : "----");
      console.log("  " + mark + " " + pad(r.claim) +
                  (r.value === null ? "" : String(r.value).slice(0, 90)));
    });
    console.log("");
  });

  console.log("== headless doors: " + rep.doors.state);
  console.log("   " + rep.doors.detail);
  console.log("");

  console.log("== GATE G0");
  rep.g0.checks.forEach(function (c) {
    const mark = c.pass ? "ok  " : (c.unmeasured ? "----" : "FAIL");
    console.log("  " + mark + " " + pad(c.name) + String(c.detail).slice(0, 90));
  });
  console.log("");
  if (!rep.g0.measured) {
    console.log("G0: NOT MEASURED. A missing probe is not a pass -- the rows");
    console.log("marked ---- say exactly what has not been run yet.");
  } else if (rep.g0.pass) {
    console.log("G0: PASS. The CEP path into Premiere is real on this machine.");
    console.log("Next: P1 (DOM inventory) per docs/PREMIERE_PLAN.md.");
  } else {
    console.log("G0: FAIL, measured. Per the plan this stops the CEP path:");
    console.log("write the limit into CLAUDE.md and docs/PREMIERE-PLATFORM.md,");
    console.log("then decide on the UXP design instead of building on CEP.");
  }
}

function main() {
  const dir = argValue("--dir") || defaultDir();
  if (!dir) {
    console.error("No probes folder: pass --dir <folder> (APPDATA is unset " +
                  "here, which is normal off Windows).");
    process.exitCode = 2;
    return;
  }
  const collected = collect(dir);
  const rep = report(collected);
  if (argv.indexOf("--json") !== -1) {
    console.log(JSON.stringify(rep, null, 2));
  } else {
    print(rep);
  }
  const out = argValue("--out");
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(rep, null, 2), "utf8");
    console.log("\nWritten to " + out);
  }
  process.exitCode = rep.g0.measured ? (rep.g0.pass ? 0 : 1) : 2;
}

if (require.main === module) { main(); }
module.exports = { collect, report, gradeHost, gradeG0, gradeDoors, measured };
