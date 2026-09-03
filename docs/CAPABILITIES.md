# AE Llama — capabilities

The one place to see everything the panel can do, kept honest two ways:
the tool inventory below is **generated from the code** (CI fails if it
goes stale), and the curated sections are edited by whoever ships the
feature they describe. Use this to look at the product whole and ask
"what's missing?" — the answers feed `docs/WORKPLAN.md`.

## Chat → After Effects tools

<!-- BEGIN GENERATED TOOL INVENTORY (scripts/capability-report.js) -->

_Regenerate with `node scripts/capability-report.js` — CI fails if this section is stale._

**79 tools** (68 mutating, 11 read-only; 73 host-side, 6 panel-side).

| Tool | Does | Writes | Side | Stub tests | Suite steps |
|---|---|---|---|---|---|
| `add_camera` | Add a camera | yes | host | — | 5 |
| `add_captions` | Build MANY timed captions in one call: one text layer per segment (trimmed to its own start/end), or one marker per segment with {as: 'markers'} | yes | host | 1 | 7 |
| `add_control` | Add a named expression control (Slider/Angle/Checkbox/Color/Point Control effect) to a layer — usually a null | yes | host | 1 | 4 |
| `add_keyframe` | Add a keyframe on a layer property at a time (seconds) | yes | host | 1 | 11 |
| `add_light` | Add a light | yes | host | 1 | 13 |
| `add_marker` | Add a marker to the comp (omit 'layer') or to a layer | yes | host | 1 | 10 |
| `add_mask` | Add a mask to a layer ('hide the bottom half') | yes | host | 1 | 63 |
| `add_null` | Add a null layer (use as a controller or parent) | yes | host | 1 | 8 |
| `add_shape_content` | Add content INSIDE a shape layer: kinds group, rectangle, ellipse, star, polygon, path, fill, stroke, gradient_fill, gradient_stroke, repeater, trim_paths, merge_paths, offset_paths, rounded_corners, pucker_bloat, twist, zigzag | yes | host | 1 | 12 |
| `add_shape_layer` | Add a shape layer (rectangle, ellipse, polygon, or star) | yes | host | — | 4 |
| `add_solid` | Add a solid layer | yes | host | — | 63 |
| `add_text_animator` | Animate a text layer PER CHARACTER (typewriter, cascade, wiggle) — an animator holds the properties, a selector picks which characters get them | yes | host | 1 | 10 |
| `add_text_layer` | Add a text layer to a comp | yes | host | 1 | 8 |
| `add_to_render_queue` | Add a comp to the render queue WITHOUT rendering it | yes | host | 1 | 3 |
| `apply_effect` | Apply an effect to a layer | yes | host | 2 | 17 |
| `apply_expression_preset` | Apply a known-good expression | yes | host | 1 | 5 |
| `apply_keyframe_ease` | Apply a bezier as TEMPORAL easing between keyframes on one property across MANY layers in ONE call (converts to AE speed/influence ease) | yes | host | 1 | 3 |
| `apply_preset` | Apply an installed .ffx animation preset to layer(s) | yes | host | 1 | 5 |
| `audio_to_keyframes` | Convert audio amplitude to keyframes: adds a null carrying Left/Right/Both Channels sliders keyframed to the loudness, one key per frame | yes | host | 1 | 11 |
| `audit_comp_usage` | Facts about how comps are used, before renaming anything: which comps each one is nested in, whether it is in the render queue, and every expression that names it as a string | no | host | 1 | 1 |
| `center_anchor_point` | Center a layer's anchor point on its visible content (sourceRect math done host-side; position compensated so the layer does not jump, at every Position keyframe) | yes | host | 2 | 2 |
| `clean_project` | Delete project clutter | yes | host | 1 | 9 |
| `comfy_generate` | Generate an image/video with local ComfyUI and import it into the AE project | yes | panel | — | — |
| `comfy_list_workflows` | List available ComfyUI generation workflow templates by name | no | panel | — | — |
| `comfy_status` | Check the local ComfyUI instance (online? queue depth?) | no | panel | — | — |
| `create_comp` | Create a composition and open it | yes | host | 1 | 36 |
| `create_folder` | Create a project-panel folder | yes | host | 1 | 10 |
| `delete_item` | Delete a project item | yes | host | 1 | 45 |
| `delete_layer` | Delete a layer from a comp | yes | host | — | 26 |
| `delete_mask` | REMOVE one mask from a layer by name or 1-based index ('remove that mask'); omit 'mask' when the layer has exactly one | yes | host | 1 | 29 |
| `distribute_property` | Distribute a property VALUE across layers | yes | host | 1 | 5 |
| `duplicate_comp` | Duplicate a composition | yes | host | 2 | 5 |
| `duplicate_layer` | Duplicate a LAYER inside its comp (use duplicate_comp only for whole compositions) | yes | host | 2 | 12 |
| `export_gif` | Export a comp as an animated GIF | yes | panel | — | — |
| `export_mogrt` | Write a comp out as a .mogrt Motion Graphics template | yes | host | 1 | 6 |
| `export_social` | Export a comp as an H.264 .mp4 (or .mov) sized for posting, AUDIO INCLUDED when the comp has any | yes | panel | — | — |
| `expose_property` | Expose one property in the comp's ESSENTIAL GRAPHICS panel, so an editor can change it in Premiere | yes | host | 1 | 5 |
| `for_each_layer` | Run a PER-LAYER tool once per target layer in ONE call (max 200 layers) — the batch executor for anything without its own layers arg: {tool: 'apply_effect', args: {effect: 'Gaussian Blur'}} blurs every target | yes | host | 1 | 8 |
| `get_bounds` | MEASURE a layer's rendered content without touching it — how wide the text actually is, where the shape sits in the frame, whether anything overflows | no | host | 1 | 32 |
| `get_comp_details` | Layers of a comp with index, name, type, timing, effects, track matte | no | host | 4 | 36 |
| `get_project_info` | List project items (comps/footage/folders) and the active comp | no | host | 2 | 16 |
| `get_property` | Read ANY property by path: value, keyframes, expression | no | host | 3 | 102 |
| `grid_layout` | Arrange layers into a grid rigged to a control null: its 'Grid X Spacing'/'Grid Y Spacing'/'Grid Columns' sliders drive spacing AND column count live, and the grid centers on the null's position (all expressions generated host-side) | yes | host | 1 | 4 |
| `import_as_layer` | Import a file AND place it in a comp as a layer, scaled to the comp | yes | host | 1 | 8 |
| `import_file` | Import a footage/image/video file into the PROJECT PANEL only — it does not appear in any comp | yes | host | 1 | 2 |
| `link_property` | Drive a layer property from a control | yes | host | 2 | 6 |
| `list_effects` | Enumerate effects INSTALLED in this AE (name, matchName, category), filtered and paged | no | host | 1 | 2 |
| `list_presets` | Enumerate the ANIMATION PRESETS (.ffx) installed in this AE — AE ships ~679 (Behaviors, Text, Backgrounds, Transitions, Image, Shapes…) plus the user's own | no | host | 1 | 3 |
| `list_properties` | DISCOVER a layer's real property tree — names, paths, types, current values | no | host | 2 | 12 |
| `list_render_templates` | List this machine's render-settings and output-module template names for render_comp | no | host | 1 | 3 |
| `move_to_folder` | Move project items into a folder (batch) | yes | host | 1 | 2 |
| `organize_project` | File loose root-level items into Comps/Footage/Solids/Audio/Images folders at the project ROOT | yes | host | 1 | 3 |
| `precompose` | Move layers into a new nested comp (precompose) | yes | host | 1 | 5 |
| `remove_effect` | REMOVE one effect from a layer by display name or matchName ('get rid of the blur') | yes | host | 1 | 8 |
| `remove_keyframes` | Remove keyframes from a property on many layers at once — specific times or all ('stop it moving' = this, times omitted) | yes | host | 1 | 10 |
| `rename_comps` | Rename MANY comps in one call, on the org convention (REVyy_ from a year in the old name, else REV_NO-YEAR_) | yes | host | 1 | 3 |
| `rename_item` | Rename any project item (comp, footage, folder) | yes | host | 1 | 3 |
| `render_comp` | Actually RENDER a comp to a file | yes | host | 1 | 11 |
| `render_comp_audio` | Render ONLY the comp's audio to a file (AE's audio-only output module, picked for you) | yes | host | 1 | 2 |
| `reorder_layers` | Restack layers WITHOUT changing their timing | yes | host | 1 | 12 |
| `scale_comp` | Resize a comp AND scale its content to match, re-centered — like the native 'Scale Composition' script | yes | host | 2 | 2 |
| `set_comp_setting` | Change a comp setting: duration, frame rate, bg color, the WORK AREA (workAreaStart with workAreaDuration or workAreaEnd, in seconds — or workArea: 'comp' to reset it to the whole comp) and preview resolution | yes | host | 2 | 10 |
| `set_effect_param` | Set a parameter on an effect already applied to a layer | yes | host | 1 | 12 |
| `set_expression` | LAST RESORT: set a raw expression (or clear with '') | yes | host | 1 | 17 |
| `set_keyframes` | Set the SAME keyframes on MANY layers in ONE call | yes | host | 2 | 14 |
| `set_layer_3d` | Enable/disable a layer's 3D switch | yes | host | 1 | 8 |
| `set_layer_parent` | Parent layers to another layer (omit/null parent to unparent) | yes | host | 4 | 18 |
| `set_layer_timing` | Retime a layer on the TIMELINE, in comp seconds: startTime slides the whole layer ('push it back two seconds' = startTime: current + 2), inPoint/outPoint TRIM its ends without sliding it | yes | host | — | 5 |
| `set_mask` | Edit an EXISTING mask: mode, feather, expansion, opacity, inverted, rename | yes | host | 1 | 11 |
| `set_mask_path` | Replace or ANIMATE a mask's path | yes | host | 1 | 7 |
| `set_property` | Set ANY property by path — the universal fallback when no dedicated tool fits | yes | host | 4 | 10 |
| `set_solid_color` | Change a SOLID layer's colour (this is the ONLY way — a solid's colour is not a property you can set_property) | yes | host | 1 | 5 |
| `set_text_style` | Restyle an existing text layer (any subset of fields) | yes | host | 1 | 2 |
| `set_track_matte` | Use one layer as another's track matte (alpha or luma, optionally inverted), or remove it with mode 'none' | yes | host | 1 | 8 |
| `set_transform` | Set a transform property | yes | host | 2 | 39 |
| `snapshot_frame` | Write one frame of a comp to a PNG on disk | yes | host | 1 | 7 |
| `split_layer_into_chunks` | Cut a layer into chunks, each on its own layer trimmed to its own window — ONE call does the whole edit | yes | host | 1 | 2 |
| `stagger_layers` | Distribute layer START TIMES | yes | host | 1 | 8 |
| `transcribe_to_captions` | TRANSCRIBE the comp's own audio with the local speech model and put the result on the timeline as timed text layers (or markers) | yes | panel | — | — |

