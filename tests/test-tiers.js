// Regression test: tiers.js — the single hardware-tier source both
// catalogs and the VRAM arbiter derive from (docs/COMFY_TIERS_PLAN.md).
"use strict";
const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

const window = {};
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "tiers.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                               "version.js"), "utf8"));
const T = window.Tiers;

// ---- the table itself -------------------------------------------------
// Boundaries sit ON NVIDIA's shipped VRAM levels so no real card
// straddles one; the ladder is strictly ascending from 0.
{
  const mins = T.TIERS.map(t => t.minGB);
  assert(JSON.stringify(mins) === JSON.stringify([0, 4, 6, 8, 12, 16, 24, 32]),
         "tier floors are NVIDIA's product VRAM levels (got " +
         mins.join(",") + ")");
  for (const t of T.TIERS) {
    assert(typeof t.copy === "string" && t.copy.length > 20 &&
           typeof t.headroomGB === "number" &&
           (t.policy === "exclusive" || t.policy === "concurrent"),
           t.id + " carries copy, headroom, and a policy");
  }
  for (const t of T.TIERS.slice(0, 3)) {
    assert(t.mandatory === true,
           t.id + " marks the exclusive handoff mandatory");
  }
}

// ---- tier resolution --------------------------------------------------
{
  const at = gb => T.tierFor(gb).id;
  assert(at(null) === "T0" && at(2) === "T0", "no/tiny VRAM -> T0");
  assert(at(4) === "T1" && at(5) === "T1", "4-5 GB -> T1");
  assert(at(6) === "T2" && at(7) === "T2", "6-7 GB -> T2");
  assert(at(8) === "T3" && at(11) === "T3", "8-11 GB -> T3");
  assert(at(12) === "T4" && at(15) === "T4", "12-15 GB -> T4");
  assert(at(16) === "T5" && at(23) === "T5", "16-23 GB -> T5");
  assert(at(24) === "T6" && at(31) === "T6", "24-31 GB -> T6");
  assert(at(32) === "T7" && at(96) === "T7", "32 GB+ -> T7");
}

// ---- the override impersonates any card (principle 4) -----------------
{
  const gpu = { hasNvidia: true, vramGB: 32, computeCap: 12.0 };
  const r = T.resolveTier(gpu, { vramOverrideGB: 6 });
  assert(r.tier.id === "T2" && r.vramGB === 6 && r.overridden === true,
         "a 32 GB card with vramOverrideGB 6 IS a T2 machine");
  const r2 = T.resolveTier(gpu, { vramOverrideGB: 0 });
  assert(r2.tier.id === "T7" && r2.overridden === false,
         "override 0 means off — the measured number rules");
  const r3 = T.resolveTier({ hasNvidia: false }, { vramOverrideGB: 8 });
  assert(r3.tier.id === "T3",
         "the override even conjures a budget on a no-GPU machine");
}

// ---- architecture gates ----------------------------------------------
{
  assert(T.archOf(6.1) === "pre-ada" && T.archOf(8.6) === "pre-ada",
         "Pascal/Ampere are pre-Ada (no fp8 compute)");
  assert(T.archOf(8.9) === "ada", "compute 8.9 is Ada");
  assert(T.archOf(12.0) === "blackwell" && T.archOf(10.0) === "blackwell",
         "consumer 12.x and datacenter 10.x are Blackwell");
  assert(T.archOf(null) === "unknown" && T.archOf(undefined) === "unknown",
         "no compute cap reported -> unknown");

  const bl = { vramGB: 32, arch: "blackwell" };
  const ada = { vramGB: 32, arch: "ada" };
  const unk = { vramGB: 32, arch: "unknown" };
  assert(T.entryFits({ minVramGB: 32, requiresBlackwell: true }, bl),
         "an nvfp4 entry fits a Blackwell card");
  assert(!T.entryFits({ minVramGB: 32, requiresBlackwell: true }, ada),
         "…and is refused on Ada — nvfp4 weights cannot execute there");
  assert(!T.entryFits({ minVramGB: 32, requiresBlackwell: true }, unk),
         "…and on an UNKNOWN architecture: recommending a model that " +
         "cannot run is worse than a smaller one");
  assert(T.entryFits({ minVramGB: 8, requiresAda: true }, bl) &&
         !T.entryFits({ minVramGB: 8, requiresAda: true },
                      { vramGB: 8, arch: "pre-ada" }),
         "requiresAda admits Ada+Blackwell, refuses pre-Ada");
  assert(!T.entryFits({ minVramGB: 8 }, { vramGB: null, arch: "unknown" }),
         "unknown VRAM fits nothing with a floor");
}

