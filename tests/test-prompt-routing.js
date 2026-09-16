// The router and the routed prompt (WORKPLAN §24b, prompt-routing-DESIGN
// §2, §3, §7 and §13). All stub-side: routing is deterministic, so every
// ceiling here is COMPUTED over the sentences that exist rather than
// guessed.
//
//   1. Off by default: promptRouting "all" (the shipped default) and a
//      route that matched nothing both give today's prompt byte for byte.
//   2. Ceilings: core-only, the worst routed sentence in chat-probe's
//      matrix, and every tool's own group (the tool, its rules, their
//      `uses`). A number moves only with a written reason.
//   3. Shape: every tool is either documented or named on the index
//      line, exactly once; the closure holds; bullets keep their order.
//   4. The sticky set, and the schema enum staying wide.
//   5. Both callers (main.js, chat-probe.js) decide through the one
//      Tools.promptOptsFor, so they cannot drift.
//   6. Per-round extension (§24c): what a round called or its results
//      named joins the next round's route, appended so the cached prefix
//      survives, capped so a tool list in a result cannot undo routing.
"use strict";
const fs = require("fs");
const path = require("path");

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else console.log("ok  -", msg);
}

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "extension", "js", "tools.js"),
                            "utf8");
const win = {};
win.window = win;
new Function("window", src).call(win, win);
const Tools = win.Tools;
const DEFS = Tools.TOOL_DEFS;
const { STEPS } = require("../scripts/chat-probe.js");

// Measured 18,672 on 2026-09-16 (§24c): the worst matrix sentence plus
// 12 result-named tools with the longest docs and 2 called ones. Still
// under half of today's whole prompt, and it leaves history at 12K.
const EXTENDED_WORST_CEILING = 19500;
const routed = (r, compact) =>
  Tools.buildSystemPrompt("", { compact: compact !== false, route: r });

// ------------------------------------------------------------ 1. off

const compactAll = Tools.buildSystemPrompt("", { compact: true });
assert(Tools.buildSystemPrompt("", { compact: true, route: "all" }) ===
         compactAll,
       "route: \"all\" renders today's compact prompt byte for byte");

const settingsSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "settings.js"), "utf8");
assert(/promptRouting: "all",/.test(settingsSrc),
       "the shipped default is promptRouting \"all\" until §24d flips it");

const off = Tools.promptOptsFor({ ctxSize: 16384, promptRouting: "all" },
                                "blur the background", []);
assert(!off.opts.route && off.routeInfo === null &&
       Tools.buildSystemPrompt("", off.opts) === compactAll,
       "promptOptsFor with routing off: no route, today's prompt");
const noMatch = Tools.promptOptsFor({ ctxSize: 16384, promptRouting: "auto" },
                                    "hmm", []);
assert(noMatch.routeInfo && noMatch.routeInfo.matched === false &&
       !noMatch.opts.route &&
       Tools.buildSystemPrompt("", noMatch.opts) === compactAll,
       "routing on but nothing matched: falls back to the whole prompt");
const on = Tools.promptOptsFor({ ctxSize: 16384, promptRouting: "auto" },
                               "blur the background", []);
assert(on.opts.route && on.opts.compact === true &&
       on.opts.route.picked.indexOf("apply_effect") !== -1,
       "routing on and matched: the route rides in opts");
assert(Tools.promptModeFor(32768, "auto").compact === false &&
       Tools.promptModeFor(32768, "auto").routed === true &&
       Tools.promptModeFor(16384).routed === false,
       "routed is its own axis: a 32K window gets full docs, still routed");

// ------------------------------------------------------------ 2. ceilings

const coreRoute = Tools.routeFor("hmm");
const core = routed({ tools: coreRoute.tools, rules: coreRoute.rules });
// Measured 7,826 on 2026-09-16 (DESIGN §5 estimated 7,959).
const CORE_CEILING = 8200;
assert(core.length <= CORE_CEILING,
       "core-only routed prompt " + core.length + " <= " + CORE_CEILING);

