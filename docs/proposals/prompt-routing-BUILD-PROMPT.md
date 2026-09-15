# Build prompt: prompt delivery — split the rules per tool, route, and shrink what the model reads

Paste this into a Claude session scoped to the plugin repo. Written
2026-09-15 by the local session, at the owner's direction.

This is a DESIGN brief. It asks for a plan that can be measured
overnight, not a patch.

---

## Context

AE Llama is a commercial After Effects CEP panel. A LOCAL llama.cpp chat
model drives After Effects through JSON tool-calling across 79 tools.
Default context window: 16,384 tokens. Nothing leaves the machine.

Read `CLAUDE.md`, then `docs/MEMORY.md` (the index — do NOT read
`docs/WORKPLAN-LOG.md` whole, it is over a megabyte). Read WORKPLAN §8
(the paraphrase matrix), §13b (KV-cache quantization), §15 (memory layer),
§16 and §16e (tool routing) in full, and
`docs/proposals/memory-layer-REFINED.md` §6. Skip the rest.

## The measured problem (2026-09-15)

A fresh panel session, one user command ("save a PNG of this comp"). The
command worked. The panel then reported:

- **Tool docs + rules + project state: ~12,242 tokens of 16,384**, before
  the user typed anything.
- Reply reserve: **3,328 tokens**. That leaves **~800 tokens for the
  entire conversation** — everything the user types and every tool result.
- A perfectly ordinary `snapshot_frame` result was then **"message cut to
  fit"**. It had nowhere to go.

Repo measurements that explain it:

| what | size |
|---|---|
| preamble + rules, up to `Available tools:` | 19,060 chars ≈ 5,152 tokens (§16e) |
| tools the rules block names by name | **57 of 79** |
| compact prompt (default below 24K) | 39,803 of a 40,000 ceiling |
| full prompt | 58,933 of a 59,000 ceiling |
| state block, capped | 5,963 bytes |

Two traps worth knowing before designing:

- `promptModeFor` returns `compact: ctx < 24576`. Raising a window to
  24,576 switches to the FULL docs, which eats most of the gain. Raising
  context is not a clean escape even where VRAM allows it.
- Tool results are verbose. The `snapshot_frame` result above carried the
  output path twice with doubled backslashes plus a long `next` hint.

## Owner principle — non-negotiable

> "The AI model itself doesn't need to be crazy smart. It just needs to be
> able to run the tools."

> "If we're trying to give this to people with eight to twelve gigabyte
> cards, they can't just raise it."

So: **design for an 8-12 GB card at its default window.** Raising the
context size is not a solution. A smaller or more heavily quantized model
is acceptable. The prompt must make choosing and calling the right tool
EASY, rather than depending on the model being clever. Read `CLAUDE.md`
"What this product is FOR" — reach is a feature.

## Objective

Cut the fixed per-turn cost so an 8K-12K window holds a working
conversation, using the four levers the owner approved 2026-09-15:

1. **Split the rules block per tool.** Each phrase list lives with the
   tool it routes to.
2. **Route.** Pick the few tools relevant to this turn; render only their
   docs and their rules. The owner's sketch: "a list of keywords that
   connects back into the tools, or however you would design that".
   Evaluate that against the alternatives and choose with reasons.
3. **KV-cache quantization (§13b).** Roughly halves the memory a window
   costs. Specify the measurement.
4. **Shorter tool results.** A result governor — the memory-layer build
   prompt already designs one (threshold, digest + handle).

## §16e is REOPENED, and why

§16e and REFINED §6 concluded routing moves the context floor exactly one
rung (16,384 -> 12,288) and never reaches 8K, because the rules block names
57 tools and must be rendered whole. That conclusion is correct **only if
the rules stay one indivisible block.** The owner decided 2026-09-15 to
split them. Re-derive the bound under that decision and show the numbers.

Keep everything §16e got right. Do not relearn it:

- Closure: a rendered rule must never name a tool that is not rendered.
- The response schema's `enum` — narrow (a wrong route makes the right
  tool un-emittable) vs wide (a hidden tool still runs, grounded errors
  recover). Choose and say why.
- Per-round extension: a tool named in round N's RESULTS joins round N+1's
  set, by string match, no model call. That redirect lever closed row 35.
- The router is an opt on `buildSystemPrompt` / `promptModeFor`, mirrored
  as a `chat-probe` flag, or the verifying instrument cannot see it.
- It needs its OWN CI ceilings, or the existing ratchet goes slack the
  moment routed prompts sit far under `COMPACT_CEILING`.

## Questions the design must answer, each with a reason

- **Routing mechanism.** Lexical keyword/phrase index per tool (no model
  call, deterministic, testable); a tiny router call over a one-line index;
  embeddings (needs another model and VRAM — likely wrong here, say why);
  or a hybrid.
- **Recovering from a miss.** When routing leaves out the tool the user
  needed: an always-on core set, a `find_tools`-style meta-tool the model
  can call, per-round extension, or a combination. Price each in tokens.
- **The core set:** what is always rendered, and how big it is.
- **Decomposing the rules:** walk the real rules block. Which rules belong
  to exactly one tool, which genuinely span several, and what happens to
  those.
- **Order sensitivity:** §16e records the rules block as measured
  order-sensitive. How does routed rendering preserve that, or how is it
  re-measured.
- **Prompt caching:** a per-turn tool set changes the prompt prefix and
  defeats `cache_prompt`. Price the re-prefill against the tokens saved.
- **Result governor:** threshold, digest shape, handle retrieval, and
  which tools' results are the worst offenders today.
- **KV quantization:** K and V types per model size, and what accuracy
  check gates it.
- **Budgets per tier:** for each hardware tier, the window it gets and the
  conversation room left — today, and after each lever.

## Measurement plan — overnight only

Specify, do not run:

- The §8 paraphrase matrix through `chat-probe`, routed vs all. **Tool
  choice accuracy must not drop.** Define the pass bar.
- New and updated ceilings in `tests/test-context-budget.js`.
- `context-budget-probe.js` for any prompt-order change.
- §13b: llama-server VRAM at each window size, fp16 vs quantized KV, via a
  standalone launcher.

## Constraints

- Daytime rule (CLAUDE.md): no After Effects, no backend, no full test
  suite, no GPU probe, no downloads. One pure `node tests/test-*.js` file
  is acceptable if you genuinely need a number.
- No dependencies. Context is a functional resource.
- Grounded errors must keep working — they are how the small model
  self-corrects, and routing must not remove what they point at.

## Out of scope

- Implementing any of it.
- Choosing a different chat model.
- The §22 install architecture, Premiere, and the generation side.

## Deliverable

`docs/proposals/prompt-routing-DESIGN.md`: the chosen design with reasons,
the re-derived bound, before/after budgets per tier, and the overnight
measurement plan. File the work it implies as sub-items of WORKPLAN §24,
appended to that section — do NOT reorder NEXT UP.
