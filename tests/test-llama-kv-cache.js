// test-llama-kv-cache.js — llama.js ships a q8_0 KV cache and falls back
// when a server refuses it (WORKPLAN §13b, NEXT UP 11c).
//
// Pinned, EXECUTED against a fake child process and a fake HTTP server:
//   1. the argv carries `-ctk q8_0 -ctv q8_0`, never q4_0 (q4_0 on the key
//      cache garbles every answer from a server that loads HEALTHY, so no
//      fallback could catch it), and no bare `-fa`;
//   2. a server that refuses the cache and exits still ends "running",
//      after exactly one respawn on the plain argv, with the reason logged;
//   3. the refusal printed AFTER 'exit' (Node does not drain pipes first)
//      is still seen;
//   4. an unrelated early exit, or a refusal of some other argument, is
//      NOT answered by respawning;
//   5. a user stop during load never respawns;
//   6. the panel and scripts/lib/kv-quant.js read the same REAL refusal
//      lines (build 10240, captured 2026-09-16).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EventEmitter = require("events");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ok  " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}

const ROOT = path.join(__dirname, "..");
const llamaSrc = fs.readFileSync(path.join(ROOT, "extension", "js", "llama.js"), "utf8");
const KV = require(path.join(ROOT, "scripts", "lib", "kv-quant.js"));

const REAL_BAD_TYPE = 'error while handling argument "-ctk": Unsupported cache type: bogus';
const REAL_BAD_FLAG = "error: invalid argument: --cache-type-k";

// behaviours: array, one per spawn: { refuse: "text", late: bool } | "healthy" | { die: "text" }
function load(behaviours) {
  const spawns = [];
  const logs = [];
  let current = null;
  const child_process = {
    spawn(exe, args) {
      const b = behaviours[spawns.length] || "healthy";
      const p = new EventEmitter();
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      p.pid = 1000 + spawns.length;
      p.kill = () => {};
      p.healthy = b === "healthy";
      spawns.push({ args: args.slice(), proc: p });
      current = p;
      if (b !== "healthy") {
        const text = b.refuse || b.die;
        setTimeout(() => {
          if (b.late) {
            p.emit("exit", 1, null);
            p.stderr.emit("data", Buffer.from(text + "\n"));
          } else {
            p.stderr.emit("data", Buffer.from(text + "\n"));
            p.emit("exit", 1, null);
          }
          setTimeout(() => p.emit("close", 1, null), 5);
        }, 10);
      }
      return p;
    },
    execFile(cmd, args, cb) { if (cb) cb(null, ""); }
  };
  const http = {
    request(o, onRes) {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => setTimeout(() => {
        if (!current || !current.healthy) { req.emit("error", new Error("ECONNREFUSED")); return; }
        const res = new EventEmitter();
        res.statusCode = 200;
        onRes(res);
        res.emit("data", Buffer.from(o.path === "/props" ? '{"model_path":"C:/m/model.gguf"}' : "{}"));
        res.emit("end");
      }, 1);
      return req;
    }
  };
  const store = {};
  const win = {
    AEBridge: {
      nodeRequire(name) {
        if (name === "child_process") return child_process;
        if (name === "http") return http;
        if (name === "fs") return { existsSync: () => true, readdirSync: () => [], statSync() { throw new Error(); } };
        if (name === "buffer") return { Buffer };
        return require(name);
      },
      getExtensionPath: () => ""
    },
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; }
    },
    setTimeout, clearInterval, setInterval
  };
  vm.runInNewContext(llamaSrc, { window: win, JSON });
  win.Llama.on("log", (l) => logs.push(l));
  return { Llama: win.Llama, spawns, logs };
}

const OPTS = { serverPath: "C:/v/llama-server.exe", modelPath: "C:/m/model.gguf",
               port: 8737, ctxSize: 16384, gpuLayers: 99 };

function start(env) {
  return new Promise((resolve) => {
    const calls = [];
    env.Llama.start(OPTS, (err) => { calls.push(err); });
    const t0 = Date.now();
    (function wait() {
      const s = env.Llama.getState();
      if ((s === "running" || s === "error" || s === "stopped") && calls.length) {
        setTimeout(() => resolve({ calls, state: env.Llama.getState() }), 30);
      } else if (Date.now() - t0 > 8000) resolve({ calls, state: s, timedOut: true });
      else setTimeout(wait, 20);
    })();
  });
}

const has = (args, a, b) => args.some((x, i) => x === a && args[i + 1] === b);

