// The rules block as data (WORKPLAN §24a, prompt-routing-DESIGN §3-§4,
// §13.1 and §13.5).
//
// Until 2026-09-16 the rules were one literal array inside
// buildSystemPrompt. Routing (§24b) needs to render SOME of them, so each
// bullet became a RULE_DEFS entry that says which tools own it, which
// tools it tells the model to call, and which it only names. Three
// things must hold for that move to be safe:
//
//   1. With no route, the prompt is the SAME BYTES as before the split.
//      Every ceiling and phrase pin was measured against those bytes.
//   2. The bullets render in their original order, sections intact.
//   3. Nothing is unclassified: a tool name in any bullet's text is an
//      owner, a `uses` or a `mentions`. An unclassified name is how a
//      routed prompt would tell the model to call a tool whose doc it
//      never rendered.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else console.log("ok  -", msg);
}

const src = fs.readFileSync(
  path.join(__dirname, "..", "extension", "js", "tools.js"), "utf8");
const win = {};
win.window = win;
new Function("window", src).call(win, win);
const Tools = win.Tools;
const RULES = Tools.RULE_DEFS;
const NAMES = Tools.TOOL_DEFS.map((t) => t.name);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------ 1. bytes
//
// Taken from the pre-split tools.js (c065a76) with the same calls. If you
// CHANGE rule or doc wording on purpose, re-measure the prompt as
// CLAUDE.md requires and replace the hash in the same commit, saying why.
// A move, a reorder of the data, or a new field must never change it.
const compact = Tools.buildSystemPrompt("", { compact: true });
const full = Tools.buildSystemPrompt("");
const COMPACT_SHA =
  "fc7c11db34f1a26384d3e9e46a626554cef6405def0e5c3fc5d154dcd969ee4c";
const FULL_SHA =
  "8dd323f33970d97eda2b27242cf55f336b8893ca9643a33d308c2803946b64f5";
assert(sha(compact) === COMPACT_SHA,
       "compact prompt is byte-identical to the pre-split one (" +
       compact.length + " chars, sha " + sha(compact).slice(0, 12) + ")");
assert(sha(full) === FULL_SHA,
       "full prompt is byte-identical to the pre-split one (" +
       full.length + " chars, sha " + sha(full).slice(0, 12) + ")");

// ------------------------------------------------------------ 2. shape
assert(RULES.length === 72, "72 bullets (" + RULES.length + ")");
assert(RULES.filter((r) => r.core).length === 21,
       "21 core bullets, DESIGN §4 (" +
       RULES.filter((r) => r.core).length + ")");
let ordered = true;
const ids = {};
for (let i = 0; i < RULES.length; i++) {
  if (RULES[i].order !== i + 1) ordered = false;
  if (ids[RULES[i].id]) assert(false, "duplicate rule id " + RULES[i].id);
  ids[RULES[i].id] = true;
}
assert(ordered, "RULE_DEFS sit in rendered order and `order` says so");
const sections = Tools.RULE_SECTIONS.map((s) => s.id);
let lastSec = -1, sectionsOk = true;
for (const r of RULES) {
  const k = sections.indexOf(r.section);
  if (k < lastSec || k < 0) sectionsOk = false;
  lastSec = k;
}
assert(sectionsOk, "every bullet names a known section, sections never " +
       "interleave");
const rulesText = full.split("\nAvailable tools:")[0];
let rendered = true;
for (const r of RULES) {
  if (rulesText.indexOf(r.lines.join("\n")) < 0) {
    rendered = false;
    assert(false, "bullet " + r.id + " renders verbatim");
  }
}
assert(rendered, "every bullet renders as one contiguous block");

// ------------------------------------------------------------ 3. closure
function namesIn(text) {
  return NAMES.filter((n) =>
    new RegExp("(^|[^a-z_])" + n + "([^a-z_]|$)").test(text));
}
let classified = true, known = true, owned = true;
for (const r of RULES) {
  const owners = r.owners || [], uses = r.uses || [],
        mentions = r.mentions || [];
  for (const n of owners.concat(uses, mentions)) {
    if (NAMES.indexOf(n) < 0) {
      known = false;
      assert(false, r.id + " classifies '" + n + "', which is no tool");
    }
  }
  for (const n of namesIn(r.lines.join("\n"))) {
    if (owners.indexOf(n) < 0 && uses.indexOf(n) < 0 &&
        mentions.indexOf(n) < 0) {
      classified = false;
      assert(false, r.id + " names " + n + " but does not classify it " +
             "(owners / uses / mentions)");
    }
  }
  for (const n of mentions) {
    if (namesIn(r.lines.join("\n")).indexOf(n) < 0) {
      classified = false;
      assert(false, r.id + " lists " + n + " in mentions but its text " +
             "never names it");
    }
  }
  if (!r.core && !owners.length && !(r.triggers || []).length) {
    owned = false;
    assert(false, r.id + " is not core, has no owner and no trigger — " +
           "a router could never render it");
  }
}
assert(known, "every classified name is a real tool");
assert(classified, "every tool name in every bullet is classified");
assert(owned, "every non-core bullet is reachable (an owner or a trigger)");

const byTool = Tools._rulesByTool;
assert(byTool.organize_project.indexOf("organize-preview") >= 0 &&
       byTool.add_mask.indexOf("soften-is-blur") >= 0,
       "a tool's rules are derived from RULE_DEFS owners (add_mask co-owns " +
       "the blur bullet, so a mask route reads it before the crop bullet)");

console.log(failures ? "\nFAILURES: " + failures :
            "\nAll prompt-rules checks passed");
process.exitCode = failures ? 1 : 0;
