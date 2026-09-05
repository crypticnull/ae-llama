> **SUPERSEDED 2026-09-05 by `memory-layer-REFINED.md`.** Kept as the
> record of the synthesised prompt block that was reviewed. Four claims in this
> document are now known to be wrong — REFINED §0 lists them. Do not
> build from this file.

# Memory & planning system prompt — synthesis with the existing prompt

**Status: proposal. Not built, not injected.** Companion to
`memory-layer-REVIEW.md`; both are gated behind WORKPLAN §15.

The source draft (`aellamamemorysystemprompt.md`, quoted below where it
matters) is good writing and its instincts match this repo's. But it was
written without three things the panel's prompt already knows, and each
changes the block:

1. an exact, CI-enforced byte budget,
2. measured facts about how *this* 32B reads *this* prompt,
3. rules already in the prompt that the draft restates.

This document is the reconciliation.

---

## 1. The budget, measured

| | chars |
|---|---|
| Full prompt now | 58,933 / **59,000 ceiling** → 67 spare |
| Compact prompt now | 39,803 / **40,000 ceiling** → 197 spare |
| Rules block | 19,043 — **byte-identical in both forms** |
| Tool docs | 39,890 full · 20,760 compact |

The draft budgets itself at "roughly 600 tokens" ≈ 2,400 chars:

```
full    58,933 + 2,400 = 61,333   over by 2,333
compact 39,803 + 2,400 = 42,203   over by 2,203
```

### The trap that is not obvious

A memory block is a *rules* block addition, and **compact mode never
touches the rules block** (asserted in `tests/test-context-budget.js`).
So it costs its full size in the prompt a default 16K user actually
gets.

Meanwhile every previous prompt addition here has been paid for by
cutting tool-doc **second sentences** — which compact already discards.
Those cuts satisfy the full-form ratchet and hand the 16K user back
nothing. That asymmetry is why `COMPACT_CEILING` was added on
2026-09-05; this proposal is the first thing it will bind.

**Consequence:** the bytes for this block cannot come from where the last
several passes took them.

---

## 2. Placement — the draft has it backwards for this prompt

> "**Placement:** after the tool definitions, before the resident memory
> index."

The panel's prompt is ordered **preamble → `Rules:` → `Available
tools:` → project state**. There is nothing after the tool definitions
except state, so "after the tool definitions" would put memory rules
19,000 characters away from every other rule, immediately behind 79 tool
descriptions.

Two measured findings say that is the wrong place:

- **0.11.25 (row 35).** A routing clause was in the prompt *verbatim* and
  the model still ignored it, because it sat inside a bullet whose first
  line named a different tool. Conclusion recorded at the time: *a model
  reading a bullet stops at the first tool the bullet names.* Position
  relative to other rules is load-bearing, not cosmetic.
- **0.11.30 (row 36).** Naming a tool in the *route* of a scope rule read
  as permission to use it — the model began inventing settings. Tool
  names inside rules change behaviour by their presence.

**So: the memory rules belong in the `Rules:` block, with the other
rules**, and the resident index goes after `Available tools:` where the
project state already goes — index and state are both *data the model
looks things up in*, and they should sit together.

---

## 3. Two of the draft's sections already exist in the prompt

Restating them costs bytes twice and risks the model treating a repeated
rule as a different rule.

**"Never recall what you can ask"** — the prompt already carries:

> `- Prefer inspecting (get_project_info / get_comp_details) before`
> `  modifying things you have not seen.`

The memory rule should *extend* that ("…see the inspect-first rule
above"), not re-derive it.

**"Stay quiet about mechanics"** — already covered by:

> `- Keep 'reply' to one or two short sentences. The TOOL RESULTS are`
> `  the record: never restate them, never narrate each step. Every`
> `  word you write shares the context window with the work.`

This needs four words appended to that bullet, not its own section. And
that placement is better than the draft's: the draft ends its block with
"Make the call and carry on", and **the last clause of a rule is an
instruction to this model** (0.11.24 — a refusal ending "…add_mask
creates one" made the model create a mask). Ending the memory block on
a *do-nothing* instruction wastes the position that matters most.

---

## 4. The synthesised block — 1,499 chars, ~375 tokens

37% smaller than the draft, with nothing dropped that testing would
miss. Phrase lists kept, because they are how routing works here
("rules carry phrase lists, docs carry one phrase" — `CLAUDE.md`).

```
- MEMORY holds what the user WANTS; the PROJECT holds what IS. Names,
  sizes, counts, order, properties, keyframes, effects and render
  settings are QUERIED, never recalled (see the inspect-first rule
  above). When memory and the project disagree the project is right —
  update the record.
- remember {scope, topic, content} when the user says 'I always' / 'we
  use' / 'never' / 'from now on', corrects you in a way that will apply
  again, or names a convention: font, size, naming, timing, structure.
  scope 'global' when it holds across projects, 'project' when only
  here. One test before writing: still true next week, on a different
  comp? If no, do not write it — a one-off is not a preference. Saying
  you will remember is not remembering; the call is the memory.
- New information contradicting a record you hold: update that record.
  Never a second one.
- The index below is every topic you hold. recall a relevant topic
  before asking the user for it; search when the index gives no lead.
