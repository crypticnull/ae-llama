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

- ~~The triage calls AE's "Executing Script *" progress window an
  UNRECOGNIZED DIALOG and fails the run~~ DONE 2026-08-30, and the
  filed symptom was not the defect. What actually stopped those runs
  was **Windows' own chrome**: `SysShadow` (a tooltip's drop shadow)
  and `tooltips_class32` are visible, wordless, top-level windows of
  the AfterFX process, and a wordless popup outranks a running script —
  so AE's drop shadow outvoted AE's own progress window and a suite
  that went on to pass 514/514 exited 4. Filtered in both layers, with
  the real-AE capture replayed as a stub test (8 assertions fail
  without the fix). The harvest learned the progress window too.
- **STILL OPEN, filed by that pass: what is the `DroverLord - Window
  Class` popup?** It stopped one field run in five, with the same three
  containers as the save-changes prompt and no words, and the re-run
  was green. It is now READ (the harvest was widened past `#32770`) and
  photographed (a blocked run always shoots, whatever the harvest
  recognised), so the next occurrence leaves evidence in
  `logs\dialogs\`. Do NOT widen `CloseWordlessDialogs` to answer it
  blind. See WORKPLAN-LOG 2026-08-30.

## FAST-TRACK: comp-rename audit tools — DONE 2026-08-25 (0.9.15)

The owner has a real work assignment: bring an old roofing-presentation
project's comp names onto the org convention. The panel cannot do it
safely today, and the missing pieces are two tools. Probe-first as
always; this outranks the feature track because a human deadline hangs
on it.

**Probe pass** (facts before code):
- `item.usedIn` — does it return what training says (array of comps
  containing this comp as a layer)? Cost on a large project?
- Project-wide expression scan — walk every comp/layer/property,
  collect `prop.expression`; wall time on a big real project.
- THE assumption behind rule 3: does renaming a comp actually BREAK
  `comp("Old Name")` string references in AE 2026, or does modern AE
  rewrite them? Build a two-comp rig, rename, check expressionError.
  If AE rewrites, the skip rule relaxes and the log says so.

**Build pass** — two tools:
- `audit_comp_usage`: per comp — usedIn list, render-queue membership,
  and every comp whose NAME appears inside any expression string
  project-wide. Facts only, no judgments.
- `rename_comps`: takes the FULL rename map in one call (sidesteps the
  8-commands-per-reply cap), `dryRun: true` is the DEFAULT and returns
  the preview table; `dryRun: false` executes in one undo group.

**Naming rules (owner-confirmed):**
- Year present in the OLD NAME -> prefix `REVyy_` (two-digit: 2026 ->
  `REV26_`), prepended, old name kept: `REV19_Roof_Shingle_2019_v2`.
- Year detection is CONSERVATIVE: 4-digit 19xx/20xx only. A bare "26"
  or "v26" is a version number, not a year.
- No year -> prefix `REV_NO-YEAR_`, old name verbatim.
- Already `REV\d\d_` or `REV_NO-YEAR_` prefixed -> skip (idempotent;
  running it twice must change nothing).
- Two DIFFERENT years in one name -> no guess; flagged in the preview
  for the human.
- Expression-referenced comps (per audit) -> HARD skip with reason.
- Likely-utility comps (nested in others, never render-queued) ->
  marked in the preview and skipped BY DEFAULT, human can override —
  the audit supplies facts, the human owns the judgment.

**Suite/stub:** stub the project walk (usedIn, expressions, queue) and
assert: year extraction table incl. the v26 trap, idempotency, hard
skip on expression reference, preview-before-execute. Selftest: a
3-comp scratch rig (one nested, one expression-linked, one plain) —
audit facts correct, dry run correct, execute renames ONLY the plain
one.

Patch-bump when verified: it fixes no shipped behavior but the owner
needs it ON the panel — call it the exception that ships as a patch,
noted here so nobody relitigates it.

## 2. Real-AE verification debt (things stubs cannot prove)

Verify each by scripting AE directly (temp .jsx + AELL_call, see
CLAUDE.md). Where behavior is wrong, fix + extend selftest.js.

DONE — do not re-verify (see WORKPLAN-LOG.md): grid rig under both
expression engines, center_anchor_point on rotated/scaled/parented and
animated layers, scale_comp with cameras/keyframes, text styling and
font validation, cameras in the suite (old item 2b).

ALL FIVE remaining bullets are now DONE. The four below were finished
2026-08-21 and the text simply never got struck, which cost a later
pass a re-read of the log to work out what was left — so they are
struck now:

- ~~split_layer_into_chunks on real FOOTAGE~~ DONE 2026-08-21.
- ~~distribute_property step mode; reorder_layers stack order~~ DONE
  2026-08-21 (found three real bugs; see the log).
- ~~set_mask_path keyframes actually ANIMATE~~ DONE 2026-08-21.
- ~~for_each_layer across 50+ layers, and 200-layer timings~~ DONE
  2026-08-21 (timings in the log; nothing over ~1s).
- ~~add_light~~ DONE 2026-08-26. Built, documented, stub-tested and
  covered by 19 real-AE suite steps (harness 187 -> 206). All five AE
  2026 types incl. ENVIRONMENT, per-type grounded refusals from a
  matrix measured in the field, validate-before-create. NOT bumped:
  a new tool rides the next MINOR, which is the remote session's.

Item 2 is CLOSED. The next pass should start at 2d (H3 i2v workflow,
parts 1-3) or item 3/4, not here.

Two things this item surfaced that are NOT done, each worth its own
small pass rather than being smuggled in:

- ~~`scale_comp` still does not scale a LIGHT's pixel-valued options
  (falloff distance, shadow diffusion)~~ DONE 2026-08-28 (0.9.26).
  Radius, Falloff Distance and Shadow Diffusion now scale with the comp,
  keyframes included, parented or not, gated by the type+falloff matrix
  measured in the field; angles and percentages are left alone. The probe
  also found two AE lies the tool was believing — an ambient light was
  reported as a FAILED layer because AE hides its Position, and a point
  light reports autoOrient 4214 like a two-node spot and then refuses its
  Point of Interest. Harness 262 -> 277.
- ~~`get_property` cannot reach `Radius` or `Falloff Distance` by bare
  name~~ DONE 2026-08-28 (0.9.27). The probe found the gap was never
  about lights: AE's layer-level shortcut is a fixed list with an
  arbitrary edge (a light answers Intensity and Cone Angle but not
  Radius; a solid answers Opacity but not its own effect's Blurriness; a
  shape layer answers Contents but not Size), so any bare name AE refuses
  is now searched down the real tree, roots in a measured order with
  Layer Styles LAST - AE ships all eleven on every layer whether or not
  one was applied, and they would otherwise outrank the property the user
  meant. Ties are refused with both real paths; the result names the path
  it found. Harness 277 -> 289.

**Item 2 has nothing left. The next pass starts at item 3, 4 or 5.**

## 2c. Inventory the owner's real ComfyUI install — DONE 2026-08-25

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

## 2d. Small local passes queued by the probe findings — CLOSED
2026-08-28 (0.9.23). Everything in this section is done: the H3 i2v
workflow through part 4, the portability pass part 4 filed, and — last —
KREA2, which now ships adapted, seeded, rule-complete and rendered end to
end through the panel into AE (17s authored / 10s bare, both 1232x1232).
Nothing below needs doing; the text is kept because the reasoning in it
is what the next template will be built against. **The next pass starts
at item 3, 4 or 5.**

- ~~Locate the H3 base weight~~ FOUND by the owner (2026-08-25):
  `AppData\Local\Comfy-Desktop\ComfyUI-Shared\models\diffusion_models\`
  — a THIRD root, the Desktop app's shared auto-download store. Remaining
  5-min task: list that whole ComfyUI-Shared\models tree (two files
  matched the H3 filter — record exact names + sizes) and append it to
  docs/COMFY_LOCAL_INVENTORY.md; the register matcher's root list is
  now Documents + code install + ComfyUI-Shared + node ckpts dirs.
- ~~**Verify the history trim**~~ DONE 2026-08-25 (0.9.17), re-confirmed
  2026-08-26. Original text: (probe steps 9–10) the remote session
  bounded what the model is sent (Tools.fitHistory + a hard-trim retry
  on context 400s). Re-run the full chat probe — steps 9 and 10 died on
  context overflow before; they should now complete, with the "context
  trimmed" notice appearing once. Green -> patch bump, this fix plus
  the set_property->for_each_layer redirect ship together.
- **H3 i2v workflow RECEIVED** (AE_LLAMA_H3_I2V_V1 + manifest): the
  fl2va weight covers BOTH t2v (no image) and i2v, superseding r2v as
  the first H3 target. Local pass, in order:
  - ~~(1) template adaptation~~ DONE 2026-08-26. It was bigger than the
    manifest thought: EVERY bundled workflow is UI-format and
    `loadWorkflow` refuses UI-format, and `extension/workflows/` is not
    the seed dir either. So the pass built the conversion instead —
    `scripts/harvest-comfy-node-defs.py` (+ the checked-in defs) and
    `scripts/adapt-workflow.js`, handling positional widget decoding,
    control_after_generate, V3 dynamic combos, autogrow groups and
    bypass rewiring. Output is seeded at
    `extension/comfy-workflows/AE_LLAMA_H3_I2V_V1.json` and passes
    ComfyUI 0.32.0's own `validate_prompt` (`valid: true`). See the log.
  - ~~(2) wire the manifest `procedural` injection points into comfy.js
    injectParams~~ DONE 2026-08-26. injectParams takes the manifest as a
    third argument and honours `procedural` (prompt, durationSeconds,
    resolution, firstFrame) with grounded refusals; `comfy_generate`
    gained `durationSeconds` (a `frames` arg on a seconds template is
    REFUSED, not converted) and `image` (uploaded to ComfyUI's input dir
    via the new `Comfy.uploadImage`). With no image the reference
    LoadImage is DETACHED and the graph runs t2v, so the template no
    longer names a one-machine PNG. Both paths return `valid: True` from
    ComfyUI 0.32.0's own validate_prompt. See the log.
  - ~~(3) ONE real generation end-to-end through the panel to verify~~
    DONE 2026-08-27 (0.9.21). It ran: prompt -> ComfyUI -> mp4 -> AE, 12s,
    VRAM peak 28.4 GB. Built `scripts/comfy-probe.js` (the ComfyUI half of
    chat-probe) and it immediately found what three validate_prompt passes
    could not: ComfyUI's `%date:...%` filename tokens are expanded by the
    FRONTEND, never the server, so the panel's own posted graph died at
    SaveVideo on a colon Windows will not accept. Fixed in comfy.js and
    covered by tests/test-comfy-filename-tokens.js. See the log.
  - ~~(4) attribute the manifest's UNKNOWN nodes~~ DONE 2026-08-27. Done
    for ALL THREE bundled workflows, from the running loader's own
    `/object_info` rather than by grepping pack sources. It found more
    than a placeholder: the i2v manifest that already said "attribution
    scanned" was missing two packs the SHIPPED template loads
    (ComfyUI-sol-attn, ComfyLiterals) and named three classes wrongly.
    `scripts/attribute-workflow-nodes.js` regenerates it;
    `tests/test-workflow-manifests.js` fails CI if a manifest and its
    graph ever disagree again. See the log.
  - ~~**NEW, from part 4:** the shipped H3 i2v template hard-requires SIX
    custom packs and only RTXVideoSuperResolution is declared bypassable~~
    DONE 2026-08-28 (0.9.22). All seven undeclared classes are removable:
    four MODEL patches bypass through `model` and collapse the chain to
    `148 -> 163 -> 139`, two are incidental, and ComfyLiterals' `Float`
    could not be bypassed at all (a literal source has nothing to rewire
    to), so `optionalNodes` gained `substitute` and it becomes core
    `PrimitiveFloat`. Measured on a freed GPU: bare 18s / 31349 MB vs
    authored 20s / 31285 MB, and the bare graph imported into real AE at
    544x288 with audio. `comfy-probe.js --bare` renders the fallback
    graph on demand; test-workflow-manifests now FAILS any shipped
    template with a non-core class that has no removal rule. See the log.
  - ~~Also surfaced, its own small pass: the KREA2 template contains a
    SUBGRAPH the converter refuses to flatten~~ CONVERTER DONE
    2026-08-28. It did not need the /history route after all:
    `adapt-workflow.js` now flattens subgraphs inline as
    `<instance>:<inner>` (ComfyUI's own id scheme), drops rgthree's two
    frontend-only nodes, and — the part nobody had noticed — emulates
    cg-use-everywhere's `Anything Everywhere`, which draws NO wire and
    carries MODEL/CLIP/VAE/LATENT to nine sockets in this graph. The
    converted KREA2 returns `valid: True` from ComfyUI 0.32.0's own
    `validate_prompt`. See the log. Original text: Route that works — queue
    it once in ComfyUI and pull the executed prompt from `/history`
    (the owner's `get-api-workflow.ps1` already does this). H3 r2v is
    still unconverted too. Two facts for that pass, measured 2026-08-27:
    the subgraph is "Initial Loader" and holds only UNETLoader/VAELoader/
    CLIPLoader (all core), and `adapt-workflow.js` FRONTEND_ONLY knows
    about Note/MarkdownNote but not rgthree's `Label (rgthree)` or
    `Fast Groups Bypasser (rgthree)`, which KREA2 uses and which are
    provably absent from the server.
  - ~~**KREA2, what is LEFT before it can ship**~~ DONE 2026-08-28
    (0.9.23). All five rules written and measured, `procedural` block
    written (prompt only — resolution and seed are already covered by
    injectParams' generic walk, and the manifest says so), and TWO real
    generations run: the authored graph and the `--bare` one, both
    landing 1232x1232 in real AE. Three things the pass found that the
    item did not anticipate: `Power Lora Loader` emits MODEL **and**
    CLIP, so `passthrough` had to grow a per-output-slot map or the text
    encoders would have been handed a MODEL; `SesquiLatentUpscale` had
    to be SUBSTITUTED (core `LatentUpscaleBy`) rather than bypassed,
    since dropping it silently shrinks the output 1.6x; and the
    authored SaveImage prefix was an ABSOLUTE one-machine path that
    ComfyUI refuses anywhere else, now corrected through the new
    `panelAdaptation.setInputs`. See the log.
  - H3 r2v is still unconverted — deferred until 5.8 lands, since it
    needs image+audio inputs the panel cannot feed yet.
- ~~**Pin H3 t2v/i2v files**~~ DONE 2026-08-25, in the log entry "item
  2d: shared root, history trim, H3 pins, set_solid_color" — all 30
  files are recorded in `docs/COMFY_TIERS_PLAN.md`. Re-listed from the
  HF API on 2026-08-28: unchanged, nothing new in the repo. The text
  simply never got struck, which is the second time that has cost a
  pass a re-read of the log.
- ~~**clearExpressions in real AE**~~ DONE 2026-08-26 (0.9.18). Verified
  in the field: refuse-then-recall-with-flag is what the model does, and
  the nine squares land on even gaps. Two defects found on the way and
  fixed at their roots — hostscript now publishes `$.global.AELLJSON`
  (chat-probe's verdict reads had been failing silently AND wedging AE on
  a modal), and the overriddenByExpression note now asks for the SAME
  layers list on the re-call, because handing back only the blocked ones
  re-spaces those and strands the layers that already landed. See the
  log entry. Original text:
  the step-7 policy question is settled — distribute_property takes
  `clearExpressions: true` (clears ONLY expressions that swallowed the
  write, on an explicit re-call; see the log entry). Local pass: run the
  187-step suite (4 new steps in the order comp), re-run chat-probe
  step 7 — expected shape is now refuse-then-recall-with-flag, and the
  existing even-gaps verdict measures exactly that end state — then
  patch bump together with whatever else is verified.
- ~~**set_solid_color**~~ DONE 2026-08-25 (0.9.17) — built, and it
  closed chat-probe step 9. Original text: no tool can change a solid's color
  (probe step 9's real blocker — the model tried four approaches; none
  exist). The color lives on the SOLID SOURCE, so changing it changes
  EVERY layer sharing that source — duplicate_layer and
  split_layer_into_chunks share sources, so this trap is the panel's
  normal case, not an edge. Probe: is solidSource.color writable; what
  does AE do when the source is shared; can a layer be given its OWN
  copy first (the Solid Settings "New" checkbox, from script). Build:
  set_solid_color {layer(s), color, makeUnique?: bool} with the shared-
  source consequence stated in the result either way.

## 3. Extend selftest.js coverage — FIRST SWEEP DONE 2026-08-28 (0.9.24)

Every verified behavior from (2) becomes a permanent step in
`extension/js/selftest.js` (both the panel button and the harness pick
it up automatically). Keep results compact; steps must clean up after
themselves inside the scratch comp.

The sweep against the computed gap list in `docs/CAPABILITIES.md` ran on
2026-08-28: 214 steps -> 260. Light keyframes closed the gap that shipped
with `add_light`, and a coverage rig gave `add_control`, `add_keyframe`,
`remove_keyframes`, `set_layer_3d`, `apply_expression_preset`,
`list_properties`, `list_effects`, `set_comp_setting`, `duplicate_comp`,
`rename_item` and `move_to_folder` their first real-AE steps.

FOUR tools are still uncovered and each is deliberate, not pending:

- ~~`add_marker`, `precompose`~~ COVERED 2026-08-28 (0.9.30) by item
  5.4 — 18 steps, after a probe found five silent losses in them.
- `add_to_render_queue` — item 5.5; it writes to the user's render queue.
- `import_file` — item 5.8; it needs a file on disk.
- ~~`organize_project` — **cannot be suite-tested at all.**~~ COVERED
  2026-08-28 (0.10.2) once it grew the `dryRun` argument this bullet
  asked for: six steps, PREVIEWS only. The preview must count the suite's
  own new comp, name the nested folder it refuses to file into, and leave
  the project panel byte-for-byte alone — that last step is the one the
  group exists for.

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
  - ~~the checklist never touches ComfyUI, undo across a mixed round, or
    a second chat turn that refers back ("make them blue instead").~~
    DONE. The undo and second-turn halves landed 2026-08-25 as steps
    9-11; the ComfyUI half landed 2026-08-28 (0.9.28) as steps 12-13 —
    "is the picture generator ready" and a real generation through the
    model into AE, judged on ctx.tools (a panel-side tool leaves nothing
    in the comp to read back). It found three defects on its first run,
    all fixed at the root: the probe never loaded comfy.js/setup.js at
    all, a dead comfyUrl told the user to install a backend they already
    had running on another port, and the shipped `example-txt2img`
    placeholder was offered to the model as a real workflow. See the log.
  - a round that fails PART WAY leaves its debris behind: when
    `duplicate_layer` errored before `add_solid` had a layer to copy,
    the model retried the whole round and the comp ended with TEN red
    squares, nine spread and one orphan parked at the centre. The tools
    each behaved correctly (grounded error, successful retry); what is
    missing is any notion of rolling a failed round back.
- ~~Undo hygiene: one Ctrl+Z per chat command~~ DONE 2026-08-21 via
  AELL_callBatch.
- ~~ROLLBACK for a round that fails part way~~ DONE 2026-08-25 (0.9.14).
  A round where one mutating command failed and another succeeded is
  undone whole, so the model's retry starts from the real state: the
  nine-squares sentence now yields nine, not ten. One Undo, issued
  inside the same AELL_callBatch execution that made the changes (AE
  blocks its UI throughout, so nothing of the user's can be on top of
  the undo stack), armed only when a net-zero sentinel proves the group
  is not empty, and verified by a before/after fingerprint — a mismatch
  gets ONE Redo and an honest "not rolled back", never a second Undo.
  Budget: one rollback per user request. A failing READ-ONLY tool does
  not trigger it. Four AE measurements gated the design; they and the
  answer to "what if it overshoots" are in WORKPLAN-LOG 2026-08-25.
  - ~~Rollback's reach over PROJECT ITEMS is unmeasured~~ MEASURED
    2026-08-29 (0.10.7). It reaches: comp creation, duplication,
    deletion, folder moves and renames all revert on the one Undo, and
    the shipped AELL_callBatch path was driven through each. The real
    finding was AELL_fingerprint - the check that proves the Undo landed
    where it started, and the only guard against it overshooting into
    the user's own last edit. Of 25 dimensions a mutating tool can
    write, AE reverted all 25 and the fingerprint saw 4; the blind 21
    (every comp setting, every layer switch, markers, the 3D-only
    rotations, a solid SOURCE's colour, a text layer's style) are
    recorded now. Harness 482 -> 490. Two limits stated in the log and
    left open on purpose: arbitrary property values beyond the transform
    basics, and folders that share a name.
  - ~~Whether `.parent =` compensation survives a child that is 3D under
    a 2D parent, or a parent with a keyframed transform~~ MEASURED
    2026-08-29 (0.10.8). Mixed dimensions survive: a 2D parent leaves a
    3D child's Z alone and a 3D parent's Z never reaches a 2D child (the
    compensation is a pure X/Y translation, measured). An ANIMATED
    parent does not - AE works the compensation out ONCE, at the
    playhead, so "nothing moved" is true at exactly one frame and the
    layer is 400 px away two seconds later; a keyframed child's MOTION
    changes, not just its numbers; and an expression-driven parent does
    it with ZERO keyframes. set_layer_parent now reports
    `parentAnimated` and `compensatedAt`, and takes `atTime`/`atFrame`
    to pin the frame that must not move. Harness 490 -> 498.
- ~~Performance: 200-layer comps — measure grid_layout and batch
  keyframe wall time~~ DONE 2026-08-28 (0.9.29). The batch-keyframe half
  is measured and fine: at 200 layers set_keyframes (600 keys) 167 ms,
  apply_keyframe_ease 291 ms, remove_keyframes 517 ms, grid_layout
  872 ms, stagger_layers 53 ms, distribute_property 69 ms, scale_comp
  352 ms, for_each_layer apply_effect 313 ms. Nothing near the ~5s flag,
  as in 2026-08-21. What the same probe found is the follow-up this
  bullet had been carrying since then, and it is now fixed: **eleven
  tools serialize past the panel's per-result cap and every one of them
  reached the model as JSON cut mid-object.** compactToolResults now
  drops WHOLE ROWS with a count, the way budgetState already did for the
  state block, and the per-result cap is a fair share of the round's
  6000 rather than a fixed 1200. See the log.
- ~~**organize_project gets clean_project's dry-run shape**~~ DONE
  2026-08-28 (0.10.2). Built to the spec: `dryRun` defaults to true, the
  preview names each move (item -> folder) with capped lists and full
  counts, execute reports moved/notMoved after checking where each item
  actually landed, and six suite steps cover the PREVIEW (an execute step
  would file the user's own project). The probe that opened the pass
  found a shipped bug the spec could not have known: the destination
  folder was looked up by name ANYWHERE in the tree, so two root comps
  were filed into a user's nested `PR Archive/Comps`. Destinations are
  now root-only and a nested homonym is named in the result instead.

- ~~**Harness dialog triage learns to READ before it answers**~~ DONE
  2026-08-28. Built to the spec, with the one line the spec implied and
  this pass had to make explicit: the harvest is EVIDENCE and is
  deliberately NOT fed to `Get-AellDialogVerdict`. That verdict is what
  gates the pre-launch answer, and it fires on `unreadable` — so making
  the save-changes prompt readable would have flipped it to `blocked`
  and stopped the harness answering the one dialog the mechanism exists
  for. Same answer set as before, now with the words and a picture.
  Measured: the text lives in an `Edit` child whose `GetWindowTextW` is
  empty and whose `WM_GETTEXT` is the whole sentence, in CURLY quotes;
  AE draws its dialog frame offset from the rect Win32 reports, so the
  screenshot is of the whole virtual screen and the dialog is moved to
  the corner and raised first. Verified in real AE on all three paths
  (a deliberate addComp error alert → UNRECOGNIZED + readable PNG, the
  save prompt → named, no PNG, no marker, and two clean back-to-back
  runs), 391/391 each time. No version bump: the panel ships
  `extension/` alone. Original spec:
  before CloseWordlessDialogs answers a `#32770`,
  (1) collect WM_GETTEXT from every child control and log it;
  (2) if that yields nothing, move the window on-screen and save a
  screenshot to `logs\dialogs\<timestamp>.png` (measured readable on
  2026-08-28);
  (3) auto-answer as today either way — unattended must proceed — but
  when the harvested text matches nothing known-benign (the
  save-changes prompt, empty), mark the pass log UNRECOGNIZED DIALOG
  with the PNG path so the morning review sees it. Never a new refusal
  path: the change is evidence, not behaviour.

