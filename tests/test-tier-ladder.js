// Regression test: the tier impersonation LADDER (WORKPLAN item 7).
//
// `vramOverrideGB` exists so one card can be every card, and the panel's
// answer at each budget is made of three separate pieces that have to agree:
// tiers.js decides the tier, setup.js picks the catalog entries, and
// planHandoff decides who owns the GPU. Each was stub-tested on its own; the
// ladder is what checks them TOGETHER, at every budget a user can type.
//
// scripts/tier-ladder-probe.js runs exactly these invariants against real
// nvidia-smi, a real llama-server and the weights on the real disk. This file
// runs them over the SHIPPED catalogs with the hardware stubbed, so a rung
// that stops making sense fails CI on a machine with no GPU at all.
"use strict";
const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

let SETTINGS = {};
const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => __dirname },
  Settings: { dataRoot: () => __dirname, get: () => SETTINGS },
  Llama: {},
  setInterval, clearInterval, setTimeout, clearTimeout
};
for (const f of ["version.js", "tiers.js", "setup.js"]) {
  eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js", f),
                       "utf8"));
}
const Tiers = window.Tiers;
const Setup = window.Setup;
const CHAT = window.AELL.MODEL_CATALOG;
const GEN = window.AELL.COMFY_CATALOG;

// The dev machine's card, so the ladder impersonates FROM something real.
const GPU = { hasNvidia: true, name: "NVIDIA GeForce RTX 5090", vramGB: 32,
              computeCap: 12.0 };
const BUDGETS = [4, 6, 8, 12, 16, 24, 32];

/** One rung: what the panel says at this budget. */
function rung(gb, pause, chatMB, needMB) {
  SETTINGS = { vramOverrideGB: gb, comfyPauseLlm: pause };
  const res = Tiers.resolveTier(GPU, SETTINGS);
  const rec = Setup.recommendSetup(null, GPU);
  return {
    gb: gb, tier: res.tier, arch: res.arch, rec: rec,
    plan: Tiers.planHandoff({
      vramGB: res.vramGB, headroomGB: res.tier.headroomGB,
      chatRunning: chatMB !== null, chatLoadedMB: chatMB,
      genNeedMB: needMB, pauseMode: pause,
      mandatory: res.tier.mandatory, overridden: res.overridden
    })
  };
}

// ---- 1. the tier line -------------------------------------------------
{
  const want = { 4: "T1", 6: "T2", 8: "T3", 12: "T4", 16: "T5", 24: "T6",
                 32: "T7" };
  for (const gb of BUDGETS) {
    const r = rung(gb, "auto", 6002, 18110);
    assert(r.tier.id === want[gb],
           gb + " GB impersonates " + want[gb] + " (got " + r.tier.id + ")");
    assert(r.rec.tier.id === r.tier.id && r.rec.vramGB === gb &&
           r.rec.overridden === true,
           gb + " GB: settings and tiers agree on the same card");
    assert(r.rec.copy.indexOf(gb + " GB (override)") !== -1 &&
           r.rec.copy.indexOf(r.tier.copy) !== -1,
           gb + " GB: the first-run line says the number is an override " +
           "and carries the tier's own copy");
    // The override is a VRAM fiction and nothing else. An fp8/nvfp4 gate
    // answered by a fiction would recommend weights the card cannot run.
    assert(r.arch === "blackwell",
           gb + " GB: the architecture is still the real silicon");
  }
}

