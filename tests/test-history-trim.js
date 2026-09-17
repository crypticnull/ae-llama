// Regression test: Tools.fitHistory — bounding what the MODEL is sent.
//
// Field bug (chat-probe 2026-08-25, steps 9-10): main.js sent
// [system].concat(history) with no bound, so a long chat died with a raw
// llama-server HTTP 400 ("request (16755 tokens) exceeds the available
// context size (16384)") on EVERY later message — the panel was dead
// until cleared, and verbose grounded errors accelerated the death.
//
// fitHistory drops the OLDEST entries first, never the last four, and
// leaves the survivors starting on a user turn. The visible transcript
// is untouched — only the model's view shrinks.
"use strict";
const fs = require("fs");
const path = require("path");

const window = {};
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tools.js"), "utf8"));
const fit = window.Tools.fitHistory;

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}
function msg(role, size) {
  return { role, content: role.charAt(0).toUpperCase() + "x".repeat(size) };
}
function convo(pairs, size) {
  const h = [];
  for (let i = 0; i < pairs; i++) {
    h.push(msg("user", size));
    h.push(msg("assistant", size));
  }
  return h;
}

// 1. under budget: untouched, same array contents, dropped 0
{
  const h = convo(3, 100);
  const r = fit(h, 100000);
  assert(r.dropped === 0 && r.entries.length === 6,
         "under budget: nothing dropped");
  assert(r.entries[0] === h[0], "and the entries are the same objects");
}

// 2. over budget: oldest dropped first, newest kept
{
  const h = convo(10, 1000);           // ~20k chars
  const r = fit(h, 8000);
  assert(r.dropped > 0, "over budget: something dropped");
  assert(r.entries[r.entries.length - 1] === h[h.length - 1],
         "the newest entry always survives");
  assert(r.entries.indexOf(h[0]) === -1, "the oldest entry went first");
}

// 3. survivors start on a user turn (chat templates need it)
{
  const h = convo(10, 1000);
  const r = fit(h, 8000);
  assert(r.entries[0].role === "user",
         "post-trim history starts with a user turn (got " +
         r.entries[0].role + ")");
}

// 4. the last four entries are sacred, even over budget
{
  const h = convo(4, 50000);           // 8 entries, each huge
  const r = fit(h, 1000);
  assert(r.entries.length >= 4,
         "never trims below the current exchange (kept " +
         r.entries.length + ")");
}

// 5. the reactive hard-trim path: budget 1 keeps exactly the floor
{
  const h = convo(10, 1000);
  const r = fit(h, 1);
  assert(r.entries.length === 4 && r.entries[0].role === "user",
         "budget 1 = the four-entry floor, user-first (got " +
         r.entries.length + ", " + r.entries[0].role + ")");
}

// 6. the original history array is never mutated
{
  const h = convo(10, 1000);
  const before = h.length;
  fit(h, 8000);
  assert(h.length === before,
         "fitHistory does not mutate the transcript history");
}

// 7. the field numbers: a 16755-token history against a 16384 window,
//    at the conservative 3 chars/token main.js uses, comes back under.
{
  const h = convo(30, 1700);           // ~102k chars ≈ way past 16k tokens
  const budget = (16384 - 3600) * 3;   // main.js's arithmetic
  const r = fit(h, budget);
  let size = 0;
  for (const e of r.entries) size += e.content.length + 16;
  assert(size <= budget,
         "the field-observed overflow now fits: " + size + " <= " + budget);
  assert(r.dropped > 0 && r.entries.length >= 4, "by dropping, not dying");
}

