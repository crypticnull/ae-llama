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

## 2b. Cameras in the real-AE suite (build AND verify in one pass)

The 26-step harness never touches cameras, which is why #28 shipped a
camera fix that could not reach its own branch. The stub now encodes the
two facts learned (hidden Scale is resolvable but not settable; POI is
writable only when autoOrient is CAMERA_OR_POINT_OF_INTEREST), so CI
catches a code regression — but nothing catches AE itself behaving
differently, or the same surprise on another layer type.

Build this here rather than remotely: it needs a dedicated scratch comp,
and blind AE code has been wrong twice today. Suggested shape —

- Its OWN scratch comp, created and deleted inside the step group, so a
  camera cannot disturb the 2D steps in the main one.
- Both camera types: `addCamera` (autoOrient 4214) and a one-node
  camera (4212). Assert scale_comp halves zoom on both, re-centres POI
  on the aimed one, and leaves the one-node camera's aim alone.
- Assert `layersSkipped` is EMPTY. That is the assertion that would
  have caught #28 — the tool reported its own failure honestly and
  nobody was reading it.
- A light as well, if cheap: same aim-not-scale rule, no zoom.

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
  - `stagger_layers` `spread` is a TOTAL, but users say "4 frames
    apart" and the model dutifully sends `spread: 0.133` for nine
    layers (0.5 frames each). Wants a per-layer `step`, or docs that
    make the total unmissable.
  - `add_text_layer` inherits AE's last-used character panel style —
    a probe asking for 120px white got tracking 251 and
    PowerCentra-Book. Decide whether the tool should normalize.
  - the checklist never touches ComfyUI, undo across a mixed round, or
    a second chat turn that refers back ("make them blue instead").
  - a round that fails PART WAY leaves its debris behind: when
    `duplicate_layer` errored before `add_solid` had a layer to copy,
    the model retried the whole round and the comp ended with TEN red
    squares, nine spread and one orphan parked at the centre. The tools
    each behaved correctly (grounded error, successful retry); what is
    missing is any notion of rolling a failed round back.
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