const sentences = [];
STEPS.forEach((step) => {
  for (const v of [{ say: step.say }].concat(step.variants || [])) {
    sentences.push(v.say);
  }
});
let worst = 0, worstSay = "";
for (const say of sentences) {
  const r = Tools.routeFor(say);
  if (!r.matched) continue;
  const len = routed(r).length;
  if (len > worst) { worst = len; worstSay = say; }
}
// Measured 11,549 over 101 sentences on 2026-09-16 (the matte step).
// DESIGN §13.3 set 14,000 against an estimated 13,154.
const ROUTED_WORST_CEILING = 14000;
console.log("   worst routed prompt " + worst + " chars: \"" + worstSay + "\"");
assert(worst > 0 && worst <= ROUTED_WORST_CEILING,
       "worst routed prompt over " + sentences.length + " matrix sentences " +
       worst + " <= " + ROUTED_WORST_CEILING);
assert(worst < compactAll.length / 3,
       "and it is under a third of today's " + compactAll.length);

// One tool's group: the tool, every bullet it owns, their uses closure.
function groupOf(name) {
  const tools = new Set(Tools.CORE_TOOLS.concat([name]));
  const rules = new Set();
  for (const d of Tools.RULE_DEFS) {
    if (d.core || (d.owners || []).indexOf(name) !== -1) rules.add(d.id);
  }
  for (const d of Tools.RULE_DEFS) {
    if (rules.has(d.id)) (d.uses || []).forEach((u) => tools.add(u));
  }
  return { tools: Array.from(tools), rules: Array.from(rules) };
}
const groups = DEFS.map((t) => [routed(groupOf(t.name)).length, t.name])
  .sort((a, b) => b[0] - a[0]);
console.log("   biggest groups: " +
            groups.slice(0, 5).map((g) => g[1] + " " + g[0]).join(", "));
const GROUP_CEILING = 12500;
assert(groups[0][0] <= GROUP_CEILING,
       "every tool's group renders <= " + GROUP_CEILING + " (" +
       groups[0][1] + " " + groups[0][0] + ")");

// DESIGN §13.9: the starve rows, worst routed prompt plus a real state.
for (const ctx of [16384, 12288]) {
  const hb = Tools.historyBudget(ctx, worst + 6026);
  assert(hb.chars >= 2000 && !hb.starved,
         "at " + ctx + " the worst routed prompt + state leaves " +
         hb.chars + " chars of history (>= 2000)");
}

// ------------------------------------------------------------ 3. shape

let shapeBad = [];
let closureBad = [];
for (const say of sentences.concat(["hmm"])) {
  const r = Tools.routeFor(say);
  const p = routed({ tools: r.tools, rules: r.rules });
  // Docs only: a rule bullet may start with a tool name too.
  const docs = p.slice(p.indexOf("\nAvailable tools:"));
  const idx = p.split("\n").filter((l) => /^Other tools /.test(l));
  const indexed = idx.length ? idx[0].replace(/^[^:]*: /, "").split(", ")
                             : [];
  for (const t of DEFS) {
    const docd = docs.indexOf("\n- " + t.name + " ") !== -1;
    const inIdx = indexed.indexOf(t.name) !== -1;
    if (docd === inIdx) shapeBad.push(say + ": " + t.name);
    if (docd !== (r.tools.indexOf(t.name) !== -1)) {
      shapeBad.push(say + ": " + t.name + " rendered != routed");
    }
  }
  for (const d of Tools.RULE_DEFS) {
    if (r.rules.indexOf(d.id) === -1) continue;
    for (const u of d.uses || []) {
      if (r.tools.indexOf(u) === -1) closureBad.push(d.id + " uses " + u);
    }
  }
  for (const n of Tools.CORE_TOOLS) {
    if (r.tools.indexOf(n) === -1) closureBad.push(say + ": core " + n);
  }
}
assert(shapeBad.length === 0,
       "every tool is documented or on the index line, exactly once" +
       (shapeBad.length ? " (" + shapeBad.slice(0, 5).join("; ") + ")" : ""));
assert(closureBad.length === 0,
       "closure: every rendered bullet's uses and the core set render" +
       (closureBad.length ? " (" + closureBad.slice(0, 5).join("; ") + ")"
                          : ""));
assert(core.indexOf("- Use ONLY the tools listed below.") !== -1 &&
       /\nOther tools \(call one and the host explains its args\): /
         .test(core),
       "the routed form keeps 'Use ONLY the tools listed below' and adds " +
       "the index line");

// DESIGN §7: for random routed sets, rendered bullets keep their order.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) /
                    2147483648);
