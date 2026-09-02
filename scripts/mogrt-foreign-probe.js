#!/usr/bin/env node
/*
 * mogrt-foreign-probe.js — read .mogrt files THIS PROJECT DID NOT WRITE.
 *
 * Why this exists, and what it replaces.
 *
 * docs/SELF-VERIFY-PLANS.md section 1 gates the definition.json field
 * names on "an export real Premiere opened". That gate guards against
 * one specific failure: run 1 grading the checker against the checker's
 * own output. 0.11.5 took the pin from AE's output instead and
 * de-circularized it with PowerShell's System.IO.Compression, which is
 * a different implementation reading the same bytes.
 *
 * What no AE export can answer, however cross-checked: whether the
 * reader survives capsules written by SOMETHING ELSE. Adobe ships
 * Motion Graphics templates with Premiere, and every one of them is
 * Premiere-accepted by construction and localized into a dozen
 * languages. They are the independent corpus the plan wanted, they are
 * already on the machine, and reading them needs no human, no Premiere
 * launch, and no After Effects.
 *
 * This does NOT retire the manual step. Premiere opening OUR capsule
 * answers "is what AE wrote usable"; this answers "can we read what
 * Premiere ships". Both are worth having; only one of them needs a
 * person, and this is the other one.
 *
 * Usage:
 *   node scripts/mogrt-foreign-probe.js            # scan the known roots
 *   node scripts/mogrt-foreign-probe.js --dir <p>  # add a root
 *   node scripts/mogrt-foreign-probe.js --json     # machine-readable
 *
 * Exit codes: 0 every capsule read, 1 a capsule the reader could not
 * read (a real finding), 2 no capsules found (nothing measured — never
 * reported as success).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const MogrtRead = require("./lib/mogrt-read.js");

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}
const OPT = {
  extraDir: argValue("--dir"),
  json: argv.indexOf("--json") !== -1,
  limit: parseInt(argValue("--limit") || "40", 10)
};

/*
 * Where Adobe and its users keep capsules nobody here authored.
 * Deliberately narrow and read-only: named folders, never a whole-disk
 * walk. Missing roots are normal (a machine without Premiere has none)
 * and are reported, not treated as failures.
 */
function candidateRoots() {
  const roots = [];
  const env = process.env;
  const add = (p) => { if (p && roots.indexOf(p) === -1) roots.push(p); };

  if (OPT.extraDir) add(path.resolve(OPT.extraDir));

  // Premiere's own installed templates, and the shared folder its
  // Essential Graphics browser installs into.
  const pf = env["ProgramFiles"] || "C:\\Program Files";
  const appdata = env.APPDATA;
  const localapp = env.LOCALAPPDATA;
  const adobe = path.join(pf, "Adobe");
  if (fs.existsSync(adobe)) {
    let entries = [];
    try { entries = fs.readdirSync(adobe); } catch (e) {}
    entries.forEach(function (name) {
      if (!/Premiere|After Effects/i.test(name)) return;
      add(path.join(adobe, name, "Essential Graphics"));
      add(path.join(adobe, name, "MOGRTs"));
    });
  }
  if (appdata) {
    add(path.join(appdata, "Adobe", "Common", "Motion Graphics Templates"));
  }
  if (localapp) {
    add(path.join(localapp, "Adobe", "Common",
                  "Motion Graphics Templates"));
  }
  return roots;
}

/** Every .mogrt directly under a root (one level; Adobe does not nest). */
function capsulesIn(root) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return out; }
  names.forEach(function (n) {
    if (!/\.mogrt$/i.test(n)) return;
    const p = path.join(root, n);
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch (e) {}
  });
  return out;
}

/*
 * One capsule, graded. A capsule is READ when the zip walks, the
 * definition parses, and a roster comes back. `provisional` records
 * whether the roster came from a known key or the fallback scan — the
 * fallback answering for an Adobe file is itself a finding, because it
 * means the key list is missing whatever Premiere actually writes.
 */
