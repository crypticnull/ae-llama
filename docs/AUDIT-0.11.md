# Function audit + roadmap — v0.11.0 (2026-08-30)

Produced by a 15-agent audit (five subsystem readers, a three-lens
feature panel, three self-verification harness designers, three
adversarial refuters), synthesized by the remote session. Every claim
below carries file:line evidence from the audit pass; trust the code
over this summary if they ever disagree.

Companion documents:
- `docs/SELF-VERIFY-PLANS.md` — the three harness plans (MOGRT,
  captions, inpainting) with the refuter-hardened check specs.
- `docs/WORKPLAN.md` sections 8–10 — the executable queue derived from
  this audit.

## Part 1 — where the plugin actually is

### 1. AE-side tool surface (71 host tools + 6 panel tools = 77)

**Strong.** 58 tools undo-grouped via AELL_MUTATING, 4 deliberately
outside undo groups (measured modal-wedge avoidance), batch rollback
with verified fingerprints, 13 keepSelection sites, resolvers that
list what exists (comps, layers with (SELECTED), masks, fonts, render
templates, presets with disambiguation). Receipts are often
disk-verified (render bytes polled, PNG IHDR parsed back).

**The grounded-error principle has one lagging group and a few
stragglers** — all cheap fixes, queued as roadmap item 1:

- apply_effect:3885 "Effect not available: X" — no alternatives, no
  pointer to list_effects. set_effect_param:3906/:3908 same class.
- rename_item:742, delete_item:1118, move_to_folder:729 — bare
  "item not found", no project-item listing (folder side IS grounded).
- set_track_matte:8970/:8998 pass AE's raw message through.
- set_keyframes:8772 and apply_keyframe_ease:4698 return plain
  AELL_err after PARTIAL mutation — rollback never arms; half-applied
  keys silently persist (for_each_layer:8947 does this correctly).
- add_keyframe requires an explicit layer and does not validate value.
- Convenience inconsistency: 8 older tools refuse an omitted layer
  even with one layer selected, while newer ones accept selection.

**Missing verbs (roadmap item 4):** no remove_effect, no delete_mask,
no relative reorder ("put it behind the logo" has no tool — the
nearest routing is the SORTER, whose own doc warns it moves other
layers). No per-layer/region rasterize (whole-comp snapshot_frame
only) — the inpainting plan builds export_mask for this.

### 2. The language interface (how a 32B local model finds the tools)

57 prompt rules + 77 tool docs, ~20 quoted-phrase mappings that
demonstrably work. **The audit's core finding: description budget is
allocated by implementation subtlety, not phrasing risk.** The ten
tools most likely missed by casual phrasing (with their current doc
text audited): set_track_matte, precompose ("group these"),
set_layer_parent ("stick it to"), apply_keyframe_ease ("smoother"),
center_anchor_point ("spin around its middle"), set_layer_timing
("trim it / push it back" — the SHORTEST doc in the file), add_mask
("hide the bottom half"), apply_preset (the designed "make it pop"
tool, findable only via the word "preset"), apply_expression_preset
("keep it drifting"), remove_keyframes ("stop it moving"). No
aesthetic-vocabulary bridge exists anywhere.

**Hard risks found:**
- Silent command loss: executeCommands slices at 20 with no result row
  (tools.js:2776) and RESPONSE_SCHEMA has no maxItems — a model that
  emits 25 commands loses 5 silently and believes the round complete.
- Two byte-slice fallbacks survive in fitResult (tools.js:2582, 2637)
  despite the measured ban.
- "clean this up" about a messy COMP routes to project-deletion
  dry-run (safe but a non-sequitur).

### 3. Coverage (what the test stack actually proves)

533 selftest steps (79 batch, 75 expectError, 20 scratch rigs), 63
stub suites (32,776 lines; 61 pass on Linux, 2 Windows-only). 70 of
71 host tools have direct selftest steps.

