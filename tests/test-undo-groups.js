// Regression test: undo hygiene — one chat command, one Ctrl+Z.
//
// Measured in AE 2026 (the facts this file encodes):
//
//  1. Every single AELL_call already collapses into exactly ONE undo step.
//     Verified across grid_layout, set_keyframes, stagger_layers,
//     distribute_property, for_each_layer, duplicate_layer,
//     reorder_layers, scale_comp, split_layer_into_chunks,
//     set_track_matte, precompose, add_mask and center_anchor_point.
//
//  2. An undo group does NOT survive the end of the script execution that
//     opened it. Open a group in one script run, change something in the
//     next, and the first change is ALREADY its own undo step — measured
//     by moving one layer per run and undoing once: only the second move
//     came back. So bracketing a chat round with separate begin/end
//     evalScripts cannot work. Tools that must share a Ctrl+Z have to run
//     inside ONE call, which is what AELL_callBatch is for.
//
//  3. Consequence, and the bug: a chat command that takes five tool calls
//     cost the user FIVE Ctrl+Z, because the panel sent one evalScript per
//     command. executeCommands now fuses consecutive host commands into a
//     single AELL_callBatch.
//
// Three halves (sorry): the host's grouping, the panel's fusion, and an
// anti-drift check that the two hand-maintained "this tool mutates" tables
// still agree — a mutating tool missing from AELL_MUTATING loses its undo
// LABEL, and the panel's copy decides what a dry run is allowed to skip.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HOST = path.join(ROOT, "extension", "jsx", "hostscript.jsx");
const TOOLS = path.join(ROOT, "extension", "js", "tools.js");
const hostSrc = fs.readFileSync(HOST, "utf8");
const toolsSrc = fs.readFileSync(TOOLS, "utf8");

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------------------ stubbed AE
//
// The only part of AE this file needs is the undo bookkeeping, so the stub
// records it: `depth` is how many groups are open right now, `opened` is
// every group name that was begun, and an unbalanced end() is an error the
// way AE would treat it (there is nothing to close).

const undoLog = { depth: 0, opened: [], unbalanced: 0 };
const app = {
  project: { numItems: 0, item() { return null; }, items: {} },
  beginUndoGroup(name) { undoLog.depth++; undoLog.opened.push(name); },
  endUndoGroup() {
    if (undoLog.depth === 0) { undoLog.unbalanced++; return; }
    undoLog.depth--;
  }
};
function resetUndo() {
  undoLog.depth = 0; undoLog.opened.length = 0; undoLog.unbalanced = 0;
}

function CompItem() {} function FolderItem() {} function FootageItem() {}
function TextLayer() {} function ShapeLayer() {} function CameraLayer() {}
function LightLayer() {} function AVLayer() {} function SolidSource() {}
const ParagraphJustification = {};
const $ = { global: {} };

// This file is "use strict", so eval() gets its OWN variable scope and
// hostscript's `var` declarations do not leak out.
const host = eval(hostSrc + ";\n({ AELL_TOOLS: AELL_TOOLS, " +
  "AELL_MUTATING: AELL_MUTATING, AELL_okay: AELL_okay, " +
  "AELL_NO_UNDO_GROUP: AELL_NO_UNDO_GROUP })");
const { AELL_TOOLS, AELL_MUTATING, AELL_okay, AELL_NO_UNDO_GROUP } = host;

// Probe tools: the dispatcher is what carries the undo grouping, so drive
// it with tools whose behaviour is known exactly rather than with real
// ones that would need half of AE stubbed to run.
const ran = [];
AELL_TOOLS.__mut = function (a) {
  ran.push({ tool: "__mut", tag: a.tag, depth: undoLog.depth });
  return AELL_okay({ tag: a.tag });
};
AELL_TOOLS.__read = function (a) {
  ran.push({ tool: "__read", tag: a.tag, depth: undoLog.depth });
  return AELL_okay({ tag: a.tag });
};
AELL_TOOLS.__boom = function () {
  ran.push({ tool: "__boom", depth: undoLog.depth });
  throw new Error("tool exploded");
};
AELL_MUTATING.__mut = true;
AELL_MUTATING.__boom = true;

