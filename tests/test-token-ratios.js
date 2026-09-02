// Regression test: the panel's token arithmetic against a MEASURED
// tokenizer.
//
// tools.js predicts tokens from characters with two constants, and until
// 2026-09-02 both were guesses. scripts/context-budget-probe.js asked the
// running llama-server's /tokenize what the panel's own payload really
// costs (Qwen2.5-32B-Instruct-Q4_K_M, ctx 16384, real project state read
// out of AE 2026):
//
//   system prompt, full docs     62364 chars = 16073 tokens  3.88 c/tok
//   system prompt, compact docs  42574 chars = 11446 tokens  3.72 c/tok
//   chat history (JSON-heavy)    56308 chars = 19937 tokens  2.82 c/tok
//   chat history, second run     42431 chars = 15291 tokens  2.77 c/tok
//
// The prompt rows repeat exactly — same text, same tokenizer. The
// history row does not: what a ten-turn chat contains depends on what
// the model says, so two runs disagreed. Every bound below is taken
// against the LOWEST sample, never the latest.
//
// The old 3.9 / 3 were within 10% — and wrong in the direction that
// kills a chat. The two constants are NOT symmetric:
//
//   PROMPT_CHARS_PER_TOKEN  divides chars into tokens. Too HIGH hides
//     tokens: at the shipped default (compact docs, ctx 16384) it said
//     10917 where the tokenizer said 11446, so 529 tokens of window
//     existed only on paper.
//   HISTORY_CHARS_PER_TOKEN multiplies room into chars. Too HIGH hands
//     out history the room cannot hold: 4917 chars at the measured 2.82
//     is 1744 tokens against 1610 really free.
//
// Together that is the raw HTTP 400 ("request exceeds the available
// context size") that fitHistory was written to prevent, back again and
// invisible, because nothing here had ever met a tokenizer.
//
// This file is the tokenizer's answer, frozen. It pins RATIOS, not
// lengths, so it stays true as the prompt grows — and it asserts the
// end-to-end property the constants exist for: what the panel hands a
// round, priced at the measured ratios, fits the window it is sent to.
"use strict";
const fs = require("fs");
const path = require("path");

const window = {};
const toolsSrc = fs.readFileSync(
  path.join(__dirname, "..", "extension", "js", "tools.js"), "utf8");
eval(toolsSrc);
const Tools = window.Tools;

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

// --------------------------------------------------- the measurement

// Measured 2026-09-02 by scripts/context-budget-probe.js. Re-run it and
// add a row (never edit one) if the model the panel ships with changes;
// never "adjust" them to make an assertion pass.
const MEASURED = {
  promptFull:    { chars: 62364, tokens: 16073 },
  promptCompact: { chars: 42574, tokens: 11446 },
  // Both runs, so the bound is against the densest one rather than
  // whichever happened to be measured last.
  historyRuns: [ { chars: 56308, tokens: 19937 },
                 { chars: 42431, tokens: 15291 } ]
};
const ratio = m => m.chars / m.tokens;
// The densest (worst) history the probe has ever seen: fewest chars per
// token, so the most tokens for a given budget.
const HISTORY_DENSEST = Math.min.apply(null,
  MEASURED.historyRuns.map(ratio));

// The constants under test, read out of the shipped source. A test that
// retypes the number it is checking cannot fail.
// REPLY_RESERVE_TOKENS ships as a SUM (max_tokens + template overhead),
// so this reads the whole right-hand side and adds it up — grabbing only
// the first number made the reserve 256 tokens smaller than the panel's
// and quietly loosened assertion 4.
function constFromTools(name) {
  const m = toolsSrc.match(
    new RegExp("var\\s+" + name + "\\s*=\\s*([0-9.\\s+]+);"));
  if (!m) return NaN;
  return m[1].split("+").reduce((n, part) => n + Number(part.trim()), 0);
}
const PROMPT_CPT = constFromTools("PROMPT_CHARS_PER_TOKEN");
const HISTORY_CPT = constFromTools("HISTORY_CHARS_PER_TOKEN");
const REPLY_RESERVE = constFromTools("REPLY_RESERVE_TOKENS");
assert(REPLY_RESERVE === 3328,
       "the reply reserve reads as the whole sum, not its first term (" +
       REPLY_RESERVE + ")");

assert(!isNaN(PROMPT_CPT) && !isNaN(HISTORY_CPT),
       "both ratio constants are readable from tools.js (" +
       PROMPT_CPT + " / " + HISTORY_CPT + ")");

