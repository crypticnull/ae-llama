# Work queue — local (real-AE) session

Ordered priorities for the agent running on the AE machine. Work top to
bottom; commit small, tested fixes to the dev branch
(`claude/ae-plugin-llama-cpp-f13g3x`) with clear messages. Big features
and releases stay with the remote session — flag them instead of
building them.

**Before picking anything, read `docs/WORKPLAN-LOG.md`** — it records
what earlier passes already finished. Unattended passes are fresh
sessions with no memory of each other, so without the log every pass
would restart at item 1. Append your entry before you stop.

Unattended runs are driven by `scripts/run-local-agent.ps1` (pull -> one
item -> commit -> repeat). One item per pass, then stop.

## 1. Make the harness green (always first)

Run `scripts/run-ae-selftest.ps1`. Fix any failure at its root (host
tool, not the test), then update the stubbed Node test in `tests/` so
the same bug class is caught WITHOUT AE — that is the whole loop:
field truth -> fix -> stub faithfulness.

## 2. Real-AE verification debt (things stubs cannot prove)

Verify each by scripting AE directly (temp .jsx + AELL_call, see
CLAUDE.md). Where behavior is wrong, fix + extend selftest.js.

DONE — do not re-verify (see WORKPLAN-LOG.md): grid rig under both
expression engines, center_anchor_point on rotated/scaled/parented and
animated layers, scale_comp with cameras/keyframes, text styling and
font validation, cameras in the suite (old item 2b).

Still open:

- split_layer_into_chunks on real FOOTAGE (trimmed in/out points), not
  just solids; verify seamless playback and stack order.
- distribute_property step mode on real layers; reorder_layers actual
  stack order after (read back via get_comp_details).
- set_mask_path keyframes: scrub and confirm the mask actually
  ANIMATES (Shape value at time, not just numKeys).
- for_each_layer with apply_effect across 50+ layers: timing +
  stability, and the same at 200 layers for grid_layout and batch keys.
  Note anything over ~5s.
- add_light: no such tool exists, so lights are wholly uncovered. Same
  aim-not-scale rule cameras needed. Build the tool AND its coverage.

## 2c. Inventory the owner's real ComfyUI install (no AE needed, one pass)

The remote session cannot see this machine's disk. Scan
`C:\Users\mr\Documents\ComfyUI` and write
`docs/COMFY_LOCAL_INVENTORY.md` with:

- Every model file under `models/` (all subdirs): relative path, size
  in MB, and which kind-folder it lives in. Flag the files the Krea
  manifest needs (`extension/workflows/AE_LLAMA_KREA2_V1.manifest.json`)
  and the MiniMax H3 / Wan 2.2 weights specifically.
- Every folder under `custom_nodes/`: name + (from its git config or
  pyproject) the repo it came from. This must ATTRIBUTE the manifest's
  UNKNOWN nodes: Krea2Control*, DepthAnythingV2Preprocessor,
  ArcaneBloomFX, easy cleanGpuUsed.
- The ComfyUI version (its own version file / git tag) — the bundled
  installer must match or exceed 0.3.76 (subgraphs).
- Any extra_model_paths.yaml already present (models may live on other
  drives — list those roots too).

Pure filesystem reading — no AE, no generation runs, do NOT launch
ComfyUI. This unblocks tier-plan P5 (catalog file lists + sizes) and
the register-existing matcher. Commit the inventory; no version bump.

## 3. Extend selftest.js coverage

Every verified behavior from (2) becomes a permanent step in
`extension/js/selftest.js` (both the panel button and the harness pick
it up automatically). Keep results compact; steps must clean up after
themselves inside the scratch comp.

## 4. Field-quality passes

- Run the panel like a user: `node scripts/chat-probe.js` drives the
  whole product path headless (real settings -> real llama-server ->
  real tools.js -> real AE) through an 8-step checklist and writes a
  transcript to `logs/`. DONE 2026-08-21 (7/8, one real bug fixed).
  Re-run it after any change to tools.js, the system prompt, or a
  batch tool — it is the only thing that tests the MODEL's half.
  Open follow-ups it filed, each its own pass:
  - ~~`stagger_layers` `spread` is a TOTAL, but users say "4 frames
    apart"~~ DONE 2026-08-21: the tool takes `step` (seconds) and
    `stepFrames`, refuses spread+step together, and flags a spread
    that works out to under a frame per layer. Probe re-run: the model
    now sends `stepFrames: 4`.
  - ~~`add_text_layer` inherits AE's last-used character panel style~~
    DONE 2026-08-21: it does normalize. A new layer starts from a
    documented baseline (white, 72px, tracking 0, auto leading, left,
    no faux/stroke, a verified-installed plain sans) and the caller's
    args override it; `inheritStyle: true` keeps AE's Character panel.
    `set_text_style` still never normalizes — it edits a layer the
    user owns. AE 2026 makes allCaps/smallCaps/superscript/subscript
    READ-ONLY, so an inherited one is reported instead of swallowed.
  - the checklist never touches ComfyUI, undo across a mixed round, or
    a second chat turn that refers back ("make them blue instead").
  - a round that fails PART WAY leaves its debris behind: when
    `duplicate_layer` errored before `add_solid` had a layer to copy,
    the model retried the whole round and the comp ended with TEN red
    squares, nine spread and one orphan parked at the centre. The tools
    each behaved correctly (grounded error, successful retry); what is
    missing is any notion of rolling a failed round back.
