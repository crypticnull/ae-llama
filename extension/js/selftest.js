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
          if (d.layersInherited !== 1) {
            return "layersInherited " + d.layersInherited + " (expected 1)";
          }
          return d.layersScaled === 6 ||
                 "layersScaled " + d.layersScaled + " (expected 6)";
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

      { name: "batch: every one of the 60 really carries the blur",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.btComp }; },
        check: function (d) {
          if (d.numLayers !== 60) return "numLayers " + d.numLayers + ", not 60";
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
        if (hardFail !== null) {
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
      });
    }

    deps.onLine("Self-test: running " + steps.length +
                " real-AE checks in a scratch comp…");
    step();
  }

  global.SelfTest = { run: run, _buildSteps: buildSteps };

})(window);
