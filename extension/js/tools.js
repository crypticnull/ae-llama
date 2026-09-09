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
      desc: "Layers of a comp with index, name, type, timing, effects, " +
            "track matte. A " +
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
      desc: "Duplicate a composition. AE names the copy '<name> 2' and " +
            "puts it in the source's own folder; pass 'name' to rename " +
            "it, and a name another item already holds is auto-numbered " +
            "(reported as nameTaken — use the returned name afterwards). " +
            "The copy SHARES its layers' sources with the original " +
            "(precomps, solids, footage), so editing those changes both; " +
            "sharedSources lists them.",
      args: "{comp: string, name?: string}" },
    { name: "organize_project", mutating: true,
      desc: "File loose root-level items into Comps/Footage/Solids/Audio/" +
            "Images folders at the project ROOT. Items already inside a " +
            "folder are left alone. " +
            "dryRun is TRUE by default and returns the moves it would " +
            "make (item -> folder) — " +
            "show them, then call again with dryRun:false. The move is " +
            "REFUSED until that list was shown in an EARLIER reply. " +
            "AE already files a solid's source into Solids, so a " +
            "Solids count of 0 is normal.",
      args: "{dryRun?: bool (default TRUE)}" },
    { name: "clean_project", mutating: true,
      desc: "Delete project clutter. ONE action per call: " +
            "'remove_unused_footage' (footage no comp uses — and every " +
            "folder that ends up empty, which AE throws in whether you " +
            "asked or not), 'consolidate_footage' (merge footage items " +
            "pointing at the same file; layers follow), or " +
            "'reduce_project' (delete EVERYTHING the comps in keepComps " +
            "do not need). dryRun is TRUE by default and returns the " +
            "list of what would go — show the user, especially the parts " +
            "they did not ask about. The delete is REFUSED until that " +
            "list was shown in an EARLIER reply. A comp or layer " +
            "argument is refused, never ignored. " +
            "reduce_project refuses to run without keepComps, and refuses " +
            "a keepComps entry that is not a comp (AE would delete every " +
            "comp in the project). Never 'clean up this comp'.",
      args: "{action: 'remove_unused_footage'|'consolidate_footage'|" +
            "'reduce_project', keepComps?: [string] (reduce_project " +
            "only, REQUIRED), dryRun?: bool (default TRUE)}" },
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
    { name: "add_text_animator", mutating: true,
      desc: "Animate a text layer PER CHARACTER (typewriter, cascade, " +
            "wiggle) — an animator holds the properties, a selector " +
            "picks which characters get them. One call adds the " +
            "animator, activates every property named and configures " +
            "the selector; the result gives the exact paths, so " +
            "set_keyframes on the selector's Offset/Start/End is what " +
            "makes it move (a typewriter is opacity 0 + units 'index' + " +
            "keyframed Start). Percent selectors run -100..100; " +
            "'rotation' IS the Z rotation, and xRotation/yRotation turn " +
            "per-character 3D on (which also makes the layer 3D — the " +
            "result says so).",
      args: "{comp?: string, layer?: name|index (text layer; omit = selected), name?: string, " +
            "properties: {opacity|position|scale|anchorPoint|rotation|xRotation|yRotation|skew|skewAxis|" +
            "fillColor|fillOpacity|fillHue|fillSaturation|fillBrightness|strokeColor|strokeOpacity|strokeWidth|" +
            "strokeHue|strokeSaturation|strokeBrightness|tracking|trackingType|lineAnchor|lineSpacing|" +
            "characterOffset|characterValue|characterRange|characterAlignment|blur: value, …}, " +
            "selector?: {type?: range|wiggly|expression|none (default range), units?: percent|index, " +
            "start?, end?, offset?, basedOn?: characters|charactersExcludingSpaces|words|lines, " +
            "mode?: add|subtract|intersect|min|max|difference, shape?: square|rampUp|rampDown|triangle|round|smooth, " +
            "smoothness?, easeHigh?, easeLow?, amount?, randomizeOrder?, randomSeed?, " +
            "maxAmount?, minAmount?, wigglesPerSecond?, correlation?, temporalPhase?, spatialPhase?, lockDimensions?}}" },
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
            "this instead of guessing anchor coordinates. 'spin around " +
            "its middle / fix the pivot' = this. If Scale or Rotation are " +
            "animated too, the note says where the compensation is exact.",
      args: "{comp?: string, layer: name|index, preservePosition?: bool = true}" },
    { name: "get_bounds", mutating: false,
      desc: "MEASURE a layer's rendered content without touching it — how " +
            "wide the text actually is, where the shape sits in the " +
            "frame, whether anything overflows. Returns the source rect, " +
            "the comp-space box and corners (parenting, scale and " +
            "rotation included) and inFrame: fully|partly|outside. Use " +
            "this before fitting, centering or aligning anything instead " +
            "of assuming a size. extents:true adds a shape's stroke. A " +
            "3D layer reports the source rect only (the camera decides " +
            "the rest).",
      args: "{comp?: string, layer?: name|index (omit = selected layer), time?: seconds (default current), extents?: bool}" },
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
    { name: "audio_to_keyframes", mutating: true,
      desc: "Convert audio amplitude to keyframes: adds a null carrying " +
            "Left/Right/Both Channels sliders keyframed to the loudness, " +
            "one key per frame. Use it for anything beat-driven " +
            "('sync to the beat' = this then link_property). " +
            "AE's own command reads the WHOLE comp mix " +
            "and only inside the work area; this tool isolates 'layer' " +
            "by muting the others for the conversion and covers the " +
            "whole comp unless range says otherwise, and says so in the " +
            "result.",
      args: "{comp?: string, layer?: name|index (omit for the whole comp mix), name?: string (default 'Audio Amplitude'), range?: 'comp' (default) | 'workArea'}" },
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
            "all pairs. 'less robotic' = this (smooth = [0.42,0,0.58,1]).",
      args: "{comp?: string, layers?: [name|index] | layer?: name|index (omit = selection), property: path, bezier: [x1,y1,x2,y2], keyIndex?: int, allPairs?: bool}" },
    { name: "grid_layout", mutating: true,
      desc: "Arrange layers into a grid rigged to a control null: its " +
            "'Grid X Spacing'/'Grid Y Spacing'/'Grid Columns' sliders " +
            "drive spacing AND column count live, and the grid centers " +
            "on the null's position (all expressions generated " +
            "host-side). Re-running re-flows the rig.",
      args: "{comp?: string, layers?: [name|index] (omit = user's selection), columns?: int ('3 by 2' = 3; default ~square; 1 = column, n = row), spacingX?: px, spacingY?: px, controlLayer?: string = 'GRID CTRL'}" },
    { name: "apply_expression_preset", mutating: true,
      desc: "Apply a known-good expression. Presets: wiggle (frequency/" +
            "amplitude as numbers OR freqControl/ampControl {layer, effect} " +
            "to drive from sliders), loop_cycle, loop_pingpong, loop_offset " +
            "(need keyframes), time_linear (scalar props; rate or rateControl). " +
            "'keep it drifting' = wiggle on position (slow: frequency 0.5).",
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
      args: "{comp?: string, layer: name|index, effect: string, param: string, value: number|[..]}" },
    { name: "remove_effect", mutating: true,
      desc: "REMOVE one effect from a layer by display name or matchName " +
            "('get rid of the blur'). An unknown name is refused listing " +
            "the effects the layer really has; the result names what was " +
            "removed and what remains.",
      args: "{comp?: string, layer?: name|index (omit = selected layer), effect: display name or matchName}" },
    { name: "set_layer_timing", mutating: true,
      desc: "Retime a layer on the TIMELINE, in comp seconds: startTime " +
            "slides the whole layer ('push it back two seconds' = " +
            "startTime: current + 2), inPoint/outPoint TRIM its ends " +
            "without sliding it.",
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
      desc: "Restack layers WITHOUT changing their timing. RELATIVE " +
            "({layer, above|below: name} or {layer, toFront|toBack: " +
            "true}) moves ONE layer and disturbs nothing else — 'put it " +
            "behind X' in the STACK (on-screen 'under the logo' is " +
            "position, not stacking). SORT restacks a whole set by a " +
            "key: 'ascending' (default) = later start times sit higher " +
            "in the stack; 'descending' = earliest on top. by:'name' " +
            "sorts numbers inside names " +
            "numerically ('X 2' before 'X 10'). Layers with equal keys " +
            "keep the stack order they had. The targets end up " +
            "CONTIGUOUS, which can push untargeted layers aside — the " +
            "result reports how many. A relative key with 'by' or " +
            "'layers' is refused.",
      args: "{comp?: string, layer?: name|index (RELATIVE mode, plus exactly one of:) above?: layer name, below?: layer name, toFront?: true, toBack?: true — never with by/layers | layers?: [name|index] (SORT mode; omit = selection, else all), by?: 'startTime'|'inPoint'|'name' (default startTime), order?: 'ascending'|'descending'}" },
    { name: "delete_layer", mutating: true,
      desc: "Delete a layer from a comp.",
      args: "{comp?: string, layer: name|index}" },
    { name: "set_comp_setting", mutating: true,
      desc: "Change a comp setting: duration, frame rate, bg color, the " +
            "WORK AREA (workAreaStart with workAreaDuration or " +
            "workAreaEnd, in seconds — or workArea: 'comp' to reset it to " +
            "the whole comp) and preview resolution. Times snap to the " +
            "frame grid and the result says when they did. Its " +
            "width/height change ONLY the canvas and leave layers stuck at " +
            "the top-left — to resize a comp, use scale_comp instead.",
      args: "{comp?: string, duration?: s, frameRate?: number, width?: int, height?: int, bgColor?: [r,g,b] 0..1, workArea?: 'comp', workAreaStart?: s, workAreaDuration?: s, workAreaEnd?: s, resolution?: 'full'|'half'|'third'|'quarter'|int|[h,v]}" },
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
      desc: "Import a footage/image/video file into the PROJECT PANEL " +
            "only — it does not appear in any comp. To put it on screen " +
            "use import_as_layer instead. Returns the size AE measured " +
            "(width/height, plus duration and frameRate for media that " +
            "has them) — use those, not the size you expected.",
      args: "{path: string (absolute)}" },
    { name: "import_as_layer", mutating: true,
      desc: "Import a file AND place it in a comp as a layer, scaled to " +
            "the comp. 'fit' (default) contains it without cropping or " +
            "distorting, 'fill' covers and crops, 'stretch' fills exactly " +
            "and distorts (what AE's own \"Fit to Comp\" does), 'none' " +
            "leaves it at 100%. A file already in the project is REUSED " +
            "and reloaded from disk rather than imported twice, so " +
            "regenerating the same path and re-placing it is safe. A " +
            "still spans the whole comp — set_layer_timing retimes it.",
      args: "{path: string (ABSOLUTE), comp?: string, fit?: 'fit'|'fill'|'stretch'|'width'|'height'|'none', name?: string, position?: [x,y]}" },
    { name: "snapshot_frame", mutating: true,
      desc: "Write one frame of a comp to a PNG on disk. Use it to show " +
            "someone what a comp looks like, or to feed a comp's own " +
            "frame to an image generator. Defaults to the comp's current " +
            "time and to FULL resolution even when the comp is " +
            "downsampled (it puts the downsample back). Refuses an " +
            "existing file unless {overwrite: true} — it would be " +
            "replaced silently and cannot be undone. Guide layers are " +
            "not rendered. list_render_templates reports a writable temp " +
            "folder; import_as_layer puts the PNG back into a comp.",
      args: "{path: string (ABSOLUTE .png), comp?: string, time?: seconds (default: the comp's current time), resolution?: 'full'|'comp', overwrite?: bool = false}" },
    { name: "add_shape_layer", mutating: true,
      desc: "Add a shape layer (rectangle, ellipse, polygon, or star).",
      args: "{comp?: string, name?: string, shape?: 'rectangle'|'ellipse'|'polygon'|'star', size?: [w,h], position?: [x,y], fillColor?: [r,g,b] 0..1, strokeColor?: [r,g,b], strokeWidth?: px, roundness?: px (rectangle), points?: int (polygon/star)}" },
    { name: "add_mask", mutating: true,
      desc: "Add a mask to a layer ('hide the bottom half'). " +
            "Coordinates are in LAYER space, sized from get_bounds — " +
            "never guessed.",
      args: "{comp?: string, layer: name|index, shape?: 'rectangle'|'ellipse'|'custom', bounds?: [x,y,w,h], vertices?: [[x,y],...] (custom), mode?: 'add'|'subtract'|'intersect'|..., inverted?: bool, feather?: px, name?: string}" },
    { name: "delete_mask", mutating: true,
      desc: "REMOVE one mask from a layer by name or 1-based index " +
            "('remove that mask'); omit 'mask' when the layer has exactly " +
            "one.",
      args: "{comp?: string, layer?: name|index (omit = selected layer), mask?: name|1-based index (omit when the layer has one)}" },
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
            "Color: [1,0,0], Copies: 5, End: 50}). ORDER MATTERS: a " +
            "repeater/trim/offset/twist/zigzag acts on the content ABOVE " +
            "it and new content is appended BELOW, so add the shape " +
            "FIRST and the filter after it. Animate afterwards via " +
            "set_keyframes on 'contents/<Group>/<Item>/<Param>' paths; a " +
            "repeater's offsets are one deeper " +
            "('…/Repeater 1/Transform/Position').",
      args: "{comp?: string, layer?: name|index (shape layer; omit = selected), kind: string, group?: name (add inside this group), name?: string, params?: {ParamName: value, …}}" },
    { name: "precompose", mutating: true,
      desc: "Move layers into a new nested comp (precompose). " +
            "'package it up' = this — AE has no layer groups. The result " +
            "names the precomp AE actually made (auto-numbered if the " +
            "name was taken), what it broke — a moved layer's parent that " +
            "stayed behind is DROPPED, and an expression left behind that " +
            "names a moved layer dangles without AE reporting it — and " +
            "the selection it put back. moveAttributes:false leaves the " +
            "transform outside and sizes the new comp to that ONE layer; " +
            "AE refuses it for more than one layer.",
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
      desc: "Add a marker to the comp (omit 'layer') or to a layer. " +
            "'time' is COMPOSITION time either way. AE keeps one marker " +
            "per exact time, so writing over one REPLACES it — the result " +
            "says what it overwrote. A time outside the comp (or outside " +
            "the layer's own span) is allowed and flagged.",
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
            "unparent). 'stick it to X / make it follow X' = {layer, " +
            "parent: 'X'} — never an expression. Visual positions are " +
            "preserved by default, but " +
            "AE pays for that by REWRITING the child's Position/Scale/" +
            "Rotation (every keyframe, not just the current value) into " +
            "the parent's space — so read those values back rather " +
            "than reusing the ones you had. That compensation is worked " +
            "out ONCE, at one frame: if the parent itself is animated " +
            "the layer only stays put at that frame and rides the parent " +
            "everywhere else (the result says so in parentAnimated). " +
            "atTime/atFrame picks the frame that must not move; without " +
            "it AE uses wherever the playhead happens to be. " +
            "keepPosition:false keeps the numbers and lets the layer " +
            "jump. Omit layer/layers to use the selection.",
      args: "{comp?: string, layer?: name|index, layers?: [name|index], parent?: name|index|null, keepPosition?: bool (default true), atTime?: seconds, atFrame?: number}" },
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
            "specific times or all ('stop it moving' = this, times " +
            "omitted). Removing ALL keys leaves the LAST " +
            "key's value.",
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
            "layer-stacking requirement. 'show the video through the " +
            "text' = {layer: the footage being cut, matteLayer: the " +
            "text, mode: alpha}.",
      args: "{comp?: string, layer?: name|index (the layer being matted; omit = selected), matteLayer: name|index, mode: 'alpha'|'alpha_inverted'|'luma'|'luma_inverted'|'none'}" },
    { name: "list_effects", mutating: false,
      desc: "Enumerate effects INSTALLED in this AE (name, matchName, " +
            "category), filtered and paged. Check here before apply_effect " +
            "when unsure of a name.",
      args: "{filter?: substring of name/category, offset?: int}" },
    { name: "list_presets", mutating: false,
      desc: "Enumerate the ANIMATION PRESETS (.ffx) installed in this AE — " +
            "AE ships ~679 (Behaviors, Text, Backgrounds, Transitions, " +
            "Image, Shapes…) plus the user's own. Search before applying.",
      args: "{filter?: substring of \"Category/Name\", category?: string, source?: \"app\"|\"user\", offset?: int, limit?: int, refresh?: bool}" },
    { name: "apply_preset", mutating: true,
      desc: "Apply an installed .ffx animation preset to layer(s). One " +
            "preset can add several effects, expressions and keyframes at " +
            "once — the fastest route to a finished look ('make it pop' " +
            "= list_presets {filter} then this). Match the " +
            "preset's CATEGORY to the layer: a Text preset on a non-text " +
            "layer lands at best partially (its sliders, never the " +
            "animation) and cameras/lights take nothing at all. The tool " +
            "reports a partial or empty landing rather than claiming " +
            "success. Use list_presets to get the exact name.",
      args: "{preset: string (name or \"Category/Name\" from list_presets), layer?: string|int, layers?: [string|int], comp?: string}" },
    { name: "add_to_render_queue", mutating: true,
      desc: "Add a comp to the render queue WITHOUT rendering it. With " +
            "no outputPath AE reuses the last render's folder, which is " +
            "usually nothing to do with this project — the result says " +
            "where it would land, so pass that on to the user.",
      args: "{comp?: string, outputPath?: string (absolute)}" },
    { name: "render_comp", mutating: true,
      desc: "Actually RENDER a comp to a file. " +
            "Blocks until AE finishes (minutes for anything long). " +
            "Refuses if the output file already exists unless " +
            "{overwrite: true}, and refuses if its folder does not " +
            "exist. Anything the user already had in the render queue " +
            "is held back, not rendered. Use list_render_templates for " +
            "valid template names — the output module forces its own " +
            "file extension, so the result says where the bytes really " +
            "went. {resolution} renders FEWER PIXELS (\"half\" writes a " +
            "file half as wide and half as tall, a quarter of the bytes) " +
            "— use it for previews and for anything that will be scaled " +
            "down afterwards; the result says the size AE really wrote.",
      args: "{comp?: string, output: string (ABSOLUTE file path), template?: string (output module, e.g. \"Lossless\" or \"H.264 - Match Render Settings - 15 Mbps\"), renderSettings?: string (e.g. \"Best Settings\"), resolution?: \"full\"|\"half\"|\"third\"|\"quarter\" = full, startTime?: number (seconds), durationSeconds?: number, frames?: int (instead of durationSeconds), overwrite?: bool = false}" },
    { name: "list_render_templates", mutating: false,
      desc: "List this machine's render-settings and output-module " +
            "template names for render_comp. Installed templates differ " +
            "per machine — never guess a name, list them.",
      args: "{}" },
    { name: "expose_property", mutating: true,
      desc: "Expose one property in the comp's ESSENTIAL GRAPHICS panel, " +
            "so an editor can change it in Premiere. This is step one of " +
            "making a .mogrt template. AE names the controller after the " +
            "LAYER (transform/text) or the EFFECT (effect parameters), " +
            "never after the property, and it allows duplicate names — " +
            "so always pass a 'label' the editor will understand. There " +
            "is no rename and no remove: AE ships neither, and a " +
            "controller cannot be exposed twice.",
      args: "{comp?: string, layer?: name|index (omit = selected), property: string (e.g. 'opacity', 'position', 'effect.Tint.Amount to Tint', or a full path), label?: string}" },
    { name: "export_mogrt", mutating: true,
      desc: "Write a comp out as a .mogrt Motion Graphics template. " +
            "Needs at least one exposed control (expose_property) and a " +
            "project that is SAVED and has NO unsaved changes — AE " +
            "silently writes nothing otherwise, so pass {save: true} to " +
            "save the project first. The FILE NAME comes from the " +
            "template name, not from 'folder'. AE reports success even " +
            "when it wrote nothing, so this tool checks the file and " +
            "reports its real size; a failure usually means a font in " +
            "the comp is not installed.",
      args: "{comp?: string, folder: string (ABSOLUTE folder), name?: string (template name = file name; default the comp's), save?: bool = false (save the project first), overwrite?: bool = false}" },
    { name: "render_comp_audio", mutating: true,
      desc: "Render ONLY the comp's audio to a file (AE's audio-only " +
            "output module, picked for you). Refuses when no layer in " +
            "the comp has audio, or when every audio layer is muted — " +
            "AE would otherwise write a full file of SILENCE and report " +
            "success. Use it to export a mix; transcribe_to_captions " +
            "calls it for you.",
      args: "{comp?: string, output: string (ABSOLUTE file path), template?: string (only to override the automatic audio module), startTime?: number (seconds), durationSeconds?: number, overwrite?: bool = false}" },
    { name: "add_captions", mutating: true,
      desc: "Build MANY timed captions in one call: one text layer per " +
            "segment (trimmed to its own start/end), or one marker per " +
            "segment with {as: 'markers'}. Text layers default to the " +
            "lower third, centred. This is the batch tool — never make " +
            "captions with one add_text_layer per line. Every segment is " +
            "validated before anything is created, so a bad one refuses " +
            "the whole batch instead of leaving half a transcript behind.",
      args: "{comp?: string, segments: [{start: seconds, end: seconds, text: string}], as?: 'text' (default) | 'markers', layer?: name|index (marker target; omit for comp markers), name?: string (layer name prefix, default 'Caption'), fontSize?: number, font?: string, fillColor?: [r,g,b] 0-1, position?: [x,y], justification?: 'left'|'center'|'right'}" },
    { name: "transcribe_to_captions", mutating: true,
      desc: "TRANSCRIBE the comp's own audio with the local speech model " +
            "and put the result on the timeline as timed text layers (or " +
            "markers). Renders the audio, transcribes it offline, and " +
            "builds the captions — one call. Needs whisper.cpp installed; " +
            "the refusal says how. Blocks for roughly a second per five " +
            "seconds of audio.",
      args: "{comp?: string, as?: 'text' (default) | 'markers', startTime?: number (seconds), durationSeconds?: number, language?: string, maxSegments?: int, name?: string (layer name prefix), fontSize?: number, font?: string, fillColor?: [r,g,b] 0-1, position?: [x,y], justification?: 'left'|'center'|'right', keepAudio?: bool = false (keep the rendered audio file and report its path)}" },
    { name: "export_gif", mutating: true,
      desc: "Export a comp as an animated GIF. Renders a lossless master " +
            "and converts it with a two-pass palette, then DELETES the " +
            "master. Defaults to 480 px wide at 12 fps because that is " +
            "what a GIF is for — say so if the user wants otherwise. " +
            "Renders the comp's WORK AREA unless you pass " +
            "{wholeComp: true}; the result says which. Needs ffmpeg " +
            "installed; the refusal says how.",
      args: "{comp?: string, output: string (ABSOLUTE path ending .gif), size?: string (\"480\" = width, \"480x270\", \"720p\" = height), width?: int, height?: int, fit?: 'contain' (letterbox, default) | 'cover' (fill and crop) | 'stretch', padColor?: string, fps?: number (default 12), colors?: int 4-256 (default 256), dither?: 'bayer' (default) | 'none' | 'sierra2_4a' | 'floyd_steinberg', loop?: bool = true, masterResolution?: 'full' (default) | 'half' | 'third' | 'quarter' | 'auto' (render the intermediate smaller — much faster and far less disk when the export is much smaller than the comp; refused if it would end up smaller than the output), wholeComp?: bool, startTime?: number (seconds), durationSeconds?: number, overwrite?: bool = false}" },
    { name: "export_social", mutating: true,
      desc: "Export a comp as an H.264 .mp4 (or .mov) sized for posting, " +
            "AUDIO INCLUDED when the comp has any. Renders a lossless " +
            "master, encodes it, verifies the result and deletes the " +
            "master. Use {size} for a platform frame — \"1080x1920\" for " +
            "a story/reel, \"1080x1080\" square, \"1920x1080\" landscape " +
            "— and {fit} to say whether the picture is letterboxed or " +
            "cropped into it. Renders the comp's WORK AREA unless you " +
            "pass {wholeComp: true}. Needs ffmpeg installed.",
      args: "{comp?: string, output: string (ABSOLUTE path ending .mp4 or .mov), size?: string (\"1080x1920\", \"1080p\", \"720\"), width?: int, height?: int, fit?: 'contain' (letterbox, default) | 'cover' (fill and crop) | 'stretch', padColor?: string, fps?: number (default: the comp's), quality?: 'low'|'medium' (default)|'high', audio?: bool = true, hardware?: bool = false (try the GPU encoder first), masterResolution?: 'full' (default) | 'half' | 'third' | 'quarter' | 'auto' (render the intermediate smaller — much faster and far less disk when the export is much smaller than the comp; refused if it would end up smaller than the output), wholeComp?: bool, startTime?: number (seconds), durationSeconds?: number, overwrite?: bool = false}" },
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
      args: "{workflow: string (name from comfy_list_workflows), prompt: string, negative?: string, width?: int, height?: int (the size the template GENERATES at, which is not always the size it saves: a template that upscales between passes writes a larger file, and the result reports the size actually imported), seed?: int, frames?: int (video workflows), durationSeconds?: number (video templates whose length is set in seconds — the error tells you which), image?: string (absolute path to a reference/first-frame image), import?: bool = true}" }
  ];

  var TOOL_NAMES = [];
  var MUTATING = {};
  for (var i = 0; i < TOOL_DEFS.length; i++) {
    TOOL_NAMES.push(TOOL_DEFS[i].name);
    if (TOOL_DEFS[i].mutating) MUTATING[TOOL_DEFS[i].name] = true;
  }

  // The executor's hard per-round cap (executeCommands). Declared here,
  // above RESPONSE_SCHEMA, because the schema's maxItems must be the
  // same number: a command past this cap does not run.
  var MAX_COMMANDS_PER_ROUND = 20;

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
        // The grammar refuses what the executor would cut: commands past
        // MAX_COMMANDS_PER_ROUND never run, so letting the model emit
        // them only manufactures the dropped-commands error row. The
        // system prompt's "AT MOST 8" stays an advisory aim below this.
        maxItems: MAX_COMMANDS_PER_ROUND,
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

  function buildSystemPrompt(projectStateJson, opts) {
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
      "- 'spin around its middle / rotate in place / fix the pivot / it",
      "  swings around its corner' = center_anchor_point. Anchor points",
      "  are in LAYER space, not comp space — never set anchorPoint",
      "  coordinates by guesswork.",
      "- NEVER assume how big a layer's content is. 'fit the title to the",
      "  frame', 'put it under the logo', 'is it cut off?' all start with",
      "  get_bounds {layer} — it reports the real rendered size, where it",
      "  sits in the comp and whether it overflows. Text and shape layers",
      "  are the ones that surprise you: their box is nothing like the",
      "  comp size.",
      "- Your reply text is shown BEFORE your commands run. Phrase it as",
      "  intent ('Centering the anchor point…'), then after reading TOOL",
      "  RESULTS confirm what actually happened — including any 'warning'",
      "  fields, which mean the result is probably not what the user wanted.",
      "- Keep 'reply' to one or two short sentences. The TOOL RESULTS are",
      "  the record: never restate them, never narrate each step. Every",
      "  word you write shares the context window with the work.",
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
      "- 'change/sort the layer order' = reorder_layers SORT {by, order}",
      "  (omit 'layers' for the selection, else all) — restacks only,",
      "  start times untouched. Never stagger_layers to reorder — it",
      "  changes TIMES, not stacking.",
      "- 'put it behind X / in front of X / underneath X in the stack /",
      "  send it to the back / bring it to the front' = STACKING:",
      "  reorder_layers RELATIVE {layer, below|above: 'X'} or {layer,",
      "  toBack|toFront: true} — ONE layer moves, nothing else; never the",
      "  sort mode ('by'). 'under / below the logo ON SCREEN' is position:",
      "  get_bounds, then set_transform.",
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
      "  selected it grids ALL content layers except a full-frame",
      "  backdrop, so 'arrange all layers in a grid' is ONE",
      "  grid_layout call with 'layers' omitted. Never",
      "  pass layers: [] — omit the argument instead.",
      "- SCOPE: do ONLY what the user asked, then stop. Never bolt on",
      "  extra steps they did not request (grids, effects, styling,",
      "  animation) and never an unasked CONTROL RIG: an effect ask",
      "  ('shadow them / blur these') is apply_effect (many:",
      "  for_each_layer) and NOTHING else — no add_null, no add_control",
      "  sliders, no link_property, no set_effect_param values they did",
      "  not ask for. Rig only when they ask to steer it ('one slider",
      "  for all of them'); an explicit request always outranks this.",
      "  Defaults decide HOW a requested step runs — never WHAT gets",
      "  done.",
      "- MACRO TOOLS ARE COMPLETE: when grid_layout /",
      "  split_layer_into_chunks / stagger_layers succeeds, the request",
      "  it covers is DONE — grid_layout's null ALREADY has the X/Y",
      "  spacing and Columns sliders ('controllers'). Do not rebuild or",
      "  augment what a macro just delivered on your own initiative.",
      "  Never drive a control null's own Transform with expressions",
      "  as a workaround for a failed call — report the failure.",
      "- 'put N copies/shapes in a comp' = create ONE layer, then ONE",
      "  duplicate_layer call with {count: N-1}. Never chain single",
      "  duplicates, and NEVER give two layers the same name.",
      "- Report counts from tool results (created / totalLayersInComp) —",
      "  never claim a number you did not verify.",
      "- Emit AT MOST 8 commands per reply and keep them compact — output",
      "  space is limited and an oversized reply gets cut off. More work?",
      "  Stop after 8 and continue after TOOL RESULTS.",
      "- 'each X' / 'every X' / 'all the Xs' / 'the X layers' names a",
      "  CLASS of layers — pass {layers: [...]} with those exact names",
      "  from the project state (e.g. every \"Square*\" layer), NEVER the",
      "  selection: the user may have a control null selected from",
      "  inspecting sliders.",
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
      "- 'make it pop / cinematic / polished / fancy / dress it up / a",
      "  finished look' = a whole LOOK in one call: list_presets {filter}",
      "  then apply_preset — never an improvised stack of effects.",
      "",
      "Masks & shape content:",
      "- set_mask edits mode/feather/expansion/opacity/inverted;",
      "  set_mask_path moves or ANIMATES the points (atTime or keys).",
      "  Mask points are LAYER space, not comp space.",
      "- Build shape layers in steps: add_shape_layer once, then",
      "  add_shape_content per item — a group, then shapes/fills/strokes/",
      "  repeaters/trim_paths inside it via {group}. Set initial values",
      "  with params; animate them with set_keyframes on",
      "  'contents/<Group>/<Item>/<Param>' paths.",
      "- Shape content is a STACK: a repeater, trim_paths, offset_paths,",
      "  twist or zigzag changes the items ABOVE it, and each new item is",
      "  added BELOW the last, so add the path/shape FIRST and the",
      "  filter after it — the other way round it renders nothing.",
      "- 'multiply it / a row / a ring of them' = one shape plus a",
      "  repeater: {kind: 'repeater', params: {Copies: 6, Position:",
      "  [200,0]}}. A ring is Position [0,0] with Rotation 360/Copies and",
      "  the shape drawn off-centre; animate Copies or",
      "  '…/Repeater 1/Transform/Rotation' with set_keyframes.",
      "- Mask path keys must all carry the SAME point count (repeat a",
      "  vertex to pad); AE cannot tween paths of different counts.",
      "- 'animate the mask / wipe it on' = set_mask_path {keys: […]} or",
      "  add trim_paths and keyframe its End — never hand-write",
      "  expressions for plain keyframe animation.",
      "- 'stagger with an ease' = stagger_layers with spread + bezier",
      "  (step mode is evenly spaced, no curve); 'ramp opacity/scale",
      "  across these layers' = distribute_property; 'ease between the",
      "  keyframes / smoother / snappier / less robotic / mechanical /",
      "  feels cheap / not so linear' = apply_keyframe_ease on the",
      "  property that HAS the keys — never stagger_layers (that moves",
      "  layers in TIME). All take the same CSS-style bezier",
      "  [x1,y1,x2,y2].",
      "",
      "Plain-English requests:",
      "- 'group these / package it up / bundle them / collapse them into",
      "  one layer' = precompose {layers, name}.",
      "- 'trim it / start it later / push it back / delay it / shift it N",
      "  seconds' = set_layer_timing (startTime slides, inPoint/outPoint",
      "  trim). Never fake timing with opacity keyframes.",
      "- 'attach / stick / pin it to X', 'make it follow / ride along",
      "  with X' = set_layer_parent {layer, parent: 'X'}.",
      "- 'soften it / blur it / too sharp / out of focus' = apply_effect",
      "  {effect: 'Gaussian Blur'} — never add_mask: a mask feather",
      "  softens the mask EDGE, never the picture.",
      "- 'crop / chop off the lower half / hide the bottom half / only",
      "  the top shows / cut a hole / vignette' = add_mask — never",
      "  set_layer_timing (that trims TIME), scale or anchor. A hole is",
      "  mode 'subtract'; a vignette is a big feathered ellipse.",
      "- 'stop it moving / un-animate it / no more fading' =",
      "  remove_keyframes, times omitted. Motion from an EXPRESSION is",
      "  cleared with set_expression {expression: ''} — remove_keyframes",
      "  reports removed: 0 there, not success.",
      "- 'keep it drifting / floating / hovering / jittering' =",
      "  apply_expression_preset {preset: 'wiggle', property: 'position'}",
      "  on THAT layer, never a null; 'bouncing back and forth / keep it",
      "  looping' = loop_pingpong / loop_cycle. Never set_expression.",
      "- 'show the video through the text / cut the logo out of the",
      "  footage / X only visible through Y' = set_track_matte {layer:",
      "  X (the footage being cut), matteLayer: Y (the text/logo), mode:",
      "  alpha}.",
      "- 'dance to the music / sync to the beat / react to the bass' =",
      "  audio_to_keyframes ONCE, then link_property {layer, property,",
      "  controlLayer: <its null>, controlEffect: 'Both Channels', scale}",
      "  — the conversion alone moves nothing. If it refuses (no audio),",
      "  say so; never fake a beat with keyframes or wiggle.",
      "- 'take off the glow / get rid of the blur / lose the drop shadow'",
      "  = remove_effect {layer, effect}; 'remove that mask / take the",
      "  mask off' = delete_mask {layer, mask}. Removing is not hiding",
      "  (never set_effect_param 0 or set_mask {mode: none}), and never",
      "  delete the layer.",
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
      "  duplicate_comp / organize_project / clean_project manage the",
      "  project panel. Items",
      "  are referenced by name or id; folders also by PATH written as",
      "  ParentName/ChildName, or 'root' for the project root.",
      "  get_project_info shows each item's parent folder and each",
      "  folder's path. Same-named folders under different parents are",
      "  normal — use paths when names repeat.",
      "- 'clean up / tidy / shrink the PROJECT' (unused footage, the",
      "  project panel) = clean_project with ONE action. It answers with a",
      "  PREVIEW: list what would be deleted in your reply, call out what",
      "  the user did not ask for (empty folders, render-queue items,",
      "  expressions that would break), and STOP. Only after they say go,",
      "  call it again with dryRun:false. reduce_project needs keepComps",
      "  — ask which comps matter, never guess.",
      "- 'clean up / tidy / sort out this COMP (or a named one) / it's",
      "  a mess / junk everywhere' NAMES NOTHING: ask what should go and",
      "  return commands: [] — the one exception to ACT, DON'T ASK. Never",
      "  guess a target (no remove_keyframes or delete_layer over every",
      "  layer), never clean_project (that deletes footage). Once they",
      "  name the clutter, remove exactly it (remove_keyframes,",
      "  remove_effect, delete_mask, delete_layer, precompose).",
      "- 'file / sort / organize the project panel' = organize_project,",
      "  which PREVIEWS the same way: report the moves it lists and any",
      "  folder it would create, then STOP until the user says go, and",
      "  call again with dryRun:false. A preview is",
      "  not an organized project — never report one as done.",
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
    var compact = !!(opts && opts.compact);
    for (var i = 0; i < TOOL_DEFS.length; i++) {
      var t = TOOL_DEFS[i];
      lines.push("- " + t.name + " " + t.args);
      lines.push("    " + (compact ? compactDesc(t.desc) : t.desc));
    }
    if (opts && opts.ledger) {
      lines.push("");
      lines.push(opts.ledger);
    }
    if (projectStateJson) {
      lines.push("");
      lines.push("CURRENT PROJECT STATE:");
      lines.push(projectStateJson);
    }
    return lines.join("\n");
  }

  /**
   * The compact form of a tool doc: its first sentence, capped at a word
   * boundary. Context is a functional resource (CLAUDE.md): the docs
   * are ~40 of the prompt's ~59 KB, and at the default 16K window that
   * left no room for conversation at all. The rules block — where the
   * phrase lists that route casual language live — is never compacted;
   * a tool's args line is never touched (it is what the model executes).
   */
  var COMPACT_DESC_CHARS = 110;
  function compactDesc(desc) {
    var s = String(desc || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    var m = s.match(/^(.*?[.!?])(\s|$)/);
    var first = m ? m[1] : s;
    if (first.length <= COMPACT_DESC_CHARS) return first;
    var cut = first.lastIndexOf(" ", COMPACT_DESC_CHARS - 1);
    if (cut < 40) cut = COMPACT_DESC_CHARS - 1;
    return first.slice(0, cut) + "…";
  }

  /**
   * Which prompt form a context window can afford. Below 24K tokens the
   * full docs plus state leave nothing for history (measured 2026-09-01:
   * ~58.7K chars of prompt is ~15K tokens against 16,384), so the compact
   * docs are the default there; a window that can hold the full docs AND
   * a conversation gets them.
   */
  function promptModeFor(ctxSize) {
    var ctx = Number(ctxSize) || 16384;
    return { compact: ctx < 24576 };
  }

  /**
   * How many chars of history the window can carry beside the prompt.
   * The reply reserve is llama.js's max_tokens plus template overhead;
   * the ledger keeps its own slice so memory of dropped turns never
   * competes with the current exchange. `starved` is the signal main.js
   * turns into ONE grounded line: the window is nearly filled by the
   * prompt alone, and turns will be forgotten fast.
   *
   * Both ratios were estimates until 2026-09-02, when
   * scripts/context-budget-probe.js asked the running llama-server's
   * /tokenize what the panel's OWN payload really costs (Qwen2.5-32B,
   * ctx 16384, real project state):
   *
   *   system prompt, full docs     62364 chars = 16073 tokens  3.88
   *   system prompt, compact docs  42574 chars = 11446 tokens  3.72
   *   chat history (JSON-heavy)    56308 chars = 19937 tokens  2.82
   *                                42431 chars = 15291 tokens  2.77
   *
   * The prompt rows are the same in every run — same text, same
   * tokenizer. The history row is NOT: what a ten-turn chat contains
   * changes with what the model says, and two runs of the same probe
   * measured 2.82 and 2.77. So the history bound is set under the
   * LOWEST sample, not the latest one; a constant tuned to one run is
   * how this was wrong in the first place.
   *
   * The old 3.9 / 3 were both off by under 10% — and both off in the
   * direction that kills a chat. The constants are not symmetric: the
   * prompt one DIVIDES chars into tokens, so a value ABOVE the truth
   * hides tokens (at the shipped default — compact docs at 16384 — it
   * hid 529 of them); the history one MULTIPLIES room into chars, so a
   * value ABOVE the truth hands out history the room cannot hold. Both
   * errors compounded: 4917 chars of budget at the measured 2.82 is
   * 1744 tokens against 1610 really free. That is the HTTP-400 the
   * fitHistory work of 2026-08-25 exists to prevent, quietly back.
   *
   * So each is pinned just BELOW the densest form measured — 3.7 under
   * the compact prompt's 3.72, 2.7 under the history's 2.77. Below, not
   * at: another model's tokenizer is not this one, and the whole point
   * of the constant is to be wrong in the survivable direction.
   */
  var PROMPT_CHARS_PER_TOKEN = 3.7;
  var HISTORY_CHARS_PER_TOKEN = 2.7;
  var REPLY_RESERVE_TOKENS = 3072 + 256;
  var LEDGER_BUDGET = 1500;
  function historyBudget(ctxSize, systemChars) {
    var ctx = Number(ctxSize) || 16384;
    var promptTokens = Math.ceil(Number(systemChars || 0) / PROMPT_CHARS_PER_TOKEN);
    var roomTokens = ctx - REPLY_RESERVE_TOKENS - promptTokens;
    var chars = Math.floor(roomTokens * HISTORY_CHARS_PER_TOKEN) - LEDGER_BUDGET;
    return {
      chars: Math.max(0, chars),
      roomTokens: roomTokens,
      promptTokens: promptTokens,
      starved: chars < 2000
    };
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

  function roughDuration(sec) {
    if (sec < 60) return Math.max(1, Math.round(sec)) + "s";
    var mins = Math.round(sec / 60);
    if (mins < 60) return mins + "m";
    var rem = mins % 60;
    return Math.floor(mins / 60) + "h" + (rem ? " " + rem + "m" : "");
  }

  /**
   * The line a user watches for fifteen minutes. Elapsed seconds ALONE
   * cannot tell a job that is a tenth done from one that has wedged, and
   * the reaction to “still generating… 600s” is to force-quit — which is
   * exactly how the backend gets left holding the card. So whenever
   * ComfyUI has said which step it is on, the fraction and a projection go
   * in front of the user.
   *
   * Both halves are OMITTED rather than guessed: no progress event means
   * no fraction (an old build, a refused websocket), and one step seen
   * means no rate yet. A wrong estimate is worse than none here — it is
   * the number the user decides to wait on.
   */
  function generatingLine(elapsed, progress) {
    var line = "ComfyUI still generating… " + elapsed + "s";
    if (!progress || !(progress.max > 1)) return line;
    line += " — step " + progress.value + "/" + progress.max;
    if (progress.etaSec > 0) {
      line += ", about " + roughDuration(progress.etaSec) + " left";
    }
    return line;
  }

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

  /**
   * The model roots a ComfyUI CONFIG FILE declares. ComfyUI's own answer
   * to "my weights are on another drive" is
   * `extra_model_paths.yaml` (next to main.py), and the Desktop app
   * keeps the same format in `%APPDATA%\ComfyUI\extra_models_config.yaml`
   * — so the roots a real install loads from are frequently in neither
   * the panel's settings nor the folder the panel calls comfyDir.
   *
   * Deliberately a NARROW reader, not a YAML parser: top-level sections,
   * two-space keys, `base_path`, and per-kind keys whose value is one
   * path or a `|` block of them. Anything it does not understand it
   * skips — a root that does not exist costs nothing (the caller asks
   * the filesystem), while a root it never returns is a generation the
   * panel cannot price.
   */
  function configuredModelRoots(s, pathMod) {
    var fsMod, proc;
    try {
      fsMod = global.AEBridge.nodeRequire("fs");
      proc = global.AEBridge.nodeRequire("process");
    } catch (e) { return []; }
    var files = [];
    if (s && s.comfyDir) {
      files.push(pathMod.join(s.comfyDir, "extra_model_paths.yaml"));
    }
    var appdata = proc.env && proc.env.APPDATA;
    if (appdata) {
      files.push(pathMod.join(appdata, "ComfyUI", "extra_models_config.yaml"));
    }
    var out = [];
    for (var f = 0; f < files.length; f++) {
      var text = null;
      try {
        if (fsMod.existsSync(files[f])) text = fsMod.readFileSync(files[f], "utf8");
      } catch (eR) {}
      if (text) parseComfyPathsYaml(String(text), pathMod, out);
    }
    return out;
  }

  /* One config file -> {kind, path} roots, appended to `out`. A section's
   * `base_path` can appear after the keys it resolves (the Desktop app
   * writes it LAST), so a section's keys are held and resolved when the
   * section ends. */
  function parseComfyPathsYaml(text, pathMod, out) {
    var lines = text.split(/\r?\n/);
    var base = null, pending = [], blockKey = null, i;
    function flush() {
      for (var p = 0; p < pending.length; p++) {
        var rel = pending[p].path;
        var abs = /^([a-zA-Z]:[\\/]|[\\/])/.test(rel)
          ? rel : (base ? pathMod.join(base, rel) : null);
        if (abs) out.push({ kind: pending[p].kind, path: abs });
      }
      pending = [];
      base = null;
    }
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, "");
      if (!line || /^\s*#/.test(line)) continue;
      if (!/^\s/.test(line)) { flush(); blockKey = null; continue; }
      var m = line.match(/^\s{1,4}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (m) {
        blockKey = null;
        var key = m[1], val = m[2].replace(/^["']|["']$/g, "");
        if (key === "base_path") { base = val; continue; }
        // A whole models TREE (the Desktop app's own key), not one kind.
        if (key === "download_model_base") {
          pending.push({ kind: null, path: val });
          continue;
        }
        // Not model dirs: config flags and the node roots.
        if (key === "is_default" || key === "custom_nodes") continue;
        if (val === "|" || val === "") { blockKey = key; continue; }
        pending.push({ kind: key, path: val });
        continue;
      }
      if (blockKey && /^\s{4,}\S/.test(line)) {
        pending.push({ kind: blockKey, path: line.replace(/^\s+/, "") });
      }
    }
    flush();
  }

  /**
   * Where a ComfyUI model file could live on this machine, most specific
   * first. Each entry is {kind, path}: a `kind` is a per-type root the
   * user wrote as "checkpoints=D:\SD\ckpts" in settings and only answers
   * for that model dir; a null kind is a whole models tree with the usual
   * subfolders under it.
   */
  function comfyModelRoots(s) {
    var pathMod, proc;
    try {
      pathMod = global.AEBridge.nodeRequire("path");
      proc = global.AEBridge.nodeRequire("process");
    } catch (e) { return []; }
    var roots = [];
    if (s && s.comfyModelsDir) roots.push({ kind: null, path: s.comfyModelsDir });
    var extra = s && s.comfyModelRoots instanceof Array ? s.comfyModelRoots : [];
    for (var i = 0; i < extra.length; i++) {
      var entry = String(extra[i] || "").replace(/^\s+|\s+$/g, "");
      if (!entry) continue;
      var eq = entry.indexOf("=");
      if (eq > 0) {
        roots.push({ kind: entry.slice(0, eq).replace(/\s+$/, ""),
                     path: entry.slice(eq + 1).replace(/^\s+/, "") });
      } else {
        roots.push({ kind: null, path: entry });
      }
    }
    // The ComfyUI DESKTOP app's shared auto-download store. It is where
    // the Desktop downloader puts weights fetched from a workflow's
    // embedded URLs, it is resolved BEFORE the Documents tree (measured
    // from the running instance's own startup log, 2026-08-25), and it is
    // declared in no config file at all — so nothing else here can reach
    // it. Measured 2026-08-30: all four MiniMax H3 weights this machine
    // has already generated with live here and NOWHERE else, so the
    // arbiter priced the shipped H3 template at null, paused chat for
    // every H3 generation on a card that fits both, and refused the
    // generation outright whenever pausing was set to never.
    var localApp = proc.env && proc.env.LOCALAPPDATA;
    if (localApp) {
      roots.push({ kind: null,
                   path: pathMod.join(localApp, "Comfy-Desktop",
                                      "ComfyUI-Shared", "models") });
    }
    // The user's own ComfyUI, then the hidden backend's own tree.
    if (s && s.comfyDir) {
      roots.push({ kind: null, path: pathMod.join(s.comfyDir, "models") });
    }
    try {
      var install = global.Setup && global.Setup.findComfyInstall
        ? global.Setup.findComfyInstall() : null;
      if (install && install.root) {
        roots.push({ kind: null,
                     path: pathMod.join(install.root, "ComfyUI", "models") });
      }
    } catch (e2) {}
    // Last: whatever ComfyUI's own config files declare. A user who moved
    // their models to another drive told ComfyUI, not this panel.
    var declared = configuredModelRoots(s, pathMod);
    for (var d = 0; d < declared.length; d++) roots.push(declared[d]);
    // A root reached two ways is one root — the Desktop config file
    // declares the same tree `comfyDir` already names on this machine.
    var seen = {}, unique = [];
    for (var u = 0; u < roots.length; u++) {
      var sig = String(roots[u].kind) + "\u0000" +
                String(roots[u].path).toLowerCase();
      if (seen[sig]) continue;
      seen[sig] = true;
      unique.push(roots[u]);
    }
    return unique;
  }

  /**
   * The size on disk of one manifest model entry, in MB, or null when no
   * root holds it. Weights are the thing the card actually has to fit, and
   * the file IS the weights — an authored number would go stale the first
   * time somebody swapped a quantization.
   */
  function modelFilePath(m, s) {
    var fsMod, pathMod;
    try {
      fsMod = global.AEBridge.nodeRequire("fs");
      pathMod = global.AEBridge.nodeRequire("path");
    } catch (e) { return null; }
    if (!m || !m.file) return null;
    var roots = comfyModelRoots(s);
    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      if (!r.path) continue;
      var candidate = r.kind === null
        ? pathMod.join(r.path, String(m.dir || ""), String(m.file))
        : (r.kind === m.dir ? pathMod.join(r.path, String(m.file)) : null);
      if (!candidate) continue;
      try {
        if (fsMod.existsSync(candidate) &&
            fsMod.statSync(candidate).size > 0) return candidate;
      } catch (e2) {}
    }
    return null;
  }

  function modelFileMB(m, s) {
    var fsMod;
    try { fsMod = global.AEBridge.nodeRequire("fs"); } catch (e) { return null; }
    var found = modelFilePath(m, s);
    if (!found) return null;
    try {
      var bytes = fsMod.statSync(found).size;
      if (bytes > 0) return Math.round(bytes / 1048576);
    } catch (e2) {}
    return null;
  }

  /**
   * The weight files ONE catalog entry is made of, from whichever shape
   * the entry carries: urls[] pin a filename (the URL's basename) and a
   * kind folder; files[] (entries whose links are not pinned yet) name
   * bare files that register wherever they are found.
   */
  function catalogEntryFiles(entry) {
    var out = [], seen = {}, i;
    var urls = entry && entry.urls instanceof Array ? entry.urls : [];
    for (i = 0; i < urls.length; i++) {
      var u = urls[i] || {};
      if (!u.url) continue;
      var base = String(u.url).split("?")[0].split("#")[0];
      base = base.slice(base.lastIndexOf("/") + 1);
      if (!base || seen[base]) continue;
      seen[base] = true;
      out.push({ file: base, dir: u.dir || null });
    }
    var files = entry && entry.files instanceof Array ? entry.files : [];
    for (i = 0; i < files.length; i++) {
      var f = String(files[i] || "");
      if (!f || seen[f]) continue;
      seen[f] = true;
      out.push({ file: f, dir: null });
    }
    return out;
  }

  /**
   * Find one weight file across every root the panel knows. A pinned
   * kind searches that kind only; a bare name searches every kind folder
   * ComfyUI has — the same tolerance the backend itself applies.
   */
  function findWeightFile(file, dir, s) {
    var fsMod, pathMod;
    try {
      fsMod = global.AEBridge.nodeRequire("fs");
      pathMod = global.AEBridge.nodeRequire("path");
    } catch (e) { return null; }
    var roots = comfyModelRoots(s);
    var kinds = dir ? [dir]
      : ((global.Comfy && global.Comfy.MODEL_SUBS) || []);
    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      if (!r.path) continue;
      for (var k = 0; k < kinds.length; k++) {
        var candidate;
        if (r.kind === null) {
          candidate = pathMod.join(r.path, kinds[k], file);
        } else if (r.kind === kinds[k]) {
          candidate = pathMod.join(r.path, file);
        } else { continue; }
        try {
          var st = fsMod.statSync(candidate);
          if (st.size > 0) return { path: candidate, bytes: st.size };
        } catch (e2) {}
      }
    }
    return null;
  }

  /**
   * The two roots the panel itself put files in — the Settings models
   * folder (whose kind layout ensureDataDirs/applyExtraModelPaths
   * created) and the hidden backend's own tree. These are the ONLY
   * places the Remove button may reap: everything else the search finds
   * (the user's extra roots, the Comfy-Desktop shared store, a root a
   * config file declared) belongs to someone else's downloader.
   */
  function managedModelRoots(s) {
    var pathMod;
    try { pathMod = global.AEBridge.nodeRequire("path"); }
    catch (e) { return []; }
    var out = [];
    if (s && s.comfyModelsDir) out.push(String(s.comfyModelsDir));
    try {
      var install = global.Setup && global.Setup.findComfyInstall
        ? global.Setup.findComfyInstall() : null;
      if (install && install.root) {
        out.push(pathMod.join(install.root, "ComfyUI", "models"));
      }
    } catch (e2) {}
    return out;
  }

  function isManagedPath(p, s) {
    var pathMod;
    try { pathMod = global.AEBridge.nodeRequire("path"); }
    catch (e) { return false; }
    var roots = managedModelRoots(s);
    var full = String(pathMod.resolve(String(p))).toLowerCase();
    for (var i = 0; i < roots.length; i++) {
      var root = String(pathMod.resolve(roots[i])).toLowerCase();
      if (full === root ||
          full.indexOf(root + pathMod.sep) === 0) return true;
    }
    return false;
  }

  /**
   * What is on disk for one catalog entry, file by file, with where it
   * lives and whether that place is the panel's to clean up. This is the
   * settings row's whole truth: present/absent, measured MiB, and
   * managed (deletable) or somebody else's copy.
   */
  function catalogModelStatus(entry, s) {
    if (!s) { try { s = global.Settings.get(); } catch (e) { s = null; } }
    var wanted = catalogEntryFiles(entry);
    var files = [], present = 0, presentMB = 0;
    var anyManaged = false;
    for (var i = 0; i < wanted.length; i++) {
      var w = wanted[i];
      var hit = findWeightFile(w.file, w.dir, s);
      var row = {
        file: w.file, dir: w.dir,
        path: hit ? hit.path : null,
        mb: hit ? Math.round(hit.bytes / 1048576) : null,
        managed: hit ? isManagedPath(hit.path, s) : false
      };
      if (hit) {
        present++;
        presentMB += row.mb;
        if (row.managed) anyManaged = true;
      }
      files.push(row);
    }
    return {
      name: entry ? entry.name : null,
      label: entry ? (entry.label || entry.name) : null,
      files: files,
      totalCount: wanted.length,
      presentCount: present,
      presentMB: presentMB,
      anyManaged: anyManaged,
      downloadable: !!(entry && entry.urls instanceof Array &&
                       entry.urls.length)
    };
  }

  /**
   * Delete one catalog entry's weights from the panel-managed roots and
   * ONLY from there. Receipts either way: what was removed (with the
   * MiB it freed), what was left because it lives in a folder the panel
   * does not own, and what could not be deleted (Windows holds a file
   * the backend still has open). Nothing here ever touches the user's
   * own collections or the Comfy-Desktop shared store.
   */
  function removeCatalogWeights(entry, s) {
    if (!s) { try { s = global.Settings.get(); } catch (e) { s = null; } }
    var fsMod;
    try { fsMod = global.AEBridge.nodeRequire("fs"); }
    catch (e) {
      return { removed: [], freedMB: 0, kept: [], failed: [],
               note: "No filesystem access — is the panel running " +
                     "outside CEP?" };
    }
    var st = catalogModelStatus(entry, s);
    var removed = [], kept = [], failed = [], freedMB = 0;
    for (var i = 0; i < st.files.length; i++) {
      var row = st.files[i];
      if (!row.path) continue;
      if (!row.managed) {
        kept.push({ file: row.file, path: row.path,
                    why: "not in a panel-managed folder — the panel " +
                         "only deletes files it downloaded itself" });
        continue;
      }
      try {
        fsMod.unlinkSync(row.path);
        removed.push({ file: row.file, path: row.path, mb: row.mb });
        freedMB += row.mb;
      } catch (e2) {
        failed.push({ file: row.file, path: row.path,
                      error: e2.message + " — if the generation backend " +
                             "is running it may still hold this file; " +
                             "stop it and retry" });
      }
    }
    var note = "";
    if (!removed.length && !kept.length && !failed.length) {
      note = "Nothing of " + (st.label || "this model") + " is on disk.";
    }
    return { removed: removed, freedMB: freedMB, kept: kept,
             failed: failed, note: note };
  }

  /**
   * The generation's weight bill: every non-optional model the workflow
   * loads, measured on disk (a manifest `sizeMB` is honoured first, for a
   * template that ships one).
   *
   * ONE unknown weight makes the whole answer null. A partial sum reads
   * like a verified fit and understates the bill in exactly the direction
   * that OOMs a card, and "unprovable" already has a safe meaning here:
   * pause the chat model. Measured 2026-08-30: no shipped manifest carried
   * a single sizeMB, so this returned null for every template ever
   * shipped, and a 32 GB card paused chat for every generation it could
   * have run concurrently.
   */
  function genNeedMBFor(manifest, settings) {
    if (!manifest || !(manifest.models instanceof Array)) return null;
    var s = settings;
    if (!s) {
      try { s = global.Settings.get(); } catch (e) { s = null; }
    }
    var sum = 0, counted = 0;
    for (var i = 0; i < manifest.models.length; i++) {
      var m = manifest.models[i];
      if (!m || m.optional) continue;
      var mb = typeof m.sizeMB === "number" && m.sizeMB > 0
        ? m.sizeMB : modelFileMB(m, s);
      if (typeof mb !== "number" || !(mb > 0)) return null;
      sum += mb;
      counted++;
    }
    return counted > 0 ? sum : null;
  }

  /**
   * The generation's OTHER precondition, and the one no arithmetic can
   * see: whether the running backend can actually LOAD these weights.
   *
   * `genNeedMBFor` above reads the DISK, because that is the only place a
   * weight's SIZE exists (/object_info carries none). ComfyUI decides what
   * it can open from its own search path, and on a machine where those two
   * trees differ the panel prices a job, stops the chat model to make room
   * for it, and only then hears `Value not in list`. Measured 2026-08-30:
   * all four MiniMax H3 weights sit where `comfyModelRoots` looks and the
   * running backend (launched `--base-directory Documents\ComfyUI`, no
   * extra_model_paths.yaml on the machine) sees none of them.
   *
   * So both sources are asked, and the refusal is the one sentence that
   * tells a user their backend is pointed at the wrong root: the files it
   * cannot load AND where they are on disk.
   *
   * The SECOND thing no arithmetic can see, added 2026-09-09 (WORKPLAN
   * 17g): whether the backend has the enum VALUES the template names. A
   * preflight that checks weights alone reports "ready" about a graph
   * ComfyUI refuses outright — measured on the shipped KREA2 template,
   * whose sampler `res_2s` exists only where the RES4LYF pack is
   * installed. Both questions are asked in one walk of /object_info
   * (Comfy.validateGraphInputs) and either one refuses.
   *
   * cb(refusalResult|null). Anything that stops the question being
   * answered — an unreadable template, an unreachable backend, a class the
   * server does not know — answers null and the round proceeds exactly as
   * before. This may only ever refuse what ComfyUI would itself reject.
   */
  /**
   * Node ids the preflight must NOT judge, because the graph it reads off
   * disk is not the graph that will be posted: `resolveOptionalNodes` may
   * drop or re-class them first. Only an UNCONDITIONAL entry needs listing
   * — a `when: "missing"` entry is self-answering, since a missing class
   * has no /object_info definition and the check is already silent there.
   */
  function unconditionalOptionalNodes(manifest) {
    var list = (manifest && manifest.optionalNodes instanceof Array)
      ? manifest.optionalNodes : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      if (e.when && e.when !== "missing") out.push(String(e.nodeId));
    }
    return out;
  }

  function preflightRefusalFor(s, workflowFile, manifest, cb) {
    var graph = null;
    try {
      graph = global.Comfy.loadWorkflow ?
        global.Comfy.loadWorkflow(workflowFile) : null;
    } catch (e) { cb(null); return; }
    var check = global.Comfy.validateGraphInputs;
    if (!graph || !check) { cb(null); return; }
    check(global.Comfy.backendUrl(s), graph,
          { skipNodes: unconditionalOptionalNodes(manifest) },
          function (err, res) {
      if (err || !res) { cb(null); return; }
      // Weights first: it is the older and the more expensive failure (the
      // arbiter would hand the whole card over for files that cannot be
      // opened), and its sentence names where they sit on disk.
      if (res.missing instanceof Array && res.missing.length) {
        cb({ ok: false,
             error: describeMissingWeights(res.missing, manifest, s) });
        return;
      }
      if (res.badValues instanceof Array && res.badValues.length) {
        cb({ ok: false, error: describeBadValues(res.badValues, s) });
        return;
      }
      cb(null);
    });
  }

  /** Where a weight the backend refused actually sits on this disk. */
  function diskPathForWeight(fileName, manifest, s) {
    var base = String(fileName).replace(/^.*[\\\/]/, "");
    var models = (manifest && manifest.models instanceof Array)
      ? manifest.models : [];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (!m || !m.file) continue;
      if (String(m.file).replace(/^.*[\\\/]/, "") !== base) continue;
      var found = modelFilePath(m, s);
      if (found) return found;
    }
    return null;
  }

  var MISSING_WEIGHTS_LISTED = 6;

  function describeMissingWeights(missing, manifest, s) {
    var lines = [], onDisk = 0;
    var shown = Math.min(missing.length, MISSING_WEIGHTS_LISTED);
    for (var i = 0; i < missing.length; i++) {
      var w = missing[i];
      var where = diskPathForWeight(w.value, manifest, s);
      if (where) onDisk++;
      if (i >= shown) continue;
      lines.push(w.value + " (node " + w.node + " " + w.classType + "." +
                 w.input + ", " + (where ? "on disk at " + where
                                         : "not on this disk either") + ")");
    }
    var tail = missing.length > shown
      ? " and " + (missing.length - shown) + " more" : "";
    var advice = onDisk === missing.length
      ? "Every one of those files IS on this machine, so the running " +
        "ComfyUI is searching a different models tree — point it at them " +
        "(extra_model_paths.yaml, or the --base-directory it was started " +
        "with) and try again."
      : (onDisk > 0
          ? "Some are on this machine and some are not, so both the " +
            "download and the backend's model search path need checking."
          : "Download them into the models tree ComfyUI searches.");
    return "ComfyUI at " + global.Comfy.backendUrl(s) + " cannot load " +
           missing.length +
           " of this workflow's weights, so the generation would fail even " +
           "after freeing VRAM for it. Missing from the backend's own model " +
           "list: " + lines.join("; ") + tail + ". " + advice;
  }

  /**
   * The sentence for a value the backend does not have.
   *
   * It lists what the backend DOES offer, because that is the only thing
   * that turns "res_2s is not available" into a fix — and it uses
   * ComfyUI's own threshold for when a list stops helping: `validate_inputs`
   * prints the options when there are 20 or fewer and a bare count above
   * that (execution.py, measured on the vendor build). Matching it means a
   * user who sees both messages sees the same shape twice.
   *
   * The advice names the manifest seam rather than the template, because
   * editing the API template by hand is the wrong fix twice over: the file
   * is generated, and an installed panel's copy is refreshed from the repo.
   */
  var ENUM_CHOICES_LISTED = 20;

  function describeBadValues(bad, s) {
    var lines = [];
    for (var i = 0; i < bad.length; i++) {
      var b = bad[i];
      var choices = b.choices instanceof Array ? b.choices : [];
      var has = choices.length <= ENUM_CHOICES_LISTED
        ? "it has " + choices.join(", ")
        : "it has " + choices.length + ", including " +
          choices.slice(0, ENUM_CHOICES_LISTED).join(", ");
      lines.push("node " + b.node + " " + b.classType + "." + b.input +
                 " is set to '" + b.value + "' and " + has);
    }
    return "ComfyUI at " + global.Comfy.backendUrl(s) + " does not offer " +
      bad.length + " of the values this workflow asks for, so it would " +
      "refuse the whole graph at " +
      "validation rather than render anything: " + lines.join("; ") + ". " +
      "Values like these come from custom node packs, which add choices to " +
      "nodes that are otherwise core — so this template was authored on a " +
      "machine with a pack this backend does not have. Fix it in the " +
      "workflow's .manifest.json (panelAdaptation.setInputs) and re-run " +
      "scripts/adapt-workflow.js; editing the API template directly is " +
      "overwritten by the next regeneration.";
  }

  // How long a VRAM wait is willing to sit there. The release wait is the
  // longer one for a measured reason: on a cancelled round (0.10.14) this
  // backend finished handing the card back at ~10.5 s, so a 10 s limit is
  // a coin flip on exactly the round the cancel created. It costs nothing
  // when the card is already free — the predicate answers on poll one.
  var VRAM_WAIT_MS = 10000;
  var VRAM_ROOM_WAIT_MS = 30000;

  /**
   * Poll nvidia-smi until total used VRAM drops by ~half the released
   * model (or a 10 s timeout — proceed either way, loudly). A fixed
   * sleep after kill was hope, not verification: the old process
   * releases its allocation asynchronously.
   */
  function waitForVramDrop(baselineMB, expectDropMB, sink, done) {
    if (typeof baselineMB !== "number") {
      // nvidia-smi unavailable — the old fixed grace period is all we have.
      global.setTimeout(function () { done(null); }, 1500);
      return;
    }
    var target = Math.max(512,
      typeof expectDropMB === "number" ? Math.round(expectDropMB / 2) : 512);
    waitForVram(function (usedMB) { return baselineMB - usedMB >= target; },
                VRAM_WAIT_MS,
                "VRAM did not visibly release within 10 s — proceeding " +
                "anyway.",
                sink, done);
  }

  /**
   * Poll nvidia-smi until `reached(usedMB)` or `limitMs` — proceed either
   * way, loudly. `msg` is the sentence the timeout prints: a string, or a
   * function(lastUsedMB) that may answer null to stay quiet. Reports the
   * last reading so the caller can remember where the card settled.
   */
  function waitForVram(reached, limitMs, msg, sink, done) {
    var waited = 0;
    var STEP = 500;
    var LIMIT = typeof limitMs === "number" && limitMs > 0
      ? limitMs : VRAM_WAIT_MS;
    (function poll() {
      global.Setup.queryVramUsedMB(function (err, usedMB) {
        if (!err && reached(usedMB)) { done(usedMB); return; }
        waited += STEP;
        if (err || waited >= LIMIT) {
          if (sink && waited >= LIMIT && msg) {
            var line = typeof msg === "function"
              ? msg(err ? null : usedMB) : msg;
            if (line) sink(line);
          }
          done(err ? null : usedMB);
          return;
        }
        global.setTimeout(poll, STEP);
      });
    })();
  }

  /**
   * The card's REAL size in MB, from nvidia-smi's own total — never
   * `vramOverrideGB`. The override impersonates a tier so any card can
   * test any policy, but the release wait asks a physical question about
   * a physical reading, and pairing a measured `memory.used` with a
   * fictional total is arithmetic about no machine at all.
   */
  function cardTotalMBNow() {
    return gpuCache && typeof gpuCache.vramGB === "number" &&
           gpuCache.vramGB > 0 ? gpuCache.vramGB * 1024 : null;
  }

  var VramArbiter = {
    paused: false,
    _opts: null,
    // Where the card settled once the chat model was gone — the floor the
    // resume aims at when it cannot ask the better question.
    _floorMB: null,
    // The better question's two numbers, remembered at pause time: what
    // the chat model's footprint was, and how big the card really is.
    _needMB: null,
    _cardMB: null,

    /**
     * The decision, assembled from what is REALLY on this machine and
     * decided nowhere else: the measured card (or the impersonated one),
     * the tier that VRAM lands in, the running chat model's own file, and
     * the workflow's weight bill off disk.
     *
     * Split out of ensureFor so the answer can be asked WITHOUT paying
     * for it. ensureFor's other half kills llama-server, so every probe
     * of the decision surface used to cost a model reload — which is why
     * the tier ladder (workplan item 7) could only ever be spot-checked.
     * Returns {decision, tier, eff, chat, genNeedMB}.
     */
    planFor: function (s, manifest) {
      var chat = chatLoadedMBNow();
      var eff = global.Tiers.effectiveVram(gpuCache, s);
      var tier = global.Tiers.tierFor(eff.vramGB);
      var need = genNeedMBFor(manifest, s);
      return {
        decision: global.Tiers.planHandoff({
          vramGB: eff.vramGB,
          headroomGB: tier.headroomGB,
          chatRunning: chat.running,
          chatLoadedMB: chat.mb,
          genNeedMB: need,
          pauseMode: s.comfyPauseLlm,
          mandatory: tier.mandatory,
          overridden: eff.overridden
        }),
        tier: tier, eff: eff, chat: chat, genNeedMB: need
      };
    },

    /**
     * Decide and, when the arithmetic says so, perform the chat→gen
     * handoff with verified release. cb(refusalResult|null) — a refusal
     * is a grounded {ok:false} the caller returns as the tool result,
     * BEFORE any VRAM churn.
     */
    ensureFor: function (s, manifest, sink, cb) {
      if (VramArbiter.paused) { cb(null); return; }   // this round already paid
      var plan = VramArbiter.planFor(s, manifest);
      var chat = plan.chat;
      var decision = plan.decision;
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
      VramArbiter._needMB = typeof chat.mb === "number" && chat.mb > 0
        ? chat.mb : null;
      VramArbiter._cardMB = cardTotalMBNow();
      global.Setup.queryVramUsedMB(function (qErr, baseMB) {
        global.Llama.stop();
        waitForVramDrop(qErr ? null : baseMB, chat.mb, sink,
                        function (settledMB) {
                          VramArbiter._floorMB =
                            typeof settledMB === "number" ? settledMB : null;
                          cb(null);
                        });
      });
    },

    /**
     * The gen→chat half, run once per round after the last command:
     * ask ComfyUI to drop its cached models (they otherwise sit in VRAM
     * and block the chat model from coming back on exclusive tiers),
     * verify the release, then warm the chat model back up.
     *
     * The wait asks whether there is ROOM FOR THE CHAT MODEL — not
     * whether the card is back to the floor the pause left it at. Both
     * were tried in the field:
     *
     * A DELTA from a baseline sampled here can never appear (ComfyUI 0.32
     * drops a Krea generation's ~19.5 GB about ten seconds BEFORE the
     * round ends), so it burned the full timeout on every healthy round.
     * The FLOOR is honest but asks for more than the resume needs, and it
     * lies in the safe-looking direction: measured 2026-08-30 after a
     * cancelled round, the card sat at 23 654 MB for the whole window and
     * fell to 2 918 MB one second later, so the panel told a user with
     * 29 GB free that their VRAM had not been released. Room is the thing
     * llama-server actually has to have; the floor stays in as an OR,
     * since a card back where it started is by definition room enough,
     * and as the whole answer when the card's own size is unknown.
     */
    resumeIfPaused: function (s, sink, cb) {
      if (!VramArbiter.paused) { cb(); return; }
      VramArbiter.paused = false;
      var opts = VramArbiter._opts;
      var floor = VramArbiter._floorMB;
      var need = VramArbiter._needMB;
      var card = VramArbiter._cardMB;
      VramArbiter._opts = null;
      VramArbiter._floorMB = null;
      VramArbiter._needMB = null;
      VramArbiter._cardMB = null;
      function warm() {
        if (sink) sink("Warming the chat model back up…");
        global.Llama.start(opts, function () { cb(); });
      }
      function atFloor(usedMB) {
        return typeof floor === "number" && usedMB <= floor + 512;
      }
      global.Comfy.freeVram(global.Comfy.backendUrl(s), function () {
        if (typeof need === "number" && typeof card === "number") {
          waitForVram(
            function (usedMB) { return card - usedMB >= need || atFloor(usedMB); },
            VRAM_ROOM_WAIT_MS,
            function (usedMB) {
              if (typeof usedMB !== "number") return null;
              return "The card still holds " + usedMB + " MB of " + card +
                     " MB and the chat model needs about " + need +
                     " MB — loading it anyway.";
            },
            sink, function () { warm(); });
          return;
        }
        if (typeof floor !== "number") {
          // Nothing to aim at (nvidia-smi was unavailable at pause time) —
          // the old fixed grace period is all there is.
          global.setTimeout(warm, 1500);
          return;
        }
        waitForVram(atFloor, VRAM_WAIT_MS,
                    "VRAM did not visibly release within 10 s — proceeding " +
                    "anyway.",
                    sink, function () { warm(); });
      });
    }
  };

  /*
   * Assemble the resolver's inputs. comfy.js stays pure - it knows about
   * templates, not about tiers or the catalog - so the panel supplies the
   * three predicates here, where both are already in scope.
   *
   * The catalog is read straight off the global: index.html loads
   * version.js before tools.js, so AELL.COMFY_CATALOG is always there.
   * The hosted feed can override it (Setup.comfyCatalog), but update.json
   * carries modelCatalog only - no comfyCatalog producer exists - so
   * plumbing the override through would be a hook with nothing on the
   * other end.
   */
  /*
   * The three facts a template is judged by, assembled once: which
   * catalog entry it renders, whether this card can hold it, and whether
   * its weights are on the disk. Both the nameless-default resolver and
   * the Settings rows read them, so a row can never say something the
   * chooser disagrees with.
   */
  function workflowFacts(s) {
    var catalog = [];
    try { catalog = (global.AELL && global.AELL.COMFY_CATALOG) || []; }
    catch (eC) { catalog = []; }

    var ctx = null;
    try { ctx = global.Tiers.resolveTier(gpuCache, s); }
    catch (eT) { ctx = null; }

    function entryOf(d) {
      if (!d.catalogEntry) return null;
      for (var i = 0; i < catalog.length; i++) {
        if (catalog[i].name === d.catalogEntry) return catalog[i];
      }
      return null;
    }
    function fits(d) {
      var e = entryOf(d);
      // An entry we cannot link, or a card we cannot size, is treated as
      // fitting: refusing on an unknown is how a working template becomes
      // unreachable.
      if (!e || !ctx) return true;
      try { return global.Tiers.entryFits(e, ctx); }
      catch (eF) { return true; }
    }
    function weightStatus(d) {
      var e = entryOf(d);
      if (!e) return null;
      try {
        var st = catalogModelStatus(e, s);
        if (!st || !st.files || !st.files.length) return null;
        var have = 0;
        for (var i = 0; i < st.files.length; i++) {
          if (st.files[i].path) have++;
        }
        return { have: have, total: st.files.length };
      } catch (eW) { return null; }
    }
    return {
      catalog: catalog, ctx: ctx, entryOf: entryOf, fits: fits,
      weightStatus: weightStatus,
      weightsPresent: function (d) {
        var w = weightStatus(d);
        return !!(w && w.total > 0 && w.have === w.total);
      },
      baseline: function (d) {
        var e = entryOf(d);
        return !!(e && e.workflowTemplate === d.name);
      }
    };
  }

  /*
   * One row per installed template, for Settings > ComfyUI > Workflows.
   * PURE over its inputs and exported, because main.js has no executed
   * coverage at all — the row MODEL is testable even though the DOM it
   * becomes is not.
   *
   * `needs` is the half the owner asked for: what a template requires,
   * derived from facts that already exist one hop away rather than from
   * anything new. A row that says only "AE_LLAMA_H3_I2V_V1" tells a user
   * nothing about why it will not run on their card.
   */
  function workflowRows(s) {
    if (!s) { try { s = global.Settings.get(); } catch (e) { s = {}; } }
    var descs = [];
    try { descs = global.Comfy.describeWorkflows(s.comfyWorkflowsDir) || []; }
    catch (eD) { descs = []; }
    var f = workflowFacts(s);
    var enh = s.comfyEnhance || {};
    var enabled = s.comfyWorkflows || {};
    var rows = [];
    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      // The format example is hidden here for the same reason the model
      // is never offered it: it holds the CHANGE-ME placeholder and can
      // never render. It used to get a checkbox of its own.
      if (d.example) continue;
      var e = f.entryOf(d);
      var w = f.weightStatus(d);
      var needs = [];
      if (e && typeof e.minVramGB === "number") {
        needs.push("needs " + e.minVramGB + "+ GB VRAM");
      }
      if (e && e.requiresBlackwell) needs.push("RTX 50 series only");
      if (e && e.requiresAda) needs.push("RTX 40 series or newer");
      if (d.requiresImage) needs.push("needs a reference image");
      if (w && w.have < w.total) {
        needs.push((w.total - w.have) + " of " + w.total +
                   " model file(s) missing");
      }
      rows.push({
        name: d.name,
        kind: d.kind || null,
        label: e ? e.label : null,
        catalogEntry: d.catalogEntry || null,
        baseline: f.baseline(d),
        fits: f.fits(d),
        takesImage: !!d.takesImage,
        requiresImage: !!d.requiresImage,
        lengthIn: d.lengthIn,
        weights: w,
        needs: needs,
        enhance: enh[d.name] !== false,
        enabled: !(enabled[d.name] && enabled[d.name].enabled === false)
      });
    }
    return rows;
  }

  function pickWorkflow(s, args) {
    var descs = global.Comfy.describeWorkflows(s.comfyWorkflowsDir);
    var f = workflowFacts(s);
    return global.Comfy.resolveWorkflow(descs, {
      // A length was asked for => a video was asked for. No new argument
      // and no prompt bytes: the model already reaches these.
      kind: (args.frames > 0 || args.durationSeconds > 0)
        ? "video" : "image",
      image: args.image,
      disabled: s.comfyWorkflows || {}
    }, f.ctx, {
      fits: f.fits,
      weightsPresent: f.weightsPresent,
      // The graph the catalog entry itself points at is the BASELINE.
      // Without this the owner's own refined template and the shipped
      // basic tie on every other axis and fall through to name order.
      baseline: f.baseline
    });
  }

  var PANEL_TOOLS = {

    comfy_status: function (args, cb) {
      var s = global.Settings.get();
      global.Comfy.status(global.Comfy.backendUrl(s), function (err, st) {
        cb({ ok: true, data: st });
      });
    },

    comfy_list_workflows: function (args, cb) {
      var s = global.Settings.get();
      var list = global.Comfy.listWorkflows(s.comfyWorkflowsDir);
      var names = [], examples = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].example) examples.push(list[i].name);
        else names.push(list[i].name);
      }
      if (names.length === 0) {
        cb({ ok: false, error: "No runnable workflow templates in " +
             s.comfyWorkflowsDir + "." +
             (examples.length
               ? " " + examples.join(", ") + " " +
                 (examples.length > 1 ? "are format examples" :
                                        "is a format example") +
                 " with a placeholder checkpoint and cannot render."
               : "") +
             " Export API-format workflows from ComfyUI into that folder." });
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
      var all = global.Comfy.listWorkflows(s.comfyWorkflowsDir);
      // A template holding the shipped placeholder renders nothing, so it
      // is never the default and never silently chosen. Naming one is
      // answered with what it is, not with ComfyUI's validator dump.
      var list = [], runnable = [];
      for (var r = 0; r < all.length; r++) {
        if (!all[r].example) list.push(all[r]);
        runnable.push(all[r].name);
      }
      if (list.length === 0) {
        cb({ ok: false, error: "No runnable workflow templates in " +
             s.comfyWorkflowsDir + (all.length
               ? " (" + runnable.join(", ") + " " +
                 (all.length > 1 ? "are format examples" :
                                   "is a format example") +
                 " with a placeholder checkpoint)" : "") });
        return;
      }
      var names = [];
      for (var j = 0; j < list.length; j++) names.push(list[j].name);
      // No workflow named: ask the resolver rather than the alphabet.
      // `list[0]` sent "a picture of a red apple" to AE_LLAMA_H3_I2V_V1 -
      // a 40 GB Blackwell-only VIDEO graph - because ae_llama_h3 sorts
      // before ae_llama_krea2.
      var chosen = null;
      if (!args.workflow) {
        var pick = pickWorkflow(s, args);
        if (!pick.chosen) {
          cb({ ok: false, error: pick.why + ". Available: " +
               names.join(", ") });
          return;
        }
        for (var c = 0; c < list.length; c++) {
          if (list[c].name === pick.chosen.name) { chosen = list[c]; break; }
        }
        if (!chosen) chosen = list[0];
      }
      if (args.workflow) {
        var found = null, placeholder = null;
        for (var i = 0; i < all.length; i++) {
          if (all[i].name.toLowerCase() ===
              String(args.workflow).toLowerCase()) {
            if (all[i].example) placeholder = all[i];
            else found = all[i];
            break;
          }
        }
        if (placeholder) {
          cb({ ok: false, error: "'" + placeholder.name + "' is a format " +
               "example, not a usable workflow — its checkpoint is still " +
               "the placeholder CHANGE-ME.safetensors, so ComfyUI rejects " +
               "it. Use one of: " + names.join(", ") });
          return;
        }
        if (!found) {
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
      global.Comfy.generate({
        comfyUrl: global.Comfy.backendUrl(s),
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
      }, function (elapsed, progress) {
        if (progressSink) progressSink(generatingLine(elapsed, progress));
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
            // The size that was REQUESTED is not always the size that was
            // rendered - the shipped KREA2 template upscales 1.6x between
            // its passes, so width 1024 saves 1640. import_file measures
            // the file in AE; hoist that measurement to the top of the
            // result so the model plans the comp around the real picture
            // instead of around its own request.
            var data = { files: result.files, imported: imported,
                         applied: result.applied };
            for (var m = 0; m < imported.length; m++) {
              if (imported[m] && imported[m].width > 0 &&
                  imported[m].height > 0) {
                data.outputSize = imported[m].width + "x" + imported[m].height;
                break;
              }
            }
            finish({ ok: true, data: data });
            return;
          }
          callHostTool("import_file", { path: result.files[i] },
            function (r) {
              imported.push(r.ok ? r.data : { error: r.error });
              next(i + 1);
            });
        })(0);
      });
      }
      // Enhancement runs FIRST, while the chat model is still loaded —
      // the VRAM decision comes after, and a refusal (pause mode
      // 'never' on a job that cannot fit) comes back as a grounded
      // error before anything is churned.
      var manifest = global.Comfy.readManifest
        ? global.Comfy.readManifest(chosen.file) : null;
      // Keyed on the template that WILL run, not on what the caller
      // typed. args.workflow is empty on a nameless call and can differ
      // in case on a named one, so an opt-out recorded against the real
      // name was silently bypassed in both.
      var plan = planEnhancement(s, chosen.name, args.prompt, manifest);
      var enhanceDone = function () {
        // Three preconditions, cheapest first, and every one of them
        // answered BEFORE the arbiter stops the chat model.
        //
        // The VRAM refusal goes first because `planFor` is the decision
        // with no side effects at all (that is what it was split out
        // for) — a job that can never fit is refused without booting
        // anything. The weight check needs a RUNNING backend, since
        // /object_info is its ground truth, so it sits after the boot
        // the generation was going to pay for anyway and before the
        // handoff, which is the churn worth saving.
        if (VramArbiter.planFor(s, manifest).decision.mode === "refuse") {
          VramArbiter.ensureFor(s, manifest, progressSink,
            function (refusal) {
              if (refusal) { cb(refusal); return; }
              begin();
            });
          return;
        }
        global.Comfy.ensureRunning(global.Comfy.backendUrl(s),
                                   function (bootMsg) {
          if (progressSink) progressSink(bootMsg);
        }, function (bootErr) {
          if (bootErr) { finish({ ok: false, error: bootErr.message }); return; }
          preflightRefusalFor(s, chosen.file, manifest, function (refusal) {
            if (refusal) { cb(refusal); return; }
            VramArbiter.ensureFor(s, manifest, progressSink,
              function (refusal) {
                if (refusal) { cb(refusal); return; }
                begin();
              });
          });
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

  /*
   * transcribe_to_captions — the one tool of WORKPLAN 6.1 Pass C the
   * model actually calls. It is a PANEL tool because the middle step is
   * a child process, which ExtendScript cannot spawn; the two ends are
   * host tools (render_comp_audio, add_captions) so the self-test can
   * cover them in real AE with no speech model installed.
   *
   *   comp -> render_comp_audio -> AIFF -> whisper-cli -> segments
   *        -> add_captions -> text layers or markers
   *
   * The AIFF is a throwaway in Folder.temp and is deleted afterwards
   * unless {keepAudio: true}. Measured end to end on 2026-08-29: a 5 s
   * comp rendered in 0.1 s and transcribed in 682 ms.
   */
  PANEL_TOOLS.transcribe_to_captions = function (args, cb) {
    args = args || {};
    if (!global.Whisper) {
      cb({ ok: false, error: "Speech-to-text is not available in this " +
           "panel build." });
      return;
    }
    var found;
    try { found = global.Whisper.find(args.model); }
    catch (e) { cb({ ok: false, error: "whisper.cpp lookup failed: " +
                     e.message }); return; }
    if (!found.ok) { cb({ ok: false, error: found.reason }); return; }

    var as = String(args.as || "text").toLowerCase();
    if (as !== "text" && as !== "markers") {
      cb({ ok: false, error: "'as' must be 'text' (a text layer per " +
           "caption, the default) or 'markers' — got " + String(args.as) });
      return;
    }

    var fs = null, path = null;
    try {
      fs = global.AEBridge.nodeRequire("fs");
      path = global.AEBridge.nodeRequire("path");
    } catch (eN) {
      cb({ ok: false, error: "Node is unavailable in this panel: " +
           eN.message });
      return;
    }

    // A fixed name would collide with the last run's leftovers, and
    // render_comp REFUSES an existing output rather than raise AE's
    // overwrite modal — so the name carries the clock, and overwrite
    // stays on as the belt to that braces.
    var tmp = path.join(
      global.AEBridge.nodeRequire("os").tmpdir(),
      "aell-transcribe-" + new Date().getTime() + ".aif");

    var sink = args.progressSink || null;
    if (sink) sink("Rendering the comp's audio…");

    callHostTool("render_comp_audio", {
      comp: args.comp, output: tmp.replace(/\\/g, "/"), overwrite: true,
      startTime: args.startTime, durationSeconds: args.durationSeconds
    }, function (rendered) {
      if (!rendered.ok) { cb(rendered); return; }
      var wrote = String((rendered.data && rendered.data.output) || tmp);

      function cleanup() {
        if (args.keepAudio) return;
        try { fs.unlinkSync(wrote); } catch (eU) {}
      }

      if (sink) sink("Transcribing…");
      global.Whisper.transcribe(wrote, { model: args.model,
                                         install: found,
                                         language: args.language },
        function (err, out) {
          if (err) { cleanup(); cb({ ok: false, error: err.message }); return; }
          var segs = out.segments;
          if (!segs.length) {
            cleanup();
            cb({ ok: false, error: "The transcriber found no speech in '" +
                 ((rendered.data && rendered.data.comp) || "the comp") +
                 "'. Its audio layers are " +
                 ((rendered.data && rendered.data.audioLayers) || "unknown") +
                 " — music and effects transcribe to nothing." });
            return;
          }
          // FACT 1 (whisper.js): a silent file transcribes as the word
          // "You" with exit code 0. render_comp_audio refuses a comp with
          // no audio LAYER, but a layer whose audio is silence gets past
          // it, and this is the shape that leaves behind.
          if (global.Whisper.looksLikeSilence(segs)) {
            cleanup();
            cb({ ok: false, error: "The only thing transcribed was \"" +
                 segs[0].text + "\", which is what whisper.cpp hears in " +
                 "SILENCE — not speech it recognised. Check that the " +
                 "audio layers (" +
                 ((rendered.data && rendered.data.audioLayers) || "?") +
                 ") actually carry speech in this part of the comp." });
            return;
          }
          if (args.maxSegments > 0 && segs.length > args.maxSegments) {
            segs = segs.slice(0, args.maxSegments);
          }
          // Segment times are relative to the RENDER, so a partial render
          // has to be put back on the comp's own clock.
          var offset = Number(args.startTime) || 0;
          if (offset) {
            for (var i = 0; i < segs.length; i++) {
              segs[i] = { start: segs[i].start + offset,
                          end: segs[i].end + offset, text: segs[i].text };
            }
          }
          if (sink) sink("Building " + segs.length + " caption(s)…");
          callHostTool("add_captions", {
            comp: args.comp, segments: segs, as: as, layer: args.layer,
            name: args.name, fontSize: args.fontSize, font: args.font,
            fillColor: args.fillColor, position: args.position,
            justification: args.justification
          }, function (built) {
            cleanup();
            if (!built.ok) { cb(built); return; }
            built.data.transcribed = segs.length + " segment(s) in " +
              out.ms + " ms";
            built.data.transcript = out.text;
            if (args.keepAudio) built.data.audioFile = wrote;
            cb(built);
          });
        });
    });
  };

  /*
   * export_gif / export_social (WORKPLAN 6.2 Pass B) — the comp, out to
   * a file somebody can actually post.
   *
   *   comp -> render_comp "Lossless" -> rawvideo AVI -> ffmpeg -> .gif/.mp4
   *
   * PANEL tools, for transcribe_to_captions' reason: the middle step is a
   * child process and ExtendScript cannot spawn one. Both ends are
   * already covered in real AE by the self-test (render_comp), so this
   * pass adds no suite steps — what it adds is a refusal at every point
   * where a step reports success and means nothing.
   *
   * Three of those, all measured (see extension/js/ffmpeg.js):
   *  - AE renders the WORK AREA when no span is given. A 3 s comp
   *    trimmed to its middle second exports ONE second and says DONE.
   *    So the span is always reported, and a short one is called out.
   *  - The lossless intermediate is width*height*3 PER FRAME: 1.87 GB
   *    for 10 s of 1080p30. It is estimated and refused BEFORE the
   *    render, not discovered when the disk fills.
   *  - ffmpeg exits 0 when it writes nothing, and can write a container
   *    with no picture in it. The result is read back with ffprobe every
   *    time; the exit code is never the check.
   */

  /* Everything the two exports share: find ffmpeg, measure the comp,
   * check the destination, render the master, encode, VERIFY, clean up.
   * `plan(ctx)` is the only part that differs, and it returns the ffmpeg
   * argument list. */
  function ffmpegExport(kind, args, cb, plan) {
    args = args || {};
    if (!global.Ffmpeg) {
      cb({ ok: false, error: "Video export is not available in this " +
           "panel build." });
      return;
    }
    var F = global.Ffmpeg;
    var install;
    try { install = F.find(); }
    catch (eF) { cb({ ok: false, error: "ffmpeg lookup failed: " +
                      eF.message }); return; }
    if (!install.ok) { cb({ ok: false, error: install.reason }); return; }

    var fs = null, path = null, os = null;
    try {
      fs = global.AEBridge.nodeRequire("fs");
      path = global.AEBridge.nodeRequire("path");
      os = global.AEBridge.nodeRequire("os");
    } catch (eN) {
      cb({ ok: false, error: "Node is unavailable in this panel: " +
           eN.message });
      return;
    }

    var exts = (kind === "gif") ? [".gif"] : [".mp4", ".mov"];
    var out = F.checkOutput(args.output, exts,
                            args.overwrite === true || args.overwrite === "true");
    if (out.err) { cb({ ok: false, error: out.err }); return; }

    var sink = args.progressSink || null;
    var wallStart = new Date().getTime();

    callHostTool("get_comp_details", { comp: args.comp }, function (det) {
      if (!det.ok) { cb(det); return; }
      var d = det.data;
      var compFps = Number(d.frameRate) || 0;
      var compDur = Number(d.duration) || 0;

      // --- how much of the comp, and at what rate ---------------------
      //
      // AE's render queue takes its span from the WORK AREA, which is
      // what the user sees when they press Ctrl+M — so that is the
      // default here too. What is NOT acceptable is it happening
      // silently, which is what render_comp alone does.
      var span = {};
      var explicitSpan = false;
      if (args.wholeComp === true || args.wholeComp === "true") {
        span.startTime = 0; span.durationSeconds = compDur;
        explicitSpan = true;
      }
      if (typeof args.startTime !== "undefined" && args.startTime !== null &&
          args.startTime !== "") {
        span.startTime = Number(args.startTime); explicitSpan = true;
      }
      if (typeof args.durationSeconds !== "undefined" &&
          args.durationSeconds !== null && args.durationSeconds !== "") {
        span.durationSeconds = Number(args.durationSeconds);
        explicitSpan = true;
      }

      var fps = Number(args.fps) || 0;
      if (fps > 0 && compFps > 0 && fps > compFps) {
        cb({ ok: false, error: "The comp runs at " + compFps + " fps, so " +
             "asking for " + fps + " fps cannot add motion that was never " +
             "rendered — ffmpeg would duplicate frames and the file would " +
             "just be bigger. Pick " + compFps + " or less." });
        return;
      }
      if (kind === "gif" && !fps) fps = Math.min(compFps || 12, 12);

      // A GIF at comp size is a GIF nobody can post. 480 wide is the
      // convention, and it is a DEFAULT rather than a cap — never an
      // upscale, because enlarging a master to make a smaller format is
      // only ever bytes.
      var wantW = args.width, wantH = args.height, wantSize = args.size;
      var gifDefault = false;
      if (kind === "gif" && !wantW && !wantH && !wantSize &&
          Number(d.width) > 480) {
        wantW = 480; gifDefault = true;
      }
      var sized = F.planSize({ w: d.width, h: d.height }, {
        size: wantSize, width: wantW, height: wantH,
        fit: args.fit, padColor: args.padColor
      });
      if (sized.err) { cb({ ok: false, error: sized.err }); return; }

      // The master only ever gets scaled DOWN, so AE can be asked to
      // render fewer pixels in the first place. Opt-in: the default is
      // still a full-resolution master.
      var mPlan = F.planMaster({ w: d.width, h: d.height }, sized,
                               args.masterResolution);
      if (mPlan.err) { cb({ ok: false, error: mPlan.err }); return; }

      // --- the intermediate, before it exists -------------------------
      var spanSecs = (typeof span.durationSeconds !== "undefined")
        ? span.durationSeconds : compDur;
      var srcFrames = Math.max(1, Math.round(spanSecs * (compFps || 1)));
      var estimate = F.estimateIntermediate(mPlan.width, mPlan.height,
                                            srcFrames);
      /*
       * The 8 GB cap was a GUESS for eleven versions, and the open
       * question under it was whether AE's AVI writer survives the
       * classic RIFF boundaries — 32-bit chunk offsets break at 2 GiB
       * and 4 GiB, and a writer that wraps there hands back a file a
       * reader accepts and truncates.
       *
       * Measured 2026-08-30 (scripts/riff-boundary-probe.js), and the
       * answer is that the FORMAT is not the risk at all. Real 1080p30
       * masters at 5.214 GiB (900 frames) and 7.995 GiB (1380 frames) —
       * the largest this cap allows — both rendered DONE, probed at the
       * full frame count, decoded end to end under `-xerror` with no
       * error, and their pictures at frames 343-347, 688-692 and the
       * last five were byte-identical (framemd5) to short reference
       * spans re-rendered across the same boundaries. Nothing wrapped
       * and nothing was dropped.
       *
       * So this stays a DISK-AND-TIME guard, not a format limit, and it
       * is safe to raise when the disk has room — which is what the
       * refusal now says, because a caller told "the limit is 8 GB" with
       * no reason will read it as "the file cannot be bigger" and shorten
       * an export it never needed to shorten. The default is unchanged:
       * 8 GiB is ~46 s of 1080p and 26 s of rendering here, and nobody
       * has asked for more.
       */
      var capGB = Number(args.maxIntermediateGB) || 8;
      var cap = capGB * 1024 * 1024 * 1024;
      if (estimate > cap) {
        cb({ ok: false, error: "The lossless master AE has to render " +
             "first would be about " + F.humanBytes(estimate) + " — " +
             mPlan.width + "x" + mPlan.height + " raw is " +
             F.humanBytes(mPlan.width * mPlan.height * 3) + " a frame " +
             "and this span is " + srcFrames + " frames. The limit is " +
             capGB + " GB, and it guards the DISK and the render time " +
             "rather than the file format (AE's lossless AVI and ffmpeg " +
             "were measured good to 7.99 GiB). Export a shorter span with " +
             "{durationSeconds}" +
             (mPlan.factor > 1 ? "" : ", render the master smaller with " +
              "{masterResolution: \"auto\"}") +
             ", or raise it with {maxIntermediateGB} if the disk has " +
             "room — that is safe." });
        return;
      }
      var free = F.freeBytes(os.tmpdir());
      if (free >= 0 && free < estimate * 1.1) {
        cb({ ok: false, error: "The lossless master would need about " +
             F.humanBytes(estimate) + " in " + os.tmpdir() + ", which has " +
             F.humanBytes(free) + " free. AE would fill the disk and " +
             "report a partial render. Free some space or export a " +
             "shorter span." });
        return;
      }

      // A fixed name would collide with the last run's leftovers, and
      // render_comp REFUSES an existing output rather than raise AE's
      // overwrite modal.
      var tmp = path.join(os.tmpdir(),
        "aell-export-" + new Date().getTime() + ".avi");

      if (sink) {
        sink("Rendering a lossless master (" + F.humanBytes(estimate) +
             ")…");
      }
      callHostTool("render_comp", {
        comp: args.comp, output: tmp.replace(/\\/g, "/"),
        template: "Lossless", overwrite: true,
        resolution: mPlan.name,
        startTime: span.startTime, durationSeconds: span.durationSeconds
      }, function (rendered) {
        if (!rendered.ok) { cb(rendered); return; }
        var master = String((rendered.data && rendered.data.output) || tmp);

        function cleanup() {
          if (args.keepMaster === true || args.keepMaster === "true") return;
          try { fs.unlinkSync(master); } catch (eU) {}
        }
        function fail(msg) {
          cleanup();
          cb({ ok: false, error: msg });
        }

        // FACT 2, applied to AE's own output: a render that reported DONE
        // is still just a file until something reads a picture out of it.
        F.inspect(install, master, function (eM, mInfo) {
          if (!mInfo.ok) {
            fail("AE reported " +
              ((rendered.data && rendered.data.status) || "DONE") +
              " but the master is not usable: " + mInfo.reason);
            return;
          }

          plan({
            F: F, install: install, args: args, comp: d, master: master,
            output: out.path, sized: sized, fps: fps, info: mInfo
          }, function (built) {
            if (built.err) { fail(built.err); return; }
            if (sink) sink("Encoding " + built.what + "…");
            F.run(install.ffmpeg, built.args, {}, function (eE, res) {
              if (eE) {
                var tail = String(res && res.stderr || "").split(/\r?\n/);
                tail = tail.slice(Math.max(0, tail.length - 3))
                  .join(" ").replace(/^\s+/, "");
                fail("ffmpeg failed: " + (tail || eE.message));
                return;
              }
              // FACT 1: ffmpeg's exit code is not evidence. This is.
              F.inspect(install, out.path, function (eO, oInfo) {
                cleanup();
                if (!oInfo.ok) { cb({ ok: false, error: oInfo.reason }); return; }
                var data = {
                  comp: d.name,
                  output: out.path,
                  bytes: oInfo.bytes,
                  size: F.humanBytes(oInfo.bytes),
                  dimensions: oInfo.width + "x" + oInfo.height,
                  frames: oInfo.frames,
                  codec: oInfo.codec,
                  seconds: Math.round(
                    (new Date().getTime() - wallStart) / 100) / 10,
                  timeSpan: (rendered.data && rendered.data.timeSpan) || "",
                  ffmpeg: install.source === "vendor"
                    ? "bundled" : "found on PATH"
                };
                if (fps > 0) data.fps = fps;
                if (built.extra) {
                  for (var k in built.extra) {
                    if (Object.prototype.hasOwnProperty.call(built.extra, k)) {
                      data[k] = built.extra[k];
                    }
                  }
                }
                var notes = [];
                if (sized.note) notes.push(sized.note);
                // Predicted vs written: a reduced master that came back
                // full size means AE ignored the request, and the only
                // way anyone finds out is if this says so.
                if (mPlan.factor > 1) {
                  notes.push(mPlan.note +
                    (mInfo.width && mInfo.width !== mPlan.width
                      ? " AE actually wrote " + mInfo.width + "x" +
                        mInfo.height + "."
                      : ""));
                }
                if (gifDefault) {
                  notes.push("Scaled to 480 px wide, the GIF default — " +
                    "the comp is " + d.width + " px. Pass {size} for " +
                    "another width.");
                }
                // THE work-area trap. AE renders the work area and says
                // nothing; the whole point of saying it here is that the
                // user asked for "the comp".
                if (!explicitSpan && compDur > 0 &&
                    mInfo.duration > 0 && mInfo.duration < compDur - 0.001) {
                  notes.push("Exported " +
                    (Math.round(mInfo.duration * 100) / 100) + "s of a " +
                    compDur + "s comp, because that is the comp's WORK " +
                    "AREA and it is what AE renders. Pass " +
                    "{wholeComp: true} for all of it.");
                }
                if (kind !== "gif" && args.audio !== false &&
                    !oInfo.hasAudio) {
                  notes.push("No audio: nothing in this part of the comp " +
                    "makes a sound.");
                }
                if (args.keepMaster === true || args.keepMaster === "true") {
                  data.master = master;
                }
                if (notes.length) data.notes = notes;
                cb({ ok: true, data: data });
              });
            });
          });
        });
      });
    });
  }

  PANEL_TOOLS.export_gif = function (args, cb) {
    ffmpegExport("gif", args, cb, function (ctx, done) {
      var built = ctx.F.buildGifArgs(ctx.master, ctx.output, {
        filter: ctx.sized.filter, fps: ctx.fps, colors: ctx.args.colors,
        dither: ctx.args.dither, loop: ctx.args.loop
      });
      if (built.err) { done({ err: built.err }); return; }
      done({ args: built.args,
             what: "a " + ctx.sized.width + "x" + ctx.sized.height +
                   " GIF at " + ctx.fps + " fps",
             extra: { loops: (ctx.args.loop === false ||
                              ctx.args.loop === "once") ? "once" : "forever" } });
    });
  };

  PANEL_TOOLS.export_social = function (args, cb) {
    ffmpegExport("social", args, cb, function (ctx, done) {
      // FACT 8: the encoder census is compile-time. Hardware encoders are
      // an opt-in that gets TRIED, never a name taken on trust.
      var candidates = ["libopenh264"];
      if (ctx.args.encoder) {
        candidates = [String(ctx.args.encoder)];
      } else if (ctx.args.hardware === true || ctx.args.hardware === "true") {
        candidates = ["h264_nvenc", "h264_mf", "libopenh264"];
      }
      // The trial frame is the size the export will be: h264_nvenc
      // refuses anything under about 145x49, so a fixed small one
      // answers about the wrong picture.
      var dims = { w: ctx.sized.width, h: ctx.sized.height };
      ctx.F.pickEncoder(ctx.install, candidates, dims, function (picked) {
        if (!picked.ok) { done({ err: picked.reason }); return; }
        var fps = ctx.fps || Number(ctx.comp.frameRate) || 30;
        var built = ctx.F.buildSocialArgs(ctx.master, ctx.output, {
          filter: ctx.sized.filter, fps: ctx.args.fps ? ctx.fps : 0,
          width: ctx.sized.width, height: ctx.sized.height,
          quality: ctx.args.quality, encoder: picked.name,
          audio: ctx.args.audio === false ? false : ctx.info.hasAudio,
          audioKbps: ctx.args.audioKbps
        });
        if (built.err) { done({ err: built.err }); return; }
        done({ args: built.args,
               what: "a " + ctx.sized.width + "x" + ctx.sized.height +
                     " H.264 file at " + Math.round(built.kbps / 100) / 10 +
                     " Mbps",
               extra: { encoder: picked.name, videoBitrate: built.kbps + " kbps" } });
      });
    });
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
      if (tool === "export_mogrt" && obj.ok && obj.data && obj.data.path) {
        verifyMogrtResult(obj.data);
      }
      cb(obj);
    });
  }

  /**
   * The export_mogrt receipt, checked against the FILE. The host side
   * proves bytes appeared; it never opens them, and a truncated zip or a
   * definition.json missing a controller was full success until this
   * (docs/SELF-VERIFY-PLANS.md section 1). MogrtRead parses the zip on
   * the panel's Node side in definitionOnly mode — headers for every
   * entry, inflate for definition.json alone, under a byte cap — so a
   * media-heavy capsule never freezes the CEP thread. Verdicts land on
   * the receipt: zipValid (true / false / null = unjudged),
   * controllersInFileCount, templateNameInFile, and a grounded
   * verifyNote when anything disagrees (expected vs measured, with the
   * path). Never throws — a verifier that fails is reported as a
   * verifier that failed, not as a bad export.
   */
  function verifyMogrtResult(data) {
    var MR = global.MogrtRead;
    if (!MR || typeof MR.verifyExport !== "function") return data;
    try {
      // The host roster can carry "(unreadable)" placeholders (AE threw
      // on a name read) and is capped at 500 names. Either makes name
      // parity a guaranteed false mismatch, so those cases fall back to
      // COUNT parity and the note says so — a receipt must never assert
      // a dropped controller it cannot have measured.
      var names = data.controllerNames instanceof Array
        ? data.controllerNames : null;
      var countOnly = null;
      if (names) {
        var clean = [], dropped = 0, i;
        for (i = 0; i < names.length; i++) {
          if (names[i] === "(unreadable)") dropped++;
          else clean.push(names[i]);
        }
        if (dropped > 0) {
          countOnly = dropped + " controller name(s) were unreadable " +
            "from AE, so parity is by COUNT only";
        } else if (typeof data.controllers === "number" &&
                   names.length < data.controllers) {
          countOnly = "the roster was capped at " + names.length +
            " of " + data.controllers + " names, so parity is by " +
            "COUNT only";
        }
        names = countOnly ? null : clean;
      }
      var v = MR.verifyExport({
        path: data.path,
        expectedControllers: names,
        templateName: data.template,
        // The comp name is the one name a real definition.json actually
        // carries (measured AE 2026: capsuleName is always "Untitled").
        compName: data.comp,
        definitionOnly: true,
        maxInflate: 4 * 1024 * 1024
      });
      if (v.readable === false) {
        // Could not even open/read the file (locked, too large for a
        // single read, gone): the export is UNJUDGED, not invalid.
        data.zipValid = null;
        data.verifyNote = "The verifier could not read the file back" +
          (v.errors && v.errors.length ? " (" + v.errors[0] + ")" : "") +
          " — the export itself is unjudged, not failed.";
        return data;
      }
      data.zipValid = v.zipValid === true;
      var inFile = v.controllersInFile instanceof Array
        ? v.controllersInFile.length : null;
      data.controllersInFileCount = inFile;
      if (typeof v.templateNameInFile === "string") {
        data.templateNameInFile = v.templateNameInFile;
      }
      var notes = [];
      if (v.errors instanceof Array) notes = notes.concat(v.errors);
      // Roster verdicts are FACTS only when the reader found the roster
      // under a known definition.json key; a provisional read (fallback
      // scan, nested groups) reports as evidence, never as a defect.
      var provisional = v.rosterProvisional === true;
      var rosterPrefix = provisional
        ? "provisional roster read (via " + (v.rosterVia || "fallback") +
          ", field names unpinned): " : "";
      if (countOnly) {
        if (inFile !== null && typeof data.controllers === "number" &&
            inFile !== data.controllers) {
          notes.push(rosterPrefix + countOnly + " — " + data.controllers +
                     " exposed, " + inFile + " in definition.json");
        } else {
          notes.push(countOnly);
        }
      } else {
        if (v.missing instanceof Array && v.missing.length) {
          notes.push(rosterPrefix + "controllers exposed but absent " +
                     "from definition.json: " + v.missing.join(", "));
        }
        if (v.extra instanceof Array && v.extra.length) {
          notes.push(rosterPrefix + "controllers in definition.json " +
                     "nobody exposed: " + v.extra.join(", "));
        }
      }
      if (v.warnings instanceof Array) notes = notes.concat(v.warnings);
      if (notes.length) data.verifyNote = notes.join(" | ");
    } catch (e) {
      data.zipValid = null;
      data.verifyNote = "The verifier could not read the file back (" +
        (e && e.message ? e.message : String(e)) + ") — the export " +
        "itself is unjudged, not failed.";
    }
    return data;
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

  // ------------------------------------------------- tool-result budget
  //
  // Every tool result the model reads passes through here. The rule is
  // the one budgetState already follows, for the same reason and paid for
  // by the same kind of field measurement: NOTHING IS BYTE-SLICED.
  //
  // Measured in AE 2026 on a 200-layer comp (WORKPLAN item 4): eleven of
  // the tools the model leans on hardest serialize past the old 1200-byte
  // per-result cap — grid_layout 7258, get_comp_details 7305 (already
  // row-capped at 40 by the host), stagger_layers 7262, distribute_property
  // 6529, list_properties 5648, scale_comp 3577, list_effects 3514,
  // get_project_info 3207, set_layer_parent 1589, audit_comp_usage 1442,
  // rename_comps 1339 — and `slice(0, 1200)` handed every one of them to
  // the model as JSON cut mid-object, with no count of what went missing.
  //
  // Two things changed:
  //  1. Oversized results are shrunk STRUCTURALLY — whole rows off the
  //     END of their longest array (lists here are ordered, so the head
  //     is the informative part), each shrunk array reporting "12 of 200"
  //     in a `truncated` field. The output is always parseable JSON.
  //  2. The per-result cap is a FAIR SHARE of the round's budget, not a
  //     fixed 1200. A round whose other results are 90-byte
  //     acknowledgements lets the one get_comp_details use nearly the
  //     whole 6000 — under the old fixed cap it got 1200 bytes, which is
  //     six layer rows out of the forty the host went to the trouble of
  //     selecting.

  var RESULTS_BUDGET = 6000;
  var RESULT_FLOOR = 120;      // enough for the shell + the note

  function jsonLen(v) {
    try { return JSON.stringify(v).length; } catch (e) { return 0; }
  }

  /** Every array worth dropping rows from, result-object first. */
  function shrinkableArrays(obj, depth, out) {
    if (!obj || typeof obj !== "object" || depth > 3) return out;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v && typeof v === "object") {
        if (Object.prototype.toString.call(v) === "[object Array]") {
          if (v.length) out.push({ owner: obj, key: k, arr: v, full: v.length });
        } else {
          shrinkableArrays(v, depth + 1, out);
        }
      }
    }
    return out;
  }

  /** The longest string value in the result, for the no-arrays case. */
  function longestString(obj, depth, best) {
    if (!obj || typeof obj !== "object" || depth > 3) return best;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (typeof v === "string") {
        if (!best || v.length > best.len) best = { owner: obj, key: k, len: v.length };
      } else if (v && typeof v === "object") {
        best = longestString(v, depth + 1, best);
      }
    }
    return best;
  }

  /**
   * Shrink ONE result to `cap` bytes without ever cutting mid-object.
   * Returns the JSON string. Mutates a deep copy, never the caller's
   * object — the transcript the user sees keeps everything.
   */
  function fitResult(result, cap) {
    var s = jsonLen(result) ? JSON.stringify(result) : String(result);
    if (s.length <= cap) return s;

    var copy;
    try { copy = JSON.parse(s); } catch (e) {
      // Not JSON at all — a result that could not serialize, rendered by
      // String(). There is no row structure to shrink, and the head of
      // it would be exactly the cut fragment this block bans, handed to
      // a model that will try to parse it. Dropped WHOLE instead, with
      // its size. No ok:false — the TOOL may well have succeeded, and
      // an error shape here invites the model to re-run a mutation that
      // already landed; the outcome is unknown, and it must say so.
      return JSON.stringify({ truncated:
        s.length + "-byte result could not be relayed as JSON — the " +
        "outcome is unknown, NOT failed; verify state (get_comp_details" +
        " / get_property) before re-running anything that mutates." });
    }

    var arrays = shrinkableArrays(copy, 0, []);
    var touched = [];

    // The note has to be written BEFORE the size is checked, or it is the
    // thing that puts the result back over the cap — which is how the
    // first cut of this shrinker still produced unparseable JSON.
    function annotate() {
      var owners = [], t, q, idx;
      for (t = 0; t < touched.length; t++) {
        idx = -1;
        for (q = 0; q < owners.length; q++) {
          if (owners[q].owner === touched[t].owner) idx = q;
        }
        if (idx < 0) { owners.push({ owner: touched[t].owner, lines: [] });
                       idx = owners.length - 1; }
        owners[idx].lines.push(touched[t].key + ": " + touched[t].arr.length +
                               " of " + touched[t].full + " shown");
      }
      for (q = 0; q < owners.length; q++) {
        owners[q].owner.truncated = owners[q].lines.join("; ") +
          " (dropped to fit the model's context, NOT by the tool — " +
          "narrow the request or page for the rest)";
      }
    }

    while (JSON.stringify(copy).length > cap) {
      // Always take from whichever array is currently costing the most,
      // and take from its END: these lists are ordered, so the head is
      // the informative part.
      var big = null;
      for (var i = 0; i < arrays.length; i++) {
        if (!arrays[i].arr.length) continue;
        var w = jsonLen(arrays[i].arr);
        if (!big || w > big.w) big = { a: arrays[i], w: w };
      }
      if (!big) break;
      big.a.arr.pop();
      var seen = false;
      for (var u = 0; u < touched.length; u++) if (touched[u] === big.a) seen = true;
      if (!seen) touched.push(big.a);
      annotate();
    }
    var out = JSON.stringify(copy);
    if (out.length > cap) {
      // No arrays left to drop: shorten the longest STRING instead, which
      // still leaves valid JSON.
      var ls = longestString(copy, 0, null);
      if (ls) {
        var keep = Math.max(40, ls.len - (out.length - cap) - 20);
        ls.owner[ls.key] = String(ls.owner[ls.key]).slice(0, keep) + " …";
        out = JSON.stringify(copy);
      }
    }
    if (out.length > cap) {
      // Arrays emptied, the longest string shortened, and the result is
      // STILL over its share (several long strings, or a shell of many
      // scalar fields). The payload goes the way its rows went — dropped
      // whole, reported in the same `truncated` wording annotate writes.
      // ok survives when it is readable: losing the payload in transit
      // is not a tool failure, and the model must still see the outcome.
      var shell = {};
      if (copy && typeof copy.ok === "boolean") shell.ok = copy.ok;
      shell.truncated = s.length + "-byte result dropped whole to fit " +
        "the model's context, NOT by the tool — narrow the request and " +
        "call again";
      out = JSON.stringify(shell);
    }
    return out;
  }

  /**
   * Bound a whole round of tool results. Each result gets an equal share
   * of the budget; results that come in under their share donate what
   * they did not use to the ones that need it (repeated until nothing
   * more can be given away), so one big read is not punished for the
   * company it keeps.
   */
  function compactToolResults(results) {
    var n = results.length;
    if (!n) return "[]";
    var sizes = [], i;
    for (i = 0; i < n; i++) sizes.push(fitResult(results[i], Infinity).length);

    // The budget covers what is SENT, so the brackets and the ",\n"
    // between results come out of it before anyone gets a share.
    var pool = Math.max(n * 40, RESULTS_BUDGET - 2 - (n - 1) * 2);
    var caps = [], settled = [], unsettled = n;
    for (i = 0; i < n; i++) { caps.push(0); settled.push(false); }
    var moved = true;
    while (moved && unsettled > 0) {
      moved = false;
      var share = Math.floor(pool / unsettled);
      for (i = 0; i < n; i++) {
        if (settled[i] || sizes[i] > share) continue;
        caps[i] = sizes[i];
        settled[i] = true;
        pool -= sizes[i];
        unsettled--;
        moved = true;
      }
    }
    if (unsettled > 0) {
      var each = Math.floor(pool / unsettled);
      // A floor, but only while it still fits the round — the total is
      // the harder promise of the two.
      if (n * RESULT_FLOOR <= RESULTS_BUDGET) each = Math.max(RESULT_FLOOR, each);
      for (i = 0; i < n; i++) if (!settled[i]) caps[i] = each;
    }

    var parts = [];
    for (i = 0; i < n; i++) parts.push(fitResult(results[i], caps[i]));
    return "[" + parts.join(",\n") + "]";
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

  // MAX_COMMANDS_PER_ROUND is declared next to RESPONSE_SCHEMA — the
  // schema's maxItems and this executor enforce the same cap.

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
    // Commands past the cap are cut here, and the cut is REPORTED as one
    // more ERROR-shaped result row at the end of the round. A silent cut
    // hands a model that emitted 25 commands exactly 20 results — it
    // counts the round complete and never re-issues 21-25. The schema's
    // maxItems keeps a constrained-decoding model from ever getting
    // here; this row covers every caller that did not decode through it.
    var overflowRow = null;
    if (commands.length > MAX_COMMANDS_PER_ROUND) {
      var cut = commands.slice(MAX_COMMANDS_PER_ROUND);
      commands = commands.slice(0, MAX_COMMANDS_PER_ROUND);
      var cutNames = [];
      for (var cn = 0; cn < cut.length && cn < 10; cn++) {
        cutNames.push("#" + (MAX_COMMANDS_PER_ROUND + cn + 1) + " " +
                      (cut[cn] && typeof cut[cn].tool === "string"
                        ? cut[cn].tool : "(malformed)"));
      }
      if (cut.length > cutNames.length) {
        cutNames.push("+" + (cut.length - cutNames.length) + " more");
      }
      overflowRow = { ok: false, error:
        "Round capped at " + MAX_COMMANDS_PER_ROUND + " commands: the " +
        "last " + cut.length + " of your " +
        (MAX_COMMANDS_PER_ROUND + cut.length) + " were NOT run — " +
        cutNames.join(", ") + ". Re-issue them in your next reply, in " +
        "rounds of " + MAX_COMMANDS_PER_ROUND + " or fewer." };
    }
    // If a generation paused the chat model this round, warm it back up
    // BEFORE handing the results on — the very next thing the caller
    // does with them is ask the model for its reply.
    var doneInner = done;
    done = function (results) {
      if (overflowRow) results.push(overflowRow);
      VramArbiter.resumeIfPaused(global.Settings.get(), progressSink,
        function () { doneInner(results); });
    };
    var dryRun = !!opts.dryRun;
    // A dry run mutates nothing, so there is never anything to roll back.
    var rollbackArmed = !!opts.allowRollback && !dryRun;
    var results = [];

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
   *    the last four — the current exchange must survive;
   *  - after dropping, keep dropping until the first entry is a USER
   *    turn: chat templates expect user-first after the system message,
   *    and an orphaned assistant turn reads as the model talking to
   *    itself;
   *  - and then, if the protected tail ALONE is still over budget,
   *    shorten its entries' CONTENT until it is not. See below.
   */
  function fitHistory(history, budgetChars) {
    var size = 0, i;
    for (i = 0; i < history.length; i++) {
      size += (history[i].content || "").length + 16;
    }
    if (size <= budgetChars) {
      return { entries: history, dropped: 0, truncated: 0, ledger: "" };
    }
    var entries = history.slice();
    var gone = [];
    while (entries.length > 4 && size > budgetChars) {
      size -= (entries[0].content || "").length + 16;
      gone.push(entries.shift());
    }
    while (entries.length > 1 && entries[0].role !== "user") {
      size -= (entries[0].content || "").length + 16;
      gone.push(entries.shift());
    }
    // THE FLOOR, and why it has to exist. Dropping WHOLE entries stops
    // at the protected tail, so ONE oversized entry inside it — a
    // comfy_generate result, a pasted expression, a long TOOL RESULTS
    // array — left this function returning a payload it had already
    // computed was too big. main.js answers a context HTTP 400 by
    // calling back with budget 1; with nothing left to drop that
    // returned the SAME BYTES, so the retry earned the SAME 400 and the
    // chat was dead until cleared. That is the exact failure fitHistory
    // was written to end, arriving through the one door it left open.
    //
    // Measured on this machine 2026-09-02 (scripts/history-floor-probe.js,
    // real llama-server, Qwen2.5-32B, ctx 16384): a four-entry tail of
    // 60334 chars was refused, and the retry re-sent all 60334 of them.
    //
    // So shorten the survivors' CONTENT: oldest of the tail first, the
    // newest entry last, because that one carries the sentence being
    // answered. Every cut says so IN WORDS — this is the one place in
    // the panel that may hand the model a JSON result cut mid-object,
    // and a silent one is indistinguishable from a tool that returned
    // half an answer.
    var truncated = 0;
    for (i = 0; i < entries.length && size > budgetChars; i++) {
      var content = entries[i].content || "";
      // The marker carries the number of characters it replaced, so its
      // own length depends on the answer. Solve it twice: the first pass
      // prices the marker at the widest the number can be, the second is
      // exact. Getting this wrong is not cosmetic — an under-priced
      // marker leaves the entry over budget, the loop walks on to the
      // next one, and it eats the newest turn it was supposed to spare.
      var marker = trimMarker(content.length);
      var keep = 0, j;
      for (j = 0; j < 2; j++) {
        keep = content.length - (size - budgetChars) - marker.length;
        if (keep < TRIM_MIN_KEEP_CHARS) keep = TRIM_MIN_KEEP_CHARS;
        marker = trimMarker(content.length - keep);
      }
      // An entry shorter than the marker gets BIGGER if we "shorten" it.
      // Leave it whole and spend the budget on one that pays.
      if (keep + marker.length >= content.length) continue;
      entries[i] = {
        role: entries[i].role,
        content: content.slice(0, keep) + marker
      };
      size -= content.length - entries[i].content.length;
      truncated++;
    }
    return { entries: entries, dropped: gone.length, truncated: truncated,
             ledger: rollupHistory(gone, LEDGER_BUDGET) };
  }

  function trimMarker(cut) {
    return "\n[... " + cut + " characters cut from this message to fit " +
      "the model's context window - it is INCOMPLETE, do not read the " +
      "end of it as the end of the data]";
  }

  // The smallest remnant worth leaving — below this an entry says
  // nothing anyway and the marker is most of what is left.
  var TRIM_MIN_KEEP_CHARS = 200;

  // ------------------------------------------------- the history ledger
  //
  // What the model keeps of a turn that no longer fits: one line of
  // FUNCTION, built by the panel with no model call. A user turn keeps
  // its first clause; an assistant turn keeps the tools it ran and the
  // names they touched; a TOOL RESULTS turn keeps the counts and the
  // names the receipts created. The prose is gone — the fact that
  // "Title" exists, was moved, and got a Glow is not. Measured before
  // this existed: main.js's floor left most rounds ONE turn of memory,
  // and "make them blue instead" had nothing to refer back to.
  var NAMING_KEYS = ["layer", "layers", "comp", "name", "property", "item",
    "items", "folder", "effect", "mask", "preset", "workflow", "file",
    "output", "template"];
  var RECEIPT_KEYS = ["name", "comp", "layer", "created", "renamed",
    "removed", "precomp", "template", "path"];

  function clipText(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ")
      .replace(/^\s+|\s+$/g, "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function shortValue(v, n) {
    if (v instanceof Array) {
      var out = [];
      for (var i = 0; i < v.length && i < 4; i++) {
        out.push(shortValue(v[i], 24));
      }
      if (v.length > 4) out.push("+" + (v.length - 4));
      return clipText(out.join(","), n);
    }
    if (v && typeof v === "object") {
      return clipText(v.name || v.layer || v.comp || "", n);
    }
    if (typeof v === "string") {
      // A path collapses to its basename — the folder is not memory.
      var base = v.replace(/[\\\/]+$/, "").split(/[\\\/]/).pop();
      return clipText(base, n);
    }
    return clipText(String(v), n);
  }

  function summarizeEntry(e) {
    var role = e && e.role, c = String((e && e.content) || "");
    var i;
    if (role === "user") {
      if (c.indexOf("TOOL RESULTS:") === 0) {
        var arr = null;
        try { arr = JSON.parse(c.slice(c.indexOf("\n") + 1)); }
        catch (e1) {}
        if (!(arr instanceof Array)) return "results: (unreadable)";
        var ok = 0, bad = 0, names = [], firstErr = "";
        for (i = 0; i < arr.length; i++) {
          var r = arr[i];
          if (r && r.ok === false) {
            bad++;
            if (!firstErr && r.error) firstErr = clipText(r.error, 70);
          } else { ok++; }
          var d = r && r.data;
          if (d && typeof d === "object") {
            for (var k = 0; k < RECEIPT_KEYS.length; k++) {
              var val = d[RECEIPT_KEYS[k]];
              if (val === undefined || val === null || val === "") continue;
              var sv = shortValue(val, 30);
              if (sv && names.length < 6) names.push(sv);
              break;
            }
          }
        }
        return "results: " + ok + " ok" +
          (bad ? ", " + bad + " error (" + firstErr + ")" : "") +
          (names.length ? "; " + clipText(names.join(", "), 90) : "");
      }
      if (c.indexOf("SYSTEM:") === 0) return "";   // a control message
      return "user: " + clipText(c, 120);
    }
    if (role === "assistant") {
      var obj = null;
      try { obj = JSON.parse(c); } catch (e2) {}
      if (!obj || typeof obj !== "object") {
        return "assistant: " + clipText(c, 80);
      }
      var cmds = obj.commands instanceof Array ? obj.commands : [];
      var parts = [];
      for (i = 0; i < cmds.length; i++) {
        var cm = cmds[i];
        if (!cm || !cm.tool) continue;
        var a = cm.args || {}, tag = "";
        for (var n = 0; n < NAMING_KEYS.length; n++) {
          if (a[NAMING_KEYS[n]] !== undefined && a[NAMING_KEYS[n]] !== "") {
            tag = shortValue(a[NAMING_KEYS[n]], 24);
            break;
          }
        }
        parts.push(cm.tool + (tag ? " " + tag : ""));
        if (parts.length >= 6 && cmds.length > 6) {
          parts.push("+" + (cmds.length - 6) + " more");
          break;
        }
      }
      var reply = typeof obj.reply === "string" ? clipText(obj.reply, 60) : "";
      return "did: " + (parts.length ? parts.join(", ") : "(no commands)") +
        (reply ? " — \"" + reply + "\"" : "");
    }
    return "";
  }

  /**
   * The ledger block for dropped entries, oldest first, under its own
   * byte budget: when even the one-liners overflow, the OLDEST lines
   * fold away and the header counts them — the model always sees the
   * most recent memory and is told what it is missing.
   */
  function rollupHistory(dropped, budgetChars) {
    var lines = [], i;
    for (i = 0; i < (dropped || []).length; i++) {
      var s = summarizeEntry(dropped[i]);
      if (s) lines.push(s);
    }
    if (!lines.length) return "";
    var budget = Number(budgetChars) || LEDGER_BUDGET;
    var folded = 0;
    function header() {
      return "EARLIER IN THIS SESSION (oldest first" +
        (folded ? "; " + folded + " older line(s) folded away" : "") +
        "; the user's transcript is complete — if they refer to " +
        "something not here, ask):";
    }
    function total() {
      // The exact size of the block as joined below: header, then
      // "\n- " + line for every line.
      var t = header().length;
      for (var j = 0; j < lines.length; j++) t += lines[j].length + 3;
      return t;
    }
    while (lines.length > 1 && total() > budget) {
      lines.shift();
      folded++;
    }
    var out = [header()];
    for (i = 0; i < lines.length; i++) out.push("- " + lines[i]);
    return out.join("\n");
  }

  global.Tools = {
    TOOL_DEFS: TOOL_DEFS,
    fitHistory: fitHistory,
    historyBudget: historyBudget,
    promptModeFor: promptModeFor,
    rollupHistory: rollupHistory,
    _summarizeEntry: summarizeEntry,  // exposed for tests
    _compactDesc: compactDesc,        // exposed for tests
    planEnhancement: planEnhancement,
    RESPONSE_SCHEMA: RESPONSE_SCHEMA,
    buildSystemPrompt: buildSystemPrompt,
    fetchProjectState: fetchProjectState,
    compactToolResults: compactToolResults,
    callHostTool: callHostTool,
    callHostBatch: callHostBatch,
    executeCommands: executeCommands,
    setGpuInfo: setGpuInfo,
    setProgressSink: function (fn) { progressSink = fn; },
    catalogModelStatus: catalogModelStatus,
    removeCatalogWeights: removeCatalogWeights,
    workflowRows: workflowRows,       // Settings > ComfyUI > Workflows
    _verifyMogrtResult: verifyMogrtResult, // exposed for tests
    _vramArbiter: VramArbiter,        // exposed for tests and probes
    _genNeedMBFor: genNeedMBFor,      // exposed for tests
    _comfyModelRoots: comfyModelRoots, // exposed for tests
    _preflightRefusalFor: preflightRefusalFor,    // exposed for tests
    _describeMissingWeights: describeMissingWeights, // exposed for tests
    _describeBadValues: describeBadValues,        // exposed for tests
    _parseComfyPathsYaml: parseComfyPathsYaml,   // exposed for tests
    _generatingLine: generatingLine,  // exposed for tests
    _panelTools: PANEL_TOOLS          // exposed for tests
  };

})(window);