**Coverage gaps (computed):**

- Host tools with NO stubbed test: `add_camera`, `add_shape_layer`, `add_solid`, `delete_layer`, `set_layer_timing`
- Host tools never exercised by the self-test suite: none

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
- Per-model generation-weight rows (ComfyUI submenu): each catalog model
  with its measured on-disk size and where it lives, Download with
  progress/cancel into the panel's own model folders, Remove with
  receipts (freed MiB; files kept because they sit in the user's own
  folders or the Comfy-Desktop shared store are reported, never
  deleted).
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
  round. Before any of that churn, the chosen template's weights are
  checked against the BACKEND's own /object_info: the disk answers how
  big a weight is, the backend answers whether it can open it, and a
  job whose weights the running ComfyUI cannot see is refused naming
  each missing file and where it sits on disk — rather than costing a
  handoff and then failing. (The curated model stack ships with the
  feed's comfyCatalog; built-in entries are PROVISIONAL until P4
  measures them.)
- Auto-update: push → CI builds signed ZXP → feed branch → public repo →
  panels update and reload in place. Version-gated: the panel takes an
  update only when the feed is strictly newer (see CLAUDE.md
  "Shipping").
- Verification: stubbed Node suite in CI on every push (stubs model real
  AE quirks — padded arrays, setValue-on-keyframes, hidden properties,
  font substitution); 289-step real-AE self-test shared by the panel
  button and `scripts/run-ae-selftest.ps1`; `scripts/chat-probe.js`
  drives the real model end-to-end (and `--variants` re-types each
  sentence casually, vaguely and with typos, scoring pass / harmless
  miss / harm, so the product is proven not to need magic words)
  and `scripts/comfy-probe.js` drives
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
- Suite coverage: `add_marker`/`precompose` (5.4) and
  `add_to_render_queue` (5.5) have since been covered, and `import_file`
  with them on 2026-08-29 — it only ever needed a file on disk, and
  `snapshot_frame` is that file. The computed gap list above now reads
  "never exercised by the self-test suite: none", which is the first
  time every host tool has been touched in real AE. `organize_project` is covered as of 0.10.2, but by its
  PREVIEW only: it files every LOOSE item at the project root and the
  suite runs inside whatever project the user has open, so the suite
  proves the preview counts and names correctly and moves nothing, and
  the execute path is covered by `tests/test-organize-project.js` plus a
  throwaway-project measurement in real AE.
