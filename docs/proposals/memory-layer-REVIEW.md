# Memory & planning layer — confirmation pass

**Status: NOT STARTED. Do not build.** Owner-gated pending a Fable 5.1
review (next week, credits permitting). This document is the
confirmation pass the build prompt itself asks for:

> "Confirm each of these against the current code before building."
> — `memory-layer-BUILD-PROMPT.md`, Integration points

The original prompt is preserved verbatim at
`docs/proposals/memory-layer-BUILD-PROMPT.md` so a second reviewer sees
the same artifact this pass reviewed, not a version already edited by
its findings.

---

## 0. First: this is a DIFFERENT memory system from `docs/MEMORY.md`

Easy to conflate, and conflating them would be expensive.

| | `docs/MEMORY.md` (built 2026-09-05) | This proposal |
|---|---|---|
| Whose memory | The **development loop's** | The **product's** |
| Consumer | An unattended `claude -p` pass | The panel's local 32B model |
| Remembers | What earlier passes did to this repo | What the USER wants, across projects |
| Lives in | The repo, git-tracked | Beside the `.aep`, and `%APPDATA%` |
| Ships | No | **Yes — this is product surface** |

They share principles (routing table, dated records, edit-in-place, no
embeddings first) because both are the same problem shape. They share no
code and should not.

---

## 1. Stale premises in the prompt's Context section

Every number in it has drifted. Correct before handing it to any
reviewer, because a reviewer reasoning from "77 tools, 533 steps" is
reasoning about a smaller system than the one that exists.

| Prompt says | Actual (2026-09-05) | Source |
|---|---|---|
| v0.11.0 | **0.11.37** | `extension/js/version.js` |
| ~77 tools | **79** | `docs/CAPABILITIES.md` (generated) |
| 533-step self-test | **770/770** | last three green runs in the log |
| Qwen2.5-32B, auto-sized | *unconfirmed* | no model name in `tiers.js`; the catalog is served by the hosted manifest, so the shipped default is not in the repo |

### The one that is not just a number

> "Nothing leaves the machine. **No network calls**, no cloud services,
> no telemetry. This is a hard product constraint and a selling point."

**False as written**, and it is the sentence most likely to end up in
marketing. `extension/js/setup.js` makes real outbound requests:
`fetchJson` (the hosted `update.json` manifest) and `downloadToFile`
(llama.cpp builds, GGUF models, the portable ComfyUI, ffmpeg, whisper).
Section 13a would add wheel downloads to that list.

The defensible claim, which is still a strong one:

> **No user content ever leaves the machine.** No project data, no
> prompts, no generated media, no telemetry. The only outbound traffic
> is first-run installs and update checks, and the panel works offline
> once installed.

Worth fixing in the prompt before review: a reviewer who accepts "no
network calls" will design storage and failure handling around a
constraint the product does not have, and may flag the download paths
as violations of the spec.

---

## 2. Integration points — confirmed one by one

The prompt names five. Three exist as described. Two do not.

### IP1 — system prompt assembly ✅ EXISTS
`Tools.buildSystemPrompt(projectStateJson, opts)` —
`extension/js/tools.js:697`. Already takes an options object and already
has a compact/full split (`opts.compact`, chosen by
`ctx < 24576`). The resident index would be injected here.

**Constraint the prompt does not mention:** the prompt is
ratchet-tested. `tests/test-context-budget.js` holds an absolute ceiling
on BOTH forms — full ≤ 59,000 chars (currently 58,933) and compact ≤
40,000 (currently 39,803). **There is ~67 chars of headroom in the full
form.** A 400–800 token resident index is 1,600–3,200 characters, so it
cannot simply be added; it must be paid for by a cut of equal size in
the same form, or the ceilings must be deliberately raised with a
reason. This is the single hardest constraint in the whole proposal and
the prompt does not know about it.

### IP2 — tool results into the message array ✅ EXISTS
`extension/js/main.js:252` declares `history`; results are pushed at
`main.js:748`; the request is assembled at `main.js:643`. The governor
from principle 2 goes immediately before that push.

