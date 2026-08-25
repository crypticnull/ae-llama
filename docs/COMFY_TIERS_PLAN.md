# One GPU, two engines — hardware tiers for generation

The design problem, stated honestly: chat (llama-server) and generation
(ComfyUI) share ONE pool of VRAM. A 6 GB card running the 4.7 GB Qwen 7B
chat model has ~1 GB free — no image model fits *while chat is loaded*,
ever. So "which models fit which cards" is the easy half; the hard half
is **who owns the GPU at any moment and how it changes hands**. Tiering
the catalogs without solving the handoff ships a panel that OOMs the
moment a 6 GB user asks for an image.

Goal, verbatim from the owner: a 6 GB user uses the panel to THEIR full
capacity — real image generation with stated limits, not a greyed-out
button.

## Principles

1. **One detection, one tier, both catalogs derive from it.** VRAM is
   read once (`detectGpu`), a tier object is computed once, and BOTH the
   llama recommendation and the ComfyUI recommendation key off that same
   object. Two independent tier tables would drift, and drift here means
   OOM.
2. **The budget belongs to the session, not to an engine.** The tier
   decides a *policy* (exclusive vs concurrent), but the actual gate is
   arithmetic at request time: `free = vram − loadedChatModel − headroom`,
   using the models the user REALLY configured — not the ones we
   recommended. A user who overrides chat upward silently flips
   themselves from concurrent to exclusive; the arbiter must notice,
   not assume.
3. **Degrade honestly.** Every tier states what it can do in UI copy and
   in grounded errors ("Your 6 GB card runs SD 1.5 up to 768px; SDXL
   needs 8 GB"). Refusals name the tier and the way up. Never a generic
   "generation failed".
4. **Testable without the hardware.** `vramOverrideGB` in settings makes
   a 24 GB dev card impersonate a 6 GB one, so every tier's behavior is
   exercisable on the one real machine we have — and the arbiter itself
   is pure logic, stub-testable in CI with fake processes and a fake
   clock.
5. **Measured beats quoted.** Every VRAM figure below is from training
   data and marked PROVISIONAL until the local session measures it on
   real hardware (nvidia-smi deltas during actual generations). The
   catalog format carries `measured: true|false` so provisional numbers
   are visibly provisional.

## The tier table (single source of truth → `extension/js/tiers.js`)

| Tier | VRAM | Chat default | Gen policy | Image ceiling (PROVISIONAL) | Video (PROVISIONAL) |
|---|---|---|---|---|---|
| T0 | none/CPU/<4 GB | Llama 3.2 3B (CPU) | exclusive, experimental | SD 1.5 @ 512, slow, flagged experimental | none |
| T1 | 4–7 GB | Llama 3.2 3B (2.1 GB) | **exclusive** (mandatory) | SD 1.5 @ 768; SDXL @ 1024 with fp8/offload, flagged | none (LTX-small experimental) |
| T2 | 8–11 GB | Qwen 7B (4.7 GB) | exclusive | SDXL comfortable; Flux Schnell GGUF q4 | Wan 1.3B short clips |
| T3 | 12–15 GB | Qwen 7B | exclusive for big models, concurrent for SD 1.5 | Flux/Krea dev fp8 @ 1024 | Wan 1.3B comfortable |
| T4 | 16–23 GB | Qwen 14B (9 GB) | exclusive; concurrent with 7B chat | Flux/Krea dev | Wan 14B GGUF q4, marginal |
| T5 | 24 GB+ | Qwen 14B/32B | concurrent available | Krea full precision | Wan 14B; the full user-picked stack |

Each tier row in code also carries: `headroomGB` (default 1),
`copy` (the honest one-line UI description), and per-kind resolution
ceilings the workflow templates read. Video entries stay placeholders
until the owner's picks land (Krea workflow JSON, Wan variant, and
whether "MiniMax H3" means local weights or an API — ask before
cataloguing it).

## The arbiter (state machine, `comfy.js` + `llama.js`)

States: `CHAT` (llama per settings) → `GEN_REQUESTED` → `GEN_RUNNING` →
back to `CHAT`. Rules:

- On a generate request, compute `need` (gen model VRAM + headroom) vs
  `free`. Fits → run concurrent. Doesn't fit and policy allows →
  **handoff**: stop llama, VERIFY the VRAM actually released (poll
  nvidia-smi total-used until it drops or 10 s timeout — the current
  fixed 1.5 s sleep is hope, not verification), then run.
- **After generation, ComfyUI keeps its models cached in VRAM.** On
  exclusive tiers that cache is what prevents chat from coming back, so
  the arbiter must free it (ComfyUI's `/free` `{unload_models: true}` —
  PROBE which builds support it; fallback: restart the managed ComfyUI
  process, which we already know how to do).
- **Lazy chat restart.** Do not eagerly restart llama after each
  generation — a user generating five variations would thrash
  load/unload ten times. Restart on the next chat message, with a
  "warming the chat model back up…" status line. (A generation request
  arriving while GEN_RUNNING queues; ComfyUI already queues natively.)
- OOM mid-generation → grounded error naming the tier, the model that
  didn't fit, and the preset that would ("try 768px, or the SD 1.5
  preset") → guarantee the chat model comes back regardless.
- `comfyPauseLlm` migrates from boolean to `auto | always | never`,
  default `auto` (tier arithmetic decides). `never` on a tier that
  needs exclusive → the generate tool refuses up front with the honest
  explanation, BEFORE any VRAM churn. Existing boolean settings migrate
  in `settings.js` (true→auto is the safe mapping).

## First-run alignment

Setup already detects the GPU and recommends a chat model. It becomes
one combined, tier-derived recommendation:

> "RTX 4060, 8 GB: **Qwen 7B** for chat + **SDXL** for images, short
> Wan clips for video. Generation pauses chat on this card. ~11 GB of
> downloads."

One "download recommended" action drives the existing downloader
(progress + cancel already built) through both stacks; the alternate
models folder already exists for the disk-constrained. The ComfyUI
install itself stays lazy (first generation request), but the CHOICE is
made and shown at setup, keyed to the same tier as the chat pick.

## Catalog & manifest

`update.json` grows a `comfyCatalog` next to `modelCatalog`: entries
`{name, kind: image|video, urls, sizeMB, minVramGB, measured,
exclusiveBelowGB, ceilings, workflowTemplate}`. Feed-driven like the
llama catalog, so catalog corrections ship without a panel release. The
owner's Krea workflow JSON becomes a workflow template referencing a
catalog entry — the template mechanism already exists
(`comfy_list_workflows`).

## Phases and owners

- **P1 (remote):** `tiers.js` single source + stub tests; refactor
  `recommendModel` onto it behavior-preserving; add `vramOverrideGB`.
- **P2 (remote):** the arbiter + stub tests (fake processes, fake
  clock, simulated OOM); `comfyPauseLlm` tri-state migration; verified
  VRAM release replacing the 1.5 s sleep.
- **P3 (remote):** combined first-run recommendation UI; `comfyCatalog`
  manifest plumbing with PROVISIONAL entries.
- **P4 (local, the machine with the real GPU):** measure every catalog
  entry's true VRAM (nvidia-smi deltas), verify the exclusive handoff
  actually releases memory both directions, OOM recovery, lazy restart —
  each tier simulated via `vramOverrideGB`. Measurements flip
  `measured: false → true` in the catalog. Queued into WORKPLAN only
  after P1–P3 land.
- **P5 (blocked on the owner):** Krea workflow JSON, video model picks,
  MiniMax H3 clarification → final catalog entries.
- Ships as a MINOR release after review, like the rest of the feature
  track.

## Open questions for the owner

1. Is "SD 1.5-class images, no video" an acceptable floor story for
   6 GB, or should SDXL-with-offloading be the T1 default despite the
   wait?
2. Video floor: fine that below 8 GB there is none?
3. "MiniMax H3" — local weights you have, or an API? Changes whether it
   can be catalogued at all.
4. The Krea workflow JSON + model picks (long-standing task #21) gate
   P5 only — P1–P4 proceed without them.