- `set_layer_3d` turning a layer back to 2D still destroys the 3D-only
  values — AE zeroes Position/Anchor Point Z, resets Scale Z to 100 and
  clears Orientation and X/Y Rotation, keyframes included, and turning 3D
  back on does not restore them. Since 0.9.25 the tool no longer lets
  that happen in silence: it names what it took in `discarded`. It still
  does not refuse and does not restore — the user asked for 2D.
- Text animators shipped 2026-08-28 (`add_text_animator`): one call adds
  the animator, activates the properties named and configures the
  selector, then reports the exact paths so `set_keyframes` on the
  selector's Offset/Start is what makes it move. An animator carries all
  103 possible properties from birth, hidden until added, so the rest of
  the panel now flags a hidden one on a read and refuses a write to it
  instead of leaking AE's own "the property or a parent property is
  hidden".
- Shape repeaters were never missing, only unreachable. Since 0.9.31 a
  `contents/<Group>/<Item>/<Param>` path resolves: a shape group hides
  its items in a nested "Contents" group AE's timeline never draws, so
  every path this panel documented -- its own returned notes and the
  system prompt's trim-paths recipe included -- was one segment short and
  failed. The short form now hops that segment (a real child of the same
  name still wins), and `add_shape_content` warns when a repeater, trim,
  offset, twist or zigzag lands with no shape ABOVE it: those act on
  what is above them and new content is always appended below, so the
  order they were added in is the whole story.
