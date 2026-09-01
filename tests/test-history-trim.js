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

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
