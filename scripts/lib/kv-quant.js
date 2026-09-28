/*
 * kv-quant.js — the pure half of scripts/kv-quant-probe.js (WORKPLAN §13b,
 * NEXT UP 11): the llama-server argv for one KV configuration, and what
 * the server's own log says it allocated.
 *
 * Kept apart from the probe so tests/test-kv-quant.js can pin both against
 * REAL log lines (build 10240, captured 2026-09-16) without a GPU.
 *
 * Why the log matters as well as nvidia-smi: the card reading is the
 * truth a user pays, but it cannot say WHICH buffer grew. The server
 * prints the KV buffer, its K/V types, and whether flash attention came
 * on, and a quantized V cache silently forces flash attention on
 * ("enabling flash_attn since it is required for quantized V cache").
 */
"use strict";

/* The panel's own argv (llama.js serverArgs) plus the KV flags. `kv` of
 * null / "shipped" adds nothing: that is the f16 cache the panel shipped
 * until NEXT UP 11c (2026-09-16). Since then the panel passes q8_0 itself
 * (and f16 only after a refusal), so the panel's config is `--kv q8_0`. */
function buildArgs(o) {
  const args = [
    "-m", o.modelPath,
    "--host", "127.0.0.1",
    "--port", String(o.port),
    "-c", String(o.ctx),
    "-ngl", String(o.gpuLayers == null ? 99 : o.gpuLayers)
  ];
  if (o.kv && o.kv !== "shipped") {
    args.push("-ctk", o.kv, "-ctv", o.kv);
  }
  if (o.flashAttn) args.push("-fa", o.flashAttn);
  // Verbosity 4 is what prints the KV / model / compute buffer lines; the
  // default (3) prints none of them.
  if (o.verbose !== false) args.push("-lv", "4");
  return args;
}

function num(s) { return s == null ? null : parseFloat(s); }

/* Read the allocation facts out of a llama-server log. Every field is
 * null when its line is absent, never guessed. */
function parseServerLog(text) {
  const t = String(text || "");
  const m = function (re) { const r = re.exec(t); return r; };
  const r = {
    modelMiB: null, kvMiB: null, kTypeMiB: null, vTypeMiB: null,
    kType: null, vType: null, computeMiB: null, flashAttn: null,
    flashForced: false, nCtx: null, nSlots: null, projectedMiB: null,
    fitChanged: null, rejected: null
  };
  let x;
  if ((x = m(/CUDA0 model buffer size =\s*([\d.]+) MiB/))) r.modelMiB = num(x[1]);
  if ((x = m(/CUDA0 KV buffer size =\s*([\d.]+) MiB/))) r.kvMiB = num(x[1]);
  if ((x = m(/K \((\w+)\):\s*([\d.]+) MiB, V \((\w+)\):\s*([\d.]+) MiB/))) {
    r.kType = x[1]; r.kTypeMiB = num(x[2]);
    r.vType = x[3]; r.vTypeMiB = num(x[4]);
  }
  if ((x = m(/CUDA0 compute buffer size =\s*([\d.]+) MiB/))) r.computeMiB = num(x[1]);
  if ((x = m(/flash_attn\s*=\s*(\w+)/))) r.flashAttn = x[1];
  // "auto" is only the REQUEST; the build resolves it a few lines later.
  if ((x = m(/Flash Attention (enabled|disabled)/))) r.flashAttn = x[1];
  r.flashForced = /enabling flash_attn since it is required/.test(t);
  if ((x = m(/llama_context: n_ctx\s*=\s*(\d+)/))) r.nCtx = parseInt(x[1], 10);
  if ((x = m(/n_slots = (\d+)/))) r.nSlots = parseInt(x[1], 10);
  if ((x = m(/projected to use (\d+) MiB of device memory/))) r.projectedMiB = parseInt(x[1], 10);
  // -fit (default on) may shrink ctx or offload to make a load fit. The
  // probe must see that, or a "cheap" row is a row that quietly got less.
  if (/no changes needed/.test(t)) r.fitChanged = false;
  else if (/fit params|fitting params/.test(t) &&
           /(reducing|changing|set .* to|offload)/i.test(t)) r.fitChanged = true;
  if ((x = m(/(error: (?:invalid|unknown) argument[^\r\n]*|invalid value for[^\r\n]*|Unsupported cache type[^\r\n]*)/i))) {
    r.rejected = x[1].trim();
  }
  return r;
}

/* fp16 KV arithmetic for a GQA model, MiB: layers x kvHeads x headDim x
 * 2 (K and V) x cells x 2 bytes. The yardstick a reading is checked
 * against, not a substitute for one. */
function fp16KvMiB(layers, kvHeads, headDim, cells) {
  return layers * kvHeads * headDim * 2 * cells * 2 / 1048576;
}

module.exports = { buildArgs: buildArgs, parseServerLog: parseServerLog,
                   fp16KvMiB: fp16KvMiB };
