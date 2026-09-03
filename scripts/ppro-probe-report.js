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

/** One named step out of a battery result, or null. */
function stepOf(steps, name) {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] && steps[i].step === name) { return steps[i]; }
  }
  return null;
}

/**
 * Re-shape an UNATTENDED battery result (job-result.json, written by
 * run-ppro-probe.ps1 through the invisible door-3 runner) into the same
 * shape the VISIBLE panel writes to runtime-<HOST>.json, so one grader
 * reads either.
 *
 * This exists because the grader used to read the panel file only. On
 * 2026-09-03 that made it print `FAIL MOGRT ... clip count did not grow
 * (1 -> 1)` from a 2026-09-02 click while an all-green battery from the
 * same morning sat unread beside it -- a report confidently about a
 * different artifact, which is the very failure class the probe's own
 * clip-diff fix had just removed.
 *
 * What the runner CANNOT see is left absent rather than guessed: it
 * never enumerates Node modules, APPDATA, the CEP API version, the
 * manifest shape, localStorage scoping or the soak, so those rows fall
 * back to the panel file. What its own existence proves -- a CEP
 * runtime answered getHostEnvironment(), and evalScript round-tripped a
 * JSON envelope -- is recorded.
 */
function fromJobResult(job) {
  if (!job || job.__unreadable) { return null; }
  const hostEnv = job.host || {};
  const appName = hostEnv.appName || hostEnv.appId || null;
  if (!appName) { return null; }
  const battery = job.battery || (job.parsed && job.parsed.data) || {};
  const steps = Array.isArray(battery.steps) ? battery.steps : [];
  const ping = stepOf(steps, "ping");
  const facts = stepOf(steps, "hostFacts");
  const qe = stepOf(steps, "qe");
  const history = stepOf(steps, "history");
  const mogrt = stepOf(steps, "mogrt");
  const envelopeOk = !!(job.parsed && job.parsed.ok === true);
  const pinged = !!(ping && ping.ok !== false && ping.data && ping.data.pong);
  function dataOf(s) { return s && s.data ? s.data : null; }
  return {
    host: appName,
    takenAt: job.finishedAt || job.startedAt || null,
    panel: {
      cepPresent: true,
      appName: appName,
      appVersion: hostEnv.appVersion || null,
      appLocale: hostEnv.appLocale || null
    },
    evalScript: (job.parsed || job.raw) ? {
      ok: envelopeOk && pinged,
      ping: dataOf(ping),
      error: envelopeOk ? (pinged ? null : "the envelope parsed but the " +
                           "ping step did not answer")
                        : ((job.parsed && job.parsed.error) ||
                           "the battery envelope did not parse")
    } : null,
    probeLoad: pinged ? {
      via: (job.via || "the unattended runner") + ", probe.jsx at " +
           (ping.data.fileName || "(unnamed)")
    } : null,
    hostFacts: dataOf(facts),
    qe: dataOf(qe),
    history: dataOf(history),
    mogrtAccept: dataOf(mogrt),
    battery: steps.length ? {
      door: job.door === undefined ? null : job.door,
      steps: steps.map(function (s) {
        return { step: s.step, ok: s.ok !== false,
                 error: (s.data && s.data.error) || null };
      }),
      project: dataOf(stepOf(steps, "project")),
      sequence: dataOf(stepOf(steps, "sequence")),
      cleanup: dataOf(stepOf(steps, "cleanup"))
    } : null
  };
}

/** Read one dotted path out of a nested object; undefined if any hop misses. */
function dig(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || typeof cur !== "object") { return undefined; }
    cur = cur[parts[i]];
  }
  return cur;
}

/**
 * Every artifact that says something about one host, NEWEST FIRST.
 *
 * Neither artifact is a superset of the other and either can be the
 * older one, so the merge is per ROW, not per file: each row takes the
 * newest source that actually has its value and REPORTS WHICH ONE. An
 * older row is still a measurement -- it just has to be labelled as
 * one, because "we measured this yesterday" and "we measured this in
 * the run you just watched" are different claims.
 */
function sourcesFor(hostKey, collected) {
  const out = [];
  const panelFile = collected.hosts ? collected.hosts[hostKey] : null;
  if (panelFile && !panelFile.__unreadable) {
    out.push({ tag: "pnl", file: "runtime-" + hostKey + ".json",
               takenAt: panelFile.takenAt || null, data: panelFile });
  }
  const job = fromJobResult(collected.jobResult);
  if (job && job.host === hostKey) {
    out.push({ tag: "job", file: "job-result.json",
               takenAt: job.takenAt, data: job });
  }
  out.sort(function (a, b) {
    const ta = Date.parse(a.takenAt || "") || 0;
    const tb = Date.parse(b.takenAt || "") || 0;
    return tb - ta;
  });
  return out;
}

