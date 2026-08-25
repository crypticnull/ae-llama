#!/usr/bin/env node
/*
 * capability-report.js — regenerate the GENERATED section of
 * docs/CAPABILITIES.md from the code itself.
 *
 *   node scripts/capability-report.js          # rewrite the doc
 *   node scripts/capability-report.js --check  # exit 1 if the doc is stale
 *
 * Hand-written inventories rot (this repo's step counts went stale twice
 * in one week), so the tool table is built from the real TOOL_DEFS the
 * panel ships, cross-referenced against the host dispatch table, the
 * stubbed tests, and the self-test suite. tests/test-capability-doc.js
 * runs --check, so CI fails when someone adds a tool without regenerating.
 * Everything OUTSIDE the markers is curated by hand and never touched.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DOC = path.join(ROOT, "docs", "CAPABILITIES.md");
const BEGIN = "<!-- BEGIN GENERATED TOOL INVENTORY (scripts/capability-report.js) -->";
const END = "<!-- END GENERATED TOOL INVENTORY -->";

function read(p) { return fs.readFileSync(p, "utf8"); }

// --- the real TOOL_DEFS, by loading the real file ---------------------
function loadToolDefs() {
  const src = read(path.join(ROOT, "extension", "js", "tools.js"));
  const window = {};
  // tools.js is an IIFE over `window`; nothing else is needed at load time.
  eval(src); // eslint-disable-line no-eval
  if (!window.Tools || !Array.isArray(window.Tools.TOOL_DEFS)) {
    throw new Error("tools.js did not export Tools.TOOL_DEFS");
  }
  return window.Tools.TOOL_DEFS;
}

function hostToolNames() {
  const src = read(path.join(ROOT, "extension", "jsx", "hostscript.jsx"));
  const names = new Set();
  const re = /AELL_TOOLS\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

function stubCoverage() {
  const dir = path.join(ROOT, "tests");
  const map = {}; // tool name -> [test files]
  for (const f of fs.readdirSync(dir)) {
    if (!/^test-.*\.js$/.test(f)) continue;
    const src = read(path.join(dir, f));
    for (const m of src.matchAll(/call\(\s*["']([a-z_]+)["']/g)) {
      (map[m[1]] = map[m[1]] || []).push(f);
    }
  }
  for (const k of Object.keys(map)) map[k] = [...new Set(map[k])];
  return map;
}

function suiteCoverage() {
  const src = read(path.join(ROOT, "extension", "js", "selftest.js"));
  const counts = {}; // tool name -> step count
  for (const m of src.matchAll(/tool:\s*["']([a-z_]+)["']/g)) {
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}

function generate() {
  const defs = loadToolDefs();
  const host = hostToolNames();
  const stubs = stubCoverage();
  const suite = suiteCoverage();

  const rows = defs.map(d => {
    const where = host.has(d.name) ? "host" : "panel";
    const stub = (stubs[d.name] || []).length;
    const steps = suite[d.name] || 0;
    // First sentence only: the full contract lives in tools.js.
    const oneLiner = String(d.desc || "").split(/\.\s/)[0]
      .replace(/\.$/, "").replace(/\|/g, "\\|");
    return { name: d.name, mutating: !!d.mutating, where, stub, steps,
             oneLiner };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const uncoveredStub = rows.filter(r => r.where === "host" && !r.stub)
    .map(r => r.name);
  const uncoveredSuite = rows.filter(r => r.where === "host" && !r.steps)
    .map(r => r.name);
  const orphanHost = [...host].filter(
    h => !defs.some(d => d.name === h)).sort();

  const lines = [];
  lines.push(BEGIN);
  lines.push("");
  lines.push("_Regenerate with `node scripts/capability-report.js` — " +
             "CI fails if this section is stale._");
  lines.push("");
  lines.push(`**${rows.length} tools** (${rows.filter(r => r.mutating).length} ` +
             `mutating, ${rows.filter(r => !r.mutating).length} read-only; ` +
             `${rows.filter(r => r.where === "host").length} host-side, ` +
             `${rows.filter(r => r.where === "panel").length} panel-side).`);
  lines.push("");
  lines.push("| Tool | Does | Writes | Side | Stub tests | Suite steps |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(`| \`${r.name}\` | ${r.oneLiner} | ${r.mutating ? "yes" : "no"} ` +
               `| ${r.where} | ${r.stub || "—"} | ${r.steps || "—"} |`);
  }
  lines.push("");
  lines.push("**Coverage gaps (computed):**");
  lines.push("");
  lines.push("- Host tools with NO stubbed test: " +
             (uncoveredStub.length ? uncoveredStub.map(n => "`" + n + "`").join(", ")
                                   : "none"));
  lines.push("- Host tools never exercised by the self-test suite: " +
             (uncoveredSuite.length ? uncoveredSuite.map(n => "`" + n + "`").join(", ")
                                    : "none"));
  if (orphanHost.length) {
    lines.push("- Host implementations NOT exposed in TOOL_DEFS (the model " +
               "cannot reach these): " +
               orphanHost.map(n => "`" + n + "`").join(", "));
  }
  lines.push("");
  lines.push(END);
  return lines.join("\n");
}

function main() {
  const check = process.argv.includes("--check");
  const block = generate();
  let doc = fs.existsSync(DOC) ? read(DOC) : "";
  const b = doc.indexOf(BEGIN);
  const e = doc.indexOf(END);
  if (b === -1 || e === -1) {
    if (check) {
      console.error("docs/CAPABILITIES.md is missing the generated-section " +
                    "markers. Run: node scripts/capability-report.js");
      process.exit(1);
    }
    throw new Error("Markers not found in docs/CAPABILITIES.md — the " +
                    "curated skeleton must exist first.");
  }
  const updated = doc.slice(0, b) + block + doc.slice(e + END.length);
  if (check) {
    // Compare CONTENT, not bytes: on Windows, git autocrlf checks the
    // doc out with CRLF while this script generates LF, so a byte
    // comparison failed every local run while CI stayed green — a check
    // that cries wolf on one platform trains people to ignore it.
    const norm = (t) => t.replace(/\r\n/g, "\n");
    if (norm(updated) !== norm(doc)) {
      console.error("docs/CAPABILITIES.md is STALE: the tool inventory no " +
                    "longer matches the code. Run: " +
                    "node scripts/capability-report.js  (then commit it)");
      process.exit(1);
    }
    console.log("capability doc is fresh");
    return;
  }
  fs.writeFileSync(DOC, updated);
  console.log("docs/CAPABILITIES.md regenerated");
}

main();
