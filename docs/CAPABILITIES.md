# AE Llama — capabilities

The one place to see everything the panel can do, kept honest two ways:
the tool inventory below is **generated from the code** (CI fails if it
goes stale), and the curated sections are edited by whoever ships the
feature they describe. Use this to look at the product whole and ask
"what's missing?" — the answers feed `docs/WORKPLAN.md`.

## Chat → After Effects tools

<!-- BEGIN GENERATED TOOL INVENTORY (scripts/capability-report.js) -->

_Regenerate with `node scripts/capability-report.js` — CI fails if this section is stale._

**60 tools** (52 mutating, 8 read-only; 57 host-side, 3 panel-side).

| Tool | Does | Writes | Side | Stub tests | Suite steps |
|---|---|---|---|---|---|
| `add_camera` | Add a camera | yes | host | — | 3 |
| `add_control` | Add a named expression control (Slider/Angle/Checkbox/Color/Point Control effect) to a layer — usually a null | yes | host | 1 | 4 |
| `add_keyframe` | Add a keyframe on a layer property at a time (seconds) | yes | host | 1 | 10 |
| `add_light` | Add a light | yes | host | 1 | 13 |
| `add_marker` | Add a marker to the comp (omit 'layer') or to a layer | yes | host | — | — |
| `add_mask` | Add a mask to a layer | yes | host | 1 | 3 |
| `add_null` | Add a null layer (use as a controller or parent) | yes | host | 1 | 7 |
| `add_shape_content` | Add content INSIDE a shape layer: kinds group, rectangle, ellipse, star, polygon, path, fill, stroke, gradient_fill, gradient_stroke, repeater, trim_paths, merge_paths, offset_paths, rounded_corners, pucker_bloat, twist, zigzag | yes | host | 1 | 1 |
| `add_shape_layer` | Add a shape layer (rectangle, ellipse, polygon, or star) | yes | host | — | 1 |
| `add_solid` | Add a solid layer | yes | host | — | 20 |
| `add_text_layer` | Add a text layer to a comp | yes | host | 1 | 5 |
| `add_to_render_queue` | Add a comp to the render queue | yes | host | — | — |
| `apply_effect` | Apply an effect to a layer | yes | host | — | 6 |
| `apply_expression_preset` | Apply a known-good expression | yes | host | 1 | 3 |
| `apply_keyframe_ease` | Apply a bezier as TEMPORAL easing between keyframes on one property across MANY layers in ONE call (converts to AE speed/influence ease) | yes | host | 1 | 3 |
| `audit_comp_usage` | Facts about how comps are used, before renaming anything: which comps each one is nested in, whether it is in the render queue, and every expression that names it as a string | no | host | 1 | 1 |
| `center_anchor_point` | Center a layer's anchor point on its visible content (sourceRect math done host-side; position compensated so the layer does not jump, at every Position keyframe) | yes | host | 1 | 1 |
| `comfy_generate` | Generate an image/video with local ComfyUI and import it into the AE project | yes | panel | — | — |
| `comfy_list_workflows` | List available ComfyUI generation workflow templates by name | no | panel | — | — |
| `comfy_status` | Check the local ComfyUI instance (online? queue depth?) | no | panel | — | — |
| `create_comp` | Create a composition and open it | yes | host | 1 | 18 |
| `create_folder` | Create a project-panel folder | yes | host | 1 | 8 |
| `delete_item` | Delete a project item | yes | host | 1 | 21 |
| `delete_layer` | Delete a layer from a comp | yes | host | — | 2 |
| `distribute_property` | Distribute a property VALUE across layers | yes | host | 1 | 5 |
| `duplicate_comp` | Duplicate a composition | yes | host | 1 | 1 |
| `duplicate_layer` | Duplicate a LAYER inside its comp (use duplicate_comp only for whole compositions) | yes | host | 1 | 6 |
| `for_each_layer` | Run a PER-LAYER tool once per target layer in ONE call (max 200 layers) — the batch executor for anything without its own layers arg: {tool: 'apply_effect', args: {effect: 'Gaussian Blur'}} blurs every target | yes | host | 1 | 6 |
| `get_comp_details` | Layers of a comp with index, name, type, timing, effects | no | host | 1 | 16 |
| `get_project_info` | List project items (comps/footage/folders) and the active comp | no | host | 2 | 9 |
| `get_property` | Read ANY property by path: value, keyframes, expression | no | host | 1 | 68 |
| `grid_layout` | Arrange layers into a grid rigged to a control null: its 'Grid X Spacing'/'Grid Y Spacing'/'Grid Columns' sliders drive spacing AND column count live, and the grid centers on the null's position (all expressions generated host-side) | yes | host | 1 | 2 |
| `import_file` | Import a footage/image/video file into the project | yes | host | — | — |
| `link_property` | Drive a layer property from a control | yes | host | — | 1 |
| `list_effects` | Enumerate effects INSTALLED in this AE (name, matchName, category), filtered and paged | no | host | 1 | 2 |
| `list_properties` | DISCOVER a layer's real property tree — names, paths, types, current values | no | host | 1 | 4 |
| `move_to_folder` | Move project items into a folder (batch) | yes | host | 1 | 2 |
| `organize_project` | File loose root-level items into Comps/Footage/Solids/Audio/Images folders | yes | host | — | — |
| `precompose` | Move layers into a new nested comp (precompose) | yes | host | — | 1 |
| `remove_keyframes` | Remove keyframes from a property on many layers at once — specific times or all | yes | host | 1 | 5 |
| `rename_comps` | Rename MANY comps in one call, on the org convention (REVyy_ from a year in the old name, else REV_NO-YEAR_) | yes | host | 1 | 3 |
| `rename_item` | Rename any project item (comp, footage, folder) | yes | host | 1 | 2 |
| `reorder_layers` | Restack layers WITHOUT changing their timing | yes | host | 1 | 2 |
| `scale_comp` | Resize a comp AND scale its content to match, re-centered — like the native 'Scale Composition' script | yes | host | 2 | 2 |
| `set_comp_setting` | Change a comp setting (duration, frame rate, bg color) | yes | host | 1 | 1 |
| `set_effect_param` | Set a parameter on an effect already applied to a layer | yes | host | — | 1 |
| `set_expression` | LAST RESORT: set a raw expression (or clear with '') | yes | host | 1 | 9 |
| `set_keyframes` | Set the SAME keyframes on MANY layers in ONE call | yes | host | 1 | 6 |
| `set_layer_3d` | Enable/disable a layer's 3D switch | yes | host | 1 | 3 |
| `set_layer_parent` | Parent layers to another layer (omit/null parent to unparent) | yes | host | 1 | 4 |
| `set_layer_timing` | Set layer inPoint/outPoint/startTime (seconds) | yes | host | — | 2 |
| `set_mask` | Edit an EXISTING mask: mode, feather, expansion, opacity, inverted, rename | yes | host | 1 | 1 |
| `set_mask_path` | Replace or ANIMATE a mask's path | yes | host | 1 | 7 |
| `set_property` | Set ANY property by path — the universal fallback when no dedicated tool fits | yes | host | 2 | 5 |
| `set_solid_color` | Change a SOLID layer's colour (this is the ONLY way — a solid's colour is not a property you can set_property) | yes | host | 1 | 4 |
| `set_text_style` | Restyle an existing text layer (any subset of fields) | yes | host | 1 | 2 |
| `set_track_matte` | Use one layer as another's track matte (alpha or luma, optionally inverted), or remove it with mode 'none' | yes | host | 1 | 1 |
| `set_transform` | Set a transform property | yes | host | 1 | 7 |
| `split_layer_into_chunks` | Cut a layer into chunks, each on its own layer trimmed to its own window — ONE call does the whole edit | yes | host | 1 | 1 |
| `stagger_layers` | Distribute layer START TIMES | yes | host | 1 | 4 |