- **NEW, filed by the ComfyUI probe steps 2026-08-28, each its own small
  pass:**
  - ~~**A generation that fails does not get retried.**~~ ALREADY FIXED,
    and the evidence is in the entry that filed it: 0.9.28's own field
    run has the model invent `simple_image`, take the grounded
    "Available: AE_LLAMA_H3_I2V_V1, AE_LLAMA_KREA2_V1" error, re-plan
    onto KREA2 and render. A rejected workflow is no longer a rejected
    request, so no prompt rule is needed. Struck 2026-08-28 without
    spending a pass on it. Original text: ComfyUI rejected the workflow
    the model chose; the model had four rounds left, said "let's try a
    different approach or workflow", and stopped.
  - ~~**A bundled workflow template never reaches an existing install
    once it has been seeded.**~~ DONE 2026-08-28 (0.10.1). Built to the
    spec below, with one thing the spec could not have known: hashes are
    taken over CRLF-NORMALIZED bytes. Git checks these templates out with
    the platform's line endings, so on this machine the installed H3
    template and the bundled one differed in raw bytes and in nothing
    else - a raw-byte hash would have called an identical file a user
    edit. Verified in the field: seeding against the real
    %APPDATA%\AE-Llama refreshed the one genuinely stale file (the H3
    i2v manifest, five releases behind), reported the other five as
    current, overwrote nothing, and the second run was a no-op. Also
    measured: `git log -- path` lists one commit for the H3 template
    where `--all --full-history` lists three, so the seeder walks the
    full history. Original spec:
    (1) `scripts/workflow-hash-history.js` maintains
    `extension/comfy-workflows/.hash-history.json`: for every bundled
    template/manifest, an APPEND-ONLY list of the sha1 of every version
    ever shipped. Run mode appends the current files' hashes if new;
    `--check` mode fails when a bundled file's current hash is missing
    (CI-enforce it next to capability-report). Seed the history by
    hashing every version of each file in `git log` so EXISTING stale
    installs are covered.
    (2) `ensureDataDirs` seeding rule per file: absent -> copy. Present
    and its hash appears in the history -> it is an UNEDITED shipped
    copy (possibly stale) -> overwrite with the current bundle. Present
    and hash unknown -> the USER edited it -> never touch it.
    (3) Stub tests: fresh seed, stale-unedited overwrite, user-edited
    preserved, history --check catches an unrecorded bundle change.
    No version bump gate: bump patch once verified (it fixes shipped
    behaviour — this machine still lacks templates shipped 5 versions
    ago).
