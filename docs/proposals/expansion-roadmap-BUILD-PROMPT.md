# Build prompt: expanding the basic workflows in tandem

Paste this into a Claude session scoped to the plugin repo. Written
2026-09-09 by the local session, at the owner's direction, to be run
after the §22 install-bundle engineering is queued.

This is a DESIGN brief. It asks for a roadmap, not a patch.

---

## Context

AE Llama is a commercial After Effects CEP panel, headed for
aescripts.com. A LOCAL llama.cpp model drives After Effects through JSON
tool-calling across ~79 tools, with a hidden ComfyUI backend for image
and video generation. Windows 11, AE 2024+, currently v0.12.16.

Nothing leaves the machine. No cloud, no telemetry, no API key. Hard
product constraint and a selling point.

Read `CLAUDE.md` and `docs/ORIENTATION.md` first. Then `docs/MEMORY.md`,
which is the generated index into `docs/WORKPLAN-LOG.md` — do NOT read
the log itself, it is ~1 MB. Read WORKPLAN §18 and §22 in full; skip the
rest of the workplan.

### What exists as of 2026-09-09

Six basic generation workflows ship, each with a manifest linking it to a
`COMFY_CATALOG` entry, each MEASURED on a real RTX 5090 through the
managed backend a buyer actually gets:

| template | kind | catalog entry | gate |
|---|---|---|---|
| `AE_LLAMA_SD15_T2I_V1` | image | sd15 | 4 GB class |
| `AE_LLAMA_SDXL_T2I_V1` | image | sdxl | 12 GB |
| `AE_LLAMA_KREA2_T2I_V1` | image | krea2 | 24 GB |
| `AE_LLAMA_WAN22_5B_T2V_V1` | video | wan22-5b | 32 GB |
| `AE_LLAMA_H3_T2V_V1` | video | minimax-h3 | 32 GB |
| `AE_LLAMA_H3_INT8_T2V_V1` | video | minimax-h3-int8 | 32 GB |

All six are **core-only**: they use no custom node packs. That is
deliberate and load-bearing (see below).

`Setup.recommendSetup` / `recommendGen` scan the machine and choose a
tier, a chat model and a gen entry per kind, gated by `entryFits` on
`minVramGB` and `requiresBlackwell`. Manifests attribute every node class
to a PACK, and `test-workflow-manifests.js` requires a repo URL for every
non-core pack.

## Objective

The owner's words, 2026-09-09:

> "we'll end up having quite a few basic workflows, but that's kind of
> the idea. And then from there, we can holistically and strategically
> expand on the functionality of all of those basic workflows in tandem."

**Produce a ranked roadmap for that expansion.** The risk being managed
is drift: six basics that each grow their own ad-hoc features become a
dozen one-offs a small local model cannot reason about and one person
cannot maintain. The roadmap must say what capabilities the set gains, in
what order, and what stays shared rather than per-template.

## Non-negotiable constraints

Do not relitigate these. They are measured or decided.

**1. The basics stay core-only.** A buyer's recommended set must never
require installing a custom node pack. Expansion that needs packs belongs
in a separate, opt-in layer (WORKPLAN §22d). Any capability you propose
must say plainly which side of that line it falls on.

**2. Convert the spec, never recompute from inventory; and measure,
never reason.** `wan22-5b` shipped `minVramGB: 8` written from training;
measured, it is 32. Every VRAM or timing number in your roadmap must be
marked as measured or unmeasured, and unmeasured numbers may not gate
anything.

**3. Context is a functional resource.** System prompt + tool docs +
state + results + history share one window, default 16384. Every tool or
prompt addition must be paid for by a cut. A capability that needs three
new tool definitions is more expensive than one that needs zero, and the
roadmap must price that.

**4. No dependencies.** The panel ships none and adds none without
asking. `.jsx` is ES3. `.ps1` is pure ASCII.

**5. Adherence beats capability.** This panel exists to be USED by one
motion designer under deadline. A feature that is impressive and rarely
reached for loses to one that removes a daily irritation.

## What a good answer looks like

- **Capability groups, not features.** Name the 4-8 things the set should
  be able to do that it cannot today, each phrased as a user outcome.
- **Shared vs per-template.** For each group, say whether it lives once
  in `comfy.js`/`tools.js` and applies to every template, or has to be
  authored per graph. Prefer the former and say when it is not possible.
- **The core-only line.** Which groups are achievable with stock ComfyUI
  nodes, and which need packs and therefore the opt-in layer.
- **Sequencing, with reasons.** What unlocks what. What is cheap and
  high-value first.
- **The measurement each step needs**, and whether this machine (a 5090,
  which runs every entry) can take it. §18 P7 established the floor is
  RESIDENT WEIGHTS not frame size, so small-card fit is measurable here.
- **What you would NOT build**, and why. This is as useful as the rest.

## Out of scope

- The install-bundle architecture. It is filed as WORKPLAN §22 and its
  gaps are queued. Do not redesign it.
- Choosing an option in §18 P7a (the sub-32 GB video gap). Measurement is
  queued as §18 P7c; the decision is the owner's.
- Premiere. Owner-gated, §12.
- Anything requiring a network call at runtime.

## Deliverable

A single markdown document at `docs/proposals/expansion-roadmap.md`.
Ranked, with the reasoning visible. File anything it implies as WORK into
`docs/WORKPLAN.md` — a finding written only to a proposal is one nothing
will ever act on, which has happened here before.
