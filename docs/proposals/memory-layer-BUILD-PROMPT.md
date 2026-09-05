# Build prompt: AE Llama memory and planning layer

Paste this into a Claude session scoped to the plugin repo.

---

## Context

You are working on AE Llama, a commercial After Effects CEP panel. Current state:

- Windows only, After Effects 2024+, currently v0.11.0
- A local llama.cpp model (Qwen2.5-32B, auto-sized to available VRAM) drives AE through JSON tool-calling across roughly 77 tools
- Nothing leaves the machine. No network calls, no cloud services, no telemetry. This is a hard product constraint and a selling point.
- There is an existing 533-step self-test suite and a VRAM tier system with a live arbiter
- Effective working context is small. Assume 16k and design so the system degrades gracefully rather than assuming headroom.

## Objective

Add a memory and planning layer so the panel holds user intent across a session, learns the user's conventions across projects, and can carry multi-step jobs to completion without losing the thread.

Do not start writing code until you have read the existing tool-call loop and system prompt assembly, and confirmed the integration points named at the bottom of this document.

## Non-negotiable principles

These are the design decisions. Do not relitigate them, implement them.

**1. Memory stores intent and decisions. Never live state.**

AE project state is queryable at any moment through existing tools. Anything the panel can ask AE about, it must ask, not recall. Memory holds things like "user wants lower thirds in Power Centra Bold with a 12 frame ease" and never things like "comp 3 has fourteen layers." Storing state produces confident action on stale structure, which is the worst failure mode this panel can have.

If you find yourself writing a memory record that duplicates something a tool returns, delete it and call the tool instead.

**2. Tool results are the primary context consumer, not conversation.**

Seventy-seven tools, and a layer dump on a busy comp is thousands of tokens. Three verbose returns exhaust the window. Two mitigations, implement both:

- Every tool gets a compact default return shape. Add an explicit expansion tool that fetches full detail for a named entity on request.
- A governor sits between tool return and context insertion. Anything over a threshold (start at 500 tokens) is summarized to a digest plus a handle, with the full payload kept in the session store and retrievable by handle.

**3. Plans live on disk, not in context.**

A multi-step job like "build a lower third package" is dozens of tool calls. The model writes an explicit plan file, then executes against it, re-reading and updating it each turn. The plan surviving on disk means it also survives panel restarts, AE crashes and context resets, which are frequent in CEP.

**4. Two memory scopes, different lifetimes.**

- Project memory, keyed to the .aep, holds what the user wants in this project
- Global memory holds the user's standing conventions across all projects: naming, fonts, easing defaults, structural habits

Global memory is the commercially interesting half. A panel that learns how someone works and stops asking is a real differentiator, and it is only credible because everything is local.

**5. Memory is dated and edited in place, never append-only.**

Append-only stores accumulate contradictions, the model reads both versions, and reliability drops below having no memory at all. Every record carries a written date. Updates replace the prior record rather than stacking underneath it.

## Storage layout

```
<AE project dir>/.aellama/
  memory.md          project memory, markdown + YAML frontmatter
  plan.md            active plan, absent when no job is running
  session.sqlite     raw turn log, tool payloads, handles

%APPDATA%/AELlama/
  global-memory.md   user conventions across all projects
  index.md           manifest of all known project memories
  memory.sqlite      FTS5 index over all memory records
```

Sidecar directory next to the .aep so memory travels with the project when it is moved or handed off. Handle the case where the project is unsaved or on a read-only volume by falling back to the APPDATA location keyed on a project hash.

## Components

### A. Memory store

A small module with a narrow API. Do not let callers write arbitrary text.

```
remember(scope, topic, content)        scope is "project" | "global"
update(scope, topic, content)          replaces the record for that topic
forget(scope, topic)
recall(scope, topic)                   single record
search(query, scope, limit)            FTS5 across records
list_topics(scope)                     for the resident index
```

Records are markdown lines under a topic heading, each prefixed with its written date. Topics are a controlled vocabulary, not free-form. Start with: naming, typography, timing, structure, colour, workflow, project-intent. Adding a topic is a code change, deliberately, because uncontrolled topics make the index useless within a week.

