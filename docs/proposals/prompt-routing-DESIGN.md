# Prompt routing — the design (WORKPLAN §24)

Written 2026-09-15 by a daytime design pass under the rule in CLAUDE.md
("the machine belongs to the owner during the day"): nothing here was
run against After Effects, a backend, a llama-server or the GPU. Every
number is either (a) read out of the repo, (b) computed by a pure string
script over the real `tools.js` strings (`buildSystemPrompt` loaded in
the same stub window `tests/test-context-budget.js` uses), or (c) an
estimate, marked **est.** with how it was made. Brief:
`docs/proposals/prompt-routing-BUILD-PROMPT.md`. Work items: WORKPLAN
§24a-§24j.

Token counts use the panel's own pinned constant, 3.7 chars/token for
prompt text (`PROMPT_CHARS_PER_TOKEN`, measured 3.72 on the Qwen2.5
tokenizer 2026-09-02) and 2.7 chars/token for history. They are
estimates of the same kind the panel budgets with; `context-budget-probe`
is the instrument that turns them into measurements (§14).

---

## 0. The answer in one screen

**Chosen mechanism: a lexical trigger index per tool, deterministic, no
model call, that falls back to today's whole prompt when nothing
matches.** The owner's sketch ("a list of keywords that connects back
into the tools") is the right one, because the phrase lists already
exist — they are the rules block — and the repo's entire routing lever
for the last two weeks has been *adding a phrase to a measured place*.
A router whose misses are fixed the same way is the only one the
paraphrase matrix can verify.