- ~~**`set_layer_3d` loses the Z in silence.**~~ DONE 2026-08-28 (0.9.25).
  A second probe measured the FULL loss (Scale Z resets to 100 rather
  than zeroing, Orientation and X/Y Rotation clear, keyframe values are
  flattened in place, and turning 3D back on restores nothing), and the
  tool now reads those values before the write and returns them in
  `discarded`. It still does not refuse and does not restore. Three suite
  steps and the stubbed tests cover it, including the ordering trap real
  AE caught: keyframes are read BEFORE an expression, or a wiggled
  Position reports its own noise instead of the Z on the next key.
  Original text below.

- **`set_layer_3d` loses the Z in silence.** Measured 2026-08-28: turning
  a 3D layer back to 2D zeroes the Z component of Position and Anchor
  Point (and the 3D-only rotations go with it), and the tool reports a
  plain `{threeD: false}`. A suite step pins the loss. This project's
  rule is that nothing disappears quietly, so the tool should report what
  the switch discarded — the same shape as `scale_comp`'s
  `layersSkipped`. Small: read the 3D-only values before the write,
  compare, and name the non-zero ones in the result. Do NOT refuse and do
  NOT restore them — the user asked for 2D.

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

### 5.1 Text animators — DONE 2026-08-28
Probed, built and covered in one pass. `add_text_animator` adds the
animator, activates every property named and configures the selector
(range/wiggly/expression/none), then reports the exact paths so the
EXISTING set_keyframes drives the selector — measured first, which is why
no keyframing was built into the tool. Eight AE facts made the design,
all in the log: an animator ships with all 103 properties present and
HIDDEN (addProperty un-hides), `canSetExpression` is the only flag that
tells added from dormant, adding a sibling animator invalidates every
reference into the earlier ones, AE lets two animators share a name and
answers a lookup with the first, percent selectors run -100..100, both
the percent and index triples exist at once and a name lookup always
finds percent, per-character 3D is a LAYER switch that drags threeDLayer
on and never gives it back, and "ADBE Text Rotation" IS the Z rotation.
The dormant-slot discovery also fixed shipped behavior: set_property /
set_keyframes / get_property / list_properties no longer leak AE's raw
"property or a parent property is hidden" for the hundred slots the
0.9.27 deep search can reach. 63 stub checks, 24 suite steps, harness
307 -> 331. Macros ("typewriter"/"cascade") stay PROMPT recipes as
planned; no version bump (feature track).

