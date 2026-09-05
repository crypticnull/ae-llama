# AE Llama — orientation

**Read this first if you are new to the repo.** It is the one document
meant to be read start-to-finish by a fresh session that needs to know
what this product is before touching anything. Everything else in
`docs/` is either a backlog, a plan, or an evidence ledger.

Where to go next, once oriented:

| You need | Read |
|---|---|
| The rules you must follow to change code here | `CLAUDE.md` (root) |
| Every tool, generated from the source | `docs/CAPABILITIES.md` |
| What to work on | `docs/WORKPLAN.md` |
| What has already been done, and why | `docs/WORKPLAN-LOG.md` (append-only, large) |
| How to run the tests | `docs/TESTING.md` |
| Premiere Pro feasibility + measured platform facts | `docs/PREMIERE_PLAN.md`, `docs/PREMIERE-PLATFORM.md` |

---

## 1. What the product is

**AE Llama** is a commercial Adobe After Effects panel that lets a user
drive After Effects by typing plain English into a chat box.

> "make the logo fade in over 2 seconds and add a soft drop shadow"

A **local** language model reads that, decides which of the panel's 79
tools to call and with what arguments, and the panel executes those calls
against the real After Effects scripting API. There is a second, hidden
backend (ComfyUI) for generating images and video.

Three things make it unusual, and all three shape every decision in the
repo:

1. **The model runs on the user's own machine.** No API key, no cloud, no
   per-token cost, and nothing about the user's project leaves the
   machine. It is a llama.cpp server the panel launches itself.
2. **The model is small.** A 32B local model is not a frontier model. It
   misreads vague instructions, picks near-miss tool names, and gives up
   quietly. Most of the engineering in this repo is about making a small
   model *succeed anyway* — see §5, which is the real thesis of the
   project.
3. **It is a commercial product**, headed for aescripts.com. Users are
   motion designers, not developers. A failure that a developer would
   shrug at ("it silently did nothing") is a refund here.

Platform: Windows 11, After Effects 2024+, field-tested on AE 2026.
Adobe CEP panel (HTML/JS front end + ExtendScript back end).

---

## 2. How a single request flows

```
   user types in the panel
            |
            v
   [ tools.js ]  builds a system prompt: routing rules + tool docs
            |
            v
   [ llama.js ]  -> llama-server.exe (local, 127.0.0.1:8737)
            |         the model replies with JSON: {tool, args}
            v
   [ tools.js ]  executeCommands() — up to 6 rounds per user turn
            |
            v
   [ main.js ]   CSInterface.evalScript(...)      <-- the CEP boundary
            |
            v
   [ hostscript.jsx ]  ExtendScript, inside After Effects
            |         AELL_TOOLS[name](args) -> touches the real API
            v
   a RECEIPT goes back up the same chain as the next tool result
```

Two details of that loop matter more than the rest:

- **Rounds, not one shot.** The model gets the result of its call and may
  call again — capped at 6 rounds per user turn. So a *receipt* is not
  logging; it is the next thing the model reads. This is why so much of
  the codebase is about what a tool says back.
- **One undo per round.** A round that fails partway is rolled back as a
  unit, so the user's project never ends up half-changed. (Premiere has
  no undo API at all, which is why the Premiere port is a separate
  problem — see `docs/PREMIERE-PLATFORM.md`.)

---

## 3. Layout

| Path | What it is | Size |
|---|---|---|
| `extension/jsx/hostscript.jsx` | **All 79 AE-side tools** (`AELL_TOOLS`). ES3. The biggest and most important file. | ~19k lines |
| `extension/js/tools.js` | Tool docs, the system prompt, the round executor, panel-side tools | 3.5k |
| `extension/js/main.js` | Panel UI, chat loop, the CEP bridge | 1.5k |
| `extension/js/llama.js` | Launches and talks to llama-server | 580 |
| `extension/js/comfy.js` | The hidden ComfyUI backend (image/video) | large |
| `extension/js/selftest.js` | The **real-AE** test suite (see §6) | 12k |
| `extension/js/setup.js` | First-run install of llama.cpp, models, ffmpeg, whisper | 1.1k |
| `extension/js/tiers.js` | VRAM arithmetic — can this generation and the chat model coexist? | 342 |
| `tests/` | ~74 stubbed-AE Node suites, run in CI | — |
| `scripts/` | PowerShell + JSX harnesses, probes, the overnight loop | — |

---

## 4. What the 79 tools do

Grouped by what a user would ask for. Full generated table with
descriptions is in `docs/CAPABILITIES.md`.

**Create things** — `create_comp` `add_solid` `add_text_layer`
`add_shape_layer` `add_shape_content` `add_null` `add_camera` `add_light`
`add_control` `import_file` `import_as_layer` `duplicate_layer`
`duplicate_comp` `precompose` `create_folder`

**Move / transform** — `set_transform` `set_property` `set_layer_timing`
`set_layer_parent` `set_layer_3d` `center_anchor_point` `reorder_layers`
`grid_layout` `stagger_layers` `scale_comp` `split_layer_into_chunks`
`distribute_property`

**Animate** — `add_keyframe` `set_keyframes` `remove_keyframes`
`apply_keyframe_ease` `set_expression` `link_property`
`apply_expression_preset` `add_text_animator` `audio_to_keyframes`

**Look** — `apply_effect` `set_effect_param` `remove_effect`
`apply_preset` `set_text_style` `set_solid_color` `add_mask`
`set_mask` `set_mask_path` `delete_mask` `set_track_matte`