- AE's own animation presets are now reachable: `list_presets` searches
  the ~679 .ffx files AE ships (Behaviors, Text, Backgrounds,
  Transitions, Shapes) plus the user's own, and `apply_preset` applies
  one. The API needed three field measurements to be usable at all --
  `applyPreset` acts on the comp's SELECTION rather than on the layer it
  is called on (two layers selected, one call, BOTH changed), with an
  empty selection it invents a comp-sized solid and applies the preset
  there instead, and a preset built for another layer type does nothing
  whatsoever without throwing. The tool selects only its target and puts
  the user's selection back, and a preset that changed nothing is
  reported as a refusal naming the layer type, never as success.
- The panel can RENDER since 2026-08-28: `render_comp` takes a comp to a
  file and waits for it, and `list_render_templates` names the
  output-module and render-settings templates this machine actually has
  (they differ per install, so nothing guesses). Seven probes decided the
  design. `renderQueue.render()` does work headless from a `-r` session —
  one frame in 181 ms — so aerender.exe is not used and would in fact be
  wrong: it launches a second AE against a SAVED .aep, while this panel
  drives a live, usually-unsaved project. The three measured hazards are
  handled rather than merely documented: `render()` renders the WHOLE
  QUEUE, so anything the user already queued is held back and handed
  straight back; an output path that ALREADY EXISTS raises a modal that
  wedges After Effects outright, so it is refused unless
  `{overwrite: true}` and only then rendered under
  `beginSuppressDialogs`; and the output module forces its OWN file
  extension onto whatever path it is handed (an .mp4 set under
  "Lossless" reads back as .avi immediately), so the path REPORTED is the
  one AE settled on, never the one that was asked for. Since 2026-08-30 it
  also takes `{resolution}` — AE's Render Settings resolution, so a
  preview or a soon-to-be-scaled master costs the pixels it will actually
  use rather than the comp's full frame. The result reports the
  resolution AE confirms and the frame size it really wrote
  (`ceil(dim/factor)` per axis, measured — 641x361 at half is 321x181),
  and the four names are all AE accepts: anything else is refused with
  the list. Ordering is load-bearing and is the reason a suite step
  exists for it: `applyTemplate` RESETS the resolution to Full, so it is
  set AFTER both templates or it silently does nothing.
  `export_gif`/`export_social` expose the same lever as
  `{masterResolution}` (`"auto"` picks the largest reduction that still
  covers the output, and a reduction that would land UNDER the requested
  size is refused rather than upscaled). It is opt-in: on this machine a
  10 s 1080p comp to 480x270 went 6.6 s -> 6.0 s, so the win is the
  intermediate itself — 1.74 GB down to 116 MB — not the clock.