// 8. the ledger: a dropped turn comes back as one line of FUNCTION
//    (owner 2026-09-01: function over conversation). Before this, the
//    turns simply vanished and "make them blue instead" had nothing to
//    refer back to.
{
  const h = [
    { role: "user", content: "Make a comp called Promo, 1920x1080, then " +
        "add a title that says HELLO in white" },
    { role: "assistant", content: JSON.stringify({
        reply: "Creating the comp and the title.", commands: [
          { tool: "create_comp", args: { name: "Promo", width: 1920, height: 1080 } },
          { tool: "add_text_layer", args: { comp: "Promo", text: "HELLO", name: "Title" } }
        ] }) },
    { role: "user", content: "TOOL RESULTS:\n" + JSON.stringify([
        { ok: true, data: { name: "Promo", width: 1920 } },
        { ok: true, data: { layer: "Title", index: 1 } } ]) },
    { role: "assistant", content: JSON.stringify({ reply: "Done.", commands: [] }) },
    { role: "user", content: "now make it blue" },
    { role: "assistant", content: JSON.stringify({ reply: "Coloring it.",
        commands: [{ tool: "set_text_style", args: { layer: "Title", fillColor: [0, 0, 1] } }] }) },
    { role: "user", content: "TOOL RESULTS:\n" + JSON.stringify([
        { ok: false, error: "Layer not found: Titel. Layers here: Title" } ]) },
    { role: "assistant", content: JSON.stringify({ reply: "Fixed the name.", commands: [] }) }
  ];
  const r = fit(h, 1);   // the hard floor: only the last four survive
  assert(r.dropped === 4 && r.entries.length === 4,
         "eight entries, four dropped (" + r.dropped + ")");
  assert(/EARLIER IN THIS SESSION/.test(r.ledger),
         "a ledger comes back for the dropped turns");
  assert(/user: Make a comp called Promo/.test(r.ledger),
         "the user's request keeps its first clause");
  assert(/did: create_comp Promo, add_text_layer Promo/.test(r.ledger),
         "the assistant turn keeps the tools it ran with their naming " +
         "args: " + r.ledger.split("\n")[2]);
  assert(/results: 2 ok; Promo, Title/.test(r.ledger),
         "the receipts keep the names they created: " +
         r.ledger.split("\n")[3]);
  assert(r.ledger.length < 600,
         "and four turns of memory cost under 600 chars (" +
         r.ledger.length + ")");
  assert(/if they refer to something not here, ask/.test(r.ledger),
         "with the honesty clause");
  assert(fit(h, 100000).ledger === "",
         "no ledger when nothing was dropped");
}

// 9. the ledger has its own cap: oldest lines fold away, counted
{
  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push({ role: "user", content: "request number " + i + " " +
                "words ".repeat(30) });
    many.push({ role: "assistant", content: JSON.stringify({
        reply: "ok " + i,
        commands: [{ tool: "add_solid", args: { name: "Solid " + i } }] }) });
  }
  const r = fit(many, 1);
  assert(r.ledger.length <= 1500,
         "the ledger stays under its 1500-char slice (" + r.ledger.length + ")");
  assert(/folded away/.test(r.ledger),
         "and says how many older lines it folded");
  assert(/Solid 5[0-9]/.test(r.ledger) && !/request number 0 /.test(r.ledger),
         "keeping the NEWEST memory, not the oldest");
}

