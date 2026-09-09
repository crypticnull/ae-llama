# Expansion roadmap: growing the six basics in tandem

Written 2026-09-09 by a design pass against
`expansion-roadmap-BUILD-PROMPT.md`. Read-only: no backend was booted, no
GPU was touched, no AE was launched. Every number below is either
**measured** (with its source) or marked **unmeasured**, and unmeasured
numbers gate nothing.

The queue view is `docs/WORKPLAN.md` §23. This document is the reasoning.

---

## 0. The one rule that keeps six basics from becoming a dozen one-offs

The panel already has the shape that prevents drift; the roadmap's job is
to not break it. As of 0.12.16 a template is reached through exactly
three seams, all shared:

| seam | where | what it does today |
|---|---|---|
| the argument list of ONE tool | `comfy_generate` (`tools.js:649`) | prompt, negative, width, height, seed, frames, durationSeconds, image, import |
| the generic injection walk | `injectParams` (`comfy.js:1155`) | lands those args on any graph by introspection; a manifest `procedural.*` key overrides when the walk cannot |
| the pure chooser | `describeWorkflows` / `resolveWorkflow` (`comfy.js:585`, `:629`) | picks the graph from `kind`, `takesImage`, `requiresImage`, `entryFits`, weights on disk, then the catalog's `workflowTemplate` |

The model sees one tool. It never picks a graph by name unless it wants
to; it says what it has (a prompt, maybe an image, maybe a mask) and the
resolver finds the template that takes it. **That is the whole anti-drift
design, and every capability below is priced against it:**

- A capability that is an ARG on `comfy_generate` plus a handler in
  `injectParams` is **shared**: written once, every template gains it the
  moment a graph carries the input.
- A capability that needs a new graph per entry is **per-template**, and
  it enters as a SIBLING file under the §18 naming contract
  (`AE_LLAMA_<MODEL>_<MODE>_V1`), never as an edit to a basic. The basic
  stays the proof of function and the measurement anchor.
- A capability that needs a node pack is **opt-in layer** (§22d). It
  lives in a separate seeded folder, never in the bundle, and §22a's pin
  stays strict: the bundle names `(comfy-core)` and nothing else, not
  even packs declared `optionalNodes`. `resolveOptionalNodes`
  (`comfy.js:1885`) is the runtime seam the opt-in layer uses; the
  basics never touch it.

Two consequences that are decisions, not observations:

1. **A manifest key with no consumer is not added** (PLAN §2). Every
   `procedural.*` key in this roadmap arrives with its handler and its
   bundle-test replay in the same commit.
2. **A sibling may raise its entry's floor, never lower it.** A sibling's
   manifest carries its own measured block; if it measures above the
   entry's `minVramGB`, the manifest carries a `minVramGB` override that
   `workflowFacts.fits` (`tools.js:2030`) reads. If it measures below,
   the entry's gate stands, because the entry's basic is what the buyer
   is recommended.

---

## 1. Context is the budget everything is priced in

Measured today by `node tests/test-context-budget.js`:

| form | chars | ceiling | headroom |
|---|---|---|---|
| compact (what a default 16384 window gets) | **39,803** | 40,000 | **197** |
| full (ctx >= 24576) | 58,933 | 59,000 | 67 |

So nothing below lands without a cut, and the cuts have to come from the
RULES block or the ARGS lines, because those are the only parts compact
keeps. Measured off `tools.js` today:

| prompt text | chars | status |
|---|---|---|
| `comfy_generate` args line | 536 | the longest args line in the file |
| ...of which the parenthetical "the size the template GENERATES at, which is not always the size it saves: a template that upscales between passes..." | **188** | describes the owner's authored KREA2 graph, which LEFT the bundle in 0.12.13 (§18 P8). No shipped basic upscales. |
| rules block, the seven `comfy_generate` lines | 690 | — |
| ...of which "Some video templates set length in SECONDS (durationSeconds)... re-call with durationSeconds" | **126** | no shipped basic declares `procedural.durationSeconds` any more (all six carry a literal `length`; the H3 manifest says why). Teaches a re-call no bundled template will ever ask for. |
| ...of which "Pass image: <absolute path> to give a video template a first frame; omit it for text-to-video" | **121** | no shipped template accepts an image (§18 P9a). Teaches a path the panel REFUSES with a grounded error. |
| ...of which "Match width/height to the target comp when it makes sense" | ~55 | becomes false once group A lands (the panel does it) |