- **AE's lossless AVI clears the RIFF boundaries, so the 8 GB cap on the
  export intermediate guards the disk and the clock — not the format.**
  AVI is RIFF and RIFF offsets are 32 bits, so 2 GiB and 4 GiB are where
  a writer classically wraps and hands back a file the reader truncates
  without complaint. At 1080p30 a lossless master crosses 2 GiB at about
  11.5 s and 4 GiB at 23 s, so almost every real export is past one of
  them and nobody had ever checked. Measured 2026-08-30
  (`scripts/riff-boundary-probe.js`): masters of **5.214 GiB (900
  frames)** and **7.995 GiB (1380 frames — the largest the shipped cap
  allows)** both rendered DONE with no warning, probed at the full frame
  count and right frame size, decoded end to end under `-xerror` with an
  empty stderr, and gave 900 and 1380 DISTINCT frame hashes. The check
  that settles it is the last one: short reference spans re-rendered
  across frames 343-347, 688-692 and the final five are **byte-identical
  (framemd5) to those same frames inside the multi-gigabyte file**, which
  compares AE against itself and so needs no assumption about colour
  management or what the picture ought to look like. Nothing wrapped and
  nothing was dropped. The default cap is therefore left at 8 GB and the
  refusal now says which kind of limit it is, because a caller told only
  "the limit is 8 GB" shortens an export that never needed shortening.
  The per-frame overhead was re-measured while the files were there and
  the old "3 640 B/frame at 1080p" note was an artefact of a TWO-frame
  render: the cost is a fixed ~9.6 KB header, so the share falls to
  **89 B/frame by 1380 frames** and the estimate stays a true floor.
- **After Effects cannot render inside an undo group.** Its renderer
  closes the script's group out from under it and AE raises a modal
  "Undo group mismatch" — later in the run, at some innocent
  `endUndoGroup`, which is why a suite can pass and still poison the
  session. So `render_comp` is exempt from the host's undo grouping via
  `AELL_NO_UNDO_GROUP` while staying `mutating` in the tool docs (a dry
  run must still refuse to burn a real render — the two maps mean
  different things), and a round that contains a render opens no undo
  group at all. Closing and reopening the group around just the render
  was tried first; AE rejects that too.
- `add_to_render_queue` stopped being silent in the same pass. With no
  outputPath AE reuses the LAST RENDER'S settings and folder — on the
  probe machine that was a ComfyUI output directory with nothing to do
  with the project — so the result now says where the bytes would land.
  It also warns when the same comp is queued twice (AE allows it, and
  both copies then render), refuses an output folder that does not
  exist, and reports an extension AE overrode.
- Project hygiene arrived 2026-08-28: `clean_project` runs exactly one
  of AE's three cleanup calls, and every one of them takes more than it
  says. `removeUnusedFootage()` also deletes EMPTY FOLDERS, recursively,
  and counts them in the total it returns; `reduceProject()` deletes a
  comp that only an EXPRESSION names -- leaving `expressionError` empty,
  so the break is invisible -- and silently drops the render-queue items
  of every comp it removes; and it ACCEPTS a footage item in its keep
  array and then deletes every comp in the project, which the tool
  refuses outright. So `dryRun` defaults to TRUE and the preview NAMES
  what would go (paths, not a count), calls out the folders, queue items
  and expressions the user never asked about, and on execute diffs what
  AE actually removed against what was promised. All measured on
  throwaway projects in AE 2026; unlike a render, these are ordinary
  edits that one Ctrl+Z undoes whole. The suite covers previews and
  refusals ONLY -- executing any of them inside the user's open project
  would delete the user's own items -- so the execute paths live in
  `tests/test-project-hygiene.js` against a stub that models each hazard.
  Since 2026-09-02 the preview is a GATE, not advice: four field runs of
  the chat probe measured the model going straight to `dryRun:false`
  half the time, deleting real project items with no list ever put in
  front of the user, and the prompt had told it to preview first in two
  places and in both doc forms. So a delete must now cite a preview of
  the SAME plan -- same action, same kept comps, same item ids -- taken
  in an EARLIER user request, which is the only boundary at which the
  user could have seen it and said go. The refusal carries that preview,
  so the round loses nothing but the deletion. And the tool takes no
  comp or layer: an argument naming one (the field call was
  `keepComps:["Probe Room"]` on `remove_unused_footage`, which the tool
  ignored before deleting project-wide) is refused and told which tools
  tidy a comp.