- ~~Undo hygiene: one Ctrl+Z per chat command~~ DONE 2026-08-21 via
  AELL_callBatch.
- ROLLBACK for a round that fails part way — the biggest open gap. When
  duplicate_layer errored before add_solid had a layer to copy, the
  model retried the whole round and the comp ended with ten squares
  instead of nine. Every tool behaved correctly; there is simply no
  notion of undoing a partial round. Now that a round is one undo group,
  this is tractable. Design it before building it, and say what happens
  to the user's OWN work if a rollback overshoots.
- Performance: 200-layer comps — measure grid_layout and batch
  keyframe wall time; note anything over ~5s so the remote session can
  optimize.

## 5. Feature track — probe, build, lock in (NO version bumps here)

New capabilities, queued AFTER items 1–4. Rules for every 5.x/6.x item,
learned the hard way:

- **Three passes max per feature, one per loop pass.** (a) PROBE: temp
  .jsx against real AE, write the verified facts (exact matchNames,
  return shapes, what throws) to WORKPLAN-LOG.md. Every API name below
  is from training and UNVERIFIED — the probe is the point. (b) BUILD:
  the tool(s) in hostscript.jsx + docs in tools.js (undocumented tools
  are unreachable by the model) + a stubbed test whose stub encodes what
  the probe measured. (c) LOCK IN: positive-path selftest.js steps, with
  cleanup, in their own scratch comp where side effects are possible.
- **NO version bump on feature passes.** Patch bumps are for fixes to
  shipped behavior. New tools ride the next MINOR (0.10.0), which the
  remote session cuts after reviewing the batch. Push without bumping —
  the feed publishing an equal version is correct here.
- If a pass ends with AE stuck on a modal (harness exit 4), dismiss it
  with the Win32 method already documented in the log, record exactly
  what raised it, and log the pass. Never leave AE blocked for the next
  pass.
- A probe that DISPROVES the sketch below is a success: log it, adjust
  or strike the item, stop the pass.
- BEFORE building any tool, check docs/CAPABILITIES.md — 5.4 nearly
  built three duplicates of tools that already existed. After a BUILD
  pass, `node scripts/capability-report.js` regenerates the inventory
  (tests/test-capability-doc.js fails CI if you forget). Its computed
  coverage-gap lists are also the ready-made queue for item 3.

### 5.1 Text animators
Probe: the property tree under "ADBE Text Animators" — add an animator,
an "ADBE Text Selectors" range selector, and animator properties
(position/opacity/rotation/scale at least); verify Start/End/Offset
percent paths and per-character-3D requirements. Build:
`add_text_animator` (generic, grounded errors listing available animator
properties) — macros like "typewriter"/"cascade" belong in the PROMPT as
recipes, not as separate tools. Highest value per line of code here.

### 5.2 Shape repeaters
Probe: "ADBE Vector Filter - Repeater" under a shape group — copies,
offset, and the repeater transform block. Build: `add_repeater` {layer,
copies, position/rotation/scale/anchor offsets}. Verify the radial-burst
recipe (rotation 360/copies) renders as expected.

### 5.3 Animation preset library
Probe: `layer.applyPreset(File)` on a stock .ffx — does it need the
layer selected, what does it do to selection (AELL_keepSelection?), and
enumerate what ships: Support Files\Presets\**\*.ffx + the user's
Documents\Adobe\After Effects*\User Presets. Build: `list_presets`
(cached, filterable) + `apply_preset` with the font-style grounded error
(near-matches by name). Hundreds of behaviors for the price of two tools.

