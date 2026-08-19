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
      args: "{name: string, parent?: folder name, id, or path 'A/B'}" },
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
      args: "{comp?: string, text: string, fontSize?: px, fillColor?: [r,g,b] 0..1, position?: [x,y], font?: string (PostScript name), tracking?: number, leading?: px, justification?: 'left'|'center'|'right'}" },
    { name: "set_text_style", mutating: true,
      desc: "Restyle an existing text layer (any subset of fields).",
      args: "{comp?: string, layer: name|index, text?: string, fontSize?: px, font?: string, fillColor?: [r,g,b] 0..1, tracking?: number, leading?: px, justification?: 'left'|'center'|'right'}" },
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
            "layer does not jump). ALWAYS use this instead of guessing " +
            "anchor coordinates.",
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
    { name: "grid_layout", mutating: true,
      desc: "Arrange layers into a grid rigged to a control null: the " +
            "grid centers on the null's position and its 'Grid X Spacing'/" +
            "'Grid Y Spacing' sliders drive spacing live (all expressions " +
            "generated host-side). Omit 'layers' to use the layers the " +
            "user has selected in AE. Re-running re-flows into the same rig.",
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
    { name: "delete_layer", mutating: true,
      desc: "Delete a layer from a comp.",
      args: "{comp?: string, layer: name|index}" },
    { name: "set_comp_setting", mutating: true,
      desc: "Change a comp setting.",
      args: "{comp?: string, duration?: s, frameRate?: number, width?: int, height?: int, bgColor?: [r,g,b] 0..1}" },
    { name: "import_file", mutating: true,
      desc: "Import a footage/image/video file into the project.",
      args: "{path: string (absolute)}" },
    { name: "add_shape_layer", mutating: true,
      desc: "Add a shape layer (rectangle, ellipse, polygon, or star).",
      args: "{comp?: string, name?: string, shape?: 'rectangle'|'ellipse'|'polygon'|'star', size?: [w,h], position?: [x,y], fillColor?: [r,g,b] 0..1, strokeColor?: [r,g,b], strokeWidth?: px, roundness?: px (rectangle), points?: int (polygon/star)}" },
    { name: "add_mask", mutating: true,
      desc: "Add a mask to a layer. Coordinates are in LAYER space.",
      args: "{comp?: string, layer: name|index, shape?: 'rectangle'|'ellipse'|'custom', bounds?: [x,y,w,h], vertices?: [[x,y],...] (custom), mode?: 'add'|'subtract'|'intersect'|..., inverted?: bool, feather?: px, name?: string}" },
    { name: "precompose", mutating: true,
      desc: "Move layers into a new nested comp (precompose).",
      args: "{comp?: string, layers: [name|index, ...], name: string, moveAttributes?: bool = true}" },
    { name: "add_camera", mutating: true,
      desc: "Add a camera. Only 3D layers (set_layer_3d) are affected by it.",
      args: "{comp?: string, name?: string, position?: [x,y,z], pointOfInterest?: [x,y,z], zoom?: px}" },
    { name: "add_marker", mutating: true,
      desc: "Add a marker to the comp (omit 'layer') or to a layer.",
      args: "{comp?: string, layer?: name|index, time: seconds, comment?: string, duration?: seconds}" },
    { name: "set_layer_3d", mutating: true,
      desc: "Enable/disable a layer's 3D switch.",
      args: "{comp?: string, layer: name|index, enabled: bool}" },
    { name: "set_layer_parent", mutating: true,
      desc: "Parent a layer to another (null/omit parent to unparent).",
      args: "{comp?: string, layer: name|index, parent?: name|index|null}" },
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
            "the AE project. Blocks until finished (may take minutes).",
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
      "  the comp details. 'these layers' / 'the selected layers' means",
      "  those. grid_layout uses the selection automatically when 'layers'",
      "  is omitted.",
      "",
      "Project panel management:",
      "- create_folder / move_to_folder / rename_item / delete_item /",
      "  duplicate_comp / organize_project manage the project panel. Items",
      "  are referenced by name or id; folders also by PATH like",
      "  '_COMPS/Promo' (get_project_info shows each item's parent folder",
      "  and each folder's path). Same-named folders under different",
      "  parents are normal — always use paths when names repeat.",
      "- Batch requests ('an _ARCHIVE folder inside every folder in",
      "  _COMPS'): call get_project_info, find the folders whose folder ==",
      "  '_COMPS', then emit one create_folder per target — e.g.",
      '  {name: "_ARCHIVE", parent: "_COMPS/Promo"} — all in ONE commands',
      "  array.",
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
      "  names). Check comfy_status first; pick a template via",
      "  comfy_list_workflows. Match width/height to the target comp when",
      "  it makes sense. Generation can take minutes — do not repeat a",
      "  request that already succeeded.",
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
        if (err) { cb({ ok: false, error: err.message }); return; }
        if (args["import"] === false) {
          cb({ ok: true, data: { files: result.files,
                                 applied: result.applied } });
          return;
        }
        // Import each rendered file into the AE project.
        var imported = [];
        (function next(i) {
          if (i >= result.files.length) {
            cb({ ok: true, data: { files: result.files, imported: imported,
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