Original text: Probe: the property tree under "ADBE Text Animators" — add
an animator, an "ADBE Text Selectors" range selector, and animator
properties (position/opacity/rotation/scale at least); verify
Start/End/Offset percent paths and per-character-3D requirements. Build:
`add_text_animator` (generic, grounded errors listing available animator
properties) — macros like "typewriter"/"cascade" belong in the PROMPT as
recipes, not as separate tools. Highest value per line of code here.

### 5.2 Shape repeaters — DONE 2026-08-28 (0.9.31)
No `add_repeater` was built: `add_shape_content {kind: "repeater"}` had
shipped all along and the probe proved it works end to end. What did not
work was reaching it. A shape GROUP hides its items in a nested
"Contents" group AE's timeline never draws, so
`contents/<Group>/<Item>/<Param>` — the path this panel's own tool notes,
tool docs and system-prompt trim-paths recipe all handed the model —
resolved to nothing, and every "animate the repeater / wipe it on"
request failed on the panel's own instructions. The resolver now hops
that segment (a real child of the same name still wins), and
add_shape_content warns when a filter lands with no shape ABOVE it —
measured: a repeater appended after the rect renders 500px wide, the same
one moved to index 1 renders 100px. Copies floors at 0 with no max,
Composite is `ADBE Vector Repeater Order` 1..2. Ring/burst stays a PROMPT
recipe. Harness 331 -> 345. Original text below.