### IP3 — the turn loop ✅ EXISTS
`Tools.executeCommands(commands, opts, onEach, done)` —
`tools.js:3086`. Capped at 6 rounds per user turn (`maxRounds`, default
in `settings.js`). Plan read before the model call, plan update after
results resolve, as the prompt says.

### IP4 — panel init and project-change events ❌ **DOES NOT EXIST**

This is the blocker, and it is bigger than the prompt implies.

- **No project-change event.** Every `addEventListener` in `main.js` is
  a DOM/UI event. There is no CEP host-event listener at all, and AE
  does not fire a CEP event on project open/close that the panel is
  currently subscribed to.
- **Nothing anywhere reads `app.project.file`.** Grepped
  `hostscript.jsx`: the panel does not know which `.aep` is open, has
  never needed to, and has no tool that reports it.

The storage layout is built on an anchor that does not exist:

```
<AE project dir>/.aellama/     <-- the panel cannot currently locate this
```

Not fatal — a host tool returning `app.project.file.fsName` (null when
unsaved) is small. But it must be **step 0**, before the memory store,
and it brings two design questions the prompt has not answered:

1. **Detection without an event.** If there is no reliable
   project-changed event, the scope must be re-derived by polling
   `app.project.file` (every turn is the obvious hook — it is one cheap
   `evalScript`), or by checking it at the start of every turn and
   re-binding on change. Poll-at-turn-start is probably right, and it is
   a design decision that needs writing down rather than discovering.
2. **The unsaved project is the COMMON case, not an edge case.** The
   prompt treats "unsaved or read-only" as a fallback. But this repo's
   own harness has spent weeks working in exactly that state — AE's
   cold-launch project is `Untitled Project.aep` with no path, and the
   self-test never saves. A user who opens AE and starts talking to the
   panel has no project file either. So the APPDATA-keyed-on-hash
   fallback is not the edge, it is the first-run path, and "hash of
   what?" needs an answer when there is no file to hash.

### IP5 — the VRAM arbiter ⚠️ EXISTS, DIFFERENTLY THAN DESCRIBED

`tiers.js` has `resolveTier`, `recommendChat`, `recommendGen` — these
are **pure recommendation functions**, not a live gate. The live part is
in `comfy.js`: `comfyPauseLlm` (`"auto" | "always" | "never"`, default
`auto`) and a free-memory call (`{unload_models: true, free_memory:
true}`) with a resume path.

So the prompt's instruction — "compaction and summarization are model
calls, so they need to go through the same arbiter" — is right in intent
but there is no single arbiter object to route through. The real
requirement is sharper: **a compaction call must not be issued while the
LLM is paused for a generation**, or it will hang or fail against a
server whose model has been unloaded. That is a sequencing constraint,
and where it belongs is the resume path at `comfy.js:1672`.

---

## 3. Section E (Compaction) replaces something that already exists

The prompt reads as though nothing manages context today. Something
does:

- `Tools.historyBudget(ctxSize, systemChars)` computes the history
  allowance from the real prompt size, with a reply reserve and a ledger
  budget, and reports `starved`.
- `main.js:615` already trims and shows a one-time notice
  (`trimNoticeShown`) — the measured string is
  `context trimmed — N earlier message(s) dropped`.

So compaction is not new machinery beside the old; it is a **replacement
of drop-oldest with summarize-oldest**, and it inherits an existing,
tested budget calculation. The prompt's "trigger at 65%" should be
expressed in terms of `historyBudget()` rather than a new percentage,
or there will be two disagreeing notions of "full".

Also worth keeping from the current behaviour: the trim notice is
**visible to the user**. Whatever replaces it should stay visible —
silent compaction is the failure mode this repo has spent weeks removing
everywhere else.

---

## 4. What the prompt gets right, and should not be relitigated

Recording this so a reviewer does not spend its effort re-deriving it:

