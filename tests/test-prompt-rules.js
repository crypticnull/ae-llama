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
// Re-pinned 2026-09-17 (NEXT UP 37): "Match width/height to the target
// comp when it makes sense" -> "Omit width/height unless the user or a
// comp sets a size", after the model sent 1920x1080 with no comp and H3
// took 442 s instead of 153 s. 39803 -> 39801 / 58933 -> 58931 chars.
// Re-pinned 2026-09-17 (NEXT UP 40a): set_track_matte's args name each
// role ("the layer to be seen" / "the text/logo whose shape it shows
// through"), the through-is-matte rule gains "X in the shape of Y" and
// drops the glosses the args now carry. 7B at 12K routed, step 27 x4
// phrasings: 7/16 pass before, 24/24 after. 39801 -> 39797 / 58931 ->
// 58927 chars.
// Re-pinned 2026-09-17 (NEXT UP 42b/42c): the rolled-back rule "resend
// the commands that CAN succeed (without the one that failed)" ->
// "resend what CAN succeed (swap the failed one for any call its error
// names)". 7B routed step 34 x10 at 12K: 23 -> 31 of 40; paired 16K
// matrix B/D r1+r2 same night: mean pass 69 vs 68.5, no pass/pass row
// HARM/HARM. Lengths unchanged (39797 / 58927 chars).
const compact = Tools.buildSystemPrompt("", { compact: true });
const full = Tools.buildSystemPrompt("");
const COMPACT_SHA =
  "2ea5dd6e92fce795eed00807788f4f2b78ca2c058a8b4f05693e62cedc512374";
const FULL_SHA =
  "dc605648cc7ec84fd197f635b52f341c907d2e10aae88c4144001b204bfa2146";
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

// NEXT UP 40a: the 7B at 12K routed swapped matte roles (layer 3 =
// matteLayer 3, or HELLO matted by Beta) while its compact doc said only
// "Use one layer as another's track matte" and the args glossed one side
// as "the layer being matted". Both args must say which side is which in
// plain words, and a trigger phrase the model has to map ("in the shape
// of") must reach the rule it is routed to.
const matteArgs = Tools.TOOL_DEFS.filter((t) => t.name === "set_track_matte")[0].args;
assert(/layer\?: name\|index \([^)]*seen/.test(matteArgs) &&
       /matteLayer: name\|index \([^)]*shows through/.test(matteArgs),
       "set_track_matte args name both roles: 'layer' is seen, " +
       "'matteLayer' is the shape it shows through");
const vague = Tools.promptOptsFor({ ctxSize: 12288, promptRouting: "auto" },
  "Beta should appear in the shape of the word HELLO", []);
const vaguePrompt = Tools.buildSystemPrompt("", vague.opts);
assert(vague.routeInfo.picked.indexOf("set_track_matte") >= 0 &&
       /X in the shape of Y' =\s+set_track_matte \{layer: X, matteLayer: Y/
         .test(vaguePrompt),
       "'in the shape of' routes to set_track_matte AND its rule maps the " +
       "phrase to the roles");

console.log(failures ? "\nFAILURES: " + failures :
            "\nAll prompt-rules checks passed");
process.exitCode = failures ? 1 : 0;