### 5.4 Precompose + markers — the tools ALREADY EXIST; verify + cover
docs/CAPABILITIES.md's computed gaps caught this item about to build
duplicates: `precompose` and `add_marker` are in TOOL_DEFS today, with
zero stub tests and zero suite steps. So this item is (a) probe their
real behavior (precompose selection side effects, marker duration
handling), (b) fix what's wrong, (c) stub test + suite steps. Do NOT
build new tools here.

### 5.5 Render queue (unlocks 5.8, 6.1, 6.2 — do before them)
`add_to_render_queue` ALREADY EXISTS (uncovered — same trap as 5.4).
Probe what it does today, then extend rather than duplicate: actually
RENDERING headless — renderQueue.render() from a -r session vs the
aerender.exe alternative (decide which is stable unattended, log why),
output-module templates (enumerate + log; version-sensitive), grounded
template errors. Also probe single-frame paths here: saveFrameToPng if
it exists, else a one-frame render — needed by 5.8.

### 5.6 Project hygiene
Probe: removeUnusedFootage(), consolidateFootage(), reduceProject()
return values. Build: `clean_project` {action} — reduceProject DELETES,
so it requires an explicit comp argument and reports counts; everything
in one undo group. Refuse vague asks with a grounded list of actions.

### 5.7 Audio to keyframes
Probe: `app.findMenuCommandId("Convert Audio to Keyframes")` — does the
id exist, what selection/active-comp state it needs, exact name of the
created null and its slider paths. Build: `audio_to_keyframes` {layer}
returning the null + slider path ready for link_property. Grounded error
lists audio-capable layers. This plus link_property = beat-driven
anything.

### 5.8 Frame round-trip (the local foundation for image/video gen)
Build on 5.5's probe: `snapshot_frame` {comp, time, path} writes a PNG
of the comp at a time; `import_as_layer` {path, comp, fit} imports a
file and places it as a layer scaled fit/fill/center to the comp. Verify
the full loop: snapshot -> import -> pixel dimensions match the comp.
Generation wiring stays remote — this is the comp<->file bridge it will
stand on.

### 5.9 .mogrt export (LAST item of any night — dialog risk)
Probe with everything pre-cleaned (project saved, text using a font
verified via isSubstitute===false): set
comp.motionGraphicsTemplateName, property.canAddToMotionGraphicsTemplate,
addToMotionGraphicsTemplateAs, then
exportAsMotionGraphicsTemplate(true, path). Log which steps raise
dialogs and whether they are dismissable. Build ONLY if the probe shows
a clean headless path: `expose_property` {layer, property, label} +
`export_mogrt` {comp, path}. If it cannot run headless, log that and
leave it panel-interactive-only for the remote session to design.

## 6. Binary track (multi-night; same lifecycle pattern as llama-server)

### 6.1 Local captions via whisper.cpp
Pass A: acquire — download a prebuilt whisper.cpp Windows binary +
ggml-base.en model the way get-llama.ps1 does llama-server; verify it
runs on a WAV. Pass B: verification harness with NO human audio —
synthesize a spoken WAV locally (PowerShell System.Speech TTS, e.g.
"the quick brown fox"), transcribe, assert the transcript contains the
phrase; make that a stub-level test that skips cleanly when the binary
is absent (CI has no binary). Pass C: AE wiring — render a comp/layer's
audio to WAV via 5.5, transcribe with timestamps, build styled text
layers (5.1/text tools) or markers from the segments:
`transcribe_to_captions` {comp|layer}. Do NOT start C before 5.5 lands.

### 6.2 ffmpeg post-renders
Pass A: acquire a static ffmpeg build the same way; verify with ffprobe.
Pass B: `export_gif` / `export_social` {comp, path, size, fps} =
lossless render via 5.5 piped through ffmpeg, temp files cleaned. After
5.5 only.

## Out of scope for the local session (remote builds these)

- ComfyUI model catalog / bundled installer, and wiring generation into
  5.8's round-trip (blocked on the user's Krea workflow + model picks).
- The VRAM-tier architecture (docs/COMFY_TIERS_PLAN.md): remote builds
  P1–P3. Its P4 — real-GPU measurement of every catalog entry and the
  handoff, each tier simulated via vramOverrideGB — will be queued HERE
  once P1–P3 land. Do not start it early; the hooks will not exist.
- Phase E roto/tracking hybrids. (Phase D animation utilities are now
  largely items 5.1–5.7 above — do not double-build them.)
- The rollback DESIGN in item 4 may be built only after the remote
  session reviews the proposal.
- Minor/major version bumps, PRs into main, release notes. PATCH bumps
  are YOURS: `node scripts/bump-version.js patch` before pushing a fix
  you verified in real AE, or it never reaches a panel (see CLAUDE.md).
