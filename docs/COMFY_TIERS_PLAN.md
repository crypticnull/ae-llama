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

Anchored to NVIDIA's actual product stack — the VRAM levels below are
the ones NVIDIA ships, so every real card lands cleanly in a tier.
Support floor: Pascal (GTX 10-series) — the practical ComfyUI minimum;
anything older (or no NVIDIA GPU) is T0/CPU, present but flagged
experimental.

**Detection keys off MEASURED VRAM (nvidia-smi), never the card name.**
The same product name ships with different VRAM (4060 Ti: 8 or 16 GB;
RTX 2060: 6 or 12 GB; laptop chips carry less than their desktop
namesakes — a laptop 4090 is 16 GB). The product examples below are for
design and marketing copy ("runs on a GTX 1660"); at runtime only the
measured number exists.

| Tier | VRAM | Example cards (not exhaustive) | Chat default | Gen policy | Image ceiling (PROVISIONAL) | Video (PROVISIONAL) |
|---|---|---|---|---|---|---|
| T0 | <4 GB / none / pre-Pascal | GTX 960, no-GPU | Llama 3B (CPU) | exclusive, experimental | SD 1.5 @ 512 CPU/offload, flagged slow | none |
| T1 | 4–5 GB | GTX 1650, 1050 Ti, laptop 3050 | Llama 3B (2.1 GB) | **exclusive** (mandatory) | SD 1.5 @ 512–768 | none |
| T2 | 6–7 GB | GTX 1060 6GB, 1660/Ti/Super, RTX 2060, 3050 6GB, laptop 4050 | Llama 3B | **exclusive** (mandatory) | SD 1.5 @ 768; SDXL @ 1024 via offload, flagged | none (LTX-small experimental) |
| T3 | 8–11 GB | GTX 1070/1080/1080 Ti, RTX 2070/2080/Ti, 3060 Ti, 3070, 4060, 4060 Ti 8GB, 5060, 3080 10GB, laptop 4060/4070 | Qwen 7B (4.7 GB) | exclusive | SDXL comfortable; Flux Schnell GGUF q4 (pre-Ada cards: GGUF only, no fp8 compute) | Wan 1.3B short clips |
| T4 | 12–15 GB | RTX 2060 12GB, 3060 12GB, 3080 12GB/Ti, 4070/Super/Ti, 5070, laptop 4080/5070 | Qwen 7B | exclusive for big models; concurrent SD 1.5 | Flux/Krea dev fp8 @ 1024 | Wan 1.3B comfortable |
| T5 | 16–23 GB | 4060 Ti 16GB, 4070 Ti Super, 4080/Super, 5060 Ti 16GB, 5070 Ti, 5080, laptop 4090/5080 | Qwen 14B (9 GB) | exclusive; concurrent with 7B chat | Flux/Krea dev | Wan 14B GGUF q4, marginal |
| T6 | 24–31 GB | RTX 3090/Ti, 4090, Titan RTX, laptop 5090 | Qwen 14B | concurrent (14B + SDXL/Flux fp8) | Krea full | Wan 14B |
| T7 | 32 GB+ | RTX 5090 | Qwen 14B or 32B | concurrent by arithmetic | Krea full precision, larger batches | Wan 14B comfortable; the full user-picked stack |

Boundaries sit ON product VRAM levels (4/6/8/12/16/24/32), so no real
card straddles one. Borderline behavior inside a tier is not hardcoded
anyway: the arbiter's arithmetic decides concurrency from the ACTUAL
configured models — e.g. even a 32 GB 5090 running the 20 GB Qwen 32B
chat model still needs the exclusive handoff for a 13 GB Flux
generation, and the arithmetic discovers that without a special case.

Each tier row in code also carries: `headroomGB` (default 1),
`copy` (the honest one-line UI description), and per-kind resolution
ceilings the workflow templates read. Pre-Ada cards (GTX 10/16, RTX 20)
lack fp8 compute, so their catalog entries prefer GGUF quantizations —
an entry field (`requiresAda: bool`), not a separate tier.

**Video stack (owner-confirmed, repos pinned 2026-08-22):**

- **Wan 2.2** — https://huggingface.co/collections/Wan-AI/wan22 .
  Note this is Wan 2.2, whose variants differ from 2.1's 1.3B/14B split
  (2.2 ships a 5B TI2V and A14B MoE variants) — P5 pins exact
  repos/files per tier from the collection; P4 measures. Downloaded
  like chat models via the existing downloader.