**Coverage gaps (computed):**

- Host tools with NO stubbed test: `add_camera`, `add_marker`, `add_shape_layer`, `add_solid`, `add_to_render_queue`, `apply_effect`, `delete_layer`, `import_file`, `link_property`, `organize_project`, `precompose`, `set_effect_param`, `set_layer_timing`
- Host tools never exercised by the self-test suite: `add_marker`, `add_to_render_queue`, `import_file`, `organize_project`

<!-- END GENERATED TOOL INVENTORY -->

## Model-level behaviors (prompt, not tools)

- Natural-language → JSON tool commands; raw ExtendScript is never
  emitted or executed. Anything outside TOOL_DEFS is rejected panel-side.
- Batch-never-loop: plan once, execute many (`for_each_layer`, batch
  keyframe/ease tools, one `AELL_callBatch` per round = one Ctrl+Z).
- Grounded self-correction: every failed lookup lists what actually
  exists (comps, layers, properties, effects, fonts, presets…), which is
  how the small local model recovers without a human.
- Class targeting: "each square" means the class of squares, not the
  current selection; control nulls are never animated uninvited.
- No-input defaults: missing durations fall back to the work area;
  missing comps to the active comp; explicit user asks always win over
  guardrails.
- Request-scoped comp aliases: renaming/recreating a comp mid-batch
  redirects the rest of that request, and manual renames later are safe.

## Panel UX

- Chat with streaming replies, cancel, compact-retry on truncation, and
  a copy-whole-chat button (includes version/model/GPU for bug reports).
- Visualizer pane: bezier ease editor, stagger/property/ease modes,
  resizable split, AE-style scrollbars.