Probe: "ADBE Vector Filter - Repeater" under a shape group — copies,
offset, and the repeater transform block. Build: `add_repeater` {layer,
copies, position/rotation/scale/anchor offsets}. Verify the radial-burst
recipe (rotation 360/copies) renders as expected.

### 5.3 Animation preset library - DONE 2026-08-28
Probed, built and covered in one pass. `list_presets` indexes AE's 679
shipped .ffx files plus the user's own (679 walked in 117 ms, cached per
session); `apply_preset` applies one to layer(s). The probe answered the
item's own question with a worse fact than it expected: **applyPreset
acts on the comp's SELECTION, not on the layer it is called on** - two
layers selected, one call, BOTH changed - and with an EMPTY selection it
does not touch the receiver either, it invents a comp-sized solid and
applies the preset there. So the tool selects exactly its target and puts
the user's selection back. Six more measured facts made the design and
are in the log; the one that cost a suite iteration is that "a preset for
the wrong layer type does nothing" is only HALF true: a Text preset that
carries expression controls installs its six sliders on a solid and none
of the animation (census 2 vs 15 on a text layer), while one that carries
none does nothing at all. That partial landing is now reported. 63 stub
checks in `tests/test-presets.js`, 13 suite steps, harness 345 -> 358. No
version bump (feature track). Original text below.

### 5.3 Animation preset library
Probe: `layer.applyPreset(File)` on a stock .ffx — does it need the
layer selected, what does it do to selection (AELL_keepSelection?), and
enumerate what ships: Support Files\Presets\**\*.ffx + the user's
Documents\Adobe\After Effects*\User Presets. Build: `list_presets`
(cached, filterable) + `apply_preset` with the font-style grounded error
(near-matches by name). Hundreds of behaviors for the price of two tools.

### 5.4 Precompose + markers — DONE 2026-08-28 (0.9.30)
Probed, fixed and covered. Five silent losses were measured and are now
reported instead: precompose counted a REPEATED layer reference twice,
dropped a moved layer's parent when the parent stayed behind, left an
expression on a layer behind it pointing at a layer that is no longer
there (AE rewrites those only when moveAttributes is FALSE, and
expressionError stays EMPTY either way), let a SECOND project item take
the requested name — which makes the later one unreachable by name — and
threw away the user's selection. add_marker silently REPLACED any marker
already at that time, refused a quoted `time` the project's own rule says
to accept, and swallowed an unusable `duration`. Marker times turned out
to be COMPOSITION time on a layer as well, so nothing had to be
converted. 56 stub checks in `tests/test-precompose-markers.js`, 18 suite
steps, harness 289 -> 307. See the log. Original text below.

docs/CAPABILITIES.md's computed gaps caught this item about to build
duplicates: `precompose` and `add_marker` are in TOOL_DEFS today, with
zero stub tests and zero suite steps. So this item is (a) probe their
real behavior (precompose selection side effects, marker duration
handling), (b) fix what's wrong, (c) stub test + suite steps. Do NOT
build new tools here.

### 5.5 Render queue — DONE 2026-08-28
Probed, built and covered in one pass. `render_comp` renders a comp to a
file and waits; `list_render_templates` names this machine's templates
(and hands back a real writable folder, because "where do I put it" was
otherwise a guess). `add_to_render_queue` was fixed rather than
duplicated.

