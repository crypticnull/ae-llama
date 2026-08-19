# Native AE Coverage Plan

Goal: anything After Effects can do from the UI should be reachable from the
chat in natural language — every layer property, every installed effect,
solids, masks, shapes, mattes, parenting, expression controls, and (where
AE's scripting API allows) tracking and roto.

## Architecture principle: introspection over enumeration

AE ships hundreds of effects and thousands of properties. Hand-writing one
panel tool per feature can never keep up, and giant tool lists overflow the
local model's context. The backbone is instead a small set of GENERIC tools
that let the model *discover* and *touch* anything:

1. **Discover** — `list_properties` walks a layer's real property tree
   (transform, effects, masks, text, shape contents, layer styles, camera/
   light options, time remap) and returns actual names/paths/types. The
   model never guesses parameter names; it looks them up. Same pattern as
   the grounded errors that fixed folder and layer hallucinations.
2. **Read** — `get_property` returns value, keyframes, expression for any
   path.
3. **Write** — `set_property` sets a value (or a keyframed value at a time)
   on any path; `set_keyframes` batches keys; `remove_keyframes` clears
   them.
4. **Apply** — `list_effects` enumerates every effect installed in this AE
   (via `app.effects`: display name, match name, category); `apply_effect`
   adds one by match name or display name. Parameters are then set through
   the same generic property tools.

Named convenience tools (set_transform, grid_layout, …) stay — they encode
units/centering/rig knowledge the generic layer can't — but the generic
tools are the safety net that makes everything else reachable.

Property paths accept match names ("ADBE Gaussian Blur 2") and display
names ("Gaussian Blur"), separated by `/`, with friendly aliases for the
root groups (`transform`, `effects`, `masks`, `text`, `contents`,
`styles`, `camera`, `light`, `audio`, `timeRemap`).

## Phases

### Phase A — layers & properties (0.6.x, IN PROGRESS)
- `list_properties {layer, path?, depth?}` — capped, grounded tree listing
- `get_property {layer, property}` — value + keys + expression
- `set_property {layer, property, value, atTime?}`
- `set_keyframes {layer, property, keys: [{time, value}]}` /
  `remove_keyframes {layer, property, times?|all}`
- `set_parent {layers?, parent|null}` — visual position preserved
  (setParentWithJump when available)
- `set_track_matte {layer, matteLayer, mode: alpha|alpha_inverted|luma|
  luma_inverted|none}` (AE 23+ API, no layer-order constraint)
- Solids: `add_solid {name?, color, size?, duration?}`
- Prompt: "unknown parameter → list_properties first, then set_property"

### Phase B — effects (0.6.x)
- `list_effects {filter?}` — the real installed-effect catalog, paged
- `apply_effect {layer, effect, preset?}` + parameter writes via Phase A
- Effect-specific unit notes fed back from get_property (percent, angle,
  color, point)

### Phase C — masks & shapes
- `add_mask {layer, points|preset (rect/ellipse), mode, feather, expansion,
  inverted}` — mask paths are fully scriptable (Shape objects: vertices,
  tangents, closed)
- `set_mask {layer, mask, ...}` / animated mask paths via keyframed Shape
  values
- Shape layers: generic `add_shape_content` builder for groups, paths,
  fills, strokes, gradients, repeaters, trim paths, zig-zag etc. via the
  vectors group property tree ("ADBE Vector …" match names)
- Shape/mask animation = Phase A keyframe tools on the same paths

### Phase D — animation & rig conveniences
- Expression controls already exist (add_control/link_property); extend
  with checkbox/dropdown/angle/color controls and multi-target linking
- Keyframe utilities: copy keys between layers, time-reverse, hold frames,
  speed ramps via time remap paths
- Text animators through the text property tree

### Phase E — tracking & roto (hybrid, honest about limits)
AE's scripting API cannot RUN the point tracker, Roto Brush strokes, or the
3D camera tracker — those are UI-only. The plan:
- **Roto/segmentation**: text-prompted segmentation through the existing
  ComfyUI link (SAM-family models) → matte sequences imported as track
  mattes, optionally converted to real editable AE mask keyframes (mask
  paths ARE scriptable). Ties into the bundled-ComfyUI installer plan.
- **Tracking**: read EXISTING track data (MotionTrackers group is
  readable) and rig it to layers/nulls; ComfyUI-side point/planar tracking
  models as a fallback for "track this thing" from scratch.
- Anything truly UI-only gets an honest reply from the model, not a fake
  success ("honesty rule" already in the prompt).

## Testing & shipping
Every phase lands with stubbed-AE regression tests wired into CI, the same
pattern as the existing suite (`tests/test-*.js`), shipped through the
auto-update feed as alpha versions. Field failures pasted into the dev chat
become tests, grounded errors, and prompt rules — the loop that built
everything so far.
