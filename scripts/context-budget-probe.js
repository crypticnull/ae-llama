/*
 * context-budget-probe.js — is the panel's context arithmetic TRUE?
 *
 * WORKPLAN 1c, "context budget + ledger" (roadmap 13). tools.js budgets
 * the window with two constants — PROMPT_CHARS_PER_TOKEN (3.9) and
 * HISTORY_CHARS_PER_TOKEN (3) — that were estimates, never measured
 * against a tokenizer. Everything downstream rides on them: how much
 * history a round may carry, whether the "context" starvation line
 * fires, and whether a long chat dies on a raw HTTP 400.
 *
 * This asks the RUNNING llama-server's /tokenize for the truth, on the
 * product's own payload:
 *
 *   A. the real system prompt, both forms (full docs and compact docs),
 *      built from the real project state read out of real AE;
 *   B. a real conversation — ten turns that each NAME something, then
 *      one turn that refers back ("make them blue instead") — driven
 *      through chat-probe.js's own round loop, with every round's
 *      system + history tokenized as it was actually sent;
 *   C. what Tools.historyBudget() promises at 16384 and at 32768, in
 *      both prompt forms, against what A and B measured.
 *
 * Nothing here re-implements the panel: the round loop, the AE bridge
 * and the panel modules all come from scripts/chat-probe.js (which runs
 * nothing on require). A second copy of the budgeter is exactly the bug
 * this probe exists to find.
 *
 *   node scripts/context-budget-probe.js                # everything
 *   node scripts/context-budget-probe.js --reuse-server # server is up
 *   node scripts/context-budget-probe.js --no-chat      # phase A + C only
 *   node scripts/context-budget-probe.js --keep         # leave the comp
 *
 * Needs After Effects running with "Allow Scripts to Write Files and
 * Access Network" enabled, and a llama-server it can reach (it starts
 * one from the panel's settings unless --reuse-server).
 *
 * Writes a markdown report to logs/ and exits 0 only if every measured
 * claim held.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const probe = require("./chat-probe.js");
const { Tools, Settings, say, aeRead, startModel,
        sendMessage, setRoundObserver, history, sessionNotices } = probe;

const ROOT = path.join(__dirname, "..");
const COMP = "Ctx Probe";

const argv = process.argv.slice(2);
const OPT = {
  noChat: argv.indexOf("--no-chat") !== -1,
  keep: argv.indexOf("--keep") !== -1
};

let failed = 0;
const claims = [];
/**
 * One measured claim. `ok` false is a finding, not a crash — the report
 * is the deliverable, so the probe always finishes and always writes it.
 */
function claim(ok, text, detail) {
  claims.push({ ok: !!ok, text, detail: detail || "" });
  if (!ok) failed++;
  say(ok ? "verdict" : "error",
      (ok ? "OK   " : "MISS ") + text + (detail ? "\n     " + detail : ""));
}

// ------------------------------------------------------------ /tokenize

/**
 * The tokenizer's own count for a string. `with_pieces` is off: the
 * count is all this needs, and the pieces of a 59 KB prompt are 15k
 * objects nobody reads.
 */
function tokenize(text, cb) {
  const s = Settings.get();
  const body = JSON.stringify({ content: text });
  const req = http.request({
    host: "127.0.0.1", port: s.port, path: "/tokenize", method: "POST",
    headers: { "Content-Type": "application/json",
               "Content-Length": Buffer.byteLength(body) }
  }, function (res) {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", d => { buf += d; });
    res.on("end", function () {
      let obj = null;
      try { obj = JSON.parse(buf); } catch (e) {}
      if (!obj || !(obj.tokens instanceof Array)) {
        cb(null, new Error("/tokenize answered: " + buf.slice(0, 200)));
        return;
      }
      cb(obj.tokens.length, null);
    });
  });
  req.on("error", e => cb(null, e));
  req.write(body);
  req.end();
}

function ratio(chars, tokens) { return chars / tokens; }
function pct(a, b) { return ((a - b) / b) * 100; }
function f2(n) { return (Math.round(n * 100) / 100).toFixed(2); }