- Audio drives animation since 2026-08-28: `audio_to_keyframes` wraps
  AE's "Convert Audio to Keyframes" menu command (id 4218 -- the exact
  spelling; any other casing resolves to 0) and hands back a null whose
  Left/Right/Both Channels sliders carry one keyframe per frame, ready
  for `link_property`. The wrapper is almost entirely made of what that
  command does NOT do, all measured in AE 2026: it converts the ACTIVE
  comp rather than one it is handed, so the target is opened first; it
  reads the whole comp MIX and ignores the selection, so isolating one
  layer means muting the others for the conversion and putting them back
  (a muted layer contributes an all-zero curve, which is what makes that
  work); it is bounded by the WORK AREA, so the default widens it to the
  whole comp, restores it and says so; it never uniques the null's name,
  so two runs leave two layers called "Audio Amplitude" and every later
  name lookup ambiguous; and with no audio-capable layer it creates
  nothing, throws nothing and shows no dialog -- silence is the only
  signal, so the tool refuses BEFORE calling it and names the layers
  that are actually there. Suite coverage needs no audio FILE: applying
  the Tone effect to a solid flips `layer.hasAudio` to true and the
  converter measures it.
- The comp/file bridge closed 2026-08-29: `snapshot_frame` writes one
  frame of a comp to a PNG and `import_as_layer` puts a file back into a
  comp as a layer, scaled to it. `comp.saveFrameToPng` needs no viewer
  and no render queue (a 320x240 frame in a few ms), but everything it
  gets wrong it gets wrong QUIETLY, and each of those is now a refusal
  or a spoken note: a folder that does not exist is a SILENT no-op, an
  out-of-range time CLAMPS and writes a blank frame, an existing file is
  replaced with no dialog and no undo, a comp left at Half resolution
  writes a half-size frame (so the default overrides the downsample,
  restores it, and says so), and it writes PNG BYTES into whatever name
  it is handed — a frame saved as .jpg is a PNG called .jpg. The
  dimensions REPORTED are read back out of the file's own PNG header,
  not repeated from the comp. On the import side, AE makes a second
  project item for a path it already holds and says nothing, so an
  existing item is reused and `reload()`ed instead — which is what makes
  regenerating the same path and re-placing it safe. The fit arithmetic
  is the panel's own because AE's "Fit to Comp" menu commands do NOTHING
  with no comp viewer open (measured: scale stayed 100,100); it
  reproduces their numbers exactly WITH one open, pixel-aspect
  correction on X included (a 320x240 par-1 source fits a 720x480
  par-1.2121 comp at 272.727 x 200, not 225 x 200). `import_file` still
  exists and still only reaches the project panel; its docs now say so
  and point here.
- Two comp settings AE keeps to itself became reachable 2026-08-29:
  `set_comp_setting` now writes the WORK AREA and the preview
  RESOLUTION, and `get_comp_details` reads both back. AE does not treat
  these like ordinary setters, and every rule below is measured: a
  work-area write SNAPS to the frame grid in silence (0.333s becomes
  frame 8 on a 24 fps comp), an out-of-range one THROWS rather than
  clamping, and the legal range for the duration is computed from the
  CURRENT start -- so widening a work area that sits late in the comp
  throws unless the start is written first, which is the order the tool
  uses. Shortening a comp drags its work area in with it, quietly; the
  tool says so. Resolution is a pair of whole numbers 1..99 (a bare
  number, a one-element array and a fraction each throw a different raw
  message), so 'full'/'half'/'third'/'quarter' are accepted names and
  anything else is refused before AE is asked. This also closed the last
  two suite gaps that could only be proven by stubs: `audio_to_keyframes`
  with `range: 'workArea'` and `snapshot_frame`'s resolution override are
  now exercised in real AE, the audio converter's own key count being the
  witness that the work area landed and was put back.