**The rules decompose cleanly.** By name-mention (a regex over the
72 rule bullets): 20 name no tool, 18 name exactly one, 34 name
several. By *ownership* after walking them (§4): **21 are always-on
behaviour, 28 have exactly one owner, 22 have several owners, and 1 is
a phrase-triggered behaviour with no owner** ("clean up this COMP:
ask"). The gap between the two counts is anti-targets — a bullet that
names three tools usually tells the model to call one and *not* the
other two, and anti-targets do not need rendering.

**The core set is 7,959 chars ≈ 2,150 tokens** (preamble, 21 generic
bullets, 9 always-on tools, and a one-line name index of the other 70)
against today's 39,803 chars ≈ 10,760. A routed prompt runs **8,159 to
13,154 chars (≈ 2,200-3,560 tokens)** on the five example requests
sized in §9, worst case included. **That is a 7,200-8,550-token cut per
turn.**

**The re-derived bound.** With the rules split, the 16K window goes
from **306 chars of conversation (STARVED, the owner's measured case,
state at the 6,000 cap) to 19,754-23,399 chars.** 12,288 holds a working
conversation on every example (8,695-12,340 chars). **8,192 does NOT
hold one under the four approved levers alone**: the routed prompt is
small enough, but the fixed 3,328-token reply reserve is 41% of an 8K
window, and with state at cap every example starves. **It does hold one
once the reply reserve scales with the window** (max_tokens 1,024 at
8K, the compact-retry path already handling truncation): 3,165-6,810
chars at state-cap, 5,584-9,229 on the probe's real state. So the honest
floor after §24 is **12K comfortable, 8K working with lever 5**, and
lever 5 is a budget-arithmetic change, not a wording one (§9).

**Miss recovery** is four cheap layers, none of them a model call:
fall-back-to-all when nothing matches (so routing can never be *less*
accurate than today on an unmatched sentence), a sticky set (tools used
in the last three assistant turns), per-round extension (tools the model
called or that round N's results named join round N+1), and the name
index itself (an un-rendered tool can still be called; the host's
grounded error answers, and the tool is rendered next round). A
`describe_tools` meta-tool is priced and *not* built in v1 (§6).

**Schema enum stays wide.** With every name in the index line, the
grammar and the prompt agree; a narrow enum would make a router miss
un-emittable inside the turn.

**Order is preserved, not re-measured:** a routed prompt renders its
subset of bullets in the original relative order, so every measured
pairwise order (row 29, row 35) holds by construction.

**Caching:** routing shrinks the stable cached prefix from ~10.7K tokens
to ~1.3K, so each user turn re-prefills the routed section (+0.7-1.9K
tokens est.) on top of the state and history it already re-prefills.
That is a per-turn cost of well under the tokens it saves from every
subsequent round of the same turn, and `chat-probe` already prints
seconds per round, so the price is measured for free (§8).

**Pass bar (§14):** same night, same model, same rig — routed vs all.
Zero canonical regressions; no HARM on any row that was clean under
all; total misses over the 140 paraphrases at most all + 2; and the
router's own recall over every matrix sentence is a 100% CI test that
needs no model.

---

## 1. What the code does today (measured from source)

`extension/js/tools.js`:

| piece | chars | ≈ tokens | source |
|---|---|---|---|
| preamble (before `Rules:`) | 320 | 87 | script |
| `Rules:` section | 9,013 | 2,436 | script |
| `Universal property access` | 1,068 | 289 | script |
| `Masks & shape content` | 1,758 | 476 | script |
| `Plain-English requests` | 2,123 | 574 | script |
| `Renaming MANY comps` | 662 | 179 | script |
| `Project panel management` | 2,581 | 698 | script |
| `Rigging` | 321 | 87 | script |
| `Expressions` (incl. the comfy bullet) | 1,198 | 324 | script |
| **preamble + rules to `Available tools:`** | **19,043** | **5,147** | script (§16e said 19,060) |
| tool docs, compact (79 lines) | 20,744 | 5,607 | script; avg line 263 |
| tool docs, full | 39,874 | 10,777 | script; avg line 505 |
| of which args lines alone | 13,641 | 3,687 | script |
| **compact prompt, empty state** | **39,803** | **10,758** | `test-context-budget.js` ceiling 40,000 |
| full prompt, empty state | 58,933 | 15,928 | ceiling 59,000 |
| state block cap | 6,000 (+26 header) | ≈1,629 | `STATE_BUDGET` |
| reply reserve | — | 3,328 | `REPLY_RESERVE_TOKENS = 3072 + 256`; `llama.js` `max_tokens: 3072` |
| ledger reserve | 1,500 chars | — | subtracted from history room always |
| results pool per round | 6,000 chars | ≈2,222 at 2.7 | `RESULTS_BUDGET` |

`historyBudget(ctx, systemChars)`: room = ctx − 3,328 − ⌈chars/3.7⌉;
history chars = ⌊room × 2.7⌋ − 1,500; starved below 2,000 chars. The
owner's measured turn (~12,242 prompt tokens) is the compact prompt plus
a state block near its cap: 16,384 − 12,387 − 3,328 = **669 tokens of
room, 306 chars of history, STARVED** — the same row this document's
tables call "state 6000 (cap)".

The rules block names **57 of 79** tools by name (script; matches
§16e). The 22 it never names: `set_solid_color, add_text_animator,
add_solid, add_keyframe, import_file, import_as_layer, snapshot_frame,
add_camera, add_light, add_marker, set_layer_3d, add_to_render_queue,
render_comp, list_render_templates, expose_property, export_mogrt,
render_comp_audio, add_captions, transcribe_to_captions, export_gif,
export_social, comfy_status`.

Four facts the design is built around:

1. `buildSystemPrompt(state, opts)` takes one opt, `compact`, and
   renders every bullet and every tool. `promptModeFor(ctx)` returns
   `{compact: ctx < 24576}` — the trap the brief names.
2. `main.js:639` and `chat-probe.js:619` build `system` **once per user
   turn** and `runRound(system, round+1)` reuses it across tool rounds.
   Per-round extension needs the rebuild; both callers must change in
   step (the probe mirrors `sendMessage` by contract).
3. `executeCommands` accepts any name in `TOOL_NAMES` (`isKnownTool`),
   independent of what the prompt rendered; the schema `enum` is
   `TOOL_NAMES`. So an un-rendered tool already runs today if the model
   names it.
4. `cache_prompt: true` on every request; the stable prefix today is
   preamble + rules + all 79 docs (state and history follow and are
   re-sent every turn, state re-fetched).

---

## 2. Routing mechanism — chosen, and the alternatives

### Chosen: a lexical trigger index, panel-side, deterministic

`Tools.routeFor(text, history, lastResults) → {tools: Set, rules: Set,
matched: bool}`, pure, no I/O, no model:

1. **Normalise** the user's message: lower-case, strip punctuation,
   collapse whitespace, light stemming (trailing `s`/`ed`/`ing` on
   words of five or more letters). Match trigger phrases as whole
   words. Add one bounded fuzzy pass for the matrix's typo'd rows: a
   message word of six or more letters within edit distance 1 of a
   trigger word counts (the trigger vocabulary is a few hundred words,
   a message is a few dozen — trivial).
2. **Score** each tool: +N for an N-word trigger phrase matched
   (multi-word beats single), +10 for its own name typed literally,
   +2 if it appears in the last three assistant turns (the *sticky*
   set — "make them blue instead" has no keywords, its referent does).
3. **Select** every tool with score ≥ 1, capped at 12 by score; union
   the `uses` closure of every rule that will render; union the core
   set. **If nothing scored, `matched: false` and the caller renders
   `route: "all"` — today's prompt, byte for byte.**
4. **Rules** render when any of their `owners` is in the routed set or
   when their own `triggers` fired (§4). Core tools are always
   *available*; their phrase-list rules render only when triggered,
   like any other tool's.

Per-round extension (§6) unions two more sources into round N+1: the
tool names the model **called** in round N (rendered or not) and the
tool names appearing in round N's TOOL RESULTS text (`next:` hints,
"To blur the picture: apply_effect" redirects — 31 distinct tools are
named in redirect-shaped host strings per REFINED §6).

Why this one:

- The triggers already exist and are already measured. Every phrase in
  the rules block was put there by a matrix row, and the mechanism that
  closed rows 17, 19, 23, 29, 30, 35, 36 was "add the phrase the user
  typed, in the place the model reads". A lexical index is that lever
  made explicit: a routing miss is fixed by adding a trigger, in a
  test-pinned array, and the CI recall test (§13) proves the fix
  without a model.
- Deterministic → CI-testable → the ceilings in §13 can be *computed*
  over every known sentence rather than guessed.
- Zero cost at 8-12 GB: no VRAM, no second model, no round trip.
- The fall-back-to-all property gives the accuracy argument a floor: on
  any sentence the router does not understand, the model sees exactly
  what it sees today.

### Rejected: a tiny router call over a one-line index

One extra model round trip per user turn (2-6 s on an 8 GB card, est.
from the seconds-per-round the probe logs today); the router's own
prompt is a 79-line index of ~1.5-2K tokens, i.e. a second prompt to
budget; non-deterministic at temperature 0.7 (§8 measured the same row
HARM in two of three runs), so no CI can pin it; and it asks the small
model to be good at the one thing the owner said it need not be. If it
mis-routes, the main call cannot recover inside the turn. Rejected.

### Rejected: embeddings

Needs a second model (30-500 MB of weights, VRAM or CPU) and a
dependency (brief: none). Scores are not inspectable, so a miss cannot
be fixed by adding a phrase — the only lever this repo has measured.
The matrix's failures were wording and *order* (row 29, row 35), never
vocabulary breadth, which is the one thing embeddings would buy.
Rejected; revisit only if the lexical router's fall-through rate stays
above 10% after two nights of trigger additions.

### Hybrid

The hybrid worth having is lexical + fall-back-to-all, above. Lexical
+ model-call fallback inherits every objection to the model call.

---

## 3. Data model and rendering

**`TOOL_DEFS` entries gain three fields** (data move, no wording
change):

```
{ name, mutating, desc, args,
  triggers: ["blur", "soften", "too sharp", "out of focus", "glow", …],
  rules:    [ruleId, …],        // the bullets this tool OWNS
  uses:     ["list_effects"] }  // tools its rules tell the model to call NOW
```

**Rules move into `RULE_DEFS`**, one entry per bullet, carrying the
original text verbatim, its section, its original index (`order`), and:

```
{ id, section, order, text,
  owners:   ["apply_effect", "add_mask"],   // render if any owner is routed
  uses:     ["apply_effect"],               // closure: docs must render
  triggers: []  }                           // standalone behaviour rules only
```

`core: true` marks the 21 always-on bullets. Anti-targets ("never
add_mask") are plain text and are deliberately not `uses`.

**`buildSystemPrompt(state, opts)`** gains `opts.route`:

- absent → today's output, **byte-identical** (every existing pin in
  `test-context-budget.js` and `test-chat-probe.js` keeps passing);
- `"all"` → the same;
- `{tools, rules}` → the routed form.

**`promptModeFor(ctx)` returns `{compact: ctx < 24576, routed: true}`**;
`routed` is a separate axis, so a bigger window gets *full descriptions
for the routed tools*, never 79 tools back. That closes the brief's
trap. A settings key `promptRouting: "auto" | "all"` is the escape hatch
(default auto), mirrored as `chat-probe --route auto|all`.

**Render order — identical to today's, filtered:** preamble → `Rules:`
→ every core bullet and routed bullet **in original `order`**, section
headers kept whenever a section has a bullet → `Available tools:` →
core tools and routed tools in `TOOL_DEFS` order → **one index line**
`Other tools (call one and the host explains its args): a, b, c, …`
listing every un-rendered name (1,195 chars for 70 names) → extension
tools appended *after* the routed set (so within-turn growth does not
disturb the prefix) → ledger → state.

The index line is what keeps "Use ONLY the tools listed below" true
without a wording change, keeps the wide `enum` honest, and is the
cheapest possible miss recovery (≈ 320 tokens for all 70 names).

**Schema `enum`: wide, all 79.** The index lists every name, so grammar
and prompt agree. Narrow would make a router miss un-emittable for the
rest of the turn, and a per-turn grammar buys nothing the wide one plus
grounded errors does not. Pinned by a stub test.

---

## 4. Decomposing the rules — the walk

Numbers are the bullet's index in the rendered block (1-72, rules only;
preamble excluded) and its chars including the newline. Full listing in
the scratch script output; the classification:

**Core — generic behaviour, always rendered (21 bullets, 4,397 chars):**
1 use-only-listed (64) · 2 commands:[] when done (120) · 3 read
results (65) · 4 ROLLED BACK (457) · 5 units seconds/colours (55) · 6
positions (65) · 7 UNITS percent (198) · 9 NEVER assume size →
get_bounds (344) · 10 reply before commands run (268) · 11 reply
brevity (189) · 12 layer name|index (63) · 13 omit comp (40) · 14
prefer inspecting (102) · 15 SELECTED layers / never placeholder names
(494) · 23 SCOPE (564) · 26 report counts (108) · 27 at most 8 commands
(181) · 28 'each X' names a CLASS (364) · 34 unknown property →
list_properties (239) · 35 path syntax (244) · 65 never claim an
unemitted action (152).

Two of these could leave core after a wording pass, and are filed as
candidates, not done here: bullet 4 (ROLLED BACK, 457) could travel *on
the rolled-back result itself* the way `next:` hints do — it is only
needed on the turn a rollback happened; bullet 15 (494) is half generic
("never pass placeholder text") and half a roster of selection-taking
tools. Neither is in the v1 core cut because both are measured wording.

**Owned by exactly one tool (28 bullets):** 8 center_anchor_point ·
17 split_layer_into_chunks · 18, 19 reorder_layers · 22 grid_layout ·
25 duplicate_layer · 30, 31 distribute_property · 32 stagger_layers ·
41, 42 add_shape_content · 43, 44 set_mask_path · 46 precompose · 47
set_layer_timing · 48 set_layer_parent · 50 add_mask · 52
apply_expression_preset · 53 set_track_matte · 57 rename_comps
(preview) · 60 clean_project · 62 organize_project · 64 create_folder ·
66/67/68 Rigging (add_null / add_control / link_property, rendered as
one recipe) · 70, 71 set_expression. Several of these *name* other
tools, as anti-targets ("never stagger_layers") or as `uses`
(`get_bounds`, `set_keyframes`) — the table below lists those.

**Standalone (1 bullet):** 61, see below.

**Bullets that name more than one tool — owners, closure, anti-targets
(32 rows: the 22 multi-owner bullets plus the 10 single-owner bullets
whose text also names other tools as anti-targets or `uses`; core
bullets 14, 15, 23 and 34 name tools too and are in the core list
above):**