// 10. what is not memory, and what cannot be read
{
  const s = window.Tools._summarizeEntry;
  assert(s({ role: "user", content: "SYSTEM: Only your LAST response was truncated" }) === "",
         "a SYSTEM control message is not memory");
  assert(/^assistant: not json/.test(s({ role: "assistant", content: "not json at all" })),
         "an unparseable assistant turn keeps a clipped text");
  assert(/results: \(unreadable\)/.test(s({ role: "user", content: "TOOL RESULTS:\n{oops" })),
         "unreadable results say so");
  assert(/1 error \(Layer not found: X/.test(s({ role: "user",
           content: "TOOL RESULTS:\n" + JSON.stringify([{ ok: false, error: "Layer not found: X" }]) })),
         "an error result keeps its first clause");
  assert(/did: import_file frame\.png/.test(s({ role: "assistant",
           content: JSON.stringify({ commands: [{ tool: "import_file",
             args: { file: "X:\\renders\\deep\\frame.png" } }] }) })),
         "a path collapses to its basename — the folder is not memory");
}

// ===================================================================
// 11-17. THE FLOOR: what happens when the protected tail ALONE busts
// the budget.
//
// Dropping whole entries stops at the last four, so one oversized entry
// inside them — a comfy_generate result, a pasted expression, a long
// TOOL RESULTS array — left fitHistory returning a payload it had
// already computed was too big. main.js answers a context HTTP 400 by
// calling back with budget 1; with nothing left to drop that returned
// the SAME BYTES, the retry earned the SAME 400, and the chat was dead
// until cleared — the exact failure this file's header says fitHistory
// ended, arriving through the one door it left open.
//
// Measured 2026-09-02, real llama-server, Qwen2.5-32B, ctx 16384
// (scripts/history-floor-probe.js): a 60334-char four-entry tail, and
// llama-server refused the attempt AND the retry with the identical
// "request (17733 tokens) exceeds the available context size (16384)".
// Everything below is that failure, without the server.
// ===================================================================

function sizeOf(entries) {
  let n = 0;
  for (const e of entries) n += (e.content || "").length + 16;
  return n;
}

// 11. THE CONTRACT: fitHistory never returns what it knows is too big
{
  const h = [msg("user", 200), msg("assistant", 200),
             msg("user", 60000), msg("assistant", 200)];
  const r = fit(h, 5000);
  assert(sizeOf(r.entries) <= 5000,
         "the protected tail is cut down to the budget: " +
         sizeOf(r.entries) + " <= 5000");
  assert(r.entries.length === 4,
         "and it is still four entries — content shrank, not the turn count");
  assert(r.truncated > 0,
         "the result SAYS how many entries were cut (" + r.truncated + ")");
}

// 12. the cut is never silent — the model is told the message is partial
{
  const h = [msg("user", 200), msg("assistant", 200),
             msg("user", 60000), msg("assistant", 200)];
  const r = fit(h, 5000);
  const cut = r.entries.filter(e => /characters cut/.test(e.content));
  assert(cut.length > 0, "a cut entry names itself in words");
  // Read through a placeholder rather than cut[0] directly: without the
  // floor there IS no cut entry, and a TypeError here would abort the
  // suite and hide every failure after it.
  const cutText = cut.length ? cut[0].content : "";
  assert(/INCOMPLETE/.test(cutText),
         "and says the end of it is not the end of the data");
  assert(/\b\d{4,}\b/.test(cutText),
         "with the number of characters it replaced");
}

// 13. the NEWEST entry is cut last — it carries the sentence being answered
{
  const h = [msg("user", 20000), msg("assistant", 20000),
             msg("user", 20000), msg("assistant", 400)];
  const r = fit(h, 3000);
  assert(r.entries[3].content === h[3].content,
         "the newest entry survives whole while older ones are cut");
  assert(sizeOf(r.entries) <= 3000, "and the budget is still met");
}

// 14. THE REGRESSION: budget 1 (the reactive retry) must actually shrink
{
  const h = [msg("user", 200), msg("assistant", 200),
             msg("user", 60000), msg("assistant", 200)];
  const first = fit(h, 5000);
  const retry = fit(h, 1);
  assert(sizeOf(retry.entries) < sizeOf(first.entries),
         "the retry sends FEWER bytes than the attempt that 400'd (" +
         sizeOf(retry.entries) + " < " + sizeOf(first.entries) + ")");
  assert(sizeOf(retry.entries) < 4000,
         "and it reaches the four-entry minimum, not the original 60k (" +
         sizeOf(retry.entries) + ")");
}

// 15. an already-small history is never touched by the floor
{
  const h = convo(2, 100);
  const r = fit(h, 100000);
  assert(r.truncated === 0 && r.dropped === 0,
         "under budget: nothing dropped AND nothing cut");
  assert(r.entries[2] === h[2], "the entries are still the same objects");
}

// 16. an entry too short to pay for its own marker is left whole.
//     "Shortening" it would make it BIGGER, and the loop would walk on
//     and eat the newest turn it exists to spare.
{
  const h = [msg("user", 40), msg("assistant", 40),
             msg("user", 40), msg("assistant", 40)];
  const r = fit(h, 1);
  assert(r.truncated === 0, "nothing was cut (" + r.truncated + ")");
  let same = true;
  for (let i = 0; i < 4; i++) {
    if (r.entries[i].content !== h[i].content) same = false;
  }
  assert(same, "every entry came back untouched");
  assert(sizeOf(r.entries) === sizeOf(h),
         "and the payload did not GROW trying to shrink (" +
         sizeOf(r.entries) + " === " + sizeOf(h) + ")");
}

// 17. dropping and cutting compose: the ledger still carries the turns
//     that went, and the survivors still fit.
{
  const h = convo(6, 800).concat([
    { role: "user", content: "TOOL RESULTS:\n" + JSON.stringify(
        [{ ok: true, data: { layer: "Hero", note: "x".repeat(40000) } }]) },
    { role: "assistant", content: JSON.stringify({ reply: "Done.",
        commands: [] }) }
  ]);
  const r = fit(h, 6000);
  assert(r.dropped > 0 && r.truncated > 0,
         "both mechanisms ran (" + r.dropped + " dropped, " +
         r.truncated + " cut)");
  assert(sizeOf(r.entries) <= 6000,
         "and the result fits: " + sizeOf(r.entries) + " <= 6000");
  assert(/EARLIER IN THIS SESSION/.test(r.ledger),
         "the dropped turns still come back as the ledger");
}

// 18-22. CJK turns (NEXT UP 38). Every count above is ENGLISH-shaped:
//     2.7 chars/token. Measured 2026-09-17 with llama-tokenize over the
//     7B and 32B Qwen2.5 vocab, ordinary Japanese / Chinese / Korean run
//     1.36-1.66 chars/token, so a CJK chat counted by .length passed the
//     proactive trim at ~2x its real size, earned the context 400, and
//     the reactive retry then dropped EVERY earlier turn.
const T = window.Tools;
const CPT = 2.7;           // HISTORY_CHARS_PER_TOKEN
const DENSEST_REAL = 1.36; // Korean AE request, the lowest measured
const JA = "新しいコンポジションを作成して、背景に青い平面を追加してください。" +
  "それから「タイトル」というテキストレイヤーを画面の中央に配置してください。";
function ja(n) { let t = ""; while (t.length < n) t += JA; return t.slice(0, n); }
function realTokens(entries) {
  // What the server would count, at the densest real CJK ratio measured
  // and the English one for the rest, +16 chars per entry as above.
  let tok = 0;
  for (const e of entries) {
    const c = e.content || "";
    let wide = 0;
    for (let i = 0; i < c.length; i++) if (c.charCodeAt(i) >= 0x2E80) wide++;
    tok += wide / DENSEST_REAL + (c.length - wide + 16) / CPT;
  }
  return tok;
}

// 18. the estimator itself
{
  assert(T.budgetLength("hello") === 5, "ASCII costs its length");
  assert(Math.abs(T.budgetLength("日本") - 2 * CPT) < 1e-9,
         "a CJK char costs a whole token (" + T.budgetLength("日本") + ")");
  assert(Math.abs(T.budgetLength("한국 ok") - (2 * CPT + 3)) < 1e-9,
         "Hangul is wide too, and mixed text adds up");
  assert(T.budgetLength(null) === 0 && T.budgetLength(undefined) === 0,
         "no content costs nothing");
}

// 19. THE BUG: a Japanese chat that fits by .length but not by tokens
//     must be trimmed BEFORE the request, not by the 400.
{
  const h = [];
  for (let i = 0; i < 5; i++) {
    h.push({ role: "user", content: ja(500) });
    h.push({ role: "assistant", content: ja(500) });
  }
  const budget = 6000; // 2222 tokens of room
  assert(sizeOf(h) <= budget,
         "precondition: by .length it fits (" + sizeOf(h) + " <= " + budget + ")");
  assert(realTokens(h) > budget / CPT,
         "precondition: by tokens it does not (" + Math.round(realTokens(h)) +
         " > " + Math.round(budget / CPT) + ")");
  const r = fit(h, budget);
  assert(r.dropped > 0, "old turns were dropped proactively (" + r.dropped + ")");
  assert(realTokens(r.entries) <= budget / CPT,
         "and what is sent fits the room in tokens (" +
         Math.round(realTokens(r.entries)) + " <= " + Math.round(budget / CPT) + ")");
  assert(r.entries[0].role === "user", "survivors still start on a user turn");
}

// 20. the floor cut is solved in the same units: one huge Japanese
//     entry in the protected tail shrinks to fit and keeps its head.
{
  const h = [{ role: "user", content: ja(200) },
             { role: "assistant", content: "ok" },
             { role: "user", content: "TOOL RESULTS:\n" + ja(8000) },
             { role: "assistant", content: "ok" }];
  const budget = 4000;
  const r = fit(h, budget);
  assert(r.truncated > 0, "the oversized CJK entry was cut (" + r.truncated + ")");
  assert(realTokens(r.entries) <= budget / CPT,
         "the tail fits in tokens (" + Math.round(realTokens(r.entries)) +
         " <= " + Math.round(budget / CPT) + ")");
  assert(r.entries[2].content.indexOf("TOOL RESULTS:\n" + JA.slice(0, 20)) === 0,
         "the cut kept the entry's head");
  const again = fit(r.entries, budget);
  assert(again.truncated === 0 && again.dropped === 0,
         "and a second pass finds nothing left to cut");
}

// 21. the ledger's own budget weighs CJK lines the same way
{
  const gone = [];
  for (let i = 0; i < 30; i++) gone.push({ role: "user", content: ja(300) });
  const led = T.rollupHistory(gone, 1500);
  assert(led && T.budgetLength(led) <= 1500,
         "a CJK ledger folds to its budget in tokens, not chars (" +
         Math.round(T.budgetLength(led)) + " <= 1500)");
}

// 22. historyBudget prices the PROMPT text the same way; a count still works
{
  const en = "x".repeat(40000);
  assert(T.historyBudget(16384, en).chars === T.historyBudget(16384, 40000).chars,
         "an ASCII prompt string budgets exactly like its length");
  const mixed = "x".repeat(38000) + ja(2000);
  assert(T.historyBudget(16384, mixed).chars < T.historyBudget(16384, 40000).chars,
         "CJK project state in the prompt leaves less room for history");
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
