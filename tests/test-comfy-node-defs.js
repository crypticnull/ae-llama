// Regression test: scripts/comfy-node-defs.json is a PARTIAL index, and
// nothing may read it as a total one (WORKPLAN 17l-b).
//
// The file is a demand harvest: harvest-comfy-node-defs.py records only the
// classes some workflow named - 52 of the 3487 the author's install defined.
// That is right for its one job (adapt-workflow.js needs ordered inputs for
// the nodes a template uses). It went wrong on 2026-09-16 when 18 P7c step 2
// asked it "does this backend have LTX nodes", read zero, and built a filed
// item on that zero. The running backend had 30 LTX classes, all core.
//
// The bug class is "a partial index read as a total one", so this pins:
//   1. the file SAYS it is partial (recorded count beside the install count,
//      and a comment that sends existence questions to /object_info);
//   2. the harvester keeps writing both, so a re-harvest cannot drop them;
//   3. a lookup of an unrecorded class THROWS, naming /object_info, instead
//      of returning undefined for a caller to read as "no such node";
//   4. adapt-workflow.js reads defs only through that lookup.
"use strict";

const fs = require("fs");
const path = require("path");
const { defOf } = require("../scripts/adapt-workflow.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ok   " + msg); }
  else { failures++; console.log("  FAIL " + msg); }
}

const REPO = path.join(__dirname, "..");
const defsFile = path.join(REPO, "scripts", "comfy-node-defs.json");
const defs = JSON.parse(fs.readFileSync(defsFile, "utf8"));
const held = Object.keys(defs.defs);

console.log("1. the file says it is a partial harvest");
assert(defs.classes_recorded === held.length,
       "classes_recorded (" + defs.classes_recorded + ") is the number of " +
       "defs actually held (" + held.length + ")");
assert(typeof defs.class_count === "number" &&
       defs.class_count !== defs.classes_recorded,
       "class_count (" + defs.class_count + ") and classes_recorded are " +
       "different numbers, so neither can pass for the other");
assert(/\/object_info/.test(defs._comment) && /NOT a complete/.test(defs._comment),
       "_comment says it is not a complete node list and names /object_info");

console.log("2. the harvester writes both, so a re-harvest keeps them");
const py = fs.readFileSync(
  path.join(REPO, "scripts", "harvest-comfy-node-defs.py"), "utf8");
assert(/"classes_recorded":\s*len\(defs\)/.test(py),
       "harvest-comfy-node-defs.py writes classes_recorded from what it held");
assert(/\/object_info/.test(py),
       "harvest-comfy-node-defs.py's _comment names /object_info");

console.log("3. an unrecorded class is refused, not answered by absence");
assert(defOf(defs, held[0]) === defs.defs[held[0]],
       "a recorded class returns its definition");
// LTXVScheduler is core and exists on the managed backend (measured
// 2026-09-16); it is exactly the class the false NO was about.
assert(held.indexOf("LTXVScheduler") === -1,
       "precondition: LTXVScheduler is not recorded in the harvest");
let err = null;
try { defOf(defs, "LTXVScheduler", "node 7"); } catch (e) { err = e; }
assert(err !== null, "looking up an unrecorded class throws");
assert(err && /\/object_info/.test(err.message),
       "the refusal sends an existence question to /object_info");
assert(err && /does NOT mean the class is missing/.test(err.message),
       "the refusal says absence is not non-existence");
assert(err && err.message.indexOf(held.length + " classes recorded of " +
                                  defs.class_count) !== -1,
       "the refusal names both counts");
assert(err && /node 7/.test(err.message), "the refusal names the caller's node");

console.log("4. adapt-workflow.js reads defs only through defOf");
const src = fs.readFileSync(
  path.join(REPO, "scripts", "adapt-workflow.js"), "utf8");
const raw = src.split(/\r?\n/).filter((l) => /\.defs\[/.test(l));
assert(raw.length === 1 && /defs\.defs && defs\.defs\[classType\]/.test(raw[0]),
       "the only raw .defs[ index is inside defOf (found " + raw.length + ")");

if (failures) {
  console.log("\n" + failures + " failure(s)");
  process.exit(1);
}
console.log("\nall comfy-node-defs assertions passed");
