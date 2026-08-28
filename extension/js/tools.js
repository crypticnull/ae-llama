/*
 * tools.js — the allowlisted bridge between the model and After Effects.
 *
 * The model never emits raw ExtendScript. It emits JSON commands
 * ({tool, args}) chosen from TOOL_DEFS; executeCommands() forwards them to
 * jsx/hostscript.jsx, which implements the tools with undo groups. Anything
 * not in this list is rejected panel-side.
 *
 * Consecutive host tools go out as ONE AELL_callBatch, so a chat command
 * that takes five tool calls is a single Ctrl+Z rather than five. It has to
 * be one call: an undo group does not survive the end of the script
 * execution that opened it.
 */
(function (global) {
  "use strict";

  // Keep names/args in sync with the dispatch table in jsx/hostscript.jsx.
  var TOOL_DEFS = [
    { name: "get_project_info", mutating: false,
      desc: "List project items (comps/footage/folders) and the active " +
            "comp. Long lists are capped (comps and folders first) and the " +
            "result says so in 'note' — raise limit to see more.",
      args: "{limit?: int (default 40, 0 = every item)}" },
    { name: "get_comp_details", mutating: false,
      desc: "Layers of a comp with index, name, type, timing, effects. A " +
            "long comp is capped to a window: SELECTED layers are always " +
            "included, and 'note' says how many layers exist and how to " +
            "page through them.",
      args: "{comp?: string, start?: int (1-based, default 1), " +
            "limit?: int (default 40, 0 = every layer)}  " +
            "// omit comp for the active comp" },
    { name: "create_folder", mutating: true,
      desc: "Create a project-panel folder. Same name in different parents " +
            "is fine; existence is checked per-parent. eachChildOf makes " +
            "ONE call create the folder inside EVERY direct subfolder of " +
            "the named folder — the host reads the real subfolders itself " +
            "and the result lists every path created, so use it for any " +
            "'inside each subfolder of X' request instead of guessing " +
            "folder names.",
      args: "{name: string, parent?: folder name, id, path, or 'root' (default: root), eachChildOf?: folder name|id|path ('inside each subfolder of X' — one call, ignore parent), except?: [subfolders to SKIP] (with eachChildOf; bare names or full paths both work — an entry matching nothing refuses)}" },
    { name: "move_to_folder", mutating: true,
      desc: "Move project items into a folder (batch).",
      args: "{items: name|id|path|[..], folder: name, id, path 'A/B', or 'root'}" },
    { name: "rename_item", mutating: true,
      desc: "Rename any project item (comp, footage, folder).",
      args: "{item: name|id|path 'A/B/Item', name: string}" },
    { name: "delete_item", mutating: true,
      desc: "Delete a project item. Deleting a folder removes its contents. " +
            "Use a path when names repeat.",
      args: "{item: name|id|path 'A/B/Item'}" },
    { name: "set_solid_color", mutating: true,
      desc: "Change a SOLID layer's colour (this is the ONLY way — a " +
            "solid's colour is not a property you can set_property). " +
            "Takes many layers in one call. The colour lives on the " +
            "shared solid SOURCE, so duplicated or split layers all " +
            "change together; if that would hit layers you did not name " +
            "the tool refuses and tells you, and makeUnique:true gives " +
            "the named layers their own solid instead.",
      args: "{comp?: string, layer?: name|index, layers?: [name|index], " +
            "color: [r,g,b], makeUnique?: bool}" },
    { name: "audit_comp_usage",
      desc: "Facts about how comps are used, before renaming anything: " +
            "which comps each one is nested in, whether it is in the " +
            "render queue, and every expression that names it as a " +
            "string. Read-only. Omit 'comp' to audit the whole project.",
      args: "{comp?: string}" },
    { name: "rename_comps", mutating: true,
      desc: "Rename MANY comps in one call, on the org convention " +
            "(REVyy_ from a year in the old name, else REV_NO-YEAR_). " +
            "dryRun is TRUE by default and returns the preview table — " +
            "show it to the user, then call again with dryRun:false. " +
            "Comps named by an expression are ALWAYS skipped (renaming " +
            "them silently breaks the expression). Comps nested in " +
            "others but not render-queued are skipped unless " +
            "includeUtility:true. Running it twice changes nothing.",
      args: "{rule?: 'rev-prefix'|'map', renames?: {old: new} (rule 'map' " +
            "only), comps?: [string] (default every comp), dryRun?: bool " +
            "(default TRUE), includeUtility?: bool}" },
    { name: "duplicate_comp", mutating: true,
      desc: "Duplicate a composition.",
      args: "{comp: string, name?: string}" },
    { name: "organize_project", mutating: true,
      desc: "File loose root-level items into Comps/Footage/Solids/Audio/" +
            "Images folders. Leaves existing folder structure alone.",
      args: "{}" },
    { name: "create_comp", mutating: true,
      desc: "Create a composition and open it.",
      args: "{name: string, width: int, height: int, duration: seconds, frameRate: number, bgColor?: [r,g,b] 0..1}" },
    { name: "add_text_layer", mutating: true,
      desc: "Add a text layer to a comp. The new layer starts from a " +
            "KNOWN baseline (white, 72px, tracking 0, auto leading, left, " +
            "no faux/stroke, a plain installed sans) instead of whatever " +
            "AE's Character panel was last set to; anything you pass " +
            "overrides it. Pass inheritStyle:true to keep the user's " +
            "Character panel style instead.",
      args: "{comp?: string, text: string, fontSize?: px, fillColor?: [r,g,b] 0..1, position?: [x,y], font?: string (PostScript name), tracking?: number, leading?: px|'auto', justification?: 'left'|'center'|'right', inheritStyle?: bool}" },
    { name: "set_text_style", mutating: true,
      desc: "Restyle an existing text layer (any subset of fields). " +
            "An uninstalled font is refused, listing what IS installed.",
      args: "{comp?: string, layer: name|index, text?: string, fontSize?: px, font?: string (PostScript name, e.g. ArialMT), fillColor?: [r,g,b] 0..1, tracking?: number, leading?: px|'auto', justification?: 'left'|'center'|'right'}" },
    { name: "add_solid", mutating: true,
      desc: "Add a solid layer.",
      args: "{comp?: string, name: string, color: [r,g,b] 0..1, width?: int, height?: int}" },
    { name: "set_transform", mutating: true,
      desc: "Set a transform property. UNITS: scale/opacity are PERCENT " +
            "(100 = normal, 200 = double), rotation is degrees, position/" +
            "anchorPoint are pixels. relative:true applies against the " +
            "current value ('scale by 200%' => {property:'scale', " +
            "value:200, relative:true}; relative position adds [dx,dy]).",
      args: "{comp?: string, layer: name|index, property: 'position'|'scale'|'rotation'|'opacity'|'anchorPoint', value: number|[..], relative?: bool}" },
    { name: "center_anchor_point", mutating: true,
      desc: "Center a layer's anchor point on its visible content " +
            "(sourceRect math done host-side; position compensated so the " +
            "layer does not jump, at every Position keyframe). ALWAYS use " +
            "this instead of guessing anchor coordinates. If Scale or " +
            "Rotation are animated too, the note says where the " +
            "compensation is exact.",
      args: "{comp?: string, layer: name|index, preservePosition?: bool = true}" },
    { name: "add_keyframe", mutating: true,
      desc: "Add a keyframe on a layer property at a time (seconds).",
      args: "{comp?: string, layer: name|index, property: transform name or 'effect.<EffectName>.<ParamName>', time: seconds, value: number|[..]}" },
    { name: "add_null", mutating: true,
      desc: "Add a null layer (use as a controller or parent).",
      args: "{comp?: string, name?: string, position?: [x,y]}" },
    { name: "add_control", mutating: true,
      desc: "Add a named expression control (Slider/Angle/Checkbox/Color/" +
            "Point Control effect) to a layer — usually a null.",
      args: "{comp?: string, layer: name|index, type: 'slider'|'angle'|'checkbox'|'color'|'point', name: string, value?: number|[..]}" },
    { name: "link_property", mutating: true,
      desc: "Drive a layer property from a control. The panel writes the " +
            "expression itself with correct syntax (dimension-aware; " +
            "optional value = control*scale + offset).",
      args: "{comp?: string, layer: name|index, property: transform name or 'effect.<Effect>.<Param>', controlLayer: name|index, controlEffect: string (control name), scale?: number, offset?: number}" },
    { name: "stagger_layers", mutating: true,
      desc: "Distribute layer START TIMES. Gap mode (use this for 'X " +
            "frames/seconds apart'): stepFrames or step is the gap " +
            "BETWEEN consecutive layers — '4 frames apart' = " +
            "{stepFrames: 4}. Curve mode: 'spread' is the TOTAL span of " +
            "the whole stagger, not the per-layer gap, and layer i (of n) " +
            "starts at startAt + bezierY(i/(n-1)) * spread. Pass spread " +
            "OR step, never both. Uses the user's selected layers when " +
            "'layers' omitted. Omit all of them to fill the comp's WORK " +
            "AREA; omit bezier for linear (ease-out = [0,0,0.58,1], " +
            "ease-in = [0.42,0,1,1]). A 'layers' list is used IN THE " +
            "ORDER GIVEN unless 'order' asks for a sort.",
      args: "{comp?: string, layers?: [name|index] (used in the order given), stepFrames?: frames BETWEEN consecutive layers, step?: seconds BETWEEN consecutive layers, spread?: seconds TOTAL for the whole stagger (default: work area), bezier?: [x1,y1,x2,y2] (curve mode only, default linear), startAt?: s, order?: 'in'|'stack'|'reverse'|'ascending'|'descending' (re-sorts the list)}" },
    { name: "distribute_property", mutating: true,
      desc: "Distribute a property VALUE across layers. Curve mode: layer " +
            "i gets from + bezierY(i/(n-1)) * (to-from). Equidistant " +
            "mode: pass step and layer i gets from + i*step (from " +
            "defaults to the first layer's current value; step is " +
            "center-to-center, so 100px shapes with a 20px gap = step " +
            "120). Use step for 'space them every X px / equidistant'. " +
            "A 'layers' list is applied IN THE ORDER GIVEN — layer i of " +
            "the list gets slot i — so name them in the sequence you " +
            "want; pass 'order' only to sort them instead. Layers whose " +
            "property is driven by an expression (a grid_layout rig, a " +
            "link) are reported in overriddenByExpression and do NOT " +
            "move; clearExpressions: true removes exactly those " +
            "expressions so the values land — re-send the FULL layers " +
            "list on that re-call, not only the overridden ones.",
      args: "{comp?: string, layers?: [name|index] (applied in the order given), property: 'opacity'|'rotation'|'scale'|'position_x'|'position_y', from?: number, to?: number, step?: number (equidistant), bezier?: [x1,y1,x2,y2], order?: 'in'|'stack'|'reverse' (re-sorts the list), clearExpressions?: true (ONLY on a re-call after overriddenByExpression, when the user explicitly asked for these values)}" },
    { name: "apply_keyframe_ease", mutating: true,
      desc: "Apply a bezier as TEMPORAL easing between keyframes on one " +
            "property across MANY layers in ONE call (converts to AE " +
            "speed/influence ease). keyIndex eases pair k..k+1; omit for " +
            "all pairs.",
      args: "{comp?: string, layers?: [name|index] | layer?: name|index (omit = selection), property: path, bezier: [x1,y1,x2,y2], keyIndex?: int, allPairs?: bool}" },
    { name: "grid_layout", mutating: true,
      desc: "Arrange layers into a grid rigged to a control null: its " +
            "'Grid X Spacing'/'Grid Y Spacing'/'Grid Columns' sliders " +
            "drive spacing AND column count live, and the grid centers " +
            "on the null's position (all expressions generated " +
            "host-side). Creates its OWN control null — never add_null " +
            "first. Omit 'layers' to use the selection; with nothing " +
            "selected it grids ALL content layers in the comp (nulls/" +
            "cameras/lights excluded). Re-running re-flows the rig.",
      args: "{comp?: string, layers?: [name|index] (omit = user's selection), columns?: int (default ~square; 1 = column, n = row), spacingX?: px, spacingY?: px, controlLayer?: string = 'GRID CTRL'}" },
    { name: "apply_expression_preset", mutating: true,
      desc: "Apply a known-good expression. Presets: wiggle (frequency/" +
            "amplitude as numbers OR freqControl/ampControl {layer, effect} " +
            "to drive from sliders), loop_cycle, loop_pingpong, loop_offset " +
            "(need keyframes), time_linear (scalar props; rate or rateControl).",
      args: "{comp?: string, layer: name|index, property: string, preset: string, frequency?: n, amplitude?: n, rate?: n, freqControl?: {layer, effect}, ampControl?: {layer, effect}, rateControl?: {layer, effect}}" },
    { name: "set_expression", mutating: true,
      desc: "LAST RESORT: set a raw expression (or clear with ''). Prefer " +
            "link_property / apply_expression_preset — they generate " +
            "correct syntax. Invalid expressions are rejected with AE's " +
            "error text.",
      args: "{comp?: string, layer: name|index, property: transform name or 'effect.<EffectName>.<ParamName>', expression: string}" },
    { name: "apply_effect", mutating: true,
      desc: "Apply an effect to a layer. Returns the effect's parameter names.",
      args: "{comp?: string, layer: name|index, effect: display name or match name (e.g. 'Gaussian Blur' or 'ADBE Gaussian Blur 2')}" },
    { name: "set_effect_param", mutating: true,
      desc: "Set a parameter on an effect already applied to a layer.",
      args: "{comp?: string, layer: name|index, effect: string, param: string, value: number|[..]|string}" },
    { name: "set_layer_timing", mutating: true,
      desc: "Set layer inPoint/outPoint/startTime (seconds).",
      args: "{comp?: string, layer: name|index, inPoint?: s, outPoint?: s, startTime?: s}" },
    { name: "duplicate_layer", mutating: true,
      desc: "Duplicate a LAYER inside its comp (use duplicate_comp only " +
            "for whole compositions). Omit 'layer' to use the user's " +
            "selected layer. Make N copies in ONE call with count — " +
            "copies auto-number ('Circle 2', 'Circle 3', …) because " +
            "duplicate names break name-based references.",
      args: "{comp?: string, layer?: name|index (omit = selected layer), name?: string (base name), count?: copies to make (default 1, max 100)}" },
    { name: "split_layer_into_chunks", mutating: true,
      desc: "Cut a layer into chunks, each on its own layer trimmed to " +
            "its own window — ONE call does the whole edit. Pass chunks " +
            "for an exact piece count ('5 equal chunks' = {chunks: 5}) " +
            "OR chunkSeconds for a fixed piece length; the host does all " +
            "math. Omit 'layer' to use the user's selected layer. Chunks " +
            "NEVER overlap and play seamlessly end-to-end; offsetPerChunk " +
            "only adds EXTRA spacing (gaps) of i*offset seconds. Chunks " +
            "stack ascending by default (later chunks HIGHER in the " +
            "stack — bars staircase upward; 'descending' puts chunk 1 on " +
            "top) and end up SELECTED, so follow-up commands can target " +
            "them by selection. Cuts always land on whole comp FRAMES, " +
            "and a piece too short to hold a frame is refused rather " +
            "than created invisible.",
      args: "{comp?: string, layer?: name|index (omit = selected layer), chunks?: exact piece count, chunkSeconds?: s, offsetPerChunk?: s (extra gaps only), order?: 'ascending'|'descending' (stack order, default ascending)}" },
    { name: "reorder_layers", mutating: true,
      desc: "Restack layers WITHOUT changing their timing. 'ascending' " +
            "(default) = later start times sit higher in the stack (bars " +
            "staircase upward); 'descending' = earliest on top. Targets " +
            "the selection when 'layers' omitted, else every layer in the " +
            "comp. Use for 'change/sort the layer order'. by:'name' sorts " +
            "numbers inside names numerically ('X 2' before 'X 10'). " +
            "Layers with equal keys keep the stack order they had. The " +
            "targets end up CONTIGUOUS, which can push untargeted layers " +
            "aside — the result reports how many.",
      args: "{comp?: string, layers?: [name|index] (omit = selection, else all), by?: 'startTime'|'inPoint'|'name' (default startTime), order?: 'ascending'|'descending'}" },
    { name: "delete_layer", mutating: true,
      desc: "Delete a layer from a comp.",
      args: "{comp?: string, layer: name|index}" },
    { name: "set_comp_setting", mutating: true,
      desc: "Change a comp setting (duration, frame rate, bg color). Its " +
            "width/height change ONLY the canvas and leave layers stuck at " +
            "the top-left — to resize a comp, use scale_comp instead.",
      args: "{comp?: string, duration?: s, frameRate?: number, width?: int, height?: int, bgColor?: [r,g,b] 0..1}" },
    { name: "scale_comp", mutating: true,
      desc: "Resize a comp AND scale its content to match, re-centered — " +
            "like the native 'Scale Composition' script. Uniform factor " +
            "(no distortion): when the aspect changes, mode 'fit' " +
            "letterboxes (default) and 'fill' crops. Parented layers " +
            "follow their parents automatically (a parented CAMERA still " +
            "gets its zoom rescaled — zoom is not inherited). A LIGHT's " +
            "pixel options (Radius, Falloff Distance, Shadow Diffusion) " +
            "are rescaled too, parented or not, and come back in " +
            "'lightOptionsRescaled'; ambient and environment lights have " +
            "nothing scalable and are listed in " +
            "'layersWithNothingToScale' rather than counted as " +
            "failures. Keyframed " +
            "transforms come along whole: values, motion-path handles " +
            "and ease speeds all scale, so animation keeps its shape. " +
            "Use this for any 'make the comp WxH' / 'scale the comp' " +
            "request.",
      args: "{comp?: string, width?: px, height?: px (omit one to keep aspect), factor?: number (e.g. 0.5 = half), mode?: 'fit'|'fill'}" },
    { name: "import_file", mutating: true,
      desc: "Import a footage/image/video file into the project.",
      args: "{path: string (absolute)}" },
    { name: "add_shape_layer", mutating: true,
      desc: "Add a shape layer (rectangle, ellipse, polygon, or star).",
      args: "{comp?: string, name?: string, shape?: 'rectangle'|'ellipse'|'polygon'|'star', size?: [w,h], position?: [x,y], fillColor?: [r,g,b] 0..1, strokeColor?: [r,g,b], strokeWidth?: px, roundness?: px (rectangle), points?: int (polygon/star)}" },
    { name: "add_mask", mutating: true,
      desc: "Add a mask to a layer. Coordinates are in LAYER space.",
      args: "{comp?: string, layer: name|index, shape?: 'rectangle'|'ellipse'|'custom', bounds?: [x,y,w,h], vertices?: [[x,y],...] (custom), mode?: 'add'|'subtract'|'intersect'|..., inverted?: bool, feather?: px, name?: string}" },
    { name: "set_mask", mutating: true,
      desc: "Edit an EXISTING mask: mode, feather, expansion, opacity, " +
            "inverted, rename. Omit 'mask' when the layer has exactly one.",
      args: "{comp?: string, layer?: name|index (omit = selected), mask?: name|1-based index, mode?: add|subtract|intersect|lighten|darken|difference|none, feather?: px|[x,y], expansion?: px, opacity?: %, inverted?: bool, name?: string}" },
    { name: "set_mask_path", mutating: true,
      desc: "Replace or ANIMATE a mask's path. Points are LAYER-space " +
            "[[x,y],…]; curves via inTangents/outTangents (one tangent " +
            "per vertex, as offsets from it). atTime keyframes one " +
            "shape; keys animates several in one call. EVERY key of one " +
            "mask must have the SAME number of points — AE cannot " +
            "interpolate paths with different counts, so pad a simpler " +
            "shape by repeating a vertex. Key times are moved onto whole " +
            "comp frames. Use atTime/keys on a path that already has " +
            "keyframes; a bare vertices list only sets a STATIC path.",
      args: "{comp?: string, layer?: name|index, mask?: name|index, vertices?: [[x,y],…], inTangents?: [[x,y],…], outTangents?: [[x,y],…], closed?: bool (default true), atTime?: s, keys?: [{time: s, vertices, inTangents?, outTangents?}, …]}" },
    { name: "add_shape_content", mutating: true,
      desc: "Add content INSIDE a shape layer: kinds group, rectangle, " +
            "ellipse, star, polygon, path, fill, stroke, gradient_fill, " +
            "gradient_stroke, repeater, trim_paths, merge_paths, " +
            "offset_paths, rounded_corners, pucker_bloat, twist, zigzag. " +
            "params sets the new item's values by name ({Size: [200,200], " +
            "Color: [1,0,0], Copies: 5, End: 50}). Animate afterwards via " +
            "set_keyframes on 'contents/…' paths.",
      args: "{comp?: string, layer?: name|index (shape layer; omit = selected), kind: string, group?: name (add inside this group), name?: string, params?: {ParamName: value, …}}" },
    { name: "precompose", mutating: true,
      desc: "Move layers into a new nested comp (precompose).",
      args: "{comp?: string, layers: [name|index, ...], name: string, moveAttributes?: bool = true}" },
    { name: "add_camera", mutating: true,
      desc: "Add a camera. Only 3D layers (set_layer_3d) are affected by it. " +
            "oneNode:true makes a free camera with no Point of Interest.",
      args: "{comp?: string, name?: string, position?: [x,y,z], pointOfInterest?: [x,y,z], zoom?: px, oneNode?: bool}" },
    { name: "add_light", mutating: true,
      desc: "Add a light. Only 3D layers (set_layer_3d) with Accepts " +
            "Lights on are lit by it. Each type hides most options: " +
            "spot takes everything; parallel has no cone/shadowDiffusion; " +
            "point has no cone and no pointOfInterest; ambient and " +
            "environment take only intensity and color — not even a " +
            "position. radius/falloffDistance need falloff set too. " +
            "oneNode:true makes a free light with no Point of Interest.",
      args: "{comp?: string, name?: string, type?: parallel|spot|point|ambient|environment (default spot), " +
            "position?: [x,y,z], pointOfInterest?: [x,y,z], oneNode?: bool, " +
            "intensity?: %, color?: [r,g,b] 0-1, coneAngle?: deg, coneFeather?: %, " +
            "falloff?: none|smooth|inverseSquareClamped, radius?: px, falloffDistance?: px, " +
            "castsShadows?: bool, shadowDarkness?: %, shadowDiffusion?: px}" },
    { name: "add_marker", mutating: true,
      desc: "Add a marker to the comp (omit 'layer') or to a layer.",
      args: "{comp?: string, layer?: name|index, time: seconds, comment?: string, duration?: seconds}" },
    { name: "set_layer_3d", mutating: true,
      desc: "Enable/disable a layer's 3D switch. Turning 3D OFF is " +
            "destructive: AE zeroes Position/Anchor Point Z, resets " +
            "Scale Z to 100 and clears Orientation and X/Y Rotation " +
            "(keyframes included), and turning 3D back on does not " +
            "restore them. Whatever was lost comes back in `discarded`.",
      args: "{comp?: string, layer: name|index, enabled: bool}" },
    { name: "set_layer_parent", mutating: true,
      desc: "Parent layers to another layer (omit/null parent to " +
            "unparent). Visual positions are preserved by default. Omit " +
            "layer/layers to use the selection.",
      args: "{comp?: string, layer?: name|index, layers?: [name|index], parent?: name|index|null, keepPosition?: bool (default true)}" },
    { name: "list_properties", mutating: false,
      desc: "DISCOVER a layer's real property tree — names, paths, types, " +
            "current values. Use this whenever a parameter/effect/mask " +
            "path is unknown instead of guessing. Narrow with path " +
            "('effects/Gaussian Blur', 'masks', 'text') and depth.",
      args: "{comp?: string, layer?: name|index (omit = selected layer), path?: string, depth?: 1-3 (default 2)}" },
    { name: "get_property", mutating: false,
      desc: "Read ANY property by path: value, keyframes, expression. A " +
            "BARE property name works too ('Radius', 'Blurriness') — " +
            "unknown names are searched down the layer's tree and the " +
            "result reports where it landed in `resolvedPath`. Two " +
            "properties with the same name are refused, listing both.",
      args: "{comp?: string, layer?: name|index, property: friendly name | bare name | 'effect.X.Y' | 'group/child/…' path}" },
    { name: "set_property", mutating: true,
      desc: "Set ANY property by path — the universal fallback when no " +
            "dedicated tool fits. Takes the same bare names get_property " +
            "does. atTime creates a keyframe at that time.",
      args: "{comp?: string, layer?: name|index, property: path (see get_property), value: number|[..]|string|bool, atTime?: seconds}" },
    { name: "set_keyframes", mutating: true,
      desc: "Set the SAME keyframes on MANY layers in ONE call. " +
            "relativeTo: 'inPoint' offsets every key by each layer's own " +
            "start, so staggered layers keep their offsets. Follow with " +
            "one apply_keyframe_ease for easing. NEVER loop this per " +
            "layer.",
      args: "{comp?: string, layers?: [name|index] | layer?: name|index (omit = selection), property: path, keys: [{time: s, value: any}, …] (max 100), relativeTo?: 'inPoint'}" },
    { name: "remove_keyframes", mutating: true,
      desc: "Remove keyframes from a property on many layers at once — " +
            "specific times or all.",
      args: "{comp?: string, layers?: [name|index] | layer?: name|index (omit = selection), property: path, times?: [s, …] (omit = remove ALL)}" },
    { name: "for_each_layer", mutating: true,
      desc: "Run a PER-LAYER tool once per target layer in ONE call (max " +
            "200 layers) — the batch executor for anything without its " +
            "own layers arg: {tool: 'apply_effect', args: {effect: " +
            "'Gaussian Blur'}} blurs every target. Reports succeeded " +
            "count + failures. 'tool' must be a tool that takes a single " +
            "{layer} (apply_effect, set_transform, set_property, " +
            "set_effect_param, add_mask, duplicate_layer, delete_layer, …); " +
            "tools with their own {layers} list (set_keyframes, " +
            "grid_layout, distribute_property, stagger_layers, " +
            "apply_keyframe_ease, reorder_layers, precompose) are called " +
            "ONCE directly, and comp/project tools (create_comp, " +
            "add_solid, add_null, scale_comp) are refused — they have no " +
            "layer to run on.",
      args: "{comp?: string, layers?: [name|index] (omit = selection, else the comp's only layer), tool: string (a per-layer tool), args: {…the tool's args, minus comp/layer…}}" },
    { name: "set_track_matte", mutating: true,
      desc: "Use one layer as another's track matte (alpha or luma, " +
            "optionally inverted), or remove it with mode 'none'. No " +
            "layer-stacking requirement.",
      args: "{comp?: string, layer?: name|index (the layer being matted; omit = selected), matteLayer: name|index, mode: 'alpha'|'alpha_inverted'|'luma'|'luma_inverted'|'none'}" },
    { name: "list_effects", mutating: false,
      desc: "Enumerate effects INSTALLED in this AE (name, matchName, " +
            "category), filtered and paged. Check here before apply_effect " +
            "when unsure of a name.",
      args: "{filter?: substring of name/category, offset?: int}" },
    { name: "add_to_render_queue", mutating: true,
      desc: "Add a comp to the render queue.",
      args: "{comp?: string, outputPath?: string (absolute)}" },
    { name: "comfy_status", mutating: false,
      desc: "Check the local ComfyUI instance (online? queue depth?).",
      args: "{}" },
    { name: "comfy_list_workflows", mutating: false,
      desc: "List available ComfyUI generation workflow templates by name.",
      args: "{}" },
    { name: "comfy_generate", mutating: true,
      desc: "Generate an image/video with local ComfyUI and import it into " +
            "the AE project. Blocks until finished (may take minutes). If " +
            "the hidden backend is installed it BOOTS AUTOMATICALLY — " +
            "never tell the user to start ComfyUI first.",
      args: "{workflow: string (name from comfy_list_workflows), prompt: string, negative?: string, width?: int, height?: int, seed?: int, frames?: int (video workflows), durationSeconds?: number (video templates whose length is set in seconds — the error tells you which), image?: string (absolute path to a reference/first-frame image), import?: bool = true}" }
  ];

  var TOOL_NAMES = [];
  var MUTATING = {};
  for (var i = 0; i < TOOL_DEFS.length; i++) {
    TOOL_NAMES.push(TOOL_DEFS[i].name);
    if (TOOL_DEFS[i].mutating) MUTATING[TOOL_DEFS[i].name] = true;
  }

  // Forced output shape for constrained decoding (llama.cpp json_schema).
  var RESPONSE_SCHEMA = {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description: "Short message to the user about what you are doing."
      },
      commands: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", "enum": TOOL_NAMES },
            args: { type: "object" }
          },
          required: ["tool", "args"]
        }
      }
    },
    required: ["reply", "commands"]
  };

  function buildSystemPrompt(projectStateJson) {
    var lines = [
      "You are an assistant embedded in Adobe After Effects. You control AE",
      "by emitting JSON tool commands, which the host executes and reports",
      "back to you as TOOL RESULTS on the next turn.",
      "",
      "Always answer with a single JSON object:",
      '  {"reply": "<short status for the user>", "commands": [{"tool": "...", "args": {...}}, ...]}',
      "",
      "Rules:",
      "- Use ONLY the tools listed below. Emit no other text or markup.",
      "- When the request is complete (or purely conversational), return",
      '  "commands": [] and summarize the outcome in "reply".',
      "- Look at TOOL RESULTS before continuing; fix errors they report.",
      "- A result marked \"ROLLED BACK\" means the WHOLE round was undone",
      "  because one of its commands failed: nothing from it exists, not",
      "  even the commands that reported ok. Your NEXT reply must do two",
      "  things — resend the commands that CAN succeed (without the one",
      "  that failed), and say plainly in 'reply' what you could not do.",
      "  Never report a rolled-back command as created/added/applied, and",
      "  never stop just because one part is impossible: do the rest.",
      "- Times are in seconds. Colors are [r,g,b] floats 0..1.",
      "- Positions are pixel coordinates [x,y] from the comp's top-left.",
      "- UNITS: scale and opacity are PERCENT (100 = normal size, 200 =",
      "  double, 50 = half). NEVER send 2 to mean 200%. Rotation is in",
      "  degrees. 'scale BY X%' is relative:true; 'scale TO X%' is absolute.",
      "- Anchor points are in LAYER space, not comp space. To center one,",
      "  call center_anchor_point — never set anchorPoint coordinates by",
      "  guesswork.",
      "- Your reply text is shown BEFORE your commands run. Phrase it as",
      "  intent ('Centering the anchor point…'), then after reading TOOL",
      "  RESULTS confirm what actually happened — including any 'warning'",
      "  fields, which mean the result is probably not what the user wanted.",
      "- 'layer' accepts a layer name or a 1-based index from the top.",
      "- Omit 'comp' to target the active comp.",
      "- Prefer inspecting (get_project_info / get_comp_details) before",
      "  modifying things you have not seen.",
      "- Layers the user has SELECTED in AE are marked selected: true in",
      "  the comp details. When the user says 'the selected layer(s)' /",
      "  'this layer' / 'these layers', OMIT the layer/layers argument —",
      "  grid_layout, stagger_layers, distribute_property, duplicate_layer",
      "  and split_layer_into_chunks all use the selection automatically.",
      "  NEVER pass placeholder text like \"these layers\" or \"selected\"",
      "  as a layer name — layer args must be real names or indexes from",
      "  the project state, or omitted.",
      "- Omitting 'comp' targets the ACTIVE comp — creating or duplicating",
      "  a comp does NOT make it active. After create_comp/duplicate_comp/",
      "  precompose, always pass comp: \"<name>\" explicitly, and take the",
      "  name from the tool RESULT — create_comp auto-numbers when the",
      "  name is already taken ('Comp 2'), so the result name is the",
      "  only correct one. Commands in the SAME reply as create_comp that",
      "  use the requested name are auto-redirected to the new comp; from",
      "  the NEXT reply on, use the result name.",
      "- To cut a layer into timed pieces ('split into chunks', 'stagger",
      "  segments'), use split_layer_into_chunks — ONE call. Never emulate",
      "  it with duplicate_comp or repeated retiming of the same layer.",
      "  'split into N chunks/pieces' = {chunks: N} — the host divides the",
      "  layer's span itself; NEVER compute chunkSeconds from durations.",
      "  'split into X-second chunks' = {chunkSeconds: X}. Chunks never",
      "  overlap on their own — omit offsetPerChunk unless the user",
      "  explicitly wants extra gaps between the pieces. Chunks stack",
      "  ascending by default (later chunks HIGHER in the stack, bars",
      "  building a staircase upward); order: 'descending' = chunk 1 on",
      "  top, staircase downward.",
      "- 'change/sort the layer order or stacking' = reorder_layers. It",
      "  restacks only — start times are untouched. ascending = later",
      "  start times higher in the stack (staircase up); descending =",
      "  earliest on top (staircase down). Omit 'layers' to use the",
      "  selection (or all layers when nothing is selected). Do NOT use",
      "  stagger_layers to reorder — it changes TIMES, not stacking.",
      "- To RESIZE a comp ('make it 1920x1080', 'scale the comp down'),",
      "  use scale_comp — it scales and re-centers the content like the",
      "  native Scale Composition script. set_comp_setting width/height",
      "  strands the layers at the old top-left; never use it to resize.",
      "- ACT, DON'T ASK: tools have working defaults — omit 'layers' for",
      "  the selection, omit spread/startAt to use the comp's work area,",
      "  omit bezier for linear. NEVER tell the user to select layers or",
      "  supply numbers first: split_layer_into_chunks leaves its chunks",
      "  SELECTED, so a follow-up like 'stagger them' is just",
      "  stagger_layers {} with no arguments.",
      "- grid_layout creates its own control null (controlLayer only",
      "  names it) — NEVER call add_null before gridding. With nothing",
      "  selected it grids ALL content layers, so 'arrange all layers in",
      "  a grid' is ONE grid_layout call with 'layers' omitted. Never",
      "  pass layers: [] — omit the argument instead.",
      "- SCOPE: do ONLY what the user asked, then stop. Never bolt on",
      "  extra steps they did not request (grids, effects, styling,",
      "  animation). Defaults decide HOW a requested step runs — never",
      "  WHAT gets done.",
      "- MACRO TOOLS ARE COMPLETE: when grid_layout /",
      "  split_layer_into_chunks / stagger_layers succeeds, the request",
      "  it covers is DONE — grid_layout's null ALREADY has the X/Y",
      "  spacing and Columns sliders ('controllers'). Do not rebuild or",
      "  augment what a macro just delivered on your own initiative;",
      "  extra nulls, controls, or links are fine WHEN THE USER ASKS for",
      "  them (an explicit request always outranks this rule). Never",
      "  drive a control null's own Transform with expressions as a",
      "  workaround for a failed call — report the failure instead.",
      "- 'put N copies/shapes in a comp' = create ONE layer, then ONE",
      "  duplicate_layer call with {count: N-1}. Never chain single",
      "  duplicates, and NEVER give two layers the same name.",
      "- Report counts from tool results (created / totalLayersInComp) —",
      "  never claim a number you did not verify.",
      "- Emit AT MOST 8 commands per reply and keep them compact — output",
      "  space is limited and an oversized reply gets cut off. More work?",
      "  Stop after 8 and continue after TOOL RESULTS.",
      "- 'each X' / 'every X' / 'all the Xs' names a CLASS of layers —",
      "  pass {layers: [...]} with those exact names from the project",
      "  state (e.g. every \"Square*\" layer), NEVER the selection: the",
      "  user may have a control null selected from inspecting sliders.",
      "  Control nulls (GRID CTRL etc.) are never animation targets",
      "  unless the user names them.",
      "- BATCH, NEVER LOOP: when many layers need the same change, one",
      "  call handles ALL of them — set_keyframes/apply_keyframe_ease/",
      "  remove_keyframes take {layers} (or the selection) directly, with",
      "  relativeTo: 'inPoint' keeping staggered offsets; anything else",
      "  goes through for_each_layer {tool, args}. 'Animate 100 squares:",
      "  stagger + scale + rotate + ease' is FIVE calls total",
      "  (stagger_layers, 2x set_keyframes, 2x apply_keyframe_ease) —",
      "  never 300. Per-layer looping runs out of tool rounds.",
      "- 'distribute/space layers equidistantly / every X px' =",
      "  distribute_property {property: position_x, step: X} — ONE call,",
      "  never a chain of set_transform/duplicate calls.",
      "- If distribute_property reports overriddenByExpression (a rig like",
      "  grid_layout drives the property), the user's explicit request",
      "  WINS: re-call it ONCE with clearExpressions: true and the SAME",
      "  layers list as the first call — NOT just the ones it named as",
      "  overridden, or the spacing is divided across those few and the",
      "  layers that already landed are stranded mid-row. Then tell the",
      "  user which layers had their expressions removed. Never pass",
      "  clearExpressions on a first call, and never use it when the user",
      "  asked to keep the rig.",
      "- 'stagger them X frames apart' = stagger_layers {stepFrames: X}.",
      "  stagger_layers 'spread' is the TOTAL span of the whole stagger,",
      "  NOT the gap between layers — for a per-layer gap use step /",
      "  stepFrames, or the nine layers land half a frame apart.",
      "- add_text_layer already starts new text from a clean baseline",
      "  (white, 72px, tracking 0, auto leading, a plain sans) — do NOT",
      "  follow it with set_text_style just to undo AE's Character",
      "  panel. Only pass the fields the user actually asked for.",
      "",
      "Universal property access (reach ANY parameter in AE):",
      "- Unknown parameter, effect setting, mask or text property? NEVER",
      "  guess names — call list_properties {layer} (narrow with {path:",
      "  \"effects/Gaussian Blur\"}) to see the real tree, then",
      "  get_property / set_property with a discovered path.",
      "- Paths join names with '/' (display or match names):",
      "  'transform/Position', 'effects/Gaussian Blur/Blurriness',",
      "  'masks/Mask 1/Mask Feather'. Root aliases: transform, effects,",
      "  masks, text, contents, styles, camera, light, audio, timeRemap.",
      "- Animate anything: set_keyframes {property, keys: [{time, value},",
      "  …]} in ONE call, then apply_keyframe_ease for easing.",
      "  set_property {atTime} sets a single keyframed value.",
      "- Unsure an effect exists or of its exact name? list_effects",
      "  {filter} searches everything installed; apply_effect accepts the",
      "  returned name or matchName.",
      "- set_track_matte mattes one layer with another (alpha/luma,",
      "  inverted variants, 'none' removes). set_layer_parent parents",
      "  (selection default, visual position preserved).",
      "",
      "Masks & shape content:",
      "- add_mask creates a mask (rectangle/ellipse/custom points);",
      "  set_mask edits mode/feather/expansion/opacity/inverted;",
      "  set_mask_path moves or ANIMATES the points (atTime or keys).",
      "  Mask points are LAYER space, not comp space.",
      "- Build shape layers in steps: add_shape_layer once, then",
      "  add_shape_content per item — a group, then shapes/fills/strokes/",
      "  repeaters/trim_paths inside it via {group}. Set initial values",
      "  with params; animate them with set_keyframes on",
      "  'contents/<Group>/<Item>/<Param>' paths.",
      "- Mask path keys must all carry the SAME point count (repeat a",
      "  vertex to pad); AE cannot tween paths of different counts.",
      "- 'animate the mask / wipe it on' = set_mask_path {keys: […]} or",
      "  add trim_paths and keyframe its End — never hand-write",
      "  expressions for plain keyframe animation.",
      "- Curve requests: 'stagger with an ease' = stagger_layers with",
      "  spread + bezier (step mode is evenly spaced, no curve);",
      "  'ramp opacity/scale across these layers' = distribute_property;",
      "  'ease between the keyframes' = apply_keyframe_ease. All take the",
      "  same CSS-style bezier [x1,y1,x2,y2].",
      "",
      "Renaming MANY comps (a naming convention / cleanup job):",
      "- Use rename_comps ONCE for the whole job. Never rename_item in a",
      "  loop, and never work out the new names yourself — the tool",
      "  applies the convention and gets the year rules right.",
      "- It answers with a PREVIEW first (dryRun defaults to true). Put",
      "  the plan and every skip reason in your reply and STOP there.",
      "  Call it again with dryRun:false only after the user says go.",
      "- audit_comp_usage answers 'what would this break?' on its own.",
      "  Renaming a comp that an expression names as a string BREAKS that",
      "  expression, so rename_comps always skips those; do not try to",
      "  work around it with rename_item.",
      "",
      "Project panel management:",
      "- create_folder / move_to_folder / rename_item / delete_item /",
      "  duplicate_comp / organize_project manage the project panel. Items",
      "  are referenced by name or id; folders also by PATH written as",
      "  ParentName/ChildName, or 'root' for the project root.",
      "  get_project_info shows each item's parent folder and each",
      "  folder's path. Same-named folders under different parents are",
      "  normal — use paths when names repeat.",
      "- Use ONLY folder and item names that appear in CURRENT PROJECT",
      "  STATE or a get_project_info result. NEVER guess a name and never",
      "  copy placeholder names from these instructions. If a lookup",
      "  fails, the error lists the folders that really exist — pick from",
      "  those or ask the user; do not invent a fallback.",
      "- 'add a folder inside each/every subfolder of X' = create_folder",
      "  {name, eachChildOf: 'X'} — ONE call. The host finds the real",
      "  subfolders itself; never list them from the PROJECT STATE (it is",
      "  trimmed on big projects) and never emit one call per folder.",
      "  'except (for) Y' rides the SAME call: except: ['Y'] — copy the",
      "  user's folder names exactly (underscores included). The result's",
      "  created/createdCount/skippedAsExcepted are the receipts — report",
      "  THOSE numbers, nothing else.",
      "- NEVER claim an action you did not emit commands for in this same",
      "  response. If no available tool can do it, say so plainly and",
      "  return commands: [].",
      "",
      "Rigging (sliders on nulls driving properties):",
      "1. add_null {name: 'CTRL'}",
      "2. add_control {layer: 'CTRL', type: 'slider', name: 'Speed', value: 50}",
      "3. link_property {layer: 'Title', property: 'rotation',",
      "   controlLayer: 'CTRL', controlEffect: 'Speed'}",
      "The panel generates all expression code itself with correct syntax.",
      "",
      "Expressions:",
      "- NEVER write expression code yourself when link_property or",
      "  apply_expression_preset can do it — they cannot produce syntax",
      "  errors, your hand-written code often does.",
      "- set_expression is a last resort. If AE rejects your expression, the",
      "  error text comes back in TOOL RESULTS — read it and fix that exact",
      "  problem; do not resend the same code.",
      "- Known-good forms if you must write one: wiggle(2, 30)",
      "  | loopOut(\"cycle\") | value + time * 50",
      "  | thisComp.layer(\"CTRL\").effect(\"Speed\")(1)",
      "- comfy_generate renders with a LOCAL ComfyUI instance and imports",
      "  the result into the project (result data lists imported item",
      "  names). The hidden backend auto-starts when installed — just",
      "  call comfy_generate; do not ask the user to launch anything.",
      "  Pick a template via comfy_list_workflows. Match width/height to",
      "  the target comp when it makes sense. Generation can take",
      "  minutes — do not repeat a request that already succeeded.",
      "  Some video templates set length in SECONDS (durationSeconds),",
      "  not frames; if one refuses your 'frames' it says so — re-call",
      "  with durationSeconds. Pass image: <absolute path> to give a",
      "  video template a first frame; omit it for text-to-video.",
      "",
      "Available tools:"
    ];
    for (var i = 0; i < TOOL_DEFS.length; i++) {
      var t = TOOL_DEFS[i];
      lines.push("- " + t.name + " " + t.args);
      lines.push("    " + t.desc);
    }
    if (projectStateJson) {
      lines.push("");
      lines.push("CURRENT PROJECT STATE:");
      lines.push(projectStateJson);
    }
    return lines.join("\n");
  }

  function isKnownTool(name) {
    for (var i = 0; i < TOOL_NAMES.length; i++) {
      if (TOOL_NAMES[i] === name) return true;
    }
    return false;
  }

  // ------------------------------------------------- panel-side tools

  // Progress sink so long generations can narrate into the chat UI.
  var progressSink = null;

  // ------------------------------------------------------ VRAM arbiter
  //
  // Chat (llama-server) and generation (ComfyUI) share one card. The
  // tier decides a policy, but the gate is arithmetic at request time
  // over what is REALLY loaded (the model file on disk, the manifest's
  // weights) — see docs/COMFY_TIERS_PLAN.md. One pause covers every
  // generation in a round; the resume happens ONCE, after the last
  // command and before the model formulates its reply, so five
  // variations in one round cost one handoff, not five.

  var gpuCache = null;   // main.js (and the probe) push detectGpu's result

  function setGpuInfo(g) { gpuCache = g; }

  /** What the running chat model really holds, from its file on disk. */
  function chatLoadedMBNow() {
    var running = false;
    try { running = global.Llama.getState() === "running"; } catch (e) {}
    if (!running) return { running: false, mb: null };
    try {
      var p = global.Llama.getCurrentModel();
      var bytes = global.AEBridge.nodeRequire("fs").statSync(p).size;
      // Weights plus KV cache and runtime overhead — llama-server's
      // footprint runs roughly file size + 1-2 GB at 16k context.
      return { running: true, mb: Math.round(bytes / 1048576) + 1536 };
    } catch (e2) {
      return { running: true, mb: null };   // unprovable, not "zero"
    }
  }

  /** The generation's weight bill from its workflow manifest, if known. */
  function genNeedMBFor(manifest) {
    if (!manifest || !(manifest.models instanceof Array)) return null;
    var sum = 0, known = false;
    for (var i = 0; i < manifest.models.length; i++) {
      var m = manifest.models[i];
      if (m && !m.optional && typeof m.sizeMB === "number" && m.sizeMB > 0) {
        sum += m.sizeMB;
        known = true;
      }
    }
    return known ? sum : null;
  }

  /**
   * Poll nvidia-smi until total used VRAM drops by ~half the released
   * model (or a 10 s timeout — proceed either way, loudly). A fixed
   * sleep after kill was hope, not verification: the old process
   * releases its allocation asynchronously.
   */
  function waitForVramDrop(baselineMB, expectDropMB, sink, done) {
    if (typeof baselineMB !== "number") {
      // nvidia-smi unavailable — the old fixed grace period is all we have.
      global.setTimeout(done, 1500);
      return;
    }
    var target = Math.max(512,
      typeof expectDropMB === "number" ? Math.round(expectDropMB / 2) : 512);
    var waited = 0;
    var STEP = 500;
    var LIMIT = 10000;
    (function poll() {
      global.Setup.queryVramUsedMB(function (err, usedMB) {
        if (!err && baselineMB - usedMB >= target) { done(); return; }
        waited += STEP;
        if (err || waited >= LIMIT) {
          if (sink && waited >= LIMIT) {
            sink("VRAM did not visibly release within 10 s — proceeding " +
                 "anyway.");
          }
          done();
          return;
        }
        global.setTimeout(poll, STEP);
      });
    })();
  }

  var VramArbiter = {
    paused: false,
    _opts: null,

    /**
     * Decide and, when the arithmetic says so, perform the chat→gen
     * handoff with verified release. cb(refusalResult|null) — a refusal
     * is a grounded {ok:false} the caller returns as the tool result,
     * BEFORE any VRAM churn.
     */
    ensureFor: function (s, manifest, sink, cb) {
      if (VramArbiter.paused) { cb(null); return; }   // this round already paid
      var chat = chatLoadedMBNow();
      var eff = global.Tiers.effectiveVram(gpuCache, s);
      var tier = global.Tiers.tierFor(eff.vramGB);
      var decision = global.Tiers.planHandoff({
        vramGB: eff.vramGB,
        headroomGB: tier.headroomGB,
        chatRunning: chat.running,
        chatLoadedMB: chat.mb,
        genNeedMB: genNeedMBFor(manifest),
        pauseMode: s.comfyPauseLlm,
        mandatory: tier.mandatory
      });
      if (decision.mode === "refuse") {
        cb({ ok: false, error: decision.reason });
        return;
      }
      if (decision.mode === "concurrent") { cb(null); return; }
      if (sink) {
        sink("Pausing the chat model to free VRAM for generation — " +
             decision.reason + "…");
      }
      VramArbiter.paused = true;
      VramArbiter._opts = { serverPath: s.serverPath,
        modelPath: s.modelPath, port: s.port, ctxSize: s.ctxSize,
        gpuLayers: s.gpuLayers };
      global.Setup.queryVramUsedMB(function (qErr, baseMB) {
        global.Llama.stop();
        waitForVramDrop(qErr ? null : baseMB, chat.mb, sink,
                        function () { cb(null); });
      });
    },

    /**
     * The gen→chat half, run once per round after the last command:
     * ask ComfyUI to drop its cached models (they otherwise sit in VRAM
     * and block the chat model from coming back on exclusive tiers),
     * verify the release, then warm the chat model back up.
     */
    resumeIfPaused: function (s, sink, cb) {
      if (!VramArbiter.paused) { cb(); return; }
      VramArbiter.paused = false;
      var opts = VramArbiter._opts;
      VramArbiter._opts = null;
      global.Setup.queryVramUsedMB(function (qErr, baseMB) {
        global.Comfy.freeVram(s.comfyUrl, function () {
          waitForVramDrop(qErr ? null : baseMB, null, sink, function () {
            if (sink) sink("Warming the chat model back up…");
            global.Llama.start(opts, function () { cb(); });
          });
        });
      });
    }
  };

  var PANEL_TOOLS = {

    comfy_status: function (args, cb) {
      var s = global.Settings.get();
      global.Comfy.status(s.comfyUrl, function (err, st) {
        cb({ ok: true, data: st });
      });
    },

    comfy_list_workflows: function (args, cb) {
      var s = global.Settings.get();
      var list = global.Comfy.listWorkflows(s.comfyWorkflowsDir);
      var names = [];
      for (var i = 0; i < list.length; i++) names.push(list[i].name);
      if (names.length === 0) {
        cb({ ok: false, error: "No workflow templates in " +
             s.comfyWorkflowsDir + ". Export API-format workflows from " +
             "ComfyUI into that folder." });
        return;
      }
      cb({ ok: true, data: { workflows: names } });
    },

    comfy_generate: function (args, cb) {
      var s = global.Settings.get();
      if (!args || typeof args.prompt !== "string" || !args.prompt) {
        cb({ ok: false, error: "'prompt' is required" });
        return;
      }
      var list = global.Comfy.listWorkflows(s.comfyWorkflowsDir);
      if (list.length === 0) {
        cb({ ok: false, error: "No workflow templates in " +
             s.comfyWorkflowsDir });
        return;
      }
      var chosen = list[0];
      if (args.workflow) {
        var found = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].name.toLowerCase() === String(args.workflow).toLowerCase()) {
            found = list[i];
            break;
          }
        }
        if (!found) {
          var names = [];
          for (var j = 0; j < list.length; j++) names.push(list[j].name);
          cb({ ok: false, error: "Unknown workflow '" + args.workflow +
               "'. Available: " + names.join(", ") });
          return;
        }
        chosen = found;
      }

      // Generation models and the chat LLM fight over VRAM. The module
      // arbiter above decides per job (tier arithmetic over what is
      // really loaded) and owns the pause; the resume happens once at
      // the end of the round, so several generations in one round pay
      // for one handoff. Transparent to the model.
      var enhancedPrompt = null;
      function finish(result) {
        if (result && result.ok && result.data && enhancedPrompt !== null) {
          result.data.promptUsed = enhancedPrompt;
          result.data.enhanced = true;
        }
        cb(result);
      }
      function begin() {
      // Boot the hidden backend first if nothing answers at the URL —
      // the user never has to start ComfyUI by hand.
      global.Comfy.ensureRunning(s.comfyUrl, function (bootMsg) {
        if (progressSink) progressSink(bootMsg);
      }, function (bootErr) {
      if (bootErr) { finish({ ok: false, error: bootErr.message }); return; }
      global.Comfy.generate({
        comfyUrl: s.comfyUrl,
        workflowFile: chosen.file,
        outDir: s.comfyOutDir,
        timeoutSec: s.comfyTimeoutSec,
        manifest: manifest,
        params: {
          prompt: enhancedPrompt !== null ? enhancedPrompt : args.prompt,
          negative: args.negative,
          width: args.width,
          height: args.height,
          seed: args.seed,
          frames: args.frames,
          durationSeconds: args.durationSeconds,
          image: args.image
        }
      }, function (elapsed) {
        if (progressSink) {
          progressSink("ComfyUI still generating… " + elapsed + "s");
        }
      }, function (err, result) {
        if (err) { finish({ ok: false, error: err.message }); return; }
        if (args["import"] === false) {
          finish({ ok: true, data: { files: result.files,
                                     applied: result.applied } });
          return;
        }
        // Import each rendered file into the AE project.
        var imported = [];
        (function next(i) {
          if (i >= result.files.length) {
            finish({ ok: true,
                     data: { files: result.files, imported: imported,
                             applied: result.applied } });
            return;
          }
          callHostTool("import_file", { path: result.files[i] },
            function (r) {
              imported.push(r.ok ? r.data : { error: r.error });
              next(i + 1);
            });
        })(0);
      });
      });
      }
      // Enhancement runs FIRST, while the chat model is still loaded —
      // the VRAM decision comes after, and a refusal (pause mode
      // 'never' on a job that cannot fit) comes back as a grounded
      // error before anything is churned.
      var manifest = global.Comfy.readManifest
        ? global.Comfy.readManifest(chosen.file) : null;
      var plan = planEnhancement(s, args.workflow, args.prompt, manifest);
      var enhanceDone = function () {
        VramArbiter.ensureFor(s, manifest, progressSink,
          function (refusal) {
            if (refusal) { cb(refusal); return; }
            begin();
          });
      };
      if (plan.enabled && global.Llama.getState() === "running") {
        if (progressSink) progressSink("Refining the prompt…");
        global.Llama.chat({ port: s.port, temperature: 0.6 },
          plan.messages, plan.schema, function () {},
          function (err, parsed) {
            // cb(err, parsedObject, rawText) — the schema constrains the
            // shape, so parsed.prompt is there whenever err is not.
            if (!err && parsed && parsed.prompt) {
              enhancedPrompt = String(parsed.prompt);
            }
            // Any failure falls back to the user's own words — a raw
            // prompt generates; a dead round does not.
            enhanceDone();
          });
      } else {
        enhanceDone();
      }
    }
  };

  /** JSON, as an ExtendScript string literal holding that JSON. */
  function jsxJsonLiteral(value) {
    // U+2028/U+2029 are legal raw inside modern JSON.stringify output but
    // are line terminators to ExtendScript (ES3) — they'd kill the eval.
    return JSON.stringify(JSON.stringify(value))
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }

  /** Call one host tool. cb(resultObject) — never throws. */
  function callHostTool(tool, args, cb) {
    if (!isKnownTool(tool)) {
      cb({ ok: false, error: "Unknown tool: " + tool });
      return;
    }
    var argsLiteral = jsxJsonLiteral(args || {});
    var script = 'AELL_call("' + tool + '", ' + argsLiteral + ')';
    global.AEBridge.evalScript(script, function (result, isError) {
      if (isError) {
        cb({ ok: false,
             error: "ExtendScript error (see AE). Tool: " + tool });
        return;
      }
      var obj = null;
      try { obj = JSON.parse(result); } catch (e) {}
      if (!obj || typeof obj.ok === "undefined") {
        cb({ ok: false, error: "Bad host response: " +
             String(result).slice(0, 200) });
        return;
      }
      cb(obj);
    });
  }

  // ---------------------------------------------------- project state
  //
  // The state block that opens every system prompt. Two rules, both paid
  // for in the field (measured in AE 2026: a 200-layer comp in a 206-item
  // project serialized to 49 KB against a 6 KB budget):
  //
  //  1. Nothing here is byte-sliced. A `slice(0, 6000)` cut the JSON in
  //     the middle of an object, so the model read a mangled fragment.
  //     Rows are dropped WHOLE and the count of what went missing is
  //     handed to the model instead.
  //  2. The project list can never starve the comp. `project` used to be
  //     serialized first, so 206 items ate the entire budget and the
  //     activeComp — the layers, and which of them the user had SELECTED
  //     — never reached the model at all. activeComp is written FIRST and
  //     trimmed LAST.

  var STATE_BUDGET = 6000;

  /** Drop whole rows until the state fits; report what was dropped. */
  function budgetState(state) {
    function size() { return JSON.stringify(state).length; }
    var comp = state.activeComp;
    var proj = state.project;

    // Project items go first: the comp the user is looking at matters
    // more than the rest of the project panel. Footage is dropped before
    // comps and folders, and the ACTIVE comp is never dropped — those are
    // the names the model has to quote back as arguments.
    function droppableItem(list, activeName) {
      var i;
      for (i = list.length - 1; i >= 0; i--) {
        if (list[i].type === "footage") return i;
      }
      for (i = list.length - 1; i >= 0; i--) {
        if (list[i].name !== activeName) return i;
      }
      return -1;
    }
    while (size() > STATE_BUDGET && proj && proj.items && proj.items.length) {
      var drop = droppableItem(proj.items, proj.activeComp);
      if (drop < 0) break;         // only the active comp left — keep it
      proj.items.splice(drop, 1);
      proj.itemsShown = proj.items.length;
      proj.note = "Showing " + proj.items.length + " of " + proj.numItems +
        " items (comps and folders first) — call get_project_info with " +
        "limit:0 for the whole project.";
    }
    // Then unselected layers, from the bottom of the window up.
    while (size() > STATE_BUDGET && comp && comp.layers &&
           comp.layers.length) {
      var i = comp.layers.length - 1;
      while (i >= 0 && comp.layers[i].selected) i--;
      if (i < 0) break;              // only selected layers left — keep them
      comp.layers.splice(i, 1);
      comp.layersShown = comp.layers.length;
      comp.note = "Showing " + comp.layers.length + " of " + comp.numLayers +
        " layers (selected layers always included) — call get_comp_details " +
        "with start/limit to page through the rest.";
    }
    return JSON.stringify(state);
  }

  /**
   * Build the state block. cb(jsonString) — always a STRING, and always
   * valid JSON unless the host itself was unreachable.
   */
  function fetchProjectState(cb) {
    callHostTool("get_project_info", { limit: 40 }, function (info) {
      if (!info.ok) { cb("(project state unavailable)"); return; }
      callHostTool("get_comp_details", { limit: 40 }, function (comp) {
        // activeComp FIRST: whatever else is lost downstream, the comp
        // the user is actually looking at survives.
        var state = {};
        if (comp.ok) state.activeComp = comp.data;
        state.project = info.data;
        cb(budgetState(state));
      });
    });
  }

  /**
   * Call a run of host tools in ONE undo group. cb(resultsArray).
   *
   * opts.rollback asks the host to undo the whole run if it fails part
   * way (see AELL_maybeRollback). The decision has to be made host-side,
   * inside the same script execution that opened the undo group — the
   * panel can never safely issue an Undo of its own, because by the time
   * it could, the user may have edited on top of the stack.
   */
  function callHostBatch(cmds, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    opts = opts || {};
    var payload = cmds.map(function (c) {
      return { tool: c.tool, args: c.args || {} };
    });
    var argsLiteral = jsxJsonLiteral(payload);
    var optsLiteral = jsxJsonLiteral({ rollback: !!opts.rollback });
    global.AEBridge.evalScript(
      "AELL_callBatch(" + argsLiteral + ", " + optsLiteral + ")",
      function (result, isError) {
        function allFailed(err) {
          cb(cmds.map(function () { return { ok: false, error: err }; }));
        }
        if (isError) {
          allFailed("ExtendScript error (see AE) running a batch of " +
                    cmds.length + " tools");
          return;
        }
        var obj = null;
        try { obj = JSON.parse(result); } catch (e) {}
        var rows = obj && obj.data ? obj.data.results : null;
        if (!obj || !obj.ok || !rows || rows.length !== cmds.length) {
          allFailed("Bad host batch response: " +
                    String(result).slice(0, 200));
          return;
        }
        cb(rows);
      });
  }

  var MAX_COMMANDS_PER_ROUND = 20;

  /**
   * Execute a command list in order.
   *
   * Consecutive AE-host tools are sent as ONE batched call so the whole
   * chat command collapses into a single Ctrl+Z. That has to happen in one
   * evalScript: an undo group does not survive the end of the script
   * execution that opened it, so per-tool calls can only ever be per-tool
   * undo steps. Panel-side tools, malformed commands and dry-run stubs are
   * still handled one at a time, and each of them ends the current run.
   *
   * onEach(index, command, result) fires per command; done(results) at end.
   * opts: {dryRun?: bool, shouldStop?: fn -> bool (checked between runs),
   *        allowRollback?: bool}
   *
   * allowRollback arms the host's partial-round rollback for this run. It
   * disarms itself after one rollback — the caller owns the budget across
   * rounds (main.js: one per user request).
   */
  function executeCommands(commands, opts, onEach, done) {
    opts = opts || {};
    // If a generation paused the chat model this round, warm it back up
    // BEFORE handing the results on — the very next thing the caller
    // does with them is ask the model for its reply.
    var doneInner = done;
    done = function (results) {
      VramArbiter.resumeIfPaused(global.Settings.get(), progressSink,
        function () { doneInner(results); });
    };
    var dryRun = !!opts.dryRun;
    // A dry run mutates nothing, so there is never anything to roll back.
    var rollbackArmed = !!opts.allowRollback && !dryRun;
    var results = [];
    if (commands.length > MAX_COMMANDS_PER_ROUND) {
      commands = commands.slice(0, MAX_COMMANDS_PER_ROUND);
    }

    // A command can join a batched host run only if it goes to the host
    // unconditionally — anything the panel answers itself would lose its
    // turn order if it were folded into the host call.
    function batchable(cmd) {
      return cmd && typeof cmd.tool === "string" && isKnownTool(cmd.tool) &&
        !Object.prototype.hasOwnProperty.call(PANEL_TOOLS, cmd.tool) &&
        !(dryRun && MUTATING[cmd.tool]);
    }

    function deliver(startIndex, rows) {
      for (var k = 0; k < rows.length; k++) {
        results.push(rows[k]);
        if (onEach) onEach(startIndex + k, commands[startIndex + k], rows[k]);
      }
    }

    function step(i) {
      if (i >= commands.length) { done(results); return; }
      if (opts.shouldStop && opts.shouldStop()) {
        results.push({ ok: false, error: "Cancelled by user — remaining " +
                       "commands were not run" });
        done(results);
        return;
      }
      var cmd = commands[i] || {};

      if (batchable(cmd)) {
        var end = i + 1;
        while (end < commands.length && batchable(commands[end])) end++;
        var run = commands.slice(i, end);
        var settledBatch = false;
        callHostBatch(run, { rollback: rollbackArmed }, function (rows) {
          if (settledBatch) return;
          settledBatch = true;
          // One rollback per user request. A second one would livelock a
          // deterministic failure: undo, identical retry, undo again,
          // until maxRounds, with nothing built and nothing learned. The
          // debris from a second failure is the lesser evil — the model
          // can at least repair it.
          for (var q = 0; q < rows.length; q++) {
            if (rows[q] && rows[q].rolledBack) { rollbackArmed = false; break; }
          }
          deliver(i, rows);
          step(end);
        });
        return;
      }

      // A buggy tool must not be able to double-invoke the continuation —
      // that would fork the remaining command list and the chat round.
      var settled = false;
      function onResult(result) {
        if (settled) return;
        settled = true;
        results.push(result);
        if (onEach) onEach(i, cmd, result);
        step(i + 1);
      }
      if (typeof cmd.tool !== "string") {
        onResult({ ok: false, error: "Malformed command (no tool name)" });
        return;
      }
      // Dry run still executes read-only tools — the model needs real
      // project data to plan; only mutations are stubbed.
      if (dryRun && MUTATING[cmd.tool]) {
        onResult({ ok: true, dryRun: true, note: "Dry run — not applied" });
        return;
      }
      callTool(cmd.tool, cmd.args, onResult);
    }
    step(0);
  }

  /** Route a command to a panel-side implementation or the AE host. */
  function callTool(tool, args, cb) {
    if (Object.prototype.hasOwnProperty.call(PANEL_TOOLS, tool)) {
      var delivered = false;
      var once = function (r) {
        if (delivered) return;
        delivered = true;
        cb(r);
      };
      try {
        PANEL_TOOLS[tool](args || {}, once);
      } catch (e) {
        // If cb already ran, this throw came from downstream of the tool —
        // don't re-deliver, just surface it in the console.
        if (!delivered) {
          once({ ok: false, error: tool + " failed: " + e.message });
        } else if (global.console && global.console.error) {
          global.console.error(e);
        }
      }
      return;
    }
    callHostTool(tool, args, cb);
  }

  /**
   * Decide whether and how to enhance a generation prompt, as data.
   *
   * Pure on purpose: the async wiring in comfy_generate stays thin, and
   * THIS — the decision and the messages — is what the stub test pins.
   *
   * Enhancement rewrites the user's rough idea into the workflow's own
   * prompt format using the CHAT model, which is already resident when
   * comfy_generate fires (it just emitted the tool call). That is why
   * this costs one completion, not a model load: the Ollama enhancer
   * branch inside the owner's workflows loaded a separate 27B model per
   * generation, and stays bypassed forever.
   *
   * Per-workflow setting comfyEnhance: {name: bool}; ABSENT means ON.
   * No manifest instruction -> a generic one, so user-added workflows
   * still get sensible enhancement until they ship a manifest.
   */
  var ENHANCE_SCHEMA = {
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"]
  };

  function planEnhancement(settings, workflowName, rawPrompt, manifest) {
    var map = (settings && settings.comfyEnhance) || {};
    if (map[workflowName] === false) {
      return { enabled: false, why: "off for this workflow" };
    }
    var instruction = (manifest && manifest.enhancerInstruction) ||
      ("You rewrite a rough idea into a rich, specific generation " +
       "prompt for an image/video model. Keep every concrete detail " +
       "the user gave; add camera, light and composition only where " +
       "they left gaps. Output ONLY the finished prompt.");
    return {
      enabled: true,
      schema: ENHANCE_SCHEMA,
      messages: [
        { role: "system", content: instruction +
          "\n\nAnswer as JSON: {\"prompt\": \"<the finished prompt>\"}" },
        { role: "user", content: String(rawPrompt || "") }
      ]
    };
  }

  /**
   * Fit the chat history into a character budget by dropping the OLDEST
   * entries first. The transcript the user sees is untouched — this only
   * bounds what the MODEL is sent.
   *
   * Without it a long chat died with a raw llama-server HTTP 400
   * ("request exceeds the available context size") on every later
   * message, and the panel was dead until cleared — field-observed at
   * 16755 tokens against a 16384 window.
   *
   * Rules, in order:
   *  - under budget -> unchanged, dropped: 0;
   *  - drop whole entries from the front until under budget, but never
   *    the last four — the current exchange must survive even when it
   *    alone busts the budget (the model then gets a too-big prompt and
   *    the caller's retry path deals with the 400);
   *  - after dropping, keep dropping until the first entry is a USER
   *    turn: chat templates expect user-first after the system message,
   *    and an orphaned assistant turn reads as the model talking to
   *    itself.
   */
  function fitHistory(history, budgetChars) {
    var size = 0, i;
    for (i = 0; i < history.length; i++) {
      size += (history[i].content || "").length + 16;
    }
    if (size <= budgetChars) return { entries: history, dropped: 0 };
    var entries = history.slice();
    var dropped = 0;
    while (entries.length > 4 && size > budgetChars) {
      size -= (entries[0].content || "").length + 16;
      entries.shift();
      dropped++;
    }
    while (entries.length > 1 && entries[0].role !== "user") {
      size -= (entries[0].content || "").length + 16;
      entries.shift();
      dropped++;
    }
    return { entries: entries, dropped: dropped };
  }

  global.Tools = {
    TOOL_DEFS: TOOL_DEFS,
    fitHistory: fitHistory,
    planEnhancement: planEnhancement,
    RESPONSE_SCHEMA: RESPONSE_SCHEMA,
    buildSystemPrompt: buildSystemPrompt,
    fetchProjectState: fetchProjectState,
    callHostTool: callHostTool,
    callHostBatch: callHostBatch,
    executeCommands: executeCommands,
    setGpuInfo: setGpuInfo,
    setProgressSink: function (fn) { progressSink = fn; },
    _vramArbiter: VramArbiter,        // exposed for tests
    _genNeedMBFor: genNeedMBFor       // exposed for tests
  };

})(window);
