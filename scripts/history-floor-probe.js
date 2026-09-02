/*
 * history-floor-probe.js — does the reactive retry actually SHRINK?
 *
 * WORKPLAN 1b, last bullet (the pass-22 salvage). Pass 22 was killed
 * mid-change on 2026-09-01 with no log entry; its stash carried a
 * `fitHistory` floor and a 268-line test for a field failure it had
 * measured and nobody had written down. This probe re-measures the
 * claim on TODAY's head, against a real llama-server, so the salvage
 * rests on evidence rather than on a dead pass's word.
 *
 * THE CLAIM UNDER TEST
 *
 * `Tools.fitHistory` drops whole entries from the front, but never
 * below the last four — the current exchange must survive. That is
 * right, and it has a hole: when ONE entry inside that protected tail
 * is bigger than the whole budget (a comfy_generate result, a pasted
 * expression, a long TOOL RESULTS array), there is nothing left to
 * drop, so the function returns a payload it has already computed is
 * too big.
 *
 * main.js answers a context HTTP 400 by setting `forceTinyContext` and
 * calling fitHistory again with budget 1. If the tail alone busts the
 * window, budget 1 returns the SAME BYTES — so the retry earns the SAME
 * 400, and the chat is dead until the user clears it. That is the exact
 * failure fitHistory was written to end.
 *
 * WHAT THIS RUNS
 *
 *   A. arithmetic, no server: fitHistory's own output size against the
 *      budget it was given, at a normal budget and at the retry's 1.
 *   B. the real server: the same messages main.js would build (real
 *      system prompt, real fitHistory) POSTed to llama-server. The RAW
 *      history has to 400 — otherwise this phase is measuring nothing —
 *      and both fitted forms have to be accepted.
 *   C. the cut is legible: whatever is sent, a human (and a 7B model)
 *      can tell that a message was cut and by how much.
 *
 * MEASURED HERE 2026-09-02, before the fix, on this machine's own 32B:
 * the attempt and the retry were byte-for-byte identical at 60334 chars,
 * and llama-server refused both with the same "request (17733 tokens)
 * exceeds the available context size (16384 tokens)". After it, the
 * first try is 3100 chars and HTTP 200 — the 400 never happens, so the
 * retry path is a second net rather than the only one.
 *
 *   node scripts/history-floor-probe.js                # starts a server
 *   node scripts/history-floor-probe.js --reuse-server # one is up
 *   node scripts/history-floor-probe.js --no-server    # phase A + C only
 *
 * Needs no After Effects: the defect is panel-side, and the project
 * state only changes the prompt's SIZE, which phase B measures from the
 * server anyway. Exits 0 only if every claim held.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const probe = require("./chat-probe.js");
const { Tools, Settings, Llama, startModel } = probe;

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const NO_SERVER = argv.indexOf("--no-server") !== -1;

let failed = 0;
const claims = [];
function claim(ok, what, detail) {
  claims.push({ ok: !!ok, what, detail: detail || "" });
  if (!ok) failed++;
  console.log((ok ? "ok   - " : "FAIL - ") + what +
              (detail ? "\n         " + detail : ""));
}

// The shape of the failure, as the field produced it: an ordinary
// exchange whose THIRD entry is one enormous tool result. Four entries
// total, so entry-dropping has nothing to work with.
function oversizedTail(resultChars) {
  const bigResult = JSON.stringify([{
    ok: true,
    data: {
      workflow: "AE_LLAMA_H3_I2V_V1",
      note: "x".repeat(resultChars),
      frames: 121
    }
  }]);
  return [
    { role: "user", content: "animate the logo drifting upward" },
    { role: "assistant", content: JSON.stringify({
        reply: "Generating.",
        commands: [{ tool: "comfy_generate",
                     args: { workflow: "AE_LLAMA_H3_I2V_V1" } }] }) },
    { role: "user", content: "TOOL RESULTS:\n" + bigResult },
    { role: "assistant", content: JSON.stringify({
        reply: "Imported the clip.", commands: [] }) }
  ];
}

function sizeOf(entries) {
  let n = 0;
  for (const e of entries) n += (e.content || "").length + 16;
  return n;
}

// ---------------------------------------------------------------- A
console.log("\n== A. the arithmetic, with no server in the room ==\n");

const s = Settings.get();
const history = oversizedTail(60000);
const budgetChars = Tools.historyBudget(s.ctxSize, 42000).chars;

const first = Tools.fitHistory(history, budgetChars);
claim(sizeOf(first.entries) <= budgetChars,
      "THE CONTRACT: fitHistory never returns a payload it knows is too big",
      sizeOf(first.entries) + " chars against a " + budgetChars +
      "-char budget");

const retry = Tools.fitHistory(history, 1);
claim(sizeOf(retry.entries) < sizeOf(first.entries),
      "and the retry sends FEWER bytes than the attempt before it — " +
      "re-sending the same ones is what left the chat dead until cleared",
      sizeOf(retry.entries) + " vs " + sizeOf(first.entries) + " chars");
claim(sizeOf(retry.entries) < 8000,
      "and it reaches something a 16384-token window can actually hold",
      sizeOf(retry.entries) + " chars");
claim(retry.entries.length === 4,
      "without spending the current exchange to get there",
      retry.entries.length + " entries kept");
claim(retry.entries[3].content === history[3].content,
      "and the NEWEST turn survives whole — it carries the sentence " +
      "being answered");

// ---------------------------------------------------------------- C
console.log("\n== C. is the cut legible to whatever reads it? ==\n");

const cut = retry.entries.filter(e => /cut from this message/.test(e.content));
claim(cut.length > 0,
      "a cut message says so in words, in its own body");
if (cut.length) {
  claim(/INCOMPLETE/.test(cut[0].content),
        "and says the end of it is not the end of the data",
        cut[0].content.slice(-120));
  claim(/\b\d{4,}\b/.test(cut[0].content),
        "with the number of characters it replaced");
}
const untouched = Tools.fitHistory(oversizedTail(20), 100000);
claim(untouched.truncated === 0 && untouched.dropped === 0,
      "a history that fits is never cut");

// ---------------------------------------------------------------- B
if (NO_SERVER) {
  finish();
} else {
  console.log("\n== B. the real server, the real 400 ==\n");
  startModel(function (err) {
    if (err) {
      claim(false, "llama-server came up", String(err.message || err));
      finish();
      return;
    }
    // The prompt main.js would send. No AE needed: an empty project is
    // the SMALLEST the system prompt ever gets, so a 400 measured here
    // is a floor on the real one, never an exaggeration of it.
    const system = Tools.buildSystemPrompt(
      JSON.stringify({ project: "(empty)", comps: [] }),
      { compact: Tools.promptModeFor(s.ctxSize).compact });
    console.log("-- system prompt: " + system.length + " chars");

    // Three posts, in the order the panel would have made them.
    // The first is the RAW history — what main.js would have sent with
    // no fitHistory at all. It has to 400, or the rest of this phase is
    // measuring nothing.
    post(system, history, function (code0, body0) {
      claim(code0 === 400 && /context/i.test(body0),
            "the raw four-entry tail really is past the window — the " +
            "situation is real, not a fixture",
            "HTTP " + code0 + ": " + body0.slice(0, 160));
      post(system, first.entries, function (code1, body1) {
        claim(code1 === 200,
              "THE FIX: what the panel now sends on the FIRST try is " +
              "accepted — the 400 never happens",
              "HTTP " + code1 +
              (code1 === 200 ? "" : ": " + body1.slice(0, 200)));
        post(system, retry.entries, function (code2, body2) {
          claim(code2 === 200,
                "and the reactive retry, if a 400 gets through anyway, " +
                "is accepted too",
                "HTTP " + code2 +
                (code2 === 200 ? "" : ": " + body2.slice(0, 200)));
          finish();
        });
      });
    });
  });
}

function post(system, entries, cb) {
  const body = JSON.stringify({
    model: "default",
    messages: [{ role: "system", content: system }].concat(entries),
    temperature: 0,
    max_tokens: 16,
    cache_prompt: true
  });
  const req = http.request({
    host: "127.0.0.1", port: s.port, path: "/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json",
               "Content-Length": Buffer.byteLength(body) }
  }, function (res) {
    let text = "";
    res.on("data", c => { text += c; });
    res.on("end", () => cb(res.statusCode, text));
  });
  req.on("error", e => cb(0, String(e.message)));
  req.end(body);
}

function finish() {
  const lines = ["# history-floor probe", ""];
  for (const c of claims) {
    lines.push("- " + (c.ok ? "ok" : "**FAIL**") + " — " + c.what +
               (c.detail ? "\n  - " + c.detail.replace(/\n/g, " ") : ""));
  }
  const dir = path.join(ROOT, "logs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "history-floor-probe.md"),
                   lines.join("\n") + "\n");
  console.log("\n" + (failed ? failed + " CLAIM(S) FAILED"
                             : claims.length + "/" + claims.length +
                               " claims held"));
  try { Llama.stop(); } catch (e) {}
  process.exitCode = failed ? 1 : 0;
}