- **MiniMax H3** — canonical download repo is
  **Comfy-Org/MiniMax-H3** (ComfyUI-repackaged; the owner's r2v workflow
  embeds its exact file URLs — see
  extension/workflows/AE_LLAMA_H3_R2V_V1.manifest.json). It is
  reference-to-video+AUDIO: a diffusion weight, a 32B text encoder, and
  BOTH a video and an audio VAE. The bundled encoder is nvfp4 —
  **Blackwell-only** (RTX 50-series); other tiers need a different
  precision from the same repo, pinned in P5. So catalog entries need
  per-ARCHITECTURE variants (requiresAda, requiresBlackwell), not just
  VRAM floors. Enters the catalog with measured VRAM or not at all.
  NOTE the base weight was absent from the Documents models root the
  scan covered, yet the workflow runs — the Desktop app resolves models
  from the CODE root's models dir too, so the register-existing matcher
  must scan BOTH roots (local task queued to confirm where it lives).
- **LTX-small at T2 — CONFIRMED experimental.** 6 GB cards get an
  experimental short-video entry, flagged as such, exclusive handoff
  mandatory. If P4's simulated-T2 run shows it cannot finish a clip
  inside a sane wall-clock, it ships OFF by default with a settings
  toggle rather than being cut.

**Krea 2 — workflow IN HAND** (`extension/workflows/AE_LLAMA_KREA2_V1.json`
+ `.manifest.json`). What it taught us, from the graph itself:

- The stack is Krea2 turbo int8 + a Qwen3-VL 4B fp8 TEXT ENCODER + a
  Qwen image VAE, plus an optional depth-control branch (control LoRA +
  DepthAnythingV2). Multi-file catalog entries were the right call.
- **Workflows have CUSTOM NODE dependencies, not just model files** —
  this one needs rgthree-comfy, cg-use-everywhere, comfyui_essentials,
  SesquiLSR, and a set the local scan must attribute (the Krea2Control
  nodes, DepthAnythingV2Preprocessor, ArcaneBloomFX). The bundled
  installer therefore needs a node-pack install step (git clone into
  custom_nodes or ComfyUI-Manager headless), and `comfyCatalog`
  workflow templates declare `customNodes` alongside `models`.
- **The prompt-enhancer branch runs on Ollama — the panel bypasses it
  permanently.** The panel HAS a language model; it does the prompt
  enhancement itself and injects into the workflow's documented
  manual-prompt path (Any Switch input any_02). No Ollama dependency
  ships, and the enhancer group stays mode-4.
- The workflow uses ComfyUI subgraphs → bundled ComfyUI must be
  >= 0.3.76.
- The SaveImage node hardcodes the owner's output path — template
  injection must override the save path per generation.

**Model locations for users who already have models (P3):** one
alternate folder is not enough — ComfyUI veterans have models spread
across drives. `comfyModelsDir` becomes `comfyModelRoots: []` (multiple
roots, each optionally per-kind: checkpoints/text_encoders/vae/loras/
diffusion_models/…), all written into extra_model_paths.yaml, all
scanned by the register-existing matcher. First-run setup asks "already
have ComfyUI models? point me at them".

