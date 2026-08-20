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
CLAUDE.md). Where behavior is wrong, fix + extend selftest.js:

- Grid rig under BOTH expression engines: flip Project Settings >
  Expressions between JavaScript and Legacy ExtendScript and re-run the
  harness. Generated expressions must evaluate in both.
- center_anchor_point on rotated + scaled + parented layers (the
  compensation math is only stub-proven).
- scale_comp on comps containing cameras (zoom scaling), parented
  chains, and keyframed position/scale (setValueAtKey path).
- Text: add_text_layer + set_text_style (font/tracking/leading paths
  are AE-version sensitive), then add a selftest step for text.
- split_layer_into_chunks on real FOOTAGE (trimmed in/out points), not
  just solids; verify seamless playback and stack order.
- distribute_property step mode on real layers; reorder_layers actual
  stack order after (read back with list via get_comp_details).
- set_mask_path keyframes: scrub and confirm the mask actually
  animates (Shape keyframe values at time, not just numKeys).
- for_each_layer with apply_effect across 50+ layers: timing +
  stability (watch for evalScript payload limits).

## 3. Extend selftest.js coverage

Every verified behavior from (2) becomes a permanent step in
`extension/js/selftest.js` (both the panel button and the harness pick
it up automatically). Keep results compact; steps must clean up after
themselves inside the scratch comp.

## 4. Field-quality passes

- Run the panel like a user: the 8-step chat checklist in the README
  era (grid, batch animation, masks, mattes, equidistant distribution,
  parenting). File exact failing transcripts in commits or notes.
- Undo hygiene: each chat command should be one Ctrl+Z step (undo
  groups) — verify for the batch tools.
- Performance: 200-layer comps — measure grid_layout and batch
  keyframe wall time; note anything over ~5s so the remote session can
  optimize.

## Out of scope for the local session (remote builds these)

- ComfyUI model catalog / bundled installer (needs the user's Krea
  workflow + model picks).
- Phase D animation utilities and Phase E roto/tracking hybrids
  (docs/NATIVE_COVERAGE_PLAN.md) — verify them when they land.
- Releases, version bumps, PRs into main, the update feed.