(async function () {
  // ---- 1. the argv
  {
    const a = load([]).Llama.serverArgs(OPTS, false);
    assert(has(a, "-ctk", "q8_0") && has(a, "-ctv", "q8_0"), "argv carries -ctk q8_0 -ctv q8_0");
    assert(!a.includes("q4_0"), "argv NEVER carries q4_0 (a garbled key cache loads healthy)");
    assert(!a.includes("-fa") && !a.includes("--flash-attn"), "no -fa: it takes a value on build 10240 and is auto-on");
    const plain = load([]).Llama.serverArgs(OPTS, true);
    assert(!plain.includes("-ctk") && !plain.includes("-ctv"), "the fallback argv carries no cache flags");
    assert(/var KV_CACHE_TYPE = "q8_0";/.test(llamaSrc) && !/settings?\.\w*kv/i.test(llamaSrc),
      "the cache type is a constant in llama.js, not read from settings");
  }

  // ---- 2. healthy first time: one spawn, quantized
  {
    const env = load(["healthy"]);
    const r = await start(env);
    assert(r.state === "running" && env.spawns.length === 1 && has(env.spawns[0].args, "-ctk", "q8_0"),
      "a build that accepts the cache runs on the first, quantized spawn");
    assert(r.calls.length === 1 && r.calls[0] === null, "and done fires once, with no error");
    env.Llama.stop();
  }

  // ---- 2b. refusal then healthy
  for (const line of [REAL_BAD_TYPE, REAL_BAD_FLAG]) {
    const env = load([{ refuse: line }, "healthy"]);
    const r = await start(env);
    assert(r.state === "running", "refusal '" + line.slice(0, 40) + "...' still ends running");
    assert(env.spawns.length === 2 && has(env.spawns[0].args, "-ctk", "q8_0") &&
           !env.spawns[1].args.includes("-ctk"), "  after exactly one respawn on the plain argv");
    assert(r.calls.length === 1 && r.calls[0] === null, "  done fires ONCE, success (not the first exit's error)");
    assert(env.logs.some((l) => /refused the q8_0 KV cache/.test(l)), "  and the log says why");
    env.Llama.stop();
  }

  // ---- 3. refusal text lands after 'exit'
  {
    const env = load([{ refuse: REAL_BAD_TYPE, late: true }, "healthy"]);
    const r = await start(env);
    assert(r.state === "running" && env.spawns.length === 2,
      "a refusal printed after 'exit' (pipes not yet drained) is still seen");
    env.Llama.stop();
  }

  // ---- 3b. the plain respawn refuses too: stop, no loop
  {
    const env = load([{ refuse: REAL_BAD_FLAG }, { refuse: REAL_BAD_FLAG }, "healthy"]);
    const r = await start(env);
    assert(r.state === "error" && env.spawns.length === 2, "a second refusal does not respawn again");
  }

  // ---- 4. unrelated failures
  {
    const env = load([{ die: "llama_model_load: error loading model: tensor data is not within file bounds" }, "healthy"]);
    const r = await start(env);
    assert(r.state === "error" && env.spawns.length === 1, "a model load failure is NOT retried without the cache");
    assert(r.calls.length === 1 && r.calls[0] && /exited before/.test(r.calls[0].message), "  and done reports the error once");
  }
  {
    const env = load([{ die: "error: invalid argument: --some-other-flag" }, "healthy"]);
    const r = await start(env);
    assert(r.state === "error" && env.spawns.length === 1, "a refusal of some OTHER argument does not drop the cache flags");
  }

  // ---- 5. user stop during load
  {
    const env = load([{ refuse: REAL_BAD_TYPE, late: true }, "healthy"]);
    env.Llama.start(OPTS, () => {});
    await new Promise((r) => setTimeout(r, 5));
    env.Llama.stop();
    await new Promise((r) => setTimeout(r, 80));
    assert(env.spawns.length === 1 && env.Llama.getState() === "stopped", "a stop during load never respawns");
  }

  // ---- 6. panel and probe read the same real lines
  {
    const L = load([]).Llama;
    for (const line of [REAL_BAD_TYPE, REAL_BAD_FLAG]) {
      assert(L.kvRefusal("junk\n" + line + "\nusage:\n") !== "" && KV.parseServerLog(line).rejected,
        "panel and scripts/lib/kv-quant.js both recognise: " + line);
    }
    assert(L.kvRefusal("main: server is listening on http://127.0.0.1:8737\n") === "", "a healthy log is not a refusal");
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