**The aerender question is settled: renderQueue.render() DOES work
headless from a `-r` session** — one frame in 181 ms, status DONE. So
aerender.exe is not used, and it would be the wrong tool anyway: it
launches a second AE against a SAVED .aep, while this panel drives a
live, usually-unsaved project.

Seven probes; three findings drove the whole design. (1) `render()`
renders the WHOLE QUEUE, not the item you added — so the user's queued
items are held back with `render = false` and put back. (2) An output
path that ALREADY EXISTS raises a MODAL, which wedged AE mid-probe and
then swallowed every later -r script while the process still looked
healthy; it is refused unless `{overwrite: true}`, and only then
rendered under `beginSuppressDialogs` (measured to genuinely overwrite,
64840 -> 698880 bytes, not silently skip). (3) The output module forces
its OWN extension on the `file` SETTER, both directions, so the path
reported is the one AE settled on. Also: a missing output directory
THROWS rather than prompting, `status` is readOnly, deleting a queued
comp silently drops its queue item (no dialog), and a fresh output
module inherits the LAST RENDER'S folder — which on the probe machine
was a ComfyUI directory unrelated to the project, so an outputPath-less
add now says where the bytes would land.

For 5.8: **`comp.saveFrameToPng(time, File)` EXISTS and works** — 407
bytes for 160x120, honours resolutionFactor, no viewer needed, comp.time
untouched, overwrites with no dialog. Its three silent failures are
measured and waiting to be handled: a bad folder is a SILENT no-op, an
out-of-range time CLAMPS and writes a blank frame, and a String path
throws (it demands a File). It also writes LAZILY — `File.exists` reads
false for ~300 ms afterwards, so output must be polled, not glanced at.

**AE cannot render inside an undo group.** Registering render_comp as
mutating earned a modal "Undo group mismatch" that wedges an unattended
AE, so it is exempt via the new `AELL_NO_UNDO_GROUP`, and a batch
containing one opens no group at all (closing and reopening the group
around just the render was tried first; AE rejects that too).

82 stub checks in `tests/test-render-queue.js`, 14 suite steps, harness
358 -> 372, green on three CONSECUTIVE runs. No version bump (feature
track). Original text below.

`add_to_render_queue` ALREADY EXISTS (uncovered — same trap as 5.4).
Probe what it does today, then extend rather than duplicate: actually
RENDERING headless — renderQueue.render() from a -r session vs the
aerender.exe alternative (decide which is stable unattended, log why),
output-module templates (enumerate + log; version-sensitive), grounded
template errors. Also probe single-frame paths here: saveFrameToPng if
it exists, else a one-frame render — needed by 5.8.

### 5.6 Project hygiene — DONE 2026-08-28
Probed, built and covered in one pass. `clean_project {action, keepComps,
dryRun}` runs exactly one of AE's three cleanup calls, previewing by
default. Five probes; the facts that shaped it are all losses AE does not
mention: `removeUnusedFootage()` also deletes EMPTY FOLDERS (recursively,
and it counts them in its return value), `reduceProject()` deletes a comp
that only an EXPRESSION names and leaves `expressionError` EMPTY, it
silently drops the render-queue items of the comps it removes, and it
ACCEPTS a footage item in the keep array and then deletes every comp in
the project (refused here). Also measured: footage used only by an UNUSED
comp is kept, `reduceProject([])` throws "Array is empty", and — unlike a
render — all three are ordinary edits that close an undo group cleanly
and are undone whole by one Ctrl+Z. So the preview NAMES what would go
and the execute path diffs AE's actual removals against that promise (the
two agreed exactly on every rig, in real AE and in the stub). 48 stub
checks in `tests/test-project-hygiene.js`, 13 suite steps, harness
372 -> 385. The suite covers PREVIEWS and REFUSALS only: every action is
project-wide, so executing one inside the user's open project would
delete the user's own items. No version bump (feature track).

Original text: Probe: removeUnusedFootage(), consolidateFootage(),
reduceProject() return values. Build: `clean_project` {action} —
reduceProject DELETES, so it requires an explicit comp argument and
reports counts; everything in one undo group. Refuse vague asks with a
grounded list of actions.

### 5.7 Audio to keyframes — DONE 2026-08-28
Probed, built and covered in one pass. The id exists (4218, and ONLY for
the exact string "Convert Audio to Keyframes"), but the sketch's `{layer}`
was disproven: the command ignores the selection and converts the whole
comp MIX of whatever comp is ACTIVE. Per-layer isolation is built on the
next measurement instead — a muted layer contributes an all-zero curve —
so `audio_to_keyframes {comp?, layer?, name?, range?}` mutes the other
audible layers for the conversion and un-mutes them again. Four more
measurements shaped it: the command is bounded by the WORK AREA (0.5..1.5
on a 4s/24fps comp gave 25 keys, not 97), it never uniques the null's
name (two runs, two layers called "Audio Amplitude"), it leaves nothing
selected, and with no audio-capable layer it creates nothing and says
nothing at all — no throw, no dialog — which is why the tool refuses
first and lists what IS in the comp. Suite coverage needed no audio file:
Tone on a solid flips `layer.hasAudio` to true and the converter hears it
(73 keys, peak 34.33 on 3s/24fps; two tones 36.02, which is what the
isolate/un-mute steps read). 66 stub checks, 13 suite steps, harness
391 -> 404. No version bump (feature track).

Original text: Probe: `app.findMenuCommandId("Convert Audio to
Keyframes")` — does the id exist, what selection/active-comp state it
needs, exact name of the created null and its slider paths. Build:
`audio_to_keyframes` {layer} returning the null + slider path ready for
link_property. Grounded error lists audio-capable layers. This plus
link_property = beat-driven anything.

