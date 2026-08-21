/*
 * tools.js — the allowlisted bridge between the model and After Effects.
 *
 * The model never emits raw ExtendScript. It emits JSON commands
 * ({tool, args}) chosen from TOOL_DEFS; executeCommands() forwards each to
 * AELL_call() in jsx/hostscript.jsx, which implements the tools with undo
 * groups. Anything not in this list is rejected panel-side.
 */
(function (global) {
  "use strict";

  // Keep names/args in sync with the dispatch table in jsx/hostscript.jsx.
  var TOOL_DEFS = [
    { name: "get_project_info", mutating: false,
      desc: "List project items (comps/footage/folders) and the active comp.",
      args: "{}" },
    { name: "get_comp_details", mutating: false,
      desc: "Layers of a comp with index, name, type, timing, effects.",
      args: "{comp?: string}  // omit for the active comp" },
    { name: "create_folder", mutating: true,
      desc: "Create a project-panel folder. Same name in different parents " +
            "is fine; existence is checked per-parent.",
      args: "{name: string, parent?: folder name, id, path, or 'root' (default: root)}" },
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
      desc: "Add a text layer to a comp.",
      args: "{comp?: string, text: string, fontSize?: px, fillColor?: [r,g,b] 0..1, position?: [x,y], font?: string (PostScript name), tracking?: number, leading?: px|'auto', justification?: 'left'|'center'|'right'}" },
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
      desc: "Distribute layer START TIMES along a cubic-bezier easing " +
            "curve: layer i (of n) starts at startAt + bezierY(i/(n-1)) * " +
            "spread. Uses the user's selected layers when 'layers' omitted. " +
            "Omit spread/startAt to fill the comp's WORK AREA; omit bezier " +
            "for linear (ease-out = [0,0,0.58,1], ease-in = [0.42,0,1,1]).",
      args: "{comp?: string, layers?: [name|index], bezier?: [x1,y1,x2,y2] (default linear), spread?: seconds (default: work area), startAt?: s, order?: 'in'|'stack'|'reverse'|'ascending'|'descending'}" },
    { name: "distribute_property", mutating: true,
      desc: "Distribute a property VALUE across layers. Curve mode: layer " +
            "i gets from + bezierY(i/(n-1)) * (to-from). Equidistant " +
            "mode: pass step and layer i gets from + i*step (from " +
            "defaults to the first layer's current value; step is " +
            "center-to-center, so 100px shapes with a 20px gap = step " +
            "120). Use step for 'space them every X px / equidistant'.",
      args: "{comp?: string, layers?: [name|index], property: 'opacity'|'rotation'|'scale'|'position_x'|'position_y', from?: number, to?: number, step?: number (equidistant), bezier?: [x1,y1,x2,y2], order?: 'in'|'stack'|'reverse'}" },
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
            "comp. Use for 'change/sort the layer order'.",
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
            "gets its zoom rescaled — zoom is not inherited). Keyframed " +
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
            "[[x,y],…]; curves via inTangents/outTangents (offsets from " +
            "each vertex). atTime keyframes one shape; keys animates " +
            "several in one call.",
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
    { name: "add_marker", mutating: true,
      desc: "Add a marker to the comp (omit 'layer') or to a layer.",
      args: "{comp?: string, layer?: name|index, time: seconds, comment?: string, duration?: seconds}" },
    { name: "set_layer_3d", mutating: true,
      desc: "Enable/disable a layer's 3D switch.",
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
      desc: "Read ANY property by path: value, keyframes, expression.",
      args: "{comp?: string, layer?: name|index, property: friendly name | 'effect.X.Y' | 'group/child/…' path}" },
    { name: "set_property", mutating: true,
      desc: "Set ANY property by path — the universal fallback when no " +
            "dedicated tool fits. atTime creates a keyframe at that time.",
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
      desc: "Run ANY layer tool once per target layer in ONE call (max " +
            "200 layers) — the batch executor for anything without its " +
            "own layers arg: {tool: 'apply_effect', args: {effect: " +
            "'Gaussian Blur'}} blurs every target. Reports succeeded " +
            "count + failures.",
      args: "{comp?: string, layers?: [name|index] (omit = selection, else the comp's only layer), tool: string, args: {…the tool's args, minus comp/layer…}}" },
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
      args: "{workflow: string (name from comfy_list_workflows), prompt: string, negative?: string, width?: int, height?: int, seed?: int, frames?: int (video workflows), import?: bool = true}" }
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
      "- 'animate the mask / wipe it on' = set_mask_path {keys: […]} or",
      "  add trim_paths and keyframe its End — never hand-write",
      "  expressions for plain keyframe animation.",
      "- Curve requests: 'stagger with an ease' = stagger_layers;",
      "  'ramp opacity/scale across these layers' = distribute_property;",
      "  'ease between the keyframes' = apply_keyframe_ease. All take the",
      "  same CSS-style bezier [x1,y1,x2,y2].",
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
      "- Batch requests ('a subfolder inside every folder within X'):",
      "  inspect, filter folders whose parent is X, then emit one",
      "  create_folder per real path, all in ONE commands array.",
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

      // Generation models and the chat LLM fight over VRAM — optionally
      // stop llama-server for the render and restart it before replying
      // (the next chat round needs it back). Transparent to the model.
      var pausedForVram = false;
      function resumeLlm(done) {
        if (!pausedForVram) { done(); return; }
        pausedForVram = false;
        if (progressSink) progressSink("Restarting the chat model…");
        global.Llama.start({
          serverPath: s.serverPath,
          modelPath: s.modelPath,
          port: s.port,
          ctxSize: s.ctxSize,
          gpuLayers: s.gpuLayers
        }, function () { done(); });
      }
      function finish(result) {
        resumeLlm(function () { cb(result); });
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
        params: {
          prompt: args.prompt,
          negative: args.negative,
          width: args.width,
          height: args.height,
          seed: args.seed,
          frames: args.frames
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
      if (s.comfyPauseLlm !== false &&
          global.Llama.getState() === "running") {
        pausedForVram = true;
        if (progressSink) {
          progressSink("Pausing the chat model to free VRAM for " +
                       "generation…");
        }
        global.Llama.stop();
        // Give the old process a beat to release its VRAM.
        global.setTimeout(begin, 1500);
      } else {
        begin();
      }
    }
  };

  /** Call one host tool. cb(resultObject) — never throws. */
  function callHostTool(tool, args, cb) {
    if (!isKnownTool(tool)) {
      cb({ ok: false, error: "Unknown tool: " + tool });
      return;
    }
    var argsLiteral = JSON.stringify(JSON.stringify(args || {}));
    // U+2028/U+2029 are legal raw inside modern JSON.stringify output but
    // are line terminators to ExtendScript (ES3) — they'd kill the eval.
    argsLiteral = argsLiteral
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
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

  var MAX_COMMANDS_PER_ROUND = 20;

  /**
   * Execute a command list sequentially.
   * onEach(index, command, result) fires per command; done(results) at end.
   * opts: {dryRun?: bool, shouldStop?: fn -> bool (checked between commands)}
   */
  function executeCommands(commands, opts, onEach, done) {
    opts = opts || {};
    var dryRun = !!opts.dryRun;
    var results = [];
    if (commands.length > MAX_COMMANDS_PER_ROUND) {
      commands = commands.slice(0, MAX_COMMANDS_PER_ROUND);
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

  global.Tools = {
    TOOL_DEFS: TOOL_DEFS,
    RESPONSE_SCHEMA: RESPONSE_SCHEMA,
    buildSystemPrompt: buildSystemPrompt,
    callHostTool: callHostTool,
    executeCommands: executeCommands,
    setProgressSink: function (fn) { progressSink = fn; }
  };

})(window);
