# Review brief — memory layer, and the tier floor

**For a second reviewer.** Two related proposals, neither built. Both
turn on the same constraint, which is why they are reviewed together:
**the system prompt is 10,758 tokens in the form a default user gets,
and it is already at a CI-enforced ceiling.**

Read in this order. Roughly 25 minutes.

| # | File | Why |
|---|---|---|
| 1 | `memory-layer-REVIEW.md` | The confirmation pass. Three stale premises, two integration points that do not exist. Read before the originals so you are not reasoning from corrected facts. |
| 2 | `memory-layer-SYSTEM-PROMPT.md` | The synthesis: memory rules reconciled with the real prompt, its byte ceilings, and measured facts about how this 32B reads it. |
| 3 | `memory-layer-BUILD-PROMPT.md` | The original build proposal, **verbatim**. |
| 4 | `memory-layer-SYSTEM-PROMPT-DRAFT.md` | The original prompt draft, **verbatim**. |
| 5 | `../WORKPLAN.md` §16 | The tier floor, with the arithmetic. |

Both originals are unedited on purpose, so you see what was reviewed
rather than a version already corrected by its own findings.

---

## The numbers everything rests on

All measured against the real `buildSystemPrompt` on 2026-09-05, not
estimated. Re-derivable with `node tests/test-context-budget.js`.

| | value |
|---|---|
| Compact prompt (what `ctx < 24576` gets) | 39,803 chars · **10,758 tokens** |
| Full prompt | 58,933 chars · 15,928 tokens |
| Ceilings (CI-enforced, `tests/test-context-budget.js`) | 40,000 compact · 59,000 full |
| **Headroom** | **197 chars compact · 67 chars full** |
| Rules block | 19,043 chars — **byte-identical in both forms** |
| History left at ctx 8192 | **0 — starved** |
| History left at ctx 16384 | 4,704 chars |
| 7B chat model, resident | **6,002 MB** (measured, dev machine) |
| VRAM reserved for After Effects | **none** — every tier allows 1 GB total headroom |

The asymmetry that matters: a **rules-block** addition costs both prompt
forms, but every previous addition here was paid for by cutting
**tool-doc second sentences**, which compact already discards. The bytes
for a memory block cannot come from where the last several passes took
them.

---

## What would make this review worth its cost

Attack rather than agree. Specifically:

**On the memory layer** — the ten questions at the end of
`memory-layer-REVIEW.md` §6 and `memory-layer-SYSTEM-PROMPT.md` §7. The
three that most change the build:

1. **Where do the resident index's 400–800 tokens come from**, against
   197 chars of compact headroom? Three ways to pay are argued in
   SYSTEM-PROMPT §5 — is a fourth being missed?
2. **Is the sidecar `.aellama/` beside the `.aep` right**, when the
   unsaved project is the *common* case here (AE cold-launches to
   `Untitled Project.aep`) and nothing in the panel currently reads
   `app.project.file` at all?
3. **"If memory and the project disagree, update the record"** is a
   write triggered by the model's own inference rather than by the user.
   It is the only rule in the block that could corrupt a store rather
   than merely fail to use it. Is it safe?

**On the tiers** — §16 concludes a 12 GB floor today, 8 GB only after KV
quantization and tool routing. Two things to press:

4. **The load-bearing number is an estimate.** AE's 2–3 GB footprint
   comes from outside this repo and carries two of four findings. §16f
   queues the measurement. Is the conclusion still right if AE holds
   1 GB? If it holds 4?
5. **Tool routing** (§16e) is proposed as the lever that moves the floor
   *and* frees the bytes for the memory block. That is one change
   serving two sections — which is either elegant or a sign both
   sections are leaning on something unproven.

**Also fair game:** `memory-layer-REVIEW.md` §4 lists things it says
should not be relitigated. That list is itself a claim. Name anything on
it you think is wrong.

---

## What is deliberately not asked

- Whether to use embeddings. Decided: no, for v1. Small consistent
  vocabulary, `grep`/FTS wins at a fraction of the complexity, and an
  embedding model competes for the VRAM `tiers.js` is already
  arbitrating.
- Whether memory stores project state. Decided: never. This panel's
  worst failure mode is confident action on stale structure, and it has
  shipped that bug repeatedly in other forms.
- Whether records are append-only. Decided: no, edit in place. Confirmed
  the hard way at repo level — `docs/WORKPLAN-LOG.md` is append-only,
  holds 37 announced corrections interleaved with what they overturn,
  and that is why `docs/MEMORY.md` had to be built.

Arguments against these are welcome, but they cost credits that the ten
open questions would use better.

---

## Not to be confused with

`docs/MEMORY.md` at the repo root is the **development loop's** memory —
a generated index into `WORKPLAN-LOG.md` so unattended passes can
retrieve by line range. Same principles, different consumer, no shared
code. It is built and working; nothing in this folder is.