- **Memory stores intent, never live state.** Correct, and it is the
  single most important line in the document. This panel's worst failure
  mode is confident action on stale structure, and it has shipped that
  bug repeatedly in other forms (`trackMatteType` read as existence,
  `remainingMasks` read as visibility). A memory that caches comp
  structure would reintroduce it at the worst possible layer.
- **Edit in place, dated records, never append-only.** Confirmed the
  hard way at repo level: `WORKPLAN-LOG.md` is append-only, holds 37
  announced corrections interleaved with what they overturn, and that is
  precisely why `docs/MEMORY.md` had to be built.
- **No embeddings for v1.** Correct twice over — vocabulary is small and
  consistent, and an embedding model competes for the VRAM `tiers.js` is
  already arbitrating.
- **Controlled topic vocabulary.** Correct. An uncontrolled one makes
  the resident index useless, which is the same failure as an unbounded
  manifest.
- **Headless first, driven by a fixture.** Correct, and it matches how
  everything here is verified. "Memory failures are silent, you get a
  fluent wrong answer with no exception to catch" is the right reason.
- **Plans on disk surviving restarts.** Correct for CEP specifically.

---

## 5. Gaps to close before building

Ordered by how much they would cost if discovered mid-build.

1. **Prompt budget (IP1).** ~67 chars of headroom in the full form. Where
   does a 400–800 token resident index come from? Either a named cut of
   equal size, or a deliberate ceiling raise with the reasoning written
   down. Unanswered, this stops the work at step 3 of 7.
2. **Project identity (IP4).** A host tool for `app.project.file`,
   turn-start re-binding, and a real answer for the unsaved project —
   which is the common case here, not the edge.
3. **Compaction vs the existing trim (§3).** One notion of "full", not
   two. Express the trigger in `historyBudget()` terms.
4. **Arbiter sequencing (IP5).** No single arbiter to route through; the
   requirement is "never issue a model call while the LLM is unloaded
   for a generation", and it belongs on the resume path.
5. **Governor threshold.** The prompt says "start at 500 tokens". Nothing
   in the repo measures actual tool-return sizes, so that number is a
   guess. `get_comp_details` and `list_properties` on a real comp are
   the ones to measure first — one cheap real-AE run answers it, and
   this repo does not ship guessed constants.
6. **Interaction with §13b.** If KV-cache quantization lands and the
   default context rises, `ctx < 24576` flips the prompt to its full
   form and every budget in this proposal changes. These two sections
   need to know about each other.

---

## 6. For the Fable 5.1 review

Give it the **original** prompt (`memory-layer-BUILD-PROMPT.md`) plus
this file, and ask it to attack rather than agree. The questions worth
its credits — the ones where a second opinion actually changes the
build:

1. Is the **sidecar `.aellama/` directory beside the `.aep`** right, given
   that the unsaved project is the common case and AE users routinely
   move, duplicate and version projects? Argue the APPDATA-primary,
   sidecar-optional inversion.
2. **Where does the resident index's 400–800 tokens come from**, against
   a prompt with 67 chars of headroom and a CI ratchet on both forms?
   This is the constraint most likely to sink the design.
3. Is **markdown + YAML frontmatter + a parallel SQLite FTS index** two
   sources of truth? What reconciles them when a user hand-edits
   `memory.md`, which the design explicitly invites?
4. **Is a controlled 7-topic vocabulary too coarse** to hold "lower
   thirds in Power Centra Bold with a 12 frame ease" usefully, and does
   `recall(scope, topic)` returning a whole topic blow the budget the
   governor exists to protect?
5. The plan file says **"never silently skip a step"** — what does the
   loop do when a step becomes impossible mid-job (the comp it targets
   was deleted)? Stop-and-ask is stated, but the panel is a chat UI with
   a 6-round cap, so "ask" has a concrete cost.
6. **What is the first thing a user notices?** The commercial claim is
   "it learns how you work and stops asking". Which single memory,
   remembered on session two, demonstrates that? Build that path first
   and the rest can follow it.

Ask it to name anything in §4 it thinks is wrong — the list of things
not to relitigate is itself a claim, and it deserves attack too.