const callOne = (t, a) => JSON.parse($.global.AELL_call(t, JSON.stringify(a)));
const callBatch = (cmds) =>
  JSON.parse($.global.AELL_callBatch(JSON.stringify(cmds)));

// ------------------------------------------- 1. one call, one undo group

resetUndo(); ran.length = 0;
const one = callOne("__mut", { tag: "a" });
assert(one.ok && undoLog.opened.length === 1,
       "a mutating tool opens exactly one undo group");
assert(undoLog.depth === 0 && undoLog.unbalanced === 0,
       "and closes it (depth " + undoLog.depth + ")");
assert(undoLog.opened[0] === "AE Llama: __mut",
       "named for the tool: " + undoLog.opened[0]);
assert(ran[0].depth === 1, "the tool really ran INSIDE the group");

resetUndo();
callOne("__read", { tag: "r" });
assert(undoLog.opened.length === 0,
       "a read-only tool opens no undo group at all");

resetUndo();
const threw = callOne("__boom", {});
assert(!threw.ok && /exploded/.test(threw.error),
       "a tool that throws comes back as an error result");
assert(undoLog.depth === 0 && undoLog.opened.length === 1,
       "and its undo group is still closed — AE is not left recording");

resetUndo();
const unknown = callOne("__nope", {});
assert(!unknown.ok && /Unknown tool/.test(unknown.error),
       "unknown tool still refused by name: " + unknown.error);
assert(undoLog.opened.length === 0, "and opens no group");

// ------------------------------------ 2. one BATCH, still one undo group

resetUndo(); ran.length = 0;
const b = callBatch([
  { tool: "__mut", args: { tag: "a" } },
  { tool: "__mut", args: { tag: "b" } },
  { tool: "__read", args: { tag: "c" } },
  { tool: "__mut", args: { tag: "d" } }
]);
assert(b.ok, "batch succeeds: " + (b.error || ""));
assert(undoLog.opened.length === 1,
       "FOUR tools cost ONE undo group (got " + undoLog.opened.length + ")");
assert(undoLog.depth === 0 && undoLog.unbalanced === 0,
       "the single group is balanced");
assert(ran.length === 4 && ran.every(r => r.depth === 1),
       "every tool ran inside that one group");
assert(b.data.results.length === 4, "one result row per command");
assert(b.data.results.map(r => r.data.tag).join(",") === "a,b,c,d",
       "results come back in the order asked for");
assert(/^AE Llama: __mut \+3 more$/.test(undoLog.opened[0]),
       "the undo entry names the batch: " + undoLog.opened[0]);

resetUndo();
const bRead = callBatch([{ tool: "__read", args: {} },
                         { tool: "__read", args: {} }]);
assert(bRead.ok && undoLog.opened.length === 0,
       "a batch of read-only tools opens no undo group");

resetUndo(); ran.length = 0;
const bMixed = callBatch([
  { tool: "__mut", args: { tag: "x" } },
  { tool: "__boom", args: {} },
  { tool: "__nope", args: {} },
  { tool: "__mut", args: { tag: "y" } }
]);
assert(bMixed.ok, "a batch with failures still returns its rows");
assert(undoLog.opened.length === 1 && undoLog.depth === 0,
       "one balanced group even when a tool throws mid-batch");
const rows = bMixed.data.results;
assert(rows.length === 4, "still one row per command (got " + rows.length + ")");
assert(rows[0].ok && !rows[1].ok && !rows[2].ok && rows[3].ok,
       "each row carries its OWN outcome");
assert(/Unknown tool/.test(rows[2].error),
       "an unknown name inside a batch is named, not swallowed");
assert(rows[3].data.tag === "y",
       "commands AFTER a failure still run — a batch is not an abort");