| # | chars | owners (render when any is routed) | `uses` (must render) | anti-targets (text only) |
|---|---|---|---|---|
| 16 | 503 | create_comp, duplicate_comp, precompose | — | — |
| 18 | 221 | reorder_layers | — | stagger_layers |
| 19 | 355 | reorder_layers | get_bounds, set_transform (core) | — |
| 20 | 260 | scale_comp, set_comp_setting | scale_comp | set_comp_setting |
| 21 | 357 | stagger_layers, split_layer_into_chunks, grid_layout, distribute_property, set_keyframes, apply_keyframe_ease | — | — |
| 22 | 332 | grid_layout | — | add_null |
| 24 | 419 | grid_layout, split_layer_into_chunks, stagger_layers | — | — |
| 29 | 499 | set_keyframes, apply_keyframe_ease, remove_keyframes, stagger_layers | all four + for_each_layer (core) | — |
| 30 | 172 | distribute_property | — | set_transform, duplicate_layer |
| 31 | 544 | distribute_property | — | grid_layout (context) |
| 33 | 246 | add_text_layer, set_text_style | — | set_text_style |
| 36 | 177 | set_keyframes, apply_keyframe_ease | both | — |
| 37 | 157 | list_effects, apply_effect | list_effects | — |
| 38 | 190 | list_presets, apply_preset | both | — |
| 39 | 167 | set_mask, set_mask_path | — | — |
| 40 | 282 | add_shape_layer, add_shape_content | both, set_keyframes | — |
| 41 | 252 | add_shape_content | — | — |
| 43 | 123 | set_mask_path | — | — |
| 45 | 447 | stagger_layers, distribute_property, apply_keyframe_ease | apply_keyframe_ease | stagger_layers (as "never") |
| 49 | 170 | apply_effect, add_mask | — | add_mask |
| 50 | 246 | add_mask | — | set_layer_timing |
| 51 | 224 | remove_keyframes, set_expression | — | — |
| 52 | 252 | apply_expression_preset | — | set_expression |
| 54 | 314 | audio_to_keyframes, link_property | both | — |
| 55 | 279 | remove_effect, delete_mask | both | set_effect_param, set_mask, delete_layer |
| 56 | 182 | rename_comps, rename_item | rename_comps | rename_item |
| 58 | 229 | rename_comps, audit_comp_usage | audit_comp_usage | rename_item |
| 59 | 432 | the project-panel group (create_folder, move_to_folder, rename_item, delete_item, duplicate_comp, organize_project, clean_project) | the group | — |
| 63 | 310 | the project-panel group | — | — |
| 69 | 170 | link_property, apply_expression_preset, set_expression | — | set_expression |
| 71 | 142 | set_expression | — | — |
| 72 | 689 | comfy_generate, comfy_list_workflows | both | — |

Bullet 49 is co-owned by `add_mask` on purpose: row 35's lesson is that
the blur bullet must be read *before* the crop bullet whenever masking
is on the table, so a mask route renders both, in order.

**Three bullets are behaviours, not tool rules — standalone, phrase-
triggered:** 61 "clean up this COMP names nothing: ask" (439; triggers
`clean up`, `tidy`, `sort out`, `a mess`, `junk`; `uses` nothing — its
second clause names tools for the *next* turn, whose own words will
route them), 28 class-of-layers (core anyway) and 21 ACT-DON'T-ASK
(owned by the selection-taking group, above). This is the model for any
future rule that is about the *shape of the ask* rather than a tool.

Closure definition (§16e's constraint, made precise): every tool a
rendered rule tells the model to call **now** is in `uses` and renders
in full; every tool a rendered rule merely *names* is at least in the
index line (always true); anti-targets need nothing. A lint asserts
every tool name appearing in a bullet's text is classified as owner,
`uses` or anti-target, so nothing is unclassified by accident.

---

## 5. The core set and its size

| part | chars | ≈ tokens |
|---|---|---|
| preamble | 320 | 87 |
| 21 core bullets | 4,397 | 1,189 |
| section headers | 82 | 23 |
| 9 core tools, compact: get_project_info, get_comp_details, get_bounds, apply_effect, for_each_layer, set_transform, list_properties, get_property, set_property | 1,835 | 496 |
| (`describe_tools`, if built — est. 130) | 130 | 36 |
| index line, 70 names | 1,195 | 323 |
| **core total** | **7,959** | **2,152** |

Why these nine: the two inspection tools are named by core bullet 14;
`get_bounds` by core bullet 9; `apply_effect` and `for_each_layer` by
SCOPE's one positive reference ("an effect ask is apply_effect (many:
for_each_layer)"); `set_transform` is the units rule's subject and the
most common mutation; the three universal-property tools are the
catch-all the core bullets 34/35 route to — they are what makes a router
miss survivable, because anything property-shaped can be done through
them. Everything else is routable.

---

## 6. Miss recovery — priced

| layer | when it acts | prompt cost | latency cost |
|---|---|---|---|
| **fall back to all** | router matched nothing | today's 39,803 chars for that turn | none |
| **sticky set** | tools used in the last 3 assistant turns | ≈ 260 chars per tool | none |
| **per-round extension** | round N called a tool, or its results named one | ≈ 260 chars per tool from round N+1 | none (string match) |
| **index-line call** | model calls an un-rendered tool | 0 (already in the index) | one round: the host's grounded error, then the tool renders |
| **`describe_tools {names}`** (panel-side, no AE) | model asks | ≈ 130 chars always + ≈ 300 per described tool as a result | one round |

`describe_tools` is not built in v1: the index-line call costs the same
one round and needs no new tool, and the host's refusals already say
what the args are (`'path' is required - an ABSOLUTE .png path…`). File
it (§24b lists it as optional) and build it only if the first
overnight run shows the model bouncing off index-only tools more than
once per row.

---

## 7. Order sensitivity

§8 measured order as load-bearing twice: row 29 (a bullet that listed
removal tools before its "ask" clause was read as "remove") and row 35
(the blur bullet had to be its own bullet *and* precede the crop
bullet). `test-chat-probe.js:2472-2538` pins those on the all-tools
prompt. The routed renderer keeps every bullet's original `order` and
sorts the rendered subset by it, so any pairwise order that holds in
the full block holds in every subset that contains both bullets. One
generic stub test asserts that (for random routed sets, the rendered
bullet indices are strictly increasing), instead of re-pinning thirty
rows. What routing *can* change is which bullet the model reads first,
because earlier bullets are absent — that is not an order effect, and
it is what the matrix run measures.