// ---- generation recommendation (against the real built-in catalog) ----
{
  const cat = window.AELL.COMFY_CATALOG;
  const rec = (vram, cc) => T.recommendGen(cat,
    { hasNvidia: true, vramGB: vram, computeCap: cc }, {});

  // These two rows moved on 2026-09-09 and the REASON moved with them.
  // SDXL's minVramGB was 6, written from training. Measured through the
  // shipped AE_LLAMA_SDXL_T2I_V1 on the managed backend it costs 9472 MiB
  // cold, and its checkpoint alone is 6617 MiB — more than a 6 GB card
  // has in total. So SDXL does not "merely FIT at minutes per image" on
  // 6 GB, which is what this row used to say and what slowBelowGB used to
  // encode; it does not fit at all, and the gate is 12 now. An 8 GB card
  // therefore gets sd15 too (measured 2656 MiB), which is the largest
  // image entry that actually fits it. See WORKPLAN 18 P6.
  const t2 = rec(6, 7.5);
  assert(t2.image && t2.image.name === "sd15",
         "6 GB default image is SD 1.5 — SDXL's measured 9472 MiB does " +
         "not fit a 6 GB card (got " + (t2.image && t2.image.name) + ")");
  assert(t2.video && t2.video.name === "ltx-small" &&
         t2.video.experimental === true,
         "6 GB video is the experimental LTX entry, flagged as such");

  const t3 = rec(8, 8.9);
  assert(t3.image && t3.image.name === "sd15",
         "8 GB image default is SD 1.5 — SDXL's gate is 12 GB since it " +
         "was measured (got " + (t3.image && t3.image.name) + ")");
  // This row said "8 GB video is Wan 2.2 5B, not the experimental LTX"
  // until 2026-09-09, and it moved because the card disagreed. wan22-5b's
  // minVramGB was 8, written from training. Measured through the shipped
  // AE_LLAMA_WAN22_5B_T2V_V1 on the managed backend, the authored job costs
  // 26 187 MiB — and a third run at 704x480, a third of the pixels, still
  // cost 21 536 MiB, because the floor is the 17 304 MiB of resident
  // weights and not the frame. No width, height or length the panel can
  // inject fits this entry on an 8 GB card, so the gate is 32 (18 P7).
  //
  // What the row asserts now is deliberately uncomfortable: an 8 GB buyer's
  // video default is the EXPERIMENTAL entry, and ltx-small has no bundled
  // graph at all (permanent ALLOW_NO_TEMPLATE seat, owner Q1). So every
  // card under 32 GB currently has no runnable video template. That is the
  // consequence WORKPLAN 18 P6a said to flag rather than decide, and it is
  // filed as 18 P7a. Pinned so the gap cannot close or widen unnoticed.
  assert(t3.video && t3.video.name === "ltx-small" &&
         t3.video.experimental === true,
         "8 GB video falls to the experimental LTX entry — Wan 2.2 5B's " +
         "measured 26 187 MiB does not fit 8 GB at any size (got " +
         (t3.video && t3.video.name) + ")");

  const t7bl = rec(32, 12.0);
  assert(t7bl.image && t7bl.image.name === "krea2",
         "32 GB image is Krea 2");
  assert(t7bl.video && t7bl.video.name === "minimax-h3",
         "32 GB Blackwell video is MiniMax H3 with the nvfp4 encoder");

  const t7ada = rec(32, 8.9);
  assert(t7ada.video && t7ada.video.name === "minimax-h3-int8",
         "32 GB NON-Blackwell falls back to the int8 encoder variant " +
         "(got " + (t7ada.video && t7ada.video.name) + ")");

  const t1 = rec(4, 7.5);
  assert(t1.image && t1.image.name === "sd15" && t1.video === null,
         "4 GB: SD 1.5 and no video at all");
}

// ---- chat recommendation parity + override ---------------------------
{
  const cat = window.AELL.MODEL_CATALOG;
  const rec = (gpu, s) => {
    const m = T.recommendChat(cat, gpu, s || {});
    return m ? m.name : null;
  };
  assert(rec({ hasNvidia: true, vramGB: 32 }).indexOf("32B") > 0 &&
         rec({ hasNvidia: true, vramGB: 8 }).indexOf("7B") > 0 &&
         rec({ hasNvidia: true, vramGB: 6 }).indexOf("3B") > 0 &&
         rec({ hasNvidia: false, vramGB: null }).indexOf("7B") > 0,
         "recommendChat keeps Setup.recommendModel's exact semantics");
  assert(rec({ hasNvidia: true, vramGB: 32 },
             { vramOverrideGB: 6 }).indexOf("3B") > 0,
         "…and the override reaches the CHAT pick too — one budget, " +
         "both catalogs");
}