- Settings: model catalog with VRAM-tiered auto-recommendation, download
  progress + cancel, context/rounds tuning, Advanced + ComfyUI submenus,
  alternate models folder plus extra model roots (one per line,
  per-kind `checkpoints=D:\...` supported), tri-state "pause chat
  during generation" (auto/always/never), a VRAM override for
  impersonating any tier, the combined hardware-tier line, one-click
  real-AE self-test with copyable report.
- Branding: llama topbar icon, "Ask the llama to do something in After
  Effects" placeholder, Alpha channel label.

## Infrastructure

- Local llama.cpp: llama-server spawned hidden, health-checked, PID
  tracked and reaped; VRAM-aware engine + model download on first run.
- Hidden ComfyUI backend: portable install bootstrap, spawn/reap
  lifecycle, external model dirs via extra_model_paths.yaml (multiple
  roots, per-kind mappings), and a VRAM arbiter (tiers.js): one
  detection → one T0–T7 tier → chat AND generation recommendations
  derive from it, and each generation is decided by arithmetic over
  the models REALLY loaded — concurrent, exclusive handoff (verified
  release both directions: nvidia-smi polling + ComfyUI /free), or a
  grounded refusal under pause="never". One pause covers a whole
  round. (The curated model stack ships with the feed's comfyCatalog;
  built-in entries are PROVISIONAL until P4 measures them.)
- Auto-update: push → CI builds signed ZXP → feed branch → public repo →
  panels update and reload in place. Version-gated: the panel takes an
  update only when the feed is strictly newer (see CLAUDE.md
  "Shipping").
- Verification: stubbed Node suite in CI on every push (stubs model real
  AE quirks — padded arrays, setValue-on-keyframes, hidden properties,
  font substitution); 289-step real-AE self-test shared by the panel
  button and `scripts/run-ae-selftest.ps1`; `scripts/chat-probe.js`
  drives the real model end-to-end and `scripts/comfy-probe.js` drives
  one real generation end-to-end (real ComfyUI, real GPU, real AE
  import); ES3/ASCII static scanners;
  unattended overnight loop (`scripts/run-local-agent.ps1`) working
  `docs/WORKPLAN.md` with `docs/WORKPLAN-LOG.md` as cross-pass memory.

### Finding a property when the name is all you have

`get_property` / `set_property` take a friendly name (`position`), an
`effect.X.Y` spec or a `group/child/...` path — and, since 0.9.27, a BARE
property name that AE itself cannot resolve from the layer. AE's
layer-level shortcut is a fixed list with an arbitrary edge (a light
answers `Intensity` and `Cone Angle` but not `Radius`; a solid answers
`Opacity` but not its own effect's `Blurriness`; a shape layer answers
`Contents` but not `Size`), so a miss is searched down the real tree,
roots in a measured order. Layer Styles are searched LAST because AE
ships all eleven on every layer whether or not one was ever applied —
ten latent `Opacity`s and seven `Color`s that would otherwise outrank the
property the user meant. The result NAMES the path it found
(`resolvedPath`) and anything else that answered to the same name
(`alsoMatched`); two matches of equal standing are refused with both real
paths rather than guessed between.

## Known gaps (the holistic list — keep this brutal)

Queued (see WORKPLAN for owners/order):

- Lights: `add_light` SHIPPED (item 2, 2026-08-26) — all five AE 2026
  types, per-type grounded refusals from a matrix measured in the field,
  stub suite + 9 real-AE steps, and since 2026-08-28 five more that
  ANIMATE one (intensity keys through the bare name, cone angle through
  the group path, then removed by time and cleared). Since 0.9.26
  `scale_comp` rescales a light's PIXEL options too (Radius, Falloff
  Distance, Shadow Diffusion, keyframes included), parented or not — AE's
  own native script still leaves them behind. Two lies it had to be
  taught: an ambient light refuses the Position write AE hides, and a
  point light reports autoOrient 4214 like a two-node spot while refusing
  its Point of Interest. Since 0.9.27 a bare `Radius` or `Falloff
  Distance` resolves too: AE's layer-level name shortcut covers Intensity,
  Color, Cone Angle, Cone Feather, Casts Shadows, Shadow Darkness and
  Shadow Diffusion but not those three (the ones that arrived with
  falloff), so any bare name AE refuses is now searched down the real
  tree.
- Suite coverage: the computed gap above is down to four tools, and each
  is deliberate rather than pending. `add_marker`/`precompose` belong to
  WORKPLAN 5.4 and `add_to_render_queue`/`import_file` to 5.5/5.8;
  `organize_project` cannot be suite-tested at all, because it files
  every LOOSE item at the project root and the suite runs inside
  whatever project the user has open.
