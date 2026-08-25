/*
 * tiers.js — the single source of truth for hardware tiers.
 *
 * Chat (llama-server) and generation (ComfyUI) share ONE pool of VRAM,
 * so the panel reads the GPU once, computes one tier, and derives BOTH
 * catalogs' recommendations and the generation-time handoff policy from
 * that same object. Two independent tables would drift, and drift here
 * means OOM on somebody's card.
 *
 * Tier boundaries sit ON NVIDIA's shipped VRAM levels (4/6/8/12/16/24/
 * 32 GB), so no real product straddles one. Detection keys off MEASURED
 * VRAM (nvidia-smi), never the card name — the same product name ships
 * with different VRAM (4060 Ti: 8 or 16 GB; laptop chips carry less
 * than their desktop namesakes). The tier decides a POLICY; the actual
 * concurrency gate is arithmetic at request time over the models the
 * user really configured (planHandoff below), not the ones we
 * recommended.
 *
 * `vramOverrideGB` in settings impersonates any card on any card — a
 * 32 GB dev machine enforcing a 6 GB budget exercises every tier's
 * behavior without the hardware. See docs/COMFY_TIERS_PLAN.md.
 */
(function (global) {
  "use strict";

  // Example cards are for copy only ("runs on a GTX 1660") — at runtime
  // only the measured number exists. `mandatory` marks tiers where the
  // exclusive handoff is not negotiable: chat + any image model cannot
  // share the card, whatever the arithmetic momentarily suggests.
  var TIERS = [
    { id: "T0", minGB: 0, policy: "exclusive", mandatory: true,
      experimental: true, headroomGB: 1,
      examples: "GTX 960-class, or no NVIDIA GPU",
      image: "SD 1.5 at 512px (experimental, slow)", video: "",
      copy: "Chat runs light (or on CPU); image generation is " +
            "experimental and slow here." },
    { id: "T1", minGB: 4, policy: "exclusive", mandatory: true,
      headroomGB: 1,
      examples: "GTX 1650, 1050 Ti, laptop RTX 3050",
      image: "SD 1.5 at 512-768px", video: "",
      copy: "4 GB card: light chat model plus SD 1.5 images up to " +
            "768px. Generation pauses chat on this card." },
    { id: "T2", minGB: 6, policy: "exclusive", mandatory: true,
      headroomGB: 1,
      examples: "GTX 1060 6GB, 1660 Super, RTX 2060, laptop 4050",
      image: "SD 1.5 at 768px (SDXL opt-in, minutes per image)",
      video: "experimental short clips",
      copy: "6 GB card: light chat model plus SD 1.5 images at 768px; " +
            "SDXL is available but takes minutes per image here. " +
            "Generation pauses chat on this card." },
    { id: "T3", minGB: 8, policy: "exclusive", headroomGB: 1,
      examples: "RTX 2070/2080, 3060 Ti, 3070, 4060, 5060",
      image: "SDXL comfortably", video: "short Wan clips",
      copy: "8 GB card: solid 7B chat plus SDXL images and short " +
            "video clips. Generation pauses chat on this card." },
    { id: "T4", minGB: 12, policy: "exclusive", headroomGB: 1,
      examples: "RTX 3060 12GB, 3080 12GB, 4070, 5070",
      image: "Flux/Krea at 1024px", video: "short Wan clips",
      copy: "12 GB card: 7B chat plus Flux/Krea images at 1024px. " +
            "Large generations pause chat." },
    { id: "T5", minGB: 16, policy: "exclusive", headroomGB: 1,
      examples: "4060 Ti 16GB, 4080, 5070 Ti, 5080, laptop 4090",
      image: "Flux/Krea dev", video: "Wan 14B (quantized)",
      copy: "16 GB card: 14B chat plus Flux/Krea images; quantized " +
            "video is possible. Large generations pause chat." },
    { id: "T6", minGB: 24, policy: "concurrent", headroomGB: 1,
      examples: "RTX 3090, 4090, Titan RTX",
      image: "Krea full", video: "Wan 14B",
      copy: "24 GB card: 14B chat and image generation can often run " +
            "side by side; the panel checks the arithmetic per job." },
    { id: "T7", minGB: 32, policy: "concurrent", headroomGB: 1,
      examples: "RTX 5090",
      image: "Krea full precision", video: "Wan 14B, MiniMax H3",
      copy: "32 GB+: large chat models plus the full generation " +
            "stack; per-job arithmetic decides what runs together." }
  ];

  /**
   * The VRAM figure every decision uses. `vramOverrideGB` (settings)
   * wins over the measured number so any card can impersonate any
   * tier for testing; 0/absent means "use what nvidia-smi said".
   * Returns {vramGB: number|null, overridden: bool, hasNvidia: bool}.
   */
  function effectiveVram(gpu, settings) {
    var o = settings && Number(settings.vramOverrideGB);
    if (o && o > 0) {
      return { vramGB: o, overridden: true, hasNvidia: true };
    }
    var has = !!(gpu && gpu.hasNvidia);
    var v = gpu && typeof gpu.vramGB === "number" && gpu.vramGB > 0
      ? gpu.vramGB : null;
    return { vramGB: has ? v : null, overridden: false, hasNvidia: has };
  }

  /**
   * GPU architecture class from the CUDA compute capability. fp8
   * compute needs Ada or newer (cc >= 8.9); nvfp4 weights need
   * Blackwell (consumer cc 12.x, datacenter 10.x). Unknown stays
   * unknown — callers treat it conservatively.
   */
  function archOf(computeCap) {
    if (typeof computeCap !== "number" || !(computeCap > 0)) {
      return "unknown";
    }
    if (computeCap >= 10) return "blackwell";
    if (computeCap >= 8.9) return "ada";
    return "pre-ada";
  }

  /** The tier a VRAM figure lands in. null VRAM → T0. */
  function tierFor(vramGB) {
    var best = TIERS[0];
    if (typeof vramGB !== "number" || !(vramGB > 0)) return best;
    for (var i = 0; i < TIERS.length; i++) {
      if (vramGB >= TIERS[i].minGB) best = TIERS[i];
    }
    return best;
  }

  /**
   * One detection → one tier, everything else derives from this.
   * Returns {tier, vramGB, overridden, arch}.
   */
  function resolveTier(gpu, settings) {
    var eff = effectiveVram(gpu, settings);
    return {
      tier: tierFor(eff.vramGB),
      vramGB: eff.vramGB,
      overridden: eff.overridden,
      arch: archOf(gpu && gpu.computeCap)
    };
  }

  /**
   * Can this catalog entry run on this machine at all? Checks the VRAM
   * floor and the architecture gates (requiresAda for fp8 weights,
   * requiresBlackwell for nvfp4). An unknown architecture fails a gate
   * — recommending a model that cannot execute is worse than
   * recommending a smaller one.
   */
  function entryFits(entry, ctx) {
    if (!entry) return false;
    var vram = ctx && typeof ctx.vramGB === "number" ? ctx.vramGB : null;
    if (typeof entry.minVramGB === "number") {
      if (vram === null || vram < entry.minVramGB) return false;
    }
    var arch = (ctx && ctx.arch) || "unknown";
    if (entry.requiresBlackwell && arch !== "blackwell") return false;
    if (entry.requiresAda && arch !== "ada" && arch !== "blackwell") {
      return false;
    }
    return true;
  }

  /**
   * Best chat model for this machine: the largest entry whose VRAM
   * floor the (effective) GPU clears; the cpuDefault entry when there
   * is no NVIDIA GPU or VRAM is unknown; the smallest entry as a last
   * resort. Same semantics Setup.recommendModel always had — now
   * override-aware and shared with the generation side.
   */
  function recommendChat(catalog, gpu, settings) {
    if (!catalog || catalog.length === 0) return null;
    var eff = effectiveVram(gpu, settings);
    var i;
    function smallest() {
      var s = catalog[0];
      for (var j = 1; j < catalog.length; j++) {
        if (catalog[j].sizeMB < s.sizeMB) s = catalog[j];
      }
      return s;
    }
    var best = null;
    if (eff.hasNvidia && eff.vramGB) {
      for (i = 0; i < catalog.length; i++) {
        if (eff.vramGB >= catalog[i].minVramGB &&
            (!best || catalog[i].sizeMB > best.sizeMB)) {
          best = catalog[i];
        }
      }
      return best || smallest();   // tiny GPU: lightest model, not CPU pick
    }
    for (i = 0; i < catalog.length; i++) {
      if (catalog[i].cpuDefault) best = catalog[i];
    }
    return best || smallest();
  }

  /**
   * Best generation models for this machine, one per kind. An entry
   * that is experimental, or that would be a mode-change slow on THIS
   * card (slowBelowGB — SDXL at 6 GB offloads into minutes-per-image),
   * is picked only when nothing solid fits the kind: available is not
   * the same thing as a good default. Returns
   * {image: entry|null, video: entry|null}.
   */
  function recommendGen(catalog, gpu, settings) {
    var out = { image: null, video: null };
    if (!catalog || !catalog.length) return out;
    var res = resolveTier(gpu, settings);
    var ctx = { vramGB: res.vramGB, arch: res.arch };
    var demotedPick = { image: false, video: false };
    function better(a, b) {   // highest VRAM floor = the most this card can do
      if (!b) return true;
      return (a.minVramGB || 0) > (b.minVramGB || 0);
    }
    for (var i = 0; i < catalog.length; i++) {
      var e = catalog[i];
      if (!entryFits(e, ctx)) continue;
      var slot = e.kind === "video" ? "video" : "image";
      var demoted = !!e.experimental ||
        (typeof e.slowBelowGB === "number" && res.vramGB !== null &&
         res.vramGB < e.slowBelowGB);
      var cur = out[slot];
      if (cur) {
        if (!demotedPick[slot] && demoted) continue;   // solid beats demoted
        if (!(demotedPick[slot] && !demoted) &&        // solid replaces demoted
            !better(e, cur)) continue;                 // same class: floor wins
      }
      out[slot] = e;
      demotedPick[slot] = demoted;
    }
    return out;
  }

  /**
   * The generation-time decision, pure arithmetic over what is REALLY
   * configured — never over what we recommended. All sizes in MB;
   * unknown numbers are null and are treated as unprovable fits.
   *
   * input: {vramGB|null, headroomGB, chatRunning, chatLoadedMB|null,
   *         genNeedMB|null, pauseMode: 'auto'|'always'|'never',
   *         mandatory}
   * out:   {mode: 'concurrent'|'handoff'|'refuse', reason}
   */
  function planHandoff(inp) {
    inp = inp || {};
    var pause = inp.pauseMode === "always" || inp.pauseMode === "never"
      ? inp.pauseMode : "auto";
    if (!inp.chatRunning) {
      return { mode: "concurrent",
               reason: "the chat model is not loaded — nothing to pause" };
    }
    if (pause === "always") {
      return { mode: "handoff",
               reason: "'Pause chat during generation' is set to always" };
    }
    var vramMB = typeof inp.vramGB === "number" && inp.vramGB > 0
      ? inp.vramGB * 1024 : null;
    var headMB = (typeof inp.headroomGB === "number"
      ? inp.headroomGB : 1) * 1024;
    var known = vramMB !== null &&
      typeof inp.chatLoadedMB === "number" && inp.chatLoadedMB > 0 &&
      typeof inp.genNeedMB === "number" && inp.genNeedMB > 0;
    var fits = known &&
      inp.chatLoadedMB + inp.genNeedMB + headMB <= vramMB;
    function numbers() {
      return "the generation needs ~" +
        Math.round(inp.genNeedMB / 1024 * 10) / 10 + " GB and the chat " +
        "model holds ~" + Math.round(inp.chatLoadedMB / 1024 * 10) / 10 +
        " GB of the card's " + inp.vramGB + " GB";
    }
    if (pause === "never") {
      if (fits && !inp.mandatory) {
        return { mode: "concurrent", reason: "fits beside chat: " +
                 numbers() };
      }
      return { mode: "refuse",
               reason: (known ? "It does not fit beside the chat model — " +
                 numbers() + "." : "The panel cannot verify this " +
                 "generation fits beside the chat model" +
                 (vramMB === null ? " (VRAM unknown)" : "") + ".") +
                 " 'Pause chat during generation' is set to never, so " +
                 "nothing was started. Set it to auto (settings) or stop " +
                 "the chat server, then ask again." };
    }
    // auto — the tier's arithmetic decides; unprovable = pause (safe).
    if (inp.mandatory) {
      return { mode: "handoff",
               reason: "this VRAM tier requires the exclusive handoff" };
    }
    if (fits) {
      return { mode: "concurrent", reason: "fits beside chat: " +
               numbers() };
    }
    return { mode: "handoff", reason: known
      ? "it does not fit beside the chat model (" + numbers() + ")"
      : "the fit cannot be verified — pausing chat is the safe default" };
  }

  /**
   * The combined first-run line: hardware, tier, and the chat + gen
   * picks in one honest sentence. parts: {gpu, settings, chat, gen}.
   */
  function describeSetup(parts) {
    parts = parts || {};
    var res = resolveTier(parts.gpu, parts.settings);
    var t = res.tier;
    var hw = parts.gpu && parts.gpu.hasNvidia
      ? ((parts.gpu.name || "NVIDIA GPU") +
         (res.vramGB ? ", " + res.vramGB + " GB" +
          (res.overridden ? " (override)" : "") : ""))
      : (res.overridden ? "VRAM override, " + res.vramGB + " GB"
                        : "no NVIDIA GPU");
    var picks = [];
    if (parts.chat) {
      picks.push((parts.chat.label || parts.chat.name) + " for chat");
    }
    if (parts.gen && parts.gen.image) {
      picks.push((parts.gen.image.label || parts.gen.image.name) +
                 " for images");
    }
    if (parts.gen && parts.gen.video) {
      picks.push((parts.gen.video.label || parts.gen.video.name) +
                 " for video");
    }
    return hw + " (" + t.id + "): " +
      (picks.length ? picks.join(" + ") + ". " : "") + t.copy;
  }

  global.Tiers = {
    TIERS: TIERS,
    effectiveVram: effectiveVram,
    archOf: archOf,
    tierFor: tierFor,
    resolveTier: resolveTier,
    entryFits: entryFits,
    recommendChat: recommendChat,
    recommendGen: recommendGen,
    planHandoff: planHandoff,
    describeSetup: describeSetup
  };

})(window);