---

## 8. Prompt caching — the price

llama.cpp's `cache_prompt` reuses the slot's KV for the longest common
prefix with the previous request. Today the stable prefix is ~10.7K
tokens (preamble, rules, all docs); state and history follow and are
re-prefilled every user turn regardless (state is re-fetched per send).

Routed, the byte-stable prefix is preamble + core bullets ≈ 4,800 chars
≈ 1,300 tokens; the routed bullets, routed docs, index line, state and
history re-prefill each user turn. Extra prefill per user turn = the
routed section + core docs + index ≈ 2,500-7,000 chars ≈ **0.7-1.9K
tokens (est.)**. Prompt processing on a 7B Q4_K_M at the 8 GB tier is
of the order of 1-2.5K tokens/s (est.; never measured here — the
matrix run measures it, see below), so **+0.3-2 s per user turn**.
Within a turn nothing changes: rounds reuse the prefix, and extension
tools are appended after the routed set so the prefix before them
survives. Against that, every round of every turn sends 7-8.5K fewer
tokens, and a request that previously starved now carries history at
all.

REFINED §6's rejection of "move the tool block after state" stands:
the order preamble → rules → tools → state is unchanged here. The
measurement: `chat-probe` already prints seconds per round; the
routed-vs-all run compares medians. `context-budget-probe` tokenizes
the routed prompt to check 3.7 chars/token still holds for a
rules-heavier mix (prose is denser in tokens than args lines).

---

## 9. The re-derived bound

Five example requests, sized from the real strings (core + routed
docs + routed bullets; a routed tool's name leaves the index line):

| example | routed section | prompt chars | ≈ tokens |
|---|---|---|---|
| A "save a PNG of this comp" → snapshot_frame | 200 | 8,159 | 2,206 |
| B "blur the background" → apply_effect (core) + list_effects, bullets 37, 49 | 474 | 8,433 | 2,280 |
| C "stagger the squares and ease them" → stagger, ease, set_keyframes, remove_keyframes; bullets 21, 24, 29, 32, 36, 45 | 3,290 | 11,249 | 3,041 |
| D "clean up the project" → the project-panel group; bullets 59-63 | 2,889 | 10,848 | 2,932 |
| E worst case: C + grid_layout + distribute_property + add_null; bullets 21, 22, 24, 29-34, 36, 45 | 5,195 | 13,154 | 3,556 |
| today, compact, all | — | 39,803 | 10,758 |

History chars the panel's own arithmetic hands out (`starved` marked
`*`, < 2,000). Columns are window / reply reserve in tokens; 3,328 is
today's reserve, 1,280 is lever 5 (max_tokens 1,024 + 256):

**Probe's real state (2,682 chars):**

| | 8192/3328 | 8192/1280 | 12288/3328 | 12288/1280 | 16384/3328 | 16384/1280 |
|---|---|---|---|---|---|---|
| today | 0* | 0* | 0* | 0* | 2,728 | 8,257 |
| A | 3,700 | 9,229 | 14,759 | 20,289 | 25,818 | 31,348 |
| C | 1,445* | 6,975 | 12,504 | 18,034 | 23,564 | 29,093 |
| E (worst) | 55* | 5,584 | 11,114 | 16,644 | 22,173 | 27,703 |