// ---- 2. the catalog picks --------------------------------------------
{
  let prevChat = null, prevGen = { image: null, video: null };
  for (const gb of BUDGETS) {
    const r = rung(gb, "auto", 6002, 18110);
    const chat = r.rec.chat;
    assert(chat && chat.minVramGB <= gb,
           gb + " GB: chat pick " + (chat && chat.name) + " fits the budget");
    const bigger = CHAT.filter(c => c.minVramGB <= gb &&
                                    c.sizeMB > chat.sizeMB);
    assert(bigger.length === 0,
           gb + " GB: chat pick is the LARGEST that fits (bigger and " +
           "fitting: " + bigger.map(c => c.name).join(", ") + ")");
    assert(!prevChat || chat.sizeMB >= prevChat.sizeMB,
           gb + " GB: the chat pick never shrinks as the budget grows");
    prevChat = chat;

    for (const kind of ["image", "video"]) {
      const pick = r.rec.gen[kind];
      if (!pick) continue;
      assert(Tiers.entryFits(pick, { vramGB: gb, arch: r.arch }),
             gb + " GB: " + kind + " pick " + pick.name + " fits");
      // A demoted pick (experimental, or a mode-change slow at this size)
      // may only win when nothing solid fits its kind.
      const demoted = !!pick.experimental ||
        (typeof pick.slowBelowGB === "number" && gb < pick.slowBelowGB);
      if (demoted) {
        const solid = GEN.filter(e =>
          (e.kind === "video" ? "video" : "image") === kind &&
          Tiers.entryFits(e, { vramGB: gb, arch: r.arch }) &&
          !e.experimental &&
          !(typeof e.slowBelowGB === "number" && gb < e.slowBelowGB));
        assert(solid.length === 0,
               gb + " GB: the demoted " + kind + " pick " + pick.name +
               " only wins because nothing solid fits (solid: " +
               solid.map(e => e.name).join(", ") + ")");
      }
      const prev = prevGen[kind];
      assert(!prev || (pick.minVramGB || 0) >= (prev.minVramGB || 0),
             gb + " GB: the " + kind + " pick never shrinks as the budget " +
             "grows (" + (prev && prev.name) + " -> " + pick.name + ")");
      prevGen[kind] = pick;
    }
  }
  // The gate itself, on the same card: an entry that needs Blackwell is
  // still refused to a pre-Ada machine holding a 32 GB budget.
  const preAda = { hasNvidia: true, vramGB: 32, computeCap: 7.5 };
  SETTINGS = { vramOverrideGB: 32 };
  const picks = Tiers.recommendGen(GEN, preAda, SETTINGS);
  assert(picks.video && !picks.video.requiresBlackwell,
         "a 32 GB pre-Ada card is not offered the nvfp4 video weights " +
         "(got " + (picks.video && picks.video.name) + ")");
}

// ---- 3. the handoff ---------------------------------------------------
//
// Real numbers from the dev machine, 2026-08-30: the 7B chat model holds
// 6002 MB and the shipped KREA2 template's weights are 18110 MB, so the
// pair crosses over between the 24 and 32 GB rungs (25136 vs 24576 MB —
// 560 MB short). The ladder must land on the right side of that.
{
  const CHAT_MB = 6002, KREA_MB = 18110;
  for (const gb of BUDGETS) {
    const auto = rung(gb, "auto", CHAT_MB, KREA_MB);
    const always = rung(gb, "always", CHAT_MB, KREA_MB);
    const never = rung(gb, "never", CHAT_MB, KREA_MB);
    const fits = CHAT_MB + KREA_MB + auto.tier.headroomGB * 1024 <= gb * 1024;
    const want = fits && !auto.tier.mandatory ? "concurrent" : "handoff";
    assert(auto.plan.mode === want,
           gb + " GB / auto: " + want + " (" + CHAT_MB + " + " + KREA_MB +
           " + headroom vs " + gb * 1024 + " MB) — got " + auto.plan.mode);
    assert(always.plan.mode === "handoff",
           gb + " GB / always: pauses whatever the arithmetic says");
    assert(never.plan.mode === (want === "concurrent" ? "concurrent"
                                                      : "refuse"),
           gb + " GB / never: mirrors auto or refuses (got " +
           never.plan.mode + ")");
    if (auto.tier.mandatory) {
      assert(auto.plan.mode === "handoff" && never.plan.mode === "refuse",
             gb + " GB: a mandatory tier never shares the card");
    }
    // The sentence a user reads. Both numbers in it are true and only one
    // of them is measured; an impersonated budget has to say so.
    for (const d of [auto.plan, never.plan]) {
      if (d.reason.indexOf("the card's " + gb + " GB") === -1) continue;
      assert(d.reason.indexOf("(VRAM override)") !== -1,
             gb + " GB: an impersonated budget is labelled in the " +
             "sentence — " + d.reason);
    }
  }
  assert(rung(24, "auto", CHAT_MB, KREA_MB).plan.mode === "handoff" &&
         rung(32, "auto", CHAT_MB, KREA_MB).plan.mode === "concurrent",
         "the crossover is BETWEEN 24 and 32 GB, where the arithmetic " +
         "puts it (560 MB short at 24)");

  // A bill the panel cannot prove is never run beside the chat model —
  // the state every shipped template was in until 0.10.9, and the state a
  // template is in again the moment one of its weights moves somewhere
  // the panel cannot see.
  for (const gb of BUDGETS.concat([64])) {
    assert(rung(gb, "auto", CHAT_MB, null).plan.mode === "handoff",
           gb + " GB: an unprovable bill pauses chat rather than guessing");
    assert(rung(gb, "never", CHAT_MB, null).plan.mode === "refuse",
           gb + " GB: …and refuses outright when pausing is set to never");
  }
}

console.log(failed === 0 ? "\ntier ladder OK" : "\n" + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