**T2 floor decision (resolved by arithmetic, 2026-08-22):** SD 1.5 is
the 6 GB default. SDXL on 6 GB cannot fit and falls back to sequential
offloading — a mode change, not a slowdown: ~5–10x slower (minutes per
image vs ~20 s), where on 8 GB+ it fits and costs only ~2–3x. A default
that takes minutes per image reads as broken; SDXL stays available on
T2 as an opt-in flagged "~2–4 min/image on this card".

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
exclusiveBelowGB, requiresAda, ceilings, workflowTemplate}`. Feed-driven
like the llama catalog, so catalog corrections ship without a panel
release. **Downloads work exactly like chat models today**: HuggingFace
URLs through the existing downloader (progress, cancel, resume), into
the models dir or the user's alternate folder. Entries may need
multiple files (a video model is diffusion weights + text encoder +
VAE) — the `urls` list plus per-file sizes exists for that, and the
downloader's progress line shows file N of M.

**Register-existing path:** a user who already holds weights (the owner
holds MiniMax H3 now) points the panel at them instead of
re-downloading — the alternate models folder + extra_model_paths.yaml
mechanism already built. The catalog entry matches by filename+size and
flips to "installed" without a download.

The owner's Krea workflow JSON becomes a workflow template referencing
a catalog entry — the template mechanism already exists
(`comfy_list_workflows`).

## What the real install taught us (docs/COMFY_LOCAL_INVENTORY.md, 2026-08-25)

The local scan of the owner's machine — a Comfy DESKTOP install with
256 weight files / 1011 GB — invalidated five assumptions before they
shipped:

1. **Code and data live in different roots.** The Documents folder holds
   models/custom_nodes; the running code lives under
   AppData\Local\Comfy-Desktop. The bootstrap must detect Desktop
   installs (`.comfyui-desktop-*` marker) and treat the two roots
   separately — deriving one from the other is wrong on real machines.
2. **Version gates compare COMPONENT-WISE, never lexically.** The real
   install is 0.32.0; lexically that is LESS than the required 0.3.76.
   Reuse the panel's own `compareVersions`. And read the version from
   the running instance's log or the active install — this machine has
   two STALE version files (0.22.2, 0.20.1) that would gate wrongly.
3. **The register-existing matcher stays EXACT-name.** The owner's disk
   holds `krea2Dmergev3_int8ConvrotV3` within 1 MB of the real Krea
   file — fuzzy matching would register the wrong model. Exact filename,
   size as confirmation only.
4. **Model files live outside models/ too.** depth_anything_v2_vitl.pth
   sits under custom_nodes/comfyui_controlnet_aux/ckpts — a matcher
   scoped to models/ re-downloads 1.3 GB the user already has. Scan
   node-pack ckpts dirs as secondary roots.
5. **Node packs COLLIDE.** DepthAnythingV2Preprocessor is defined by two
   installed packs; which binds depends on load order. The installer
   must check for an existing provider before cloning a pack, and the
   workflow manifest pins WHICH pack each node is expected from.

**MiniMax H3 status on the owner's machine: HALF-PROVISIONED.** Turbo
LoRAs and the video VAE are present; the base/transformer weight is NOT
on disk anywhere. Until the base weight is downloaded from
https://huggingface.co/MiniMaxAI/MiniMax-H3 , H3 cannot run or be
measured even on the 5090. Wan 2.2 is fully provisioned in three
precisions and is therefore the video model P4 measures FIRST.

## Phases and owners

- **P1 (remote):** `tiers.js` single source + stub tests; refactor
  `recommendModel` onto it behavior-preserving; add `vramOverrideGB`.
- **P2 (remote):** the arbiter + stub tests (fake processes, fake
  clock, simulated OOM); `comfyPauseLlm` tri-state migration; verified
  VRAM release replacing the 1.5 s sleep.
- **P3 (remote):** combined first-run recommendation UI; `comfyCatalog`
  manifest plumbing with PROVISIONAL entries.
- **P4 (local, the 32 GB 5090):** measure every catalog entry's true
  VRAM (nvidia-smi deltas), verify the exclusive handoff actually
  releases memory both directions, OOM recovery, lazy restart. The
  5090 can impersonate EVERY tier via `vramOverrideGB` (a 6 GB budget
  enforced on a 32 GB card), so the whole ladder T1–T7 is testable on
  the one real machine. What it cannot simulate: pre-Ada quirks (no
  fp8 compute), genuinely-out-of-memory driver behavior, and WALL-CLOCK
  on small cards — the override caps the budget, not the 5090's
  compute, so offload PATHS get exercised while offload TIMINGS stay
  training-quoted until a real low-tier card reports. UI copy quoting
  times must say "typically" and cite the card class, not promise.
  Also here: measure MiniMax H3's real VRAM from the owner's local
  weights — it enters the catalog with measured numbers or not at all. Measurements flip
  `measured: false → true` in the catalog. Queued into WORKPLAN only
  after P1–P3 land.
- **P5 (blocked on the owner):** Krea workflow JSON, video model picks,
  MiniMax H3 clarification → final catalog entries.
- Ships as a MINOR release after review, like the rest of the feature
  track.

## Open questions for the owner

1. ~~T2 default~~ RESOLVED: SD 1.5 default at 6 GB, SDXL opt-in
   flagged with its real wait (see the T2 floor decision above).
2. ~~Video floor~~ RESOLVED: LTX-small experimental at T2 (see video
   stack above).
3. ~~MiniMax H3~~ RESOLVED: local weights, owner holds them. P5 needs
   the exact HuggingFace repo/file list (or the local filenames+sizes
   to derive it); P4 measures VRAM before any tier claim.
4. ~~Krea workflow JSON~~ RESOLVED: in the repo with a dependency
   manifest. Remaining P5 inputs come from the LOCAL SCAN of the
   owner's real install (WORKPLAN item 2c): file sizes, which pack owns
   each unattributed custom node, and the Wan 2.2 / MiniMax H3 file
   lists as actually downloaded.