### 5.8 Frame round-trip — DONE 2026-08-29
Probed, built and covered in one pass. `snapshot_frame {comp?, time?,
path, resolution?, overwrite?}` and `import_as_layer {path, comp?, fit?,
name?, position?}` are both almost entirely made of what AE does
SILENTLY, all measured: a missing folder is a no-op with no error, an
out-of-range time CLAMPS and writes a blank frame, an existing file is
replaced with no dialog and no undo, a comp at Half resolution writes a
half-size frame, PNG bytes go into whatever name is handed over (a
frame saved as .jpg is a PNG called .jpg), and a path the project
already holds is imported a SECOND time without a word. Two findings
shaped the design rather than a report: AE's "Fit to Comp" menu commands
do NOTHING with no comp viewer open, so the fit arithmetic is the
panel's own — reproducing their numbers exactly, pixel-aspect correction
on X included (320x240 par-1 into 720x480 par-1.2121 = 272.727 x 200,
not 225 x 200) — and `saveFrameToPng` is SAFE inside an undo group
(measured across three nested groups plus three more cycles), unlike
`renderQueue.render()`, so snapshot_frame is in `AELL_NO_UNDO_GROUP`
only to keep an un-undoable file write from arming a rollback. Reported
dimensions are read back out of the PNG's own header. `import_file`
finally got suite coverage too — it only ever needed a file on disk —
which closes the last "never exercised in real AE" gap. 100 stub checks
in `tests/test-frame-roundtrip.js`, 17 suite steps, harness 404 -> 421.
No version bump (feature track). Original text below.

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
~~Pass A: acquire~~ DONE 2026-08-29. `scripts/get-whisper.ps1` +
`scripts/lib/whisper-assets.ps1` (the choice, testable without a
network) + `tests/test-whisper-acquire.js`. Acquires into
`vendor\whisper.cpp\{bin,models}` — split so a binary update does not
re-download the 141 MB model — and verifies by synthesizing a WAV and
transcribing it: measured 818 ms for a 3 s clip, base.en, CPU. Facts the
probe paid for, all now pinned by tests: the newest tag can be an
asset-less prerelease; the archive nests under `Release\` and `main.exe`
is a deprecation shim (`whisper-cli.exe` is the transcriber); the models
are on HuggingFace under `ggerganov`, not `ggml-org` (which answers 401);
`Invoke-RestMethod` hands a JSON array back as ONE object, so `@()`
around it pools every release's assets together; and this machine's
nvidia-smi says "CUDA **UMD** Version", which the usual regex misses.
~~Pass B: verification harness~~ DONE 2026-08-29.
`scripts/lib/whisper-verify.ps1` (the round-trip, one implementation for
the acquirer, the standalone runner and the test),
`scripts/verify-whisper.ps1` (SKIP + exit 0 with no install, `-Require`
to make that a failure) and `tests/test-whisper-verify.js`, which runs
49 of its 52 checks with NO install present (verified by pointing
APPDATA at an empty folder). Field
facts this paid for: 2 s of SILENCE transcribes as " You", so "a
transcript came back" is not a check at all; whisper-cli writes nothing
to stdout on failure and ~6 KB to stderr, so draining stdout before
waiting on the process deadlocks (measured: a five-minute hang);
base.en writes numbers as DIGITS and the synthesizer's "pack" comes back
as "hack", so a verification phrase is a fixture that has to be
measured; and 44.1 kHz audio transcribes fine - the old "whisper refuses
anything but 16 kHz" note was wrong, which matters for Pass C's comp
audio.
~~Pass C: AE wiring~~ DONE 2026-08-29. Three tools, split so the two
ends can be tested where the middle cannot: `render_comp_audio` and
`add_captions` are HOST tools the self-test drives in real AE with no
speech model present, and `transcribe_to_captions` is the PANEL tool
that joins them (ExtendScript cannot spawn a child process).
`extension/js/whisper.js` finds the install and parses the segments.
Verified end to end in real AE: a 20 s comp of synthesized speech
rendered in 0.1 s, transcribed in 1053 ms, and became five caption
layers each trimmed to its own span. Field facts this paid for: a comp
with NO audio layer STILL renders a full, valid, audio-only AIFF (DONE,
772 674 bytes, no warning) and silence transcribes as the word "You" —
so the refusal has to come before the render or the feature's failure
mode is a confident wrong answer; `layer.inPoint` is a SLIDE that DRAGS
outPoint and preserves duration (in=2 in a 5 s comp reads back out=7),
so in is always set before out; AE accepts inverted and zero-length
spans in silence; in/out QUANTIZE to AE's own time base (0.3333 ->
0.33329264322917), so every comparison needs a tolerance; whisper.cpp
decodes AE's AIFF directly through miniaudio, so no WAV conversion and
no ffmpeg; and `om.getSettings()` throws while `setSettings({Format})`
answers "Property is read-only", so the audio format comes from the
output-module TEMPLATE, matched by name. 115 stub checks in
`tests/test-captions.js`, 16 suite steps, harness 498 -> 514. No version
bump (feature track).

### 6.2 ffmpeg post-renders
~~Pass A: acquire a static ffmpeg build the same way; verify with
ffprobe.~~ DONE 2026-08-30. `scripts/get-ffmpeg.ps1` +
`scripts/lib/ffmpeg-assets.ps1` (the choice, testable without a network)
+ `scripts/lib/ffmpeg-verify.ps1` (the round trip) +
`scripts/verify-ffmpeg.ps1` (SKIP + exit 0 with no install, `-Require`
to make that a failure) + `tests/test-ffmpeg-acquire.js` (55 checks).
Source is BtbN/FFmpeg-Builds; installs to `vendor\ffmpeg\bin`; verified
in the field at n9.0.1-11-ge47273f4d9. `Expand-AellReleaseList` moved to
the new `scripts/lib/gh-releases.ps1`, shared with get-whisper.

Field facts this paid for, all in the log: **ffmpeg exits 0 when it
refuses to overwrite an existing output**, writing nothing at all (real
errors return -22/-2, which is what makes the 0 believable) — so an
exporter that trusts the exit code hands the user last week's render;
without `-nostdin` that same case is an interactive prompt and it HANGS
FOREVER; `ffmpeg -t 0` writes a 262-byte MP4 with ZERO streams that
ffprobe then accepts with exit 0, valid JSON, empty stderr and
probe_score 100, so the only real check is reading width/height/frame
count back; matroska containers (.webm, .mkv) report NEITHER `nb_frames`
NOR `duration` on the stream, which made the first checker reject a good
VP9 file; the asset names are TWO schemes, not one, and matching
`-latest-` literally disables the dated-release fallback while every
positive test still passes; and `-encoders` is a COMPILE-time list —
h264_amf and h264_qsv are named by this build and both fail at encode
time here for want of a device.

**The licence question is settled by measurement, and the answer is
LGPL.** The LGPL build has no libx264/libx265, but it does have
**libopenh264** (software H.264, works: exit 0, real h264, 37 ms) plus
h264_nvenc and h264_mf. So Pass B needs no GPL binary in a commercial
product — default to libopenh264 and treat hardware encoders as an
opt-in that must be tried, not trusted.

~~Pass B: `export_gif` / `export_social` {comp, path, size, fps} =
lossless render via 5.5 piped through ffmpeg, temp files cleaned.~~ DONE
2026-08-30. `extension/js/ffmpeg.js` (the panel's find/plan/build/VERIFY,
mirroring whisper.js) + the two PANEL tools in `tools.js` +
`tests/test-ffmpeg-export.js` (122 checks, no binary and no AE — the
child process is scripted with captured field output). Verified end to
end in real AE: a 3 s 1080p30 comp exported to a 480x270 GIF and to
1080x1920 H.264 in ~2.8 s each, master cleaned every time.

Field facts this paid for, all in the log: AE's "Lossless" module writes
**rawvideo/bgr24 AVI that ffmpeg reads natively** — and it costs
width*height*3 PER FRAME (6 224 440 B/f at 1080p, 1.87 GB for ten
seconds), so the master is estimated and REFUSED before the render
rather than discovered when the disk fills; that same AVI **carries the
comp's audio** as pcm_s16le, so one intermediate serves both streams;
**a trimmed WORK AREA silently shortens the render** (a 3 s comp trimmed
to its middle second renders ONE second and reports DONE), which is now
reported rather than discovered; the bottom-up-BGR upside-down trap does
NOT apply to AE's AVI (measured, (0,0) stays red — do not add a vflip);
and **h264_nvenc refuses a frame under about 145x49**, so the encoder
trial that Pass A demanded had to run at the export's REAL size — the
first version used a fixed 64x64 and a working NVIDIA card fell through
to h264_mf in silence, caught only because the field run disagreed with
the hardware in the box.

Not built, deliberately: `.webm`/VP9 and animated `.webp`, both refused
by name with the list of what IS written. A GIF/MP4 pair is the ask;
the third format is a remote-session call about whether libvpx's speed
is acceptable.

~~Pass B follow-up: the intermediate is always the FULL comp size, then
scaled by ffmpeg — a `resolution` argument on `render_comp` would make
this much cheaper.~~ DONE 2026-08-30. `render_comp` takes
`{resolution}` and both exporters take `{masterResolution}` (plus
`"auto"`, the largest reduction that still covers the output; a
reduction that would land UNDER the requested size is refused rather
than upscaled). The probe paid for the fact that decides its shape: the
render-queue ITEM answers `getSettings()` where the OUTPUT MODULE
throws (6.1 Pass C measured that throw), Resolution is written by NAME
and nothing else, `getSetting` answers the pair and `getSettings` the
name — and `applyTemplate` RESETS Resolution to Full, so it is set
AFTER both templates or the argument silently does nothing. The
rendered frame is `ceil(dim/factor)` per axis, not floor: 641x361 at
half is 321x181. Measured payoff on a 10 s 1080p comp to 480x270: the
master went 1.74 GB -> 116 MB, the wall clock 6.6 s -> 6.0 s. So it
buys HEADROOM — an export the intermediate cap refused now runs — not
speed. Opt-in on the export side, because nobody has measured AE's own
downsampler against ffmpeg's on real footage. Harness 514 -> 517.

## 7. Tier P4 — real-GPU measurement (local; P1–P3 landed 2026-08-25)

The remote half of docs/COMFY_TIERS_PLAN.md is in: tiers.js (T0–T7 +
planHandoff), the VRAM arbiter in tools.js (pause once per round,
verified release via Setup.queryVramUsedMB polling, ComfyUI /free
before the chat model returns, grounded refusal under pause "never"),
comfyPauseLlm tri-state, vramOverrideGB, comfyModelRoots, the combined
recommendSetup line, and COMFY_CATALOG (all PROVISIONAL). Stub suites:
test-tiers, test-vram-arbiter, test-settings-migrate, extended
test-model-catalog / test-comfy-backend. NONE of it has touched a real
GPU. This item is that touch, one pass per bullet, smallest first:

- ~~**Handoff smoke on the 5090, no override**~~ DONE 2026-08-30 (0.10.9),
  and it found that the concurrent path had never been reachable.
  `scripts/handoff-probe.js` drives the real panel path (settings + tiers
  + llama.js + comfy.js + tools.js) against a real llama-server, a real
  ComfyUI and real nvidia-smi, in two rounds. **Every shipped manifest
  carries `file`+`dir` and NO `sizeMB`**, so `genNeedMB` was null for
  every template ever shipped: the arbiter answered "the fit cannot be
  verified" and a 32 GB card paused chat for every generation it could
  have run beside it — while T6/T7's own copy promises "per-job
  arithmetic". The weights are now MEASURED on disk across the panel's
  model roots. Numbers: 7B chat 6002 MB + KREA2 18110 MB on a 32 607 MB
  card -> CONCURRENT, peak **29 064 MB**, 10 s, chat holding the card
  throughout; vramOverrideGB 8 -> handoff, 9736 -> 4004 MB, 14 s, chat
  warmed back up. See WORKPLAN-LOG 2026-08-30.
- ~~**Probe /free support**~~ ANSWERED 2026-08-30. ComfyUI 0.32.0 answers
  **HTTP 200** with an empty body to POST /free {unload_models:true,
  free_memory:true} in ~65 ms. The observed VRAM delta is **0 MB**, and
  that is not a failure: this backend drops a finished generation's
  ~19.5 GB *on its own*, about ten seconds before the round ends, so
  /free routinely has nothing left to release. No fallback build item.
  What it DID cost was a bug — the resume waited for a further drop from
  a baseline sampled after that release, which can never come, so every
  paused round paid a 10 s timeout and said "VRAM did not visibly
  release". Fixed: the resume aims at the absolute floor the pause left.
- ~~**pause "never" refusal in the field**~~ DONE 2026-08-30 (0.10.10),
  and it holds: it is now `chat-probe.js` **step 14**, permanent. Asked
  for a picture on an impersonated 8 GB card with pausing off, the model
  invented a workflow name, took the grounded "Available:" error,
  re-planned onto KREA2, got the refusal and relayed it — "The
  generation requires more VRAM than is currently available. Please
  pause the chat during generation or stop the chat server and try
  again." Two defects paid for the run: the refusal quoted an
  IMPERSONATED card size as if it were real ("the chat model holds
  ~20 GB of the card's 8 GB" — a measured 32B against a fictional
  budget), now annotated "(VRAM override)"; and `.hash-history.json`
  was being listed as a workflow, sorting FIRST, so a generation that
  named no workflow ran the seeder's hash record as a graph. Steps get
  a `settings:` block that patches the cached settings object and
  restores it — never `Settings.set`, which mirrors to the owner's real
  settings.json. See WORKPLAN-LOG 2026-08-30.
- **Measure the catalog**: for each downloadable entry that fits the
  card (sd15, sdxl, wan22-5b, minimax-h3): real VRAM delta during a
  generation (nvidia-smi peak − idle), wall clock, and whether the
  fixed sizes in version.js COMFY_CATALOG are honest. Flip
  measured:false → true with the number IN the entry, patch bump.
  Correct any dead download URL the same way (they are
  training-quoted; HF was unreachable from the remote session).
- **Tier impersonation ladder**: vramOverrideGB 4/6/8/12/16/24 — each
  budget must produce the matching tier line in settings, the matching
  catalog picks, and a handoff (or refusal) consistent with
  planHandoff. The 5090 exercises every PATH; timings on small cards
  stay training-quoted and must keep saying "typically".
- **OOM recovery**: force one real OOM (override 6, generate something
  known too big with pause never overridden off — or drive ComfyUI
  directly) and verify the chat model comes back afterward regardless.

## Out of scope for the local session (remote builds these)

- ComfyUI bundled node-pack installer and wiring generation into
  5.8's round-trip; tier-plan P5 (final video file pins per tier).
- Phase E roto/tracking hybrids. (Phase D animation utilities are now
  largely items 5.1–5.7 above — do not double-build them.)
- The rollback DESIGN in item 4 may be built only after the remote
  session reviews the proposal.
- Minor/major version bumps, PRs into main, release notes. PATCH bumps
  are YOURS: `node scripts/bump-version.js patch` before pushing a fix
  you verified in real AE, or it never reaches a panel (see CLAUDE.md).
