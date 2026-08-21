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

## Out of scope for the local session (remote builds these)

- ComfyUI model catalog / bundled installer (needs the user's Krea
  workflow + model picks).
- Phase D animation utilities and Phase E roto/tracking hybrids
  (docs/NATIVE_COVERAGE_PLAN.md) — verify them when they land.
- Minor/major version bumps, PRs into main, release notes. PATCH bumps
  are YOURS: `node scripts/bump-version.js patch` before pushing a fix
  you verified in real AE, or it never reaches a panel (see CLAUDE.md).