- Essential Graphics is now reachable: `expose_property` puts one
  property in the comp's EG panel and `export_mogrt` writes the comp out
  as a .mogrt for Premiere. Both are made almost entirely of what AE does
  silently -- a CANCELLED export (a font that is not installed, and its
  alert answered anywhere but OK) returns TRUE and writes nothing, so the
  tool stats the file rather than trusting the boolean; the export needs
  the project saved AND clean, and dirties it again on success, so a
  second export with no save between is a silent failure; the path is a
  FOLDER and the file name is the template name VERBATIM, spaces and all.
  There is no rename and no remove -- AE 2026 ships neither -- and
  controller indices renumber on every add, newest first. Suite coverage
  as of 2026-08-30 is `expose_property` end to end plus the whole
  `export_mogrt` refusal wall; the EXPORT itself cannot be a suite step,
  because AE exports only from a saved, CLEAN project and the suite has
  been creating comps in the user's open one since step 1 -- the same
  shape as `clean_project` and `organize_project`.
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
  detached and the graph runs as text-to-video. `width`/`height` are the
  size the template GENERATES at, which is not always the size it writes:
  the Krea 2 graph upscales its latent 1.6x between passes, so a request
  for 1024x1024 saves 1640x1640. `injectParams` traces the size chain
  forward to the node that writes the file and says so in `applied`
  (staying silent for any chain it cannot account for — an upscale whose
  factor lives in a `.pth`, a factor behind a link, two output branches
  that disagree), and `import_file` reports the size AE MEASURED, which
  `comfy_generate` hoists to `outputSize`. Both numbers verified against
  the card by `scripts/output-size-probe.js`.
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
- A bundled template REACHES an existing install. Seeding used to copy
  only what was missing, so a machine froze on the templates it first
  saw (this one was running the H3 manifest from five releases earlier).
  The bundle now carries `.hash-history.json` — the append-only sha1 of
  every version ever shipped, CRLF-normalized because git hands a
  Windows checkout different bytes for the same version — and
  `ensureDataDirs` refreshes an installed file only when its hash is one
  of ours. An unknown hash is a user's edit and is never touched; a
  bundle with no readable history falls back to never overwriting.
  `node scripts/workflow-hash-history.js` records a new version and
  `tests/test-workflow-hash-history.js` fails CI when a template changes
  without it — an unrecorded hash would make every install look edited
  and silently re-freeze the bug.
- The tier build's REMOTE half (P1–P3) is in: tiers.js, the arbiter
  with verified release, the combined recommendation, comfyCatalog.
  Still open: every VRAM figure and catalog URL is PROVISIONAL until
  P4 measures on real hardware (nvidia-smi deltas, handoff both
  directions, OOM recovery, `/free` support probe); the bundled
  node-pack installer and final video file pins are P5.
  Architecture: docs/COMFY_TIERS_PLAN.md.
- Chat probe never exercises ComfyUI, multi-turn references ("make them
  blue instead"), or undo across a mixed round.
- **`set_layer_parent` moves the layer it parents.** Measured in real AE
  2026 on 2026-08-29 by the new bounds steps: with the default
  `keepPosition: true` the tool calls `setParentWithJump`, which is AE's
  *jumping* form, so a layer parented to a null at [300,200] slides by
  exactly that much while the result still reports "Visual positions
  preserved". The two calls are the wrong way round (`layer.parent = p`
  is the pick-whip that compensates). One-line fix, but it moves the
  ground under every rig in the suite that parents something, so it gets
  its own pass rather than riding another one.
- Measuring a layer is READ-ONLY as of `get_bounds` (2026-08-29): before
  it, the only route to `sourceRectAtTime` was `center_anchor_point`,
  which mutates the anchor to tell you. It reports the source rect, the
  comp-space box and corners through parenting/scale/rotation, and
  whether the layer overflows the frame. A 3D layer gets the source rect
  and an explicit refusal for the comp box — AE's own
  `sourcePointToComp` ignores Z, the camera and a 3D parent's rotation
  (all measured), so any comp-space number for it would be a lie.

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