// 1. The prompt constant must not exceed the DENSEST prompt form the
//    panel ever sends. The compact docs are denser than the full ones
//    (tool names and args tokenize worse than prose), and compact is
//    what ships at the default window — so the full-doc ratio alone is
//    not the bound.
{
  const densest = Math.min(ratio(MEASURED.promptFull),
                           ratio(MEASURED.promptCompact));
  assert(PROMPT_CPT <= densest,
         "PROMPT_CHARS_PER_TOKEN (" + PROMPT_CPT + ") is at or below the " +
         "densest measured prompt form (" + densest.toFixed(2) + " c/tok, " +
         "the compact docs)");
  assert(PROMPT_CPT >= densest - 0.5,
         "and is not so pessimistic it throws the window away (within " +
         "0.5 c/tok of the measurement)");
}

// 2. The history constant is used the OTHER way round, so the same
//    "too high hurts" rule lands on the same side of the measurement
//    for the opposite reason.
{
  assert(HISTORY_CPT <= HISTORY_DENSEST,
         "HISTORY_CHARS_PER_TOKEN (" + HISTORY_CPT + ") is at or below " +
         "the DENSEST history measured (" + HISTORY_DENSEST.toFixed(2) +
         " c/tok, over " + MEASURED.historyRuns.length + " runs)");
  assert(HISTORY_CPT >= HISTORY_DENSEST - 0.5,
         "and is not so pessimistic history is priced out");
}

// 3. The estimate must COVER the real prompt, at both windows, in the
//    form each window really sends. This is the assertion that failed
//    on the shipped 3.9 and is the whole reason the file exists.
for (const ctx of [16384, 32768]) {
  const compact = Tools.promptModeFor(ctx).compact;
  const m = compact ? MEASURED.promptCompact : MEASURED.promptFull;
  const hb = Tools.historyBudget(ctx, m.chars);
  assert(hb.promptTokens >= m.tokens,
         "ctx " + ctx + " (" + (compact ? "compact" : "full") + " docs): " +
         "the estimate covers the real prompt (" + hb.promptTokens +
         " >= " + m.tokens + ")");
}

// 4. End to end, the property a user feels: prompt + reply reserve +
//    the history the panel hands out, all priced at the MEASURED
//    ratios, fits inside the window. With 3.9/3 this overflowed by 134
//    tokens at the shipped default.
for (const ctx of [16384, 32768]) {
  const compact = Tools.promptModeFor(ctx).compact;
  const m = compact ? MEASURED.promptCompact : MEASURED.promptFull;
  const hb = Tools.historyBudget(ctx, m.chars);
  const histTokens = Math.ceil(hb.chars / HISTORY_DENSEST);
  const total = m.tokens + REPLY_RESERVE + histTokens;
  assert(total <= ctx,
         "ctx " + ctx + ": real prompt " + m.tokens + " + reply reserve " +
         REPLY_RESERVE + " + budgeted history " + histTokens +
         " tokens = " + total + " <= " + ctx);
}

// 5. The ledger's own slice is inside the budget, not beside it — it
//    rides in the SYSTEM message, so a budget that ignored it would put
//    the block over the line it just measured.
{
  const hb = Tools.historyBudget(16384, MEASURED.promptCompact.chars);
  const ledger = constFromTools("LEDGER_BUDGET");
  const withLedger = Math.ceil((hb.chars + ledger) / HISTORY_DENSEST) +
    MEASURED.promptCompact.tokens + REPLY_RESERVE;
  assert(withLedger <= 16384,
         "the " + ledger + "-char ledger slice still fits at ctx 16384 (" +
         withLedger + " tokens)");
}

// 6. A window too small for the prompt gives up history rather than
//    going negative — the arithmetic bug the old max(4000, …) floor had.
{
  const hb = Tools.historyBudget(8192, MEASURED.promptCompact.chars);
  assert(hb.chars === 0 && hb.starved,
         "ctx 8192 cannot even hold the compact prompt: 0 chars of " +
         "history and starved=true");
}

// 7. Direction, stated once as a rule, so a future edit that "rounds up
//    for margin" is caught: raising either constant makes the panel
//    more optimistic, never safer.
{
  const src = toolsSrc.slice(toolsSrc.indexOf("var PROMPT_CHARS_PER_TOKEN") - 2000,
                             toolsSrc.indexOf("var PROMPT_CHARS_PER_TOKEN"));
  assert(/tokenize|measured/i.test(src),
         "the constants carry the measurement that set them, not a guess");
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
