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
  // So does the anchor-point rig: it needs its own parent chain and
  // measuring nulls, which would disturb the grid steps above.
  var APCOMP = "AELL Self-Test Anchor";
  // And so does the chunk rig: it needs its own frame rate and a clip
  // trimmed deliberately off the frame grid.
  var CHCOMP = "AELL Self-Test Chunks";
  // And the ordering rig: it wants a dozen numbered layers all sitting at
  // inPoint 0, which is exactly the tie the sort used to scramble.
  var ORCOMP = "AELL Self-Test Order";
  // And the mask-animation rig: it needs its own frame rate (25) so that
  // "did the key land on a frame" is a question with a known answer.
  var MKCOMP = "AELL Self-Test Mask";
  // And the batch rig: 60 layers of its own, so a for_each_layer run
  // that misfires cannot touch the comps the other groups measure.
  var BTCOMP = "AELL Self-Test Batch";
  // And the batch-CALL rig (many tools in one host call, one Ctrl+Z): a
  // batch that misfires must not be able to reach the comps above.
  var UNCOMP = "AELL Self-Test Undo";
  // And the light rig: lights are riggers like cameras, so they get
  // their own comp rather than joining the ones being measured.
  var LTCOMP = "AELL Self-Test Light";
  // And the coverage rig: the tools nothing else in the suite ever calls.
  // It resizes and re-times its own comp, so it cannot share one.
  var CVCOMP = "AELL Self-Test Cover";
  // And the precompose rig: precompose CREATES project items, so it must
  // not be able to nest a comp another group is still measuring.
  var PCCOMP = "AELL Self-Test Precomp";
  var running = false;

  /**
   * Each step: {name, tool, args: object | function(ctx), check(data, ctx)}.
   * check returns true (pass) or a string (failure detail); throwing also
   * fails the step. ctx carries values captured by earlier steps.
   *
   * A step may also set {expectError: true}, which INVERTS the step: the
   * tool must refuse, and check() is handed the error string instead of
   * the data. Grounded refusals are half of this panel's design and the
   * suite could not reach any of them before.
   */
  function buildSteps() {
    var squares = ["ST Square"];
    for (var i = 2; i <= 9; i++) squares.push("ST Square " + i);
    var ords = ["ST Ord"];
    for (var o = 2; o <= 12; o++) ords.push("ST Ord " + o);
    var ordsRev = ords.slice(0).reverse();
    // duplicate_layer names copies "ST Batch 2".."ST Batch 60".
    var batchNames = ["ST Batch"];
    for (var b = 2; b <= 60; b++) batchNames.push("ST Batch " + b);
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

      // From a real chat transcript (scripts/chat-probe.js): "make a 3x3
      // grid of squares", then "spread them equally across the width".
      // grid_layout rigs Position to an expression, AE ACCEPTS every
      // setValue that follows and shows none of them, and the tool used to
      // answer with nine `applied` rows of values that were not in the
      // comp. The layers are still rigged at this point in the suite, so
      // this is the field state exactly.
      { name: "distribute over the grid rig applies NOTHING (and says so)",
        tool: "distribute_property",
        args: function (ctx) {
          return { comp: ctx.comp, layers: squares, property: "position_x",
                   from: 200, to: 1720, step: 180 };
        },
        check: function (d) {
          if (d.applied && d.applied.length) {
            return "claimed " + d.applied.length + " layer(s) applied " +
                   "while an expression drives Position";
          }
          if (!d.overriddenByExpression ||
              d.overriddenByExpression.length !== squares.length) {
            return "overriddenByExpression: " +
                   JSON.stringify(d.overriddenByExpression);
          }
          if (!/clearExpressions/.test(d.note || "")) {
            return "note does not name the way out: " + (d.note || "");
          }
          return true;
        } },

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

      // The unit trap, measured in the field: "stagger them 4 frames
      // apart" reached stagger_layers as spread 0.133 (the TOTAL) across
      // nine layers -- half a frame each -- and the tool reported nine
      // placements without a murmur. Frames are what designers say, so
      // the gap is now its own argument, and REAL AE has to agree that
      // the layers landed where the tool claims.
      { name: "stagger 9 layers 4 frames apart (gap, not total)",
        tool: "stagger_layers",
        args: function (ctx) {
          return { comp: ctx.comp, layers: squares, stepFrames: 4,
                   startAt: 0 };
        },
        check: function (d) {
          var fd = 1 / 30;
          if (d.stepFrames !== 4) return "stepFrames " + d.stepFrames;
          if (Math.abs(d.step - 4 * fd) > 0.002) return "step " + d.step;
          if (Math.abs(d.spread - 32 * fd) > 0.01) {
            return "total spread " + d.spread + " (8 gaps of 4 frames)";
          }
          if (!d.placed || d.placed.length !== 9) {
            return "placed " + (d.placed ? d.placed.length : d.placed);
          }
          for (var i = 1; i < d.placed.length; i++) {
            var gap = d.placed[i].startTime - d.placed[i - 1].startTime;
            if (Math.abs(gap - 4 * fd) > 0.002) {
              return "gap " + (i + 1) + " is " + gap + "s, not 4 frames";
            }
          }
          return true;
        } },

      { name: "…and the comp really shows those 4-frame gaps",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.comp, limit: 0 }; },
        check: function (d) {
          // limit: 0 on purpose — a capped list would check 40 of the
          // comp and call it nine.
          if (d.layersShown !== d.numLayers) {
            return "capped list: " + d.layersShown + " of " + d.numLayers;
          }
          var at = {};
          for (var i = 0; i < d.layers.length; i++) {
            at[d.layers[i].name] = d.layers[i].startTime;
          }
          for (var s = 0; s < squares.length; s++) {
            var want = s * 4 / 30;
            if (typeof at[squares[s]] !== "number") {
              return "no row for " + squares[s];
            }
            if (Math.abs(at[squares[s]] - want) > 0.002) {
              return squares[s] + " starts at " + at[squares[s]] +
                     "s, wanted " + want + "s";
            }
          }
          return true;
        } },

      { name: "stagger refuses 'spread' AND 'step' together",
        tool: "stagger_layers",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.comp, layers: squares, spread: 2, step: 0.2 };
        },
        check: function (err) {
          return (/TOTAL/.test(err) && /BETWEEN/.test(err)) ||
                 "error does not spell out which unit is which: " + err;
        } },

      { name: "a sub-frame spread is honored but NAMED",
        tool: "stagger_layers",
        args: function (ctx) {
          return { comp: ctx.comp, layers: squares, spread: 0.133,
                   startAt: 0 };
        },
        check: function (d) {
          if (!(d.perLayerFrames < 1)) {
            return "perLayerFrames " + d.perLayerFrames;
          }
          if (!/TOTAL/.test(d.note || "")) {
            return "note does not say spread is the total: " + (d.note || "");
          }
          if (!/step: 0\.133/.test(d.note || "")) {
            return "note does not name the argument that fixes it: " +
                   (d.note || "");
          }
          return true;
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

      // The two halves of "driven": link_property just rigged ST Square 6's
      // opacity to a slider, so a write to it is swallowed…
      { name: "write to a linked property reports applied:false",
        tool: "set_transform",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 6",
                   property: "opacity", value: 42 };
        },
        check: function (d) {
          if (d.applied !== false) {
            return "reported applied " + JSON.stringify(d.applied);
          }
          if (!/not 42/.test(d.warning || "")) {
            return "warning does not quote the real value: " +
                   (d.warning || "");
          }
          return true;
        } },

      // …while an expression that CONSUMES `value` really does move, and
      // warning about it would be a false alarm. Only reading the property
      // back tells the two apart, which is why the check is a read and not
      // an expressionEnabled flag.
      { name: "pass-through expression (value) on ST Square 7 opacity",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 7",
                   property: "opacity", expression: "value" };
        },
        check: function (d) {
          return d.expressionEnabled === true || "expression not enabled";
        } },

      { name: "…a write through it is NOT flagged as overridden",
        tool: "set_transform",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 7",
                   property: "opacity", value: 42 };
        },
        check: function (d) {
          if (d.applied === false) {
            return "false alarm: " + (d.warning || "");
          }
          return !d.warning || "unexpected warning: " + d.warning;
        } },

      { name: "…and clearing it leaves the written value behind",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 7",
                   property: "opacity", expression: "" };
        },
        check: function (d) {
          return d.expression === "cleared" || "expression: " + d.expression;
        } },

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

      // ---- Text (WORKPLAN item 2) --------------------------------------
      // font/tracking/leading are the AE-version-sensitive paths. Added
      // late so the text layer cannot disturb the 9-square steps above.
      { name: "add text layer (fontSize/tracking/leading)",
        tool: "add_text_layer",
        args: function (ctx) {
          return { comp: ctx.comp, text: "ST Text", fontSize: 48,
                   tracking: 20, leading: 60, justification: "center",
                   position: [100, 100] };
        },
        check: function (d, ctx) {
          ctx.textLayer = d.name;
          var s = d.style || {};
          if (s.fontSize !== 48) return "fontSize " + s.fontSize;
          if (s.tracking !== 20) return "tracking " + s.tracking;
          if (s.leading !== 60) return "leading " + s.leading;
          return true;
        } },

      // Restyling writes one TextDocument back wholesale, so a partial
      // update must not quietly drop the fields it was not given.
      { name: "restyle a subset keeps the other text fields",
        tool: "set_text_style",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.textLayer, fontSize: 24 };
        },
        check: function (d) {
          var s = d.style || {};
          if (s.fontSize !== 24) return "fontSize " + s.fontSize;
          if (s.tracking !== 20) return "tracking lost: " + s.tracking;
          if (s.leading !== 60) return "leading lost: " + s.leading;
          return true;
        } },

      // AE clamps leading 0 to ~0.01 and leaves autoLeading false, so
      // without an explicit "auto" there is no way back.
      { name: "leading can go back to auto",
        tool: "set_text_style",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.textLayer, leading: "auto" };
        },
        check: function (d) {
          var s = d.style || {};
          return s.leading === "auto" || "leading " + s.leading;
        } },

      // A layer made by comp.layers.addText() inherits AE's CHARACTER
      // PANEL -- whatever the user last typed with, which scripting can
      // neither read as "the default" nor reset. On the dev machine a
      // plain "add a text layer" really did come back PowerCentra-Book
      // 66px with tracking 251 and auto leading off, and the tool
      // reported that as a success. These steps assert the CONTRACT (a
      // new layer starts from a known baseline), so they hold on a
      // machine whose Character panel happens to be clean too.
      { name: "a new text layer ignores AE's last-used character style",
        tool: "add_text_layer",
        args: function (ctx) {
          return { comp: ctx.comp, text: "ST Baseline",
                   position: [100, 200] };
        },
        check: function (d, ctx) {
          ctx.baseTextLayer = d.name;
          var s = d.style || {};
          if (d.styleReset !== true) return "styleReset " + d.styleReset;
          if (s.tracking !== 0) return "tracking " + s.tracking;
          if (s.leading !== "auto") return "leading " + s.leading;
          if (s.fontSize !== 72) return "fontSize " + s.fontSize;
          if (!s.font) return "no font reported";
          var f = s.fillColor || [];
          if (f.join(",") !== "1,1,1") return "fillColor " + f.join(",");
          return true;
        } },

      // ...but the caller's own wishes must still win over that baseline.
      { name: "explicit style beats the baseline",
        tool: "add_text_layer",
        args: function (ctx) {
          return { comp: ctx.comp, text: "ST Override", fontSize: 40,
                   tracking: 12, leading: 55, fillColor: [1, 0, 0],
                   position: [100, 300] };
        },
        check: function (d, ctx) {
          ctx.overTextLayer = d.name;
          var s = d.style || {};
          if (s.fontSize !== 40) return "fontSize " + s.fontSize;
          if (s.tracking !== 12) return "tracking " + s.tracking;
          if (s.leading !== 55) return "leading " + s.leading;
          var f = s.fillColor || [];
          if (f.join(",") !== "1,0,0") return "fillColor " + f.join(",");
          return true;
        } },

      { name: "clean up the baseline text layer",
        tool: "delete_layer",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.baseTextLayer };
        },
        check: function (d, ctx) {
          return d.removed === ctx.baseTextLayer || "removed " + d.removed;
        } },

      { name: "clean up the override text layer",
        tool: "delete_layer",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.overTextLayer };
        },
        check: function (d, ctx) {
          return d.removed === ctx.overTextLayer || "removed " + d.removed;
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

      // ---- keyframed + parented content (WORKPLAN item 2) -------------
      // scale_comp maps every keyframe VALUE, which is the easy half. The
      // half that broke is everything else a keyframe carries: the ease
      // SPEED is units/second and the spatial handles are pixels, both
      // still in the old comp's scale afterwards. Key values stay exactly
      // right while the motion BETWEEN them goes wrong, so this is
      // measured with a probe null reading valueAtTime, not keyValue.
      { name: "keyed layer for the resize",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Cam Ease",
                   color: [0, 1, 0], width: 100, height: 100 };
        },
        check: function (d) { return d.name === "ST Cam Ease" || d.name; } },

      { name: "animate its Position across the comp",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Ease",
                   property: "Position",
                   keys: [{ time: 0, value: [100, 300] },
                          { time: 2, value: [700, 300] }] };
        },
        check: function (d) { return d.keysSet === 2 || "keys " + d.keysSet; } },

      // A bezier with a non-zero y1/y2 gives the keys a real SPEED (600
      // px/s here) rather than the 0 an ease-in-out would store — a speed
      // of zero would scale correctly by doing nothing.
      { name: "ease it, so the keys carry a real speed",
        tool: "apply_keyframe_ease",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Ease",
                   property: "Position", bezier: [0.3, 0.6, 0.7, 0.4] };
        },
        check: function (d) {
          return d.easedPairs === 1 || "easedPairs " + d.easedPairs;
        } },

      // Scale is NOT spatial, so AE demands one ease per PADDED scripting
      // component — 3 even on this 2D layer. Read-and-rewrite gets that
      // right for free; building the array by hand would not, and AE
      // refuses the wrong length outright.
      { name: "animate its Scale too (padded ease dims)",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Ease",
                   property: "Scale",
                   keys: [{ time: 0, value: [100, 100] },
                          { time: 2, value: [200, 50] }] };
        },
        check: function (d) { return d.keysSet === 2 || "keys " + d.keysSet; } },

      { name: "ease the Scale keys as well",
        tool: "apply_keyframe_ease",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Ease",
                   property: "Scale", bezier: [0.3, 0.6, 0.7, 0.4] };
        },
        check: function (d) {
          return d.easedPairs === 1 || "easedPairs " + d.easedPairs;
        } },

      { name: "probe null for the mid-keyframe position",
        tool: "add_null",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Cam Probe" };
        },
        check: function () { return true; } },

      // Reads the eased layer BETWEEN its two keys. Key values alone
      // cannot see this failure; the whole point is the in-between.
      { name: "probe reads the eased layer at t=0.5",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Probe",
                   property: "Position",
                   expression: 'thisComp.layer("ST Cam Ease")' +
                               '.position.valueAtTime(0.5)' };
        },
        check: function (d) {
          return d.expressionEnabled === true || "expression not enabled";
        } },

      { name: "record the mid-keyframe position before the resize",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Probe",
                   property: "Position" };
        },
        check: function (d, ctx) {
          ctx.camEaseBefore = d.value;
          // An eased curve must not sit at the linear midpoint, or the
          // ease is doing nothing and the check below proves nothing.
          return (d.value && Math.abs(d.value[0] - 400) > 20) ||
                 "no ease in the motion: " + JSON.stringify(d.value);
        } },

      { name: "null to parent a camera to (the standard rig)",
        tool: "add_null",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Cam Rig",
                   position: [400, 300] };
        },
        check: function () { return true; } },

      { name: "add a camera and parent it to the null",
        tool: "add_camera",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Cam Kid", zoom: 1000,
                   position: [400, 300, -800],
                   pointOfInterest: [400, 300, 0] };
        },
        check: function (d) { return d.name === "ST Cam Kid" || d.name; } },

      { name: "parent it",
        tool: "set_layer_parent",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Kid",
                   parent: "ST Cam Rig" };
        },
        check: function () { return true; } },

      // ---- lights in the same resize (WORKPLAN item 2 follow-up) ------
      // A light's pixel options live in Light Options, OUTSIDE the
      // Transform group — the camera-zoom trap one layer type over. A
      // halved comp used to keep a 300px falloff radius, and an ambient
      // light (whose Position AE hides) was reported as a layer that
      // could NOT be scaled. Values are exact: 800x600 halved, so 300 ->
      // 150, 400 -> 200, 60 -> 30.
      { name: "add a spot light with pixel options",
        tool: "add_light",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Lit Spot", type: "spot",
                   falloff: "smooth", radius: 300, falloffDistance: 400,
                   shadowDiffusion: 60, coneAngle: 90,
                   position: [400, 300, -500],
                   pointOfInterest: [400, 300, 0] };
        },
        check: function (d) { return d.name === "ST Lit Spot" || d.name; } },

      // inverseSquareClamped uses Radius but HIDES Falloff Distance, and
      // a point light reports autoOrient 4214 like a two-node spot while
      // refusing its Point of Interest — trusting that flag threw after
      // Position had already been written.
      { name: "add a point light (hidden distance, lying autoOrient)",
        tool: "add_light",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Lit Point", type: "point",
                   falloff: "inverseSquareClamped", radius: 200,
                   shadowDiffusion: 80, position: [200, 150, -300] };
        },
        check: function (d) { return d.name === "ST Lit Point" || d.name; } },

      { name: "add an ambient light (nothing at all to scale)",
        tool: "add_light",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Lit Amb", type: "ambient" };
        },
        check: function (d) { return d.name === "ST Lit Amb" || d.name; } },

      { name: "add a light to parent to the null",
        tool: "add_light",
        args: function (ctx) {
          return { comp: ctx.camComp, name: "ST Lit Kid", type: "spot",
                   falloff: "smooth", radius: 600,
                   position: [400, 300, -500],
                   pointOfInterest: [400, 300, 0] };
        },
        check: function (d) { return d.name === "ST Lit Kid" || d.name; } },

      { name: "parent the light",
        tool: "set_layer_parent",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Kid",
                   parent: "ST Cam Rig" };
        },
        check: function () { return true; } },

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
          // Zoom lives in Camera Options, so a PARENTED camera inherits
          // none of it and must still be re-zoomed — reported apart from
          // layersScaled because its transform really was inherited.
          var rez = d.parentedCamerasRezoomed || [];
          if (rez.join(",") !== "ST Cam Kid") {
            return "parentedCamerasRezoomed " + JSON.stringify(rez);
          }
          if (d.layersInherited !== 2) {
            return "layersInherited " + d.layersInherited + " (expected 2)";
          }
          // The ambient light is in NEITHER count: AE hides everything
          // scalable on it, so there was never anything to do.
          var none = d.layersWithNothingToScale || [];
          if (none.join(",").indexOf("ST Lit Amb") === -1) {
            return "layersWithNothingToScale " + JSON.stringify(none);
          }
          return d.layersScaled === 8 ||
                 "layersScaled " + d.layersScaled + " (expected 8)";
        } },

      // A light's pixel options are pixels: they halve with the comp, and
      // the angles and percentages beside them must not move.
      { name: "spot light Radius halves",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Spot",
                   property: "light/Radius" };
        },
        check: function (d) {
          return Math.abs(d.value - 150) < 0.6 || "radius " + d.value;
        } },

      { name: "spot light Falloff Distance halves",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Spot",
                   property: "light/Falloff Distance" };
        },
        check: function (d) {
          return Math.abs(d.value - 200) < 0.6 || "distance " + d.value;
        } },

      { name: "spot light Shadow Diffusion halves",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Spot",
                   property: "light/Shadow Diffusion" };
        },
        check: function (d) {
          return Math.abs(d.value - 30) < 0.6 || "diffusion " + d.value;
        } },

      { name: "but the Cone Angle (degrees) does NOT scale",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Spot",
                   property: "light/Cone Angle" };
        },
        check: function (d) {
          return Math.abs(d.value - 90) < 0.6 ||
                 "cone angle " + d.value + " — an angle is not a pixel";
        } },

      { name: "point light Radius halves",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Point",
                   property: "light/Radius" };
        },
        check: function (d) {
          return Math.abs(d.value - 100) < 0.6 || "radius " + d.value;
        } },

      // Under inverseSquareClamped this one is HIDDEN, so writing it
      // throws and leaving it is correct — it renders nothing.
      { name: "its hidden Falloff Distance is left alone",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Point",
                   property: "light/Falloff Distance" };
        },
        check: function (d) {
          return Math.abs(d.value - 500) < 0.6 ||
                 "falloff distance " + d.value + " (should be untouched)";
        } },

      { name: "the point light's Position still halved",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Point",
                   property: "Position" };
        },
        check: function (d) {
          var v = d.value || [];
          return (Math.abs(v[0] - 100) < 0.6 && Math.abs(v[1] - 75) < 0.6 &&
                  Math.abs(v[2] + 150) < 0.6) ||
                 "position " + JSON.stringify(v);
        } },

      // Light Options are not inherited from a parent any more than a
      // camera's zoom is.
      { name: "a PARENTED light still rescales its Radius",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Kid",
                   property: "light/Radius" };
        },
        check: function (d) {
          return Math.abs(d.value - 300) < 0.6 ||
                 "radius " + d.value + " — a parent inherits none of it";
        } },

      { name: "the parented light's transform is left to its parent",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Kid",
                   property: "Position" };
        },
        check: function (d) {
          var v = d.value || [];
          return (Math.abs(v[0] - 400) < 0.6 && Math.abs(v[1] - 300) < 0.6) ||
                 "position " + JSON.stringify(v) + " (double-scaled?)";
        } },

      { name: "the ambient light's hidden Position was not touched",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Lit Amb",
                   property: "Position" };
        },
        check: function (d, ctx) {
          var v = d.value || [];
          ctx.ambPos = v;
          return (Math.abs(v[0] - 0) < 0.6 && Math.abs(v[1] - 0) < 0.6) ||
                 "position " + JSON.stringify(v) + " — AE hides it, so " +
                 "nothing should have written it";
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

      // An 800x600 comp halved centres on itself, so every comp-space
      // point must land at exactly half its old value.
      { name: "eased motion keeps its shape through the resize",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Probe",
                   property: "Position" };
        },
        check: function (d, ctx) {
          var b = ctx.camEaseBefore || [0, 0];
          var v = d.value || [];
          var dx = v[0] - b[0] / 2, dy = v[1] - b[1] / 2;
          var off = Math.sqrt(dx * dx + dy * dy);
          return off < 0.5 ||
                 "mid-keyframe position is " + off.toFixed(2) + "px off " +
                 "course (ease speed is units/second and did not scale): " +
                 JSON.stringify(v) + " vs half of " + JSON.stringify(b);
        } },

      { name: "its Position keyframe values halve",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Ease",
                   property: "Position" };
        },
        check: function (d) {
          var k = d.keys || [];
          if (k.length !== 2) return "keys " + k.length;
          return (Math.abs(k[0].value[0] - 50) < 0.6 &&
                  Math.abs(k[1].value[0] - 350) < 0.6) ||
                 "keys " + JSON.stringify(k);
        } },

      { name: "its Scale keyframe values halve (padded ease dims accepted)",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Ease",
                   property: "Scale" };
        },
        check: function (d) {
          var k = d.keys || [];
          if (k.length !== 2) return "keys " + k.length;
          return (Math.abs(k[0].value[0] - 50) < 0.6 &&
                  Math.abs(k[1].value[0] - 100) < 0.6 &&
                  Math.abs(k[1].value[1] - 25) < 0.6) ||
                 "keys " + JSON.stringify(k);
        } },

      { name: "a parented camera still re-zooms",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Kid",
                   property: "Zoom" };
        },
        check: function (d) {
          return Math.abs(d.value - 500) < 0.6 ||
                 "zoom " + d.value + " — a parent inherits nothing of it";
        } },

      { name: "the parented camera's transform is left to its parent",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Kid",
                   property: "Position" };
        },
        check: function (d) {
          var v = d.value || [];
          return (Math.abs(v[0] - 400) < 0.6 && Math.abs(v[2] + 800) < 0.6) ||
                 "position " + JSON.stringify(v) + " (double-transformed)";
        } },

      // ---- center_anchor_point on a moving rig (WORKPLAN item 2) -------
      // Measured the only way that proves "the layer did not move": a
      // probe null whose Position expression is the TARGET's own
      // toComp([0,0], t). That is the layer's origin in comp space, so it
      // must read IDENTICALLY before and after the anchor is re-centred --
      // through parenting, rotation and non-uniform scale alike.
      //
      // Real AE 2026 caught what the stub could not: the compensation
      // delta was taken once at the current time and applied to every
      // Position key, so a layer whose Scale/Rotation are ALSO animated
      // drifted up to 37px at the other keys. Two probe times, one per
      // Position key, is what makes that visible.
      { name: "anchor scratch comp",
        tool: "create_comp",
        args: { name: APCOMP, width: 800, height: 600, duration: 5,
                frameRate: 30 },
        check: function (d, ctx) {
          ctx.apComp = d.name;
          return typeof d.id === "number" || !!d.id || "no comp id";
        } },

      { name: "anchor rig: parent null",
        tool: "add_null",
        args: function (ctx) {
          return { comp: ctx.apComp, name: "ST AP Parent",
                   position: [500, 300] };
        },
        check: function (d) { return d.name === "ST AP Parent" || d.name; } },

      { name: "anchor rig: rotate the parent",
        tool: "set_transform",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: "ST AP Parent",
                   property: "rotation", value: 30 };
        },
        check: function () { return true; } },

      // Non-uniform, so a parent that distorts the child's frame is part
      // of the test rather than a friendly special case.
      { name: "anchor rig: scale the parent non-uniformly",
        tool: "set_transform",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: "ST AP Parent",
                   property: "scale", value: [80, 120] };
        },
        check: function () { return true; } },

      // Text, not a solid: a solid's anchor already sits at its centre,
      // so centring it is a no-op and would prove nothing.
      { name: "anchor rig: text layer (content bounds are off-centre)",
        tool: "add_text_layer",
        args: function (ctx) {
          return { comp: ctx.apComp, text: "Anchor", fontSize: 48 };
        },
        check: function (d, ctx) {
          ctx.apText = d.name;
          return !!d.name || "no layer name";
        } },

      { name: "anchor rig: parent the text",
        tool: "set_layer_parent",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: ctx.apText,
                   parent: "ST AP Parent" };
        },
        check: function () { return true; } },

      { name: "anchor rig: animate Position",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: ctx.apText, property: "Position",
                   keys: [{ time: 0, value: [100, 100] },
                          { time: 2, value: [300, 250] }] };
        },
        check: function (d) { return d.keysSet === 2 || "keys " + d.keysSet; } },

      { name: "anchor rig: animate Rotation",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: ctx.apText, property: "Rotation",
                   keys: [{ time: 0, value: 0 }, { time: 2, value: 45 }] };
        },
        check: function (d) { return d.keysSet === 2 || "keys " + d.keysSet; } },

      { name: "anchor rig: animate Scale",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: ctx.apText, property: "Scale",
                   keys: [{ time: 0, value: [100, 100] },
                          { time: 2, value: [50, 150] }] };
        },
        check: function (d) { return d.keysSet === 2 || "keys " + d.keysSet; } },

      { name: "anchor probe null (t=0)",
        tool: "add_null",
        args: function (ctx) {
          return { comp: ctx.apComp, name: "ST AP Probe 0" };
        },
        check: function () { return true; } },

      { name: "anchor probe reads the layer's origin in comp space (t=0)",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: "ST AP Probe 0",
                   property: "Position",
                   expression: 'thisComp.layer("' + ctx.apText +
                               '").toComp([0,0], 0)' };
        },
        check: function (d) {
          return d.expressionEnabled === true || "expression not enabled";
        } },

      { name: "anchor probe null (t=2)",
        tool: "add_null",
        args: function (ctx) {
          return { comp: ctx.apComp, name: "ST AP Probe 2" };
        },
        check: function () { return true; } },

      { name: "anchor probe reads the layer's origin in comp space (t=2)",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: "ST AP Probe 2",
                   property: "Position",
                   expression: 'thisComp.layer("' + ctx.apText +
                               '").toComp([0,0], 2)' };
        },
        check: function (d) {
          return d.expressionEnabled === true || "expression not enabled";
        } },

      { name: "record where the layer sits at t=0",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: "ST AP Probe 0",
                   property: "Position" };
        },
        check: function (d, ctx) {
          ctx.apBefore0 = d.value;
          return (d.value && isFinite(d.value[0])) ||
                 "probe value " + JSON.stringify(d.value);
        } },

      { name: "record where the layer sits at t=2",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: "ST AP Probe 2",
                   property: "Position" };
        },
        check: function (d, ctx) {
          ctx.apBefore2 = d.value;
          return (d.value && isFinite(d.value[0])) ||
                 "probe value " + JSON.stringify(d.value);
        } },

      { name: "center_anchor_point on the animated, parented layer",
        tool: "center_anchor_point",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: ctx.apText };
        },
        check: function (d) {
          if (!/2 Position keyframes offset/.test(d.note || "")) {
            return "note: " + d.note;
          }
          // Scale and Rotation animate here, so the tool must SAY the
          // offset is only exact at the keys instead of overclaiming.
          return /exact at the Position keyframes/.test(d.note || "") ||
                 "note does not disclose the in-between drift: " + d.note;
        } },

      { name: "layer did not move at t=0 (first Position key)",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: "ST AP Probe 0",
                   property: "Position" };
        },
        check: function (d, ctx) {
          var b = ctx.apBefore0 || [], a = d.value || [];
          var dx = a[0] - b[0], dy = a[1] - b[1];
          var drift = Math.sqrt(dx * dx + dy * dy);
          return drift < 0.5 || "layer jumped " + drift.toFixed(2) +
                 "px at t=0 (" + JSON.stringify(b) + " -> " +
                 JSON.stringify(a) + ")";
        } },

      // THE regression assertion: this is the key the old code got wrong,
      // because Scale and Rotation are different here than at t=0.
      { name: "layer did not move at t=2 either (moving Scale/Rotation)",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.apComp, layer: "ST AP Probe 2",
                   property: "Position" };
        },
        check: function (d, ctx) {
          var b = ctx.apBefore2 || [], a = d.value || [];
          var dx = a[0] - b[0], dy = a[1] - b[1];
          var drift = Math.sqrt(dx * dx + dy * dy);
          return drift < 0.5 || "layer jumped " + drift.toFixed(2) +
                 "px at t=2 (" + JSON.stringify(b) + " -> " +
                 JSON.stringify(a) + ")";
        } },

      // Cutting a clip is a TIMELINE edit and the timeline is a frame
      // grid. Measured in AE 2026: in/out points are NOT snapped for you,
      // and a piece whose in and out fall between the same two frames
      // renders nothing at all while the tool still reports it. So this
      // comp is trimmed deliberately OFF the grid (1.35s = frame 40.5 at
      // 30 fps) and split into a count that does not divide evenly —
      // 5.2s / 7 is 22.29 frames, so every interior cut has to be moved.
      { name: "chunk scratch comp",
        tool: "create_comp",
        args: { name: CHCOMP, width: 320, height: 240, duration: 8,
                frameRate: 30 },
        check: function (d, ctx) {
          ctx.chComp = d.name;
          return typeof d.id === "number" || !!d.id || "no comp id";
        } },

      { name: "add a clip to cut up",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.chComp, name: "ST Clip", color: [0.2, 0.6, 1],
                   width: 200, height: 120 };
        },
        check: function (d) { return d.name === "ST Clip" || d.name; } },

      { name: "trim the clip OFF the frame grid (1.35s..6.55s)",
        tool: "set_layer_timing",
        args: function (ctx) {
          return { comp: ctx.chComp, layer: "ST Clip",
                   inPoint: 1.35, outPoint: 6.55 };
        },
        check: function (d, ctx) {
          ctx.clipIn = d.inPoint;
          ctx.clipOut = d.outPoint;
          return (Math.abs(d.inPoint - 1.35) < 0.001 &&
                  Math.abs(d.outPoint - 6.55) < 0.001) ||
                 "trim came back " + d.inPoint + ".." + d.outPoint;
        } },

      { name: "split into 7: frame-aligned cuts, no gaps, ends kept",
        tool: "split_layer_into_chunks",
        args: function (ctx) {
          return { comp: ctx.chComp, layer: "ST Clip", chunks: 7 };
        },
        check: function (d, ctx) {
          if (d.chunks !== 7) return "made " + d.chunks + " chunks";
          var p = d.pieces || [];
          if (p.length !== 7) return "reported " + p.length + " pieces";
          var i, b = [p[0].inPoint];
          for (i = 0; i < 7; i++) {
            if (Math.abs(p[i].inPoint - b[b.length - 1]) > 1e-6) {
              return "gap or overlap before chunk " + (i + 1);
            }
            b.push(p[i].outPoint);
          }
          // Interior cuts only: the first in and last out are the user's
          // own trim and must survive verbatim, off-grid or not.
          for (i = 1; i < b.length - 1; i++) {
            var f = b[i] * 30;
            if (Math.abs(f - Math.round(f)) > 0.02) {
              return "cut " + i + " lands mid-frame at " + f.toFixed(2) +
                     " frames";
            }
          }
          if (Math.abs(b[0] - ctx.clipIn) > 0.001 ||
              Math.abs(b[7] - ctx.clipOut) > 0.001) {
            return "the clip's own trim moved: " + b[0] + ".." + b[7];
          }
          var lens = [], lo = 1e9, hi = -1e9;
          for (i = 0; i < 7; i++) {
            var n = Math.round((b[i + 1] - b[i]) * 30);
            lens.push(n);
            if (n < lo) lo = n;
            if (n > hi) hi = n;
          }
          if (lo < 1) return "a chunk holds no frame (" + lens + ")";
          if (hi - lo > 1) {
            return "chunk lengths vary by more than one frame (" + lens + ")";
          }
          if (p[0].index !== 7 || p[6].index !== 1) {
            return "stack order wrong: chunk 1 at index " + p[0].index +
                   ", chunk 7 at index " + p[6].index;
          }
          if (String(d.note).indexOf("cut on whole frames") < 0) {
            return "note does not report frame alignment: " + d.note;
          }
          return true;
        } },

      // THE regression assertion: the reported values are rounded, so read
      // an untouched chunk straight back out of AE.
      { name: "exact read-back: chunk 3 starts and ends on a frame",
        tool: "set_layer_timing",
        args: function (ctx) {
          return { comp: ctx.chComp, layer: "ST Clip chunk 3" };
        },
        check: function (d) {
          var f0 = d.inPoint * 30, f1 = d.outPoint * 30;
          if (Math.abs(f0 - Math.round(f0)) > 0.02 ||
              Math.abs(f1 - Math.round(f1)) > 0.02) {
            return "chunk 3 spans " + f0.toFixed(3) + ".." + f1.toFixed(3) +
                   " frames (" + d.inPoint + ".." + d.outPoint + ")";
          }
          return Math.round(f1 - f0) >= 1 || "chunk 3 holds no frame";
        } },

      // ---- Ordering (WORKPLAN item 2) ---------------------------------
      // Two facts measured in AE 2026, both invisible until you look at
      // WHICH layer got WHICH value. (1) ExtendScript's Array.sort is
      // unstable, so layers with equal sort keys came out in an order
      // that was not repeatable between two identical calls. (2) Every
      // layer in a fresh grid sits at inPoint 0, so the key that
      // distribute_property sorted by tied on every single one. Together
      // that turned "space these six every 100px" into a shuffle.
      // Their own comp: a dozen extra layers would drown the grid steps.
      { name: "order scratch comp",
        tool: "create_comp",
        args: { name: ORCOMP, width: 1600, height: 600, duration: 5,
                frameRate: 25 },
        check: function (d, ctx) {
          ctx.orComp = d.name;
          return typeof d.id === "number" || !!d.id || "no comp id";
        } },

      { name: "a layer to number up",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.orComp, name: "ST Ord", color: [0.9, 0.4, 0.1],
                   width: 60, height: 60 };
        },
        check: function (d) { return d.name === "ST Ord" || d.name; } },

      // AE's own auto-numbering makes the names: ST Ord, ST Ord 2 ..
      // ST Ord 12 — the double-digit tail is what a string sort mangles.
      { name: "duplicate to 12 numbered layers, all at inPoint 0",
        tool: "duplicate_layer",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord", count: 11 };
        },
        check: function (d) {
          return d.totalLayersInComp === 12 ||
                 "comp holds " + d.totalLayersInComp + " layers";
        } },

      { name: "step mode hands out slots in the LISTED order",
        tool: "distribute_property",
        args: function (ctx) {
          return { comp: ctx.orComp, layers: ords, property: "position_x",
                   from: 100, step: 100 };
        },
        check: function (d) {
          var a = d.applied || [];
          if (a.length !== 12) return "applied to " + a.length + " layers";
          for (var i = 0; i < 12; i++) {
            if (a[i].layer !== ords[i]) {
              return "slot " + i + " went to " + a[i].layer + ", not " +
                     ords[i] + " (order: " +
                     a[0].layer + ".." + a[11].layer + ")";
            }
            if (Math.abs(a[i].value - (100 + i * 100)) > 0.01) {
              return a[i].layer + " got " + a[i].value;
            }
          }
          return true;
        } },

      // The report above is what the tool BELIEVES. Read one end out of
      // AE so a report that lies cannot pass.
      { name: "read-back: first listed layer took the first slot",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord", property: "position" };
        },
        check: function (d) {
          return Math.abs(d.value[0] - 100) < 0.01 ||
                 "ST Ord sits at x=" + d.value[0] + ", not 100";
        } },

      { name: "read-back: last listed layer took the last slot",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 12",
                   property: "position" };
        },
        check: function (d) {
          return Math.abs(d.value[0] - 1200) < 0.01 ||
                 "ST Ord 12 sits at x=" + d.value[0] + ", not 1200";
        } },

      { name: "reversing the list reverses the spread",
        tool: "distribute_property",
        args: function (ctx) {
          return { comp: ctx.orComp, layers: ordsRev, property: "position_x",
                   from: 100, step: 100 };
        },
        check: function (d) {
          var a = d.applied || [];
          for (var i = 0; i < 12; i++) {
            if (a[i] && a[i].layer !== ordsRev[i]) {
              return "slot " + i + " went to " + a[i].layer + ", not " +
                     ordsRev[i];
            }
          }
          return true;
        } },

      { name: "read-back: the reversal actually landed in AE",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord", property: "position" };
        },
        check: function (d) {
          return Math.abs(d.value[0] - 1200) < 0.01 ||
                 "ST Ord sits at x=" + d.value[0] + ", not 1200";
        } },

      // ---- clearExpressions: the user's explicit ask outranks a rig ----
      // Decided deliberately (WORKPLAN-LOG, the chat-probe step-7
      // question): without the flag a driven layer is reported and NOT
      // moved; with it, exactly the expressions that swallowed the write
      // are removed and the values land. The escalation is a re-call the
      // model makes on purpose, never a temperature accident.
      { name: "rig one ordered layer (expression swallows writes)",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 5",
                   property: "position", expression: "[600, 300]" };
        },
        check: function (d) {
          return d.expressionEnabled === true || "expression not enabled";
        } },

      { name: "distribute refuses to fight the rig — and names the flag",
        tool: "distribute_property",
        args: function (ctx) {
          return { comp: ctx.orComp, layers: ords, property: "position_x",
                   from: 100, step: 100 };
        },
        check: function (d) {
          if (!d.applied || d.applied.length !== 11) {
            return "applied " + (d.applied ? d.applied.length : 0) +
                   " of the 11 un-rigged layers";
          }
          if (!d.overriddenByExpression ||
              d.overriddenByExpression.join(",") !== "ST Ord 5") {
            return "overriddenByExpression: " +
                   JSON.stringify(d.overriddenByExpression);
          }
          if (!/clearExpressions/.test(d.note || "")) {
            return "note does not name the way out: " + (d.note || "");
          }
          return true;
        } },

      { name: "clearExpressions removes the rig and lands the value",
        tool: "distribute_property",
        args: function (ctx) {
          return { comp: ctx.orComp, layers: ords, property: "position_x",
                   from: 100, step: 100, clearExpressions: true };
        },
        check: function (d) {
          if (!d.applied || d.applied.length !== 12) {
            return "applied " + (d.applied ? d.applied.length : 0) +
                   " of 12 layers";
          }
          if (!d.expressionsCleared ||
              d.expressionsCleared.join(",") !== "ST Ord 5") {
            return "expressionsCleared: " +
                   JSON.stringify(d.expressionsCleared);
          }
          if (d.overriddenByExpression) {
            return "still overridden: " +
                   JSON.stringify(d.overriddenByExpression);
          }
          return true;
        } },

      // Ask AE, not the report: the expression is gone and the slot
      // value is what the comp really shows (ords[4] -> 100 + 4*100).
      { name: "read-back: the rig is gone and x=500 is real",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 5",
                   property: "position" };
        },
        check: function (d) {
          if (d.expression) return "expression still on: " + d.expression;
          return Math.abs(d.value[0] - 500) < 0.01 ||
                 "ST Ord 5 sits at x=" + d.value[0] + ", not 500";
        } },

      { name: "reorder by name reads the numbers as numbers",
        tool: "reorder_layers",
        args: function (ctx) {
          return { comp: ctx.orComp, layers: ords, by: "name",
                   order: "descending" };
        },
        check: function (d) {
          var want = ords.join(" | ");
          if (d.topToBottom !== want) {
            return "stacked " + d.topToBottom;
          }
          if (d.slots !== "1..12") return "landed in slots " + d.slots;
          if (d.displaced) {
            return d.displaced + " untargeted layer(s) moved in a comp " +
                   "where every layer was a target";
          }
          return true;
        } },

      // Same trick again: ask AE what the stack IS, not what the tool
      // says it did.
      { name: "read-back: the comp's real stack matches the report",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.orComp }; },
        check: function (d) {
          var L = d.layers || [];
          if (L.length !== 12) return "comp holds " + L.length + " layers";
          for (var i = 0; i < 12; i++) {
            if (L[i].name !== ords[i]) {
              return "slot " + (i + 1) + " holds " + L[i].name + ", not " +
                     ords[i];
            }
          }
          return true;
        } },

      // ---- mask path animation ------------------------------------
      // The suite used to prove a mask was animated by counting keyframes,
      // which is exactly the number that stays right when the animation is
      // broken. Two real bugs measured in AE 2026 hid behind numKeys == 2:
      // (1) keys whose point counts disagree do not interpolate at all --
      //     AE holds key 1 and POPS, and queues a modal warning that
      //     appears after the script returns and disables AE's main
      //     window, swallowing every later tool call in silence;
      // (2) key times were stored exactly as asked, so a time off the
      //     frame grid put the requested shape on no rendered frame.
      // Its own comp, at 25 fps, so "which frame" has one right answer.
      { name: "mask scratch comp",
        tool: "create_comp",
        args: { name: MKCOMP, width: 400, height: 400, duration: 4,
                frameRate: 25 },
        check: function (d, ctx) {
          ctx.mkComp = d.name;
          return typeof d.id === "number" || !!d.id || "no comp id";
        } },

      { name: "a layer to mask",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.mkComp, name: "ST Mask", color: [1, 1, 1],
                   width: 200, height: 200 };
        },
        check: function (d) { return d.name === "ST Mask" || d.name; } },

      { name: "3-point custom mask",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", name: "ST Path",
                   shape: "custom",
                   vertices: [[0, 0], [100, 0], [100, 100]] };
        },
        check: function (d) {
          return d.mask === "ST Path" || "mask named " + d.mask;
        } },

      { name: "animate the mask path (keys on whole frames)",
        tool: "set_mask_path",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", mask: "ST Path",
                   keys: [
                     { time: 0, vertices: [[0, 0], [100, 0], [100, 100]] },
                     { time: 1, vertices: [[0, 0], [200, 0], [200, 200]] }
                   ] };
        },
        check: function (d) {
          if (d.keysSet !== 2 || d.numKeys !== 2) {
            return "keysSet " + d.keysSet + " numKeys " + d.numKeys;
          }
          if (d.points !== 3) return "points " + d.points;
          var f = (d.keyFrames || []).join(",");
          if (f !== "0,25") return "keys landed on frames " + f;
          if (d.snappedToFrames) return "nothing should have needed snapping";
          return true;
        } },

      { name: "mask probe null",
        tool: "add_null",
        args: function (ctx) {
          return { comp: ctx.mkComp, name: "ST Mask Probe" };
        },
        check: function () { return true; } },

      // maskPath.points(t) is the only way to read the SHAPE between two
      // keys -- there is no tool that moves the playhead, and keyValue
      // only ever returns the keys themselves.
      { name: "probe reads the mask path BETWEEN its keys",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Probe",
                   property: "Position",
                   expression: 'thisComp.layer("ST Mask")' +
                               '.mask("ST Path").maskPath.points(0.5)[1]' };
        },
        check: function (d) {
          return d.expressionEnabled === true || "expression not enabled";
        } },

      { name: "the mask really MOVES at t=0.5 (tween, not a pop)",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Probe",
                   property: "Position" };
        },
        check: function (d) {
          var x = (d.value || [])[0];
          if (typeof x !== "number") return "no probe value";
          // Halfway between vertex 1 at x=100 and x=200. A held or popped
          // path reads one END of that, never the middle.
          if (Math.abs(x - 150) > 0.5) {
            return "vertex 1 sits at x=" + Math.round(x * 100) / 100 +
                   " halfway through, not 150" +
                   (Math.abs(x - 100) < 0.5 || Math.abs(x - 200) < 0.5
                     ? " (that is a key value: the path is holding, " +
                       "not interpolating)" : "");
          }
          return true;
        } },

      { name: "a second layer for off-grid key times",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.mkComp, name: "ST Mask Off", color: [1, 0, 0],
                   width: 200, height: 200 };
        },
        check: function () { return true; } },

      { name: "3-point mask on the off-grid layer",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off",
                   name: "ST Off Path", shape: "custom",
                   vertices: [[0, 0], [100, 0], [100, 100]] };
        },
        check: function () { return true; } },

      // 0.33s and 0.71s in a 25 fps comp are frames 8.25 and 17.75. Left
      // alone, AE stores them there and the shapes asked for are on no
      // frame anyone can render.
      { name: "off-grid key times move onto whole frames",
        tool: "set_mask_path",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off",
                   mask: "ST Off Path", keys: [
                     { time: 0.33, vertices: [[0, 0], [100, 0], [100, 100]] },
                     { time: 0.71, vertices: [[0, 0], [1000, 0], [1000, 100]] }
                   ] };
        },
        check: function (d) {
          if (d.snappedToFrames !== 2) {
            return "snappedToFrames " + d.snappedToFrames;
          }
          var f = (d.keyFrames || []).join(",");
          if (f !== "8,18") return "keys landed on frames " + f;
          var t = (d.keyTimes || []).join(",");
          if (t !== "0.32,0.72") return "key times " + t;
          return true;
        } },

      { name: "off-grid probe null",
        tool: "add_null",
        args: function (ctx) {
          return { comp: ctx.mkComp, name: "ST Off Probe" };
        },
        check: function () { return true; } },

      { name: "off-grid probe reads frame 10 (t=0.4)",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Off Probe",
                   property: "Position",
                   expression: 'thisComp.layer("ST Mask Off")' +
                               '.mask("ST Off Path").maskPath.points(0.4)[1]' };
        },
        check: function (d) {
          return d.expressionEnabled === true || "expression not enabled";
        } },

      { name: "frame 10 shows the shape the frame grid implies",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Off Probe",
                   property: "Position" };
        },
        check: function (d) {
          var x = (d.value || [])[0];
          if (typeof x !== "number") return "no probe value";
          // Keys on frames 8 and 18 put frame 10 one fifth along:
          // 100 + 900 * 0.2 = 280. Unsnapped keys (0.33..0.71) put the
          // same frame at 265.8 -- a shape that is 14px wrong and lands
          // on no frame at all.
          if (Math.abs(x - 280) > 1) {
            return "vertex 1 sits at x=" + Math.round(x * 100) / 100 +
                   " on frame 10, not 280 (keys are off the frame grid)";
          }
          return true;
        } },

      // The refusals. Each of these used to be accepted, and the first one
      // used to leave AE behind a modal dialog -- if it regresses, this
      // suite does not merely fail, it stops responding at all.
      { name: "keys with different point counts are REFUSED",
        tool: "set_mask_path",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", mask: "ST Path",
                   keys: [
                     { time: 2, vertices: [[0, 0], [100, 0], [100, 100]] },
                     { time: 3, vertices: [[0, 0], [50, 0], [100, 0],
                                           [100, 50], [100, 100]] }
                   ] };
        },
        check: function (e) {
          if (!/same number of points/.test(e)) return "message was: " + e;
          if (!/POP/.test(e)) return "no mention of the pop: " + e;
          if (!/repeat a vertex/.test(e)) return "no way out offered: " + e;
          return true;
        } },

      { name: "the refused batch left the animation alone",
        tool: "set_mask_path",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", mask: "ST Path",
                   atTime: 2, vertices: [[0, 0], [300, 0], [300, 300]] };
        },
        check: function (d) {
          if (d.numKeys !== 3) return "numKeys " + d.numKeys + ", not 3";
          if (d.frame !== 50) return "landed on frame " + d.frame;
          return true;
        } },

      { name: "two key times on the same frame are REFUSED",
        tool: "set_mask_path",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off",
                   mask: "ST Off Path", keys: [
                     { time: 0.51, vertices: [[0, 0], [10, 0], [10, 10]] },
                     { time: 0.53, vertices: [[0, 0], [20, 0], [20, 20]] }
                   ] };
        },
        check: function (e) {
          return /both land on the same frame/.test(e) || "message was: " + e;
        } },

      { name: "a static path over an animated mask is REFUSED",
        tool: "set_mask_path",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", mask: "ST Path",
                   vertices: [[0, 0], [10, 0], [10, 10]] };
        },
        check: function (e) {
          return (/already animated/.test(e) && /atTime/.test(e)) ||
                 "message was: " + e;
        } },

      // --- the batch executor, at the scale it is actually used at.
      // for_each_layer used to run ANY tool name, so {tool: "create_comp"}
      // over N layers reported {succeeded: N} and left N junk comps in the
      // project. These steps drive it at 60 layers and then try to get it
      // to lie again.
      { name: "batch: create the batch comp",
        tool: "create_comp",
        args: { name: BTCOMP, width: 640, height: 360, duration: 4,
                frameRate: 30 },
        check: function (d, ctx) { ctx.btComp = d.name; return true; } },

      { name: "batch: seed one solid",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.btComp, name: "ST Batch", width: 60,
                   height: 60, color: [0.2, 0.6, 1] };
        },
        check: function () { return true; } },

      { name: "batch: grow it to 60 layers",
        tool: "duplicate_layer",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch", count: 59 };
        },
        check: function (d) {
          return d.totalLayersInComp === 60 ||
                 "comp holds " + d.totalLayersInComp + " layers, not 60";
        } },

      { name: "batch: apply_effect across 60 layers in ONE call",
        tool: "for_each_layer",
        args: function (ctx) {
          return { comp: ctx.btComp, layers: batchNames, tool: "apply_effect",
                   args: { effect: "Gaussian Blur" } };
        },
        check: function (d) {
          if (d.succeeded !== 60) {
            return "succeeded " + d.succeeded + " of 60. " + d.failures;
          }
          return true;
        } },

      // limit:0 on purpose: get_comp_details caps its layer list for the
      // MODEL, and a step that enumerates all 60 has to opt out of that
      // cap — otherwise it would go on passing while checking 40.
      { name: "batch: every one of the 60 really carries the blur",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.btComp, limit: 0 }; },
        check: function (d) {
          if (d.numLayers !== 60) return "numLayers " + d.numLayers + ", not 60";
          if (d.layers.length !== 60) {
            return "only " + d.layers.length + " layer rows came back — " +
                   "this step checks all 60";
          }
          var without = [];
          for (var i = 0; i < d.layers.length; i++) {
            var fx = d.layers[i].effects || [];
            var has = false;
            for (var k = 0; k < fx.length; k++) {
              if (String(fx[k]).indexOf("Gaussian Blur") !== -1) has = true;
            }
            if (!has) without.push(d.layers[i].name);
          }
          return without.length === 0 ||
                 without.length + " layers have no blur: " +
                 without.slice(0, 5).join(", ");
        } },

      { name: "batch: set_effect_param reaches all 60",
        tool: "for_each_layer",
        args: function (ctx) {
          return { comp: ctx.btComp, layers: batchNames,
                   tool: "set_effect_param",
                   args: { effect: "Gaussian Blur", param: "Blurriness",
                           value: 12 } };
        },
        check: function (d) {
          return d.succeeded === 60 ||
                 "succeeded " + d.succeeded + " of 60. " + d.failures;
        } },

      { name: "batch: the LAST layer really took the value",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   property: "effects/Gaussian Blur/Blurriness" };
        },
        check: function (d) {
          return Math.abs(Number(d.value) - 12) < 1e-6 ||
                 "Blurriness reads " + d.value + ", not 12";
        } },

      // ---- what the MODEL is told about a big comp -----------------
      // A 200-layer comp serialized to 30 KB against a 6 KB prompt
      // budget, so the panel's byte-slice dropped the comp out of the
      // system prompt entirely — the model saw no layers and never
      // learned which one the user had selected. The list is capped
      // here now, where the omission can be described.

      { name: "big comp: the layer list is capped for the model",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.btComp }; },
        check: function (d) {
          if (d.numLayers !== 60) return "numLayers " + d.numLayers + ", not 60";
          if (d.layers.length > 41) {
            return "sent " + d.layers.length + " layer rows uncapped";
          }
          if (d.layersShown !== d.layers.length) {
            return "layersShown says " + d.layersShown + ", sent " +
                   d.layers.length;
          }
          return true;
        } },

      { name: "big comp: and the cap stays inside the prompt budget",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.btComp }; },
        check: function (d) {
          var bytes = JSON.stringify(d).length;
          return bytes < 6000 ||
                 "a capped comp still serializes to " + bytes + " bytes";
        } },

      { name: "big comp: the omission is stated, with the true total",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.btComp }; },
        check: function (d) {
          var note = String(d.note || "");
          if (!note) return "no note — the model is not told anything is missing";
          if (note.indexOf("of 60 layers") === -1) {
            return "note does not name the real total: " + note;
          }
          if (note.indexOf("start:") === -1 || note.indexOf("limit:0") === -1) {
            return "note does not say how to get the rest: " + note;
          }
          return true;
        } },

      { name: "big comp: start/limit really pages through the stack",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.btComp, start: 51, limit: 5 }; },
        check: function (d) {
          var L = d.layers || [];
          if (L.length !== 5) return "asked for 5 rows, got " + L.length;
          if (L[0].index !== 51) return "page starts at index " + L[0].index;
          if (L[4].index !== 55) return "page ends at index " + L[4].index;
          return true;
        } },

      { name: "big comp: limit:0 still hands back every layer",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.btComp, limit: 0 }; },
        check: function (d) {
          if (d.layers.length !== 60) {
            return "limit:0 returned " + d.layers.length + " of 60";
          }
          return !d.note || "an uncapped result should carry no note: " + d.note;
        } },

      { name: "big project: the item list is capped but keeps the comps",
        tool: "get_project_info",
        args: {},
        check: function (d, ctx) {
          if (d.items.length > 40) {
            return "sent " + d.items.length + " item rows uncapped";
          }
          if (d.itemsShown !== d.items.length) {
            return "itemsShown says " + d.itemsShown + ", sent " +
                   d.items.length;
          }
          // The scratch comps must survive: every comp argument the model
          // writes is a NAME it read out of this list.
          var seen = {}, i;
          for (i = 0; i < d.items.length; i++) seen[d.items[i].name] = true;
          if (!seen[ctx.btComp]) {
            return "the comp under test (" + ctx.btComp + ") was dropped " +
                   "from a " + d.numItems + "-item project";
          }
          if (d.items.length < d.numItems && !d.note) {
            return "items were dropped with no note saying so";
          }
          return true;
        } },

      { name: "batch: note the project size",
        tool: "get_project_info",
        args: {},
        check: function (d, ctx) { ctx.btItems = d.numItems; return true; } },

      { name: "batch: a comp-level tool is REFUSED (create_comp)",
        tool: "for_each_layer",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.btComp, layers: ["ST Batch", "ST Batch 2"],
                   tool: "create_comp",
                   args: { name: "ST Batch Junk", width: 100, height: 100,
                           duration: 1, frameRate: 30 } };
        },
        check: function (e) {
          if (!/no per-layer target/.test(e)) return "message was: " + e;
          if (!/Drivable tools/.test(e)) return "nothing listed as valid: " + e;
          return true;
        } },

      { name: "batch: and NO junk comps were created",
        tool: "get_project_info",
        args: {},
        check: function (d, ctx) {
          return d.numItems === ctx.btItems ||
                 "project grew from " + ctx.btItems + " to " + d.numItems +
                 " items — the refused tool ran anyway";
        } },

      { name: "batch: add_solid is REFUSED, not run 60 times",
        tool: "for_each_layer",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.btComp, layers: batchNames, tool: "add_solid",
                   args: { name: "ST Batch Spawn", width: 20, height: 20 } };
        },
        check: function (e) {
          return /no per-layer target/.test(e) || "message was: " + e;
        } },

      { name: "batch: and the comp still holds exactly 60 layers",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.btComp }; },
        check: function (d) {
          return d.numLayers === 60 ||
                 "comp holds " + d.numLayers + " layers, not 60";
        } },

      { name: "batch: an already-batched tool is REFUSED (grid_layout)",
        tool: "for_each_layer",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.btComp, layers: batchNames, tool: "grid_layout",
                   args: { columns: 6 } };
        },
        check: function (e) {
          return (/already takes its own/.test(e) && /ONCE/.test(e)) ||
                 "message was: " + e;
        } },

      { name: "batch: a READ tool is REFUSED (its values would be lost)",
        tool: "for_each_layer",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.btComp, layers: batchNames, tool: "get_property",
                   args: { property: "transform/Position" } };
        },
        check: function (e) {
          return /discarded/.test(e) || "message was: " + e;
        } },

      // ---- one host call, many tools: what makes a chat command ONE
      // Ctrl+Z. An undo group does not survive the end of the script
      // execution that opened it (measured in AE 2026), so the panel fuses
      // a round's consecutive tools into a single AELL_callBatch instead of
      // bracketing them. These steps prove the batch entry point really
      // runs them, in order, with each command's own outcome. Its own comp,
      // so a batch that misfires cannot touch the groups above.
      { name: "create the batch-call comp",
        tool: "create_comp",
        args: { name: UNCOMP, width: 320, height: 240, duration: 4,
                frameRate: 30 },
        check: function (d, ctx) { ctx.unComp = d.name; return true; } },

      { name: "one call runs three tools in order",
        batch: function (ctx) {
          return [
            { tool: "add_solid",
              args: { comp: ctx.unComp, name: "ST Bat A", color: [1, 0, 0],
                      width: 40, height: 40 } },
            { tool: "add_solid",
              args: { comp: ctx.unComp, name: "ST Bat B", color: [0, 1, 0],
                      width: 40, height: 40 } },
            { tool: "apply_effect",
              args: { comp: ctx.unComp, layer: "ST Bat A",
                      effect: "Gaussian Blur" } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + i + " failed: " + rows[i].error;
          }
          return rows[0].data.name === "ST Bat A" &&
                 rows[1].data.name === "ST Bat B" ||
                 "rows came back out of order: " + rows[0].data.name + ", " +
                 rows[1].data.name;
        } },

      { name: "the batched tools really landed in AE",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.unComp }; },
        check: function (d) {
          var names = [], withFx = [];
          for (var i = 0; i < d.layers.length; i++) {
            names.push(d.layers[i].name);
            if (d.layers[i].effects && d.layers[i].effects.length) {
              withFx.push(d.layers[i].name);
            }
          }
          if (names.join(",").indexOf("ST Bat A") === -1 ||
              names.join(",").indexOf("ST Bat B") === -1) {
            return "expected both solids, comp holds " + names.join(", ");
          }
          return withFx.join(",") === "ST Bat A" ||
                 "expected the effect on ST Bat A only, got " +
                 (withFx.join(", ") || "none");
        } },

      { name: "a failing command does not abort the rest of the batch",
        batch: function (ctx) {
          return [
            { tool: "set_transform",
              args: { comp: ctx.unComp, layer: "ST Bat A",
                      property: "position", value: [100, 100] } },
            { tool: "apply_effect",
              args: { comp: ctx.unComp, layer: "ST No Such Layer",
                      effect: "Gaussian Blur" } },
            { tool: "not_a_real_tool", args: {} },
            { tool: "set_transform",
              args: { comp: ctx.unComp, layer: "ST Bat B",
                      property: "position", value: [200, 200] } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "first command failed: " + rows[0].error;
          if (rows[1].ok) return "a missing layer was accepted";
          if (rows[2].ok) return "an unknown tool name was accepted";
          if (!/Unknown tool/.test(String(rows[2].error))) {
            return "unknown tool not named: " + rows[2].error;
          }
          return rows[3].ok ||
                 "the command AFTER the failures never ran: " + rows[3].error;
        } },

      { name: "the write after the failed command is really in the comp",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.unComp, layer: "ST Bat B",
                   property: "transform/Position" };
        },
        check: function (d) {
          var v = d.value || [];
          return (v[0] === 200 && v[1] === 200) ||
                 "position is " + JSON.stringify(v) + ", expected [200, 200]";
        } },

      // ---- set_solid_color. A solid's colour lives on the SOURCE, and
      // duplicate_layer hands out layers that share one — measured in AE
      // 2026: duplicate twice and all three report the same source id,
      // and one write to mainSource.color turns all three. So the tool
      // has to refuse a partial recolour rather than surprise anyone.
      { name: "create the solid-colour comp",
        tool: "create_comp",
        args: { name: "ST Solid Room", width: 320, height: 240,
                duration: 3, frameRate: 30 },
        check: function (d, ctx) { ctx.scComp = d.name; return true; } },

      { name: "one red solid, duplicated twice — three sharing one solid",
        batch: function (ctx) {
          return [
            { tool: "add_solid",
              args: { comp: ctx.scComp, name: "ST SC Square",
                      color: [1, 0, 0], width: 60, height: 60 } },
            { tool: "duplicate_layer",
              args: { comp: ctx.scComp, layer: "ST SC Square", count: 2 } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok || !rows[1].ok) {
            return "rig failed: " + (rows[0].error || rows[1].error);
          }
          return true;
        } },

      { name: "recolouring ONE of three sharers is refused, not silent",
        tool: "set_solid_color",
        args: function (ctx) {
          return { comp: ctx.scComp, layer: "ST SC Square",
                   color: [0, 1, 0] };
        },
        expectError: true,
        check: function (e) {
          return (/SHARED/.test(e) && /makeUnique/.test(e)) ||
                 "expected the shared-solid refusal, got: " + e;
        } },

      { name: "makeUnique:true recolours only the layer named",
        tool: "set_solid_color",
        args: function (ctx) {
          return { comp: ctx.scComp, layer: "ST SC Square",
                   color: [0, 1, 0], makeUnique: true };
        },
        check: function (d) {
          return (d.madeUnique && d.madeUnique.length === 1) ||
                 "expected one layer given its own solid, got " +
                 JSON.stringify(d.madeUnique || d);
        } },

      { name: "and the other two really are still red",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.scComp }; },
        check: function (d) {
          // get_comp_details does not carry solid colour, so this step
          // proves only that the rig is intact; the colour itself is
          // asserted by the tool's own result above and by the stubbed
          // suite, where the source objects are inspectable.
          var n = 0, i;
          for (i = 0; i < d.layers.length; i++) {
            if (/^ST SC Square/.test(d.layers[i].name)) n++;
          }
          return n === 3 ||
                 "expected the three squares to survive, found " + n;
        } },

      { name: "recolouring ALL the sharers together is allowed",
        tool: "set_solid_color",
        args: function (ctx) {
          return { comp: ctx.scComp,
                   layers: ["ST SC Square 2", "ST SC Square 3"],
                   color: [0, 0, 1] };
        },
        check: function (d) {
          if (d.solidsTouched !== 1) {
            return "expected ONE solid touched, got " + d.solidsTouched;
          }
          return (d.alsoChanged === undefined) ||
                 "nothing should have been collateral, got " +
                 JSON.stringify(d.alsoChanged);
        } },

      { name: "add a text layer for set_solid_color to refuse",
        tool: "add_text_layer",
        args: function (ctx) {
          // add_text_layer names the layer from its TEXT — there is no
          // name argument — so the text IS the handle used below.
          return { comp: ctx.scComp, text: "ST SC Words" };
        },
        check: function () { return true; } },

      { name: "a text layer is refused, and told where its colour lives",
        tool: "set_solid_color",
        args: function (ctx) {
          return { comp: ctx.scComp, layer: "ST SC Words",
                   color: [1, 0, 0] };
        },
        expectError: true,
        check: function (e) {
          if (!/only works on SOLID layers/.test(e)) {
            return "expected the not-a-solid refusal, got: " + e;
          }
          return /set_text_style/.test(e) ||
                 "the refusal should name the tool that DOES set text " +
                 "colour, got: " + e;
        } },

      { name: "cleanup: delete the solid-colour comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.scComp }; },
        check: function () { return true; } },

      // ---- rolling back a round that failed PART WAY.
      //
      // The field bug: duplicate_layer errored because add_solid had not
      // made the source layer yet, add_solid succeeded anyway, and the
      // model — seeing a failed round — redid the whole thing, leaving
      // TEN squares where nine were asked for. Every tool had behaved
      // correctly; nothing undid the half that landed.
      //
      // Measured in AE 2026 before this shipped (WORKPLAN-LOG 2026-08-25):
      // an EMPTY undo group registers nothing, so one Undo would reach
      // the user's own previous edit — which is why the batch writes a
      // net-zero sentinel first. The Undo is issued inside the same
      // script execution that made the changes, exactly once, and a
      // fingerprint mismatch is answered with a single Redo rather than
      // a second Undo.
      { name: "create the rollback comp",
        tool: "create_comp",
        args: { name: "ST Rollback", width: 320, height: 240, duration: 4,
                frameRate: 30 },
        check: function (d, ctx) { ctx.rbComp = d.name; return true; } },

      { name: "an armed round that fails part way is rolled back",
        batchOpts: { rollback: true },
        batch: function (ctx) {
          return [
            { tool: "duplicate_layer",
              args: { comp: ctx.rbComp, layer: "ST No Source", count: 3 } },
            { tool: "add_solid",
              args: { comp: ctx.rbComp, name: "ST RB Orphan",
                      color: [1, 0, 0], width: 40, height: 40 } }
          ];
        },
        check: function (rows) {
          if (rows[1].ok) {
            return "the command that succeeded is still reported ok, so " +
                   "the model would build on a layer that no longer exists";
          }
          if (!rows[0].rolledBack || !rows[1].rolledBack) {
            return "rows not marked rolledBack: " +
                   JSON.stringify(rows[0]).slice(0, 140);
          }
          return /ROLLED BACK/.test(String(rows[0].error)) ||
                 "no explanation for the model: " + rows[0].error;
        } },

      { name: "and the comp is empty again — no orphan left behind",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.rbComp }; },
        check: function (d) {
          if (!d.layers.length) return true;
          var names = [];
          for (var i = 0; i < d.layers.length; i++) names.push(d.layers[i].name);
          return "expected an empty comp, it holds " + names.join(", ");
        } },

      { name: "the SAME round unarmed leaves its debris (what changed)",
        batch: function (ctx) {
          return [
            { tool: "duplicate_layer",
              args: { comp: ctx.rbComp, layer: "ST No Source", count: 3 } },
            { tool: "add_solid",
              args: { comp: ctx.rbComp, name: "ST RB Orphan",
                      color: [1, 0, 0], width: 40, height: 40 } }
          ];
        },
        check: function (rows) {
          if (rows[0].ok) return "duplicate_layer should have failed";
          if (rows[0].rolledBack) return "an unarmed round was rolled back";
          return rows[1].ok ||
                 "add_solid should still have run: " + rows[1].error;
        } },

      { name: "so the orphan IS there when nothing rolls it back",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.rbComp }; },
        check: function (d) {
          return (d.layers.length === 1 &&
                  d.layers[0].name === "ST RB Orphan") ||
                 "expected the one orphan, comp holds " + d.layers.length +
                 " layer(s)";
        } },

      { name: "an armed round where everything works is left alone",
        batchOpts: { rollback: true },
        batch: function (ctx) {
          return [
            { tool: "add_solid",
              args: { comp: ctx.rbComp, name: "ST RB Keep A",
                      color: [0, 1, 0], width: 40, height: 40 } },
            { tool: "add_solid",
              args: { comp: ctx.rbComp, name: "ST RB Keep B",
                      color: [0, 0, 1], width: 40, height: 40 } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok || !rows[1].ok) {
            return "a plain round failed: " + (rows[0].error || rows[1].error);
          }
          return (!rows[0].rolledBack && !rows[1].rolledBack) ||
                 "a fully successful round was rolled back";
        } },

      { name: "a failing READ does not throw the round's real work away",
        batchOpts: { rollback: true },
        batch: function (ctx) {
          return [
            { tool: "add_solid",
              args: { comp: ctx.rbComp, name: "ST RB Survivor",
                      color: [1, 1, 0], width: 40, height: 40 } },
            { tool: "get_property",
              args: { comp: ctx.rbComp, layer: "ST No Such Layer",
                      property: "transform/Position" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "add_solid failed: " + rows[0].error;
          if (rows[0].rolledBack) {
            return "a bad lookup threw away real work — read-only " +
                   "failures must not trigger a rollback";
          }
          return !rows[1].ok || "the missing layer was accepted";
        } },

      { name: "and the survivor is really still in the comp",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.rbComp }; },
        check: function (d) {
          var names = [];
          for (var i = 0; i < d.layers.length; i++) names.push(d.layers[i].name);
          return names.join(",").indexOf("ST RB Survivor") !== -1 ||
                 "survivor missing, comp holds " + (names.join(", ") || "nothing");
        } },

      { name: "cleanup: delete the rollback comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.rbComp }; },
        check: function () { return true; } },

      // ---- Lights (WORKPLAN item 2, last bullet) ---------------------
      // Their own scratch comp, like the cameras: a light is a rigger,
      // and the grid/scale steps above must not have to know about it.
      //
      // What makes lights worth a suite group is that they LIE. Measured
      // in AE 2026 (WORKPLAN-LOG 2026-08-26): `canSetValue` is false on
      // every light property INCLUDING the ones that write fine, `elided`
      // is false everywhere, and the Light Options group hands out all 14
      // properties whatever the type is. So nothing about a light can be
      // discovered by inspection — only by attempting the write. These
      // steps are the standing proof that the table in add_light still
      // matches the AE on this machine.
      { name: "light scratch comp",
        tool: "create_comp",
        args: { name: LTCOMP, width: 800, height: 600, duration: 4,
                frameRate: 30 },
        check: function (d, ctx) {
          ctx.ltComp = d.name;
          return typeof d.id === "number" || !!d.id || "no comp id";
        } },

      { name: "a spot light takes every option AE gives it",
        tool: "add_light",
        args: function (ctx) {
          return { comp: ctx.ltComp, name: "ST Light Spot", type: "spot",
                   position: [100, 200, -300], pointOfInterest: [400, 300, 0],
                   intensity: 80, color: [1, 0.5, 0],
                   coneAngle: 60, coneFeather: 25,
                   falloff: "smooth", radius: 111, falloffDistance: 222,
                   castsShadows: true, shadowDarkness: 70,
                   shadowDiffusion: 12 };
        },
        check: function (d) {
          if (d.refused) return "refused: " + d.refused;
          if (d.type !== "spot") return "type " + d.type;
          // Every one of the twelve must be reported applied, or the
          // per-type table has drifted from this AE.
          var want = ["position", "pointOfInterest", "intensity", "color",
                      "coneAngle", "coneFeather", "falloff", "radius",
                      "falloffDistance", "castsShadows", "shadowDarkness",
                      "shadowDiffusion"];
          for (var i = 0; i < want.length; i++) {
            if ((d.applied || "").indexOf(want[i]) === -1) {
              return "not applied: " + want[i] + " (got " + d.applied + ")";
            }
          }
          return true;
        } },

      { name: "spot-only cone angle really landed",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "Cone Angle" };
        },
        check: function (d) {
          return Math.abs(d.value - 60) < 0.01 || "cone angle " + d.value;
        } },

      // AE's own layer-level name shortcut does NOT cover Radius or
      // Falloff Distance, though it covers Cone Angle, Intensity, Color,
      // Cone Feather, Casts Shadows, Shadow Darkness and Shadow Diffusion
      // in the very same group (measured name by name, 2026-08-28: the
      // three it misses are exactly the ones AE added with falloff). The
      // group path always worked and these steps pin that it still does;
      // the bare name works too now, through the deep search, and its own
      // steps are further down.
      { name: "falloff was written BEFORE radius (it gates it)",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "light/Radius" };
        },
        check: function (d) {
          return Math.abs(d.value - 111) < 0.01 ||
                 "radius " + d.value + " — Falloff must be set first or " +
                 "AE hides Radius entirely";
        } },

      { name: "falloff distance landed too (smooth keeps it)",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "light/Falloff Distance" };
        },
        check: function (d) {
          return Math.abs(d.value - 222) < 0.01 || "distance " + d.value;
        } },

      { name: "castsShadows became AE's 1, not a raw boolean",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "Casts Shadows" };
        },
        check: function (d) { return d.value === 1 || "value " + d.value; } },

      { name: "Point of Interest is the Anchor Point on a light",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "Point of Interest" };
        },
        check: function (d) {
          var v = d.value || [];
          return (Math.abs(v[0] - 400) < 0.6 && Math.abs(v[1] - 300) < 0.6) ||
                 "POI " + JSON.stringify(v);
        } },

      { name: "a point light has no cone angle, and the refusal says who does",
        tool: "add_light",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.ltComp, type: "point", coneAngle: 45 };
        },
        check: function (err) {
          if (err.indexOf("spot") === -1) return "does not name spot: " + err;
          // A grounded refusal has to leave the model somewhere to go.
          return err.indexOf("shadowDiffusion") !== -1 ||
                 "does not list what a point light accepts: " + err;
        } },

      { name: "an ambient light has no position at all",
        tool: "add_light",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.ltComp, type: "ambient", position: [1, 2, 3] };
        },
        check: function (err) {
          return err.indexOf("parallel, spot, point") !== -1 ||
                 "refusal does not say which types are positionable: " + err;
        } },

      { name: "radius without falloff is refused with the fix",
        tool: "add_light",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.ltComp, type: "spot", radius: 300 };
        },
        check: function (err) {
          return err.indexOf("smooth") !== -1 || "no way forward: " + err;
        } },

      // The refusals above must not have littered the comp with the
      // half-built lights they declined to finish.
      { name: "three refusals created no light layers",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.ltComp }; },
        check: function (d) {
          var layers = d.layers || [];
          var lights = 0, i;
          for (i = 0; i < layers.length; i++) {
            if (layers[i].type === "light") lights++;
          }
          return lights === 1 ||
                 lights + " lights, expected 1 (validate-before-create)";
        } },

      { name: "ambient still takes intensity and colour",
        tool: "add_light",
        args: function (ctx) {
          return { comp: ctx.ltComp, name: "ST Light Amb", type: "ambient",
                   intensity: 30, color: [0, 0, 1] };
        },
        check: function (d) {
          return d.applied === "intensity, color" ||
                 "applied '" + d.applied + "'";
        } },

      { name: "and that intensity is readable back off the ambient light",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Amb",
                   property: "Intensity" };
        },
        check: function (d) {
          return Math.abs(d.value - 30) < 0.01 || "intensity " + d.value;
        } },

      // Same rule cameras needed: NO_AUTO_ORIENT hides the Point of
      // Interest, so it has to be set before any POI write or the write
      // throws. Asking for both is a refusal rather than a silent choice.
      { name: "one-node light plus a Point of Interest is refused",
        tool: "add_light",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.ltComp, type: "spot", oneNode: true,
                   pointOfInterest: [1, 2, 3] };
        },
        check: function (err) {
          return err.indexOf("oneNode") !== -1 ||
                 err.indexOf("one-node") !== -1 || "unexpected: " + err;
        } },

      { name: "a one-node light builds, and Position still lands after it",
        tool: "add_light",
        args: function (ctx) {
          return { comp: ctx.ltComp, name: "ST Light Free", type: "spot",
                   oneNode: true, position: [5, 6, 7], coneAngle: 33 };
        },
        check: function (d) {
          return (d.applied || "").indexOf("position") !== -1 ||
                 "applied '" + d.applied + "'";
        } },

      { name: "...and Position really reads back",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Free",
                   property: "Position" };
        },
        check: function (d) {
          var v = d.value || [];
          return (Math.abs(v[0] - 5) < 0.01 && Math.abs(v[2] - 7) < 0.01) ||
                 "position " + JSON.stringify(v);
        } },

      // AE 2026 has a FIFTH light type that predates none of the four in
      // training. If a future AE drops it, this step is where we find out.
      { name: "environment is a real light type in this AE",
        tool: "add_light",
        args: function (ctx) {
          return { comp: ctx.ltComp, name: "ST Light Env",
                   type: "environment", intensity: 50 };
        },
        check: function (d) {
          return d.type === "environment" || "type " + d.type;
        } },

      { name: "an unknown light type lists the real ones",
        tool: "add_light",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.ltComp, type: "spotlight" };
        },
        check: function (err) {
          return err.indexOf("parallel, spot, point, ambient") !== -1 ||
                 "ungrounded: " + err;
        } },

      // Light KEYFRAMES. docs/CAPABILITIES.md named this as the gap left
      // by add_light: every step above writes a STATIC option, so nothing
      // proved a light option can be animated at all. Measured here first
      // (2026-08-28): Intensity animates through its bare name, Cone Angle
      // only through the group path "light/Cone Angle" — the same split the
      // static steps above found, now pinned for keyframes too.
      { name: "a light's intensity takes keyframes",
        batch: function (ctx) {
          return [
            { tool: "add_keyframe",
              args: { comp: ctx.ltComp, layer: "ST Light Spot",
                      property: "Intensity", time: 0, value: 80 } },
            { tool: "add_keyframe",
              args: { comp: ctx.ltComp, layer: "ST Light Spot",
                      property: "Intensity", time: 2, value: 15 } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "first key refused: " + rows[0].error;
          if (!rows[1].ok) return "second key refused: " + rows[1].error;
          return rows[1].data.numKeys === 2 ||
                 "numKeys " + rows[1].data.numKeys;
        } },

      { name: "the intensity keys really hold both values",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "Intensity" };
        },
        check: function (d) {
          var k = d.keys || [];
          if (d.numKeys !== 2) return "numKeys " + d.numKeys;
          return (Math.abs(k[0].value - 80) < 0.01 &&
                  Math.abs(k[1].value - 15) < 0.01) ||
                 "keys " + JSON.stringify(k);
        } },

      { name: "a spot's cone angle animates too (group path)",
        batch: function (ctx) {
          return [
            { tool: "add_keyframe",
              args: { comp: ctx.ltComp, layer: "ST Light Spot",
                      property: "light/Cone Angle", time: 0, value: 60 } },
            { tool: "add_keyframe",
              args: { comp: ctx.ltComp, layer: "ST Light Spot",
                      property: "light/Cone Angle", time: 1, value: 20 } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "first key refused: " + rows[0].error;
          return (rows[1].ok && rows[1].data.numKeys === 2) ||
                 "second key: " + (rows[1].error || rows[1].data.numKeys);
        } },

      { name: "remove_keyframes takes ONE key off by time",
        tool: "remove_keyframes",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "light/Cone Angle", times: [1] };
        },
        check: function (d) {
          if (d.removed !== 1) return "removed " + d.removed;
          return d.remaining === 1 || "remaining " + d.remaining;
        } },

      { name: "...and with no times at all it clears the property",
        tool: "remove_keyframes",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "Intensity" };
        },
        check: function (d) {
          return (d.removed === 2 && d.remaining === 0) ||
                 "removed " + d.removed + ", remaining " + d.remaining;
        } },

      // ---- the deep search (WORKPLAN item 2 follow-up) ---------------
      // A light is where the gap was found: "Radius" and "Falloff
      // Distance" are the two options AE's layer-level shortcut cannot
      // see, so before the search the model's only way in was a group
      // path it had no reason to guess. These steps prove the bare name
      // now lands, that the result NAMES the path it had to hunt for
      // (that is how the model learns the real path), and that a name
      // which is nowhere still comes back grounded.
      { name: "a bare 'Radius' reaches what AE's shortcut hides",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "Radius" };
        },
        check: function (d) {
          if (Math.abs(d.value - 111) > 0.01) return "radius " + d.value;
          if (d.matchName !== "ADBE Light Falloff Start") {
            return "landed on " + d.matchName;
          }
          return d.resolvedPath === "Light Options/Radius" ||
                 "the hunt is not reported: " + d.resolvedPath;
        } },

      { name: "a matchName is a name too",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "ADBE Light Falloff Distance" };
        },
        check: function (d) {
          return Math.abs(d.value - 222) < 0.01 || "distance " + d.value;
        } },

      { name: "and the bare name WRITES, not just reads",
        batch: function (ctx) {
          return [
            { tool: "set_property",
              args: { comp: ctx.ltComp, layer: "ST Light Spot",
                      property: "Falloff Distance", value: 333 } },
            { tool: "get_property",
              args: { comp: ctx.ltComp, layer: "ST Light Spot",
                      property: "light/Falloff Distance" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "the write was refused: " + rows[0].error;
          if (rows[0].data.resolvedPath !== "Light Options/Falloff Distance") {
            return "wrote without saying where: " + rows[0].data.resolvedPath;
          }
          if (!rows[1].ok) return "read back refused: " + rows[1].error;
          return Math.abs(rows[1].data.value - 333) < 0.01 ||
                 "the group path still reads " + rows[1].data.value;
        } },

      { name: "a documented group path claims no hunt",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "light/Radius" };
        },
        check: function (d) {
          return typeof d.resolvedPath === "undefined" ||
                 "reported a search it never had to run: " + d.resolvedPath;
        } },

      { name: "a name that is nowhere still comes back grounded",
        tool: "get_property",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "Blurriness" };
        },
        check: function (err) {
          if (!/Children here/.test(err)) {
            return "lost the children list: " + err;
          }
          return /searched the whole tree/.test(err) ||
                 "does not say the tree was searched: " + err;
        } },

      { name: "...and a near miss names the real neighbours",
        tool: "get_property",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.ltComp, layer: "ST Light Spot",
                   property: "Diffusion" };
        },
        check: function (err) {
          return /Shadow Diffusion/.test(err) ||
                 "no near-name hint: " + err;
        } },

      { name: "cleanup: delete the light comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.ltComp }; },
        check: function () { return true; } },

      // ---- coverage rig. docs/CAPABILITIES.md computes which tools the
      // suite has never once called, and this group exists to shorten that
      // list: add_control, add_keyframe, remove_keyframes, set_layer_3d,
      // apply_expression_preset, list_properties, list_effects,
      // set_comp_setting, duplicate_comp, rename_item and move_to_folder
      // all shipped with real-AE steps behind them for the first time here.
      // Every expectation below was measured first (WORKPLAN-LOG
      // 2026-08-28), never assumed.
      //
      // Two tools stay deliberately uncovered and it is not an oversight:
      // organize_project files every LOOSE item at the project root, and
      // add_to_render_queue writes to the user's render queue — the suite
      // runs inside whatever project the user has open, so neither can be
      // exercised without reaching outside the scratch comps.
      { name: "coverage scratch comp",
        tool: "create_comp",
        args: { name: CVCOMP, width: 640, height: 480, duration: 5,
                frameRate: 25 },
        check: function (d, ctx) {
          ctx.cvComp = d.name;
          return typeof d.id === "number" || !!d.id || "no comp id";
        } },

      { name: "coverage rig: one solid to hang the rest on",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.cvComp, name: "ST Cov Box",
                   color: [0.2, 0.4, 1], width: 100, height: 100 };
        },
        check: function (d) {
          return d.name === "ST Cov Box" || "named " + d.name;
        } },

      { name: "add_control puts a named slider on the layer",
        tool: "add_control",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", type: "slider",
                   name: "ST Cov Amp", value: 40 };
        },
        check: function (d) {
          if (d.control !== "ST Cov Amp") return "control " + d.control;
          // The hint is the whole point of the tool: it hands the model the
          // exact link_property call to make next.
          return (d.hint || "").indexOf("link_property") !== -1 ||
                 "no link hint: " + d.hint;
        } },

      { name: "the slider's initial value really landed",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "effects/ST Cov Amp" };
        },
        check: function (d) {
          // A one-leaf control group resolves to its value property, so
          // "effects/<name>" reads the slider itself, not the group.
          if (String(d.matchName).indexOf("ADBE Slider Control") !== 0) {
            return "resolved to " + d.matchName;
          }
          return Math.abs(d.value - 40) < 0.01 || "value " + d.value;
        } },

      { name: "a point control takes a two-component value",
        tool: "add_control",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", type: "point",
                   name: "ST Cov Pt", value: [10, 20] };
        },
        check: function (d) { return d.type === "point" || "type " + d.type; } },

      { name: "...and it reads back as [10, 20]",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "effects/ST Cov Pt" };
        },
        check: function (d) {
          var v = d.value || [];
          return (Math.abs(v[0] - 10) < 0.01 && Math.abs(v[1] - 20) < 0.01) ||
                 "value " + JSON.stringify(v);
        } },

      { name: "an unknown control type lists the real ones",
        tool: "add_control",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", type: "spinner",
                   name: "ST Cov Bad" };
        },
        check: function (err) {
          return err.indexOf("slider, angle, checkbox, color or point") !== -1 ||
                 "ungrounded: " + err;
        } },

      { name: "a control with no name is refused, with an example",
        tool: "add_control",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", type: "slider" };
        },
        check: function (err) {
          return err.indexOf("'name' is required") !== -1 || "err: " + err;
        } },

      { name: "apply_expression_preset wires wiggle to that slider",
        tool: "apply_expression_preset",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "position", preset: "wiggle", frequency: 3,
                   ampControl: { layer: "ST Cov Box", effect: "ST Cov Amp" } };
        },
        check: function (d) {
          var e = String(d.expression || "");
          if (e.indexOf("wiggle(3,") !== 0) return "expression " + e;
          // The inline chained pickwhip form is the only one the panel
          // generates — a stored Property ref would break on rename.
          return e.indexOf('effect("ST Cov Amp")(1)') !== -1 ||
                 "amplitude is not driven by the control: " + e;
        } },

      { name: "AE really accepted it — the position is wiggling",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "transform/Position" };
        },
        check: function (d) {
          if (!d.expression) return "no expression on the property";
          var v = d.value || [];
          // The comp is 640x480, so an untouched centre reads [320, 240].
          // A live wiggle moves it; a DISABLED expression would not.
          return (Math.abs(v[0] - 320) > 0.001 ||
                  Math.abs(v[1] - 240) > 0.001) ||
                 "value is still dead centre: " + JSON.stringify(v);
        } },

      { name: "time_linear refuses an ARRAY property and says what to do",
        tool: "apply_expression_preset",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "position", preset: "time_linear" };
        },
        check: function (err) {
          return err.indexOf("link_property") !== -1 ||
                 "no route out of the refusal: " + err;
        } },

      { name: "an unknown preset lists the five that exist",
        tool: "apply_expression_preset",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "rotation", preset: "bounce" };
        },
        check: function (err) {
          return err.indexOf("wiggle, loop_cycle, loop_pingpong, " +
                             "loop_offset, time_linear") !== -1 ||
                 "ungrounded: " + err;
        } },

      { name: "add_keyframe stacks three keys and counts them",
        batch: function (ctx) {
          return [
            { tool: "add_keyframe",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "rotation", time: 0, value: 0 } },
            { tool: "add_keyframe",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "rotation", time: 1, value: 90 } },
            { tool: "add_keyframe",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "rotation", time: 2, value: 180 } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "key " + i + " refused: " + rows[i].error;
            if (rows[i].data.numKeys !== i + 1) {
              return "key " + i + " reported numKeys " + rows[i].data.numKeys;
            }
          }
          return true;
        } },

      { name: "add_keyframe without a time is refused",
        tool: "add_keyframe",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "rotation", value: 45 };
        },
        check: function (err) {
          return err.indexOf("'time'") !== -1 || "err: " + err;
        } },

      { name: "remove_keyframes drops the MIDDLE key by time",
        tool: "remove_keyframes",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "rotation", times: [1] };
        },
        check: function (d) {
          return (d.removed === 1 && d.remaining === 2) ||
                 "removed " + d.removed + ", remaining " + d.remaining;
        } },

      { name: "and the two that survived are the OUTER ones",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "rotation" };
        },
        check: function (d) {
          var k = d.keys || [];
          if (d.numKeys !== 2) return "numKeys " + d.numKeys;
          return (Math.abs(k[0].time - 0) < 0.001 &&
                  Math.abs(k[1].time - 2) < 0.001) ||
                 "surviving keys at " + JSON.stringify(k);
        } },

      { name: "a GROUP is refused by remove_keyframes",
        tool: "remove_keyframes",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "transform" };
        },
        check: function (err) {
          return err.indexOf("GROUP") !== -1 || "err: " + err;
        } },

      { name: "remove_keyframes with no times clears what is left",
        tool: "remove_keyframes",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "rotation" };
        },
        check: function (d) {
          return (d.removed === 2 && d.remaining === 0) ||
                 "removed " + d.removed + ", remaining " + d.remaining;
        } },

      // set_layer_3d, and the two AE facts underneath it. Measured
      // 2026-08-28: the Transform group hands out the SAME children for a
      // 2D and a 3D layer — Z Position included — so nothing in the
      // property tree can tell you whether a layer is 3D. Only
      // threeDLayer can, which is exactly why the panel never infers
      // 3D-ness from value.length.
      { name: "list_properties: a 2D layer already advertises Z Position",
        tool: "list_properties",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", path: "transform",
                   depth: 1 };
        },
        check: function (d, ctx) {
          var paths = [], matches = [];
          for (var i = 0; i < d.properties.length; i++) {
            paths.push(d.properties[i].path);
            matches.push(d.properties[i].matchName);
          }
          ctx.cv2dTransform = paths.join("|");
          ctx.cv2dMatches = matches.join("|");
          if (paths.join("|").indexOf("transform/Z Position") === -1) {
            return "no Z Position on the 2D layer: " + paths.join(", ");
          }
          // matchName is what the model needs when display names collide.
          for (i = 0; i < d.properties.length; i++) {
            if (d.properties[i].path === "transform/Position") {
              return d.properties[i].matchName === "ADBE Position" ||
                     "Position matchName " + d.properties[i].matchName;
            }
          }
          return "no Position entry at all";
        } },

      { name: "set_layer_3d turns the layer 3D",
        tool: "set_layer_3d",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", enabled: true };
        },
        check: function (d) {
          return d.threeD === true || "threeD " + d.threeD;
        } },

      // ...and the sting: the tree holds the same twelve properties with
      // the same matchNames, but AE RENAMES one of them. "Rotation" on a
      // 2D layer is "Z Rotation" on a 3D one — same ADBE Rotate Z. So a
      // display-name path stored before the layer went 3D stops resolving,
      // while the matchName and the friendly alias never move. Measured
      // 2026-08-28, after this step first went in asserting (wrongly) that
      // the two trees were identical and real AE said otherwise.
      { name: "...same properties, same matchNames, ONE renamed",
        tool: "list_properties",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", path: "transform",
                   depth: 1 };
        },
        check: function (d, ctx) {
          var paths = [], matches = [];
          for (var i = 0; i < d.properties.length; i++) {
            paths.push(d.properties[i].path);
            matches.push(d.properties[i].matchName);
          }
          if (matches.join("|") !== ctx.cv2dMatches) {
            return "the 3D tree holds DIFFERENT properties, not just " +
                   "different names: " + matches.join(", ");
          }
          var was = ctx.cv2dTransform.split("|");
          var moved = [];
          for (i = 0; i < paths.length; i++) {
            if (paths[i] !== was[i]) moved.push(was[i] + " -> " + paths[i]);
          }
          return moved.join(", ") ===
                 "transform/Rotation -> transform/Z Rotation" ||
                 "expected only Rotation to be renamed, got: " +
                 (moved.join(", ") || "no renames at all");
        } },

      // And the asymmetry, measured rather than assumed: a 3D layer
      // answers to BOTH names — AE keeps the old one working — while a 2D
      // layer has never heard of "Z Rotation". So a path written while the
      // layer was 2D survives the switch; one written while it was 3D does
      // not survive the switch back. The step below the 3D-off proves the
      // second half.
      { name: "a 3D layer answers to BOTH rotation names",
        batch: function (ctx) {
          return [
            { tool: "get_property",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "transform/Z Rotation" } },
            { tool: "get_property",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "transform/Rotation" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "the NEW name is refused: " + rows[0].error;
          if (!rows[1].ok) return "the OLD name stopped working: " +
                                  rows[1].error;
          return (rows[0].data.matchName === "ADBE Rotate Z" &&
                  rows[1].data.matchName === "ADBE Rotate Z") ||
                 "they are not the same property: " +
                 rows[0].data.matchName + " / " + rows[1].data.matchName;
        } },

      { name: "...but the friendly alias never moves",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "rotation" };
        },
        check: function (d) {
          return d.matchName === "ADBE Rotate Z" ||
                 "resolved to " + d.matchName;
        } },

      { name: "Z really writes once the layer is 3D",
        tool: "set_transform",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "anchorPoint", value: [10, 20, -150] };
        },
        check: function (d) {
          var v = d.value || [];
          return Math.abs(v[2] + 150) < 0.01 ||
                 "z did not take: " + JSON.stringify(v);
        } },

      // The 3D switch is destructive on the way back, so the next two
      // steps arm every kind of value it takes and then read the receipt.
      // Anchor Point Z is already -150 from the step above; this adds a
      // 3D-only rotation and a KEYFRAMED Z, because a layer whose Z is 0
      // at the current time but 500 at the next keyframe loses just as
      // much, and a tool that only looked at the static value would call
      // that lossless. Position here also still carries the rig's wiggle
      // expression, which is the case that broke the first version of
      // this: read expression-before-keyframes, the report named the
      // wiggle's own noise and never mentioned the 500.
      { name: "arm the 3D-only values the switch will take",
        batch: function (ctx) {
          return [
            { tool: "set_property",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "transform/X Rotation", value: 44 } },
            { tool: "add_keyframe",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "transform/Position", time: 0,
                      value: [100, 100, 0] } },
            { tool: "add_keyframe",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "transform/Position", time: 1,
                      value: [100, 100, 500] } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "step " + i + ": " + rows[i].error;
          }
          return true;
        } },

      // Pinning a LOSS and its receipt. AE zeroes Position/Anchor Point Z,
      // resets Scale Z to 100 and clears Orientation and X/Y Rotation on
      // the way to 2D, keyframes included, and turning 3D back on does NOT
      // bring them back (measured 2026-08-28). The loss is AE's and the
      // user asked for it, so the tool neither refuses nor restores — but
      // nothing in this project disappears quietly, so it reports.
      { name: "turning 3D off reports the Z it discarded",
        batch: function (ctx) {
          return [
            { tool: "set_layer_3d",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      enabled: false } },
            { tool: "get_property",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "transform/Anchor Point" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "set_layer_3d failed: " + rows[0].error;
          if (rows[0].data.threeD !== false) return "still 3D";
          var lost = rows[0].data.discarded;
          if (!lost || !lost.length) return "the loss went unreported";
          var text = lost.join("; ");
          if (text !== "Position Z on 1 of 2 keyframes (largest 500); " +
                       "Anchor Point Z -150; X Rotation 44") {
            return "unexpected discard report: " + text;
          }
          if (!rows[1].ok) return "read-back failed: " + rows[1].error;
          // ...and the loss is real, not just reported.
          var v = rows[1].data.value || [];
          return Math.abs(v[2]) < 0.01 ||
                 "AE kept the Z this time: " + JSON.stringify(v);
        } },

      { name: "...and a layer that was already 2D discards nothing",
        tool: "set_layer_3d",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", enabled: false };
        },
        check: function (d) {
          if (d.threeD !== false) return "threeD " + d.threeD;
          return !d.discarded ||
                 "a no-op switch claimed a loss: " + d.discarded.join("; ");
        } },

      { name: "back in 2D, the 3D-era name is gone (the asymmetry)",
        tool: "get_property",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "transform/Z Rotation" };
        },
        check: function (err) {
          return err.indexOf("Rotation") !== -1 ||
                 "the refusal does not list what is there now: " + err;
        } },

      { name: "list_properties on a LEAF sends you to get_property",
        tool: "list_properties",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   path: "transform/Position" };
        },
        check: function (err) {
          return err.indexOf("get_property") !== -1 || "err: " + err;
        } },

      // A layer root lists TWO groups both called "Geometry Options"
      // (ADBE Plane Options Group and ADBE Extrsn Options Group) —
      // measured on this AE. Display-name paths are therefore not unique,
      // which is the whole reason every entry carries a matchName.
      { name: "the layer root's display names really do collide",
        tool: "list_properties",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", depth: 1 };
        },
        check: function (d) {
          var seen = {}, dupe = null, matches = {};
          for (var i = 0; i < d.properties.length; i++) {
            var p = d.properties[i];
            if (seen[p.path]) {
              dupe = p.path;
              if (matches[p.path] === p.matchName) {
                return "two entries with the SAME path AND matchName: " +
                       p.path + " / " + p.matchName;
              }
            }
            seen[p.path] = true;
            matches[p.path] = p.matchName;
          }
          return !!dupe ||
                 "no colliding display names — if AE stopped shipping two " +
                 "Geometry Options groups this step can go";
        } },

      // The other half of the deep search: rank, and the refusal to pick.
      // A bare name is searched root by root in a MEASURED order, because
      // AE hands every layer all eleven Layer Styles whether or not one
      // was ever applied — ten latent "Opacity"s and seven "Color"s sit
      // at depth 3 on a plain solid, shallower than a shape's real Size
      // at depth 5. Shallowest-wins would answer from a style nobody
      // added, so Layer Styles is searched LAST and Transform first.
      { name: "'Opacity' still means the Transform one, not a layer style",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "Opacity" };
        },
        check: function (d) {
          return d.matchName === "ADBE Opacity" ||
                 "resolved to " + d.matchName;
        } },

      { name: "an effect param resolves by its bare name",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "ST Cov Amp" };
        },
        check: function (d) {
          if (Math.abs(d.value - 40) > 0.01) return "value " + d.value;
          return d.resolvedPath === "Effects/ST Cov Amp/Slider" ||
                 "resolved to " + d.resolvedPath;
        } },

      { name: "a path that STARTS at the effect resolves too",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "ST Cov Pt/Point" };
        },
        check: function (d) {
          var v = d.value || [];
          return (Math.abs(v[0] - 10) < 0.01 && Math.abs(v[1] - 20) < 0.01) ||
                 "value " + JSON.stringify(v);
        } },

      { name: "two of the same effect, and the second is named ' 2'",
        batch: function (ctx) {
          return [
            { tool: "apply_effect",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      effect: "Gaussian Blur" } },
            { tool: "apply_effect",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      effect: "Gaussian Blur" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "first blur refused: " + rows[0].error;
          if (!rows[1].ok) return "second blur refused: " + rows[1].error;
          return rows[1].data.effect === "Gaussian Blur 2" ||
                 "AE named the copy " + rows[1].data.effect;
        } },

      { name: "a tie is refused with both real paths, never guessed",
        tool: "get_property",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "Blurriness" };
        },
        check: function (err) {
          if (!/ambiguous/.test(err)) return "it picked one: " + err;
          return (/Gaussian Blur\/Blurriness/.test(err) &&
                  /Gaussian Blur 2\/Blurriness/.test(err)) ||
                 "the refusal does not name both: " + err;
        } },

      // Read both BEFORE and after rather than assuming a default: a
      // freshly applied Gaussian Blur in AE 2026 comes up at Blurriness
      // 25, not 0, and a step that asserted 0 would have failed for a
      // reason that has nothing to do with the refusal it is testing.
      { name: "...and an ambiguous WRITE changes nothing",
        batch: function (ctx) {
          var one = { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "Effects/Gaussian Blur/Blurriness" };
          var two = { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "Effects/Gaussian Blur 2/Blurriness" };
          return [
            { tool: "get_property", args: one },
            { tool: "get_property", args: two },
            { tool: "set_property",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "Blurriness", value: 12 } },
            { tool: "get_property", args: one },
            { tool: "get_property", args: two }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (i === 2) continue;
            if (!rows[i].ok) return "read " + i + " refused: " + rows[i].error;
          }
          if (rows[2].ok) return "the ambiguous write went through";
          if (!/ambiguous/.test(rows[2].error)) {
            return "refused for another reason: " + rows[2].error;
          }
          if (rows[0].data.value === 12 || rows[1].data.value === 12) {
            return "one of them was already 12 — the step cannot tell a " +
                   "refusal from a write";
          }
          return (rows[3].data.value === rows[0].data.value &&
                  rows[4].data.value === rows[1].data.value) ||
                 "a refused write still moved something: " +
                 rows[0].data.value + "->" + rows[3].data.value + " / " +
                 rows[1].data.value + "->" + rows[4].data.value;
        } },

      { name: "list_effects filters by name OR category",
        tool: "list_effects",
        args: { filter: "blur" },
        check: function (d, ctx) {
          if (!d.total) return "no effects matched 'blur'";
          for (var i = 0; i < d.effects.length; i++) {
            var e = d.effects[i];
            var hay = (e.name + " " + e.category).toLowerCase();
            if (hay.indexOf("blur") === -1) {
              return "non-matching hit: " + e.name + " / " + e.category;
            }
            if (!e.matchName) return "hit with no matchName: " + e.name;
          }
          ctx.cvFx = d.effects;
          return true;
        } },

      { name: "...and {offset} pages through them exactly",
        tool: "list_effects",
        args: { filter: "blur", offset: 3 },
        check: function (d, ctx) {
          if (ctx.cvFx.length < 5) return true;   // too few to page
          return d.effects[0].matchName === ctx.cvFx[3].matchName ||
                 "offset 3 started at " + d.effects[0].name +
                 ", expected " + ctx.cvFx[3].name;
        } },

      { name: "set_comp_setting resizes and re-times the comp",
        tool: "set_comp_setting",
        args: function (ctx) {
          return { comp: ctx.cvComp, width: 800, height: 600, duration: 6,
                   frameRate: 24, bgColor: [1, 0, 0] };
        },
        check: function (d) {
          if (d.width !== 800 || d.height !== 600) {
            return "size " + d.width + "x" + d.height;
          }
          if (Math.abs(d.frameRate - 24) > 0.001) return "fps " + d.frameRate;
          return Math.abs(d.duration - 6) < 0.001 ||
                 "duration " + d.duration;
        } },

      { name: "and the project agrees the comp really changed",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          for (var i = 0; i < d.items.length; i++) {
            if (d.items[i].name !== ctx.cvComp) continue;
            var it = d.items[i];
            return (it.width === 800 && it.height === 600 &&
                    Math.abs(it.frameRate - 24) < 0.001) ||
                   "project reports " + it.width + "x" + it.height + " @ " +
                   it.frameRate;
          }
          return "the coverage comp is not in the project listing";
        } },

      { name: "duplicate_comp copies it, settings and all",
        tool: "duplicate_comp",
        args: function (ctx) {
          return { comp: ctx.cvComp, name: "ST Cov Copy" };
        },
        check: function (d, ctx) {
          ctx.cvCopy = d.name;
          if (d.name !== "ST Cov Copy") return "named " + d.name;
          return d.duplicatedFrom === ctx.cvComp ||
                 "duplicatedFrom " + d.duplicatedFrom;
        } },

      { name: "rename_item reports the name it replaced",
        tool: "rename_item",
        args: function (ctx) { return { item: ctx.cvCopy, name: "ST Cov Kept" }; },
        check: function (d, ctx) {
          if (d.oldName !== ctx.cvCopy) return "oldName " + d.oldName;
          ctx.cvCopy = d.name;
          return d.name === "ST Cov Kept" || "name " + d.name;
        } },

      { name: "renaming something that does not exist is refused",
        tool: "rename_item",
        expectError: true,
        args: { item: "ST No Such Item At All", name: "ST Whatever" },
        check: function (err) {
          return err.indexOf("not found") !== -1 || "err: " + err;
        } },

      { name: "move_to_folder files the copy away",
        batch: function (ctx) {
          return [
            { tool: "create_folder", args: { name: "ST Cov Folder" } },
            { tool: "move_to_folder",
              args: { items: [ctx.cvCopy], folder: "ST Cov Folder" } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok) return "folder: " + rows[0].error;
          if (!rows[1].ok) return "move: " + rows[1].error;
          return rows[1].data.moved.join(",") === ctx.cvCopy ||
                 "moved " + rows[1].data.moved.join(", ");
        } },

      { name: "and the project shows it inside that folder",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          for (var i = 0; i < d.items.length; i++) {
            if (d.items[i].name !== ctx.cvCopy) continue;
            return d.items[i].folder === "ST Cov Folder" ||
                   "folder is " + (d.items[i].folder || "(root)");
          }
          return "the copy is not in the project listing";
        } },

      { name: "a missing folder is refused with the folders that exist",
        tool: "move_to_folder",
        expectError: true,
        args: function (ctx) {
          return { items: [ctx.cvCopy], folder: "ST No Such Folder" };
        },
        check: function (err) {
          if (err.indexOf("ST Cov Folder") === -1) {
            return "does not list the real folders: " + err;
          }
          return err.indexOf("create_folder") !== -1 ||
                 "no route out of the refusal: " + err;
        } },

      { name: "cleanup: delete the coverage copy",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.cvCopy }; },
        check: function () { return true; } },

      { name: "cleanup: delete the coverage folder",
        tool: "delete_item",
        args: { item: "ST Cov Folder" },
        check: function () { return true; } },

      { name: "cleanup: delete the coverage comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.cvComp }; },
        check: function () { return true; } },

      // ---- precompose + markers (WORKPLAN 5.4). Both tools shipped with
      // no coverage at all. Everything asserted below was measured in AE
      // 2026 first (WORKPLAN-LOG 2026-08-28) — the four things precompose
      // used to do silently, and the one add_marker did.
      //
      // Its own comp: precompose CREATES project items, and a rig that
      // shared a comp with the groups above would leave nested comps
      // inside something another step still measures.
      { name: "precompose rig comp",
        tool: "create_comp",
        args: { name: PCCOMP, width: 640, height: 480, duration: 10,
                frameRate: 24 },
        check: function (d, ctx) { ctx.pcComp = d.name; return true; } },

      { name: "precompose rig: four solids and a parent link",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.pcComp, name: "ST Pre Stay",
                color: [0.2, 0.2, 0.2], width: 100, height: 100 } },
            { tool: "add_solid", args: { comp: ctx.pcComp, name: "ST Pre Par",
                color: [0.4, 0.4, 0.4], width: 100, height: 100 } },
            { tool: "add_solid", args: { comp: ctx.pcComp, name: "ST Pre Kid",
                color: [0.6, 0.6, 0.6], width: 100, height: 100 } },
            { tool: "add_solid", args: { comp: ctx.pcComp, name: "ST Pre Watch",
                color: [0.8, 0.8, 0.8], width: 100, height: 100 } },
            { tool: "set_layer_parent", args: { comp: ctx.pcComp,
                layer: "ST Pre Kid", parent: "ST Pre Par" } },
            { tool: "set_expression", args: { comp: ctx.pcComp,
                layer: "ST Pre Watch", property: "opacity",
                expression: 'thisComp.layer("ST Pre Kid").transform.opacity' } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "rig row " + (i + 1) + ": " + rows[i].error;
          }
          return true;
        } },

      // AE refuses moveAllAttributes:false for more than one layer. The
      // tool has to say so itself — the raw AE throw is not something the
      // model can act on.
      { name: "precompose refuses moveAttributes:false for two layers",
        tool: "precompose",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.pcComp, layers: ["ST Pre Stay", "ST Pre Watch"],
                   name: "ST Pre Never", moveAttributes: false };
        },
        check: function (err) {
          if (/After Effects error/.test(err)) {
            return "leaks AE's raw throw: " + err;
          }
          return (/ST Pre Stay/.test(err) && /ST Pre Watch/.test(err)) ||
                 "does not name the layers: " + err;
        } },

      // Three of the four silences in one call: a repeated reference
      // counts once, the parent that stayed behind is named, and the
      // expression left behind that now dangles is named. Nothing was
      // selected before (add_solid restores the selection it found, and
      // the rig comp started empty), so this is also the "nothing
      // survived" half of the selection report.
      { name: "precompose reports the parent and expression it broke",
        tool: "precompose",
        args: function (ctx) {
          return { comp: ctx.pcComp,
                   layers: ["ST Pre Kid", "ST Pre Kid"],
                   name: "ST Pre Nest" };
        },
        check: function (d, ctx) {
          ctx.pcNest = d.precomp;
          if (d.layersMoved !== 1) {
            return "a repeated reference was counted twice: layersMoved " +
                   d.layersMoved;
          }
          if (!/ST Pre Kid/.test(d.duplicatesIgnored || "")) {
            return "the repeat is not reported: " +
                   (d.duplicatesIgnored || "(nothing)");
          }
          if (!/ST Pre Par/.test(d.parentsBroken || "")) {
            return "the dropped parent is not reported: " +
                   (d.parentsBroken || "(nothing)");
          }
          if (!/ST Pre Watch/.test(d.expressionsAtRisk || "")) {
            return "the dangling expression is not reported: " +
                   (d.expressionsAtRisk || "(nothing)");
          }
          return /none survived/.test(d.selectionKept || "") ||
                 "nothing was selected to keep, but the result claims " +
                 d.selectionKept;
        } },

      { name: "...and the layer really did move into the new comp",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.pcNest }; },
        check: function (d) {
          if (d.numLayers !== 1) return "precomp holds " + d.numLayers;
          return d.layers[0].name === "ST Pre Kid" ||
                 "it holds " + d.layers[0].name;
        } },

      // AE never uniquifies an item name, and two comps sharing one make
      // the later unreachable by name. precompose auto-numbers instead,
      // and registers the same request-scoped alias create_comp does.
      //
      // This is also the OTHER half of the selection report: precompose
      // above left AE's new layer selected, that layer survives this call,
      // and so it has to come back selected.
      { name: "a precomp name already taken is auto-numbered",
        tool: "precompose",
        args: function (ctx) {
          return { comp: ctx.pcComp, layers: ["ST Pre Par"],
                   name: ctx.pcNest };
        },
        check: function (d, ctx) {
          ctx.pcNest2 = d.precomp;
          if (d.precomp === ctx.pcNest) {
            return "took the name that was already used: " + d.precomp;
          }
          if (d.selectionKept !== ctx.pcNest) {
            return "the selection that survived was not put back: " +
                   d.selectionKept + " (expected " + ctx.pcNest + ")";
          }
          return /already existed/.test(d.note || "") ||
                 "no note about the rename: " + (d.note || "(none)");
        } },

      { name: "...and the old name still reaches the new comp",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.pcNest }; },
        check: function (d, ctx) {
          // Within one request the alias wins, exactly as after
          // create_comp: the batch that asked for the name gets the comp
          // it actually made.
          return d.name === ctx.pcNest2 ||
                 "resolved to '" + d.name + "', not '" + ctx.pcNest2 + "'";
        } },

      // moveAttributes:false sizes the new comp to the LAYER, not the comp.
      { name: "moveAttributes:false takes the layer's own size",
        tool: "precompose",
        args: function (ctx) {
          return { comp: ctx.pcComp, layers: ["ST Pre Watch"],
                   name: "ST Pre Solo", moveAttributes: false };
        },
        check: function (d, ctx) {
          ctx.pcSolo = d.precomp;
          return /SIZE OF THE LAYER \(100x100\)/.test(d.note || "") ||
                 "no size note, or the wrong size: " + (d.note || "(none)");
        } },

      { name: "...and the new comp really is 100x100",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.pcSolo }; },
        check: function (d) {
          return (d.width === 100 && d.height === 100) ||
                 d.width + "x" + d.height;
        } },

      // ---- markers.
      { name: "add_marker puts one on the comp",
        tool: "add_marker",
        args: function (ctx) {
          return { comp: ctx.pcComp, time: 1, comment: "ST first",
                   duration: 2 };
        },
        check: function (d) {
          return (d.comment === "ST first" && d.duration === 2 &&
                  d.markers === 1) || JSON.stringify(d);
        } },

      // AE keeps ONE marker per exact time, so this destroys the first.
      { name: "...a second at the same time names what it destroyed",
        tool: "add_marker",
        args: function (ctx) {
          return { comp: ctx.pcComp, time: 1, comment: "ST second" };
        },
        check: function (d) {
          if (d.markers !== 1) return "AE kept " + d.markers + " markers";
          return /ST first/.test(d.replaced || "") ||
                 "the overwritten marker is not reported: " +
                 (d.replaced || "(nothing)");
        } },

      { name: "...and one on empty time reports no loss",
        tool: "add_marker",
        args: function (ctx) {
          return { comp: ctx.pcComp, time: 3, comment: "ST third" };
        },
        check: function (d) {
          return (!d.replaced && d.markers === 2) ||
                 "replaced=" + d.replaced + " markers=" + d.markers;
        } },

      // A small model writes {"time": "4"} often enough to matter.
      { name: "a quoted time is accepted, not dropped",
        tool: "add_marker",
        args: function (ctx) {
          return { comp: ctx.pcComp, time: "4", comment: "ST quoted" };
        },
        check: function (d) {
          return d.time === 4 || "time came back as " +
                 d.time + " (" + typeof d.time + ")";
        } },

      { name: "a duration that is not a duration is refused",
        tool: "add_marker",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.pcComp, time: 5, duration: -3 };
        },
        check: function (err) {
          return (/-3/.test(err) && /duration/.test(err)) ||
                 "not grounded in what came in: " + err;
        } },

      // AE will happily put a marker where nobody can ever see it.
      { name: "a marker past the end of the comp is flagged",
        tool: "add_marker",
        args: function (ctx) {
          return { comp: ctx.pcComp, time: 99, comment: "ST far" };
        },
        check: function (d) {
          return /off the visible timeline/.test(d.note || "") ||
                 "no note: " + (d.note || "(none)");
        } },

      { name: "a layer marker outside the layer's span is flagged",
        batch: function (ctx) {
          return [
            { tool: "set_layer_timing", args: { comp: ctx.pcComp,
                layer: "ST Pre Stay", inPoint: 3, outPoint: 8 } },
            { tool: "add_marker", args: { comp: ctx.pcComp,
                layer: "ST Pre Stay", time: 1, comment: "ST early" } },
            { tool: "add_marker", args: { comp: ctx.pcComp,
                layer: "ST Pre Stay", time: 5, comment: "ST inside" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "set_layer_timing failed: " + rows[0].error;
          if (!rows[1].ok || !rows[2].ok) {
            return "add_marker failed: " +
                   (rows[1].error || rows[2].error);
          }
          if (!/own span/.test(rows[1].data.note || "")) {
            return "the early marker is not flagged: " +
                   (rows[1].data.note || "(nothing)");
          }
          return !rows[2].data.note ||
                 "the marker INSIDE the span was flagged too: " +
                 rows[2].data.note;
        } },

      // Marker times are COMPOSITION time on a layer as well: the marker
      // rides the layer when its startTime moves, so what came back as
      // "time 5" is still where the user asked for it.
      { name: "a layer marker reads back at the comp time it was given",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.pcComp, layer: "ST Pre Stay",
                   property: "Marker" };
        },
        check: function (d) {
          if (d.numKeys !== 2) return "expected 2 markers, got " + d.numKeys;
          var times = [];
          for (var i = 0; i < d.keys.length; i++) times.push(d.keys[i].time);
          return times.join(",") === "1,5" ||
                 "marker times " + times.join(",") + ", expected 1,5";
        } },

      { name: "cleanup: delete the precompose rig comps",
        batch: function (ctx) {
          return [
            { tool: "delete_item", args: { item: ctx.pcSolo } },
            { tool: "delete_item", args: { item: ctx.pcNest2 } },
            { tool: "delete_item", args: { item: ctx.pcNest } },
            { tool: "delete_item", args: { item: ctx.pcComp } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          return true;
        } },

      // ---- comp-rename audit + bulk rename. A three-comp rig: one
      // plain, one nested (a utility), one named by an expression.
      //
      // Measured in AE 2026 before these tools were written: AE does NOT
      // rewrite comp("Old Name") when a comp is renamed — the expression
      // breaks and is DISABLED — and the trap is that prop.value keeps
      // reading normally afterwards, so only expressionError reveals it.
      // Hence the hard skip, and hence a preview before anything moves.
      { name: "create the rename host comp",
        tool: "create_comp",
        args: { name: "ST RN Host 2021", width: 320, height: 240,
                duration: 4, frameRate: 30 },
        check: function (d, ctx) { ctx.rnHost = d.name; return true; } },

      { name: "create the plain and linked rename comps",
        batch: function () {
          return [
            { tool: "create_comp",
              args: { name: "ST RN Plain 2019", width: 320, height: 240,
                      duration: 4, frameRate: 30 } },
            { tool: "create_comp",
              args: { name: "ST RN Linked 2020", width: 320, height: 240,
                      duration: 4, frameRate: 30 } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok || !rows[1].ok) {
            return "could not build the rig: " +
                   (rows[0].error || rows[1].error);
          }
          ctx.rnPlain = rows[0].data.name;
          ctx.rnLinked = rows[1].data.name;
          return true;
        } },

      { name: "nest a comp inside the host, so it reads as a utility",
        batch: function (ctx) {
          return [
            { tool: "add_solid",
              args: { comp: ctx.rnHost, name: "ST RN Inner",
                      color: [1, 0, 0], width: 40, height: 40 } },
            { tool: "precompose",
              args: { comp: ctx.rnHost, layers: ["ST RN Inner"],
                      name: "ST RN Util 2019" } },
            { tool: "add_solid",
              args: { comp: ctx.rnHost, name: "ST RN Expr",
                      color: [0, 1, 0], width: 40, height: 40 } },
            { tool: "set_expression",
              args: { comp: ctx.rnHost, layer: "ST RN Expr",
                      property: "transform/Opacity",
                      expression: 'comp("ST RN Linked 2020").duration ' +
                                  '* 0 + 100' } }
          ];
        },
        check: function (rows, ctx) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + i + " failed: " + rows[i].error;
          }
          ctx.rnUtil = rows[1].data.precomp;
          return true;
        } },

      { name: "audit_comp_usage reports the nesting and the expression",
        tool: "audit_comp_usage",
        args: {},
        check: function (d, ctx) {
          var by = {}, i;
          for (i = 0; i < d.comps.length; i++) by[d.comps[i].name] = d.comps[i];
          var util = by[ctx.rnUtil], linked = by[ctx.rnLinked],
              plain = by[ctx.rnPlain];
          if (!util || !linked || !plain) {
            return "the audit did not report the rig comps";
          }
          if (util.usedIn.join(",").indexOf(ctx.rnHost) === -1) {
            return "the nested comp does not name its parent: " +
                   util.usedIn.join(", ");
          }
          if (!util.looksLikeUtility) return "the nested comp is not marked";
          if (linked.expressionRefCount < 1) {
            return "the expression reference was not found";
          }
          if (linked.expressionRefs[0].kind !== "comp()") {
            return "wrong reference kind: " + linked.expressionRefs[0].kind;
          }
          return plain.expressionRefCount === 0 ||
                 "the plain comp was wrongly reported as referenced";
        } },

      { name: "the rename preview plans one and skips two, changing nothing",
        tool: "rename_comps",
        args: function (ctx) {
          return { comps: [ctx.rnPlain, ctx.rnUtil, ctx.rnLinked] };
        },
        check: function (d, ctx) {
          if (d.dryRun !== true) return "dryRun did not default to true";
          var by = {}, i;
          for (i = 0; i < d.plan.length; i++) by[d.plan[i].comp] = d.plan[i];
          if (!by[ctx.rnPlain]) {
            return "the plain comp is missing from the plan entirely";
          }
          if (by[ctx.rnPlain].action !== "rename") {
            // Nearly always a leftover REV19_ comp from an aborted run
            // colliding with the name this step wants. Say so, rather
            // than leaving the next person to guess.
            return "the plain comp was not planned for rename — " +
                   by[ctx.rnPlain].reason;
          }
          if (by[ctx.rnPlain].newName !== "REV19_" + ctx.rnPlain) {
            return "wrong new name: " + by[ctx.rnPlain].newName;
          }
          if (by[ctx.rnLinked].action !== "skip") {
            return "the expression-referenced comp was not skipped";
          }
          if (by[ctx.rnUtil].action !== "skip") {
            return "the utility comp was not skipped";
          }
          return d.willRename === 1 ||
                 "expected exactly one rename, got " + d.willRename;
        } },

      { name: "and the preview really did not rename anything",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          var names = [], i;
          for (i = 0; i < d.items.length; i++) names.push(d.items[i].name);
          return names.join(",").indexOf("REV19_ST RN Plain") === -1 ||
                 "the dry run renamed a comp";
        } },

      { name: "executing renames ONLY the plain comp",
        tool: "rename_comps",
        args: function (ctx) {
          return { comps: [ctx.rnPlain, ctx.rnUtil, ctx.rnLinked],
                   dryRun: false };
        },
        check: function (d, ctx) {
          if (d.renamedCount !== 1) {
            return "expected 1 rename, got " + d.renamedCount + ": " +
                   (d.renamed || []).join(", ");
          }
          ctx.rnPlainNew = "REV19_" + ctx.rnPlain;
          return d.renamed[0].indexOf(ctx.rnPlainNew) !== -1 ||
                 "renamed the wrong comp: " + d.renamed[0];
        } },

      { name: "the linked comp still answers to its ORIGINAL name",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.rnLinked }; },
        check: function (d, ctx) {
          return d.name === ctx.rnLinked ||
                 "the expression-referenced comp was renamed to " + d.name;
        } },

      { name: "running it again renames nothing (idempotent)",
        tool: "rename_comps",
        args: function (ctx) {
          return { comps: [ctx.rnPlainNew, ctx.rnUtil, ctx.rnLinked],
                   dryRun: false };
        },
        check: function (d) {
          return d.renamedCount === 0 ||
                 "a second run renamed " + d.renamedCount + " comp(s)";
        } },

      // ---- create_folder eachChildOf (field failure 2026-08-26) -------
      // "Add an _ARCHIVE subfolder within each subfolder within _COMPS":
      // the model acted from the trimmed project summary, hit 2 of 10
      // targets and claimed success. The fan-out form walks the REAL
      // subfolders host-side in one call and returns the created paths
      // as receipts.
      { name: "folder rig: fan-out parent",
        tool: "create_folder",
        args: { name: "ST FanParent" },
        check: function (d) {
          return !!d.id || "no folder id in " + JSON.stringify(d);
        } },

      { name: "folder rig: first subfolder",
        tool: "create_folder",
        args: { name: "ST FanKid A", parent: "ST FanParent" },
        check: function (d) {
          return d.path === "ST FanParent/ST FanKid A" ||
                 "path was " + d.path;
        } },

      { name: "folder rig: second subfolder",
        tool: "create_folder",
        args: { name: "ST FanKid B", parent: "ST FanParent" },
        check: function (d) {
          return d.path === "ST FanParent/ST FanKid B" ||
                 "path was " + d.path;
        } },

      { name: "folder rig: third subfolder (to be excepted)",
        tool: "create_folder",
        args: { name: "ST FanKid C", parent: "ST FanParent" },
        check: function (d) {
          return d.path === "ST FanParent/ST FanKid C" ||
                 "path was " + d.path;
        } },

      { name: "folder rig: one child is already archived",
        tool: "create_folder",
        args: { name: "_ARCHIVE", parent: "ST FanParent/ST FanKid B" },
        check: function (d) {
          return d.path === "ST FanParent/ST FanKid B/_ARCHIVE" ||
                 "path was " + d.path;
        } },

      // The field sentence had an exclusion ("except for in _North") —
      // the flag honors it and REPORTS it. The except entry here is the
      // FULL PATH on purpose: the field's first run spelled it that way
      // and burned a correction round before paths were accepted.
      { name: "eachChildOf fans out with receipts, honoring except",
        tool: "create_folder",
        args: { name: "_ARCHIVE", eachChildOf: "ST FanParent",
                except: ["ST FanParent/ST FanKid C"] },
        check: function (d) {
          if (d.subfolders !== 2) return "saw " + d.subfolders +
            " subfolders after the exception, not 2";
          if (d.createdCount !== 1 ||
              !d.created || d.created.length !== 1 ||
              d.created[0] !== "ST FanParent/ST FanKid A/_ARCHIVE") {
            return "created: " + JSON.stringify(d.created);
          }
          if (d.alreadyExistedCount !== 1) {
            return "pre-existing archive not reported: " +
                   JSON.stringify(d);
          }
          if (!d.skippedAsExcepted ||
              d.skippedAsExcepted.join(",") !== "ST FanKid C") {
            return "except not reported: " +
                   JSON.stringify(d.skippedAsExcepted);
          }
          return true;
        } },

      // Ask AE, not the report: re-running WITHOUT the exception walks
      // the live project again — kid C getting its archive only NOW
      // proves the except really spared it, and existed=2 proves the
      // first fan-out really landed.
      { name: "read-back: the exception was honored and the fan landed",
        tool: "create_folder",
        args: { name: "_ARCHIVE", eachChildOf: "ST FanParent" },
        check: function (d) {
          if (d.subfolders !== 3) return "saw " + d.subfolders +
            " subfolders, not 3";
          if (d.createdCount !== 1 || !d.created ||
              d.created[0] !== "ST FanParent/ST FanKid C/_ARCHIVE") {
            return "kid C's archive should be created only NOW (got " +
                   JSON.stringify(d.created) + ")";
          }
          return (d.alreadyExistedCount === 2) ||
                 "re-run says " + JSON.stringify(d);
        } },

      { name: "cleanup: delete the fan-out rig",
        tool: "delete_item",
        args: { item: "ST FanParent" },
        check: function () { return true; } },

      { name: "cleanup: delete the renamed plain comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.rnPlainNew }; },
        check: function () { return true; } },

      { name: "cleanup: delete the rename host comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.rnHost }; },
        check: function () { return true; } },

      { name: "cleanup: delete the nested utility comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.rnUtil }; },
        check: function () { return true; } },

      { name: "cleanup: delete the linked comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.rnLinked }; },
        check: function () { return true; } },

      { name: "cleanup: delete the batch-call comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.unComp }; },
        check: function () { return true; } },

      { name: "cleanup: delete the batch comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.btComp }; },
        check: function () { return true; } },

      { name: "cleanup: delete the mask comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.mkComp }; },
        check: function () { return true; } },

      { name: "cleanup: delete the order comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.orComp }; },
        check: function () { return true; } },

      { name: "cleanup: delete the chunk comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.chComp }; },
        check: function () { return true; } },

      { name: "cleanup: delete the anchor comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.apComp }; },
        check: function () { return true; } },

      { name: "cleanup: delete the camera comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.camComp }; },
        check: function () { return true; } },

      { name: "cleanup: delete the scratch comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.comp }; },
        check: function () { return true; } },

      // Deleting a comp does NOT delete the solid SOURCES its layers
      // used — they stay in the project panel, so every suite run left
      // its solids behind and a scratch project accumulated dozens of
      // duplicates (field-observed: 45 items, visibly doubling). Find
      // every leftover footage item in the suite's own namespace and
      // queue its deletion for the step below. Names outside "ST " are
      // never touched — that prefix is the suite's, nothing else's.
      { name: "cleanup: find the solid sources the suite left behind",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          ctx.leftoverIds = [];
          for (var i = 0; i < d.items.length; i++) {
            var it = d.items[i];
            if (it.type === "footage" && it.name.indexOf("ST ") === 0) {
              ctx.leftoverIds.push(it.id);
            }
          }
          return true;
        } },

      { name: "cleanup: delete them (by id — names duplicate)",
        batch: function (ctx) {
          var ids = ctx.leftoverIds || [];
          var cmds = [];
          for (var i = 0; i < ids.length; i++) {
            cmds.push({ tool: "delete_item",
                        args: { item: ids[i] } });
          }
          // An empty batch is refused by the host; a no-op read keeps
          // the step well-formed on an already-clean project.
          if (!cmds.length) {
            cmds.push({ tool: "get_project_info", args: { limit: 1 } });
          }
          return cmds;
        },
        check: function (rows, ctx) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) {
              return "leftover " + (i + 1) + " of " + rows.length +
                     " not deleted: " + rows[i].error;
            }
          }
          return true;
        } },

      { name: "cleanup: nothing of the suite's remains in the project",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d) {
          var stale = [];
          for (var i = 0; i < d.items.length; i++) {
            if (d.items[i].name.indexOf("ST ") === 0) {
              stale.push(d.items[i].name);
            }
          }
          return stale.length === 0 ||
                 "the suite left items behind: " + stale.join(", ");
        } }
    ];
  }

  /**
   * Run the suite. deps: {callHostTool, callHostBatch?, onLine(text),
   * onDone(summary)}.
   * Sequential; a step failure is recorded and the run continues (cleanup
   * still happens last).
   *
   * callHostBatch(commands, cb) sends several tools in ONE host call, which
   * is how a whole chat command becomes a single Ctrl+Z. It is optional: a
   * runner that does not provide it falls back to one call per command, so
   * the ORDER and per-command outcomes are still checked — only the shared
   * undo group is not.
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

    // Record one step's verdict and move on. `verdict` is true or a
    // failure detail; `hardFail` short-circuits check() entirely.
    function settle(s, verdict, hardFail) {
      if (hardFail !== null && typeof hardFail !== "undefined") {
        results.push({ name: s.name, ok: false, detail: hardFail });
        deps.onLine("FAIL — " + s.name);
      } else if (verdict === true) {
        results.push({ name: s.name, ok: true });
      } else {
        results.push({ name: s.name, ok: false, detail: String(verdict) });
        deps.onLine("FAIL — " + s.name + " (" + verdict + ")");
      }
      // Yield between steps so the panel stays responsive.
      global.setTimeout(step, 30);
    }

    // A {batch: [...]} step hands check() the raw result ROWS: a batch is
    // about what each command did, so a failing row is data, not a stop.
    function runBatch(s, cmds) {
      function done(rows) {
        var verdict = null, hardFail = null;
        if (!rows || rows.length !== cmds.length) {
          hardFail = "expected " + cmds.length + " result rows, got " +
                     (rows ? rows.length : "none");
        } else {
          try { verdict = s.check(rows, ctx); }
          catch (eB) { verdict = "check error: " + eB.message; }
        }
        settle(s, verdict, hardFail);
      }
      if (deps.callHostBatch) {
        // s.batchOpts arms the host's partial-round rollback for this
        // step. Both runners take (cmds, opts, cb).
        deps.callHostBatch(cmds, s.batchOpts || {}, done);
        return;
      }
      var rows = [];
      (function one(i) {
        if (i >= cmds.length) { done(rows); return; }
        deps.callHostTool(cmds[i].tool, cmds[i].args || {}, function (r) {
          rows.push(r || { ok: false, error: "no result" });
          one(i + 1);
        });
      })(0);
    }

    function step() {
      if (idx >= steps.length) { finish(); return; }
      var s = steps[idx++];
      if (s.batch) {
        var cmds;
        try {
          cmds = typeof s.batch === "function" ? s.batch(ctx) : s.batch;
        } catch (eBA) {
          settle(s, "batch error: " + eBA.message, null);
          return;
        }
        runBatch(s, cmds);
        return;
      }
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
        var verdict = null, hardFail = null;
        if (s.expectError) {
          // Inverted step: the refusal IS the behaviour under test, and
          // its wording is what the model has to act on, so check() reads
          // the message rather than the data.
          if (!r) hardFail = "no result";
          else if (r.ok) hardFail = "expected a refusal, but the tool " +
                                    "accepted the call";
          else {
            try { verdict = s.check(String(r.error || ""), ctx); }
            catch (eE) { verdict = "check error: " + eE.message; }
          }
        } else if (!r || !r.ok) {
          hardFail = r ? r.error : "no result";
        } else {
          try { verdict = s.check(r.data || {}, ctx); }
          catch (eC) { verdict = "check error: " + eC.message; }
        }
        settle(s, verdict, hardFail);
      });
    }

    deps.onLine("Self-test: running " + steps.length +
                " real-AE checks in a scratch comp…");
    step();
  }

  global.SelfTest = { run: run, _buildSteps: buildSteps };

})(window);
