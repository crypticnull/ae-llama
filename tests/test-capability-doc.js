// Regression test: docs/CAPABILITIES.md's generated tool inventory must
// match the code. A capability list that rots is worse than none -- it
// answers "what can the panel do?" wrongly with confidence. This suite
// already caught one real miss on day one: the feature track queued
// building `precompose`/`add_marker`/`add_to_render_queue`, all of which
// ALREADY EXISTED but were invisible because no single document listed
// the tools.
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const r = spawnSync(process.execPath,
  [path.join(__dirname, "..", "scripts", "capability-report.js"), "--check"],
  { encoding: "utf8" });

if (r.status !== 0) {
  console.error("FAIL:", (r.stderr || r.stdout || "").trim());
  console.error("\nTESTS FAILED");
  process.exitCode = 1;
} else {
  console.log("ok  - capability doc matches the code");
  console.log("\nALL TESTS PASSED");
}