**Gaps:** set_effect_param is the one host tool with no direct step
(reached only inside for_each_layer, where per-layer failures
aggregate — a grounded-error regression there would pass all 533
steps). The 6 panel tools are structurally outside the selftest;
comfy_generate/transcribe_to_captions end-to-end runs exist only via
chat-probe (real model + real AE, ~10 min). main.js has only
source-regex assertions; llama.js has no dedicated suite;
visualizer.js has ZERO coverage anywhere.

### 4. Natural-language variance (the gap this audit measured)

chat-probe: 14 steps, exactly ONE phrasing each, shared history that
never resets (a later variant can ride an earlier success), step
order load-bearing (test-chat-probe pins indexes), loose checks in
steps 4/5/6 that would score wrong-but-present as pass, and a
name-scoped cleanup whitelist that makes project-mutating scenarios
UNSAFE to wire against the owner's live project. 16 of the 25
probe-marked USEFULNESS-TESTS rows are unwired; 6 steps have no doc
row. Full matrix ≈ 75–125 model conversations, multi-hour sequential
on the one real machine.

**Consequence (folded into WORKPLAN 8 + roadmap item 11): build the
reset machinery and tightened checks FIRST, wire the new trigger
mappings with 2–3 paraphrases on the already-safe scenario rows, and
defer the project-mutating rows until a sandbox design exists. A
variance number computed on today's harness would lie.**

### 5. Generation stack (inpainting readiness)

Image input is wired for exactly one template (H3 I2V firstFrame).
KREA2's authored img2img branch ships BYPASSED and stripped — and
comfy_generate {image} on KREA2 uploads the file then silently ignores
it (no "image landed" fail-fast; the prompt has one at
comfy.js:1504-1515). uploadImage collides by basename with
overwrite=true. injectParams' generic width/height walk stamps ANY
node with those inputs — a hazard for future image-path graphs. 5 of
7 catalog entries have no workflowTemplate. Whisper runs text-mode
only (no -oj JSON: no word timestamps, no confidence — the
English-only SILENCE_WORDS sentinel is the only hallucination guard).
Manifest drift: extension/workflows H3 I2V manifest lacks the
detachable flag the shipped sidecar depends on — regenerating would
reintroduce a validation failure for every user.

**For inpainting, five pieces are needed; four are ~30-line
extensions of proven machinery** (mask upload = second uploadImage
call; mask injection = clone the firstFrame handler; mask param =
plumb through tools.js; import = existing reuse+reload). The genuinely
new work: export_mask (AE mask → white-on-black PNG) and one inpaint
template+manifest. Full plan in SELF-VERIFY-PLANS.md.

## Part 2 — ranked roadmap (proposal; owner picks the order)

Three-lens panel (working designer / aescripts strategist / tech
leverage) merged and ranked for THIS stage: pre-launch alpha, where
robustness and demo-power outweigh breadth. S/M/L = effort. Full
what/why with file:line lives in WORKPLAN section 9.

1. **[S/both] Zero-silent-failure gate** — fix every audited
   silent-lie path: partial-mutation rollback arming (set_keyframes,
   apply_keyframe_ease), the 20-command silent slice + schema
   maxItems, the bare error paths (effects group, item lookups,
   track matte), comfy image-landed fail-fast, upload name collisions,
   the two byte-slice fallbacks. The failure class alpha testers never
   forgive, all with exact locations, zero model-behavior risk.
2. **[S/both] Plain-English trigger layer** — synonym rules + doc
   rebalance for the ten orphan tools; "clean this up" disambiguation;
   one single-phrasing probe step per mapping to bound regressions.
3. **[S/both] img2img restyle loop** — un-bypass KREA2's authored
   image branch, add denoise, chat flow snapshot_frame →
   comfy_generate{image,denoise} → import_as_layer reuse+reload.
   Best demo-per-line; prerequisite for inpainting; depends on 1's
   image-landed check.
4. **[S/both] Relative restack + removal symmetry** — reorder_layers
   relative mode (above/below/front/back), remove_effect, delete_mask;
   the three-word first-session requests with no tool today.
