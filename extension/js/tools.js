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
    { name: "create_comp", mutating: true,
      desc: "Create a composition and open it.",
      args: "{name: string, width: int, height: int, duration: seconds, frameRate: number, bgColor?: [r,g,b] 0..1}" },
    { name: "add_text_layer", mutating: true,
      desc: "Add a text layer to a comp.",
      args: "{comp?: string, text: string, fontSize?: px, fillColor?: [r,g,b] 0..1, position?: [x,y], font?: string (PostScript name)}" },
    { name: "add_solid", mutating: true,
      desc: "Add a solid layer.",
      args: "{comp?: string, name: string, color: [r,g,b] 0..1, width?: int, height?: int}" },
    { name: "set_transform", mutating: true,
      desc: "Set a transform property on a layer.",
      args: "{comp?: string, layer: name|index, property: 'position'|'scale'|'rotation'|'opacity'|'anchorPoint', value: number|[..]}" },
    { name: "add_keyframe", mutating: true,
      desc: "Add a keyframe on a layer property at a time (seconds).",
      args: "{comp?: string, layer: name|index, property: transform name or 'effect.<EffectName>.<ParamName>', time: seconds, value: number|[..]}" },
    { name: "set_expression", mutating: true,
      desc: "Set (or clear with '') an expression on a layer property.",
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
    { name: "add_to_render_queue", mutating: true,
      desc: "Add a comp to the render queue.",
      args: "{comp?: string, outputPath?: string (absolute)}" }
  ];

  var TOOL_NAMES = [];
  for (var i = 0; i < TOOL_DEFS.length; i++) TOOL_NAMES.push(TOOL_DEFS[i].name);

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
      "- 'layer' accepts a layer name or a 1-based index from the top.",
      "- Omit 'comp' to target the active comp.",
      "- Prefer inspecting (get_project_info / get_comp_details) before",
      "  modifying things you have not seen.",
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

  /** Call one host tool. cb(resultObject) — never throws. */
  function callHostTool(tool, args, cb) {
    if (!isKnownTool(tool)) {
      cb({ ok: false, error: "Unknown tool: " + tool });
      return;
    }
    var argsLiteral = JSON.stringify(JSON.stringify(args || {}));
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

  /**
   * Execute a command list sequentially.
   * onEach(index, command, result) fires per command; done(results) at end.
   * dryRun: report what would run without touching AE.
   */
  function executeCommands(commands, dryRun, onEach, done) {
    var results = [];
    function step(i) {
      if (i >= commands.length) { done(results); return; }
      var cmd = commands[i] || {};
      if (dryRun) {
        var r = { ok: true, dryRun: true,
                  note: "Dry run — not applied" };
        results.push(r);
        if (onEach) onEach(i, cmd, r);
        step(i + 1);
        return;
      }
      callHostTool(cmd.tool, cmd.args, function (result) {
        results.push(result);
        if (onEach) onEach(i, cmd, result);
        step(i + 1);
      });
    }
    step(0);
  }

  global.Tools = {
    TOOL_DEFS: TOOL_DEFS,
    RESPONSE_SCHEMA: RESPONSE_SCHEMA,
    buildSystemPrompt: buildSystemPrompt,
    callHostTool: callHostTool,
    executeCommands: executeCommands
  };

})(window);