**That is ~490 chars of prompt, in BOTH forms, currently buying either
nothing or a refusal.** They are the fund. Priced against them:

| addition | chars (both forms) | funded by |
|---|---|---|
| A. `comp?: string` on `comfy_generate` | +14 | the "Match width/height" sentence (−55) |
| C. `denoise?: number (0-1, image-to-image)` | +38 | the durationSeconds lines (−126) |
| C. reword the image line to cover image AND video | ±0 | itself |
| D. `mask?: string (absolute path)` | +30 | the upscale parenthetical (−188, replaced by "(generation size; the result reports the size imported)" +55) |
| D. a compound `repaint_region` tool: name + args + one compact sentence | **~240** | what is left (~130) plus one more cut, OR not built — see §5 |

Every prompt edit is gated on `chat-probe --variants`; the durationSeconds
and image cuts are the two that need it least, because the behaviour
they describe no longer exists. Whoever takes the cut pass runs the probe
anyway, because the rule is measured, not exempted.

---

## 2. The capability groups, ranked

Ranked by adherence first (constraint 5), then by how much is shared,
then by cost. Each is a user outcome the set cannot deliver today.

### A. "Put it in my comp, at my comp's size" — SHARED, core, first

**Today.** `comfy_generate` imports the result with `import_file`
(`tools.js:2290`), which the tool's own doc describes as "into the
PROJECT PANEL only — it does not appear in any comp". Placing it costs
the model a second round (`import_as_layer`), and the size is whatever
the model chose to name; the rules block asks it to "match width/height
to the target comp when it makes sense". Usefulness test G2
(`docs/USEFULNESS-TESTS.md:83`) already flags "the known gap is stopping
at the project panel". It is not filed as work anywhere; this files it.

**The change.** One arg, `comp?: string`, and when present the import
goes through `import_as_layer` (reuse + reload, fit to comp, both
already measured under §5.8) instead of `import_file`. When neither
`width` nor `height` is named and a target comp is known, the panel
derives the size from the comp — **converting the spec, not recomputing
it**:

- IMAGE templates: the comp's pixel size, snapped to the width/height
  input's declared `step` read from the backend's `/object_info` at
  generation time (`validateGraphInputs` already fetches these
  definitions, `comfy.js:1540`). No manifest key; the backend is the
  authority on the grid, and the sd15 P5a lesson is that a hand-written
  positional number is how a graph gets refused.
- VIDEO templates: the template's AUTHORED pixel count at the comp's
  ASPECT. The measured seconds for every video entry were taken at the
  authored size (H3: 1344x768, 253 s; Wan: 1280x704, 127 s — both
  measured 2026-09-09 on the 5090), and §18 P7 established the VRAM
  floor is resident weights, so a comp-sized 1920x1080 clip would fit
  the card and take an UNMEASURED multiple of the time. Time is the
  adherence constraint on video; the authored size is the spec.