// The two constants under test, read out of the shipped source rather
// than retyped here — a probe that carries its own copy of the number
// it is checking cannot fail.
const toolsSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "tools.js"), "utf8");
function constFromTools(name) {
  const m = toolsSrc.match(new RegExp("var\\s+" + name + "\\s*=\\s*([0-9.]+)"));
  return m ? Number(m[1]) : NaN;
}
const ASSUMED_PROMPT = constFromTools("PROMPT_CHARS_PER_TOKEN");
const ASSUMED_HISTORY = constFromTools("HISTORY_CHARS_PER_TOKEN");

// The tolerance the workplan set: off by more than 10% and the constant
// is wrong, not merely conservative.
const TOLERANCE = 10;

const measured = { prompt: null, promptCompact: null, history: null,
                   rounds: [], full: null, compact: null };

// ------------------------------------------------------- phase A: prompt

function phaseA(next) {
  say("info", "phase A — the system prompt, both forms, through /tokenize");
  Tools.fetchProjectState(function (stateJson) {
    const full = Tools.buildSystemPrompt(stateJson, { compact: false });
    const compact = Tools.buildSystemPrompt(stateJson, { compact: true });
    measured.full = full;
    measured.compact = compact;
    say("info", "state " + stateJson.length + " chars; prompt " +
        full.length + " full / " + compact.length + " compact");
    tokenize(full, function (fullTok, err) {
      if (err) { claim(false, "/tokenize reachable", err.message); next(); return; }
      tokenize(compact, function (compactTok, err2) {
        if (err2) { claim(false, "/tokenize reachable", err2.message); next(); return; }
        measured.prompt = { chars: full.length, tokens: fullTok,
                            ratio: ratio(full.length, fullTok) };
        measured.promptCompact = { chars: compact.length, tokens: compactTok,
                                   ratio: ratio(compact.length, compactTok) };
        say("info", "full   " + full.length + " chars = " + fullTok +
            " tokens (" + f2(measured.prompt.ratio) + " chars/token)");
        say("info", "compact " + compact.length + " chars = " + compactTok +
            " tokens (" + f2(measured.promptCompact.ratio) + " chars/token)");
        const off = pct(measured.prompt.ratio, ASSUMED_PROMPT);
        claim(Math.abs(off) <= TOLERANCE,
              "PROMPT_CHARS_PER_TOKEN (" + ASSUMED_PROMPT + ") is within " +
              TOLERANCE + "% of the tokenizer",
              "measured " + f2(measured.prompt.ratio) + " chars/token on " +
              "the full prompt (" + (off >= 0 ? "+" : "") + f2(off) + "%)");
        // The direction that can KILL a chat: the panel divides chars by
        // this constant to predict tokens, so a real ratio BELOW the
        // assumed one means more tokens than predicted — the estimate
        // undershoots and the 400 comes back.
        claim(measured.prompt.ratio >= ASSUMED_PROMPT,
              "the prompt estimate does not undershoot (real chars/token " +
              ">= assumed)",
              "assumed " + ASSUMED_PROMPT + ", measured " +
              f2(measured.prompt.ratio));
        next();
      });
    });
  });
}

// -------------------------------------------------------- phase B: chat

// Ten turns that each NAME a thing, then one that refers back to all of
// them. Deliberately plain asks: the point is the ledger, not routing —
// a step that fails to route still names something the ledger must
// carry, and the last turn is the only one being judged on memory.
const NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo",
               "Foxtrot", "Golf", "Hotel", "India", "Juliet"];
const TURNS = NAMES.map(n =>
  "In " + COMP + ", add a 200x200 white solid called " + n + ".");
const RECALL = "Make them blue instead.";