5. **[S/both] Animate-this-frame I2V one-liner** — trigger rule
   chaining snapshot_frame → H3 I2V {image} → import_as_layer; all
   links ship today, no rule teaches the chain. Flagged: 3-call chain;
   fallback is a compound panel tool (transcribe_to_captions
   precedent).
6. **[S/remote] One-click support bundle** — extend copy-chat into a
   full support report (settings redacted, tier line, comfy_status,
   server log tail, last round receipts). One-paste bug reports.
7. **[M/both] First-run flight check** — GPU/tier verdict in plain
   words, the AE scripting-permission probe with a grounded fix
   message, guided model download, canned first-win demo.
8. **[M/both] Timeline finesse pack** — retime_layer (stretch,
   reverse, time-remap), freeze_frame, shift_keyframes. "Slow it
   down" is week-one vocabulary with no tool; local measures AE's
   stretch/remap quirks first, stubs encode them.
9. **[L/both] Region inpainting hero demo** — the full plan in
   SELF-VERIFY-PLANS.md; after items 1 and 3. Ship as a compound
   repaint_region tool, not 5-call model choreography.
10. **[S/both] Word-level kinetic captions** — whisper -oj JSON,
    per-word timing + confidence gating (also fixes the English-only
    silence sentinel risk), karaoke/typewriter caption mode.
11. **[M/local] Chat-probe variant machinery (scoped)** — the
    prerequisites from Part 1.4, then 2–3 paraphrases over the safe
    rows. The full 75–125-variant nightly matrix stays deferred.
12. **[M/both] Bring-your-own-endpoint chat** — llama.js is already a
    pure OpenAI-compatible client; settings URL + skip-spawn. Widens
    the alpha pool past big-NVIDIA owners; salvage path becomes
    load-bearing, test it explicitly.

**Dropped (with reasons, revisit post-launch):** comp versioning
(strongest post-launch candidate), comp checkpoint/diff (undo work
covers alpha), review renders with slates, missing-footage triage,
segmentation-to-matte (fast-follow AFTER inpainting ships its mask
plumbing), 2.5D parallax (long model chains — the exact flagged risk),
variation boards (merged into generate-and-place), one-call audio
reactivity (rides beat markers), full paraphrase matrix (scoped into
item 11).

## Part 3 — the self-verification harnesses (summary)

All three designs survived adversarial refutation with fixes that are
now REQUIREMENTS (marked in SELF-VERIFY-PLANS.md). Shared skeleton:
probe scripts on the chat-probe bridge pattern, run by the overnight
loop under the existing dialog triage, verdicts appended to
WORKPLAN-LOG (a probe that aborts writes a grounded SKIP — silent
coverage decay is itself a failure), and every checker proven against
planted defects before it is trusted.

- **MOGRT:** zero-dep zip reader → definition.json parse → controller
  roster/type/range/default parity against pre-export receipts,
  bytes honesty from Node, refusal-writes-nothing disk snapshots.
  Found a LIVE bug during design: AELL_mogrtFound (hostscript.jsx:
  9482) reports a possibly mid-write size — fix queued. The pinned
  fixture must be one real Premiere accepted (kills the bootstrap
  circularity).
- **Captions:** independent timing anchor from AUTHORED audio layout
  (silence + two-sentence phrase + silence), caption-inside-segment /
  no-overlap / readable-duration / verbatim / safe-margin checks with
  pinned typography, silence and tone-WAV refusal rounds, plus one
  chat-probe step so the model half is covered too.
- **Inpainting:** the pixel invariant (outside-mask survives, inside
  changes) measured by an ffmpeg-based region comparator, with the
  region selector grounded ANALYTICALLY from the rig's geometry (not
  by the mask file under test), fixed seeds, magnitude+ratio gates
  (direction assertions demoted to report-only), degenerate-mask
  refusal before GPU spend, and tolerance freezing gated on a human
  blessing the first measured distributions.

**What stays manual, honestly:** Premiere accepting the .mogrt (once
per release), caption/inpaint aesthetics, Essential Graphics panel
appearance, and judging format drift when Adobe adds keys.
