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

  /*
   * ------------------------------------------------ the host reserve
   *
   * VRAM this panel will not spend, because After Effects and the
   * Windows desktop are already spending it. DECIDED by the owner
   * 2026-09-15 as UNCONDITIONAL — not a setting, not a tier option:
   * "we do need to reserve a small amount of VRAM for After Effects
   * always". The panel lives INSIDE After Effects, so a model that
   * starves its host has broken the product even when the model runs.
   *
   * Two numbers, because the arithmetic comes in two shapes and mixing
   * them double-counts (or under-counts) After Effects:
   *
   *   AE_RESIDENT_MB — what After Effects plus the desktop already HOLD.
   *     Measured 3,255 MB on the dev 5090 with AE open, no project and
   *     nothing else loaded (WORKPLAN-LOG 7428). Used by arithmetic that
   *     sizes against the card's TOTAL, where nothing else accounts for
   *     AE at all (planHandoff).
   *
   *   DESKTOP_FREE_MB — what must stay UNALLOCATED on top of that, for
   *     the compositor to keep drawing. Field-measured lower bound,
   *     2026-09-15: the owner's display went black, with no driver event
   *     logged, at 28,804 MB used of 32,607 — i.e. 3,803 MB free was NOT
   *     enough. 4,096 is the smallest round figure above the reading that
   *     failed. Used by arithmetic that starts from a MEASURED free
   *     figure, where AE is already inside `memory.used` (planChatLoad).
   *
   * Both are PROVISIONAL and deliberately live on one line each: §16b
   * step 4 measures AE's real working footprint on four real projects,
   * and that measurement replaces AE_RESIDENT_MB without touching a
   * single call site. Neither figure is exposed as a setting.
   */
  var AE_RESIDENT_MB = 3255;
  var DESKTOP_FREE_MB = 4096;

  /** The reserve for TOTAL-based arithmetic: AE's footprint + the floor. */
  function hostReserveMB() { return AE_RESIDENT_MB + DESKTOP_FREE_MB; }

  /** The reserve for MEASURED-FREE arithmetic: the floor alone. */
  function desktopFreeMB() { return DESKTOP_FREE_MB; }

  function gb(mb) { return Math.round(mb / 1024 * 10) / 10; }

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
   * Can this card RUN the entry (entryFits) AND is it offered as a DEFAULT
   * here? Two different questions since 2026-09-16 (WORKPLAN 18 P7c step
   * 2g, NEXT UP 5a-4c). minVramGB is the smallest card MEASURED to run the
   * shipped graph without a grind or a changed output; recommendFromGB,
   * when an entry carries it, is the smallest card it is picked FOR.
   *
   * They split because moving a measured gate also moves the defaults this
   * file hands out (a 12 GB buyer's video default would go from a 12 s
   * LTX clip to a 130 s Wan one), and the tier table is the owner's call
   * (16f). So the gates carry the measurement and reach a buyer who
   * chooses; the defaults hold where they were until he decides. Removing
   * the field is the whole of that decision's code.
   */
  function recommendFloor(entry) {
    if (typeof entry.recommendFromGB === "number") return entry.recommendFromGB;
    return entry.minVramGB;
  }
  function entryRecommendable(entry, ctx) {
    if (!entryFits(entry, ctx)) return false;
    if (typeof entry.recommendFromGB !== "number") return true;
    var vram = ctx && typeof ctx.vramGB === "number" ? ctx.vramGB : null;
    return vram !== null && vram >= entry.recommendFromGB;
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
      var af = recommendFloor(a) || 0, bf = recommendFloor(b) || 0;
      if (af !== bf) return af > bf;
      // TIES ARE DECIDED, not inherited from array order. Until 2026-09-09
      // no two entries of one kind shared a floor, so a tie fell through to
      // "whichever came first in COMFY_CATALOG" and nobody had chosen that.
      // Measuring wan22-5b (WORKPLAN 18 P7) moved its gate 8 -> 32 and made
      // a three-way video tie with minimax-h3 and minimax-h3-int8 — and the
      // 32 GB recommendation silently changed to Wan purely because it sits
      // earlier in the array. That is the defect 18 P1 fixed for
      // resolveWorkflow, where the ALPHABET was doing the picking.
      //
      // On an equal floor, prefer the larger download. It carries the same
      // intent the floor does ("the most this card can do"), it is a number
      // every entry either has or has not, and it keeps the 32 GB pick at
      // MiniMax H3 instead of moving a buyer-facing default as a side
      // effect of a VRAM measurement. An entry with no sizeMB (krea2,
      // ltx-small) scores 0 and so LOSES a tie rather than winning one by
      // accident.
      //
      // Before the size, one rule that is about FIT rather than bulk: an
      // entry gated on this card's own architecture beats one that is not.
      // That is the whole reason the catalog carries minimax-h3 AND
      // minimax-h3-int8 at the same floor — the nvfp4 encoder is the
      // Blackwell-native build and the int8 one is the fallback for cards
      // that cannot run it (entryFits, requiresBlackwell). Size alone would
      // invert that pair, because the FALLBACK is the larger file.
      var aArch = !!a.requiresBlackwell, bArch = !!b.requiresBlackwell;
      if (aArch !== bArch) return aArch;
      if ((a.sizeMB || 0) !== (b.sizeMB || 0)) return (a.sizeMB || 0) > (b.sizeMB || 0);
      // LAST, and only reachable since 2026-09-16: two entries can now share
      // a floor AND a download. wan22-5b and wan22-5b-fp8 are ONE set of
      // files that differ only in what core UNETLoader is told to cast the
      // diffusion to (WORKPLAN 18 P7c step 1), so sizeMB cannot separate
      // them by construction, and without this the pick falls back to array
      // order - the one thing this whole block exists to refuse.
      //
      // Prefer the entry MEASURED cheaper on the card. Same gate, same
      // bytes, less VRAM held while After Effects is also resident (16b),
      // so there is no axis on which the dearer one is the better offer.
      // An entry carrying no reading scores Infinity and LOSES the tie
      // rather than winning it by accident - the mirror of the sizeMB 0
      // rule above, and for the same reason: a missing number must not beat
      // a measured one.
      var aMeas = typeof a.measuredVramMB === "number" ? a.measuredVramMB : Infinity;
      var bMeas = typeof b.measuredVramMB === "number" ? b.measuredVramMB : Infinity;
      return aMeas < bMeas;
    }
    for (var i = 0; i < catalog.length; i++) {
      var e = catalog[i];
      if (!entryRecommendable(e, ctx)) continue;
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
   *         mandatory, overridden}
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
    // The host reserve is in this sum because nothing ELSE in it is
    // After Effects: `vramMB` is the card's whole sticker, and both
    // other terms are models the panel loaded. Without it the arbiter
    // was free to spend the card down to the last gigabyte while the
    // application it lives inside was still drawing — which is what it
    // did on 2026-09-15. The tier's own `headroomGB` stays as it was:
    // it is the per-job slop the tier table owns, and rewriting that
    // table is a separate, owner-gated decision (§16f).
    var reserveMB = hostReserveMB();
    var known = vramMB !== null &&
      typeof inp.chatLoadedMB === "number" && inp.chatLoadedMB > 0 &&
      typeof inp.genNeedMB === "number" && inp.genNeedMB > 0;
    var fits = known &&
      inp.chatLoadedMB + inp.genNeedMB + headMB + reserveMB <= vramMB;
    // The chat model's figure is MEASURED off the model that is really
    // loaded; the card's can be a fiction (`vramOverrideGB` impersonates
    // any card on any card). Unlabelled, the two together produce
    // sentences that read as nonsense — measured in the field
    // 2026-08-30 with a 32B model and an 8 GB override: "the chat model
    // holds ~20 GB of the card's 8 GB". Both numbers are true; only the
    // budget's provenance was missing.
    // The reserve is NAMED in every sentence it decided. A user told
    // "8.7 GB does not fit on a 24 GB card" with no mention of the 7.2
    // GB held back for After Effects reads the panel as broken at
    // arithmetic, and files that bug instead of the real one.
    function numbers() {
      return "the generation needs ~" + gb(inp.genNeedMB) +
        " GB and the chat model holds ~" + gb(inp.chatLoadedMB) +
        " GB of the card's " + inp.vramGB + " GB" +
        (inp.overridden ? " (VRAM override)" : "") + ", with ~" +
        gb(reserveMB) + " GB held back for After Effects and the desktop";
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
   * The OTHER load, and until 2026-09-15 the unguarded one: starting the
   * chat model itself. `planHandoff` only ever ran when a GENERATION was
   * asked for, so the panel could put a 23 GB model onto a card that
   * After Effects was already working on and never do a sum — which is
   * exactly the field incident (§16b): AE at 14:01, the 32B at 14:08,
   * 28,804 MB of 32,607 held, display black at 14:28.
   *
   * This half starts from a MEASURED `usedMB`, so After Effects is
   * already counted and only DESKTOP_FREE_MB is held back — adding
   * AE_RESIDENT_MB here would charge for AE twice.
   *
   * input: {cardTotalMB|null, usedMB|null, chatNeedMB|null, gpuLayers}
   * out:   {mode:'ok'|'tight'|'refuse'|'unknown', reason, freeAfterMB|null,
   *         reserveMB}
   *
   * Only 'refuse' stops a load, and only for a shortfall that is
   * PHYSICAL — the model does not fit in the free VRAM at all. A model
   * that fits but eats into the desktop's floor is 'tight': it is told,
   * loudly, and then it loads. Refusing there would decide the honest
   * chat floor for 8 GB cards by arithmetic, and that is the owner's
   * call (§16d), not this function's.
   */
  function planChatLoad(inp) {
    inp = inp || {};
    var reserve = DESKTOP_FREE_MB;
    var out = { mode: "unknown", reason: "", freeAfterMB: null,
                reserveMB: reserve };
    if (Number(inp.gpuLayers) === 0) {
      out.reason = "GPU layers is 0, so this model loads into system " +
                   "RAM — nothing is asked of the card.";
      return out;
    }
    var total = typeof inp.cardTotalMB === "number" && inp.cardTotalMB > 0
      ? inp.cardTotalMB : null;
    var used = typeof inp.usedMB === "number" && inp.usedMB >= 0
      ? inp.usedMB : null;
    var need = typeof inp.chatNeedMB === "number" && inp.chatNeedMB > 0
      ? inp.chatNeedMB : null;
    if (total === null || used === null || need === null) {
      out.reason = "The panel could not measure " +
        (total === null ? "the card" :
         used === null ? "what the card is already holding"
                       : "this model's size") +
        ", so it did not check whether this model leaves room for " +
        "After Effects.";
      return out;
    }
    var free = total - used;
    var freeAfter = free - need;
    out.freeAfterMB = freeAfter;
    var where = "~" + gb(need) + " GB and the card has ~" + gb(free) +
      " GB free of " + gb(total) + " GB";
    if (freeAfter < 0) {
      out.mode = "refuse";
      out.reason = "This model needs " + where + " — it will not fit, " +
        "so nothing was started. Close what else is using the card, " +
        "pick a smaller model, or set GPU layers to 0 to run it on the " +
        "CPU.";
      return out;
    }
    if (freeAfter < reserve) {
      out.mode = "tight";
      out.reason = "Heads up: this model needs " + where + ", which " +
        "leaves about " + gb(freeAfter) + " GB for After Effects and " +
        "the Windows desktop. Under ~" + gb(reserve) + " GB the display " +
        "can freeze with no error (measured 2026-09-15). A smaller " +
        "model leaves more.";
      return out;
    }
    out.mode = "ok";
    out.reason = "This model needs " + where + ", leaving ~" +
      gb(freeAfter) + " GB for After Effects and the desktop.";
    return out;
  }

  /**
   * The same floor, asked of the card AFTER something loaded — a
   * reading, not a prediction. The prediction above prices a model by
   * its file size plus a flat constant; the field incident landed 800 MB
   * under the floor while that estimate said it was clear, so the only
   * honest check is to look again once the memory is really allocated.
   * Returns the sentence to show, or null when there is nothing to say.
   */
  function freeFloorWarning(totalMB, usedMB) {
    if (typeof totalMB !== "number" || !(totalMB > 0) ||
        typeof usedMB !== "number" || !(usedMB >= 0)) {
      return null;                       // unmeasured: claim nothing
    }
    var free = totalMB - usedMB;
    if (free >= DESKTOP_FREE_MB) return null;
    return "The card now holds " + usedMB + " MB of " + totalMB +
      " MB — only ~" + gb(free) + " GB is free, and Windows needs some " +
      "of it to draw the screen. If the display freezes, stop the chat " +
      "model (Stop, above) — that releases it without closing After " +
      "Effects.";
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
    entryRecommendable: entryRecommendable,
    recommendFloor: recommendFloor,
    recommendChat: recommendChat,
    recommendGen: recommendGen,
    hostReserveMB: hostReserveMB,
    desktopFreeMB: desktopFreeMB,
    planHandoff: planHandoff,
    planChatLoad: planChatLoad,
    freeFloorWarning: freeFloorWarning,
    describeSetup: describeSetup
  };

})(window);