/**
 * A per-row reader over those sources: the newest source that HAS the
 * value wins. A row may name several paths (the same fact is recorded
 * under different keys by the panel and by the battery); the SOURCE is
 * chosen first and the paths tried within it, so a newer artifact's
 * second-choice key still beats an older artifact's first-choice one.
 */
function picker(sources) {
  return function pick(dotted) {
    const paths = Array.isArray(dotted) ? dotted : [dotted];
    for (let i = 0; i < sources.length; i++) {
      for (let p = 0; p < paths.length; p++) {
        const v = dig(sources[i].data, paths[p]);
        if (v !== null && typeof v !== "undefined" && v !== "") {
          return { value: v, source: sources[i], stale: i > 0 };
        }
      }
    }
    return { value: null, source: null, stale: false };
  };
}

// A row is what the plan's "unverified" table asked for, one per line.
function row(claim, state, value) {
  return { claim: claim, state: state, value: value === undefined ? null : value };
}

/** Stamp a row with the artifact its value came from (null when MISSING). */
function from(r, got) {
  r.from = got && got.source ? got.source.file : null;
  r.fromTag = got && got.source ? got.source.tag : null;
  r.fromAt = got && got.source ? got.source.takenAt : null;
  r.stale = !!(got && got.stale);
  return r;
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

function gradeHost(hostKey, given) {
  const rows = [];
  // Callers outside this file (and the tests) may still hand over one
  // plain runtime object; treat it as a single source.
  let sources;
  if (Array.isArray(given)) {
    sources = given;
  } else if (given && given.__unreadable) {
    return { host: hostKey, present: false, sources: [], rows: [
      row("the probe panel's result file parses", "FAILED", given.__unreadable)
    ] };
  } else if (given) {
    sources = [{ tag: "pnl", file: "runtime-" + hostKey + ".json",
                 takenAt: given.takenAt || null, data: given }];
  } else {
    sources = [];
  }
  if (!sources.length) {
    return { host: hostKey, present: false, sources: [], rows: [
      row("the probe panel ran in this host", "MISSING", null)
    ] };
  }
  const pick = picker(sources);
  /** One row, tagged with the artifact its value came from. */
  function m(claim, dotted, shape, badWhen) {
    const got = pick(dotted);
    const value = got.value === null ? null :
                  (typeof shape === "function" ? shape(got.value) : got.value);
    return from(measured(claim, value, badWhen), value === null ? null : got);
  }
  rows.push(m("CEP runtime present (__adobe_cep__)", "panel.cepPresent",
              function (v) { return v === true ? "yes" : null; }));
  rows.push(m("appName the panel must branch on", "panel.appName"));
  rows.push(m("appVersion", "panel.appVersion"));
  rows.push(m("CEP API version", "panel.cepApiVersion", JSON.stringify));
  rows.push(m("Node: child_process (llama-server, ComfyUI, ffmpeg)",
              "panel.node.child_process",
              function (v) { return v === true ? "yes" : v; }));
  rows.push(m("Node: fs", "panel.node.fs",
              function (v) { return v === true ? "yes" : v; }));
  rows.push(m("Node: http", "panel.node.http",
              function (v) { return v === true ? "yes" : v; }));
  rows.push(m("APPDATA visible to the panel", "panel.appdata"));
  rows.push(m("probe.jsx loaded into the host engine", "probeLoad",
              function (v) {
                return v.typeofCall
                  ? ("FAILED: typeof AELLP_call was " + v.typeofCall)
                  : ("via " + v.via);
              },
              function (v) { return /^FAILED/.test(String(v)); }));
  // The manifest's ScriptPath is evaluated, but $.fileName inside it
  // names the HOST's folder, so a ScriptPath loader cannot resolve its
  // own siblings. Recorded because it decides whether a dual-host panel
  // can branch in ScriptPath at all (docs/PREMIERE-PLATFORM.md).
  rows.push(m("$.fileName inside the manifest's ScriptPath",
              "scriptPath.dollarFileName"));
  rows.push(m("evalScript round-trips a JSON envelope", "evalScript",
              function (v) { return v.ok === true ? "yes" : (v.error ||
                                                             "did not parse"); },
              function (v) { return v !== "yes"; }));
  rows.push(m("ExtendScript engine name",
              ["hostFacts.engineName", "evalScript.ping.engineName"]));
  rows.push(m("BridgeTalk.appName (the door-1 target)", "hostFacts.btAppName"));
  rows.push(m("BridgeTalk targets this host can see", "hostFacts.btTargets",
              function (v) { return v.join(" "); }));
  rows.push(m("undo grouping (app.beginUndoGroup)", "hostFacts.beginUndoGroup"));
  rows.push(m("app.executeCommand (AE's undo/redo menu ids)",
              "hostFacts.executeCommand"));
  rows.push(m("app.enableQE", "hostFacts.enableQE"));
  rows.push(m("QE reachable after enableQE", "qe",
              function (v) { return v.qeProject || v.error || null; }));
  rows.push(m("manifest shape installed", "shape",
              function (v) { return v.guess || v.error || null; }));
  rows.push(m("localStorage scoping across hosts", "storage.note"));
  rows.push(m("engine soak (500 round-trips)", "soak",
              function (v) { return v.verdict || v.skipped || null; },
              function (v) { return /DEGRADED/.test(String(v)); }));
  rows.push(m("History entries for 3 scripted mutations", "history",
              function (v) {
                return v.instruction ? "ran; owner reads the History panel"
                                     : (v.skipped || v.error || null);
              }));
  rows.push(m("MOGRT: Premiere accepted what AE wrote", "mogrtAccept",
              function (v) {
                return v.landed === true
                  ? ("landed, " + v.controllerCount + " controllers, names " +
                     "readable: " + v.namesReadable)
                  : (v.error || null);
              },
              function (v) { return !/^landed/.test(String(v)); }));

  // The unattended battery's own steps. They have no equivalent in the
  // visible panel, so they are only graded when a job result exists --
  // and their absence is stated in the sources line above the block,
  // not faked as a MISSING measurement of the panel.
  if (pick("battery").value) {
    rows.push(m("battery: every step passed", "battery.steps",
                function (v) {
                  const bad = v.filter(function (s) { return !s.ok; });
                  return bad.length
                    ? ("FAILED at " + bad.map(function (s) {
                        return s.step + (s.error ? " (" + s.error + ")" : "");
                      }).join(", "))
                    : (v.length + "/" + v.length + " steps ok: " +
                       v.map(function (s) { return s.step; }).join(" "));
                },
                function (v) { return /^FAILED/.test(String(v)); }));
    rows.push(m("scratch project (created or opened)", "battery.project",
                function (v) {
                  return v.error ? ("FAILED: " + v.error)
                                 : (v.via + " " + v.name);
                },
                function (v) { return /^FAILED/.test(String(v)); }));
    rows.push(m("a sequence to work in", "battery.sequence",
                function (v) {
                  return v.error ? ("FAILED: " + v.error)
                    : (v.via + " " + v.active + ", " + v.videoTracks +
                       " video tracks");
                },
                function (v) { return /^FAILED/.test(String(v)); }));
    rows.push(m("the probe removed what it made", "battery.cleanup",
                function (v) {
                  return v.removed && v.removed.length
                    ? v.removed.join(", ") : (v.error || "nothing removed");
                }));
  }
  return { host: hostKey, present: true, sources: sources.map(function (s) {
    return { tag: s.tag, file: s.file, takenAt: s.takenAt };
  }), rows: rows };
}

/**
 * Gate G0 from docs/PREMIERE_PLAN.md: the panel is LISTED and OPENS in
 * Premiere, evalScript round-trips, and Node works. Everything else in
 * the report is information; these four are the gate.
 */
function gradeG0(collected) {
  const sources = sourcesFor("PPRO", collected);
  if (!sources.length && collected.hosts && collected.hosts.ppro) {
    sources.push({ tag: "pnl", file: "runtime-ppro.json",
                   takenAt: collected.hosts.ppro.takenAt || null,
                   data: collected.hosts.ppro });
  }
  const checks = [];
  function check(name, pass, detail, source) {
    checks.push({ name: name, pass: pass === true, unmeasured: pass === null,
                  detail: detail,
                  from: source ? source.file : null,
                  fromAt: source ? source.takenAt : null });
  }
  if (!sources.length) {
    check("the probe panel opened in Premiere", null,
          "no runtime-PPRO.json and no job-result.json in " + collected.dir +
          " -- either the panel is not listed under Window > Extensions in " +
          "Premiere, or it was never opened and pressed, or the unattended " +
          "runner never wrote a result. Those are different answers: look " +
          "at the menu before recording a verdict.");
    return { pass: false, measured: false, checks: checks, sources: [] };
  }
  const pick = picker(sources);
  // Every gate row below is one of pass / measured-FAIL / UNMEASURED, and
  // an ABSENT reading is always the third. The gate used to read a
  // missing evalScript result as a measured FAIL and print "envelope
  // parsed" beside it -- confidently wrong in both halves.
  const cep = pick("panel.cepPresent");
  check("the probe panel opened in Premiere",
        cep.value === null ? null : cep.value === true,
        "appName=" + String(pick("panel.appName").value) + " appVersion=" +
        String(pick("panel.appVersion").value), cep.source);
  const es = pick("evalScript");
  check("evalScript reaches Premiere's ExtendScript engine",
        es.value === null ? null : es.value.ok === true,
        es.value ? (es.value.ok === true ? "envelope parsed"
                                         : (es.value.error || "did not parse"))
                 : "no evalScript result -- the round-trip was never run",
        es.source);
  const nodeGot = pick("panel.node");
  const node = nodeGot.value || {};
  check("CEP Node is available (the whole engine/ComfyUI stack needs it)",
        nodeGot.value === null ? null
          : (node.child_process === true && node.fs === true &&
             node.http === true),
        nodeGot.value ? ("child_process=" + String(node.child_process) +
                         " fs=" + String(node.fs) + " http=" +
                         String(node.http))
                      : "the Node inventory was never taken",
        nodeGot.source);
  // A soak that was SKIPPED (the probe never loaded) is unmeasured, not
  // a degraded engine. The panel's first run reported "DEGRADED at
  // round 1" when probe.jsx had simply never been evaluated, and a gate
  // that cannot tell those apart would have failed G0 for the wrong
  // reason.
  const soakGot = pick("soak");
  const soak = soakGot.value;
  check("the engine survives a realistic session (soak)",
        (soak && !soak.skipped) ? soak.failedAt === null : null,
        soak ? (soak.skipped || soak.verdict)
             : "soak not run -- it is a button in the VISIBLE panel, not a " +
               "battery step, so an unattended run can never supply it",
        soakGot.source);
  const anyUnmeasured = checks.some(function (c) { return c.unmeasured; });
  return {
    pass: checks.every(function (c) { return c.pass; }),
    measured: !anyUnmeasured,
    checks: checks,
    sources: sources.map(function (s) {
      return { tag: s.tag, file: s.file, takenAt: s.takenAt };
    })
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
  // AE is graded too: the seam must not regress the shipping product,
  // and an AE row that changes is the first sign it did.
  if (hosts.indexOf("AEFT") === -1) { hosts.unshift("AEFT"); }
  if (hosts.indexOf("PPRO") === -1) { hosts.push("PPRO"); }
  const graded = hosts.map(function (h) {
    const g = gradeHost(h, sourcesFor(h, collected));
    // A panel file that will not parse is a finding in its own right --
    // but it must not HIDE a battery result for the same host, which is
    // the mistake this whole pass is about. Report both.
    const raw = collected.hosts[h];
    if (raw && raw.__unreadable) {
      g.rows.unshift(row("the probe panel's result file parses", "FAILED",
                         raw.__unreadable));
    }
    return g;
  });
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
    // Which artifacts spoke for this host, newest first. Without this
    // line a row read as "the probe says X" when it meant "a click from
    // yesterday said X".
    if (h.sources && h.sources.length) {
      console.log("   sources: " + h.sources.map(function (s, i) {
        return "[" + s.tag + "] " + s.file + " " + (s.takenAt || "(undated)") +
               (i === 0 && h.sources.length > 1 ? " <- newest" : "");
      }).join("\n            "));
    }
    h.rows.forEach(function (r) {
      const mark = r.state === "MEASURED" ? "ok  " :
                   (r.state === "FAILED" ? "FAIL" : "----");
      // [job] / [pnl] is where the value came from; a * means it came
      // from the OLDER artifact because the newer one does not measure it.
      const tag = "[" + (r.fromTag || " - ") + (r.stale ? "*" : " ") + "]";
      console.log("  " + mark + " " + tag + " " + pad(r.claim) +
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
    if (c.from) {
      console.log("       from " + c.from + " " + (c.fromAt || "(undated)"));
    }
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
module.exports = { collect, report, gradeHost, gradeG0, gradeDoors, measured,
                   fromJobResult, sourcesFor, picker };
