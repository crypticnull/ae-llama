// Per-tool triggers and the router's match step (WORKPLAN §24a NEXT UP 9b,
// prompt-routing-DESIGN §2, §13.7 and §13.8).
//
// A routed prompt renders only the tools a sentence's words point at, so
// a tool whose triggers miss the user's phrasing is a tool the model
// never reads about. Three things are pinned here, all without a model:
//
//   1. The trigger lint (§13.8): every tool has at least 3 triggers; a
//      trigger is lower-case words and digits only; no phrase (after the
//      matcher's own normalising) belongs to more than 3 tools.
//   2. The matcher itself: stemming, the one-edit typo pass, the literal
//      tool name.
//   3. Router recall (§13.7) over every chat-probe sentence, canonical
//      and paraphrase: each routes to a set holding every tool its step
//      `expects`, or matches nothing at all and falls back to today's
//      whole prompt. Recall must be 100%; the fall-through count is
//      pinned and may only go DOWN as triggers are added.
//
// Recall runs through the real router, Tools.routeFor (§24b): top 12 by
// score, the core set, and the `uses` closure of every rule an owner
// brings in. Its ceilings live in tests/test-prompt-routing.js.
"use strict";
const fs = require("fs");
const path = require("path");

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
const DEFS = Tools.TOOL_DEFS;
const { STEPS } = require("../scripts/chat-probe.js");

// ------------------------------------------------------------ 1. lint

const short = DEFS.filter((t) => !Array.isArray(t.triggers) ||
                                 t.triggers.length < 3);
assert(short.length === 0,
       "every tool has at least 3 triggers" +
       (short.length ? " (short: " + short.map((t) => t.name) + ")" : ""));

const badShape = [];
const dupWithin = [];
const owners = {};
for (const t of DEFS) {
  const seen = {};
  for (const p of t.triggers || []) {
    if (!/^[a-z0-9]+( [a-z0-9]+)*$/.test(p)) badShape.push(t.name + ": " + p);
    const key = Tools._triggerWords(p).map((w) => w.stem).join(" ");
    if (seen[key]) dupWithin.push(t.name + ": " + p);
    seen[key] = true;
    (owners[key] = owners[key] || []).push(t.name);
  }
}
assert(badShape.length === 0,
       "triggers are lower-case words and digits, single-spaced" +
       (badShape.length ? " (" + badShape.join("; ") + ")" : ""));
assert(dupWithin.length === 0,
       "no tool lists the same phrase twice after stemming" +
       (dupWithin.length ? " (" + dupWithin.join("; ") + ")" : ""));
const crowded = Object.keys(owners).filter((k) => owners[k].length > 3);
assert(crowded.length === 0,
       "no trigger phrase belongs to more than 3 tools" +
       (crowded.length ? " (" + crowded.map((k) => k + " -> " +
                                           owners[k]).join("; ") + ")" : ""));
assert(Tools.CORE_TOOLS.length === 9 &&
       Tools.CORE_TOOLS.every((n) => DEFS.some((t) => t.name === n)),
       "CORE_TOOLS names the nine DESIGN §5 tools, all real");

// ------------------------------------------------------------ 2. matcher

const s = (text) => Tools.scoreTriggers(text).tools;
assert(["fade", "fades", "faded", "fading"].every((w) => s("the " + w)
         .set_keyframes === 1),
       "stemming: fade / fades / faded / fading all hit the 'fade' trigger");
assert(s("parnet Beta to teh Rig null").set_layer_parent >= 1,
       "a six-letter transposition ('parnet') still matches 'parent'");
assert(!s("gird the icons").grid_layout,
       "a four-letter typo is NOT fuzzy-matched ('gird' is not 'grid')");
assert(s("move to the back of the stack").reorder_layers >= 1 &&
       !s("stacks of paper").set_keyframes,
       "whole words only, and an unrelated word scores nothing");
assert(s("call reorder_layers on it").reorder_layers >= 10,
       "the tool's own name typed literally scores +10");
assert(s("Beta shouldn't show up").set_layer_timing === 2,
       "a two-word phrase scores 2; the apostrophe does not split words");
assert(Tools.scoreTriggers("hmm").matched === false,
       "a sentence with no trigger reports matched: false");
assert(Tools.scoreTriggers("it's a mess").rules.indexOf("clean-comp-ask") !==
         -1,
       "rule triggers fire too (clean-comp-ask)");

// ------------------------------------------------------------ 3. recall

const byName = {};
DEFS.forEach((t, i) => { byName[t.name] = i; });
function route(text) {
  const r = Tools.routeFor(text);
  return { matched: r.matched, tools: new Set(r.tools),
           rules: new Set(r.rules), picked: r.picked };
}

const sentences = [];
const exempt = [];
STEPS.forEach((step, i) => {
  const all = [{ kind: "canonical", say: step.say }]
    .concat(step.variants || []);
  if (step.carry) { exempt.push(i + " " + step.title); return; }
  for (const v of all) sentences.push({ step: i, title: step.title, v,
                                        expects: step.expects,
                                        expectsRules: step.expectsRules });
});

const noExpects = STEPS.filter((st) => !st.carry && !Array.isArray(st.expects));
assert(noExpects.length === 0,
       "every chat-probe step carries expects: [...] metadata");
const unknown = [];
STEPS.forEach((st) => (st.expects || []).forEach((n) => {
  if (!(n in byName)) unknown.push(st.title + ": " + n);
}));
assert(unknown.length === 0, "every expected tool exists" +
       (unknown.length ? " (" + unknown.join("; ") + ")" : ""));
const toolMismatch = STEPS.filter((st) => st.tool &&
  (st.expects || []).indexOf(st.tool) === -1);
assert(toolMismatch.length === 0,
       "a step's graded `tool` is among its expects");

const missed = [];
const fell = [];
let biggest = 0;
for (const x of sentences) {
  const r = route(x.v.say);
  if (!r.matched) { fell.push(x); continue; }
  biggest = Math.max(biggest, r.picked.length);
  const lost = (x.expects || []).filter((n) => !r.tools.has(n))
    .concat((x.expectsRules || []).filter((id) => !r.rules.has(id)));
  if (lost.length) {
    missed.push("step " + x.step + " " + x.v.kind + " \"" + x.v.say +
                "\" lost " + lost.join(",") + " (routed " +
                r.picked.join(",") + ")");
  }
}
console.log("   " + sentences.length + " sentences, " + fell.length +
            " fall through to the whole prompt, largest routed pick " +
            biggest + "; exempt (carry, needs the sticky set): " +
            exempt.join("; "));
for (const f of fell) {
  console.log("   fall-through: step " + f.step + " " + f.v.kind + " \"" +
              f.v.say + "\"");
}
assert(missed.length === 0,
       "router recall is 100%: every matched sentence routes its expected " +
       "tools" + (missed.length ? "\n  " + missed.join("\n  ") : ""));

// Pinned at today's count. Lower it when a trigger closes one; raising it
// needs a written reason. DESIGN §13.7 caps it at 10 percent.
const FALL_THROUGH_PIN = 1;
assert(fell.length <= FALL_THROUGH_PIN,
       "fall-through " + fell.length + " <= pin " + FALL_THROUGH_PIN);
assert(fell.length <= Math.floor(sentences.length * 0.10),
       "fall-through stays within 10 percent of " + sentences.length +
       " sentences");

if (failures) {
  console.error("\n" + failures + " prompt-trigger check(s) FAILED");
  process.exit(1);
}
console.log("\nAll prompt-trigger checks passed");