- A PLAN exists for any job over ~5 calls. Each turn: read it, do the
  next unchecked step, check it off, save. Never skip a step, never
  redo a checked one. On a failure write what happened under Notes and
  either revise the remaining steps or stop and ask. Resume a plan you
  find; never start it over. Delete it when the goal is met or the user
  changes direction.
- A result given as a digest with a handle: expand it only for detail
  you actually need and do not already have.
```

Plus, appended to the existing reply-brevity bullet:

```
  …never narrate each step — including memory and plan calls; make them
  and carry on.
```

**What changed and why:**

| Draft | Here | Reason |
|---|---|---|
| "Never recall what you can ask" section | one bullet citing the existing rule | already in the prompt |
| "Stay quiet about mechanics" section | four words on an existing bullet | already in the prompt; and a block should not *end* on a prohibition |
| "Do not write:" list of three | one durability test | the draft's own tuning note says long prohibition lists make a 32B cautious across the board; the repo measured the same in 0.11.30 |
| Headings (`### When to write`) | flat bullets | the rest of the block is flat bullets; a heading mid-list is a new format for the model to parse |

---

## 5. The remaining bill, and three honest ways to pay it

Even at 1,499 chars:

```
full    58,933 + 1,499 = 60,432   still over by 1,432
compact 39,803 + 1,499 = 41,302   still over by 1,302
```

**Option A — genuine deletion (~1,450 chars).** The rules block is 69
bullets / 18,723 chars, and the largest is `comfy_generate` at **691
chars** — that is tool documentation living in the rules block. Moving
tool-specific prose from rules into its tool's doc helps *compact* (the
doc's later sentences get dropped there) but **not full**, where it just
moves. So full still needs a real cut. Candidates exist; none is
verified, and none should be taken on reasoning — see §6.

**Option B — raise both ceilings, deliberately, and re-pin.** The
ceilings are self-imposed ratchets in a test file, not technical limits.
They exist to force pay-as-you-go on *incremental* additions. A whole new
capability is not an incremental addition, and refusing it because a
discipline device says no is the tail wagging the dog. The honest form:
measure whether the panel routes *better* with the block than without,
and if so raise the ceiling to the new measured value and re-pin. What
must not happen is raising it quietly.

**Option C — inject only when memory exists.** The block is dead weight
for a user with an empty store. Injecting it only when the store is
non-empty costs nothing on first run, and the byte pressure arrives only
once the feature is earning something.
*But* it creates a bootstrap problem: with no rules, the model never
writes the first memory, so the store stays empty forever. A workable
shape is a two-line seed always present (write-trigger + the durability
test) with the full block appearing once there is something to recall.
Untested, and it is the option most likely to be wrong in an interesting
way — worth putting to the independent review.

**Recommendation:** A and B together — take the deletions that measure
clean, then raise the ceiling by whatever remains and record the number
with its justification. C is a real idea but adds a conditional prompt
shape, and this prompt has never had one.

---

## 6. Verification — the draft's failure modes are already matrix rows

The draft lists eight failure modes. Seven map onto the instrument this
repo already has: `scripts/chat-probe.js --variants`, which puts four
phrasings of a real request in front of the actual local model and
grades pass / miss / HARM. **Routing and prompt-following cannot be seen
any other way** — no stub can, because the decision happens before any
tool runs, and `selftest.js` drives host tools with no model in the loop.

| Draft failure mode | How it is caught |
|---|---|
| Acts on recalled structure that changed | matrix row that mutates the project between turns; **this is the HARM-grade one** |
| Says "I'll remember" without calling `remember` | assert the tool call in the transcript, never the reply text |
| Writes a one-off as a standing preference | matrix row with "make this one blue"; a `remember` call is the failure |
| Asks for something already in memory | seeded store + a row whose answer is in it |
| Forgets to check off a step, repeats it | plan-file fixture across two turns |
| Starts over after a context reset | kill and resume mid-plan |
| Expands every handle, runs out of context | governor fixture with an oversized return |
| Stacks a contradicting record | two writes to one topic, assert one record |

The last is the only one a stub can prove alone, and it should be a stub
test — it is a store invariant, not a model behaviour.

**One caution from this repo's own history:** a prompt change that does
not move the real-AE harness number is *not* evidence of nothing. On
2026-09-03 a routing fix left the harness at 653/653 and closed a HARM
row in the field, and the log recorded that as the honest result. The
matrix is the instrument here; the harness is the safety net.

---

## 7. Open for the independent review

Beyond the six questions in `memory-layer-REVIEW.md`:

7. **Is 375 tokens still too much?** It is permanent, on every turn, in
   the form a 16K user gets. What is the smallest block that still
   produces the write behaviour — is the durability test alone enough,
   with the rest learned from tool descriptions?
8. **Option C's bootstrap.** Does a two-line seed actually produce a
   first write, or does a 32B need the whole block to start?
9. **Does the phrase list generalise?** `'I always' / 'we use' / 'never'
   / 'from now on'` is four phrases. Every routing bullet in this prompt
   has needed its phrase list widened at least once after field
   measurement. Which phrasings are missing?
10. **Is "the project is right, update the record" safe?** It instructs
    the model to *write* on a disagreement it detected itself. That is
    a write path triggered by inference rather than by the user, and it
    is the one rule here that could corrupt a store rather than merely
    fail to use it.
