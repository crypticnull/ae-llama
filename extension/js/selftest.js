/*
 * selftest.js — one-click, deterministic regression run against REAL After
 * Effects. No LLM involved: a fixed script of host-tool calls exercises
 * every tool family in a scratch comp, checks each result, cleans up, and
 * prints a copyable PASS/FAIL report. This is the field-truth complement
 * to the stubbed Node tests (which cannot see real expression engines,
 * padded value dims, or ExtendScript quirks).
 */
(function (global) {
  "use strict";

  var COMP = "AELL Self-Test";
  // Cameras get their own comp: scale_comp resizes the whole thing.
  var CAMCOMP = "AELL Self-Test Cam";
  var running = false;

  /**
   * Each step: {name, tool, args: object | function(ctx), check(data, ctx)}.
   * check returns true (pass) or a string (failure detail); throwing also
   * fails the step. ctx carries values captured by earlier steps.
   */
  function buildSteps() {
    var squares = ["ST Square"];
    for (var i = 2; i <= 9; i++) squares.push("ST Square " + i);
    return [
      { name: "create scratch comp",
        tool: "create_comp",
        args: { name: COMP, width: 1280, height: 720, duration: 8,
                frameRate: 30 },
        check: function (d, ctx) {
          ctx.comp = d.name;
          return typeof d.id === "number" || !!d.id || "no comp id";
        } },

      { name: "comp name collision auto-numbers",
        tool: "create_comp",
        args: { name: COMP, width: 640, height: 360, duration: 2,
                frameRate: 30 },
        check: function (d, ctx) {
          ctx.comp2 = d.name;
          return (d.name !== ctx.comp && d.name.indexOf(COMP) === 0) ||
                 "expected auto-numbered name, got " + d.name;
        } },

      { name: "delete the collision comp (delete_item)",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.comp2 }; },
        check: function () { return true; } },

      { name: "add solid",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.comp, name: "ST Square", color: [1, 1, 1],
                   width: 100, height: 100 };
        },
        check: function (d) { return d.name === "ST Square" || d.name; } },

      { name: "duplicate x8 in one call (original stays on top)",
        tool: "duplicate_layer",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square", count: 8 };
        },
        check: function (d) {
          if (d.created !== 8) return "created " + d.created;
          if (d.totalLayersInComp !== 9) {
            return "total " + d.totalLayersInComp;
          }
          return true;
        } },

      { name: "grid rig (REAL expression engine accepts the rig)",
        tool: "grid_layout",
        args: function (ctx) { return { comp: ctx.comp, columns: 3 }; },
        check: function (d) {
          if (!d.sliders || d.sliders.length !== 3) {
            return "sliders: " + JSON.stringify(d.sliders);
          }
          return true;
        } },

      { name: "control-effect path auto-descends (read Grid Columns)",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "GRID CTRL",
                   property: "Effects/Grid Columns" };
        },
        check: function (d) {
          return d.value === 3 || "value " + JSON.stringify(d.value);
        } },

      // Verified in real AE 2026 under BOTH expression engines
      // (javascript-1.0 and legacy extendscript). grid_layout only
      // reports the sliders it made; these two steps prove the rig
      // actually EVALUATES, which is the part that silently breaks when
      // a generated expression is malformed for the active engine.
      { name: "grid rig evaluates (expression drives Position)",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square",
                   property: "Position" };
        },
        check: function (d, ctx) {
          if (!d.expression) { return "Position carries no expression"; }
          var v = d.value;
          if (!v || typeof v.length !== "number" || v.length < 2) {
            return "value " + JSON.stringify(v);
          }
          if (!isFinite(v[0]) || !isFinite(v[1])) {
            return "non-finite value " + JSON.stringify(v);
          }
          ctx.gridCell = v[0] + "," + v[1];
          return true;
        } },

      { name: "grid rig places layers in distinct cells",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 2",
                   property: "Position" };
        },
        check: function (d, ctx) {
          var v = d.value;
          if (!v || typeof v.length !== "number" || v.length < 2) {
            return "value " + JSON.stringify(v);
          }
          var cell = v[0] + "," + v[1];
          return cell !== ctx.gridCell ||
            "ST Square 2 evaluates to the same cell as ST Square (" +
            cell + ")";
        } },

      { name: "control-effect path write (Grid X Spacing = 222)",
        tool: "set_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "GRID CTRL",
                   property: "Effects/Grid X Spacing", value: 222 };
        },
        check: function () { return true; } },

      { name: "batch scale keys on 9 layers (relativeTo inPoint)",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.comp, layers: squares,
                   property: "transform/Scale",
                   keys: [{ time: 0, value: [100, 100] },
                          { time: 1, value: [150, 150] }],
                   relativeTo: "inPoint" };
        },
        check: function (d) {
          return d.keysSet === 18 || "keysSet " + d.keysSet;
        } },

      { name: "batch SCALE ease (padded 3-dim regression)",
        tool: "apply_keyframe_ease",
        args: function (ctx) {
          return { comp: ctx.comp, layers: squares,
                   property: "transform/Scale",
                   bezier: [0.42, 0, 0.58, 1], allPairs: true };
        },
        check: function (d) {
          return d.easedPairs === 9 || "easedPairs " + d.easedPairs;
        } },

      { name: "stagger 9 layers across a curve",
        tool: "stagger_layers",
        args: function (ctx) {
          return { comp: ctx.comp, layers: squares, spread: 2,
                   bezier: [0, 0, 0.58, 1], startAt: 0 };
        },
        check: function (d) {
          return d.layers === 9 || "layers " + d.layers;
        } },

      { name: "ellipse mask",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square", shape: "ellipse" };
        },
        check: function () { return true; } },

      { name: "edit mask (feather/mode)",
        tool: "set_mask",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square", feather: 10,
                   mode: "add" };
        },
        check: function () { return true; } },

      { name: "ANIMATE mask path (real Shape keyframes)",
        tool: "set_mask_path",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square", keys: [
            { time: 0, vertices: [[0, 0], [100, 0], [100, 100]] },
            { time: 1, vertices: [[0, 0], [80, 0], [80, 80]] }
          ] };
        },
        check: function (d) {
          return d.keysSet === 2 || "keysSet " + d.keysSet;
        } },

      { name: "shape layer",
        tool: "add_shape_layer",
        args: function (ctx) {
          return { comp: ctx.comp, name: "ST Shape", shape: "rectangle",
                   size: [120, 120], fillColor: [1, 0, 0] };
        },
        check: function () { return true; } },

      { name: "shape content: trim paths (real vector match names)",
        tool: "add_shape_content",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Shape", kind: "trim_paths",
                   params: { End: 50 } };
        },
        check: function (d) {
          return (d.params || "").indexOf("End") !== -1 ||
                 "params: " + d.params;
        } },

      { name: "apply effect by match name",
        tool: "apply_effect",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 2",
                   effect: "ADBE Gaussian Blur 2" };
        },
        check: function () { return true; } },

      { name: "set effect param via universal path",
        tool: "set_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 2",
                   property: "effects/Gaussian Blur/Blurriness",
                   value: 12 };
        },
        check: function () { return true; } },

      { name: "track matte (AE 23+ API)",
        tool: "set_track_matte",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 3",
                   matteLayer: "ST Square 4", mode: "alpha" };
        },
        check: function (d) { return d.mode === "alpha" || d.mode; } },

      { name: "parent without visual jump",
        tool: "set_layer_parent",
        args: function (ctx) {
          return { comp: ctx.comp, layers: ["ST Square 5"],
                   parent: "GRID CTRL" };
        },
        check: function (d) {
          return (d.parented || "").indexOf("ST Square 5") !== -1 ||
                 "parented: " + d.parented;
        } },

      { name: "link_property (expression validated by real AE)",
        tool: "link_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 6",
                   property: "opacity", controlLayer: "GRID CTRL",
                   controlEffect: "Grid X Spacing", scale: 0.1 };
        },
        check: function () { return true; } },

      { name: "reorder layers (stacking only)",
        tool: "reorder_layers",
        args: function (ctx) {
          return { comp: ctx.comp, layers: squares, order: "ascending" };
        },
        check: function () { return true; } },

      { name: "scale_comp (uniform, centered)",
        tool: "scale_comp",
        args: function (ctx) { return { comp: ctx.comp, width: 640 }; },
        check: function (d) {
          return Math.abs(d.scaleFactor - 0.5) < 0.01 ||
                 "factor " + d.scaleFactor;
        } },

      // ---- Cameras (WORKPLAN item 2b) ----------------------------------
      // In their OWN scratch comp: scale_comp resizes the whole comp, and
      // a camera must not disturb the 2D steps above. Values are chosen so
      // every expectation is exact rather than relative — an 800x600 comp
      // halved is 400x300, so a zoom of 1000 must become 500 and a Point
      // of Interest at the old centre [400,300] must become [200,150].
      { name: "camera scratch comp",
        tool: "create_comp",
        args: { name: CAMCOMP, width: 800, height: 600, duration: 4,
                frameRate: 30 },
        check: function (d, ctx) {
          ctx.camComp = d.name;
          return typeof d.id === "number" || !!d.id || "no comp id";
        } },

      { name: "add a two-node camera (aims at a Point of Interest)",
        tool: "add_camera",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Cam Aim", zoom: 1000,
                   position: [400, 300, -800],
                   pointOfInterest: [400, 300, 0] };
        },
        check: function (d) { return d.name === "ST Cam Aim" || d.name; } },

      { name: "add a one-node camera (no Point of Interest to aim)",
        tool: "add_camera",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Cam One", zoom: 1000,
                   position: [400, 300, -800], oneNode: true };
        },
        check: function (d) { return d.name === "ST Cam One" || d.name; } },

      { name: "a 2D layer rides along with the cameras",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Cam Solid",
                   color: [1, 1, 1], width: 100, height: 100 };
        },
        check: function (d) { return d.name === "ST Cam Solid" || d.name; } },

      // THE assertion that would have caught the camera regression: the
      // tool reported its own failure honestly in layersSkipped and
      // nothing was reading it. A camera's Scale resolves but is hidden,
      // and writing it aborted the layer half-done.
      { name: "scale_comp with cameras skips nothing",
        tool: "scale_comp",
        args: function (ctx) { return { comp: ctx.camComp, factor: 0.5 }; },
        check: function (d) {
          if (d.layersSkipped && d.layersSkipped.length) {
            return "layersSkipped: " + JSON.stringify(d.layersSkipped);
          }
          if (Math.abs(d.scaleFactor - 0.5) > 0.01) {
            return "factor " + d.scaleFactor;
          }
          return d.layersScaled === 3 ||
                 "layersScaled " + d.layersScaled + " (expected 3)";
        } },

      { name: "two-node camera zoom halves",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Aim",
                   property: "Zoom" };
        },
        check: function (d) {
          return Math.abs(d.value - 500) < 0.6 || "zoom " + d.value;
        } },

      { name: "two-node camera keeps its aim (POI re-centred)",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Aim",
                   property: "Point of Interest" };
        },
        check: function (d) {
          var v = d.value || [];
          return (Math.abs(v[0] - 200) < 0.6 && Math.abs(v[1] - 150) < 0.6) ||
                 "POI " + JSON.stringify(d.value);
        } },

      { name: "one-node camera zoom halves too",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam One",
                   property: "Zoom" };
        },
        check: function (d) {
          return Math.abs(d.value - 500) < 0.6 || "zoom " + d.value;
        } },

      // A one-node camera has no aim point, so leaving it alone is
      // correct. Re-centring it would mean writing a hidden property.
      { name: "one-node camera's aim left alone",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam One",
                   property: "Point of Interest" };
        },
        check: function (d) {
          var v = d.value || [];
          return (Math.abs(v[0] - 400) < 0.6 && Math.abs(v[1] - 300) < 0.6) ||
                 "POI moved to " + JSON.stringify(d.value);
        } },

      { name: "cleanup: delete the camera comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.camComp }; },
        check: function () { return true; } },

      { name: "cleanup: delete the scratch comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.comp }; },
        check: function () { return true; } }
    ];
  }

  /**
   * Run the suite. deps: {callHostTool, onLine(text), onDone(summary)}.
   * Sequential; a step failure is recorded and the run continues (cleanup
   * still happens last).
   */
  function run(deps) {
    if (running) {
      deps.onLine("Self-test already running.");
      return;
    }
    running = true;
    var steps = buildSteps();
    var ctx = {};
    var results = [];
    var idx = 0;

    function finish() {
      running = false;
      var passed = 0;
      var lines = [];
      for (var i = 0; i < results.length; i++) {
        if (results[i].ok) {
          passed++;
        } else {
          lines.push("FAIL " + results[i].name + " — " + results[i].detail);
        }
      }
      var summary = "Self-test: " + passed + "/" + results.length +
        " passed" + (lines.length ? "\n" + lines.join("\n") : "") +
        "\n(Copy the chat with the clipboard button to report this.)";
      deps.onDone({ passed: passed, total: results.length, text: summary });
    }

    function step() {
      if (idx >= steps.length) { finish(); return; }
      var s = steps[idx++];
      var args;
      try {
        args = typeof s.args === "function" ? s.args(ctx) : s.args;
      } catch (eA) {
        results.push({ name: s.name, ok: false,
                       detail: "args error: " + eA.message });
        step();
        return;
      }
      deps.callHostTool(s.tool, args, function (r) {
        if (!r || !r.ok) {
          results.push({ name: s.name, ok: false,
                         detail: r ? r.error : "no result" });
          deps.onLine("FAIL — " + s.name);
        } else {
          var verdict;
          try { verdict = s.check(r.data || {}, ctx); }
          catch (eC) { verdict = "check error: " + eC.message; }
          if (verdict === true) {
            results.push({ name: s.name, ok: true });
          } else {
            results.push({ name: s.name, ok: false,
                           detail: String(verdict) });
            deps.onLine("FAIL — " + s.name + " (" + verdict + ")");
          }
        }
        // Yield between steps so the panel stays responsive.
        global.setTimeout(step, 30);
      });
    }

    deps.onLine("Self-test: running " + steps.length +
                " real-AE checks in a scratch comp…");
    step();
  }

  global.SelfTest = { run: run, _buildSteps: buildSteps };

})(window);