### B. Resident index

A compact manifest injected into every system prompt: topic names, one-line descriptions, record counts, last-written dates. Budget it at 400 to 800 tokens. This is the model's map. Without it the model does not know what it does not know, answers from the window, and never realises the answer was on disk.

When the manifest outgrows its budget, group by scope and summarize per topic rather than letting it sprawl.

### C. Retrieval

Layered, in this order:

1. Resident index, always present
2. Explicit `recall` calls the model makes against topics it sees in the index
3. FTS5 keyword search for anything not covered

Do not build embedding retrieval for v1. The vocabulary here is small and consistent, keyword search will outperform vectors at a fraction of the complexity, and adding an embedding model competes for the VRAM the arbiter is already managing.

### D. Plan file

Markdown with checkboxes. Written by the model at the start of any job it judges to need more than roughly five tool calls.

```markdown
# Goal
One sentence, in the user's words.

## Constraints
- Written from memory and from what the user said this session

## Steps
- [x] 1. Create the comp at 1920x1080, 30fps
- [ ] 2. Build the text layer, Power Centra Bold 48px
- [ ] 3. ...

## Notes
Anything discovered mid-job that changes later steps.
```

Loop behaviour: read plan at turn start, execute the next unchecked step, update the file, repeat. When a step fails, record the failure in Notes and either revise the remaining steps or stop and ask. The model must never silently skip a step.

Delete the plan when the goal is met, or when the user changes direction. A stale plan is worse than none.

### E. Compaction

Trigger at 65% of the context budget, not 95%. You need room for the summarization call and the following response.

Compact the oldest turns, not everything. Produce a structured block, not prose: goal, decisions made, facts established, open questions. Prose summaries compound loss and the model starts inventing continuity.

Never summarize a summary. When re-compacting, re-derive from the raw turn log in session.sqlite. Anything the user stated explicitly is pinned and never eligible for lossy rewrite.

### F. Write path

Memory writes are explicit tool calls the model makes, not a side effect of compaction. Give the model `remember` and `update` as real tools and prompt it on when to use them. Dumping every rolling summary into memory produces an archive nobody can navigate.

## Integration points

Confirm each of these against the current code before building:

1. Where the system prompt is assembled. The resident index and global memory both need to be injected here.
2. Where tool results are appended to the message array. The governor from principle 2 goes in front of this.
3. The turn loop. Plan read happens before the model call, plan update after the tool results resolve.
4. Panel init and project-change events. Memory scope must re-bind when the user opens a different .aep.
5. The VRAM arbiter. Compaction and summarization are model calls, so they need to go through the same arbiter rather than around it.

## Constraints

- No network. Everything runs against the local llama.cpp server.
- Node/CEP on the panel side, ExtendScript for anything touching the AE DOM. Keep memory logic entirely on the Node side.
- Windows paths. Handle spaces, long paths, and UNC.
- Must remain correct at 16k context. Test at that budget even if more is available.
- Do not add a dependency that pulls a native binary without flagging it first.

## Testing

Extend the existing self-test suite. Minimum coverage:

- Memory survives a panel restart
- Memory re-binds correctly when the project changes
- A plan resumes correctly after a simulated crash mid-job
- The governor truncates a large tool return and the handle retrieves the full payload
- Compaction at 16k preserves pinned user statements verbatim
- Contradictory writes to the same topic result in one record, not two
- A project on a read-only volume falls back without erroring

Build this headless first, driven by a script against a fixture project, before wiring it to the panel UI. Memory failures are silent, you get a fluent wrong answer with no exception to catch, so a harness is the only way to see regressions.

## Out of scope for v1

- Embeddings and vector search
- Any cloud service
- Cross-user or shared memory
- Memory UI beyond a simple view and clear control

## Order of work

1. Memory store module and its tests, headless
2. FTS index and retrieval
3. Resident index and system prompt injection
4. Tool result governor
5. Plan file and loop integration
6. Compaction
7. Panel UI surface

Stop after step 1 and show me the API and the record format before continuing.
