/*
 * kv-quant-probe.js — what KV-cache quantization buys on THIS card,
 * measured through a standalone llama-server (WORKPLAN §13b, NEXT UP 11).
 *
 * Standalone on purpose: llama.js spawnServer's argv is closed, and adding
 * the flags there to take a reading would ship them to every user before
 * §13b's "detect and fall back" guard exists (§13b, review 2026-09-05).
 * No extension/ change, so no bump.
 *
 * For each model x window x KV type: a card baseline, then llama-server
 * spawned with the panel's argv plus `-ctk T -ctv T`, nvidia-smi streamed
 * at 25 ms through load and one fixed completion (~3 000 prompt tokens,
 * 256 generated, temperature 0), the server's own buffer lines, and its
 * prompt/generation tokens per second. "shipped" is the panel's argv
 * with nothing added — the row every other row is compared against.
 *
 *   node scripts/kv-quant-probe.js                       # default matrix
 *   node scripts/kv-quant-probe.js --models 7B --ctx 16384 --kv shipped,q8_0
 *   node scripts/kv-quant-probe.js --serve --kv q8_0     # leave ONE up on
 *        the settings port, for `chat-probe.js --reuse-server` (the
 *        accuracy half of §13b); Ctrl+C stops it
 *   --out <file.md>   default docs/measured/kv-quant-<date>.md
 *
 * Needs no After Effects. Uses the GPU: overnight / owner-started loop only.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, spawnSync, execFileSync } = require("child_process");
const KV = require("./lib/kv-quant.js");

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const has = function (n) { return argv.indexOf(n) !== -1; };

const appdata = process.env.APPDATA || "";
const settingsFile = path.join(appdata, "AE-Llama", "settings.json");
let S = {};
try { S = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch (e) {}
const serverPath = argValue("--server", S.serverPath);
const modelsDir = S.modelsDir || path.join(appdata, "AE-Llama", "models");

function resolveModels(spec) {
  const files = fs.existsSync(modelsDir)
    ? fs.readdirSync(modelsDir).filter(function (f) { return /\.gguf$/i.test(f); })
    : [];
  return spec.split(",").map(function (tag) {
    if (fs.existsSync(tag)) return tag;
    const hit = files.filter(function (f) {
      return f.toLowerCase().indexOf("-" + tag.toLowerCase() + "-") !== -1;
    })[0];
    if (!hit) {
      console.error("no model matches '" + tag + "' in " + modelsDir +
                    " — present: " + (files.join(", ") || "(none)"));
      process.exit(2);
    }
    return path.join(modelsDir, hit);
  });
}

const OPT = {
  models: resolveModels(argValue("--models", "7B,32B")),
  ctx: argValue("--ctx", "8192,16384,32768").split(",").map(Number),
  kv: argValue("--kv", "shipped,q8_0,q4_0").split(","),
  port: parseInt(argValue("--port", has("--serve") ? String(S.port || 8737) : "8791"), 10),
  sampleMs: parseInt(argValue("--sample-ms", "25"), 10),
  nPredict: parseInt(argValue("--n-predict", "256"), 10),
  out: argValue("--out", path.join(ROOT, "docs", "measured",
    "kv-quant-" + new Date().toISOString().slice(0, 10) + ".md")),
  serve: has("--serve")
};

function say(s) { console.log("[" + new Date().toTimeString().slice(0, 8) + "] " + s); }

function cardUsed() {
  try {
    const out = execFileSync("nvidia-smi",
      ["--query-gpu=memory.used,memory.total,name", "--format=csv,noheader,nounits"],
      { encoding: "utf8" });
    const p = out.trim().split(/\r?\n/)[0].split(",").map(function (x) { return x.trim(); });
    return { used: parseInt(p[0], 10), total: parseInt(p[1], 10), name: p[2] };
  } catch (e) { return null; }
}

function startWitness(ms) {
  const w = { peak: 0, n: 0 };
  const p = spawn("nvidia-smi", ["--query-gpu=memory.used",
    "--format=csv,noheader,nounits", "-lms", String(ms)]);
  let buf = "";
  p.stdout.on("data", function (d) {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (ln) {
      const mb = parseInt(ln.trim(), 10);
      if (!isNaN(mb)) { w.n++; if (mb > w.peak) w.peak = mb; }
    });
  });
  p.on("error", function () {});
  w.stop = function () { try { p.kill(); } catch (e) {} };
  return w;
}

function request(method, route, body, timeoutMs) {
  return new Promise(function (resolve) {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: "127.0.0.1", port: OPT.port, path: route,
      method: method, timeout: timeoutMs,
      headers: data ? { "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(data) } : {} },
      function (res) {
        let s = "";
        res.on("data", function (d) { s += d; });
        res.on("end", function () { resolve({ status: res.statusCode, body: s }); });
      });
    req.on("error", function (e) { resolve({ status: 0, body: e.message }); });
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// ~3 000 tokens of plain prose, identical for every row.
const PARA = "The motion designer opens a composition, selects the title layer, " +
  "adds a gentle ease to its position keyframes, and asks for a soft drop " +
  "shadow that follows the text as it slides in from the left edge. ";
const PROMPT = new Array(64).join(PARA) + "\nSummarise the request above in one list:";

async function waitSettled(baseline) {
  // After a kill the card takes a moment to hand memory back.
  for (let i = 0; i < 60; i++) {
    const c = cardUsed();
    if (c && c.used <= baseline + 150) return c.used;
    await sleep(500);
  }
  const c = cardUsed();
  return c ? c.used : null;
}

async function runOne(model, ctx, kv, idleBaseline) {
  const row = { model: path.basename(model), ctx: ctx, kv: kv };
  row.baselineMiB = await waitSettled(idleBaseline);
  const args = KV.buildArgs({ modelPath: model, port: OPT.port, ctx: ctx, kv: kv });
  say("start " + row.model + " ctx " + ctx + " kv " + kv);
  const w = startWitness(OPT.sampleMs);
  const t0 = Date.now();
  const proc = spawn(serverPath, args, { cwd: path.dirname(serverPath), windowsHide: true });
  let log = "";
  let exited = null;
  proc.stdout.on("data", function (d) { log += d; });
  proc.stderr.on("data", function (d) { log += d; });
  proc.on("exit", function (code) { exited = code; });

  let up = false;
  for (let i = 0; i < 600 && exited === null; i++) {
    const h = await request("GET", "/health", null, 2000);
    if (h.status === 200) { up = true; break; }
    await sleep(500);
  }
  row.loadSec = +((Date.now() - t0) / 1000).toFixed(1);
  if (up) {
    const r = await request("POST", "/completion", {
      prompt: PROMPT, n_predict: OPT.nPredict, temperature: 0,
      cache_prompt: false, ignore_eos: true }, 600000);
    try {
      const j = JSON.parse(r.body);
      const tm = j.timings || {};
      row.promptTokens = tm.prompt_n;
      row.promptTps = tm.prompt_per_second != null ? +tm.prompt_per_second.toFixed(1) : null;
      row.genTokens = tm.predicted_n;
      row.genTps = tm.predicted_per_second != null ? +tm.predicted_per_second.toFixed(1) : null;
      row.textHead = String(j.content || "").slice(0, 80).replace(/\s+/g, " ");
    } catch (e) { row.error = "completion: HTTP " + r.status + " " + String(r.body).slice(0, 160); }
  } else {
    row.error = exited !== null ? "server exited " + exited : "server never answered /health";
  }
  await sleep(300);
  w.stop();
  try { proc.kill(); } catch (e) {}
  for (let i = 0; i < 40 && exited === null; i++) await sleep(250);
  row.peakMiB = w.peak || null;
  row.samples = w.n;
  row.deltaMiB = (row.peakMiB && row.baselineMiB != null) ? row.peakMiB - row.baselineMiB : null;
  Object.assign(row, KV.parseServerLog(log));
  if (row.rejected && !row.error) row.error = row.rejected;
  say("  -> " + (row.error ? "ERROR " + row.error : "delta " + row.deltaMiB +
      " MiB, KV " + row.kvMiB + " MiB (" + row.kType + "/" + row.vType + "), fa " +
      row.flashAttn + ", pp " + row.promptTps + " t/s, tg " + row.genTps + " t/s"));
  return row;
}

function fmt(v) { return v == null ? "—" : String(v); }

function report(rows, card, startedAt) {
  const L = [];
  L.push("# KV-cache quantization on llama-server — " + startedAt.slice(0, 10));
  L.push("");
  L.push("Generated by `node scripts/kv-quant-probe.js` (WORKPLAN §13b, NEXT UP 11).");
  L.push("Card: " + (card ? card.name + ", " + card.total + " MiB" : "unknown") +
         ". Server: `" + path.basename(serverPath) + "` build " + serverBuild() +
         ". nvidia-smi streamed at " + OPT.sampleMs + " ms; delta = peak - settled idle before spawn.");
  L.push("One completion per row: ~" + (rows[0] && rows[0].promptTokens || "3000") +
         " prompt tokens, " + OPT.nPredict + " generated, temperature 0, cache off.");
  L.push("`shipped` = the panel's argv today (no -ctk/-ctv/-fa; this build's -fa default is auto).");
  L.push("");
  L.push("| model | ctx | kv | card delta MiB | KV buf MiB | model MiB | compute MiB | fa | slots | pp t/s | tg t/s | load s | note |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  rows.forEach(function (r) {
    L.push("| " + [r.model.replace(/\.gguf$/i, ""), r.ctx, r.kv, fmt(r.deltaMiB), fmt(r.kvMiB),
      fmt(r.modelMiB), fmt(r.computeMiB), fmt(r.flashAttn) + (r.flashForced ? " (forced)" : ""),
      fmt(r.nSlots), fmt(r.promptTps), fmt(r.genTps), fmt(r.loadSec),
      r.error ? "ERROR " + r.error : (r.fitChanged ? "-fit CHANGED params" : "")].join(" | ") + " |");
  });
  L.push("");
  return L.join("\n");
}

function serverBuild() {
  // --version prints to stderr on this build.
  const r = spawnSync(serverPath, ["--version"], { encoding: "utf8" });
  const m = /version: (\S+ \(\w+\))/.exec(String(r.stdout || "") + String(r.stderr || ""));
  return m ? m[1] : "?";
}

async function main() {
  if (!serverPath || !fs.existsSync(serverPath)) {
    console.error("llama-server not found at '" + serverPath + "' (settings: " + settingsFile + ")");
    process.exit(2);
  }
  const card = cardUsed();
  if (!card) { console.error("nvidia-smi gave nothing — no card to measure"); process.exit(2); }
  const busy = await request("GET", "/health", null, 1500);
  if (busy.status !== 0) {
    console.error("port " + OPT.port + " already answers — refusing to measure alongside another server");
    process.exit(2);
  }

  if (OPT.serve) {
    const args = KV.buildArgs({ modelPath: OPT.models[0], port: OPT.port,
      ctx: OPT.ctx[0], kv: OPT.kv[0], verbose: false });
    say("serving: " + serverPath + " " + args.join(" "));
    const p = spawn(serverPath, args, { cwd: path.dirname(serverPath), stdio: "inherit" });
    process.on("SIGINT", function () { try { p.kill(); } catch (e) {} process.exit(0); });
    p.on("exit", function (c) { process.exit(c || 0); });
    return;
  }

  const startedAt = new Date().toISOString();
  say("card " + card.name + ": " + card.used + " / " + card.total + " MiB used at start");
  const rows = [];
  for (const m of OPT.models) {
    for (const ctx of OPT.ctx) {
      for (const kv of OPT.kv) {
        rows.push(await runOne(m, ctx, kv, card.used));
        fs.mkdirSync(path.dirname(OPT.out), { recursive: true });
        fs.writeFileSync(OPT.out, report(rows, card, startedAt));
        fs.writeFileSync(OPT.out.replace(/\.md$/, ".json"), JSON.stringify(rows, null, 1));
      }
    }
  }
  say("wrote " + OPT.out);
  process.exit(rows.some(function (r) { return r.error; }) ? 1 : 0);
}

main();