let orderBad = 0;
for (let n = 0; n < 200; n++) {
  const rules = Tools.RULE_DEFS.filter((d) => d.core || rand() < 0.3);
  const p = routed({ tools: [], rules: rules.map((d) => d.id) });
  let at = -1;
  for (const d of rules.slice().sort((a, b) => a.order - b.order)) {
    const pos = p.indexOf(d.lines.join("\n"), at + 1);
    if (pos <= at) { orderBad++; break; }
    at = pos;
  }
}
assert(orderBad === 0,
       "200 random routed sets render their bullets in original order");

// ------------------------------------------------------------ 4. sticky

const hist = [
  { role: "user", content: "make a red solid" },
  { role: "assistant", content: '{"reply":"ok","commands":' +
    '[{"tool":"add_solid","args":{"name":"Red"}}]}' },
  { role: "user", content: "make them blue instead" }
];
const sticky = Tools.routeFor("make them blue instead", hist);
assert(sticky.matched && sticky.picked.indexOf("add_solid") !== -1 &&
       sticky.scores.add_solid >= 2,
       "sticky: a tool the last assistant turn called is routed");
const old = [{ role: "assistant", content: '{"commands":[{"tool":"add_solid"}]}' }]
  .concat([1, 2, 3].map(() => ({ role: "assistant", content: '{"commands":[]}' })));
assert(!Tools.routeFor("xyzzy", old).scores.add_solid,
       "sticky looks back three assistant turns, not four");
assert(!Tools.routeFor("xyzzy", [{ role: "assistant",
         content: '{"commands":[{"tool":"not_a_tool"}]}' }]).matched,
       "an unknown name in history is not sticky");
const many = Tools.routeFor("blur fade move rotate scale text mask shape " +
  "solid null camera light parent matte render import precompose");
assert(many.picked.length <= 12, "a route picks at most 12 scored tools (" +
       many.picked.length + ")");

const enumNames = Tools.RESPONSE_SCHEMA.properties.commands.items
  .properties.tool.enum;
assert(enumNames.length === DEFS.length,
       "the schema enum stays wide under routing (" + enumNames.length + ")");

// ------------------------------------------------------------ 5. callers

const mainSrc = fs.readFileSync(path.join(ROOT, "extension", "js", "main.js"),
                                "utf8");
const probeSrc = fs.readFileSync(path.join(ROOT, "scripts", "chat-probe.js"),
                                 "utf8");