function phaseB(next) {
  if (OPT.noChat) { say("info", "phase B skipped (--no-chat)"); next(); return; }
  say("info", "phase B — ten naming turns, then one that refers back");

  setRoundObserver(function (r) {
    const histChars = r.messages.slice(1)
      .reduce((n, m) => n + (m.content || "").length, 0);
    measured.rounds.push({
      turn: measured.rounds.length,
      systemChars: r.system.length,
      histChars: histChars,
      histEntries: r.messages.length - 1,
      dropped: r.fitted.dropped,
      ledger: r.fitted.ledger || "",
      hb: r.hb,
      ctxSize: r.ctxSize,
      // Tokenized after the run, in one batch: /tokenize is a round trip
      // and the chat is already the slow part.
      systemText: r.system,
      histText: r.messages.slice(1).map(m => m.content || "").join("\n")
    });
  });

  Tools.callHostTool("create_comp", {
    name: COMP, width: 1920, height: 1080, duration: 6, frameRate: 30
  }, function () {
    let i = 0;
    (function step() {
      if (i < TURNS.length) {
        say("info", "--- turn " + (i + 1) + "/" + TURNS.length);
        sendMessage(TURNS[i++], step);
        return;
      }
      say("info", "--- recall turn");
      sendMessage(RECALL, function (round) {
        setRoundObserver(null);
        judgeChat(round, next);
      });
    })();
  });
}

/** Everything phase B can decide without another AE round trip. */
function judgeChat(round, next) {
  const withLedger = measured.rounds.filter(r => r.ledger);
  claim(withLedger.length > 0,
        "a ten-turn chat at ctx " + Settings.get().ctxSize +
        " overflows and produces a ledger",
        measured.rounds.length + " round(s) observed, " +
        withLedger.length + " carried a ledger");

  const last = measured.rounds[measured.rounds.length - 1];
  if (last && last.ledger) {
    // The whole promise of the ledger: the model can still answer
    // "make THEM blue" because the names it can no longer see in full
    // are in the roll-up.
    const carried = NAMES.filter(n => last.ledger.indexOf(n) !== -1);
    claim(carried.length >= 3,
          "the ledger on the recall turn carries the names the dropped " +
          "turns created",
          carried.length + " of " + NAMES.length + " names present: " +
          carried.join(", "));
    claim(/EARLIER IN THIS SESSION/.test(last.ledger),
          "and it is labelled so the model knows what it is reading");
  } else {
    claim(false, "the recall turn had a ledger to read",
          "no ledger on the last observed round");
  }

  claim(sessionNotices.ledger,
        "the panel's 'context ledger' info line fired (once per chat)");
  claim(round && round.failures.length === 0,
        "the recall turn ran without a tool failure",
        round ? (round.failures.join("; ") || "none") : "no round record");

  next();
}

/** Token counts for what phase B really sent, one round at a time. */
function tokenizeRounds(next) {
  let i = 0;
  (function step() {
    if (i >= measured.rounds.length) { next(); return; }
    const r = measured.rounds[i];
    tokenize(r.systemText, function (sysTok, err) {
      if (err) { r.error = err.message; i++; step(); return; }
      r.systemTokens = sysTok;
      if (!r.histChars) { r.histTokens = 0; i++; step(); return; }
      tokenize(r.histText, function (histTok, err2) {
        if (err2) { r.error = err2.message; i++; step(); return; }
        r.histTokens = histTok;
        i++; step();
      });
    });
  })();
}

