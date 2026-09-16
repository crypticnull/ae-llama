/*
 * test-kv-quant.js — scripts/lib/kv-quant.js, the pure half of
 * scripts/kv-quant-probe.js (WORKPLAN §13b, NEXT UP 11).
 *
 * The fixture lines are REAL llama-server output (build 10240, 7B Q4_K_M,
 * `-c 16384 -ngl 99 -ctk q8_0 -ctv q8_0 -lv 4`, captured 2026-09-16).
 * Two facts they carry that a hand-written fixture would not:
 *   - the buffer lines appear ONLY at verbosity 4; the default prints
 *     none, so buildArgs must add `-lv 4` or every KV column reads null;
 *   - a quantized V cache FORCES flash attention on, and says so.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const KV = require(path.join(__dirname, "..", "scripts", "lib", "kv-quant.js"));

let n = 0;
function check(name, fn) { fn(); n++; console.log("ok - " + name); }

const REAL_Q8 = [
  "0.00.143.557 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true",
  "0.00.332.176 I common_params_fit_impl: projected to use 4792 MiB of device memory vs. 30991 MiB of free device memory",
  "0.00.332.180 I common_params_fit_impl: will leave 26198 >= 1024 MiB of free device memory, no changes needed",
  "0.00.772.198 I load_tensors:        CUDA0 model buffer size =  4168.09 MiB",
  "0.02.011.893 I llama_init_from_model: enabling flash_attn since it is required for quantized V cache",
  "0.02.011.942 I llama_context: n_ctx         = 16384",
  "0.02.011.944 I llama_context: flash_attn    = enabled",
  "0.02.013.235 I llama_kv_cache:      CUDA0 KV buffer size =   476.00 MiB",
  "0.02.017.917 I llama_kv_cache: size =  476.00 MiB ( 16384 cells,  28 layers,  4/1 seqs), K (q8_0):  238.00 MiB, V (q8_0):  238.00 MiB",
  "0.02.023.184 I sched_reserve:      CUDA0 compute buffer size =   148.09 MiB",
  "0.02.087.061 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 16384, kv_unified = 'true'"
].join("\n");

// What the SAME run prints at the default verbosity (real, 18 lines).
const REAL_DEFAULT_VERBOSITY = [
  "0.00.172.118 I srv    load_model: loading model '../../models/Qwen2.5-7B-Instruct-Q4_K_M.gguf'",
  "0.09.390.156 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 16384, kv_unified = 'true'",
  "0.09.409.230 I srv  llama_server: model loaded"
].join("\n");

check("buildArgs: shipped is the panel's argv exactly, plus the log level", function () {
  const a = KV.buildArgs({ modelPath: "m.gguf", port: 8791, ctx: 16384, kv: "shipped" });
  assert.deepStrictEqual(a, ["-m", "m.gguf", "--host", "127.0.0.1", "--port", "8791",
    "-c", "16384", "-ngl", "99", "-lv", "4"]);
  assert.strictEqual(a.indexOf("-ctk"), -1);
});

check("buildArgs: a KV type sets K and V both", function () {
  const a = KV.buildArgs({ modelPath: "m", port: 1, ctx: 8192, kv: "q8_0" });
  assert.strictEqual(a[a.indexOf("-ctk") + 1], "q8_0");
  assert.strictEqual(a[a.indexOf("-ctv") + 1], "q8_0");
});

check("buildArgs: --serve form drops -lv, keeps the KV flags", function () {
  const a = KV.buildArgs({ modelPath: "m", port: 8737, ctx: 16384, kv: "q4_0", verbose: false });
  assert.strictEqual(a.indexOf("-lv"), -1);
  assert.strictEqual(a[a.indexOf("-ctk") + 1], "q4_0");
});

check("parseServerLog: every buffer fact off the real verbose log", function () {
  const r = KV.parseServerLog(REAL_Q8);
  assert.strictEqual(r.modelMiB, 4168.09);
  assert.strictEqual(r.kvMiB, 476);
  assert.strictEqual(r.kType, "q8_0");
  assert.strictEqual(r.vType, "q8_0");
  assert.strictEqual(r.kTypeMiB, 238);
  assert.strictEqual(r.vTypeMiB, 238);
  assert.strictEqual(r.computeMiB, 148.09);
  assert.strictEqual(r.flashAttn, "enabled");
  assert.strictEqual(r.flashForced, true);
  assert.strictEqual(r.nCtx, 16384);
  assert.strictEqual(r.nSlots, 4);
  assert.strictEqual(r.projectedMiB, 4792);
  assert.strictEqual(r.fitChanged, false);
  assert.strictEqual(r.rejected, null);
});

check("parseServerLog: the default verbosity carries no buffer lines -> nulls, not guesses", function () {
  const r = KV.parseServerLog(REAL_DEFAULT_VERBOSITY);
  assert.strictEqual(r.kvMiB, null);
  assert.strictEqual(r.modelMiB, null);
  assert.strictEqual(r.flashAttn, null);
  assert.strictEqual(r.nSlots, 4);
});

check("parseServerLog: fa auto is read as what it RESOLVED to (real shipped-argv lines)", function () {
  const r = KV.parseServerLog([
    "0.01.963.562 I llama_context: flash_attn    = auto",
    "0.01.969.907 I resolve_fused_ops: Flash Attention enabled"].join("\n"));
  assert.strictEqual(r.flashAttn, "enabled");
  assert.strictEqual(r.flashForced, false);
});

check("parseServerLog: a rejected cache type is reported", function () {
  const r = KV.parseServerLog("error: invalid argument: --cache-type-k\n");
  assert.ok(/invalid argument/.test(r.rejected));
});

check("fp16KvMiB: the 7B's fp16 yardstick is 1.88x the measured q8_0 buffer", function () {
  // Qwen2.5-7B: 28 layers, 4 KV heads, head dim 128.
  const f16 = KV.fp16KvMiB(28, 4, 128, 16384);
  assert.strictEqual(f16, 896);
  // q8_0 is 8.5 bits a value: 896 * 8.5/16 = 476, the real reading.
  assert.strictEqual(f16 * 8.5 / 16, 476);
});

console.log("\n" + n + " checks passed");