resetUndo();
const bad = JSON.parse($.global.AELL_callBatch('"not an array"'));
assert(!bad.ok && /\[\{tool, args\}/.test(bad.error),
       "a non-array payload is refused with the shape it wanted: " +
       bad.error);
assert(undoLog.depth === 0 && undoLog.opened.length === 0,
       "and leaves no undo group open");

resetUndo();
const bEmpty = callBatch([]);
assert(bEmpty.ok && bEmpty.data.results.length === 0 &&
       undoLog.opened.length === 0, "an empty batch is a no-op");

delete AELL_TOOLS.__mut; delete AELL_TOOLS.__read; delete AELL_TOOLS.__boom;
delete AELL_MUTATING.__mut; delete AELL_MUTATING.__boom;

// ------------------------------------------- 3. the panel fuses the runs

const window = {
  console,
  setTimeout,
  Settings: { get() { return {}; } },
  Llama: { isRunning() { return true; } },
  Comfy: {}
};

// Recording bridge: every evalScript is logged, and AELL_callBatch /
// AELL_call are answered the way the host would.
const scripts = [];
window.AEBridge = {
  evalScript(script, cb) {
    scripts.push(script);
    if (!cb) return;
    let out;
    const batch = script.match(/^AELL_callBatch\((.*)\)$/);
    const single = script.match(/^AELL_call\("([^"]+)", (.*)\)$/);
    if (batch) {
      // Two arguments now: the command array, then the options that arm
      // the host's partial-round rollback. Both are JSON string literals.
      const args = new Function("return [" + batch[1] + "]")();
      const cmds = JSON.parse(args[0]);
      out = JSON.stringify({ ok: true, data: {
        results: cmds.map(c => ({ ok: true, data: { echo: c.tool } })) } });
    } else if (single) {
      out = JSON.stringify({ ok: true, data: { echo: single[1] } });
    } else {
      out = JSON.stringify({ ok: true, data: {} });
    }
    // The real bridge is async; keep the ordering honest.
    setTimeout(() => cb(out, false), 0);
  }
};

new Function("window", toolsSrc)(window);
const Tools = window.Tools;
assert(!!Tools && typeof Tools.executeCommands === "function",
       "tools.js loads and exports executeCommands");

function run(commands, opts) {
  return new Promise(resolve => {
    const each = [];
    Tools.executeCommands(commands, opts || {},
      (i, cmd, result) => each.push({ i, tool: cmd && cmd.tool, result }),
      results => resolve({ results, each }));
  });
}

const H = t => ({ tool: t, args: {} });

(async function () {
  // -- five host tools, ONE evalScript
  scripts.length = 0;
  const r1 = await run([H("add_solid"), H("grid_layout"), H("set_keyframes"),
                        H("apply_effect"), H("set_transform")]);
  assert(scripts.length === 1,
         "five host commands cost ONE evalScript (got " + scripts.length + ")");
  assert(/^AELL_callBatch\(/.test(scripts[0]),
         "and it is the batch entry point: " + scripts[0].slice(0, 24));
  assert(r1.results.length === 5, "five results come back");
  assert(r1.results.map(x => x.data.echo).join(",") ===
         "add_solid,grid_layout,set_keyframes,apply_effect,set_transform",
         "in the order the model asked for");
  assert(r1.each.map(e => e.i).join(",") === "0,1,2,3,4",
         "onEach fires once per command with the ORIGINAL index");
  assert(r1.each.every((e, k) => e.tool === r1.each[k].tool),
         "onEach hands back the command it belongs to");

  // The payload must survive the ES3 round trip it is written for.
  const m0 = String(scripts[0]).match(/^AELL_callBatch\((.*)\)$/);
  const literal = m0 ? m0[1] : "";
  assert(!/[\u2028\u2029]/.test(literal),
         "no raw U+2028/U+2029 in the batch literal (ES3 line terminators)");
  let decoded = null;
  let optsArg = null;
  try {
    const args = new Function("return [" + literal + "]")();
    decoded = JSON.parse(args[0]);
    optsArg = args.length > 1 ? JSON.parse(args[1]) : null;
  } catch (e) {}
  assert(decoded && decoded.length === 5,
         "the first literal is a JSON string holding the command array");
  assert(optsArg && typeof optsArg.rollback === "boolean",
         "and a second one carries the rollback flag the host needs");

  // -- a panel-side tool splits the run, order preserved
  scripts.length = 0;
  window.Comfy = { status(url, cb) { cb(null, { up: false }); } };
  const r2 = await run([H("add_solid"), H("apply_effect"),
                        H("comfy_status"),
                        H("set_transform"), H("add_mask")]);
  assert(scripts.length === 2,
         "a panel tool splits the round into TWO host batches (got " +
         scripts.length + ")");
  assert(r2.results.length === 5 && r2.each.map(e => e.i).join(",") ===
         "0,1,2,3,4", "all five still report, in order, with right indices");
  assert(r2.results[3].data.echo === "set_transform",
         "the commands after the panel tool still ran");

  // -- unknown and malformed commands never join a batch
  scripts.length = 0;
  const r3 = await run([H("add_solid"), H("not_a_tool"), { args: {} },
                        H("add_mask")]);
  assert(!r3.results[1].ok && /Unknown tool: not_a_tool/.test(
           r3.results[1].error),
         "an unknown tool is refused panel-side: " + r3.results[1].error);
  assert(!r3.results[2].ok && /Malformed command/.test(r3.results[2].error),
         "a command with no tool name is refused: " + r3.results[2].error);
  assert(r3.results[0].ok && r3.results[3].ok,
         "the real commands around them still ran");
  assert(r3.results.length === 4, "four commands, four results");

  // -- dry run: mutations stay stubbed, reads still batch
  scripts.length = 0;
  const r4 = await run([H("add_solid"), H("get_comp_details"),
                        H("grid_layout")], { dryRun: true });
  assert(r4.results[0].dryRun === true && r4.results[2].dryRun === true,
         "dry run stubs the mutating commands");
  assert(r4.results[1].ok && !r4.results[1].dryRun,
         "and still really runs the read-only one");
  const dryBatched = scripts.filter(s => /AELL_callBatch/.test(s));
  assert(scripts.length === 1 && dryBatched.length === 1,
         "exactly one host call in a dry run (the read): " + scripts.length);

  // -- a batch that fails as a whole reports per command, not as a hang
  scripts.length = 0;
  const realBridge = window.AEBridge.evalScript;
  window.AEBridge.evalScript = (script, cb) => {
    scripts.push(script);
    if (cb) setTimeout(() => cb("", true), 0);
  };
  const r5 = await run([H("add_solid"), H("add_mask"), H("apply_effect")]);
  assert(r5.results.length === 3,
         "an ExtendScript error still yields one row per command (got " +
         r5.results.length + ")");
  assert(r5.results.every(x => !x.ok && /batch of 3 tools/.test(x.error)),
         "every row says the batch failed: " + r5.results[0].error);

  // -- a host response that does not line up is not silently trusted
  window.AEBridge.evalScript = (script, cb) => {
    scripts.push(script);
    if (cb) setTimeout(() => cb(JSON.stringify(
      { ok: true, data: { results: [{ ok: true }] } }), false), 0);
  };
  const r6 = await run([H("add_solid"), H("add_mask")]);
  assert(r6.results.length === 2 &&
         r6.results.every(x => !x.ok && /Bad host batch response/.test(
           x.error)),
         "a short results array is rejected, not zipped up wrong: " +
         r6.results[0].error);
  window.AEBridge.evalScript = realBridge;

  // -- cancelling still stops the round
  scripts.length = 0;
  let calls = 0;
  const r7 = await run([H("add_solid"), H("comfy_status"), H("add_mask")],
                       { shouldStop: () => ++calls > 1 });
  assert(r7.results.some(x => !x.ok && /Cancelled by user/.test(x.error)),
         "shouldStop still cancels the remaining commands");

  // -- the per-round cap still holds
  scripts.length = 0;
  const many = [];
  for (let i = 0; i < 30; i++) many.push(H("add_solid"));
  const r8 = await run(many);
  assert(r8.results.length === 20,
         "still capped at 20 commands per round (got " + r8.results.length +
         ")");
  assert(scripts.length === 1, "and they go out as a single batch");

  // ------------------------------ 4. anti-drift: the two mutating tables
  //
  // hostscript.jsx decides what gets an undo group; tools.js decides what a
  // dry run is allowed to skip. They are maintained by hand, separately, so
  // compare them instead of trusting either.
  const docMutating = new Set();
  const docAll = new Set();
  for (const def of Tools.TOOL_DEFS) {
    docAll.add(def.name);
    if (def.mutating) docMutating.add(def.name);
  }
  const hostMutating = new Set(Object.keys(AELL_MUTATING));
  const hostTools = new Set(Object.keys(AELL_TOOLS));

  const ghosts = [...hostMutating].filter(n => !hostTools.has(n));
  assert(ghosts.length === 0,
         "no name in AELL_MUTATING is missing from AELL_TOOLS" +
         (ghosts.length ? " (ghosts: " + ghosts.join(", ") + ")" : ""));

  // Panel-side tools (comfy_*) never reach the host, so only compare the
  // names both sides actually own.
  const shared = [...docAll].filter(n => hostTools.has(n));
  // One documented exception, and it has to be an EXPLICIT one rather
  // than a hole in the comparison: AE cannot render inside an undo group.
  // Its renderer closes the script's group out from under it, and AE then
  // raises a modal "Undo group mismatch" that wedges an unattended run.
  // So render_comp is `mutating: true` in tools.js (a dry run must never
  // burn a real render) and deliberately absent from AELL_MUTATING. The
  // rule is therefore "mutating tools get a group UNLESS they are listed
  // as must-not-be-grouped", and that list is checked, not assumed.
  const noGroup = new Set(Object.keys(AELL_NO_UNDO_GROUP));
  const strayNoGroup = [...noGroup].filter(n => !hostTools.has(n));
  assert(strayNoGroup.length === 0,
         "every name in AELL_NO_UNDO_GROUP is a real tool" +
         (strayNoGroup.length ? " (stray: " + strayNoGroup.join(", ") + ")"
                              : ""));
  const pointlessNoGroup = [...noGroup].filter(n => !docMutating.has(n));
  assert(pointlessNoGroup.length === 0,
         "AELL_NO_UNDO_GROUP only exempts tools that are otherwise " +
         "documented as mutating — exempting a read would mean nothing" +
         (pointlessNoGroup.length
           ? " (pointless: " + pointlessNoGroup.join(", ") + ")" : ""));
  assert(noGroup.has("render_comp"),
         "render_comp is the exemption this exists for");

  const missingHost = shared.filter(n => docMutating.has(n) &&
                                         !hostMutating.has(n) &&
                                         !noGroup.has(n));
  assert(missingHost.length === 0,
         "every tool documented as mutating gets an undo group in the " +
         "host, unless it is explicitly exempt" +
         (missingHost.length ? " (missing: " + missingHost.join(", ") + ")"
                             : ""));
  const bothWays = [...noGroup].filter(n => hostMutating.has(n));
  assert(bothWays.length === 0,
         "and nothing is both exempt and wrapped" +
         (bothWays.length ? " (both: " + bothWays.join(", ") + ")" : ""));
  const missingDoc = shared.filter(n => hostMutating.has(n) &&
                                        !docMutating.has(n));
  assert(missingDoc.length === 0,
         "every tool the host wraps in an undo group is documented as " +
         "mutating" + (missingDoc.length
           ? " (missing: " + missingDoc.join(", ") + ")" : ""));

  const undocumented = [...hostTools].filter(n => !docAll.has(n));
  assert(undocumented.length === 0,
         "every host tool is documented in TOOL_DEFS" +
         (undocumented.length ? " (missing: " + undocumented.join(", ") + ")"
                              : ""));

  if (process.exitCode) console.error("\nundo-group tests FAILED");
  else console.log("\nundo-group tests passed");
})().catch(e => {
  console.error("FAIL: the panel half threw:", (e && e.stack) || e);
  process.exitCode = 1;
});