for (const [label, s] of [["main.js", mainSrc], ["chat-probe.js", probeSrc]]) {
  assert(/Tools\.promptOptsFor\(s, text, history\)/.test(s) &&
         !/buildSystemPrompt\(\s*stateJson,\s*(global\.)?Tools\.promptModeFor/
           .test(s),
         label + " builds its prompt through Tools.promptOptsFor");
}
assert(/argValue\("--route"\)/.test(probeSrc),
       "chat-probe mirrors the setting as --route auto|all");

// ------------------------------------------------------------ 6. per-round extension (§24c)

// The sticky set reads the reply as the model WRITES it. The regex once
// had `s*` for `\s*`, so it only matched unspaced JSON — the stub above
// is unspaced, real replies are not.
const spaced = [{ role: "assistant",
  content: '{"reply": "ok", "commands": [{"tool": "add_solid", "args": {}}]}' }];
assert(Tools.routeFor("make them blue instead", spaced).scores.add_solid === 2,
       "sticky reads a spaced reply (\"tool\": \"add_solid\")");

const S = { ctxSize: 16384, promptRouting: "auto" };
const po0 = Tools.promptOptsFor(S, "add a blur to the logo", []);
const r0 = po0.opts.route;
assert(r0 && r0.matched, "the extension fixture routes");
const docs = (p, name) => p.indexOf("\n- " + name + " ") !== -1;
const outside = DEFS.map(d => d.name).filter(n =>
  r0.tools.indexOf(n) === -1 && Tools.CORE_TOOLS.indexOf(n) === -1);
const [calledOut, namedOut, laterOut] = outside;
const p0 = Tools.buildSystemPrompt("{}", po0.opts);

assert(!Tools.extendPromptOpts(po0, [{ tool: r0.tools[0] }], "ok") &&
       po0.opts.route === r0,
       "a round that adds nothing already rendered leaves the route alone");
const offPo = Tools.promptOptsFor({ ctxSize: 16384, promptRouting: "all" },
                                  "add a blur", []);
assert(!Tools.extendPromptOpts(offPo, [{ tool: calledOut }], calledOut) &&
       !offPo.opts.route,
       "routing off: nothing to extend, the whole prompt stays");

assert(Tools.extendPromptOpts(po0, [{ tool: calledOut }],
         '[{"ok":false,"error":"To do that: ' + namedOut + '"}]'),
       "a called tool and a result-named tool grow the route");
const r1 = po0.opts.route;
assert(r1 !== r0 && !r0.extended, "extension replaces the route, never mutates it");
assert(r1.extended.join() === [calledOut, namedOut].join(),
       "called first, then result-named: " + r1.extended.join());
assert(po0.routeInfo === r1, "routeInfo follows, so the probe logs the grown set");
const p1 = Tools.buildSystemPrompt("{}", po0.opts);
assert(docs(p1, calledOut) && docs(p1, namedOut),
       "both extension tools render their docs");
const idx1 = p1.split("\n").find(l => /^Other tools/.test(l)) || "";
assert(!new RegExp("[ ,]" + calledOut + "(,|$)").test(idx1) &&
       !new RegExp("[ ,]" + namedOut + "(,|$)").test(idx1),
       "an extension tool leaves the index line (named exactly once)");
const cut0 = p0.indexOf("\nOther tools");
assert(cut0 > 0 && p1.slice(0, cut0) === p0.slice(0, cut0),
       "round 1 keeps round 0's whole prefix up to the index line (cache)");
assert(Tools.extendPromptOpts(po0, [{ tool: laterOut }], ""),
       "a later round extends again");
const p2 = Tools.buildSystemPrompt("{}", po0.opts);
const cut1 = p1.indexOf("\nOther tools");
assert(p2.slice(0, cut1) === p1.slice(0, cut1) &&
       p2.indexOf("\n- " + namedOut) < p2.indexOf("\n- " + laterOut),
       "and appends after the earlier extension, prefix intact");

assert(!Tools.extendPromptOpts(po0, [{ tool: "not_a_tool" }], "not_a_tool") &&
       !Tools.extendPromptOpts(po0, [], "the calledOut layer, apply effectx"),
       "unknown names and near-misses extend nothing");

// A result that names every tool (a grounded list) cannot bring the
// whole prompt back: result-named additions stop at the route cap.
const poCap = Tools.promptOptsFor(S, "add a blur to the logo", []);
Tools.extendPromptOpts(poCap, [], DEFS.map(d => d.name).join(", "));
const named = poCap.opts.route.extended.length;
Tools.extendPromptOpts(poCap, [], DEFS.map(d => d.name).join(", "));
assert(named === 12 && poCap.opts.route.extended.length === 12,
       "result-named extension caps at 12 per turn (" + named + ")");
assert(Tools.extendPromptOpts(poCap, [{ tool: outside[outside.length - 1] }], "") ||
       poCap.opts.route.extended.indexOf(outside[outside.length - 1]) !== -1,
       "a CALLED tool still joins past the cap");
// The ceiling is priced on the WORST matrix sentence extended by the 12
// result-named tools with the longest docs, plus two called ones.
const poWorst = Tools.promptOptsFor(S, worstSay, []);
const longest = DEFS.filter(d => poWorst.opts.route.tools.indexOf(d.name) === -1)
  .map(d => [Tools.buildSystemPrompt("", { compact: true, route: {
     tools: poWorst.opts.route.tools, rules: poWorst.opts.route.rules,
     extended: [d.name] } }).length, d.name])
  .sort((a, b) => b[0] - a[0]).map(x => x[1]);
Tools.extendPromptOpts(poWorst, [{ tool: longest[12] }, { tool: longest[13] }],
                       longest.slice(0, 12).join(" "));
const capPrompt = Tools.buildSystemPrompt("", poWorst.opts);
console.log("   worst sentence extended to the cap: " + capPrompt.length +
            " chars (+" + poWorst.opts.route.extended.length + " tools)");
assert(capPrompt.length <= EXTENDED_WORST_CEILING,
       "a turn extended to the cap stays <= " + EXTENDED_WORST_CEILING +
       " chars (" + capPrompt.length + ")");
for (const ctx of [16384, 12288]) {
  const hb = Tools.historyBudget(ctx, capPrompt.length + 6026);
  assert(hb.chars >= 2000 && !hb.starved,
         "at " + ctx + " the capped extension + state leaves " + hb.chars +
         " chars of history (>= 2000)");
}

if (failures) {
  console.error("\n" + failures + " prompt-routing check(s) FAILED");
  process.exit(1);
}
console.log("\nAll prompt-routing checks passed");