**Read the project** (no writes — how the model orients itself)
— `get_project_info` `get_comp_details` `get_property` `get_bounds`
`list_properties` `list_effects` `list_presets` `list_render_templates`
`audit_comp_usage`

**Output** — `render_comp` `render_comp_audio` `add_to_render_queue`
`export_gif` `export_social` `export_mogrt` `expose_property`
`snapshot_frame`

**Project hygiene** — `clean_project` `organize_project` `rename_item`
`rename_comps` `move_to_folder` `delete_item` `delete_layer`
`set_comp_setting`

**Batch** — `for_each_layer` (runs another tool across many layers)
**Captions** — `add_captions` `transcribe_to_captions` (Whisper) `add_marker`
**Generation** — `comfy_generate` `comfy_list_workflows` `comfy_status`

---

## 5. The design thesis: a small model needs grounded receipts

This is the part that is easy to miss and explains most of the code.

A frontier model can recover from a vague error. A 32B local model
cannot — it will retry the same wrong thing, or announce success.
So every tool here obeys rules that look excessive until you watch a
small model fail without them:

- **Every failed lookup lists what actually exists.** Not
  `Parameter not found: Radius`, but that plus the seven parameters the
  effect really has, plus — since a later pass measured it — *which of
  them means what you asked for* ("Offset → on 'Drop Shadow' that is:
  Direction, Distance").
- **A tool that did nothing must say so.** The single largest category of
  fixed bugs in this repo is *silent success*: a call that returned `ok`
  and changed nothing, or erased the layer. Example: a mask set to
  `subtract` covering the whole layer empties it, and for a long time the
  receipt was a bare `ok`. Several passes are entirely about reading the
  layer's real alpha before and after an edit so the receipt can say
  "this hid the layer, here is the way back".
- **A refusal's last sentence is an instruction.** The small model obeys
  it. A refusal that ended "…add_mask creates one" caused the model to
  create a useless mask. Wording is load-bearing and is measured.
- **Context is a functional resource.** System prompt + tool docs +
  project state + results + history share one window. When it overflows,
  the panel drops *history*, so the user's earlier turns vanish and
  follow-up requests break. Every prompt addition must be measured and
  paid for by a cut. See §7.

The consequence: you cannot verify a change here by reading it. Real AE
disagrees with reasonable expectations constantly (see `CLAUDE.md`'s
"hard-won AE facts" — 2D layers pad to 3 components in scripting but not
in expressions; `instanceof AVLayer` is false for text and shape layers;
`removeTrackMatte()` leaves the type behind forever). **Measure first,
then fix.**

---

## 6. How anything gets verified

Three layers, in increasing cost and increasing authority:

1. **Stubbed suites** — `node tests/test-<name>.js`, ~74 files, no AE
   needed, run by CI on every push. The stubs deliberately model *real
   AE's quirks*, including its bugs. A stub that is too permissive is
   itself a defect: several bug classes stayed invisible for months
   because a stub answered from the arguments instead of modelling state.
2. **The real-AE self-test** —
   `powershell -ExecutionPolicy Bypass -File scripts/run-ae-selftest.ps1`
   drives `AfterFX.exe` through ~770 checks in a scratch comp and prints
   PASS/FAIL. This is the one that counts. New coverage goes in
   `extension/js/selftest.js`, which both the CLI runner and the panel's
   Settings → "Run self-test" button share.
3. **The paraphrase matrix** — `scripts/chat-probe.js --variants` puts
   four phrasings of the same real user request in front of the actual
   local model and grades pass / miss / HARM. It is the *only* instrument
   that can see routing (which tool the model picks), because that
   happens before any tool runs. Prompt changes are unverifiable without
   it.

There is also an **overnight loop** (`scripts/run-local-agent.ps1`) that
runs unattended passes through the workplan on the machine with real AE.
Its brief is in that file.

---

## 7. Context budget — the constraint that shapes the prompt

The panel builds two forms of the system prompt:

| Form | Size | Used when |
|---|---|---|
| full | ~58.9k chars | model context ≥ 24576 |
| compact | ~39.8k chars | model context < 24576 |

`ctxSize` **defaults to 16384**, so **compact is what a typical user
actually gets**. Both forms share a byte-identical *rules block* — the
routing phrase lists that decide which tool the model picks — and compact
drops the second sentence of each tool's doc.

Both forms are ratcheted by absolute ceilings in
`tests/test-context-budget.js`. Growth in either must be paid for by a
real cut in that same form. (Cuts to tool-doc second sentences reduce
`full` only; compact already discards them.)

---

## 8. Rules that will bite you

Read `CLAUDE.md` for the full list. The ones that cause the most damage
when forgotten:

- **`.jsx` is ES3.** No `JSON` (use `AELLJSON`), no `const`, no array
  extras. And ExtendScript parses `?:` **left-associatively**, so every
  nested conditional needs explicit parentheses —
  `tests/test-es3-ternary.js` enforces it.
- **`.ps1` must be pure ASCII, BOM-less** (Windows PowerShell 5.1).
  `tests/test-powershell-syntax.js` parses every one with real pwsh.
- **BUMP OR IT DOES NOT SHIP.** CI publishes the update feed on every
  push to `main` *and* `claude/**`, but the panel only updates when the
  feed's version is greater. `node scripts/bump-version.js patch` touches
  all four files. Bump when `extension/` changed; do **not** bump for
  harness/test/doc-only work.
- **Never push tags** (branch-scoped credentials reject them).
- Model identity strings must never appear in committed artifacts.