**State at its cap (6,000 chars — the owner's measured case):**

| | 8192/3328 | 8192/1280 | 12288/3328 | 12288/1280 | 16384/3328 | 16384/1280 |
|---|---|---|---|---|---|---|
| today | 0* | 0* | 0* | 0* | **306*** | 5,835 |
| A | 1,281* | 6,810 | 12,340 | 17,869 | 23,399 | 28,929 |
| C | 0* | 4,556 | 10,085 | 15,615 | 21,144 | 26,674 |
| E (worst) | 0* | 3,165 | 8,695 | 14,224 | **19,754** | 25,284 |

Reading it:

- **16K:** from 306 chars (starved) to 19,754-23,399 at the owner's
  measured configuration — the conversation room grows 65-76×. That
  is where every 8-12 GB buyer is today, and it is the headline.
- **12K:** works on every example, 8,695-14,759 chars. §16e's "one
  rung" is confirmed and made comfortable.
- **8K, four levers only:** simple requests on a small project survive
  (A/B at 3,500-3,700 chars); anything with a real project or a real
  rules group starves. **8K is not a working floor under the four
  levers alone**, and the reason is not the prompt any more — it is the
  reserve.
- **8K with lever 5** (reply reserve scaled to the window): 3,165-9,229
  chars — working, two to four tool rounds of memory, the starve line
  still firing where it should. This is the honest 8K claim.

**Lever 5 — the reply reserve (found by the arithmetic, not in the
brief).** `REPLY_RESERVE_TOKENS = 3072 + 256` is `llama.js`'s
`max_tokens: 3072` ("room for large-but-legit command batches"). A
reply of the advisory 8 commands is ≈ 600-800 tokens; the schema's hard
cap is 20; a 100-key `set_keyframes` is ≈ 1,200. At 8K the reserve is
41% of the window, at 12K 27%. Proposal: `max_tokens = clamp(ctx / 8,
1024, 3072)` (8K → 1,024; 12K → 1,536; 16K → 2,048; ≥ 24K → 3,072),
reserve = max_tokens + 256, and the schema's `maxItems` steps with it
(20 → 10 at 8K). `main.js` already answers a truncated reply with the
compact-retry round, so the failure mode of a smaller cap is one retry,
not a lost turn. Gated on the matrix's batch rows (§14).

**Lever 6 — the two other fixed caps.** `STATE_BUDGET` (6,000 chars ≈
1,629 tokens = 20% of an 8K window) and `RESULTS_BUDGET` (6,000 chars
≈ 2,222 history tokens — a single round of results is the whole history
room at 8K) should scale: state ∝ ctx/16384 with a 2,500 floor; results
pool ≤ half of `historyBudget().chars` so the user turn and the reply
before it survive the round. And `LEDGER_BUDGET` (1,500 chars) is
subtracted from every turn's room whether or not a ledger exists;
reserve it only once `fitHistory` has dropped something. Small, but at
8K each is 5-10% of the window.

**With §13b:** lever 3 does not change the *conversation* arithmetic at
a given window; it changes which window a card can afford (§12).

---

## 10. Result governor

**What the brief asked for vs what the authoritative doc says.** The
brief points at "threshold, digest + handle"; REFINED §5 (authoritative
per WORKPLAN §15) **dropped the handle**: a stored payload is a stale
snapshot of project state, and the repo's expansion shape is a re-query
(`limit:0`, `start:`, `get_property`). This design follows REFINED.
Retrieval is a re-query, and the digest note already says exactly which
one (`fitResult`'s `truncated: "… narrow the request or page for the
rest"`).

**What exists today** (`compactToolResults`/`fitResult`): a 6,000-char
per-round pool, fair-shared, rows dropped from the END of the largest
array, a note written before the size check, never a mid-object cut.
That is the governor; it has a threshold (the fair share) and a digest
(rows + note). What it lacks is a window-aware pool (§9 lever 6) and
receipts that are short *at source*.

**Worst offenders, measured** (`test-tool-result-budget.js` header,
200-layer comp): `get_comp_details` 7,305 · `stagger_layers` 7,262 ·
`grid_layout` 7,258 · `distribute_property` 6,529 · `list_properties`
5,648 · `scale_comp` 3,577 · `list_effects` 3,514 · `get_project_info`
3,207 · `set_layer_parent` 1,589 · `audit_comp_usage` 1,442 ·
`rename_comps` 1,339. The reads are paged and honest already. The
three animation macros are the ones to shrink at source: a `placed:
[…]` row per layer is not a receipt, it is a dump — counts, the first
few, and the note are what the model acts on.

**The owner's `snapshot_frame` case, read from `hostscript.jsx:10954`:**
the result carries `path` (fsName, backslashes doubled by JSON
escaping), `next` (the same path again with forward slashes inside a
paste-ready `import_as_layer {…}` hint, ~120 chars), `timeNote` (~70),
`resolutionNote` (~150 when it fires), `pathNote`. ≈ 430-600 chars
(est.), of which the repeated path is 60-100. It was "cut to fit" not
because it was large but because the whole history room was 306 chars —
§9 is the fix; this section is hygiene.

**Design:**

1. **Window-scaled pool** (lever 6): `RESULTS_BUDGET(hb) = min(6000,
   floor(hb.chars / 2))`.
2. **Receipt ceilings per tool, in CI, off the canned host**: the same
   ratchet the prompt has. `test-tool-result-budget.js` gains a table:
   for every mutating tool the canned host answers, its `ok` result
   serialises under N chars (N = 400 unless the tool legitimately
   returns a list the model must read — created names, skipped names,
   failures — which are capped by count, not dropped). Today's sizes
   are the first pins; the three macros come down to counts + head.
3. **`next` hints never repeat a value already in the result**: `next:
   "import_as_layer {path} puts it in a comp"` — the model copies
   `path`. Notes ≤ 120 chars. A lint over the host source for `next:`
   sites (there are three: 4793, 10963, 12846) plus the `*Note` fields.
4. **No new digest shape.** `fitResult` is the digest. A per-result
   threshold is its fair share. The re-query is the retrieval.

---

## 11. KV-cache quantization (§13b) — what to set, what gates it

KV bytes per token at fp16 = 2 × layers × kv_heads × head_dim × 2. From
the models' published configs (**est.**, to be settled by the reading):

| model (catalog) | KiB/token fp16 | 16K fp16 | 16K q8_0 | 24K q8_0 | 32K q8_0 |
|---|---|---|---|---|---|
| Llama 3.2 3B (28 L, 8 KV heads) | 112 | 1,792 MiB | 952 | 1,428 | 1,904 |
| Qwen2.5 7B (28 L, 4 KV heads) | 56 | 896 | 476 | 714 | 952 |
| Qwen2.5 14B (48 L, 8 KV heads) | 192 | 3,072 | 1,632 | 2,448 | 3,264 |
| Qwen2.5 32B (64 L, 8 KV heads) | 256 | 4,096 | 2,176 | 3,264 | 4,352 |

q8_0 is 8.5 bits/element → 0.53 of fp16; q4_0 is 4.5 → 0.28. Two
things worth noticing before the reading: **the 3B's KV is twice the
7B's per token** (8 KV heads vs 4), so §13b matters most on the 4-6 GB
tiers, not least; and **the 7B at 24K with q8 KV (714 MiB) costs less
than at 16K fp16 (896)** — with routing having removed the 24K trap,
that is a window upgrade at zero VRAM on the 8-12 GB card.

**K/V types per model size (proposal):** `q8_0`/`q8_0` for every
catalog model, behind `--flash-attn` (V quantization needs it). Do not
ship `q4_0` V by default at any size; it is the one setting where
llama.cpp users report visible degradation, and this product's failure
mode is a modified project. `q4_0` V is a measured *opt-in* candidate
for the 3B on 4 GB only, after the reading. K stays q8_0 always (K is
the more sensitive half).

**Detection and fallback (§13b's own requirement):** spawn with the
flags; if the process exits non-zero with `unknown argument` /
`unrecognized` on stderr within the first seconds, respawn without them
and log which set was used. The reading is taken by a **standalone
`scripts/kv-quant-probe.js`** (no `extension/` change, no bump — the
§13b/§16f#4 dependency direction): `child_process.spawn` of
`llama-server.exe` with explicit flags, `nvidia-smi memory.used`
sampled before load and at steady state the way
`catalog-vram-probe.js:312` does, a fixed ~4K-token prompt sent to
`/completion` for `timings` (prompt tok/s and generation tok/s), over
{7B, 32B on the dev card} × {16384, 20480, 24576, 32768} × {fp16,
q8/q8, q8/q4}.

**The accuracy gate that decides shipping:** `chat-probe --variants`
on the same rows at fp16 and at q8/q8, same night: no new HARM, no
canonical regression, misses ≤ fp16 + 1 over the matrix, generation
tok/s within −10%. NEXT UP item 6 is this measurement; §24h is its
spec.

---

## 12. Budgets per tier — before and after each lever

Chat model per tier is `recommendChat` (largest catalog entry whose
`minVramGB` the card clears): T1/T2 → 3B, T3 → 7B, T4/T5 → 14B, T6/T7
→ 32B. The shipping window is **16,384 for every tier** (`settings.js`;
8,192 is upgraded to 16,384 on load). Conversation room is
`historyBudget` chars at state-cap; "after routing" uses the worst
example E and the best A; VRAM rows use §16d's corroborated 7B formula
(weights + 1,536 MiB, which is consistent with KV@16K fp16 ≈ 896 plus
~640 of buffers, **est.**) and §16's measured idle AE figure of 3,255
MiB on the dev card — the buyer's AE footprint is §16f's open reading
and dominates every fit below.

| tier | model | window today | room today (state-cap) | after routing (lever 1+2) | + lever 5 at 8K | KV lever (q8, est.) |
|---|---|---|---|---|---|---|
| T1 4 GB | 3B | 16,384 (does not fit: 1,926 + 1,536 + 1,792 KV = 5,254 MiB alone) | 306* | 19,754-23,399 | 3,165-6,810 | −840 MiB at 16K; at 8K q8 the model is 3,938 MiB — the only window with a chance on this card |
| T2 6 GB | 3B | 16,384 | 306* | same | same | −840 MiB at 16K; 16K q8 = 4,414 MiB + AE |
| T3 8 GB | 7B | 16,384 | 306* | same | same | −420 MiB; 24K q8 costs less than 16K fp16 |
| T4 12 GB | 14B | 16,384 | 306* | same | same | −1,440 MiB at 16K; 24K q8 (2,448) < 16K fp16 (3,072) |
| T5 16 GB | 14B | 16,384 | 306* | same | same | same as T4 |
| T6 24 GB | 32B | 16,384 | 306* | same | same | −1,920 MiB at 16K; 32K q8 ≈ 16K fp16 |
| T7 32 GB | 32B | 16,384 | 306* | same | same | the owner's card "behaves like a 16K card once ComfyUI wants VRAM" (§13b) — 32K q8 fits where 16K fp16 did |

The room columns are identical across tiers because the window is: the
prompt cost is per window, not per card. What differs per tier is
which window the card can afford, and that is §13b's reading plus
§16f's AE reading. Two findings for the owner, filed not decided
(§24j): on paper the 3B does not fit a 4 GB card at the shipping 16K
window at all, and the tier copy that promises "light chat" there
predates any measurement; and 8K is the only window with a chance on
T1, which is why the 8K floor in §9 is a product question, not an
academic one.

---

## 13. CI — ceilings and tests, all stub-side

New pins in `tests/test-context-budget.js` (or a sibling
`test-prompt-routing.js`):

1. **Byte-identity:** `buildSystemPrompt("", {compact:true})` with no
   `route` equals the pre-split output — the existing `COMPACT_CEILING`
   40,000 / `FULL_CEILING` 59,000 and every `test-chat-probe.js` rules
   pin keep passing unchanged.
2. **`CORE_CEILING`:** the routed prompt with an empty route (core
   only, compact) ≤ **8,200** (measured 7,959; the number moves only
   with a written reason).
3. **`ROUTED_WORST_CEILING`:** route every canonical sentence and every
   paraphrase in `chat-probe`'s step list (176 sentences: 36 canonical
   + 140 variants) through `routeFor` and take the largest rendered
   prompt: ≤ **14,000** (example E measured 13,154).
4. **Group-union ceiling:** for each tool, the prompt with that tool
   routed plus its full closure: ≤ **12,500** (the project-panel group
   and the animation group are the two biggest; the test prints the top
   five so growth is attributable).
5. **Closure:** every `uses` of every rendered rule is rendered; every
   tool name that appears in any bullet's text is classified (owner,
   `uses` or anti-target) — nothing unclassified.
6. **Order:** for 200 random routed sets, rendered bullet `order`
   indices are strictly increasing.
7. **Router recall (no model):** each step in `chat-probe.js` gains
   `expects: [tool, …]` (metadata only); every canonical and variant
   sentence routes to a set containing every expected tool, **or**
   returns `matched: false` (fall-through to all). Recall must be 100%;
   the fall-through count is printed and pinned at ≤ 10% of sentences,
   moving down as triggers are added.
8. **Trigger lint:** every tool has ≥ 3 triggers; no trigger phrase
   belongs to more than 3 tools; triggers are lower-case, no
   punctuation.
9. **Starve rows** (REFINED §4's acceptance, in the routed form):
   `historyBudget(16384, routedWorst + 6026).chars ≥ 2000` and the same
   at 12,288; after lever 5, at 8,192 with the scaled reserve.
10. **Schema:** `RESPONSE_SCHEMA.properties.commands.items.properties.tool.enum`
    still lists all 79 under routing.
11. **Receipt ceilings** (§10.2) in `test-tool-result-budget.js`.

---

## 14. Measurement plan — overnight only, specified not run

All runs are `--variants --isolate` (fresh rig, fresh history per
sentence), on the same model the panel ships for the tier being
measured, and **routed vs all are always the same night** — the
baseline is never a historical number, because §8 measured the same
row HARM in two of three runs at temperature 0.7.

**Night A — §13b reading (needs no design; NEXT UP item 6; §24h).**
`scripts/kv-quant-probe.js` as specified in §11: VRAM at steady state
and tok/s for {7B, 32B} × {16384, 20480, 24576, 32768} × {fp16, q8/q8,
q8/q4}; flag-rejection detected and recorded. Then `chat-probe
--variants` fp16 vs q8/q8 on the full matrix. **Pass bar for shipping
q8:** zero new HARM, zero canonical regressions, misses ≤ fp16's + 1,
generation tok/s ≥ 90% of fp16's.

**Night B — routing, 16K (§24d).** `chat-probe --route all` then
`--route auto`, full matrix, default window. **Pass bar:** (1) every
canonical that passes under `all` passes under `auto`; (2) HARM under
`auto` is zero on every row where HARM under `all` is zero; (3) total
misses over the 140 paraphrases ≤ misses under `all` + 2; (4) the
transcript records, per sentence, the routed set, whether it fell
through, and seconds per round — medians of `auto` vs `all` are the
cache price (§8), reported, no bar; (5) `context-budget-probe.js --no-chat`
with routing on: real tokens for the core prompt and for example E's
prompt; if chars/token < 3.7 on either, `PROMPT_CHARS_PER_TOKEN` is
re-pinned below the new measurement before anything ships. Any step
where `auto` misses and `all` passes is logged with the trigger that
was missing; one trigger addition per pass, re-run that step's
variants, the way §8 always did it.

**Night C — the floor (§24d, second half).** The same matrix at
`--ctx 12288 --route auto`: same pass bar as night B against the same
night's 16K `auto` run. Then `--ctx 8192` with lever 5 in place: the
rows that test the floor are "a second turn that refers back" (history
survived), "batch animation with a stagger" and "cascade the entrances"
(the reply cap), and any row whose transcript shows `message cut to
fit` or a context 400. **Pass bar at 8K:** refer-back passes; no
context-400 retry on more than 10% of sentences; the starve notice
fires only where `historyBudget` says it should.

**Night D — governor and caps (§24e-g).** Re-run the rows whose results
were pinned (§10.2) and the 200-layer fixture rows of
`test-tool-result-budget.js` in the stub suite; in real AE, the
`grid_layout` / `stagger_layers` / `distribute_property` steps with
receipts shrunk: pass = same verdicts as the previous night, and the
per-round `TOOL RESULTS` message sizes in the transcript down by the
pinned amounts.

**What flips the default.** Routing ships default-on only after night
B and the 12K half of night C are green; that flip is the MINOR
boundary (a capability the user notices arriving — the panel stops
forgetting), with release notes. Everything before it is patch work
behind an opt.

---

## 15. Where the code and the brief disagree, and what this design does about it

1. **"Digest + handle" (brief, lever 4) vs REFINED §5 (authoritative):**
   the handle was dropped as a stale snapshot. This design follows
   REFINED: re-query is the retrieval, `fitResult` is the digest.
2. **The four levers alone do not reach 8K** at the owner's measured
   state size (§9). §16e's "never reaches 8K" survives the split in a
   weaker form: it is the reply reserve now, not the rules. Lever 5 is
   the fix and is arithmetic, not wording.
3. **The 24K trap** is closed by making `routed` its own axis on
   `promptModeFor`, not by touching the 24,576 threshold.
4. **`system` is built once per turn** in both `main.js:639` and
   `chat-probe.js:619`; per-round extension needs the rebuild in both,
   in step. The probe has a `roundObserver` hook the panel lacks;
   routing decisions must be visible to it (the routed set per round is
   logged).
5. **`test-chat-probe.js:2362`** pins bullet order on the *all* prompt
   by splitting at `\nAvailable tools:`. Those pins survive untouched
   because `route` absent is byte-identical; the routed form gets the
   generic order test (§13.6), not thirty new pins.
6. **§16d's 1,536 MiB constant** is presented as KV-type-free; it is
   consistent with fp16 KV at 16K plus buffers (est.). The §13b reading
   should record ctx and KV type so the constant can be split.
7. **The tier copy for T1/T2** promises chat that the arithmetic in
   §12 says does not fit at the shipping window (est.). Owner-gated
   under §16's rule; filed as §24j, not rewritten.
8. **The starve notice's advice** ("Raising Context size in Settings
   gives it memory") is the advice §16 says the 8-12 GB buyer cannot
   follow; once routing is default-on it is also usually unnecessary.
   Reword with the flip (§24i).

---

## 16. Build order (the §24 items, in dependency order)

§24a (split the block, byte-identical) → §24b (router + opt + probe
flag + CI) → §24c (per-round extension and sticky set, both callers) →
§24d (nights B and C; default-on = MINOR) → §24e (reply reserve) →
§24f (window-scaled caps) → §24g (receipts). §24h (the §13b launcher
and the fp16-vs-q8 matrix) is independent and is NEXT UP item 6
already. §24i (docs, notice copy) rides the flip. §24j is the owner's.