- `set_layer_3d` turning a layer back to 2D still destroys the 3D-only
  values — AE zeroes Position/Anchor Point Z, resets Scale Z to 100 and
  clears Orientation and X/Y Rotation, keyframes included, and turning 3D
  back on does not restore them. Since 0.9.25 the tool no longer lets
  that happen in silence: it names what it took in `discarded`. It still
  does not refuse and does not restore — the user asked for 2D.
- Feature track not yet built: text animators, repeaters, preset
  library, precompose/markers, render queue, project hygiene,
  audio-to-keyframes, frame round-trip, .mogrt export, whisper
  captions, ffmpeg exports (items 5–6).
- Image/video generation is not yet seamless: no frame-aware img2img,
  no mask-driven inpainting, no depth/parallax, no upscale/interpolate.
  The Krea 2 workflow now ships adapted and runnable
  (extension/comfy-workflows/) with a dependency manifest; video repos
  are pinned (Wan 2.2, MiniMax H3); the remaining blocker is P4, which
  is every VRAM figure and catalog URL measured on real hardware.
- Bundled ComfyUI templates: TWO of the three are panel-runnable —
  MiniMax H3 i2v/t2v (video) and Krea 2 (image). `extension/workflows/`
  holds UI-format ("Export") graphs, which `comfy.js loadWorkflow`
  refuses outright — the panel can only queue API-format graphs.
  `scripts/adapt-workflow.js` converts them (bypass rewiring, V3 dynamic
  combos, autogrow groups, positional widget decoding, subgraph
  flattening, cg-use-everywhere broadcasts) against definitions
  harvested from a real ComfyUI into `scripts/comfy-node-defs.json`;
  both converted graphs pass ComfyUI 0.32.0's own `validate_prompt` and
  both have been rendered end to end through the panel into AE. H3 r2v
  is still unconverted (it needs image+audio inputs the panel cannot
  feed yet). `injectParams` honours a sidecar manifest's `procedural`
  block, so a prompt living on the sampler node (H3) or behind an
  rgthree Any Switch (Krea 2) rather than on a plain `CLIPTextEncode`
  does land; `comfy_generate` also takes `durationSeconds` (templates
  whose length is authored in seconds refuse a `frames` argument instead
  of mis-writing it) and `image`, which uploads a local file to
  ComfyUI's input folder — with no image the reference `LoadImage` is
  detached and the graph runs as text-to-video.
- A shipped template must run on a bare ComfyUI, and the manifest is
  what makes that true: every non-core node class carries an
  `optionalNodes` rule — `passthrough` (drop it, rewire consumers to a
  named input, or to one input PER OUTPUT SLOT for a node that emits
  more than one type) or `substitute` (swap the class for a core one).
  `tests/test-workflow-manifests.js` fails CI if a shipped template ever
  gains a class with no rule, and both templates have been rendered with
  every rule forced ON (`scripts/comfy-probe.js --bare`). Machine-
  specific literals — an absolute output path, a reference image only
  one disk has — are corrected in the sidecar's `panelAdaptation`, not
  by hand, so the next regeneration keeps the fix.
- The tier build's REMOTE half (P1–P3) is in: tiers.js, the arbiter
  with verified release, the combined recommendation, comfyCatalog.
  Still open: every VRAM figure and catalog URL is PROVISIONAL until
  P4 measures on real hardware (nvidia-smi deltas, handoff both
  directions, OOM recovery, `/free` support probe); the bundled
  node-pack installer and final video file pins are P5.
  Architecture: docs/COMFY_TIERS_PLAN.md.
- Chat probe never exercises ComfyUI, multi-turn references ("make them
  blue instead"), or undo across a mixed round.

Not queued anywhere yet (candidates to promote):

- Second-turn context: the model's memory of what IT built last round
  is only whatever survives in the transcript — no structured recall.
- Keyframe assistants beyond eases (time-reverse, exponential scale),
  motion sketch, rove-across-time.
- Masks from text ("mask out the sky") without the Phase E segmentation
  stack.
- Multi-comp orchestration ("build a 3-scene sequence and edit them
  together").
- Guide layers, adjustment layers, blending modes, layer styles,
  track-matte TYPES beyond alpha/luma inverts (verify coverage).
- Expression LIBRARY for the user (bounce/overshoot/inertia presets as
  first-class recipes rather than ad-hoc generation).
- Accessibility/i18n of the panel itself; non-English AE installs
  (display-name lookups are locale-sensitive — matchNames mitigate,
  audit the places that still compare display names).

Rejected (with reasons, so they stay rejected):

- Model-authored raw ExtendScript: unbounded blast radius, kills the
  reliability the grounded-tool design exists for.
- Native content-aware fill / Mocha / puppet-pin creation: not
  scriptable; roto goes through the ComfyUI segmentation route instead.
