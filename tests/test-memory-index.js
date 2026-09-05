// test-memory-index.js — docs/MEMORY.md must stay fresh and stay small.
//
// The index is the routing table into docs/WORKPLAN-LOG.md, which is a
// megabyte and growing ~16k tokens a night. Two ways it can fail, and
// both are silent:
//
//   1. STALE. The log grows and the index does not follow, so its line
//      ranges point at the wrong entries. A wrong line range is worse
//      than no line range: it retrieves something confidently.
//   2. FAT. An always-resident file that grows without bound stops being
//      resident, and then the whole structure is just another document
//      nobody reads.
//
// CI runs --check for (1) and the budget assertion covers (2).

"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const DOC = path.join(ROOT, "docs", "MEMORY.md");
const LOG = path.join(ROOT, "docs", "WORKPLAN-LOG.md");
const GEN = path.join(ROOT, "scripts", "memory-index.js");

let failures = [];
function check(name, ok, detail) {
  if (ok) { console.log("ok  - " + name); }
  else {
    console.log("FAIL- " + name + (detail ? ": " + detail : ""));
    failures.push(name);
  }
}

// --- fresh --------------------------------------------------------------
const res = cp.spawnSync(process.execPath, [GEN, "--check"],
                         { cwd: ROOT, encoding: "utf8" });
check("docs/MEMORY.md is regenerated from the current log",
      res.status === 0,
      ((res.stdout || "") + (res.stderr || "")).trim());

const doc = fs.readFileSync(DOC, "utf8");
const bytes = Buffer.byteLength(doc);

// --- small enough to stay resident --------------------------------------
// The index earns its place only by being cheap enough to always load.
// 3000 tokens is roughly a fifth of the panel's default 16384 window;
// past that, it is competing with the work.
const BUDGET = 3000;
const tokens = Math.round(bytes / 4);
check("the index fits its always-resident budget (" + tokens + " of " +
      BUDGET + " tokens)", tokens <= BUDGET);

// --- and the log it indexes is NOT something to read --------------------
// This is the fact the whole structure exists for. If the log ever gets
// small enough to read whole, this test should be revisited rather than
// silently passing on a premise that stopped being true.
const logTokens = Math.round(Buffer.byteLength(fs.readFileSync(LOG)) / 4);
check("the log is still far too large to read whole (" + logTokens +
      " tokens), so the index is still load-bearing", logTokens > 40000);

// --- the parts that make it usable --------------------------------------
check("it explains the memory tiers", /## |Pinned facts/.test(doc) &&
      doc.indexOf("WORKPLAN-LOG.md") !== -1);
check("it carries a corrections section",
      /Superseded \/ corrected/.test(doc));
check("it says what the corrections section deliberately omits",
      /deliberately not listed/.test(doc));
check("it routes by subsystem", /## By subsystem/.test(doc));
check("it tells the reader how to retrieve one entry",
      /sed -n '<START>,<END>p'/.test(doc));

// --- the line ranges must actually resolve ------------------------------
// A routing table whose pointers are wrong is the failure mode that
// matters most, and it is invisible without checking. Take every line
// range the index publishes and confirm the log really does start an
// entry there.
const logLines = fs.readFileSync(LOG, "utf8").split("\n");
const ranges = [...doc.matchAll(/`(\d+),(\d+)`/g)]
  .map(m => [parseInt(m[1], 10), parseInt(m[2], 10)]);
check("the index publishes line ranges", ranges.length > 10,
      "found " + ranges.length);

let badStart = 0, badOrder = 0;
for (const [a, b] of ranges) {
  const line = logLines[a - 1];
  if (typeof line !== "string" || !/^## /.test(line)) badStart++;
  if (!(b >= a)) badOrder++;
}
check("every published range starts on a real entry header",
      badStart === 0, badStart + " of " + ranges.length + " do not");
check("every published range is well-ordered", badOrder === 0);

// --- CRLF safety --------------------------------------------------------
// CI runs on windows-latest and git checks the log out with CRLF, so the
// generator must produce a byte-identical index either way. It did not:
// PR #68 went red with "docs/MEMORY.md is STALE" because every heading
// carried a trailing \r under the Windows checkout. Regenerate from a
// CRLF copy of the real log and require the same bytes.
{
  const lf = fs.readFileSync(LOG, "utf8");
  const before = fs.readFileSync(DOC, "utf8");
  let same = false, detail = "";
  try {
    fs.writeFileSync(LOG, lf.replace(/\r?\n/g, "\r\n"));
    cp.spawnSync(process.execPath, [GEN], { cwd: ROOT, encoding: "utf8" });
    const after = fs.readFileSync(DOC, "utf8");
    same = after === before;
    if (!same) { detail = before.length + " chars from LF vs " + after.length + " from CRLF"; }
  } finally {
    // Always put the working tree back, even if an assertion throws.
    fs.writeFileSync(LOG, lf);
    cp.spawnSync(process.execPath, [GEN], { cwd: ROOT, encoding: "utf8" });
  }
  check("the index is byte-identical from an LF and a CRLF checkout",
        same, detail);
  check("the working tree was restored after the CRLF probe",
        fs.readFileSync(DOC, "utf8") === before);
}

// --- the routing rule that caused a real miss ---------------------------
// 2026-09-03: a finding was written into the log alone, with the words
// "Filed in WORKPLAN" while no such filing existed. The loop takes work
// from the queue, so a fact in the log tier only is a fact nothing acts
// on. The index has to say this, or the structure invites the same miss.
check("it states that work-implying facts belong in the QUEUE, not here",
      /belongs in `docs\/WORKPLAN\.md`/.test(doc) &&
      /Filed in\s*\n?WORKPLAN/.test(doc.replace(/\s+/g, " ").replace(/ /g, " ")) ||
      /Filed in WORKPLAN/.test(doc.replace(/\s+/g, " ")));

console.log("");
if (failures.length) {
  console.log(failures.length + " FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