function gradeCapsule(file) {
  const row = { file: file, ok: false, note: "" };
  let v;
  try {
    v = MogrtRead.verifyExport({ path: file, definitionOnly: true,
                                 maxInflate: 8 * 1024 * 1024 });
  } catch (e) {
    row.note = "the reader threw: " + (e && e.message ? e.message : e);
    return row;
  }
  if (v.readable === false) {
    row.note = "unreadable: " + (v.errors[0] || "no reason given");
    row.skipped = true;   // a locked/oversized file is not a defect
    return row;
  }
  row.zipValid = v.zipValid;
  row.entries = v.entryCount;
  row.definitionFound = v.definitionFound;
  row.controllers = (v.controllersInFile || []).length;
  row.names = (v.controllersInFile || []).slice(0, 6);
  row.types = v.controllerTypes || null;
  row.rosterVia = v.rosterVia || null;
  row.provisional = v.rosterProvisional === true;
  row.templateName = v.templateNameInFile || null;
  row.warnings = v.warnings || [];

  if (!v.zipValid) {
    row.note = "zip did not validate: " + (v.errors[0] || "");
    return row;
  }
  if (!v.definitionFound) {
    row.note = "no definition.json in the capsule";
    return row;
  }
  if (row.controllers === 0) {
    // A real Premiere template with no controls is possible but rare;
    // far likelier is a shape this reader's key list does not know.
    row.note = "definition parsed but NO controllers were found — the " +
               "key list does not cover this file's shape";
    return row;
  }
  // A name that is a locale tag is the exact 0.11.5 bug, and the reason
  // a foreign corpus is worth reading at all.
  const localeish = row.names.filter(function (n) {
    return /^[a-z]{2}_[A-Z]{2}$/.test(String(n));
  });
  if (localeish.length) {
    row.note = "controller names came back as LOCALE TAGS (" +
               localeish.join(", ") + ") — the localized-string read is " +
               "wrong for this file";
    return row;
  }
  row.ok = true;
  if (!row.provisional) {
    row.note = "read via " + row.rosterVia;
  } else if (/^fallback/.test(String(row.rosterVia))) {
    row.note = "read via " + row.rosterVia + " — the FALLBACK scan, so " +
               "the known-key list is missing this file's shape";
  } else {
    row.note = "read via " + row.rosterVia + " — a known key, nested; " +
               "the group's leaf controllers are what came back";
  }
  return row;
}

function main() {
  const roots = candidateRoots();
  const found = [];
  const rootRows = [];
  roots.forEach(function (r) {
    const exists = fs.existsSync(r);
    const caps = exists ? capsulesIn(r) : [];
    rootRows.push({ root: r, exists: exists, capsules: caps.length });
    caps.forEach(function (c) {
      if (found.length < OPT.limit) found.push(c);
    });
  });

  const rows = found.map(gradeCapsule);
  const graded = rows.filter(function (r) { return !r.skipped; });
  const bad = graded.filter(function (r) { return !r.ok; });
  const provisional = graded.filter(function (r) { return r.ok && r.provisional; });

  if (OPT.json) {
    console.log(JSON.stringify({ roots: rootRows, rows: rows }, null, 2));
  } else {
    console.log("-- roots");
    rootRows.forEach(function (r) {
      console.log("   " + (r.exists ? String(r.capsules) + " capsule(s)"
                                    : "(absent)      ") + "  " + r.root);
    });
    console.log("\n-- capsules");
    rows.forEach(function (r) {
      const mark = r.skipped ? "skip" : (r.ok ? "ok  " : "FAIL");
      console.log(mark + "  " + path.basename(r.file));
      console.log("      " + r.note);
      if (r.ok) {
        console.log("      " + r.controllers + " controller(s): " +
                    r.names.join(", ") +
                    (r.controllers > r.names.length ? " …" : ""));
      }
    });
  }

  if (!graded.length) {
    console.log("\nNo .mogrt files found in any known location. Nothing " +
                "was measured — this is not a pass. Install a Premiere " +
                "template, or pass --dir <folder> with capsules in it.");
    process.exitCode = 2;
    return;
  }
  console.log("\n" + graded.length + " capsule(s) read, " + bad.length +
              " failed, " + provisional.length + " provisional.");
  if (provisional.length) {
    // Two different states share the provisional flag, and only one of
    // them is a gap in the key list. Say which.
    const fallback = provisional.filter(function (r) {
      return /^fallback/.test(String(r.rosterVia));
    });
    const nested = provisional.length - fallback.length;
    if (nested) {
      console.log(nested + " read through a NESTED roster under a known " +
                  "key — the shape is understood, and these are the " +
                  "controller GROUPS the plan lists as unmeasured. " +
                  "Reading them here is the measurement.");
    }
    if (fallback.length) {
      console.log(fallback.length + " came from the FALLBACK scan: the " +
                  "known-key list is missing whatever these files use. " +
                  "Add the key, do not widen the scan.");
    }
  }
  process.exitCode = bad.length ? 1 : 0;
}

if (require.main === module) main();
module.exports = { candidateRoots, capsulesIn, gradeCapsule };