function judgeTokens(next) {
  const usable = measured.rounds.filter(r => r.histTokens > 0);
  if (!usable.length) {
    if (!OPT.noChat) claim(false, "phase B produced tokenizable history");
    next();
    return;
  }
  const chars = usable.reduce((n, r) => n + r.histChars, 0);
  const tokens = usable.reduce((n, r) => n + r.histTokens, 0);
  measured.history = { chars, tokens, ratio: ratio(chars, tokens) };
  say("info", "history " + chars + " chars = " + tokens + " tokens (" +
      f2(measured.history.ratio) + " chars/token) over " + usable.length +
      " round(s)");
  const off = pct(measured.history.ratio, ASSUMED_HISTORY);
  claim(Math.abs(off) <= TOLERANCE,
        "HISTORY_CHARS_PER_TOKEN (" + ASSUMED_HISTORY + ") is within " +
        TOLERANCE + "% of the tokenizer",
        "measured " + f2(measured.history.ratio) + " chars/token (" +
        (off >= 0 ? "+" : "") + f2(off) + "%)");
  claim(measured.history.ratio >= ASSUMED_HISTORY,
        "the history estimate does not undershoot",
        "assumed " + ASSUMED_HISTORY + ", measured " +
        f2(measured.history.ratio));

  // The claim that actually matters to a user: no round the panel let
  // through was bigger than the window it was sent to.
  let worst = null;
  for (const r of usable) {
    const total = r.systemTokens + r.histTokens;
    if (!worst || total > worst.total) worst = { r, total };
  }
  claim(worst && worst.total < worst.r.ctxSize,
        "no round exceeded the context window it was sent to",
        worst ? ("worst round: " + worst.total + " tokens against ctx " +
                 worst.r.ctxSize) : "");
  next();
}

// ------------------------------------------------- phase C: the promise

const TABLE = [];
function phaseC() {
  say("info", "phase C — what historyBudget() promises, against A and B");
  if (!measured.full) return;
  for (const ctx of [16384, 32768]) {
    const mode = Tools.promptModeFor(ctx);
    const text = mode.compact ? measured.compact : measured.full;
    const meas = mode.compact ? measured.promptCompact : measured.prompt;
    const hb = Tools.historyBudget(ctx, text.length);
    const realTokens = meas ? meas.tokens : null;
    TABLE.push({ ctx, compact: mode.compact, chars: text.length,
                 estTokens: hb.promptTokens, realTokens,
                 roomTokens: hb.roomTokens, histChars: hb.chars,
                 starved: hb.starved });
    say("info", "ctx " + ctx + " (" + (mode.compact ? "compact" : "full") +
        " docs): prompt " + text.length + " chars, estimated " +
        hb.promptTokens + " tokens" +
        (realTokens ? " / real " + realTokens : "") + ", room " +
        hb.roomTokens + " tokens, history budget " + hb.chars +
        " chars, starved=" + hb.starved);
  }
  const small = TABLE[0], big = TABLE[1];
  claim(small && small.realTokens !== null &&
        small.estTokens >= small.realTokens,
        "at ctx 16384 the estimate covers the real prompt",
        small ? ("estimated " + small.estTokens + ", real " +
                 small.realTokens) : "");
  claim(big && big.histChars > small.histChars,
        "raising the window really buys history",
        small && big ? (small.histChars + " chars at 16384 -> " +
                        big.histChars + " at 32768") : "");
}

// ------------------------------------------------------------- cleanup

function cleanup(next) {
  if (OPT.keep || OPT.noChat) { next(); return; }
  aeRead(
    "var killed = 0, i, it;" +
    "for (i = app.project.numItems; i >= 1; i--) {" +
    "  it = app.project.item(i);" +
    "  if (it instanceof CompItem && it.name.indexOf(" +
    JSON.stringify(COMP) + ") === 0) { it.remove(); killed++; }" +
    "}" +
    // Only the solids this probe's own turns named, and only when
    // nothing else uses them: the probe runs in the user's live project.
    "var mine = " + JSON.stringify(NAMES) + ";" +
    "for (i = app.project.numItems; i >= 1; i--) {" +
    "  it = app.project.item(i);" +
    "  if (!(it instanceof FootageItem)) continue;" +
    "  var hit = false, j;" +
    "  for (j = 0; j < mine.length; j++) {" +
    "    if (it.name === mine[j] || it.name.indexOf(mine[j] + \" \") === 0) hit = true;" +
    "  }" +
    "  if (!hit) continue;" +
    "  try { if (it.usedIn.length === 0) { it.remove(); killed++; } }" +
    "  catch (e) {}" +
    "}" +
    "return { removed: killed };",
    function (res) {
      say("info", "cleaned up " + ((res && res.removed) || 0) + " item(s)");
      next();
    });
}

