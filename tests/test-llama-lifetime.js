// test-llama-lifetime.js — llama-server's lifetime is a DECISION, pinned.
//
// WORKPLAN 17i (NEXT UP 26), decided 2026-09-16. The filing said
// llama.js's orphan reap "can never fire": the server is spawned without
// `detached`, so the Windows job object kills it when its parent process
// exits (measured 2026-09-09 for the same spawn in comfy.js). That half
// is true, and it is why the server stays NON-detached: closing AE must
// free a model's RAM/VRAM even when CEP never fires `unload`.
//
// The "never fires" half is not. The job object lives as long as the
// PROCESS, not the page. A reload in the same CEP process (DevTools,
// Ctrl+R) loses the old page's `proc` handle while the server keeps the
// port, and that is exactly the case reapOrphan() covers. So both halves
// stay, and this file pins both so neither is "tidied" away:
//
//   1. spawnServer() passes no `detached` (a flip would leave a 32B model
//      holding RAM after AE closes, for no caller that wants it);
//   2. init still calls Llama.reapOrphan();
//   3. reapOrphan() EXECUTED: kills a recorded pid only when tasklist says
//      it is llama-server (pids get recycled), forgets the record either
//      way, and does nothing without one.

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ok  " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}

const ROOT = path.join(__dirname, "..");
const llamaSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "llama.js"), "utf8");
const mainSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "main.js"), "utf8");

// ---- 1. the spawn stays attached to the host process
const spawnAt = llamaSrc.indexOf("child_process.spawn(serverPath");
assert(spawnAt > 0, "spawnServer spawns llama-server through child_process.spawn");
const spawnCall = llamaSrc.slice(spawnAt, llamaSrc.indexOf("});", spawnAt));
assert(!/detached/.test(spawnCall),
  "llama-server is spawned WITHOUT `detached`, so AE exiting takes it down");
assert(/LIFETIME, decided/.test(llamaSrc),
  "llama.js states the lifetime decision where the reap lives");

// ---- 2. init still reaps
assert(/Llama\.reapOrphan\(\)/.test(mainSrc),
  "main.js init still calls Llama.reapOrphan() for a same-process reload survivor");

// ---- 3. reapOrphan, executed against stubs
function load(opts) {
  const store = {};
  if (opts.record) store["com.cptk.aellama.serverPid"] = JSON.stringify(opts.record);
  const calls = [];
  const logs = [];
  const child_process = {
    execFile(cmd, args, cb) {
      calls.push({ cmd, args });
      if (cmd === "tasklist") cb(null, opts.tasklist || "");
      else cb(null, "");
    },
    spawn() { throw new Error("spawn must not run in this test"); }
  };
  const win = {
    AEBridge: {
      nodeRequire(name) {
        if (name === "child_process") return child_process;
        if (name === "buffer") return { Buffer };
        return require(name);
      }
    },
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; }
    },
    setTimeout, clearInterval
  };
  vm.runInNewContext(llamaSrc, { window: win, JSON });
  win.Llama.on("log", (l) => logs.push(l));
  return { Llama: win.Llama, store, calls, logs };
}

function reap(env) {
  let result;
  env.Llama.reapOrphan((r) => { result = r; });
  return result;
}

{
  const env = load({});
  const r = reap(env);
  assert(r === false && env.calls.length === 0,
    "no recorded pid: reports false and runs no process at all");
}
{
  const env = load({
    record: { pid: 4242, serverPath: "C:/x/llama-server.exe" },
    tasklist: '"llama-server.exe","4242","Console","1","9,999,999 K"\r\n'
  });
  const r = reap(env);
  const kill = env.calls.find((c) => c.cmd === "taskkill");
  assert(r === true, "live llama-server at the recorded pid: reports a reap");
  assert(kill && kill.args.join(" ") === "/PID 4242 /T /F",
    "it is killed by pid, tree, forced");
  assert(!("com.cptk.aellama.serverPid" in env.store),
    "the record is forgotten after the kill");
  assert(env.logs.some((l) => /earlier load of this panel/.test(l)),
    "the log names the real case (an earlier page load), not a previous AE session");
}
{
  const env = load({
    record: { pid: 4242, serverPath: "C:/x/llama-server.exe" },
    tasklist: '"chrome.exe","4242","Console","1","100 K"\r\n'
  });
  const r = reap(env);
  assert(r === false && !env.calls.some((c) => c.cmd === "taskkill"),
    "a RECYCLED pid (not llama-server) is never killed");
  assert(!("com.cptk.aellama.serverPid" in env.store),
    "and its stale record is forgotten");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
