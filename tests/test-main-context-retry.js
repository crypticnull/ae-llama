// test-main-context-retry.js — main.js's reactive hard-trim retry,
// EXECUTED under strict mode.
//
// Field-shaped bug (found 2026-09-16 while wiring §24c, WORKPLAN NEXT UP
// 13a): `runRound(system, round)` takes `round` as a NUMBER, and main.js
// is "use strict", so the retry's `round.forceTinyContext = true` threw
// `TypeError: Cannot create property 'forceTinyContext' on number '0'`
// inside the llama callback. A context 400 in the panel therefore never
// retried and never called finish(): the panel sat busy on "Thinking…".
// scripts/chat-probe.js never showed it (its `round` is a stats object),
// and every earlier test only grepped main.js for the word.
//
// main.js has no executed coverage (it wires the DOM at load), so this
// file lifts sendMessage's SOURCE out of it and runs it under strict
// mode with stubs for exactly what it closes over. A regex over the
// source proves a word is there; only running it proves it does not
// throw.

"use strict";
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ok  " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}

const ROOT = path.join(__dirname, "..");
const mainSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "main.js"), "utf8");

const start = mainSrc.indexOf("  function sendMessage() {");
const end = mainSrc.indexOf("\n  function cancelMessage()", start);
assert(start > 0 && end > start,
       "sendMessage and the function after it are where this test looks");
assert(/^\(function \(global\) \{\s*"use strict";/m.test(mainSrc),
       "main.js is still strict mode (the condition the bug needs)");
const sendSrc = mainSrc.slice(start, end);

// One scenario: the llama stub answers each chat() call from `replies`
// in order. Returns what the panel did.
function run(replies) {
  const calls = [];       // [{budget}] per Llama.chat call
  const msgs = [];        // appendMsg(kind, text)
  let budgetSeen = null;
  let finished = 0;
  let thrown = null;
  const ctx = {
    els: { chatInput: { value: "make a red solid" },
           clearChatBtn: { disabled: false },
           chat: { scrollTop: 0, scrollHeight: 0 } },
    history: [],
    appendMsg: function (kind, text) {
      msgs.push({ kind: kind, text: String(text) });
      return { textContent: "", parentNode: null };
    },
    fetchProjectState: function (cb) { cb("{}"); },
    setSendMode: function (on) { if (!on) finished++; },
    extractPartialReply: function () { return ""; },
    global: {
      Llama: {
        isRunning: function () { return true; },
        chat: function (opts, messages, schema, onPartial, done) {
          calls.push({ budget: budgetSeen, n: messages.length });
          const r = replies[calls.length - 1];
          // The real client calls back asynchronously, but a synchronous
          // callback is the harsher case: a throw here escapes to us.
          try {
            if (r.err) done({ message: r.err }, null, null);
            else done(null, r.obj, JSON.stringify(r.obj));
          } catch (e) { thrown = e; }
          return { cancel: function () {} };
        }
      },
      AEBridge: { evalScript: function () {} },
      Settings: { get: function () {
        return { ctxSize: 16384, port: 8080, temperature: 0.2,
                 maxRounds: 6, dryRun: false };
      } },
      Tools: {
        RESPONSE_SCHEMA: {},
        promptOptsFor: function () { return { opts: {} }; },
        buildSystemPrompt: function () { return "SYSTEM"; },
        extendPromptOpts: function () { return false; },
        historyBudget: function () {
          return { chars: 40000, starved: false, promptTokens: 10 };
        },
        fitHistory: function (h, budget) {
          budgetSeen = budget;
          return { entries: h.slice(), dropped: 0, truncated: 0,
                   ledger: "" };
        },
        compactToolResults: function () { return "[]"; },
        executeCommands: function () {}
      }
    }
  };
  const names = Object.keys(ctx);
  // The closure vars sendMessage assigns: declared here as main.js's IIFE
  // does, so strict mode sees bindings and not implicit globals.
  const body = '"use strict";\n' +
    "var busy = false, cancelRequested = false, currentChat = null;\n" +
    "var trimNoticeShown = false, starveNoticeShown = false, " +
    "cutNoticeShown = false;\n" +
    sendSrc + "\n" +
    "return { send: sendMessage, busy: function () { return busy; } };";
  const api = new Function(...names, body)(...names.map(n => ctx[n]));
  try { api.send(); } catch (e) { thrown = e; }
  return { calls, msgs, finished, thrown, busy: api.busy() };
}

console.log("a context 400, then a good reply: retried trimmed, finishes");
{
  const r = run([
    { err: "request (17733 tokens) exceeds the available context size " +
           "(16384 tokens)" },
    { obj: { reply: "Done.", commands: [] } }
  ]);
  assert(r.thrown === null,
         "the retry path does not throw under strict mode" +
         (r.thrown ? " (" + r.thrown.message + ")" : ""));
  assert(r.calls.length === 2, "the model is asked twice (got " +
         r.calls.length + ")");
  assert(r.calls[0] && r.calls[0].budget === 40000,
         "the first attempt uses the arithmetic budget");
  assert(r.calls[1] && r.calls[1].budget === 1,
         "the retry keeps only the current exchange (budget 1)");
  assert(r.msgs.some(m => /retrying with older turns trimmed/.test(m.text)),
         "the user is told it is retrying");
  assert(r.msgs.some(m => m.kind === "assistant" && m.text === "Done."),
         "the retried reply reaches the transcript");
  assert(r.finished === 1 && r.busy === false,
         "finish() runs, so the panel is not left busy on Thinking…");
}

console.log("a context 400 twice: ONE retry, then a grounded error");
{
  const e = "the request exceeds the available context size";
  const r = run([{ err: e }, { err: e }, { err: e }]);
  assert(r.thrown === null, "no throw on the second refusal either");
  assert(r.calls.length === 2, "exactly one retry, not a loop (got " +
         r.calls.length + ")");
  assert(r.msgs.some(m => m.kind === "error" && /Model error/.test(m.text)),
         "the second refusal is reported as an error");
  assert(r.finished === 1 && r.busy === false,
         "and the panel is released");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