// -------------------------------------------------------------- report

function writeReport() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = [];
  out.push("# context budget probe " + stamp, "");
  const s = Settings.get();
  out.push("- model: `" + s.modelPath + "`");
  out.push("- ctx " + s.ctxSize + ", temperature " + s.temperature);
  out.push("- assumed PROMPT_CHARS_PER_TOKEN " + ASSUMED_PROMPT +
           ", HISTORY_CHARS_PER_TOKEN " + ASSUMED_HISTORY, "");

  out.push("## measured chars/token", "");
  out.push("| what | chars | tokens | chars/token | assumed | off |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  const row = (what, m, assumed) => m && out.push("| " + what + " | " +
    m.chars + " | " + m.tokens + " | " + f2(m.ratio) + " | " + assumed +
    " | " + (pct(m.ratio, assumed) >= 0 ? "+" : "") +
    f2(pct(m.ratio, assumed)) + "% |");
  row("system prompt, full docs", measured.prompt, ASSUMED_PROMPT);
  row("system prompt, compact docs", measured.promptCompact, ASSUMED_PROMPT);
  row("chat history (JSON-heavy)", measured.history, ASSUMED_HISTORY);
  out.push("");

  if (TABLE.length) {
    out.push("## Tools.historyBudget()", "");
    out.push("| ctx | docs | prompt chars | est tokens | real tokens | " +
             "room tokens | history budget | starved |");
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const t of TABLE) {
      out.push("| " + t.ctx + " | " + (t.compact ? "compact" : "full") +
        " | " + t.chars + " | " + t.estTokens + " | " +
        (t.realTokens === null ? "—" : t.realTokens) + " | " +
        t.roomTokens + " | " + t.histChars + " | " + t.starved + " |");
    }
    out.push("");
  }

  if (measured.rounds.length) {
    out.push("## per round, as sent", "");
    out.push("| # | system chars | system tokens | history entries | " +
             "history chars | history tokens | dropped | ledger chars |");
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    measured.rounds.forEach((r, i) => out.push("| " + (i + 1) + " | " +
      r.systemChars + " | " + (r.systemTokens || "—") + " | " +
      r.histEntries + " | " + r.histChars + " | " +
      (r.histTokens || "—") + " | " + r.dropped + " | " +
      r.ledger.length + " |"));
    out.push("");
    const withLedger = measured.rounds.filter(r => r.ledger);
    if (withLedger.length) {
      out.push("## the ledger on the last round that had one", "");
      out.push("```");
      out.push(withLedger[withLedger.length - 1].ledger);
      out.push("```", "");
    }
  }

  out.push("## claims", "");
  for (const c of claims) {
    out.push("- " + (c.ok ? "**OK**" : "**MISS**") + " — " + c.text +
             (c.detail ? "  \n  " + c.detail : ""));
  }
  out.push("");

  const dir = path.join(ROOT, "logs");
  try { fs.mkdirSync(dir); } catch (e) {}
  const file = path.join(dir, "context-budget-" + stamp + ".md");
  fs.writeFileSync(file, out.join("\n"), "utf8");
  console.log("\nreport: " + file);
}

// ----------------------------------------------------------------- main

function main() {
  if (!probe.AFTERFX) {
    console.error("AfterFX.exe not found");
    process.exit(2);
  }
  startModel(function (err) {
    if (err) {
      console.error("!! could not start the model: " + err.message);
      process.exit(3);
    }
    say("info", "model ready");
    phaseA(function () {
      phaseB(function () {
        tokenizeRounds(function () {
          judgeTokens(function () {
            phaseC();
            cleanup(function () {
              writeReport();
              console.log(failed
                ? "\n" + failed + " claim(s) MISSED"
                : "\nevery claim held");
              process.exit(failed ? 1 : 0);
            });
          });
        });
      });
    });
  });
}

if (require.main === module) main();
else module.exports = { tokenize, TURNS, RECALL, NAMES, COMP };