**Cost.** +14 chars, −55 from the rules block; net negative. Zero
per-template work. Zero new nodes. One selftest step (the placement
half is `import_as_layer`, already covered by 17 suite steps under §5.8)
and one chat-probe variant ("generate a paper texture and put it in the
comp" — G2 verbatim).

**Measurement.** None on the GPU. The snap rule is verified against a
running backend's `/object_info` for all six templates in one
`comfy-probe --no-ae` pass, which this machine can take overnight.

**Why first.** It is the daily irritation: every generation today ends
with the asset in the wrong place, and the fix is the cheapest item in
this document.

### B. "Tell me how long before I wait, and do not promise what you will cancel" — SHARED, already queued

**Today.** The panel narrates step k/N and an ETA (0.12.16, §18 P3b),
but the ETA can exceed `comfyTimeoutSec` and the panel then cancels a job
it promised to finish (§18 P3c, NEXT UP item 4). And a video request
that names no length renders the template's authored length: 124
frames for H3 (5.17 s, 253 s measured), 121 for Wan (127 s measured) —
the basics fixed the >15-minute default the authored H3 graph had, but
capping what the PANEL injects when the user names none is still the
owner's call (§18 P3a(b)).

**This roadmap adds nothing to those items; it sequences them.** P3c
steps 1 and 2 are loop-takeable and come before any video sibling in
group C, because an i2v round-trip a user iterates on is unusable while
the panel can contradict itself about time. P3a(b) is owner-gated and
stays so.

**One addition, and it is unmeasured so it gates nothing:** a pre-queue
line, "about N s on an RTX 5090 at this size", from the entry's
`measuredSeconds` scaled by pixel count and frames. That scaling is a
REASONING from one reading, so it is labelled "on the reference card"
and never used to refuse. On any other card the honest line is "N s on
the reference card; this card is unmeasured". Cost: zero prompt bytes
(it goes in the progress sink, not the tool result). Worth building only
after group A; a buyer who has not yet been told where the asset went
does not need a timer first.

### C. "Start from what is on my timeline" — SHARED plumbing, PER-TEMPLATE siblings, core

**Today.** No shipped template accepts an image (§18 P9a, pinned by
`IMAGE_CAPABLE_SHIPPED = []`). Image-to-video left with the authored H3
graph; image-to-image never shipped. `snapshot_frame` and
`import_as_layer` (§5.8) are the AE halves and both exist, measured. The
upload path exists (`uploadImage`, `comfy.js:438`), the landed check
exists (`graphCarriesValue`), the resolver already prefers `takesImage`
templates when an image is given.

**The shared half (one pass, no GPU):**

1. `procedural.denoise` — the hook §18 named. One handler cloned from
   the `firstFrame` branch, one arg `denoise?: number`, and the bundle
   test replays it. `BasicScheduler.denoise` (krea2, H3, Wan) and
   `KSampler.denoise` (sd15, sdxl) are both literal numeric inputs, so
   the GENERIC walk can land it the way it lands `seed` — try that
   first; the manifest key exists only for a graph where the walk
   provably cannot.
2. The rules-block image line rewritten from "give a video template a
   first frame" to cover both kinds, at the same byte count.
3. **The placeholder measurement §18 P9a asks for.** A `LoadImage` in an
   API graph must name a file that exists in the backend's input
   folder or `validateGraphInputs` refuses the template before it is
   queued. Whatever placeholder the siblings carry must exist on a
   FRESH managed install; that is a measurement on this machine, not a
   guess, and it gates every sibling below.

**The per-template half, one sibling per pass, each measured:**

| order | sibling | shape | why this order |
|---|---|---|---|
| 1 | `AE_LLAMA_SD15_I2I_V1` | the sd15 basic + `LoadImage -> VAEEncode` into `KSampler.latent_image`, `denoise` 0.6 | cheapest proof of the WHOLE sibling mechanism: 4 s renders (measured on the basic), 2 GB weights, and it exercises the placeholder rule, the denoise handler, the resolver's `takesImage` path and the measured-block-on-a-sibling rule at once |
| 2 | `AE_LLAMA_H3_I2V_V1` | the H3 basic + `LoadImage` into `MiniMaxH3ImageToVideo.first_frame` | `first_frame` is OPTIONAL on that node (measured from `/object_info`, §18 P9a) and it is the owner's model; "animate this frame" is §9 item 5 |
| 3 | `AE_LLAMA_WAN22_5B_I2V_V1` | the Wan basic + `LoadImage` into `Wan22ImageToVideoLatent.start_image` | `start_image` is OPTIONAL there too (measured, §18 P9a); the only other video entry with a graph |
| 4 | `AE_LLAMA_SDXL_I2I_V1` | sd15's shape, ckpt swap | derived, not authored — see the derive rule below |
| 5 | `AE_LLAMA_KREA2_I2I_V1` | the krea2 basic + `LoadImage -> VAEEncode` into `SamplerCustomAdvanced.latent_image`; denoise on `BasicScheduler` | the 24 GB image entry; last of the image trio because its 4-step distilled sampler at partial denoise is unmeasured for quality as well as VRAM |
| 6 | `AE_LLAMA_H3_INT8_I2V_V1` | H3 i2v with the encoder swapped | derived; the P10 pattern |

Node classes named here are from core ComfyUI as this pass remembers it
and from what §18 P9a measured; **every one is confirmed against a
RUNNING backend's `/object_info` at authoring time, never from this
document** (PLAN §2). `scripts/comfy-node-defs.json` cannot answer
(§17l).

**Measurement, per sibling.** VRAM and seconds, two runs, on the managed
backend, the way P5-P10 did. **All six are UNMEASURED today.** The
expectation is "the basic plus one VAE encode of one frame", which is
small — and the expectation is exactly the kind of number that put
`minVramGB: 8` on wan22-5b. The i2v readings are taken at the authored
length and the authored size, so they compare to the basics' blocks
directly. This machine takes every one of them. **Instrument gap:**
`catalog-vram-probe` selects by `--entry` and runs the entry's
`workflowTemplate`; measuring a sibling needs a `--workflow` flag or an
equivalent. Filed as §23 instrument work; verify the flag does not
already exist before writing it.

**The derive rule, which is the anti-drift mechanism for this group.**
Siblings 4 and 6 differ from another shipped file by ONE input value.
`test-workflow-bundle.js` already pins that the two H3 basics "may
differ in exactly the encoder and the prefix" (§18 P10). Generalise it:
a manifest `derivedFrom: {workflow, differs: [nodeId.input, ...]}` whose
consumer is a bundle-test rule asserting the graphs are identical
outside the listed inputs. A derived sibling that drifts anywhere else
fails CI. This is the rule that lets a fp8 Wan entry (§18 P7c) inherit
Wan's siblings without hand-authoring them, and it is why the sibling
count can grow with the entry count without the maintenance growing
with it.

**Cost.** +38 chars for `denoise?`, funded by the −126 durationSeconds
cut. Six files. No new tool. No pack.

### D. "Fix just this part" — SHARED plumbing, PER-TEMPLATE siblings, core; the compound tool is the expensive half

**Today.** Nothing. §9 item 9 and `docs/SELF-VERIFY-PLANS.md` §3 carry
the full plan and its fourteen checks; this roadmap places it, it does
not redesign it.

**Core-only?** Yes, for the sampling half. `LoadImage` emits a MASK from
alpha; `VAEEncodeForInpaint`, `SetLatentNoiseMask`, `GrowMask`,
`ImageCompositeMasked` are core (from memory; confirm on a running
backend). The AE half is a mask rasteriser the plan calls `export_mask`.

**Shared.** The second `uploadImage`, `procedural.maskImage` (the hook
§18 named; the `firstFrame` clone), `mask?: string` on `comfy_generate`,
the mask-landed fail-fast, and the width/height strip when a mask is
present (the generic size walk must not stamp an image-path graph — the
plan's "size invariant" row).

**Per-template.** One `_INPAINT_V1` sibling per IMAGE entry — sd15,
sdxl, krea2 — in that order for the same reason as group C. Video
inpainting is not built (see §5).

**The AE tool.** `export_mask` is a NEW host tool and costs a tool
definition in the prompt (~200 chars compact). Cheaper: an `alpha?: bool`
on `snapshot_frame` that writes the comp's alpha as the mask — a mask
drawn as an AE mask or matte on a solid IS a comp with alpha. That is
+13 chars against ~200 and needs no new tool doc. Measure in real AE
whether `saveFrameToPng` carries alpha for a comp with a transparent
background before choosing; the §5.8 probe did not ask that question.

**The compound tool.** SELF-VERIFY-PLANS §3 wants `repaint_region` so
the 32B runs ONE call, not `snapshot_frame -> comfy_generate -> place`,
on the `transcribe_to_captions` precedent. That precedent is real. It is
also ~240 chars of compact prompt, which is more than the fund has left
after A, C and D's args. **Build the plumbing and the siblings first;
put the chain in front of `chat-probe --variants`; build the compound
tool only if the probe shows the 3-call chain failing** — the same
"measured, not pre-emptive" rule PLAN §8 applied to the `kind?` arg.
If it is needed, the bytes come from a cut named in the same commit.

**Why fourth.** It reuses every piece of C (upload, landed check,
sibling contract, derive rule, sibling measurement) and adds the most
new surface — a second upload, a mask rasteriser, pixel-level
verification. Building it before C means building C's plumbing inside
D, where it is harder to prove.

### E. The opt-in layer's first citizens — PACKS, after A-D, behind §22d

Everything here needs a custom node pack and therefore lives in the
opt-in layer. The basics do not change. The point of listing them is
that each one is a SIBLING of a basic with `optionalNodes` declaring how
it degrades, so the machinery is the one that already ships
(`resolveOptionalNodes`, `bypassNode`, `substituteNode`) and the
opt-in folder is seeded only after §22d has installed the pack.

| sibling | pack (from the owner's inventory and the H3 manifest, measured) | what it buys | measurement |
|---|---|---|---|
| `AE_LLAMA_H3_T2V_FAST_V1` | the five model-chain patches the H3 basic DROPPED: SageAttention / first-block cache / scheduled attention (KJNodes-class packs) | speed and VRAM on the slowest entry; the manifest calls them "a speed-or-VRAM trade rather than part of the render" | UNMEASURED. The authored graph ran with them; nobody measured them against the basic at the same seed and size. If the delta is not a real fraction of 253 s, this sibling is not shipped. |
| `AE_LLAMA_<VIDEO>_INTERP_V1` | frame interpolation (RIFE/FILM; no core node this pass knows of — confirm) | 24 fps from a 12 fps render at half the sampling time | UNMEASURED, and AE's own Timewarp/Pixel Motion does this on the timeline; ship only if the ComfyUI path is measured faster end to end |
| `AE_LLAMA_SDXL_CTRL_V1` | ControlNet weights + a preprocessor pack (`comfyui_controlnet_aux` for depth; `Canny` is core) | "keep my layout": generate a background that respects the comp's edges/depth from a `snapshot_frame` | UNMEASURED; a 2-3 GB control weight per model family to pin |

The order within E is the order of the table, and E does not start until
§22d exists and A-D have shipped. A buyer who has never placed a
generated asset in a comp does not need a faster sampler.

---

## 3. Sequencing, and what unlocks what

```
Phase 0  repo-only, funds everything, no GPU, no AE
         - the four prompt cuts (chat-probe gated; bumps)
         - modes coverage matrix pinned two-way in test-workflow-bundle.js
         - sibling measured-block rule + minVramGB-override reader
         - derivedFrom rule
         - catalog-vram-probe --workflow (verify first)
Phase 1  A. comp landing + comp-derived size          1 pass, bump, selftest + chat-probe
Phase 2  B. P3c (1)+(2) as queued; P3a(b) owner       already NEXT UP 4
Phase 3  C. shared plumbing (1 pass) then siblings    7 passes, each measured, each bumps
         SD15_I2I -> H3_I2V -> WAN_I2V -> SDXL_I2I -> KREA2_I2I -> H3_INT8_I2V
Phase 4  D. plumbing, snapshot alpha measurement, siblings, THEN probe the chain
         SD15_INPAINT -> SDXL_INPAINT -> KREA2_INPAINT; repaint_region only if measured necessary
Phase 5  E. §22d installer, then FAST -> INTERP -> CTRL, each measured or dropped
```

Why this order and not feature-first:

- Phase 0 before anything because 197 chars of compact headroom is not
  room for a single arg, and the fund is stale prose describing graphs
  that left the bundle.
- A before C because C's siblings all land an asset that today goes to
  the project panel; shipping i2v into the wrong place is shipping half
  of it.
- C's sd15 sibling before H3's because the sibling MECHANISM (placeholder
  rule, measured block on a manifest, derive rule, `--workflow` on the
  probe) is what is being proven, and sd15 proves it in 4 s per render
  instead of 253.
- D after C because D is C plus a second upload plus a rasteriser plus
  pixel verification; every shared piece it needs is cheaper to prove in
  C.
- E last because it is the only phase that needs §22d, and because every
  item in it is "faster" or "more control" — the kind of capability
  constraint 5 ranks below "removes a daily irritation".

Each sibling pass is the §18 P9 rule: one template per pass, proven end
to end, measured, bumped. A pass that authors two is a pass that measures
neither.

---

## 4. The coverage matrix, extended to modes

§22e keeps a matrix of tier x kind. This roadmap makes it tier x kind x
MODE, pinned two-way in `test-workflow-bundle.js` so a mode cannot
appear or vanish without a log entry:

| entry | gate (measured) | T2I/T2V | I2I/I2V | INPAINT | FAST / INTERP / CTRL |
|---|---|---|---|---|---|
| sd15 | 4 | ships | C.1 | D.1 | — |
| sdxl | 12 | ships | C.4 (derived) | D.2 | E.3 |
| krea2 | 24 | ships | C.5 | D.3 | — |
| wan22-5b | 32 | ships | C.3 | not built | E.2 |
| minimax-h3 | 32 (Blackwell) | ships | C.2 | not built | E.1, E.2 |
| minimax-h3-int8 | 32 | ships | C.6 (derived) | not built | derived from E.1 |
| ltx-small | 6, unmeasured | none (owner Q1) | — | — | — |
| fp8 Wan (§18 P7c, if it ships) | unmeasured | P7c | derived from C.3 | — | derived from E.2 |

Reading down a column is "the capability, across the set" — that is what
"in tandem" means operationally. Reading across a row is what a buyer
with that card gets. Every cell is a file under the naming contract or a
deliberate dash.

---

## 5. What this roadmap would NOT build, and why

- **Upscaling as a template capability.** Core can do it
  (`UpscaleModelLoader` + `ImageUpscaleWithModel`, plus a pinned 4x
  weight), and it costs the same weights resident plus a second pass at
  4x the pixels — the authored KREA2's second pass measured 5.3 GiB and
  24 s more than the basic (§18 P8). AE has Detail-preserving Upscale on
  the timeline for free. A motion designer under deadline does it there.
- **A `kind?` arg, a `steps?` arg, a `cfg?` arg, a `sampler?` arg.** Each
  is bytes in both prompt forms handed to a model that misreads vague
  instructions; the basics carry the vendor's own defaults and the
  measured blocks are taken AT those defaults. A user who wants to tune a
  sampler opens the graph in ComfyUI — measured to work on an API file
  (§18 P5b) — and saves a sibling.
- **Variations / batch (`count?`, `batch_size`).** Dropped by the
  2026-08-30 audit (§9) with reasons recorded. The cheapest form if
  reopened is one arg landing on `batch_size` by the same introspection
  as width/height; it is not reopened here.
- **LoRA / style-lock siblings.** `LoraLoader` is core, but no LoRA is
  pinned, the catalog has no shape for a per-mode optional weight yet,
  and a sibling per (entry x LoRA) is the drift this document exists to
  prevent. Revisit after the derive rule has carried C and D.
- **Video inpainting, reference-to-video (H3 r2v), audio-driven video.**
  r2v needs the `ref2va` diffusion file — a different 20 GB weight, so a
  new catalog ENTRY under §18's rules, not an expansion of an existing
  basic. Audio input is a third upload kind with no consumer graph.
  `CAPABILITIES.md` already records r2v as "unconverted"; it stays so.
- **Segmentation-to-mask, 2.5D parallax, depth passes as core.**
  Dropped or deferred by §9 with reasons; the depth PREPROCESSOR is a
  pack either way (E.3).
- **Anything that edits a shipped basic.** A basic is frozen under its
  name (PLAN §1): a seeded copy a user has touched is preserved forever by
  the hash-history seeder, and the tests pin the file. Improvement is a
  sibling; the basic stays the anchor the measurements hang from.
- **An orchestration layer ("build me the whole comp").** Six rounds per
  turn and a 32B model are the ceiling; every compound behaviour ships
  as ONE panel tool with a receipt, or not at all.
- **A per-tier resolution ceiling.** `COMFY_TIERS_PLAN.md` describes
  "per-kind resolution ceilings the workflow templates read" and three
  manifests say `resolutionCeilingFrom: tier ceilings`; nothing in
  `tools.js` or `comfy.js` reads one. Group A derives size from the comp
  and the backend's step; a ceiling would be a number written from
  reasoning, which is the class of number this repo has stopped
  shipping.

---

## 6. Things found that the brief, or the repo, has wrong

Reported rather than fixed; each is filed in §23 where it implies work.

1. **The prompt teaches two paths the bundle refuses.** The rules block
   tells the model to pass `image:` for a first frame (121 chars) and to
   re-call with `durationSeconds` when a template refuses frames (126
   chars). As of 0.12.14/0.12.16 no shipped template accepts an image
   (§18 P9a) and none declares `durationSeconds`. Under constraint 3
   those 247 chars are the most expensive bytes in the prompt: they cost
   history and buy a grounded refusal.
2. **The `comfy_generate` args line documents the authored KREA2's 1.6x
   upscale** (188 chars) — a graph that left the bundle in 0.12.13.
3. **`tiers.js` copy contradicts the measured catalog.** T3 (8 GB) and T4
   (12 GB) promise "short Wan clips" (Wan gates at 32, measured); T4
   promises "Flux/Krea at 1024px" (krea2 gates at 24, measured); T5-T7
   promise "Wan 14B", which is not a catalog entry. §16 and PLAN §8 know
   this; §22b/§22c will put that copy in front of a buyer on first run,
   so it moves from stale to wrong the day §22c ships.
4. **`docs/CAPABILITIES.md`'s curated half** says "the remaining blocker
   is P4, which is every VRAM figure ... measured on real hardware" and
   "the Krea 2 workflow now ships adapted and runnable ... with a
   dependency manifest" in the same paragraph that correctly says the
   authored graphs left the bundle. `ALLOW_UNMEASURED` is empty; P4 is
   done.
5. **`docs/proposals/README.md`** lists the templates plan as "planned
   2026-09-06, not built". P5-P10 shipped 2026-09-09.
6. **Not a contradiction, a confirmation worth stating:** every claim
   the brief makes about what exists — six core-only basics, all
   measured on the 5090 through the managed backend, manifests
   attributing every class to a pack, a repo URL required per non-core
   pack, `entryFits` gating on `minVramGB` and `requiresBlackwell` —
   checked true in the code this pass read.

---

## 7. Provenance

| decision | from |
|---|---|
| one tool, one walk, one chooser as the drift boundary | `comfy.js` / `tools.js` as shipped; PLAN §1 "one chooser, never two" |
| siblings, never edits; derive rule | §18 contract, P10's two-file rule, P7c's "second entry with one filename changed" |
| a sibling may raise, never lower, its entry's floor | §18 P6/P6a/P7: gates are measured per graph, the entry is what the buyer is recommended |
| bundle stays strictly core, opt-in layer separate | owner Q6 reframe; §22a; §22d |
| A first | constraint 5; USEFULNESS-TESTS G2; `import_file` doc |
| video size = authored pixels at comp aspect | §18 P7 (floor is weights), measured seconds at authored size only |
| compound tool only if measured necessary | PLAN §8 `kind?` rule; SELF-VERIFY-PLANS §3 precedent acknowledged |
| prompt fund = stale lines | measured off `tools.js` this pass; `test-context-budget.js` 39,803 / 58,933 |
| E last, and each item measured or dropped | H3 manifest "speed-or-VRAM trade"; constraint 2 |