// ---- the arbiter arithmetic (planHandoff) ----------------------------
{
  const P = T.planHandoff;
  const base = { vramGB: 24, headroomGB: 1, chatRunning: true,
                 chatLoadedMB: 10500, genNeedMB: 8000,
                 pauseMode: "auto", mandatory: false };
  const c = (patch) => P(Object.assign({}, base, patch));

  // THE RESERVE IS IN THIS SUM (§16b, owner-decided 2026-09-15). Until
  // then the budget was the card's whole sticker, so the arbiter could
  // spend it to the last gigabyte while After Effects — the application
  // this panel lives inside — was still drawing. It did exactly that on
  // 2026-09-15: 28,804 MB of 32,607 held, display black, no driver event
  // logged. These two rows are the same arithmetic they always were,
  // plus `Tiers.hostReserveMB()`; the first one's ANSWER changed, which
  // is the point of the change and not a loosened assertion.
  assert(T.hostReserveMB() === 3255 + 4096,
         "the reserve is AE's measured footprint plus the desktop's floor");
  assert(c({}).mode === "handoff",
         "24 GB, 10.5 chat + 8 gen + 1 headroom + 7.2 reserve does NOT " +
         "fit -> handoff (it read 'concurrent' before the reserve)");
  assert(/held back for After Effects/.test(c({}).reason),
         "…and the sentence names the reserve that decided it");
  assert(c({ vramGB: 32, chatLoadedMB: 6002, genNeedMB: 8000 })
           .mode === "concurrent",
         "32 GB, 6 chat + 8 gen still clears the reserve -> concurrent");
  // The dev 5090's measured Krea round (LOG:7422-7436) still clears —
  // by 281 MB here, ~120 MB against the card's real 32,607. Pinned as
  // the KNOWN EDGE rather than tuned away: that round's peak was 29,064
  // MB, ~1.7 GB above the weight sum this arithmetic prices it at, so
  // the reserve survives it only because the estimate is low. Filed as
  // §16g — the bill is weights on disk, not peak allocation.
  assert(c({ vramGB: 32, chatLoadedMB: 6002, genNeedMB: 18110 })
           .mode === "concurrent",
         "…a 32 GB card's 18.1 GB Krea round still clears the reserve, " +
         "by 281 MB — the known edge, not a comfortable pass");
  assert(c({ genNeedMB: 14000 }).mode === "handoff",
         "…14 GB of gen does not fit beside it -> handoff");
  assert(c({ chatRunning: false, chatLoadedMB: null }).mode === "concurrent",
         "chat not loaded -> nothing to pause");
  // "even when it would fit" has to be asked of a case that REALLY
  // fits, or the reserve answers these two and the flag is never tested.
  const fits = { vramGB: 32, chatLoadedMB: 6002, genNeedMB: 8000 };
  assert(c(Object.assign({ pauseMode: "always" }, fits)).mode === "handoff",
         "pauseMode always -> handoff even when it would fit");
  assert(c(Object.assign({ mandatory: true }, fits)).mode === "handoff",
         "a mandatory-exclusive tier hands off even when arithmetic fits");

  // Principle 2: the user who overrode chat UPWARD flips themselves to
  // exclusive; the arbiter notices from the real numbers.
  assert(c({ vramGB: 32, chatLoadedMB: 21500, genNeedMB: 13000 })
           .mode === "handoff",
         "a 32 GB card running a 20 GB chat model still hands off a " +
         "13 GB generation");

  // Unknowns are unprovable, and unprovable pauses (never OOMs).
  assert(c({ vramGB: null }).mode === "handoff" &&
         c({ chatLoadedMB: null }).mode === "handoff" &&
         c({ genNeedMB: null }).mode === "handoff",
         "unknown VRAM / chat size / gen size -> handoff, the safe default");

  // pauseMode never: fit -> concurrent; no fit -> REFUSE with numbers,
  // before any churn.
  assert(c(Object.assign({ pauseMode: "never" }, fits)).mode === "concurrent",
         "never + fits -> concurrent");
  const ref = c({ pauseMode: "never", genNeedMB: 14000 });
  assert(ref.mode === "refuse" && /13\.7 GB/.test(ref.reason) &&
         /10\.3 GB/.test(ref.reason) && /24 GB/.test(ref.reason),
         "never + no fit -> refusal quoting the real numbers (got: " +
         ref.reason + ")");
  const ref2 = c({ pauseMode: "never", vramGB: null });
  assert(ref2.mode === "refuse" && /cannot verify/.test(ref2.reason),
         "never + unknown VRAM -> refusal says the fit is unprovable");
  assert(c({ pauseMode: "never", mandatory: true }).mode === "refuse",
         "never on a mandatory-exclusive tier refuses even a paper fit");
}

// ---- the combined first-run line -------------------------------------
{
  const line = T.describeSetup({
    gpu: { hasNvidia: true, name: "RTX 4060", vramGB: 8, computeCap: 8.9 },
    settings: {},
    chat: { label: "Qwen2.5 7B — solid default" },
    gen: { image: { label: "SDXL" }, video: { label: "Wan 2.2 5B" } }
  });
  assert(/RTX 4060/.test(line) && /8 GB/.test(line) && /T3/.test(line),
         "the line names the card, the VRAM and the tier");
  assert(/Qwen2.5 7B/.test(line) && /SDXL/.test(line) &&
         /Wan 2.2 5B/.test(line),
         "…and the chat + image + video picks");
  assert(/pauses chat/i.test(line),
         "…and says honestly that generation pauses chat on this card");

  const t7 = T.describeSetup({
    gpu: { hasNvidia: true, name: "RTX 5090", vramGB: 32, computeCap: 12 },
    settings: {}, chat: null, gen: {}
  });
  assert(/T7/.test(t7) && !/pauses chat/i.test(t7),
         "a concurrent tier's line does not claim generation pauses chat");
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
