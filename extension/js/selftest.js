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
  // And the text-animator rig: per-character 3D turns the whole LAYER 3D
  // and never gives it back, so it may not share a comp being measured.
  var TXCOMP = "AELL Self-Test Text";
  // And the render rig: it is the only group that writes FILES and that
  // puts items in the user's render queue, so it gets a comp of its own
  // and takes it away again. Small on purpose — 160x120 for one frame
  // renders in about 180 ms, measured.
  var RQCOMP = "AELL Self-Test Render";
  // And the audio rig: audio_to_keyframes MUTES other layers for the
  // duration of a conversion and can widen the work area, so it may not
  // share a comp anything else is measuring. It needs no file on disk —
  // AE's Tone effect turns a plain solid into a real audio source
  // (measured: layer.hasAudio flips to true and the converter hears it).
  var AUCOMP = "AELL Self-Test Audio";
  // And the frame round-trip rig: snapshot_frame writes FILES and
  // import_as_layer brings project items in, so like the render rig it
  // works in comps of its own and takes them away again.
  // And the caption rigs. Two, for the same reason the render and frame
  // rigs are separate: one gets a Tone effect so it has real audio to
  // render, the other is 1920x1080 because add_captions' default
  // position is the comp's own lower third and a 160x120 comp would
  // prove nothing about it.
  var CAPCOMP = "AELL Self-Test Caption Audio";
  var CAPTEXT = "AELL Self-Test Captions";
  var FRCOMP = "AELL Self-Test Frame";
  var FRWIDE = "AELL Self-Test Frame Wide";
  // And the bounds rig: it slides a layer in time, pushes one off the
  // frame and turns another 3D, so it may not share a comp anything else
  // is measuring.
  var BNCOMP = "AELL Self-Test Bounds";
  // And the Essential Graphics rig: exposing a property writes to the
  // COMP's controller list, which nothing else in the suite reads, and
  // there is no way to remove a controller once it is added (AE 2026
  // ships no such call) — so the rig has to be a comp that is thrown
  // away whole.
  var MGCOMP = "AELL Self-Test Mogrt";
  // And the carpet-bomb rig. The gate it measures triggers on "the
  // caller named EVERY layer in this comp", so the comp has to hold a
  // roster nothing else in the suite adds to.
  var WPCOMP = "AELL Self-Test Wipe";
  // And the "nothing to stagger" rig. Every other comp in the suite has
  // been keyframed by the time stagger_layers runs, and the class this
  // measures is a comp where NOTHING is animated — so it needs solids
  // nobody else has touched.
  var SMCOMP = "AELL Self-Test Stagger";
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
      // FIRST, before anything is created: photograph the project as the
      // user left it. The cleanup at the bottom sweeps the suite's own
      // "ST " namespace, but the items a run leaks are named by AFTER
      // EFFECTS, not by the suite — every add_null leaves a solid source
      // called "Null <n>" behind and every audio_to_keyframes one called
      // "Audio Amplitude" (measured 2026-08-30: 34 orphans per run, in
      // whatever project the user had open). Those names cannot be swept
      // by name: "Null 1" is a name a user's own project will hold. So
      // the sweep is scoped by ID to the items THIS RUN created, which
      // needs the before-picture taken here.
      { name: "baseline: photograph the project before the suite touches it",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          ctx.baseIds = {};
          for (var i = 0; i < d.items.length; i++) {
            ctx.baseIds[d.items[i].id] = true;
          }
          ctx.baseCount = d.items.length;
          // limit:0 means "no cap". If it ever capped, the baseline would
          // be partial and the sweep would delete items it never created —
          // so this is a guard on the cleanup, not a spare assertion.
          return d.items.length === d.numItems ||
                 "limit:0 listed " + d.items.length + " of " + d.numItems +
                 " items; the cleanup cannot scope itself to this run " +
                 "without the whole list";
        } },

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
          if (d.layers !== 9) return "layers " + d.layers;
          // These nine carry scale AND opacity keyframes from the batch
          // steps above, so the "nothing animates" warning must stay
          // silent here. A warning that fires on animated layers would
          // cost a round on every real stagger.
          return !d.warning || "warned on animated layers: " + d.warning;
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

      // The other half of the type guard added 2026-09-01: a SHAPE layer
      // is not `instanceof AVLayer` in ExtendScript, so the first cut at
      // refusing cameras locked shapes and text out of mattes as well.
      // The step above uses solids and stayed green through that, which
      // is exactly why this one exists.
      { name: "a shape layer still takes a matte",
        tool: "set_track_matte",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Shape",
                   matteLayer: "ST Square 4", mode: "luma" };
        },
        check: function (d) {
          return d.layer === "ST Shape" || "layer: " + d.layer;
        } },

      { name: "…and can BE one",
        tool: "set_track_matte",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Square 7",
                   matteLayer: "ST Shape", mode: "alpha_inverted" };
        },
        check: function (d) {
          return d.matte === "ST Shape" || "matte: " + d.matte;
        } },

      // Until 2026-09-02 the four steps above checked only the RECEIPT,
      // so nothing here could tell a matte AE really made from one it
      // only said it made. AE's own state is read back now.
      { name: "…and AE really shows the matte, read back from the comp",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.comp, limit: 0 }; },
        check: function (d) {
          var row = null, i;
          for (i = 0; i < d.layers.length; i++) {
            if (d.layers[i].name === "ST Square 3") row = d.layers[i];
          }
          if (!row) return "no row for ST Square 3";
          if (row.matte !== "ST Square 4") {
            return "matte reads " + row.matte + ", wanted ST Square 4";
          }
          return row.matteMode === "alpha" ||
                 "matteMode reads " + row.matteMode + ", wanted alpha";
        } },

      { name: "removing the shape layer's matte",
        tool: "set_track_matte",
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Shape", mode: "none" };
        },
        check: function (d) {
          return d.matte === "removed" || "matte: " + d.matte;
        } },

      // Measured in AE 2026: removeTrackMatte() clears trackMatteLayer
      // but LEAVES trackMatteType at the type it just removed, so a
      // type-only read reports a matte that is gone. This is the step
      // that would catch that.
      { name: "…and the removal really cleared it in AE",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.comp, limit: 0 }; },
        check: function (d) {
          var row = null, i;
          for (i = 0; i < d.layers.length; i++) {
            if (d.layers[i].name === "ST Shape") row = d.layers[i];
          }
          if (!row) return "no row for ST Shape";
          if (row.matte) {
            return "ST Shape still reports matte " + row.matte +
                   " after mode 'none'";
          }
          return true;
        } },

      { name: "removing a matte a normal layer never had is refused",
        tool: "set_track_matte",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.comp, layer: "ST Shape", mode: "none" };
        },
        check: function (err) {
          return /has no track matte to remove/.test(err) ||
                 "does not say there was nothing to remove: " + err;
        } },

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

      // A camera can neither take a matte nor be one. Measured 2026-09-01
      // (WORKPLAN 1b): a CameraLayer carries no setTrackMatte at all, and
      // `camera.trackMatteType = LUMA` is ACCEPTED without throwing (it
      // reads back 5015), so before the type guard the tool reordered the
      // stack with moveBefore and reported ok for a matte AE never made.
      // Nothing threw, so only a by-type refusal can catch it.
      { name: "a camera cannot take a track matte",
        tool: "set_track_matte",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Aim",
                   matteLayer: "ST Cam Solid", mode: "luma" };
        },
        check: function (err) {
          if (!/ST Cam Aim/.test(err) || !/camera/.test(err)) {
            return "does not name the layer and its type: " + err;
          }
          if (!/get_comp_details/.test(err)) {
            return "does not point at the lister: " + err;
          }
          return true;
        } },

      { name: "…and cannot be one either",
        tool: "set_track_matte",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Solid",
                   matteLayer: "ST Cam One", mode: "alpha" };
        },
        check: function (err) {
          return /matteLayer 'ST Cam One' is camera/.test(err) ||
                 "does not name the matte layer and its type: " + err;
        } },

      { name: "…and removing a matte it never had is refused, not 'removed'",
        tool: "set_track_matte",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.camComp, layer: "ST Cam Aim", mode: "none" };
        },
        check: function (err) {
          return /cannot take a track matte/.test(err) ||
                 "wrong refusal: " + err;
        } },

      // (that the refusal also leaves the layer STACK alone is pinned in
      // tests/test-property-access.js, where the stub can watch
      // moveBefore; here the refusal itself is the evidence)

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

      // Read the Position back rather than assuming it: parenting with
      // the default keepPosition makes AE REWRITE it into the rig's
      // space (measured 2026-08-29), so the number here is not the one
      // add_camera was given. What the later step needs is whatever it
      // became, so that scale_comp can be shown not to touch it.
      { name: "parent it",
        batch: function (ctx) {
          return [
            { tool: "set_layer_parent", args: { comp: ctx.camComp,
                layer: "ST Cam Kid", parent: "ST Cam Rig" } },
            { tool: "get_property", args: { comp: ctx.camComp,
                layer: "ST Cam Kid", property: "Position" } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok) return rows[0].error;
          if (!rows[1].ok) return rows[1].error;
          ctx.camKidPos = rows[1].data.value || [];
          return ctx.camKidPos.length >= 3 ||
                 "position " + JSON.stringify(ctx.camKidPos);
        } },

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

      // Same as the camera above: the link rewrites Position, so the
      // "left to its parent" step compares against what it became.
      { name: "parent the light",
        batch: function (ctx) {
          return [
            { tool: "set_layer_parent", args: { comp: ctx.camComp,
                layer: "ST Lit Kid", parent: "ST Cam Rig" } },
            { tool: "get_property", args: { comp: ctx.camComp,
                layer: "ST Lit Kid", property: "Position" } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok) return rows[0].error;
          if (!rows[1].ok) return rows[1].error;
          ctx.litKidPos = rows[1].data.value || [];
          return ctx.litKidPos.length >= 3 ||
                 "position " + JSON.stringify(ctx.litKidPos);
        } },

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
        check: function (d, ctx) {
          var v = d.value || [], was = ctx.litKidPos || [];
          for (var i = 0; i < 3; i++) {
            if (Math.abs((v[i] || 0) - (was[i] || 0)) > 0.6) {
              return "position " + JSON.stringify(v) + ", was " +
                     JSON.stringify(was) + " (double-scaled?)";
            }
          }
          return true;
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
        check: function (d, ctx) {
          var v = d.value || [], was = ctx.camKidPos || [];
          for (var i = 0; i < 3; i++) {
            if (Math.abs((v[i] || 0) - (was[i] || 0)) > 0.6) {
              return "position " + JSON.stringify(v) + ", was " +
                     JSON.stringify(was) + " (double-transformed)";
            }
          }
          return true;
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

      // ---- relative reorder (audit 0.11 item 4) ------------------------
      // "Put it behind the logo": ONE layer next to ONE anchor, nothing
      // else disturbed. The sorter above pulls a list contiguous and pushes
      // the rest aside, so it could never answer that request honestly.
      // Every landing slot is read back from AE with get_comp_details, and
      // the four moves return the stack to exactly what it was.
      { name: "below: ST Ord 3 goes under ST Ord 7",
        tool: "reorder_layers",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 3", below: "ST Ord 7" };
        },
        check: function (d) {
          if (d.layer !== "ST Ord 3") return "layer " + d.layer;
          if (d.previousIndex !== 3) return "previousIndex " + d.previousIndex;
          if (d.movedTo !== 7) return "movedTo " + d.movedTo;
          if (d.below !== "ST Ord 7") return "below " + d.below;
          if (d.by || d.topToBottom) return "answered as a SORT: " + d.by;
          if (d.warning) return "warning: " + d.warning;
          return true;
        } },

      { name: "read-back: only ST Ord 3 moved, the rest kept their order",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.orComp }; },
        check: function (d) {
          var want = ["ST Ord", "ST Ord 2", "ST Ord 4", "ST Ord 5",
                      "ST Ord 6", "ST Ord 7", "ST Ord 3", "ST Ord 8",
                      "ST Ord 9", "ST Ord 10", "ST Ord 11", "ST Ord 12"];
          var L = d.layers || [];
          if (L.length !== 12) return "comp holds " + L.length + " layers";
          for (var i = 0; i < 12; i++) {
            if (L[i].name !== want[i]) {
              return "slot " + (i + 1) + " holds " + L[i].name + ", not " +
                     want[i];
            }
          }
          return true;
        } },

      { name: "above: ST Ord 3 goes back on top of ST Ord 4",
        tool: "reorder_layers",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 3", above: "ST Ord 4" };
        },
        check: function (d) {
          if (d.previousIndex !== 7) return "previousIndex " + d.previousIndex;
          if (d.movedTo !== 3) return "movedTo " + d.movedTo;
          return d.above === "ST Ord 4" || "above " + d.above;
        } },

      { name: "toBack: the top layer goes to the bottom",
        tool: "reorder_layers",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord", toBack: true };
        },
        check: function (d) {
          if (d.previousIndex !== 1) return "previousIndex " + d.previousIndex;
          if (d.movedTo !== 12) return "movedTo " + d.movedTo;
          return d.toBack === true || "toBack " + d.toBack;
        } },

      { name: "toFront: and back up again",
        tool: "reorder_layers",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord", toFront: true };
        },
        check: function (d) {
          if (d.previousIndex !== 12) return "previousIndex " + d.previousIndex;
          if (d.movedTo !== 1) return "movedTo " + d.movedTo;
          return d.toFront === true || "toFront " + d.toFront;
        } },

      { name: "toFront on the top layer is an honest no-op",
        tool: "reorder_layers",
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord", toFront: true };
        },
        check: function (d) {
          if (d.movedTo !== 1 || d.previousIndex !== 1) {
            return "slots " + d.previousIndex + " -> " + d.movedTo;
          }
          return /Nothing moved/.test(d.note || "") ||
                 "the receipt claims a move: " + d.note;
        } },

      { name: "read-back: the stack is exactly what it was",
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

      { name: "a layer cannot be moved relative to itself",
        tool: "reorder_layers",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 2", above: "ST Ord 2" };
        },
        check: function (e) {
          if (!/itself/.test(e)) return "message was: " + e;
          return /ST Ord 5/.test(e) || "the refusal lists no layers: " + e;
        } },

      { name: "a relative key and 'by' cannot be combined",
        tool: "reorder_layers",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 2", above: "ST Ord 3",
                   by: "name" };
        },
        check: function (e) {
          return (/cannot be combined/.test(e) && /'by: name'/.test(e)) ||
                 "message was: " + e;
        } },

      { name: "above and below at once are refused by name",
        tool: "reorder_layers",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 2", above: "ST Ord 3",
                   below: "ST Ord 4" };
        },
        check: function (e) {
          return /above \+ below/.test(e) || "message was: " + e;
        } },

      { name: "an anchor name in toFront is refused, not read as true",
        tool: "reorder_layers",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 2", toFront: "ST Ord 5" };
        },
        check: function (e) {
          if (!/'toFront' takes true/.test(e)) return "message was: " + e;
          return /above: 'ST Ord 5'/.test(e) || "no way out offered: " + e;
        } },

      { name: "a missing anchor lists the comp's real layers",
        tool: "reorder_layers",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 2", above: "ST Logo" };
        },
        check: function (e) {
          if (!/Layer not found/.test(e)) return "message was: " + e;
          return (/Actual layers:/.test(e) && /ST Ord 2/.test(e)) ||
                 "the refusal lists no layers: " + e;
        } },

      // The ordered layers carry no effects, which is the state the
      // "take off the glow" refusal has to name.
      // It used to point at apply_effect here, which answers a question a
      // REMOVE caller did not ask. Measured 2026-09-02 (chat-probe row
      // 29): the model met this refusal and guessed seven more effect
      // names in the same round, so what it has to say is that no name
      // can match an empty list.
      { name: "remove_effect on a layer with no effects closes the door",
        tool: "remove_effect",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.orComp, layer: "ST Ord 12", effect: "Glow" };
        },
        check: function (e) {
          if (!/has no effects at all/.test(e)) return "message was: " + e;
          return /no other effect name will match/.test(e) ||
            "another guess is still invited: " + e;
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

      // add_mask's doc says "sizes from get_comp_details, never guessed"
      // and, until 0.11.9, that result carried no layer size at all — so
      // four separate phrasings of "hide half of Beta" all reached
      // add_mask with the COMP's dimensions halved, on a 100x100 layer,
      // and AE took every one of them silently. These two steps are the
      // field proof that the doc is now true and the miss is now caught.
      { name: "a layer row carries the LAYER's size, not the comp's",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.mkComp, limit: 0 }; },
        check: function (d) {
          if (d.width !== 400 || d.height !== 400) {
            return "comp reads " + d.width + "x" + d.height;
          }
          var rows = d.layers || [], i, row = null;
          for (i = 0; i < rows.length; i++) {
            if (rows[i].name === "ST Mask") row = rows[i];
          }
          if (!row) return "no ST Mask row";
          if (row.width !== 200 || row.height !== 200) {
            return "ST Mask is 200x200 but its row says " +
                   row.width + "x" + row.height;
          }
          // 0,0 origin: a solid's box starts there, so the two extra
          // fields a text layer needs must NOT be on this row.
          return (typeof row.left === "undefined" &&
                  typeof row.top === "undefined") ||
                 "a 0,0-origin layer paid for left/top: " +
                 row.left + "," + row.top;
        } },

      { name: "a comp-sized mask on a smaller layer is refused, with its size",
        tool: "add_mask",
        expectError: true,
        args: function (ctx) {
          // Exactly what the model produced in the field: the comp's
          // dimensions, halved, as a "bottom half" rectangle.
          return { comp: ctx.mkComp, layer: "ST Mask", name: "ST Miss",
                   shape: "rectangle", bounds: [0, 200, 400, 200] };
        },
        check: function (e) {
          if (!/misses 'ST Mask' completely/.test(e)) {
            return "message was: " + e;
          }
          if (!/200x200/.test(e)) return "the real size is missing: " + e;
          return /LAYER space/.test(e) ||
                 "the refusal does not say which space: " + e;
        } },

      // The same comp coordinates in the phrasing that OVERLAPS: "I only
      // want to see the top half of Beta" reached add_mask with
      // [0, 0, 1920.0001, 540] on a 100x100 layer. That swallows the
      // layer whole — the mask changes nothing — and the tool said ok.
      { name: "…as is one that swallows the layer whole",
        tool: "add_mask",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", name: "ST Swallow",
                   shape: "rectangle", bounds: [0, 0, 400, 400] };
        },
        check: function (e) {
          if (!/covers ALL of 'ST Mask'/.test(e)) return "message was: " + e;
          if (!/200x200/.test(e)) return "the real size is missing: " + e;
          // It works the answer out rather than only naming the problem.
          return /\[0, 0, 200, 100\]/.test(e) ||
                 "no worked bounds offered: " + e;
        } },

      { name: "…and the aimed version of it lands, unremarked",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", name: "ST Half",
                   shape: "rectangle", bounds: [0, 100, 200, 100] };
        },
        check: function (d) {
          if (d.mask !== "ST Half") return "mask named " + d.mask;
          return !d.note || "an in-bounds mask was noted anyway: " + d.note;
        } },

      { name: "…and the refused one wrote nothing",
        tool: "delete_mask",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", mask: "ST Miss" };
        },
        check: function (e) {
          if (!/Mask not found/.test(e)) return "message was: " + e;
          // The grounded half: the masks that DO exist are the two the
          // steps above meant to make, and no third one from the refusal.
          if (!/ST Path/.test(e) || !/ST Half/.test(e)) {
            return "the refusal lists the wrong masks: " + e;
          }
          return true;
        } },

      // Put the layer back to one mask: the delete-by-index step further
      // down addresses masks positionally, so an extra one here would
      // silently change what index 2 means.
      { name: "…and the aimed one comes off again",
        tool: "delete_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", mask: "ST Half" };
        },
        check: function (d) {
          var rem = d.remainingMasks;
          return (rem && rem.length === 1 && rem[0] === "ST Path") ||
                 "remainingMasks " + JSON.stringify(rem);
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

      // ---- delete_mask (audit 0.11 item 4) -----------------------------
      // The off-grid probe's expression points at the mask about to go;
      // it is cleared first so the deletion cannot leave a broken
      // expression behind. Measured 2026-09-02 in AE 2026, and the
      // reason is worse than the dialog older versions raised: AE puts
      // up NOTHING and tells scripting nothing either. The dependent
      // Position still read expressionEnabled: true with an EMPTY
      // expressionError while its value had quietly fallen back from the
      // mask vertex to the layer's static one. Clearing first is the
      // only way that stays visible.
      { name: "clear the off-grid probe before its mask goes",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Off Probe",
                   property: "Position", expression: "" };
        },
        check: function (d) {
          return d.expression === "cleared" || "expression: " + d.expression;
        } },

      { name: "delete_mask by name",
        tool: "delete_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off",
                   mask: "ST Off Path" };
        },
        check: function (d) {
          if (d.layer !== "ST Mask Off") return "layer " + d.layer;
          if (d.removed !== "ST Off Path") return "removed " + d.removed;
          var rem = d.remainingMasks;
          return (rem && rem.length === 0) ||
                 "remainingMasks " + JSON.stringify(rem);
        } },

      { name: "…and a second delete finds nothing to delete",
        tool: "delete_mask",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off" };
        },
        check: function (e) {
          if (!/has no masks/.test(e)) return "message was: " + e;
          return /add_mask/.test(e) || "no way out offered: " + e;
        } },

      { name: "delete_mask miss lists the masks that exist",
        tool: "delete_mask",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", mask: "ST Nope" };
        },
        check: function (e) {
          if (!/Mask not found/.test(e)) return "message was: " + e;
          return /ST Path/.test(e) || "the refusal lists no masks: " + e;
        } },

      { name: "a second mask, to delete by index",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", name: "ST Path 2",
                   shape: "rectangle" };
        },
        check: function (d) {
          return d.mask === "ST Path 2" || "mask named " + d.mask;
        } },

      { name: "delete_mask by 1-based index leaves the animated one",
        tool: "delete_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask", mask: 2 };
        },
        check: function (d) {
          if (d.removed !== "ST Path 2") return "removed " + d.removed;
          var rem = (d.remainingMasks || []).join(",");
          return rem === "ST Path" || "remainingMasks " + rem;
        } },

      // ---- a feather is not a blur (row 35) ---------------------------
      // Measured 2026-09-02 through the chat probe, "the background is
      // too sharp behind the icons": the model sent add_mask with the
      // layer's OWN four corners as custom vertices and feather 50, got
      // a bare ok, and told the user the background had been softened.
      // Nothing was. A mask feather fades the mask EDGE and never
      // touches a pixel inside the region, so a region that IS the whole
      // layer cannot blur anything. 'ST Mask Off' is a 200x200 solid
      // with no masks left on it by now.
      { name: "a full-layer feathered mask is warned about, not refused",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off", name: "ST Soft",
                   shape: "custom",
                   vertices: [[0, 0], [200, 0], [200, 200], [0, 200]],
                   feather: 50 };
        },
        check: function (d) {
          if (d.mask !== "ST Soft") return "mask named " + d.mask;
          var w = d.warning || "";
          if (!/covers all of 'ST Mask Off'/.test(w)) return "warning: " + w;
          if (!/200x200/.test(w)) return "the real size is missing: " + w;
          if (!/OUTER EDGE/.test(w) || !/does not blur the picture/.test(w)) {
            return "it does not say what the feather did: " + w;
          }
          // Grounded the way every refusal here is: it names the call
          // that WOULD have done what the sentence asked for.
          return (/apply_effect/.test(w) && /Gaussian Blur/.test(w)) ||
                 "no way out offered: " + w;
        } },

      { name: "…and the mask it warned about was really created",
        tool: "delete_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off", mask: "ST Soft" };
        },
        check: function (d) {
          return d.removed === "ST Soft" || "removed " + d.removed;
        } },

      { name: "…the same coverage with no feather is a plain no-op",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off", name: "ST Flat",
                   shape: "rectangle", bounds: [0, 0, 200, 200] };
        },
        check: function (d) {
          var w = d.warning || "";
          if (!/covers all of 'ST Mask Off'/.test(w)) return "warning: " + w;
          if (!/still shows/.test(w) || !/bounds/.test(w)) {
            return "it does not point at a real region: " + w;
          }
          return !/Gaussian Blur/.test(w) ||
                 "it offered a blur nobody asked for: " + w;
        } },

      // One-sided, like every other verdict in this file: silent wherever
      // "cuts nothing away" is not PROVED. The tool's own default region
      // is the layer's box, and add_mask + set_mask_path opens with it.
      { name: "…but the tool's own default region is never warned about",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off",
                   name: "ST Default", shape: "rectangle" };
        },
        check: function (d) {
          return !d.warning || "the placeholder was warned about: " +
                 d.warning;
        } },

      // Inverted, that same full coverage hides the WHOLE layer.
      { name: "…nor is an inverted one, which hides everything",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off", name: "ST Inv",
                   shape: "rectangle", bounds: [0, 0, 200, 200],
                   inverted: true, feather: 50 };
        },
        check: function (d) {
          return !d.warning || "an inverted mask was warned about: " +
                 d.warning;
        } },

      // ...and a feather on a region that DOES cut something away is the
      // vignette the prompt routes to add_mask. It has to stay silent or
      // the warning is noise on the tool's best use.
      { name: "…nor a feathered mask that really does cut something away",
        tool: "add_mask",
        args: function (ctx) {
          return { comp: ctx.mkComp, layer: "ST Mask Off",
                   name: "ST Vignette", shape: "ellipse",
                   bounds: [20, 20, 160, 160], feather: 20 };
        },
        check: function (d) {
          return !d.warning || "a real vignette was warned about: " +
                 d.warning;
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

      // The plural handed to a SINGULAR tool. Measured 2026-09-02
      // (chat-probe row 36 casual, "drop shadow on every layer but the
      // BG"): the model routed CORRECTLY to apply_effect and passed
      // {layers: [...]}, and the bare "Missing 'layer' (name or 1-based
      // index)" named the absent key but never the key that HAD arrived.
      // The model re-sent the identical call and gave up. These steps run
      // BEFORE the blur, so "applied nothing" is checkable.
      { name: "batch: apply_effect handed {layers} names for_each_layer",
        tool: "apply_effect",
        args: function (ctx) {
          return { comp: ctx.btComp, layers: ["ST Batch", "ST Batch 2"],
                   effect: "Gaussian Blur" };
        },
        expectError: true,
        check: function (err) {
          if (!/you passed 'layers'/.test(err)) {
            return "the refusal never names the key it was handed: " + err;
          }
          if (err.indexOf("ST Batch 2") === -1) {
            return "it does not quote the layers back: " + err;
          }
          if (!/apply_effect/.test(err)) {
            return "it does not name the tool: " + err;
          }
          return /for_each_layer \{layers/.test(err) ||
                 "it does not name for_each_layer: " + err;
        } },

      { name: "batch: and that refusal applied nothing",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.btComp, limit: 0 }; },
        check: function (d) {
          var with_ = [];
          for (var i = 0; i < d.layers.length; i++) {
            var fx = d.layers[i].effects || [];
            if (fx.length) with_.push(d.layers[i].name);
          }
          return with_.length === 0 ||
                 with_.length + " layers already carry an effect: " +
                 with_.slice(0, 5).join(", ");
        } },

      { name: "batch: apply_effect with NO layer lists the comp's layers",
        tool: "apply_effect",
        args: function (ctx) {
          return { comp: ctx.btComp, effect: "Gaussian Blur" };
        },
        expectError: true,
        check: function (err) {
          if (!/Missing 'layer'/.test(err)) return "error was: " + err;
          if (/you passed 'layers'/.test(err)) {
            return "it invented a plural nobody sent: " + err;
          }
          return err.indexOf("ST Batch") !== -1 ||
                 "it named no real layer: " + err;
        } },

      // The mirror: a list under the SINGULAR key. comp.layer([a, b])
      // answered "invalid numeric result (divide by zero?)" in the field.
      { name: "batch: a list under 'layer' is named as a list",
        tool: "link_property",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: ["ST Batch", "ST Batch 2"],
                   property: "opacity", controlLayer: "ST Batch 3",
                   controlEffect: "Slider" };
        },
        expectError: true,
        check: function (err) {
          if (/divide by zero/.test(err)) {
            return "AE's raw error surfaced instead of ours: " + err;
          }
          return (/takes ONE layer, not a list/.test(err) &&
                  err.indexOf("ST Batch 2") !== -1) ||
                 "error was: " + err;
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

      // An EXPRESSION handed over as a VALUE. Measured 2026-09-03
      // (chat-probe row 36 vague, "everything should sit off the
      // background a bit — shadow them, not it"): the model built a
      // slider rig, passed the expression that READS it as
      // set_effect_param's value, and AE answered 'Unable to call
      // "setValue" ... is not a number' — true, and naming no way to do
      // what was asked. The round rolled back and six of seven layers
      // were skipped on an "ok" reply. A rig plus an expression IS how
      // you drive a parameter from a control; the tool that does it was
      // the only missing piece, so the refusal names it.
      { name: "batch: an expression as a VALUE is refused, not passed to AE",
        tool: "set_effect_param",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   effect: "Gaussian Blur", param: "Blurriness",
                   value: 'thisComp.layer("ST Batch").effect("Slider")(1)' };
        },
        expectError: true,
        check: function (err) {
          if (/is not a number/.test(err)) {
            return "AE's raw sentence surfaced instead of ours: " + err;
          }
          if (!/takes a number/.test(err) || err.indexOf("holds 12") === -1) {
            return "the refusal names neither the shape nor the current " +
                   "value: " + err;
          }
          if (!/link_property/.test(err) || !/controlLayer/.test(err)) {
            return "it never names the tool that DOES this: " + err;
          }
          return err.indexOf(
            'property: "effect.Gaussian Blur.Blurriness"') !== -1 ||
            "the link_property path is not paste-ready: " + err;
        } },

      { name: "batch: and that refusal wrote nothing",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   property: "effects/Gaussian Blur/Blurriness" };
        },
        check: function (d) {
          return Math.abs(Number(d.value) - 12) < 1e-6 ||
                 "Blurriness reads " + d.value + ", not the 12 it held";
        } },

      // The half that keeps this a fix and not a new refusal: real AE
      // ACCEPTS a number written as text (measured, setValue("50") reads
      // back 50), so the guard may not reject one.
      { name: "batch: a NUMERIC string still writes",
        tool: "set_effect_param",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   effect: "Gaussian Blur", param: "Blurriness",
                   value: "9" };
        },
        check: function () { return true; } },

      { name: "batch: and AE really took it as the number 9",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   property: "effects/Gaussian Blur/Blurriness" };
        },
        check: function (d) {
          return Math.abs(Number(d.value) - 9) < 1e-6 ||
                 "Blurriness reads " + d.value + ", not 9";
        } },

      // Same root (AELL_writeValue), so the same guard has to hold for
      // the transform tools the model reaches for just as often.
      { name: "batch: set_transform refuses an expression value too",
        tool: "set_transform",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   property: "opacity",
                   value: 'thisComp.layer("ST Batch").effect("Slider")(1)' };
        },
        expectError: true,
        check: function (err) {
          if (/is not a number/.test(err)) {
            return "AE's raw sentence surfaced instead of ours: " + err;
          }
          return (/'opacity' takes a number/.test(err) &&
                  /set_expression/.test(err)) ||
                 "error was: " + err;
        } },

      { name: "batch: put the 60 back to 12 for the steps that follow",
        tool: "set_effect_param",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   effect: "Gaussian Blur", param: "Blurriness", value: 12 };
        },
        check: function (d) {
          return Number(d.value) === 12 || "wrote " + d.value;
        } },

      // The CONTEXT bill of the refusal above. Measured 2026-09-03 in the
      // same field round: for_each_layer printed that ~450-char refusal
      // once PER LAYER, so its "Stopped after 5 failures" summary carried
      // ~2.2 KB in ONE result against a default 16384 ctx — and the very
      // next transcript line was "context trimmed — 2 earlier message(s)
      // dropped". The panel drops HISTORY on overflow, so a repeated
      // refusal deletes the turns the model needs in order to act on it.
      // All six layers hold Blurriness 12, so all six refusals are
      // character-identical: exactly the case that must collapse.
      { name: "batch: an identical per-layer failure is printed ONCE",
        tool: "for_each_layer",
        args: function (ctx) {
          return { comp: ctx.btComp,
                   layers: ["ST Batch 2", "ST Batch 3", "ST Batch 4",
                            "ST Batch 5", "ST Batch 6", "ST Batch 7"],
                   tool: "set_effect_param",
                   args: { effect: "Gaussian Blur", param: "Blurriness",
                           value: 'thisComp.layer("ST Batch").effect("Slider")(1)' } };
        },
        expectError: true,
        check: function (err) {
          if (!/Stopped after 5 failures/.test(err)) {
            return "it did not stop at the failure cap: " + err;
          }
          var copies = String(err).split("link_property").length - 1;
          if (copies !== 1) {
            return "the same refusal is repeated " + copies + " times (" +
                   String(err).length + " chars in one result): " + err;
          }
          if (err.indexOf("ST Batch 2, ST Batch 3, ST Batch 4, ST Batch 5, " +
                          "ST Batch 6: ") === -1) {
            return "the five layers that hit it are not listed together: " +
                   err;
          }
          return String(err).length < 900 ||
                 "one refusal, five layers, still " + String(err).length +
                 " chars: " + err;
        } },

      { name: "batch: and that collapsed failure wrote nothing",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 6",
                   property: "effects/Gaussian Blur/Blurriness" };
        },
        check: function (d) {
          return Math.abs(Number(d.value) - 12) < 1e-6 ||
                 "Blurriness reads " + d.value + ", not the 12 it held";
        } },

      // Failures that differ are NOT merged — collapsing those would hide
      // real problems behind one layer's message. 'Vibrance' is on no
      // layer here, so each refusal names its own layer and stands alone.
      { name: "batch: failures that DIFFER still print one line each",
        tool: "for_each_layer",
        args: function (ctx) {
          return { comp: ctx.btComp,
                   layers: ["ST Batch 8", "ST Batch 9"],
                   tool: "set_effect_param",
                   args: { effect: "Vibrance", param: "Vibrance", value: 20 } };
        },
        check: function (d) {
          // Two failures is under the give-up cap, so this comes back as
          // an ok result carrying a failures string — the OTHER place the
          // grouping runs.
          var f = String(d.failures || "");
          if (d.succeeded !== 0) return "succeeded " + d.succeeded + " of 2";
          if (!/ST Batch 8:/.test(f) || !/ST Batch 9:/.test(f)) {
            return "the two differing failures were merged: " + f;
          }
          return f.indexOf("Effect not found") !== -1 ||
                 "failures do not carry the real reason: " + f;
        } },

      // ---- "Parameter not found" is a CONCEPT map -------------------
      // Measured 2026-09-03 in the same field round: the model asked
      // Drop Shadow for Offset -> Offset X -> Offset Y -> Blurriness
      // across FOUR calls and was shown the complete, correct seven-name
      // roster every time. The list was never hiding the answer and
      // there was nothing to rank; what it never said is that on THIS
      // effect an "offset" IS Distance at a Direction, and a "blur" IS
      // Softness. Drop Shadow is the effect that failure happened on and
      // its roster is measured (scripts/param-concept-probe.jsx).
      { name: "batch: Drop Shadow for the concept-map steps",
        tool: "apply_effect",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   effect: "Drop Shadow" };
        },
        check: function () { return true; } },

      { name: "batch: 'Offset' is answered with Distance and Direction",
        tool: "set_effect_param",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   effect: "Drop Shadow", param: "Offset", value: 10 };
        },
        expectError: true,
        check: function (err) {
          if (!/Parameter not found: Offset/.test(err)) {
            return "the name that missed is not named: " + err;
          }
          if (!/that is: Direction, Distance\./.test(err)) {
            return "an 'offset' is not mapped to the two names that " +
                   "mean it here: " + err;
          }
          return (/'Drop Shadow' has: Shadow Color, Opacity, Direction/
                    .test(err) && /list_properties/.test(err)) ||
                 "the grounded roster or the lister was lost: " + err;
        } },

      { name: "batch: 'Blurriness' is answered with Softness, alone",
        tool: "set_effect_param",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   effect: "Drop Shadow", param: "Blurriness", value: 4 };
        },
        expectError: true,
        check: function (err) {
          if (!/that is: Softness\./.test(err)) {
            return "a 'blur' is not mapped to Softness: " + err;
          }
          return String(err).split("has:")[0].indexOf("Compositing") === -1 ||
                 "the concept clause offered Compositing Options: " + err;
        } },

      // The map may not INVENT. A word that means nothing on this effect
      // has to leave the refusal exactly as it was.
      { name: "batch: an unmappable word gets no suggestion at all",
        tool: "set_effect_param",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   effect: "Drop Shadow", param: "Wobble", value: 1 };
        },
        expectError: true,
        check: function (err) {
          return (/Parameter not found: Wobble\. 'Drop Shadow' has:/
                    .test(err) && !/that is:/.test(err)) ||
                 "a suggestion was invented for a word that means " +
                 "nothing here: " + err;
        } },

      // The other half, and it is AE's own arbitrariness: measured on
      // Drop Shadow, fx.property("distance") RESOLVES and
      // fx.property("DISTANCE") does not, nor does "shadow color". A
      // name that differs only in case or a separator is the SAME name,
      // so the host folds it rather than refusing - the way remove_effect
      // and the render-template picker already do.
      { name: "batch: a shouted parameter name still writes",
        tool: "set_effect_param",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   effect: "Drop Shadow", param: "DISTANCE", value: 30 };
        },
        check: function (d) {
          return d.param === "Distance" ||
                 "the receipt reports '" + d.param + "', not AE's spelling";
        } },

      { name: "batch: and AE really took it on Distance",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   property: "effects/Drop Shadow/Distance" };
        },
        check: function (d) {
          return Math.abs(Number(d.value) - 30) < 1e-6 ||
                 "Distance reads " + d.value + ", not the 30 that was " +
                 "written through the folded name";
        } },

      // The OTHER place a caller names a parameter: the dotted spec that
      // add_keyframe / link_property / set_expression all resolve
      // through. It used to refuse with the name and nothing else - no
      // roster, no concept, nothing to retry from.
      { name: "batch: the dotted property path refuses the same way",
        tool: "add_keyframe",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60", time: 0,
                   value: 4, property: "effect.Drop Shadow.Blurriness" };
        },
        expectError: true,
        check: function (err) {
          if (!/that is: Softness/.test(err)) {
            return "no concept on the dotted path: " + err;
          }
          if (!/'Drop Shadow' has: Shadow Color/.test(err)) {
            return "no roster on the dotted path: " + err;
          }
          return /effect\.Drop Shadow\.<one of those>/.test(err) ||
                 "it never says how to spell the path it wants: " + err;
        } },

      { name: "batch: take the concept-map Drop Shadow back off",
        tool: "remove_effect",
        args: function (ctx) {
          return { comp: ctx.btComp, layer: "ST Batch 60",
                   effect: "Drop Shadow" };
        },
        check: function (d) {
          return d.removed === "Drop Shadow" ||
                 "removed '" + d.removed + "'";
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

      // ---- what the rollback reaches, and what its check can SEE ----
      //
      // Two questions the log carried for four passes, both answered in
      // real AE on 2026-08-29. (1) Does the one Undo reach PROJECT
      // ITEMS? It does — comps, folders, duplicates, deletions, moves
      // and renames all revert, and the steps below keep it that way.
      // (2) Does AELL_fingerprint — the check that proves the Undo
      // landed EXACTLY on the pre-round state, and the only guard
      // against it overshooting into the user's own last edit — see the
      // dimensions those tools write? It did not: of 25 dimensions
      // measured, AE reverted all 25 and the fingerprint saw 4.
      //
      // A suite step cannot make a TORN write (no tool leaves a change
      // the undo stack cannot reverse), so the stubbed test owns that
      // half. What these steps own is the other risk the widening
      // created: a field AE reports with noise would make the
      // fingerprints differ after a PERFECT undo, and every rollback in
      // the product would start reporting itself as an abandoned
      // overshoot. Each step below fails loudly if that ever happens.

      { name: "an armed round that created a COMP and failed undoes it",
        batchOpts: { rollback: true },
        batch: function (ctx) {
          return [
            { tool: "create_comp",
              args: { name: "ST RB Ghost Comp", width: 160, height: 120,
                      duration: 2, frameRate: 30 } },
            { tool: "duplicate_layer",
              args: { comp: ctx.rbComp, layer: "ST No Source", count: 1 } }
          ];
        },
        check: function (rows) {
          if (rows[0].ok) return "create_comp still reports ok";
          return rows[0].rolledBack ||
                 "the comp-creating round was not rolled back: " +
                 String(rows[0].error).slice(0, 120);
        } },

      { name: "and the comp it made is not in the project",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d) {
          var items = d.items || d.comps || [];
          for (var i = 0; i < items.length; i++) {
            var n = items[i] && (items[i].name || items[i]);
            if (String(n) === "ST RB Ghost Comp") {
              return "the rolled-back comp is still in the project";
            }
          }
          return true;
        } },

      { name: "an armed round that changed COMP SETTINGS and failed " +
              "puts them back",
        batchOpts: { rollback: true },
        batch: function (ctx) {
          return [
            { tool: "set_comp_setting",
              args: { comp: ctx.rbComp, workAreaStart: 1,
                      workAreaDuration: 1, resolution: "quarter" } },
            { tool: "duplicate_layer",
              args: { comp: ctx.rbComp, layer: "ST No Source", count: 1 } }
          ];
        },
        check: function (rows) {
          if (rows[0].ok) return "set_comp_setting still reports ok";
          if (!rows[0].rolledBack) {
            return "a comp-settings round was NOT rolled back — if the " +
                   "reason is 'did not land on the pre-round state', a " +
                   "comp setting in AELL_fingerprint is reading noise: " +
                   String(rows[0].error).slice(0, 160);
          }
          return true;
        } },

      { name: "the work area and resolution are the ones from before it",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.rbComp, limit: 0 }; },
        check: function (d) {
          if (d.workArea !== "0s-4s") {
            return "work area is " + d.workArea + ", expected the " +
                   "whole 4s comp back";
          }
          return d.resolution === "full [1, 1]" ||
                 "resolution is " + d.resolution + ", expected full [1, 1]";
        } },

      { name: "an armed round that turned a layer 3D and failed leaves " +
              "it 2D",
        batchOpts: { rollback: true },
        batch: function (ctx) {
          return [
            { tool: "set_layer_3d",
              args: { comp: ctx.rbComp, layer: "ST RB Survivor",
                      enabled: true } },
            { tool: "add_marker",
              args: { comp: ctx.rbComp, layer: "ST RB Survivor", time: 1,
                      comment: "ST RB mark" } },
            { tool: "set_solid_color",
              args: { comp: ctx.rbComp, layer: "ST RB Survivor",
                      color: [0, 0, 1], makeUnique: true } },
            { tool: "duplicate_layer",
              args: { comp: ctx.rbComp, layer: "ST No Source", count: 1 } }
          ];
        },
        check: function (rows) {
          // Four dimensions at once, three of them invisible to the
          // fingerprint before 2026-08-29: the 3D switch, a layer
          // marker, and the solid SOURCE's colour (which makeUnique
          // turns into a new project item as well).
          for (var i = 0; i < 3; i++) {
            if (rows[i].ok) return "row " + i + " still reports ok";
            if (!rows[i].rolledBack) {
              return "row " + i + " was not rolled back: " +
                     String(rows[i].error).slice(0, 160);
            }
          }
          return true;
        } },

      { name: "and get_bounds no longer calls it a 3D layer",
        tool: "get_bounds",
        args: function (ctx) {
          return { comp: ctx.rbComp, layer: "ST RB Survivor" };
        },
        check: function (d) {
          return !d.compBoxUnavailable ||
                 "still 3D after the rollback: " + d.compBoxUnavailable;
        } },

      { name: "an armed round that RENAMED an item and failed puts the " +
              "name back",
        batchOpts: { rollback: true },
        batch: function (ctx) {
          return [
            { tool: "rename_item",
              args: { item: ctx.rbComp, name: "ST RB Renamed" } },
            { tool: "duplicate_layer",
              args: { comp: "ST RB Renamed", layer: "ST No Source",
                      count: 1 } }
          ];
        },
        check: function (rows) {
          if (rows[0].ok) return "rename_item still reports ok";
          return rows[0].rolledBack ||
                 "the rename was not rolled back: " +
                 String(rows[0].error).slice(0, 160);
        } },

      { name: "so the comp still answers to the name it started with",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.rbComp, limit: 0 }; },
        check: function (d, ctx) {
          return d.name === ctx.rbComp ||
                 "comp is called " + d.name + ", expected " + ctx.rbComp;
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

      // The refusal that used to be the bare string "Missing 'property'".
      // With the real model it was the most-hit error in the whole tool
      // suite (chat-probe step 23: all four phrasings omitted the arg),
      // and it handed back nothing to correct with.
      { name: "a missing 'property' names the wiggle target AND the effects",
        tool: "apply_expression_preset",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", preset: "wiggle" };
        },
        check: function (err) {
          if (err.indexOf("'position' is the drift/float/hover one") === -1) {
            return "does not say which property wiggle meant: " + err;
          }
          if (err.indexOf("position, scale, rotation, opacity or " +
                          "anchorPoint") === -1) {
            return "does not list the transform words: " + err;
          }
          return err.indexOf("ST Cov Amp") !== -1 ||
                 "does not list the layer's own effects: " + err;
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

      // Three rotation keys exist now, which is the half of the refusal
      // a loop_* caller actually needs: WHICH property carries keys.
      { name: "…and for a loop preset it names the keyframed property",
        tool: "apply_expression_preset",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   preset: "loop_cycle" };
        },
        check: function (err) {
          if (err.indexOf("the property that HAS the keyframes") === -1) {
            return "does not ask for the keyframed property: " + err;
          }
          return err.indexOf("Already keyframed here: rotation") !== -1 ||
                 "does not name the property that has keys: " + err;
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

      // …and the value it LEAVES BEHIND, which is the whole point of
      // "un-animate it". The keys were 0s=0, 1s=90, 2s=180 and the host
      // empties a property by removing key 1 over and over, so the last
      // one standing is the last in TIME and AE holds its value: 180,
      // not the 0 it started from and not whatever the playhead was
      // over. Measured 2026-09-02 with two rigs emptied at different
      // playheads (scripts/verb-semantics-probe.jsx); this step is what
      // keeps the promise the remove_keyframes doc now makes.
      { name: "…leaving the LAST key's value behind, not the first",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "rotation" };
        },
        check: function (d) {
          if (d.numKeys !== 0) return "still keyed: " + d.numKeys;
          return Math.abs(d.value - 180) < 0.001 ||
                 "rotation settled at " + d.value + ", not 180";
        } },

      // ---- the carpet-bomb gate --------------------------------
      //
      // Measured 2026-09-02 in real AE (chat-probe row 29, "Probe Room's
      // got junk everywhere, tidy it"): nobody named a layer, the model
      // met the grounded no-targets refusal, copied all twelve names
      // back out of it into ONE call, and remove_keyframes answered
      // {"layers":12,"property":"opacity","removed":18}. clean_project
      // and organize_project both refuse that shape until the user has
      // SEEN it; this tool had no gate at all.
      { name: "wipe rig: a comp whose whole roster can be named",
        tool: "create_comp",
        args: { name: WPCOMP, width: 320, height: 240, duration: 3,
                frameRate: 25 },
        check: function (d, ctx) {
          ctx.wpComp = d.name;
          ctx.wpLayers = ["ST Wipe A", "ST Wipe B", "ST Wipe C"];
          // Not pinned to the exact name: AE auto-numbers a taken one,
          // and every later step here works from ctx.wpComp anyway.
          return typeof d.name === "string" || "no comp name";
        } },
      { name: "wipe rig: solid A",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.wpComp, name: "ST Wipe A", color: [1, 0, 0],
                   width: 80, height: 80 };
        },
        check: function (d) { return d.name === "ST Wipe A" || d.name; } },
      { name: "wipe rig: solid B",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.wpComp, name: "ST Wipe B", color: [0, 1, 0],
                   width: 80, height: 80 };
        },
        check: function (d) { return d.name === "ST Wipe B" || d.name; } },
      { name: "wipe rig: solid C",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.wpComp, name: "ST Wipe C", color: [0, 0, 1],
                   width: 80, height: 80 };
        },
        check: function (d) { return d.name === "ST Wipe C" || d.name; } },
      { name: "wipe rig: two opacity keys on each of the three",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.wpComp, layers: ctx.wpLayers,
                   property: "opacity",
                   keys: [{ time: 0, value: 0 }, { time: 1, value: 100 }] };
        },
        check: function (d) {
          return d.keysSet === 6 || "keysSet " + d.keysSet;
        } },

      { name: "naming EVERY layer in the comp is refused, with the count",
        tool: "remove_keyframes",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.wpComp, layers: ctx.wpLayers,
                   property: "opacity" };
        },
        check: function (err) {
          if (err.indexOf("refused to wipe every layer") === -1) {
            return "err: " + err;
          }
          if (err.indexOf("delete 6 opacity keyframe(s) from 3 layer(s)")
              === -1) {
            return "the preview does not count what would go: " + err;
          }
          return err.indexOf("ask the user WHICH") !== -1 ||
                 "no question to relay: " + err;
        } },
      // …and nothing went. The refusal has to be a refusal, not a note
      // printed after the deletion.
      { name: "…and the keys are all still there",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.wpComp, layer: "ST Wipe A",
                   property: "opacity" };
        },
        check: function (d) {
          return d.numKeys === 2 || "numKeys " + d.numKeys;
        } },
      // Retrying inside the SAME reply is refused too, and that is the
      // branch the field failure needs: the round that lost 18 keyframes
      // made sixteen calls without the user seeing one of them. The whole
      // suite runs as one request (AELL_requestSeq is bumped per chat
      // turn, not per step), so this is the branch real AE can show. The
      // release — a LATER request goes through — needs a second turn and
      // is pinned in tests/test-property-access.js instead.
      { name: "…and retrying it in the same reply is refused too",
        tool: "remove_keyframes",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.wpComp, layers: ctx.wpLayers,
                   property: "opacity" };
        },
        check: function (err) {
          return err.indexOf("THIS same reply") !== -1 || "err: " + err;
        } },
      { name: "…and the keys survived the retry as well",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.wpComp, layer: "ST Wipe C",
                   property: "opacity" };
        },
        check: function (d) {
          return d.numKeys === 2 || "numKeys " + d.numKeys;
        } },
      // Narrow on purpose: two of the three layers is the ordinary case
      // and is never gated, however fresh the project is.
      { name: "a named SUBSET is not gated",
        tool: "remove_keyframes",
        args: function (ctx) {
          return { comp: ctx.wpComp,
                   layers: [ctx.wpLayers[0], ctx.wpLayers[1]],
                   property: "opacity" };
        },
        check: function (d) {
          return d.removed === 4 || "removed " + d.removed;
        } },
      // Nor is a whole-comp call with nothing to lose: a refusal about a
      // provable no-op is noise, the same reason organize_project does
      // not gate an empty plan.
      { name: "a whole-comp wipe with no keys to lose is not gated",
        tool: "remove_keyframes",
        args: function (ctx) {
          return { comp: ctx.wpComp, layers: ctx.wpLayers,
                   property: "rotation" };
        },
        check: function (d) {
          return d.removed === 0 || "removed " + d.removed;
        } },

      // Every other rig comp in this suite is deleted by the step that
      // finishes with it; this one never was, so ten runs on this machine
      // left "AELL Self-Test Wipe" through "…Wipe 10" in the user's
      // project. The check at the bottom could not see them either — it
      // looks for the "ST " namespace and for new FOOTAGE, and a comp
      // called "AELL Self-Test …" is neither. It turned the harness red
      // in the end, from a long way off: reduce_project's refusal lists
      // the project's comps and TRUNCATES the list, and the tenth leaked
      // Wipe comp pushed the comp that step looks for off the end of it.
      { name: "cleanup: delete the carpet-bomb rig comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.wpComp }; },
        check: function () { return true; } },

      // ---- "nothing to stagger" rig. Field run 2026-09-03, row 32:
      // three of four phrasings called stagger_layers ALONE on layers
      // with no keyframes. It moved six start times and answered
      // ok {layers:6, spread:2.5, placed:[…]} — a success receipt for a
      // comp where nothing fades. The tool now scans its targets and
      // says so, and every clause of that scan is an AE fact worth
      // pinning in real AE (see scripts/stagger-motion-probe.jsx).
      { name: "stagger rig: a comp nothing has animated",
        tool: "create_comp",
        args: { name: SMCOMP, width: 320, height: 240, duration: 4,
                frameRate: 30 },
        check: function (d, ctx) {
          ctx.smComp = d.name;
          ctx.smLayers = ["ST Stag A", "ST Stag B", "ST Stag C"];
          return typeof d.name === "string" || "no comp name";
        } },
      { name: "stagger rig: solid A",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.smComp, name: "ST Stag A", color: [1, 0, 0],
                   width: 60, height: 60 };
        },
        check: function (d) { return d.name === "ST Stag A" || d.name; } },
      { name: "stagger rig: solid B",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.smComp, name: "ST Stag B", color: [0, 1, 0],
                   width: 60, height: 60 };
        },
        check: function (d) { return d.name === "ST Stag B" || d.name; } },
      { name: "stagger rig: solid C",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.smComp, name: "ST Stag C", color: [0, 0, 1],
                   width: 60, height: 60 };
        },
        check: function (d) { return d.name === "ST Stag C" || d.name; } },

      { name: "staggering unanimated layers WARNS that nothing moves",
        tool: "stagger_layers",
        args: function (ctx) {
          return { comp: ctx.smComp, layers: ctx.smLayers, spread: 2,
                   startAt: 0 };
        },
        check: function (d) {
          if (d.layers !== 3) return "layers " + d.layers;
          if (!d.warning) return "no warning at all";
          if (d.warning.indexOf("nothing on these 3 layers varies over " +
                                "time") === -1) {
            return "warning does not name the finding: " + d.warning;
          }
          if (d.warning.indexOf("set_keyframes") === -1 ||
              d.warning.indexOf("relativeTo") === -1) {
            return "warning does not say what to do next: " + d.warning;
          }
          // …and the placement it warns about still happened, so the
          // warning is a warning and not a silent refusal.
          return (d.placed && d.placed.length === 3 &&
                  Math.abs(d.placed[2].startTime - 2) < 0.01) ||
                 "the stagger itself did not land: " +
                 JSON.stringify(d.placed);
        } },

      // A MARKER reads numKeys > 0 in real AE (measured: Marker is root
      // property 1 on every layer type, and it is a LEAF). A scan that
      // counted it would go quiet on exactly the layers this is for.
      { name: "…a marker is not animation",
        tool: "add_marker",
        args: function (ctx) {
          return { comp: ctx.smComp, layer: "ST Stag A", time: 1,
                   comment: "not animation" };
        },
        check: function () { return true; } },
      { name: "…so the warning survives a marked layer",
        tool: "stagger_layers",
        args: function (ctx) {
          return { comp: ctx.smComp, layers: ctx.smLayers, spread: 2,
                   startAt: 0 };
        },
        check: function (d) {
          return (d.warning &&
                  d.warning.indexOf("varies over time") !== -1) ||
                 "a marker silenced it: " + (d.warning || "(no warning)");
        } },

      // One keyframe anywhere and it goes quiet: the warning speaks only
      // when EVERY target is static.
      { name: "…two opacity keys on ONE of the three",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.smComp, layers: ["ST Stag B"],
                   property: "opacity",
                   keys: [{ time: 0, value: 0 }, { time: 1, value: 100 }] };
        },
        check: function (d) {
          return d.keysSet === 2 || "keysSet " + d.keysSet;
        } },
      { name: "…and one animated layer among three silences the warning",
        tool: "stagger_layers",
        args: function (ctx) {
          return { comp: ctx.smComp, layers: ctx.smLayers, spread: 2,
                   startAt: 0 };
        },
        check: function (d) {
          return !d.warning || "still warned: " + d.warning;
        } },

      // An EFFECT with no keyframes silences it too. Some effects animate
      // on their own at zero keys (CC Particle World, Radio Waves), so an
      // effect is doubt — and a warning that says nothing animates has to
      // be right.
      { name: "…keys off again, and an unkeyed effect on one layer",
        batch: function (ctx) {
          return [
            { tool: "remove_keyframes",
              args: { comp: ctx.smComp, layers: ["ST Stag B"],
                      property: "opacity" } },
            { tool: "apply_effect",
              args: { comp: ctx.smComp, layer: "ST Stag C",
                      effect: "Fast Box Blur" } }
          ];
        },
        check: function (rows) {
          if (rows.length !== 2) return "rows " + rows.length;
          if (!rows[0].ok) return "remove_keyframes: " + rows[0].error;
          return rows[1].ok || "apply_effect: " + rows[1].error;
        } },
      { name: "…an unkeyed EFFECT is doubt enough to stay quiet",
        tool: "stagger_layers",
        args: function (ctx) {
          return { comp: ctx.smComp, layers: ctx.smLayers, spread: 2,
                   startAt: 0 };
        },
        check: function (d) {
          return !d.warning || "warned past an effect: " + d.warning;
        } },

      { name: "cleanup: delete the stagger rig comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.smComp }; },
        check: function () { return true; } },

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

      // ---- remove_effect (audit 0.11 item 4) ---------------------------
      // The two blurs above share one matchName. A matchName call takes
      // the FIRST and says what else matched; the tie the search refused
      // is then gone, which the bare-name read proves.
      { name: "remove_effect by matchName takes the first of two, and says so",
        tool: "remove_effect",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   effect: "ADBE Gaussian Blur 2" };
        },
        check: function (d) {
          if (d.layer !== "ST Cov Box") return "layer " + d.layer;
          if (d.removed !== "Gaussian Blur") return "removed " + d.removed;
          var also = (d.alsoMatched || []).join(",");
          if (also !== "Gaussian Blur 2") return "alsoMatched " + also;
          if (!/removed the first/.test(d.note || "")) {
            return "the duplicate went unmentioned: " + d.note;
          }
          var rem = d.remainingEffects || [];
          var hasFirst = false, hasSecond = false;
          for (var i = 0; i < rem.length; i++) {
            if (rem[i] === "Gaussian Blur") hasFirst = true;
            if (rem[i] === "Gaussian Blur 2") hasSecond = true;
          }
          if (hasFirst) return "'Gaussian Blur' is still listed";
          return hasSecond || "'Gaussian Blur 2' vanished too: " + rem;
        } },

      { name: "read-back: the tie is gone, so the bare name resolves",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   property: "Blurriness" };
        },
        check: function (d) {
          return d.resolvedPath === "Effects/Gaussian Blur 2/Blurriness" ||
                 "resolved to " + d.resolvedPath;
        } },

      { name: "remove_effect by display name takes the survivor",
        tool: "remove_effect",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box",
                   effect: "Gaussian Blur 2" };
        },
        check: function (d) {
          if (d.removed !== "Gaussian Blur 2") return "removed " + d.removed;
          if (d.alsoMatched) return "alsoMatched " + d.alsoMatched;
          var rem = d.remainingEffects || [];
          for (var i = 0; i < rem.length; i++) {
            if (/^Gaussian Blur/.test(rem[i])) {
              return "a blur is still listed: " + rem[i];
            }
          }
          return rem.length > 0 || "the controls vanished with it";
        } },

      { name: "remove_effect miss lists the effects that exist",
        tool: "remove_effect",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", effect: "Glow" };
        },
        check: function (e) {
          if (!/No effect 'Glow'/.test(e)) return "message was: " + e;
          return /ST Cov Amp/.test(e) || "the refusal lists no effects: " + e;
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

      { name: "an off-grid work area snaps to a frame, and says so",
        tool: "set_comp_setting",
        args: function (ctx) {
          return { comp: ctx.cvComp, workAreaStart: 0.333,
                   workAreaDuration: 1.7 };
        },
        check: function (d) {
          // Measured in AE 2026: on a 24 fps comp 0.333s becomes frame 8
          // (0.333333s) and 1.7s becomes 41 frames (1.708333s), silently.
          if (Math.abs(d.workAreaStart - 8 / 24) > 0.0005 ||
              Math.abs(d.workAreaDuration - 41 / 24) > 0.0005) {
            return "AE holds " + d.workAreaStart + " / " + d.workAreaDuration;
          }
          return (d.note || "").indexOf("frame 8") !== -1 ||
                 "the snap was not reported: " + d.note;
        } },

      { name: "a work area past the comp's end is refused, not clamped",
        tool: "set_comp_setting",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, workAreaStart: 4, workAreaDuration: 9 };
        },
        check: function (err) {
          if (err.indexOf("past the end") === -1) {
            return "not a range refusal: " + err;
          }
          return err.indexOf("2s") !== -1 ||
                 "does not say what DOES fit from there: " + err;
        } },

      { name: "an invented resolution is refused with the real ones",
        tool: "set_comp_setting",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.cvComp, resolution: "low" };
        },
        check: function (err) {
          return (err.indexOf("'half'") !== -1 &&
                  err.indexOf("'quarter'") !== -1) ||
                 "does not name the real resolutions: " + err;
        } },

      { name: "and the comp is put back the way the suite found it",
        tool: "set_comp_setting",
        args: function (ctx) {
          return { comp: ctx.cvComp, workArea: "comp" };
        },
        check: function (d) {
          return d.workArea === "0s-6s" || "work area reads " + d.workArea;
        } },

      { name: "duplicate_comp copies it, settings and all",
        tool: "duplicate_comp",
        args: function (ctx) {
          return { comp: ctx.cvComp, name: "ST Cov Copy" };
        },
        check: function (d, ctx) {
          ctx.cvCopy = d.name;
          if (d.name !== "ST Cov Copy") return "named " + d.name;
          if (d.duplicatedFrom !== ctx.cvComp) {
            return "duplicatedFrom " + d.duplicatedFrom;
          }
          // AE puts the copy in the SOURCE'S folder, and the coverage comp
          // is a root one, so this is where the copy has to be.
          return d.folder === "Root" || "folder " + d.folder;
        } },

      // ---- what duplicate_comp used to do silently. Measured in AE 2026
      // (probe 2026-08-29, WORKPLAN-LOG): the copy SHARES its layers'
      // sources, AE accepts a name another item already holds (and a
      // by-name walk then finds the older one), and it accepts a blank
      // name too.
      { name: "the copy is told it SHARES the solid it was copied with",
        tool: "duplicate_comp",
        args: function (ctx) { return { comp: ctx.cvComp }; },
        check: function (d, ctx) {
          ctx.cvShared = d.name;
          if (d.name !== ctx.cvComp + " 2") {
            return "AE named the copy " + d.name;
          }
          var list = (d.sharedSources || []).join(" | ");
          if (list.indexOf("ST Cov Box (solid)") === -1) {
            return "sharedSources: " + (list || "(none)");
          }
          return (d.sharedNote || "").indexOf("both comps") !== -1 ||
                 "the consequence is not stated: " + d.sharedNote;
        } },

      { name: "cleanup: delete that copy",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.cvShared }; },
        check: function () { return true; } },

      { name: "a name another item already holds is auto-numbered",
        tool: "duplicate_comp",
        args: function (ctx) {
          // The SOURCE'S own name: the collision case that must NOT
          // redirect later commands, since they still mean the original.
          return { comp: ctx.cvComp, name: ctx.cvComp };
        },
        check: function (d, ctx) {
          ctx.cvTaken = d.name;
          if (d.name !== ctx.cvComp + " 2") return "named " + d.name;
          return (d.nameTaken || "").indexOf("copied FROM") !== -1 ||
                 "no nameTaken note: " + d.nameTaken;
        } },

      { name: "and the original still answers to its own name",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.cvComp }; },
        check: function (d, ctx) {
          return d.name === ctx.cvComp || "'" + ctx.cvComp +
                 "' now resolves to " + d.name;
        } },

      { name: "cleanup: delete the auto-numbered copy",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.cvTaken }; },
        check: function () { return true; } },

      { name: "a blank name is refused, not made",
        tool: "duplicate_comp",
        expectError: true,
        args: function (ctx) { return { comp: ctx.cvComp, name: "   " }; },
        check: function (err) {
          return err.indexOf("blank") !== -1 || "err: " + err;
        } },

      { name: "an expression naming the source comp is set up",
        tool: "set_expression",
        args: function (ctx) {
          return { comp: ctx.cvComp, layer: "ST Cov Box", property: "opacity",
                   expression: 'comp("' + ctx.cvComp +
                     '").layer("ST Cov Box").transform.rotation + 100' };
        },
        check: function (d) { return true; } },

      { name: "the copy is told which expressions still drive off the source",
        tool: "duplicate_comp",
        args: function (ctx) { return { comp: ctx.cvComp }; },
        check: function (d, ctx) {
          ctx.cvExprCopy = d.name;
          var list = (d.stillDrivenBySource || []).join(" | ");
          // AE copies the expression verbatim and leaves expressionError
          // EMPTY, so this report is the only place it is ever mentioned.
          if (list.indexOf("ST Cov Box > Opacity") === -1) {
            return "stillDrivenBySource: " + (list || "(none)");
          }
          return (d.expressionNote || "").indexOf("thisComp") !== -1 ||
                 "no route out of it: " + d.expressionNote;
        } },

      { name: "cleanup: delete the expression copy and clear the expression",
        batch: function (ctx) {
          return [
            { tool: "delete_item", args: { item: ctx.cvExprCopy } },
            { tool: "set_expression",
              args: { comp: ctx.cvComp, layer: "ST Cov Box",
                      property: "opacity", expression: "" } }
          ];
        },
        check: function (rows) {
          return rows[0].ok || "delete: " + rows[0].error;
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

      // ---- text animators (WORKPLAN 5.1). add_text_animator is new, and
      // every assertion below comes from the probe in WORKPLAN-LOG
      // 2026-08-28: an animator ships with all 103 properties already
      // present and hidden, canSetExpression is the only flag that knows
      // which were added, adding a second animator invalidates every
      // reference into the first, AE lets two animators share a name, and
      // per-character 3D drags the layer's own 3D switch on with it.
      //
      // Its own comp for exactly that last reason.
      { name: "text-animator rig comp",
        tool: "create_comp",
        args: { name: TXCOMP, width: 640, height: 480, duration: 6,
                frameRate: 30 },
        check: function (d, ctx) { ctx.txComp = d.name; return true; } },

      { name: "text-animator rig: a text layer and a solid",
        batch: function (ctx) {
          return [
            { tool: "add_text_layer", args: { comp: ctx.txComp,
                text: "ANIMATE ME", fontSize: 48 } },
            { tool: "add_solid", args: { comp: ctx.txComp,
                name: "ST Anim Solid", color: [0.3, 0.3, 0.3],
                width: 80, height: 80 } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok) return "text layer: " + rows[0].error;
          if (!rows[1].ok) return "solid: " + rows[1].error;
          ctx.txLayer = rows[0].data.name;
          return true;
        } },

      { name: "add_text_animator refuses a non-text layer",
        tool: "add_text_animator",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.txComp, layer: "ST Anim Solid",
                   properties: { opacity: 0 } };
        },
        check: function (err, ctx) {
          if (/After Effects error/.test(err)) return "leaks AE's throw: " + err;
          return (/TEXT layers/.test(err) && err.indexOf(ctx.txLayer) >= 0) ||
                 "does not name the text layer to use instead: " + err;
        } },

      { name: "add_text_animator refuses a property AE does not have",
        tool: "add_text_animator",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   properties: { wobble: 5 } };
        },
        check: function (err) {
          return (/No animator property named wobble/.test(err) &&
                  /opacity/.test(err)) ||
                 "does not list the real properties: " + err;
        } },

      // Percent Start/End/Offset are -100..100 in AE (101 throws). The
      // refusal has to come BEFORE an animator is built, or the user is
      // left cleaning one up.
      { name: "add_text_animator refuses a percent outside -100..100",
        tool: "add_text_animator",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   properties: { opacity: 0 }, selector: { end: 400 } };
        },
        check: function (err) {
          return (/PERCENT/.test(err) && /index/.test(err)) ||
                 "does not explain percent vs index: " + err;
        } },

      { name: "no animator was built by the refusals",
        tool: "list_properties",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   path: "Text/Animators" };
        },
        check: function (d) {
          return d.count === 0 ||
                 "Text/Animators has " + d.count + " children, expected 0";
        } },

      { name: "add_text_animator builds animator, properties and selector",
        tool: "add_text_animator",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   properties: { opacity: 0, position: [0, -80] },
                   selector: { start: 0, end: 40, offset: -10,
                               shape: "rampUp", easeHigh: 50 } };
        },
        check: function (d, ctx) {
          ctx.txAnim = d.animator;
          ctx.txSelPath = d.selector && d.selector.path;
          if (d.animator !== "Animator 1") {
            return "animator named " + d.animator;
          }
          if (d.problems) return "problems: " + d.problems.join("; ");
          if (!d.properties || d.properties.length !== 2) {
            return "properties: " + JSON.stringify(d.properties);
          }
          if (!ctx.txSelPath ||
              ctx.txSelPath.indexOf("Range Selector 1") < 0) {
            return "selector path " + ctx.txSelPath;
          }
          return /set_keyframes/.test(d.animateHint || "") ||
                 "no hint about keyframing the selector";
        } },

      // The property must be ADDED, not merely written to: AE keeps a
      // value on a hidden property and never renders it.
      { name: "the animator property reads back active",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   property: "Text/Animators/" + ctx.txAnim +
                             "/Properties/Opacity" };
        },
        check: function (d) {
          if (d.inactive) return "reported inactive: " + d.inactive;
          return d.value === 0 || "opacity is " + d.value + ", expected 0";
        } },

      { name: "a 2-number position was padded to the 3 AE keeps",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   property: "Text/Animators/" + ctx.txAnim +
                             "/Properties/Position" };
        },
        check: function (d) {
          return String(d.value) === "0,-80,0" ||
                 "position " + JSON.stringify(d.value);
        } },

      // The other hundred slots are still there and still hidden, and the
      // panel now says so instead of handing back a value AE ignores.
      { name: "an unadded animator property reads back flagged inactive",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   property: "Text/Animators/" + ctx.txAnim +
                             "/Properties/Skew" };
        },
        check: function (d) {
          return /never applied/.test(d.inactive || "") ||
                 "not flagged: " + JSON.stringify(d);
        } },

      { name: "set_property refuses a bare name that is only a hidden slot",
        tool: "set_property",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   property: "Skew", value: 20 };
        },
        check: function (err) {
          if (/property or a parent property is hidden/.test(err)) {
            return "leaks AE's raw hidden error: " + err;
          }
          return /add_text_animator/.test(err) ||
                 "does not name the tool that activates it: " + err;
        } },

      { name: "set_keyframes refuses a hidden slot before writing key 1",
        tool: "set_keyframes",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   property: "Text/Animators/" + ctx.txAnim +
                             "/Properties/Skew",
                   keys: [{ time: 0, value: 0 }, { time: 1, value: 30 }] };
        },
        check: function (err) {
          return /has not been added/.test(err) || "wrong refusal: " + err;
        } },

      // The half a static animator is missing: the selector has to MOVE.
      { name: "the selector Offset takes keyframes (the typewriter half)",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   property: ctx.txSelPath + "/Offset",
                   keys: [{ time: 0, value: -100 }, { time: 2, value: 100 }] };
        },
        check: function (d) {
          return d.numKeys === 2 || "numKeys " + d.numKeys;
        } },

      { name: "and they read back off the selector's own path",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   property: ctx.txSelPath + "/Offset" };
        },
        check: function (d) {
          if (d.numKeys !== 2) return "numKeys " + d.numKeys;
          return (d.keys[0].value === -100 && d.keys[1].value === 100) ||
                 "keys " + JSON.stringify(d.keys);
        } },

      // A SECOND animator on the same layer is the reference trap: AE
      // invalidates everything held into animator 1 at this moment.
      { name: "a second animator on the same layer survives the trap",
        tool: "add_text_animator",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer, name: "ST Cascade",
                   properties: { rotation: 20 },
                   selector: { units: "index", start: 0, end: 3 } };
        },
        check: function (d, ctx) {
          ctx.txAnim2 = d.animator;
          if (d.animator !== "ST Cascade") return "named " + d.animator;
          if (d.problems) return "problems: " + d.problems.join("; ");
          return (d.selector && d.selector.settings &&
                  d.selector.settings.units === "index") ||
                 "units not reported: " + JSON.stringify(d.selector);
        } },

      // Units 'index' means the INDEX triple. AE keeps both, and a lookup
      // by the display name "End" finds the PERCENT one either way.
      { name: "units 'index' wrote the index triple, not the percent one",
        batch: function (ctx) {
          var base = "Text/Animators/" + ctx.txAnim2 +
                     "/Selectors/Range Selector 1";
          return [
            { tool: "get_property", args: { comp: ctx.txComp,
                layer: ctx.txLayer, property: base + "/End" } },
            { tool: "list_properties", args: { comp: ctx.txComp,
                layer: ctx.txLayer, path: base } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "get: " + rows[0].error;
          if (!rows[1].ok) return "list: " + rows[1].error;
          if (rows[0].data.matchName !== "ADBE Text Percent End") {
            return "name lookup found " + rows[0].data.matchName;
          }
          if (rows[0].data.value !== 100) {
            return "percent End was written: " + rows[0].data.value;
          }
          var props = rows[1].data.properties, i, idx = null;
          for (i = 0; i < props.length; i++) {
            if (props[i].matchName === "ADBE Text Index End") {
              idx = props[i].value;
            }
          }
          return idx === 3 || "index End is " + idx + ", expected 3";
        } },

      { name: "the first animator kept what it was given",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   property: "Text/Animators/" + ctx.txAnim +
                             "/Properties/Opacity" };
        },
        check: function (d) {
          return d.value === 0 || "opacity is " + d.value;
        } },

      // AE lets a second animator take the same name and then answers a
      // name lookup with the FIRST, stranding this one.
      { name: "a repeated animator name is auto-numbered and reported",
        tool: "add_text_animator",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer, name: "ST Cascade",
                   properties: { skew: 15 }, selector: { type: "none" } };
        },
        check: function (d) {
          if (d.animator === "ST Cascade") {
            return "took the name AE would strand it under";
          }
          return (/already an animator/.test(d.nameTaken || "") &&
                  /every character/.test(String(d.selector))) ||
                 "nameTaken: " + d.nameTaken + " selector: " +
                 JSON.stringify(d.selector);
        } },

      // Per-character 3D is a LAYER switch: yRotation is addable without
      // it and renders nothing, so the tool turns it on and says so.
      { name: "yRotation turns per-character 3D on and reports it",
        tool: "add_text_animator",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   properties: { yRotation: 90 }, selector: { type: "none" } };
        },
        check: function (d) {
          if (!d.perCharacter3D) return "said nothing about per-character 3D";
          return /3D layer/.test(d.perCharacter3D) ||
                 "does not mention the layer becoming 3D: " + d.perCharacter3D;
        } },

      // ...and the switch really took in AE: a second 3D-only property on
      // the same layer has nothing left to turn on.
      { name: "the per-character 3D switch stayed on for the next animator",
        tool: "add_text_animator",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   properties: { xRotation: 45 }, selector: { type: "none" } };
        },
        check: function (d) {
          return !d.perCharacter3D ||
                 "reported turning it on twice: " + d.perCharacter3D;
        } },

      { name: "a wiggly selector takes its own parameters",
        tool: "add_text_animator",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   properties: { position: [0, 10] },
                   selector: { type: "wiggly", wigglesPerSecond: 4,
                               correlation: 20, maxAmount: 60,
                               mode: "intersect" } };
        },
        check: function (d, ctx) {
          ctx.txWiggly = d.selector && d.selector.path;
          if (d.problems) return "problems: " + d.problems.join("; ");
          return (d.selector && d.selector.type === "wiggly" &&
                  d.selector.settings.wigglesPerSecond === 4) ||
                 "selector: " + JSON.stringify(d.selector);
        } },

      { name: "the wiggly parameters really landed in AE",
        tool: "list_properties",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer, path: ctx.txWiggly };
        },
        check: function (d) {
          var freq = null, corr = null, i;
          for (i = 0; i < d.properties.length; i++) {
            if (d.properties[i].matchName === "ADBE Text Temporal Freq") {
              freq = d.properties[i].value;
            }
            if (d.properties[i].matchName ===
                "ADBE Text Character Correlation") {
              corr = d.properties[i].value;
            }
          }
          return (freq === 4 && corr === 20) ||
                 "wiggles/second " + freq + ", correlation " + corr;
        } },

      // AE's own range refusal, reported rather than swallowed.
      { name: "a value AE rejects comes back with the range",
        tool: "add_text_animator",
        args: function (ctx) {
          return { comp: ctx.txComp, layer: ctx.txLayer,
                   properties: { opacity: 900 }, selector: { type: "none" } };
        },
        check: function (d) {
          if (!d.problems || d.problems.length !== 1) {
            return "problems: " + JSON.stringify(d.problems);
          }
          if (d.properties.length !== 0) {
            return "claimed it applied: " + JSON.stringify(d.properties);
          }
          return /0 to 100/.test(d.problems[0]) ||
                 "no range in: " + d.problems[0];
        } },

      { name: "cleanup: delete the text-animator rig comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.txComp }; },
        check: function () { return true; } },

      // ---- shape repeaters and the path AE's UI implies (WORKPLAN 5.2).
      //
      // Measured in AE 2026 (probe in WORKPLAN-LOG 2026-08-28): shape
      // content is a stack whose filters act on what is ABOVE them, and
      // addProperty always appends BELOW — so a repeater added after the
      // rectangle repeats it (bounds 100 -> 500 px) and the same repeater
      // moved to index 1 renders one copy. And a shape GROUP hides its
      // items in a nested "Contents" group the timeline never draws, so
      // the path this panel's own docs handed the model,
      // contents/<Group>/<Item>/<Param>, resolved to nothing at all.
      //
      // These run in the main scratch comp: shape content creates no
      // project items, and the layer dies with the comp.
      { name: "a shape layer to repeat",
        tool: "add_shape_layer",
        args: function (ctx) {
          return { comp: ctx.comp, name: "ST Rep", shape: "rectangle",
                   size: [10, 10] };
        },
        check: function (d, ctx) { ctx.repLayer = d.name || "ST Rep";
                                   return true; } },

      { name: "an empty group, then a repeater with nothing above it",
        batch: function (ctx) {
          return [
            { tool: "add_shape_content", args: { comp: ctx.comp,
                layer: ctx.repLayer, kind: "group", name: "ST Ring" } },
            { tool: "add_shape_content", args: { comp: ctx.comp,
                layer: ctx.repLayer, kind: "repeater", group: "ST Ring",
                params: { Copies: 3 } } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "group: " + rows[0].error;
          if (!rows[1].ok) return "repeater: " + rows[1].error;
          var w = rows[1].data.warning || "";
          if (!w) return "a repeater over an empty group did not warn";
          return (/ABOVE it/.test(w) && /will NOT fix this/.test(w)) ||
                 "the warning does not give the rule: " + w;
        } },

      // A repeater added UNDER a shape is the working order, and gets no
      // warning — a warning on the good case would train the model to
      // ignore them.
      { name: "a second group, shape first: no warning",
        batch: function (ctx) {
          return [
            { tool: "add_shape_content", args: { comp: ctx.comp,
                layer: ctx.repLayer, kind: "group", name: "ST Row" } },
            { tool: "add_shape_content", args: { comp: ctx.comp,
                layer: ctx.repLayer, kind: "rectangle", group: "ST Row",
                params: { Size: [100, 100], Position: [0, 0] } } },
            { tool: "add_shape_content", args: { comp: ctx.comp,
                layer: ctx.repLayer, kind: "fill", group: "ST Row",
                params: { Color: [1, 0, 0, 1] } } },
            { tool: "add_shape_content", args: { comp: ctx.comp,
                layer: ctx.repLayer, kind: "repeater", group: "ST Row",
                params: { Copies: 3, Position: [200, 0] } } }
          ];
        },
        check: function (rows, ctx) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          if (rows[3].data.warning) {
            return "warned about a correctly ordered repeater: " +
                   rows[3].data.warning;
          }
          ctx.repNote = rows[3].data.note || "";
          return true;
        } },

      // The proof that it RENDERS, not merely that AE took the values:
      // center_anchor_point measures sourceRectAtTime, so a 100px square
      // repeated three times at +200 has to hand back a center at x=200
      // (bounds -50..450). One copy would answer 0.
      { name: "the repeater actually repeats (measured bounds, not values)",
        tool: "center_anchor_point",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer };
        },
        check: function (d) {
          var ap = d.newAnchor || [];
          if (!ap.length) return "no anchor in result: " + JSON.stringify(d);
          return Math.abs(ap[0] - 200) < 1 ||
                 "content centre x=" + ap[0] + ", expected 200 — the " +
                 "repeater rendered one copy";
        } },

      // The bug this item really found: every path the panel documented
      // left out the "Contents" hop, so this call used to fail.
      { name: "the path AE's UI implies reaches the repeater",
        tool: "set_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer,
                   property: "contents/ST Row/Repeater 1/Copies",
                   value: 4 };
        },
        check: function (d) {
          return d.value === 4 || "value " + JSON.stringify(d.value);
        } },

      { name: "…and one level deeper, into the repeater's offsets",
        tool: "set_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer,
                   property: "contents/ST Row/Repeater 1/Transform/Rotation",
                   value: 15 };
        },
        check: function (d) {
          return d.value === 15 || "value " + JSON.stringify(d.value);
        } },

      { name: "the long form AE's scripting API wants still works",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer,
                   property: "contents/ST Row/Contents/Repeater 1/Copies" };
        },
        check: function (d) {
          return d.value === 4 || "value " + JSON.stringify(d.value);
        } },

      // A direct child named "Transform" is the GROUP's own transform,
      // never the repeater's one hop away.
      { name: "a real child shadows the same name inside Contents",
        tool: "set_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer,
                   property: "contents/ST Row/Transform/Rotation",
                   value: 30 };
        },
        check: function (d, ctx) {
          if (d.value !== 30) return "value " + JSON.stringify(d.value);
          return (d.resolvedPath || "").indexOf("Repeater") === -1 ||
                 "landed in the repeater: " + d.resolvedPath;
        } },

      { name: "the group's rotation left the repeater's alone",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer,
                   property: "contents/ST Row/Repeater 1/Transform/Rotation" };
        },
        check: function (d) {
          return d.value === 15 || "repeater rotation is now " + d.value;
        } },

      // The tool's own note has to be a path that works: handing the
      // model a broken one is exactly how this shipped unnoticed.
      { name: "the path in add_shape_content's note resolves",
        tool: "get_property",
        args: function (ctx) {
          var m = /'([^']*)<param>'/.exec(ctx.repNote || "");
          ctx.repNoted = m ? m[1] : "";
          return { comp: ctx.comp, layer: ctx.repLayer,
                   property: (m ? m[1] : "contents/ST Row/Repeater 1/") +
                             "Copies" };
        },
        check: function (d, ctx) {
          if (!ctx.repNoted) return "the note quoted no path";
          return d.value === 4 || "value " + JSON.stringify(d.value);
        } },

      // set_keyframes is the documented way to animate one, and it takes
      // the same short path.
      { name: "set_keyframes animates a repeater by that path",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer,
                   property: "contents/ST Row/Repeater 1/Transform/Position",
                   keys: [{ time: 0, value: [0, 0] },
                          { time: 1, value: [200, 0] }] };
        },
        check: function (d) {
          return d.numKeys === 2 || "numKeys " + d.numKeys;
        } },

      // AE's ranges, surfaced rather than swallowed: Copies floors at 0,
      // Composite is 1..2 ("ADBE Vector Repeater Order").
      { name: "a negative Copies is refused with AE's own range",
        tool: "add_shape_content",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer, kind: "repeater",
                   group: "ST Row", params: { Copies: -1 } };
        },
        check: function (err) {
          return (/Copies/.test(err) && /less-than-0/.test(err)) ||
                 "does not name the parameter and the floor: " + err;
        } },

      { name: "a missing segment lists what the TIMELINE shows",
        tool: "get_property",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer,
                   property: "contents/ST Row/Nope/Copies" };
        },
        check: function (err) {
          return (/inside Contents:/.test(err) && /Repeater 1/.test(err)) ||
                 "lists only the four scripting rows: " + err;
        } },

      { name: "cleanup: delete the repeater layer",
        tool: "delete_layer",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.repLayer };
        },
        check: function () { return true; } },

      // ---- animation presets: list_presets / apply_preset (WORKPLAN 5.3).
      //
      // Measured in AE 2026 (three probes, WORKPLAN-LOG 2026-08-28):
      // layer.applyPreset() applies to the comp's SELECTION, not to the
      // layer it is called on — two layers selected, one call, BOTH
      // changed — and with an EMPTY selection it invents a comp-sized
      // solid, applies the preset there and leaves the target alone. Both
      // halves are checked below against real AE, which is why the rig
      // goes to the trouble of establishing a two-layer selection:
      // split_layer_into_chunks is the one tool that leaves one behind.
      //
      // Nothing here hard-codes a preset name. AE's library differs by
      // install and by locale, so every name comes from list_presets.
      { name: "list_presets finds AE's shipped library",
        tool: "list_presets",
        args: { category: "Behaviors", limit: 0 },
        check: function (d, ctx) {
          if (!d.total) return "no Behaviors presets found";
          if (d.installed < d.total) return "installed < matched";
          var pick = null, i;
          for (i = 0; i < d.presets.length; i++) {
            if (/wiggle/i.test(d.presets[i].name)) { pick = d.presets[i]; break; }
          }
          if (!pick) pick = d.presets[0];
          ctx.presetName = pick.category + "/" + pick.name;
          if (pick.source !== "app") return "source " + pick.source;
          return true;
        } },

      { name: "a filter that matches nothing is grounded in what exists",
        tool: "list_presets",
        expectError: true,
        args: { filter: "zzz no such preset zzz" },
        check: function (err) {
          return (/presets are installed/.test(err) &&
                  /Behaviors/.test(err)) ||
                 "does not say what IS installed: " + err;
        } },

      { name: "a text preset name, taken from the library not from memory",
        tool: "list_presets",
        args: { category: "Text/Animate In", limit: 5 },
        check: function (d, ctx) {
          if (!d.total) return "no Text/Animate In presets";
          ctx.textPreset = d.presets[0].category + "/" + d.presets[0].name;
          return true;
        } },

      { name: "a solid, split into two pieces that stay SELECTED",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.comp, name: "ST Pre",
                color: [0, 0.4, 1], width: 80, height: 80 } },
            { tool: "split_layer_into_chunks",
              args: { comp: ctx.comp, layer: "ST Pre", chunks: 2 } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok) return "add_solid: " + rows[0].error;
          if (!rows[1].ok) return "split: " + rows[1].error;
          var p = rows[1].data.pieces || [];
          if (p.length !== 2) return "got " + p.length + " pieces";
          ctx.preA = p[0].layer;
          ctx.preB = p[1].layer;
          return true;
        } },

      { name: "both pieces really are selected (the rig AE needs)",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.comp, limit: 0 }; },
        check: function (d, ctx) {
          ctx.preLayerCount = d.numLayers;
          var i, sel = 0;
          for (i = 0; i < d.layers.length; i++) {
            if (d.layers[i].selected) sel++;
          }
          return sel === 2 || "expected 2 selected layers, found " + sel;
        } },

      { name: "apply_preset touches ONLY the layer it was given",
        tool: "apply_preset",
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.preA,
                   preset: ctx.presetName };
        },
        check: function (d, ctx) {
          if (d.applied.length !== 1) {
            return "applied to " + d.applied.length + " layers";
          }
          if (d.applied[0].layer !== ctx.preA) {
            return "landed on " + d.applied[0].layer;
          }
          if (!d.applied[0].effectsAdded &&
              !d.applied[0].keysAndExpressionsAdded) {
            return "reported success with nothing added";
          }
          if (d.layersAdded) return "invented " + d.layersAdded + " layer(s)";
          return true;
        } },

      // The measured failure this whole design exists for: the OTHER
      // selected layer must be untouched.
      { name: "the other SELECTED layer got nothing",
        tool: "list_properties",
        args: function (ctx) {
          // depth 1: the effect ROWS, not their parameters — the default
          // depth of 2 counts every slider inside them (6 effects = 18
          // rows) and would compare two different things.
          return { comp: ctx.comp, layer: ctx.preB, path: "effects",
                   depth: 1 };
        },
        check: function (d) {
          return d.count === 0 ||
                 "the bystander picked up " + d.count + " effect row(s)";
        } },

      { name: "…and no layer was invented, and the selection came back",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.comp, limit: 0 }; },
        check: function (d, ctx) {
          if (d.numLayers !== ctx.preLayerCount) {
            return "layer count " + ctx.preLayerCount + " -> " + d.numLayers;
          }
          var i, sel = 0;
          for (i = 0; i < d.layers.length; i++) {
            if (d.layers[i].selected) sel++;
          }
          return sel === 2 || "selection is now " + sel + " layer(s)";
        } },

      // A Text preset on a NON-text layer has two real outcomes, both
      // measured: one that carries expression controls installs those and
      // none of the animation ("Alternating Characters In" on a solid:
      // six sliders, census 2, against census 15 on a text layer), and one
      // that does not ("Center Spiral In") changes nothing whatsoever.
      // Which one AE ships first differs by install, so the step checks
      // the INVARIANT instead of the outcome: whatever the tool says
      // happened is what the layer really has.
      { name: "a Text preset on a solid tells the truth either way",
        batch: function (ctx) {
          return [
            { tool: "apply_preset", args: { comp: ctx.comp, layer: ctx.preB,
                preset: ctx.textPreset } },
            { tool: "list_properties", args: { comp: ctx.comp,
                layer: ctx.preB, path: "effects", depth: 1 } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[1].ok) return "list_properties: " + rows[1].error;
          var count = rows[1].data.count;
          if (!rows[0].ok) {
            var err = rows[0].error;
            if (count !== 0) {
              return "refused, but the layer gained " + count + " effect(s)";
            }
            return (err.indexOf(ctx.preB) !== -1 && /silent/i.test(err) &&
                    /TEXT layer/.test(err)) ||
                   "the refusal does not name the layer and the rule: " + err;
          }
          var d = rows[0].data, a = d.applied[0];
          if (!a || a.layer !== ctx.preB) return "landed elsewhere";
          if (!count && !a.keysAndExpressionsAdded) {
            return "claimed success with nothing on the layer";
          }
          if (a.effectsAdded && a.effectsAdded.length !== count) {
            return "reported " + a.effectsAdded.length + " effects, the " +
                   "layer has " + count;
          }
          return (d.partialOnNonText && /text animators/i.test(d.partialNote ||
                  "")) ||
                 "a Text preset landed on a solid with no partial-landing " +
                 "note";
        } },

      // Cameras and lights have no Effect Parade at all and took NOTHING
      // from either kind of preset — the one guaranteed no-op, and so the
      // one place the refusal path can be exercised on any install.
      { name: "a camera takes no preset, and is told so",
        batch: function (ctx) {
          return [
            { tool: "add_camera", args: { comp: ctx.comp,
                name: "ST PreCam" } },
            { tool: "apply_preset", args: { comp: ctx.comp,
                layer: "ST PreCam", preset: ctx.presetName } },
            { tool: "delete_layer", args: { comp: ctx.comp,
                layer: "ST PreCam" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "add_camera: " + rows[0].error;
          if (rows[1].ok) return "a camera accepted a preset";
          var err = rows[1].error;
          if (!/ST PreCam/.test(err) || !/camera/.test(err)) {
            return "the refusal does not name the layer and its type: " + err;
          }
          if (!/silent/i.test(err)) return "does not explain AE's silence: " +
            err;
          return rows[2].ok || "cleanup: " + rows[2].error;
        } },

      { name: "the same preset on a TEXT layer applies",
        batch: function (ctx) {
          return [
            { tool: "add_text_layer", args: { comp: ctx.comp,
                text: "ST PreText" } },
            { tool: "apply_preset", args: { comp: ctx.comp,
                layer: "ST PreText", preset: ctx.textPreset } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "add_text_layer: " + rows[0].error;
          if (!rows[1].ok) return "apply_preset: " + rows[1].error;
          var a = rows[1].data.applied[0];
          if (a.type !== "text") return "type " + a.type;
          return (a.keysAndExpressionsAdded > 0 || !!a.effectsAdded) ||
                 "applied nothing to a layer it fits";
        } },

      { name: "an invented preset name is refused with a way back",
        tool: "apply_preset",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.comp, layer: ctx.preA,
                   preset: "Sparkle Burst Deluxe" };
        },
        check: function (err) {
          return (/list_presets/.test(err) &&
                  !/After Effects error/.test(err)) ||
                 "leaks AE's own wording or offers no way back: " + err;
        } },

      { name: "cleanup: delete the preset rig",
        batch: function (ctx) {
          return [
            { tool: "delete_layer", args: { comp: ctx.comp, layer: ctx.preA } },
            { tool: "delete_layer", args: { comp: ctx.comp, layer: ctx.preB } },
            { tool: "delete_layer",
              args: { comp: ctx.comp, layer: "ST PreText" } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + i + ": " + rows[i].error;
          }
          return true;
        } },

      // ---- render queue: list_render_templates / render_comp /
      // add_to_render_queue (WORKPLAN 5.5).
      //
      // Measured in AE 2026 across seven probes (WORKPLAN-LOG
      // 2026-08-28). Three of those facts are what these steps exist to
      // hold down, because each one is invisible until it bites:
      //
      //  - renderQueue.render() renders the WHOLE QUEUE, so a foreign
      //    item is queued below and must come back untouched.
      //  - rendering onto a file that ALREADY EXISTS raises a MODAL that
      //    wedges After Effects outright -- it ate a probe run of this
      //    very pass and then swallowed every later -r script while the
      //    process still looked healthy. The refusal step below is the
      //    one that keeps the harness alive.
      //  - the output module forces its OWN extension onto whatever path
      //    it is handed, so the path asked for is not the path written.
      //
      // Everything renders one frame of a 160x120 comp into Folder.temp
      // (~180 ms measured), so the suite pays almost nothing for it. No
      // template name is hard-coded: installed templates differ per
      // machine, so they come from list_render_templates.
      { name: "create the render rig, small enough to render for free",
        batch: function () {
          return [
            { tool: "create_comp",
              args: { name: RQCOMP, width: 160, height: 120,
                      duration: 1, frameRate: 24 } },
            { tool: "add_solid",
              args: { comp: RQCOMP, name: "ST RQ Fill",
                      color: [0, 0.6, 0.9], width: 160, height: 120 } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok) return "create_comp: " + rows[0].error;
          if (!rows[1].ok) return "add_solid: " + rows[1].error;
          ctx.rqComp = rows[0].data.name;
          return true;
        } },

      { name: "list_render_templates names this machine's templates",
        tool: "list_render_templates",
        args: {},
        check: function (d, ctx) {
          if (!d.outputModules || !d.outputModules.length) {
            return "no output-module templates";
          }
          if (!d.renderSettings || !d.renderSettings.length) {
            return "no render-settings templates";
          }
          if (!d.tempFolder) return "no tempFolder to render into";
          ctx.rqTemp = d.tempFolder.replace(/\\/g, "/").replace(/\/$/, "");
          // Prefer a still-image module: it is the cheapest thing AE can
          // write, and every install has at least one video one to fall
          // back on. Never an internal _HIDDEN entry.
          var i, n, pick = "";
          for (i = 0; i < d.outputModules.length; i++) {
            n = d.outputModules[i];
            if (/^_HIDDEN/.test(n)) continue;
            if (/^Lossless$/i.test(n)) { pick = n; break; }
            if (!pick) pick = n;
          }
          if (!pick) return "every template was _HIDDEN";
          ctx.rqTemplate = pick;
          ctx.rqOut = ctx.rqTemp + "/AELL_ST_render";
          for (i = 0; i < d.renderSettings.length; i++) {
            if (/^Draft Settings$/i.test(d.renderSettings[i])) {
              ctx.rqSettings = d.renderSettings[i];
            }
          }
          return true;
        } },

      { name: "an invented template is refused with the real list",
        tool: "render_comp",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.rqComp, output: ctx.rqTemp + "/AELL_ST_never.avi",
                   template: "ProRes Ultra Deluxe" };
        },
        check: function (err, ctx) {
          if (/After Effects error/.test(err)) {
            return "leaks AE's own throw, which names no alternatives: " +
                   err;
          }
          return err.indexOf(ctx.rqTemplate) >= 0 ||
                 "does not list what IS installed: " + err;
        } },

      { name: "a relative output path is refused before anything is queued",
        tool: "render_comp",
        expectError: true,
        args: function (ctx) { return { comp: ctx.rqComp,
                                        output: "renders/rel.avi" }; },
        check: function (err) {
          return /ABSOLUTE/i.test(err) ||
                 "does not say the path must be absolute: " + err;
        } },

      { name: "an output folder that does not exist names the nearest one",
        tool: "render_comp",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.rqComp,
                   output: ctx.rqTemp + "/AELL_ST_no_such_dir/x.avi",
                   template: ctx.rqTemplate };
        },
        check: function (err, ctx) {
          if (!/does not exist/i.test(err)) return "not a folder error: " + err;
          // The actionable half: which folder DOES exist to create it in.
          var tail = ctx.rqTemp.replace(/^.*\//, "");
          return err.indexOf(tail) >= 0 ||
                 "does not name the deepest existing folder: " + err;
        } },

      { name: "render_comp writes one real frame to disk",
        tool: "render_comp",
        args: function (ctx) {
          return { comp: ctx.rqComp, output: ctx.rqOut,
                   template: ctx.rqTemplate, frames: 1, overwrite: true };
        },
        check: function (d, ctx) {
          if (d.status !== "DONE") return "status " + d.status +
            (d.warning ? " — " + d.warning : "");
          if (!(d.bytes > 0)) {
            return "reported DONE but " + d.bytes + " bytes — AE hides a " +
                   "just-written file for a moment, so this is what a " +
                   "single unpolled look would report";
          }
          if (!d.output) return "no output path reported";
          // The extension is AE's choice, not ours: record what it
          // actually settled on so the next steps aim at the same file.
          ctx.rqWrote = d.output.replace(/\\/g, "/");
          ctx.rqBytes = d.bytes;
          if (d.resolution !== "Full") {
            return "an unasked render is not Full resolution: " +
                   d.resolution;
          }
          if (d.renderedSize !== "160x120") {
            return "did not report the comp's own frame size: " +
                   d.renderedSize;
          }
          return /1 frame/.test(d.timeSpan) ||
                 "did not report one frame: " + d.timeSpan;
        } },

      // THE step. Without the refusal, this call reaches real AE, AE puts
      // up an overwrite dialog, and the harness dies at exit 4 with every
      // later pass swallowed behind it.
      { name: "rendering onto an existing file is REFUSED, not attempted",
        tool: "render_comp",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.rqComp, output: ctx.rqWrote,
                   template: ctx.rqTemplate, frames: 1 };
        },
        check: function (err) {
          if (!/already exists/i.test(err)) {
            return "not an existence refusal: " + err;
          }
          if (!/overwrite/i.test(err)) return "no way forward offered: " + err;
          return /modal|dialog/i.test(err) ||
                 "does not say why it matters (a modal wedges AE): " + err;
        } },

      { name: "overwrite:true really replaces the file, and does not skip",
        tool: "render_comp",
        args: function (ctx) {
          return { comp: ctx.rqComp, output: ctx.rqWrote,
                   template: ctx.rqTemplate, frames: 6, overwrite: true };
        },
        check: function (d, ctx) {
          if (d.status !== "DONE") return "status " + d.status;
          if (!(d.bytes > 0)) return "no bytes: " + d.bytes;
          // Six frames instead of one: if AE had quietly declined to
          // overwrite, the size would be unchanged. This is the only way
          // to tell a real overwrite from a silent no-op.
          return d.bytes > ctx.rqBytes ||
                 "the file did not grow (" + ctx.rqBytes + " -> " +
                 d.bytes + "), so the render was silently skipped";
        } },

      // ---- {resolution}: AE renders FEWER PIXELS, rather than the same
      // pixels scaled afterwards. The export path's master exists only to
      // be scaled down, so this is where the bytes are saved. Every step
      // here pins a measurement from the 2026-08-30 probe.
      { name: "resolution:half renders a HALF-SIZE frame, and says so",
        tool: "render_comp",
        args: function (ctx) {
          return { comp: ctx.rqComp, output: ctx.rqWrote,
                   template: ctx.rqTemplate, frames: 1, overwrite: true,
                   resolution: "half" };
        },
        check: function (d, ctx) {
          if (d.status !== "DONE") return "status " + d.status;
          if (d.resolution !== "Half") {
            return "AE reports " + d.resolution + ", not Half";
          }
          var rs = String(d.renderedSize || "");
          if (rs.indexOf("80x60") !== 0) {
            return "half of 160x120 should be 80x60: " + rs;
          }
          if (rs.indexOf("160x120") < 0) {
            return "the comp's own size is not named beside it: " + rs;
          }
          // The file itself, not just the report: a quarter of the
          // pixels cannot cost the same bytes as all of them.
          return d.bytes < ctx.rqBytes ||
                 "the same frame at half resolution was not smaller (" +
                 ctx.rqBytes + " -> " + d.bytes + "), so AE rendered " +
                 "full size and the setting did nothing";
        } },

      // THE ordering step. applyTemplate RESETS Resolution to Full
      // (measured), so a tool that sets it beside the other arguments
      // renders full size and reports success. Only a render-settings
      // template TOGETHER with a resolution can catch that.
      { name: "a render-settings template does not eat the resolution",
        tool: "render_comp",
        args: function (ctx) {
          var a = { comp: ctx.rqComp, output: ctx.rqWrote,
                    template: ctx.rqTemplate, frames: 1, overwrite: true,
                    resolution: "quarter" };
          if (ctx.rqSettings) a.renderSettings = ctx.rqSettings;
          return a;
        },
        check: function (d) {
          if (d.status !== "DONE") return "status " + d.status;
          if (d.resolutionWarning) return d.resolutionWarning;
          if (d.resolution !== "Quarter") {
            return "the template reset the resolution to " + d.resolution +
                   " and the render went out full size";
          }
          return String(d.renderedSize || "").indexOf("40x30") === 0 ||
                 "quarter of 160x120 should be 40x30: " + d.renderedSize;
        } },

      { name: "an arbitrary percentage is refused with AE's four names",
        tool: "render_comp",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.rqComp, output: ctx.rqWrote,
                   template: ctx.rqTemplate, frames: 1, overwrite: true,
                   resolution: "35%" };
        },
        check: function (err) {
          if (!/resolution/i.test(err)) return "not a resolution error: " + err;
          return (/Full/.test(err) && /Quarter/.test(err)) ||
                 "does not list what AE really offers: " + err;
        } },

      { name: "the queue is left exactly as it was found",
        tool: "add_to_render_queue",
        args: function (ctx) { return { comp: ctx.rqComp }; },
        check: function (d, ctx) {
          // render_comp removes its own item, so this add must be the
          // FIRST entry for this comp — a warning here would mean it left
          // litter behind.
          if (d.warning) return "render_comp left its own items queued: " +
            d.warning;
          if (!d.output) return "no destination reported";
          if (!/last render/i.test(d.note || "")) {
            return "an outputPath-less add did not say where AE would " +
                   "write: " + (d.note || "(silent)");
          }
          ctx.rqQueued = true;
          return true;
        } },

      { name: "a second add of the same comp is called out",
        tool: "add_to_render_queue",
        args: function (ctx) { return { comp: ctx.rqComp }; },
        check: function (d) {
          return /already in the render queue/i.test(d.warning || "") ||
                 "AE allows the duplicate silently and so did we: " +
                 (d.warning || "(silent)");
        } },

      // Two of OUR items are now sitting in the queue. A render that took
      // the whole queue would consume them; render_comp must hold them
      // back and hand them straight back.
      { name: "queued items are held back, not swept into the render",
        tool: "render_comp",
        args: function (ctx) {
          return { comp: ctx.rqComp, output: ctx.rqWrote,
                   template: ctx.rqTemplate, frames: 1, overwrite: true };
        },
        check: function (d) {
          if (d.status !== "DONE") return "status " + d.status;
          if (!/held back/i.test(d.heldBack || "")) {
            return "did not report holding the queued items back: " +
                   (d.heldBack || "(silent)");
          }
          return /2 /.test(d.heldBack) ||
                 "expected both queued items held: " + d.heldBack;
        } },

      { name: "and they are still queued afterwards, flags intact",
        tool: "add_to_render_queue",
        args: function (ctx) { return { comp: ctx.rqComp }; },
        check: function (d) {
          // Still two -> neither was rendered away nor removed. AE does
          // not reset render=false by itself, so this also proves the
          // flags were restored.
          return /queue 2 time/i.test(d.warning || "") ||
                 "the held-back items did not survive intact: " +
                 (d.warning || "(silent)");
        } },

      // AE CANNOT RENDER INSIDE AN UNDO GROUP. Registering render_comp as
      // mutating did exactly that, and AE answered with a modal "After
      // Effects warning: Undo group mismatch" that wedged the harness --
      // its renderer closes the script's group out from under it, so the
      // count goes wrong and the warning lands at some innocent
      // endUndoGroup much later in the run. A batch opens ONE group if
      // any command in it mutates, so this step is the one that proves
      // the render still steps outside it.
      { name: "a render batched with a mutation stays out of the undo group",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.rqComp, name: "ST RQ Grp",
                color: [1, 0.5, 0], width: 40, height: 40 } },
            { tool: "render_comp",
              args: { comp: ctx.rqComp, output: ctx.rqWrote,
                      template: ctx.rqTemplate, frames: 1,
                      overwrite: true } },
            { tool: "delete_layer", args: { comp: ctx.rqComp,
                layer: "ST RQ Grp" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "add_solid: " + rows[0].error;
          if (!rows[1].ok) return "render_comp: " + rows[1].error;
          if (rows[1].data.status !== "DONE") {
            return "status " + rows[1].data.status;
          }
          return rows[2].ok || "cleanup: " + rows[2].error;
        } },

      { name: "cleanup: drop the render rig and its queue items",
        batch: function (ctx) {
          return [
            { tool: "delete_item", args: { item: ctx.rqComp } }
          ];
        },
        check: function (rows) {
          // Measured: removing a comp that sits in the render queue drops
          // its queue items too, silently and with no dialog.
          return rows[0].ok || "cleanup: " + rows[0].error;
        } },

      // ---- audio_to_keyframes. AE's "Convert Audio to Keyframes" is one
      // menu command (id 4218) wrapped in everything it does NOT do, and
      // every step below pins one of those, all measured in AE 2026:
      //
      //  - with no audio-capable layer it creates nothing and says
      //    nothing at all — no exception, no dialog. Silence is the only
      //    signal, so the tool has to refuse BEFORE calling it.
      //  - it reads the whole comp MIX and ignores the selection, so
      //    "just this layer" means muting the others for the conversion
      //    and putting them back. The mix/isolate/mix triple below is
      //    what proves the un-muting really happens.
      //  - it never uniques the null's name: two runs, two layers both
      //    called "Audio Amplitude", and every later name lookup
      //    ambiguous.
      //
      // The rig needs no audio FILE: applying Tone to a solid flips
      // layer.hasAudio to true and the converter measures it (73 keys,
      // peak ~34 on a 3s/24fps comp).
      { name: "create the audio rig (a solid, still silent)",
        batch: function () {
          return [
            { tool: "create_comp",
              args: { name: AUCOMP, width: 160, height: 120,
                      duration: 3, frameRate: 24 } },
            { tool: "add_solid",
              args: { comp: AUCOMP, name: "ST Aud Host",
                      color: [0.1, 0.4, 0.8], width: 160, height: 120 } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok) return "create_comp: " + rows[0].error;
          if (!rows[1].ok) return "add_solid: " + rows[1].error;
          ctx.auComp = rows[0].data.name;
          return true;
        } },

      { name: "a comp with no audio is refused, not silently converted",
        tool: "audio_to_keyframes",
        expectError: true,
        args: function (ctx) { return { comp: ctx.auComp }; },
        check: function (err) {
          if (err.indexOf("ST Aud Host") === -1) {
            return "refusal does not list what IS in the comp: " + err;
          }
          return err.indexOf("import_file") !== -1 ||
                 "no route out of the refusal: " + err;
        } },

      { name: "an unknown 'range' is refused as a typo, not as no-audio",
        tool: "audio_to_keyframes",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.auComp, range: "everything" };
        },
        check: function (err) {
          if (err.indexOf("no audio") !== -1) {
            return "the argument typo was reported as a comp problem: " + err;
          }
          return (err.indexOf("workArea") !== -1 &&
                  err.indexOf("'comp'") !== -1) ||
                 "refusal names neither real choice: " + err;
        } },

      { name: "Tone turns the solid into a real audio source",
        tool: "apply_effect",
        args: function (ctx) {
          return { comp: ctx.auComp, layer: "ST Aud Host", effect: "Tone" };
        },
        check: function (d) {
          if (d.matchName !== "ADBE Aud Tone") {
            return "wrong effect: " + d.matchName;
          }
          return (d.params.join(",").indexOf("Level") !== -1) ||
                 "Tone has no Level param: " + d.params;
        } },

      { name: "audio_to_keyframes writes one key per frame of the mix",
        tool: "audio_to_keyframes",
        args: function (ctx) { return { comp: ctx.auComp }; },
        check: function (d, ctx) {
          if (d.keyframes !== 73) {
            return "3s at 24fps should be 73 keys, got " + d.keyframes;
          }
          if (d.rangeStart !== 0 || Math.abs(d.rangeEnd - 3) > 0.001) {
            return "range " + d.rangeStart + ".." + d.rangeEnd;
          }
          if (!(d.peak > 0)) return "silent curve, peak " + d.peak;
          if (d.controlEffects.join(",") !==
              "Left Channel,Right Channel,Both Channels") {
            return "channel controls: " + d.controlEffects;
          }
          if (d.measured !== "whole comp mix") {
            return "measured: " + d.measured;
          }
          if ((d.next || "").indexOf("link_property") === -1) {
            return "no route on to link_property: " + d.next;
          }
          ctx.auMix = d.peak;
          ctx.auNull = d.layer;
          return d.layer === "Audio Amplitude" ||
                 "unexpected null name: " + d.layer;
        } },

      { name: "the slider really drives a property through link_property",
        tool: "link_property",
        args: function (ctx) {
          return { comp: ctx.auComp, layer: "ST Aud Host",
                   property: "opacity", controlLayer: ctx.auNull,
                   controlEffect: "Both Channels", scale: 2 };
        },
        check: function (d, ctx) {
          return (d.expression.indexOf(ctx.auNull) !== -1 &&
                  d.expression.indexOf("Both Channels") !== -1) ||
                 "expression does not reach the audio slider: " + d.expression;
        } },

      { name: "a second conversion is renamed, never left ambiguous",
        tool: "audio_to_keyframes",
        args: function (ctx) { return { comp: ctx.auComp }; },
        check: function (d) {
          if (d.layer !== "Audio Amplitude 2") {
            return "AE reuses the name; the tool should not: " + d.layer;
          }
          return (d.nameTaken || "").indexOf("Audio Amplitude") !== -1 ||
                 "the rename was silent";
        } },

      { name: "add a second audible layer to the rig",
        batch: function (ctx) {
          return [
            { tool: "add_solid",
              args: { comp: ctx.auComp, name: "ST Aud Extra",
                      color: [0.8, 0.3, 0], width: 160, height: 120 } },
            { tool: "apply_effect",
              args: { comp: ctx.auComp, layer: "ST Aud Extra",
                      effect: "Tone" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return "add_solid: " + rows[0].error;
          return rows[1].ok || "apply_effect: " + rows[1].error;
        } },

      { name: "two audible layers mix louder than one",
        tool: "audio_to_keyframes",
        args: function (ctx) { return { comp: ctx.auComp }; },
        check: function (d, ctx) {
          ctx.auMixTwo = d.peak;
          return d.peak > ctx.auMix ||
                 "two tones peak at " + d.peak + ", one at " + ctx.auMix +
                 " — the second layer is not being heard";
        } },

      { name: "isolating one layer mutes the others and says so",
        tool: "audio_to_keyframes",
        args: function (ctx) {
          return { comp: ctx.auComp, layer: "ST Aud Host",
                   name: "ST Aud Beat" };
        },
        check: function (d, ctx) {
          if (d.measured !== "ST Aud Host") {
            return "measured: " + d.measured;
          }
          if ((d.isolated || "").indexOf("ST Aud Extra") === -1) {
            return "the mute was not reported: " + d.isolated;
          }
          if (!(d.peak > 0)) return "isolated curve is silent";
          ctx.auSolo = d.peak;
          // Two tones are louder than one — if the isolation had not
          // happened this would equal the mix.
          return d.peak < ctx.auMixTwo ||
                 "isolated peak " + d.peak + " is not below the two-layer " +
                 "mix — the other layer was still audible";
        } },

      { name: "every mute is undone: the mix is as loud as before",
        tool: "audio_to_keyframes",
        args: function (ctx) { return { comp: ctx.auComp }; },
        check: function (d, ctx) {
          if (Math.abs(d.peak - ctx.auMixTwo) > 0.01) {
            return "mix peak " + d.peak + " != " + ctx.auMixTwo +
                   " — a layer was left muted";
          }
          return d.peak > ctx.auSolo ||
                 "the two-layer mix is not louder than one layer alone";
        } },

      // ---- the WORK AREA. range:'workArea' shipped with 5.7 and had no
      // real-AE step at all, because nothing in the tool set could SET a
      // work area; set_comp_setting can now. The audio converter is its
      // own witness here: AE converts INSIDE the work area only, so a key
      // count that drops to the narrowed range and comes back is proof
      // the setting really landed in AE and was really put back.
      { name: "set_comp_setting puts a work area on the audio comp",
        tool: "set_comp_setting",
        args: function (ctx) {
          return { comp: ctx.auComp, workAreaStart: 1, workAreaEnd: 2 };
        },
        check: function (d) {
          if (d.workArea !== "1s-2s") return "work area reads " + d.workArea;
          return Math.abs(d.workAreaDuration - 1) < 0.001 ||
                 "duration " + d.workAreaDuration;
        } },

      { name: "and get_comp_details can READ the work area back",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.auComp, limit: 0 }; },
        check: function (d) {
          if (d.workArea !== "1s-2s") {
            return "the comp reports " + d.workArea;
          }
          return d.resolution === "full [1, 1]" ||
                 "resolution reads " + d.resolution;
        } },

      { name: "range:'workArea' converts inside it and nowhere else",
        tool: "audio_to_keyframes",
        args: function (ctx) {
          return { comp: ctx.auComp, range: "workArea" };
        },
        check: function (d) {
          if (d.keyframes !== 25) {
            return "1s of a 24 fps comp is 25 keys, got " + d.keyframes;
          }
          if (Math.abs(d.rangeStart - 1) > 0.001 ||
              Math.abs(d.rangeEnd - 2) > 0.001) {
            return "the keys cover " + d.rangeStart + "-" + d.rangeEnd +
                   ", not the work area";
          }
          return (d.workArea || "").indexOf("WORK AREA") !== -1 ||
                 "the narrowed range was not reported: " + d.workArea;
        } },

      { name: "the default widens to the whole comp and says it did",
        tool: "audio_to_keyframes",
        args: function (ctx) { return { comp: ctx.auComp }; },
        check: function (d) {
          if (d.keyframes !== 73) {
            return "the whole 3s comp is 73 keys, got " + d.keyframes;
          }
          return (d.workArea || "").indexOf("widened") !== -1 ||
                 "the widening was silent: " + d.workArea;
        } },

      { name: "...and put the user's work area back afterwards",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.auComp, limit: 0 }; },
        check: function (d) {
          return d.workArea === "1s-2s" ||
                 "the widened work area was left behind: " + d.workArea;
        } },

      { name: "workArea:'comp' resets it to the whole comp",
        tool: "set_comp_setting",
        args: function (ctx) { return { comp: ctx.auComp, workArea: "comp" }; },
        check: function (d) {
          return d.workArea === "0s-3s" || "work area reads " + d.workArea;
        } },

      { name: "and then range:'workArea' is the whole comp too",
        tool: "audio_to_keyframes",
        args: function (ctx) {
          return { comp: ctx.auComp, range: "workArea" };
        },
        check: function (d) {
          if (d.keyframes !== 73) {
            return "the reset work area should convert 73 keys, got " +
                   d.keyframes;
          }
          return !d.workArea ||
                 "a full-width work area needs no note: " + d.workArea;
        } },

      { name: "a layer with no audio is refused with the ones that have it",
        tool: "audio_to_keyframes",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.auComp, layer: "ST Aud Beat" };
        },
        check: function (err) {
          if (err.indexOf("ST Aud Host") === -1 ||
              err.indexOf("ST Aud Extra") === -1) {
            return "refusal does not list the audible layers: " + err;
          }
          return err.indexOf("whole comp mix") !== -1 ||
                 "no route out of the refusal: " + err;
        } },

      { name: "cleanup: delete the audio rig",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.auComp }; },
        check: function () { return true; } },

      // ---- the frame round-trip: snapshot_frame / import_as_layer
      // (WORKPLAN 5.8). A comp goes out to a PNG and comes back as a
      // layer, which is the bridge every generator stands on.
      //
      // Every step below pins one thing AE does silently (all measured
      // in AE 2026 across three probe rounds):
      //
      //  - saveFrameToPng overwrites an existing file with NO dialog and
      //    no undo, so the refusal is the only thing between a user's
      //    file and a quiet replacement.
      //  - an out-of-range time CLAMPS and writes a BLANK frame rather
      //    than complaining.
      //  - it writes PNG BYTES into whatever name it is handed: a frame
      //    saved as .jpg is a PNG called .jpg.
      //  - importing a path the project ALREADY holds makes a second
      //    item and says nothing.
      //  - AE's "Fit to Comp" menu commands do NOTHING with no viewer
      //    open, so the fit arithmetic here is the panel's own and is
      //    checked against the numbers those commands produced WITH one
      //    open: 250x200 stretch / 250 wide / 200 high for a 320x240
      //    source in an 800x480 comp.
      { name: "create the frame rig, and a wider comp to fit into",
        batch: function () {
          return [
            { tool: "create_comp",
              args: { name: FRCOMP, width: 240, height: 180,
                      duration: 2, frameRate: 24 } },
            { tool: "add_solid",
              args: { comp: FRCOMP, name: "ST FR Fill",
                      color: [0.9, 0.3, 0.1], width: 240, height: 180 } },
            { tool: "create_comp",
              args: { name: FRWIDE, width: 480, height: 180,
                      duration: 2, frameRate: 24 } }
          ];
        },
        check: function (rows, ctx) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + i + ": " + rows[i].error;
          }
          ctx.frComp = rows[0].data.name;
          ctx.frWide = rows[2].data.name;
          return true;
        } },

      { name: "a writable folder to snapshot into",
        tool: "list_render_templates",
        args: {},
        check: function (d, ctx) {
          if (!d.tempFolder) return "no tempFolder to write into";
          ctx.frTemp = d.tempFolder.replace(/\\/g, "/").replace(/\/$/, "");
          // Named "ST ..." on purpose: the imported footage item takes
          // the FILE's name, and the suite's own cleanup sweeps exactly
          // that prefix out of the project at the end.
          ctx.frPath = ctx.frTemp + "/ST Frame.png";
          return true;
        } },

      { name: "snapshot_frame writes a real PNG of the comp",
        tool: "snapshot_frame",
        args: function (ctx) {
          return { comp: ctx.frComp, time: 1, path: ctx.frPath,
                   overwrite: true };
        },
        check: function (d, ctx) {
          if (!(d.bytes > 0)) {
            return "reported " + d.bytes + " bytes — AE hides a file it " +
                   "has just written for ~300 ms, so this is what a " +
                   "single unpolled look reports";
          }
          // Read back out of the FILE's own header, not from the comp.
          if (d.width !== 240 || d.height !== 180) {
            return "the PNG is " + d.width + "x" + d.height +
                   ", not the comp's 240x180";
          }
          if (d.frame !== 24) return "frame " + d.frame + ", not 24";
          if (d.warning) return "unexpected warning: " + d.warning;
          ctx.frWrote = d.path.replace(/\\/g, "/");
          return (d.next || "").indexOf("import_as_layer") !== -1 ||
                 "no route on to import_as_layer: " + d.next;
        } },

      // THE refusal. Without it a second snapshot silently destroys the
      // first, with no dialog and nothing to undo.
      { name: "snapshotting onto an existing file is REFUSED",
        tool: "snapshot_frame",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.frComp, time: 1, path: ctx.frWrote };
        },
        check: function (err) {
          if (!/already exists/i.test(err)) return "not a refusal: " + err;
          return /silently|no undo/i.test(err) ||
                 "does not say what would have happened: " + err;
        } },

      { name: "a time past the end is refused, not clamped to a blank frame",
        tool: "snapshot_frame",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.frComp, time: 99,
                   path: ctx.frTemp + "/ST Never.png" };
        },
        check: function (err) {
          if (err.indexOf("outside") === -1) return "not a range error: " + err;
          return /CLAMPS|BLANK/.test(err) ||
                 "does not say what AE would have done: " + err;
        } },

      { name: "a relative path is refused, naming 'path' not 'output'",
        tool: "snapshot_frame",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.frComp, path: "frames/rel.png" };
        },
        check: function (err) {
          if (!/ABSOLUTE/i.test(err)) return "not a path error: " + err;
          return err.indexOf("'path'") !== -1 ||
                 "names the wrong argument: " + err;
        } },

      { name: "a non-.png extension is corrected, because AE would not",
        tool: "snapshot_frame",
        args: function (ctx) {
          return { comp: ctx.frComp, time: 0,
                   path: ctx.frTemp + "/ST Wrongext.jpg", overwrite: true };
        },
        check: function (d) {
          if (!/\.png$/i.test(d.path)) {
            return "wrote to " + d.path + " — AE puts PNG bytes in a .jpg " +
                   "and says nothing";
          }
          return (d.pathNote || "").indexOf("PNG bytes") !== -1 ||
                 "the correction was silent: " + d.pathNote;
        } },

      // ---- the resolution override, which had no real-AE step either,
      // for the same reason: nothing could set resolutionFactor. A comp
      // left at Half writes a half-size frame and AE says nothing, so
      // the default overrides it and REPORTS the override; only the
      // PNG's own IHDR header can tell the difference.
      { name: "set_comp_setting drops the frame comp to Half resolution",
        tool: "set_comp_setting",
        args: function (ctx) {
          return { comp: ctx.frComp, resolution: "half" };
        },
        check: function (d) {
          return d.resolution === "half [2, 2]" ||
                 "resolution reads " + d.resolution;
        } },

      { name: "a snapshot overrides the downsample and says it did",
        tool: "snapshot_frame",
        args: function (ctx) {
          return { comp: ctx.frComp, time: 1,
                   path: ctx.frTemp + "/ST Frame Full.png",
                   overwrite: true };
        },
        check: function (d) {
          if (d.width !== 240 || d.height !== 180) {
            return "the PNG is " + d.width + "x" + d.height +
                   " — the comp's Half resolution was not overridden";
          }
          if (d.warning) return "unexpected warning: " + d.warning;
          return (d.resolutionNote || "").indexOf("resolution 1/2") !== -1 ||
                 "the override was silent: " + d.resolutionNote;
        } },

      { name: "and the comp is still at Half afterwards, not switched",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.frComp, limit: 0 }; },
        check: function (d) {
          return d.resolution === "half [2, 2]" ||
                 "the snapshot left the comp at " + d.resolution;
        } },

      { name: "{resolution: 'comp'} keeps AE's downsample and warns",
        tool: "snapshot_frame",
        args: function (ctx) {
          return { comp: ctx.frComp, time: 1, resolution: "comp",
                   path: ctx.frTemp + "/ST Frame Half.png",
                   overwrite: true };
        },
        check: function (d) {
          if (d.width !== 120 || d.height !== 90) {
            return "a Half-resolution comp should write 120x90, got " +
                   d.width + "x" + d.height;
          }
          return (d.warning || "").indexOf("downsampled") !== -1 ||
                 "the smaller frame was not flagged: " + d.warning;
        } },

      { name: "cleanup: the frame comp goes back to Full",
        tool: "set_comp_setting",
        args: function (ctx) {
          return { comp: ctx.frComp, resolution: "full" };
        },
        check: function (d) {
          return d.resolution === "full [1, 1]" ||
                 "resolution reads " + d.resolution;
        } },

      // The round trip itself: the comp's own frame, back in the comp,
      // at exactly 100%.
      { name: "import_as_layer brings the frame back at 1:1",
        tool: "import_as_layer",
        args: function (ctx) {
          return { path: ctx.frWrote, comp: ctx.frComp, name: "ST FR Back" };
        },
        check: function (d, ctx) {
          if (d.index !== 1) return "landed at index " + d.index;
          if (d.sourceSize !== d.compSize) {
            return "ROUND TRIP: " + d.sourceSize + " came back into " +
                   d.compSize;
          }
          if (!d.scale || Math.abs(d.scale[0] - 100) > 0.001 ||
              Math.abs(d.scale[1] - 100) > 0.001) {
            return "ROUND TRIP: scaled to " +
                   (d.scale ? d.scale.join(",") : "(nothing)") +
                   ", not 100,100";
          }
          ctx.frSource = d.source;
          return (d.stillNote || "").indexOf("whole comp") !== -1 ||
                 "a still's timing was not explained: " + d.stillNote;
        } },

      { name: "AE really holds that scale, not just the report",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.frComp, layer: "ST FR Back",
                   property: "Scale" };
        },
        check: function (d) {
          var v = d.value;
          if (!v || v.length < 2) return "no scale value: " +
            JSON.stringify(v);
          return (Math.abs(v[0] - 100) < 0.001 &&
                  Math.abs(v[1] - 100) < 0.001) ||
                 "AE holds " + v.join(",");
        } },

      { name: "the same file again is REUSED and reloaded, not doubled",
        tool: "import_as_layer",
        args: function (ctx) {
          return { path: ctx.frWrote, comp: ctx.frComp, name: "ST FR Again" };
        },
        check: function (d) {
          if (d.reusedExisting !== true) {
            return "imported a second project item for one path";
          }
          if (d.warning) return "unexpected warning: " + d.warning;
          return (d.reuseNote || "").indexOf("RELOADED") !== -1 ||
                 "did not reload from disk, so a regenerated file would " +
                 "still show the old picture: " + d.reuseNote;
        } },

      // The fit arithmetic, against AE's own Fit to Comp numbers. A
      // 240x180 source in a 480x180 comp: x ratio 200, y ratio 100.
      { name: "fit CONTAINS, fill COVERS, stretch fills exactly",
        batch: function (ctx) {
          return [
            { tool: "import_as_layer",
              args: { path: ctx.frWrote, comp: ctx.frWide, fit: "fit",
                      name: "ST FR Contain" } },
            { tool: "import_as_layer",
              args: { path: ctx.frWrote, comp: ctx.frWide, fit: "fill",
                      name: "ST FR Cover" } },
            { tool: "import_as_layer",
              args: { path: ctx.frWrote, comp: ctx.frWide, fit: "stretch",
                      name: "ST FR Stretch" } },
            { tool: "import_as_layer",
              args: { path: ctx.frWrote, comp: ctx.frWide, fit: "none",
                      name: "ST FR AsIs" } }
          ];
        },
        check: function (rows) {
          var i;
          for (i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + i + ": " + rows[i].error;
          }
          var fit = rows[0].data.scale, fill = rows[1].data.scale,
              str = rows[2].data.scale;
          if (Math.abs(fit[0] - 100) > 0.001 ||
              Math.abs(fit[1] - 100) > 0.001) {
            return "'fit' should contain at 100,100 — got " + fit.join(",");
          }
          if (Math.abs(fill[0] - 200) > 0.001 ||
              Math.abs(fill[1] - 200) > 0.001) {
            return "'fill' should cover at 200,200 — got " + fill.join(",");
          }
          if (Math.abs(str[0] - 200) > 0.001 ||
              Math.abs(str[1] - 100) > 0.001) {
            return "'stretch' should be 200,100 (AE's own Fit to Comp) — " +
                   "got " + str.join(",");
          }
          return rows[3].data.scale === undefined ||
                 "'none' touched the scale: " +
                 JSON.stringify(rows[3].data.scale);
        } },

      { name: "AE really holds the stretched, non-uniform scale",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.frWide, layer: "ST FR Stretch",
                   property: "Scale" };
        },
        check: function (d) {
          var v = d.value;
          if (!v || v.length < 2) return "no scale value";
          return (Math.abs(v[0] - 200) < 0.001 &&
                  Math.abs(v[1] - 100) < 0.001) ||
                 "AE holds " + v.join(",");
        } },

      { name: "an invented fit is refused with the real list",
        tool: "import_as_layer",
        expectError: true,
        args: function (ctx) {
          return { path: ctx.frWrote, comp: ctx.frWide, fit: "squish" };
        },
        check: function (err) {
          return (err.indexOf("stretch") !== -1 &&
                  err.indexOf("fill") !== -1) ||
                 "does not name the real modes: " + err;
        } },

      { name: "a file that is not there is refused before AE is asked",
        tool: "import_as_layer",
        expectError: true,
        args: function (ctx) {
          return { path: ctx.frTemp + "/ST Nothing Here.png",
                   comp: ctx.frWide };
        },
        check: function (err) {
          return /File not found/.test(err) || "not a missing-file error: " +
                 err;
        } },

      // import_file has shipped since the beginning and has never been
      // exercised here, for want of a file on disk — snapshot_frame is
      // that file. It reaches the PROJECT PANEL only, which is the whole
      // difference between it and the tool above, and AE really does
      // take a second item for a path it already holds.
      { name: "import_file reaches the project panel and nothing else",
        tool: "import_file",
        args: function (ctx) { return { path: ctx.frWrote }; },
        check: function (d, ctx) {
          if (!d.name) return "no item name came back";
          if (!(d.id > 0)) return "no item id came back: " + d.id;
          return d.name.indexOf("ST Frame") === 0 ||
                 "imported something else: " + d.name;
        } },

      // And it MEASURES what it imported. Nothing else could: the caller
      // knows only the size it asked for, and comfy_generate proved that
      // is a different number - the KREA2 template upscales 1.6x between
      // its passes, so a request for 1024x1024 lands a 1640x1640 file.
      // The PNG here is a 240x180 still, so duration and frameRate must
      // be ABSENT rather than reported as zero.
      { name: "import_file reports the size AE measured, not one we asked for",
        tool: "import_file",
        args: function (ctx) { return { path: ctx.frWrote }; },
        check: function (d) {
          if (d.width !== 240 || d.height !== 180) {
            return "wrong or missing dimensions: " + d.width + "x" + d.height;
          }
          if (d.duration !== undefined) {
            return "a still reported a duration: " + d.duration;
          }
          if (d.frameRate !== undefined) {
            return "a still reported a frame rate: " + d.frameRate;
          }
          return d.hasAudio === undefined ||
                 "a still reported audio: " + d.hasAudio;
        } },

      { name: "and the layer count of the comp is untouched by it",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.frComp, limit: 0 }; },
        check: function (d) {
          // Three layers: the solid, and the two import_as_layer made.
          return d.numLayers === 3 ||
                 "import_file changed the comp: " + d.numLayers +
                 " layers, expected 3";
        } },

      { name: "cleanup: drop the frame rig (the footage sweep takes the PNG)",
        batch: function (ctx) {
          return [
            { tool: "delete_item", args: { item: ctx.frWide } },
            { tool: "delete_item", args: { item: ctx.frComp } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + i + ": " + rows[i].error;
          }
          return true;
        } },

      // ---- captions: render_comp_audio + add_captions (WORKPLAN 6.1
      // Pass C, the AE half of speech-to-captions).
      //
      // The transcription itself is NOT here and cannot be: it needs a
      // ~150 MB whisper.cpp install that no CI runner and few user
      // machines have, and it is covered by tests\test-captions.js and
      // scripts\verify-whisper.ps1 instead. What IS here is everything
      // AE owns, and every step below is a measurement from the probe:
      //
      //  - A comp with NO audio layer still renders a full, valid,
      //    audio-only AIFF: DONE, 772 674 bytes, no warning. Two seconds
      //    of silence transcribes as the word "You", so the honest-looking
      //    end of that pipeline is a caption reading "You" over a comp
      //    nobody spoke in. The refusal is the load-bearing step.
      //  - layer.inPoint is a SLIDE: it drags outPoint along and keeps
      //    the duration (in a 5s comp, in=2 reads back out=7). Set out
      //    first and every caption is the wrong length, silently. That is
      //    what the span assertions below exist for.
      //  - AE accepts an inverted or zero-length span without a word.
      //  - in/out QUANTIZE to AE's own time base (0.3333 -> 0.33329264),
      //    so every comparison here is a tolerance, never an equality.
      //
      // The rig needs no audio FILE: Tone on a solid flips hasAudio to
      // true, exactly as the audio_to_keyframes rig does. One second at
      // 24 fps, 160x120, so the audio render costs about as much as the
      // one-frame render above.
      { name: "create the caption rig (a solid, still silent)",
        batch: function () {
          return [
            { tool: "create_comp",
              args: { name: CAPCOMP, width: 160, height: 120,
                      duration: 1, frameRate: 24 } },
            { tool: "add_solid",
              args: { comp: CAPCOMP, name: "ST Cap Host",
                      color: [0.2, 0.2, 0.2], width: 160, height: 120 } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok) return "create_comp: " + rows[0].error;
          if (!rows[1].ok) return "add_solid: " + rows[1].error;
          ctx.capComp = rows[0].data.name;
          return true;
        } },

      // THE step. AE renders silence happily and reports DONE, so
      // without this the whole feature produces a confident wrong answer.
      { name: "rendering the audio of a comp with NO audio is REFUSED",
        tool: "render_comp_audio",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.capComp,
                   output: ctx.rqTemp + "/AELL_ST_never_audio.aif" };
        },
        check: function (err) {
          if (!/silence/i.test(err)) {
            return "does not say AE would render SILENCE, which is the " +
                   "whole reason to refuse: " + err;
          }
          return err.indexOf("ST Cap Host") !== -1 ||
                 "does not list what IS in the comp: " + err;
        } },

      { name: "Tone gives the caption rig a real audio track",
        tool: "apply_effect",
        args: function (ctx) {
          return { comp: ctx.capComp, layer: "ST Cap Host", effect: "Tone" };
        },
        check: function (d) {
          return d.matchName === "ADBE Aud Tone" ||
                 "wrong effect: " + d.matchName;
        } },

      { name: "render_comp_audio picks the audio module and writes bytes",
        tool: "render_comp_audio",
        args: function (ctx) {
          return { comp: ctx.capComp,
                   output: ctx.rqTemp + "/AELL_ST_audio.wav",
                   overwrite: true };
        },
        check: function (d, ctx) {
          if (d.status !== "DONE") {
            return "status " + d.status + (d.warning ? " — " + d.warning : "");
          }
          if (!(d.bytes > 0)) return "reported DONE but " + d.bytes + " bytes";
          if (!d.audioLayers || d.audioLayers.indexOf("ST Cap Host") === -1) {
            return "does not report what went into the mix: " + d.audioLayers;
          }
          // The audio output module forces its own extension, so the
          // path asked for (.wav) is not the path written.
          ctx.capAudio = d.output;
          return /\.(aif|aiff|wav|mp3)$/i.test(d.output) ||
                 "did not write an audio container: " + d.output;
        } },

      { name: "cleanup: drop the caption audio rig",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.capComp }; },
        check: function () { return true; } },

      // add_captions works in a comp of its own: it makes one layer per
      // caption and its default position is comp-relative.
      { name: "create the caption text rig",
        tool: "create_comp",
        args: { name: CAPTEXT, width: 1920, height: 1080, duration: 5,
                frameRate: 24 },
        check: function (d, ctx) { ctx.capText = d.name; return true; } },

      { name: "a zero-length caption is refused, not silently invisible",
        tool: "add_captions",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.capText,
                   segments: [{ start: 1, end: 1, text: "never seen" }] };
        },
        check: function (err) {
          return /not after start/i.test(err) ||
                 "does not explain the span: " + err;
        } },

      { name: "an inverted caption is refused with its own segment number",
        tool: "add_captions",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.capText, segments: [
            { start: 0, end: 1, text: "good" },
            { start: 3, end: 2, text: "backwards" }
          ] };
        },
        check: function (err) {
          return /segment 2/.test(err) ||
                 "does not say WHICH segment is wrong: " + err;
        } },

      { name: "and the good segment before it was not built either",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.capText, limit: 0 }; },
        check: function (d) {
          return d.numLayers === 0 ||
                 "a refused batch left " + d.numLayers + " layer(s) behind";
        } },

      { name: "add_captions builds one trimmed text layer per segment",
        tool: "add_captions",
        args: function (ctx) {
          return { comp: ctx.capText, fontSize: 48, segments: [
            { start: 0, end: 3.32,
              text: "The quick brown fox jumps over the lazy dog." },
            { start: 3.32, end: 4.9,
              text: "After effects renders the composition." }
          ] };
        },
        check: function (d, ctx) {
          if (d.captions !== 2) return "built " + d.captions + " captions";
          // Named and numbered, NOT named after the transcript.
          if (d.layers.join(",") !== "Caption 1,Caption 2") {
            return "captions are named after their text: " + d.layers;
          }
          ctx.capNames = d.layers;
          return true;
        } },

      // THE assertion of this block. Set outPoint before inPoint and
      // these read 8.32 and 8.22 instead, in real AE, silently.
      { name: "each caption is trimmed to its own span (inPoint SLIDES)",
        tool: "get_comp_details",
        args: function (ctx) { return { comp: ctx.capText, limit: 0 }; },
        check: function (d) {
          if (d.numLayers !== 2) return d.numLayers + " layers, expected 2";
          var by = {};
          for (var i = 0; i < d.layers.length; i++) {
            by[d.layers[i].name] = d.layers[i];
          }
          var a = by["Caption 1"], b = by["Caption 2"];
          if (!a || !b) return "captions not found by name";
          // Tolerances, not equalities: AE quantizes to its own time base.
          if (Math.abs(a.inPoint - 0) > 0.001 ||
              Math.abs(a.outPoint - 3.32) > 0.001) {
            return "caption 1 spans " + a.inPoint + ".." + a.outPoint +
                   ", expected 0..3.32";
          }
          if (Math.abs(b.inPoint - 3.32) > 0.001 ||
              Math.abs(b.outPoint - 4.9) > 0.001) {
            return "caption 2 spans " + b.inPoint + ".." + b.outPoint +
                   ", expected 3.32..4.9 — outPoint dragged by inPoint " +
                   "means the two were set in the wrong order";
          }
          return true;
        } },

      { name: "a caption past the end of the comp is built AND reported",
        tool: "add_captions",
        args: function (ctx) {
          return { comp: ctx.capText, name: "ST Late", segments: [
            { start: 4.5, end: 9, text: "runs off the end" }
          ] };
        },
        check: function (d) {
          return /past/i.test(d.note || "") ||
                 "no note that it runs off the timeline: " + d.note;
        } },

      { name: "'layer' is refused for text captions, not silently ignored",
        tool: "add_captions",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.capText, layer: "Caption 1",
                   segments: [{ start: 0, end: 1, text: "x" }] };
        },
        check: function (err) {
          return /markers/i.test(err) ||
                 "does not point at the mode where it means something: " +
                 err;
        } },

      { name: "as:'markers' writes timed markers instead of layers",
        tool: "add_captions",
        args: function (ctx) {
          return { comp: ctx.capText, as: "markers", segments: [
            { start: 0, end: 1.5, text: "first" },
            { start: 1.5, end: 2.5, text: "second" }
          ] };
        },
        check: function (d) {
          if (d.markersAdded !== 2) {
            return "wrote " + d.markersAdded + " markers, expected 2";
          }
          return d.as === "markers" || "reported as " + d.as;
        } },

      { name: "two captions at the same instant collapse, and it SAYS so",
        tool: "add_captions",
        args: function (ctx) {
          return { comp: ctx.capText, as: "markers", segments: [
            { start: 3, end: 3.5, text: "one" },
            { start: 3, end: 4, text: "same instant" }
          ] };
        },
        check: function (d) {
          if (d.markersAdded !== 1) {
            return "expected AE to keep one marker, it kept " + d.markersAdded;
          }
          return !!d.collapsed ||
                 "AE silently dropped a caption and the result did not say";
        } },

      { name: "cleanup: drop the caption text rig",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.capText }; },
        check: function () { return true; } },

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

      // ---- project hygiene (clean_project). PREVIEWS ONLY, deliberately.
      //
      // The suite runs inside whatever project the user has open, and
      // every action here is project-WIDE: executing remove_unused_footage
      // would delete their unused footage (and, measured, their empty
      // folders), and reduce_project would delete everything their kept
      // comps do not need. So the suite proves the preview is honest and
      // proves the refusals fire; the EXECUTE paths are covered against a
      // stubbed project in tests/test-project-hygiene.js and were verified
      // in real AE on throwaway projects during the 5.6 pass.
      //
      // The load-bearing steps are the two that re-read the project after
      // a preview: a "preview" that quietly deleted something is the one
      // failure this group exists to catch.
      { name: "hygiene rig: two comps",
        batch: function () {
          return [
            { tool: "create_comp",
              args: { name: "ST HYG Keep", width: 160, height: 120,
                      duration: 1, frameRate: 24 } },
            { tool: "create_comp",
              args: { name: "ST HYG Drop", width: 160, height: 120,
                      duration: 1, frameRate: 24 } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok || !rows[1].ok) {
            return "rig: " + (rows[0].error || rows[1].error);
          }
          ctx.hygKeep = rows[0].data.name;
          ctx.hygDrop = rows[1].data.name;
          return true;
        } },

      // An UNUSED footage item, made the way a user makes one by accident:
      // add a solid, delete the layer. The solid SOURCE stays in the
      // project panel with nothing pointing at it.
      { name: "hygiene rig: a solid source nobody uses, and one that is used",
        batch: function (ctx) {
          return [
            { tool: "add_solid",
              args: { comp: ctx.hygKeep, name: "ST HYG Orphan",
                      color: [1, 0, 0], width: 40, height: 40 } },
            { tool: "delete_layer",
              args: { comp: ctx.hygKeep, layer: "ST HYG Orphan" } },
            { tool: "add_solid",
              args: { comp: ctx.hygKeep, name: "ST HYG Used",
                      color: [0, 1, 0], width: 40, height: 40 } },
            { tool: "set_expression",
              args: { comp: ctx.hygKeep, layer: "ST HYG Used",
                      property: "transform/Opacity",
                      expression: 'comp("ST HYG Drop").duration * 0 + 100' } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + i + ": " + rows[i].error;
          }
          return true;
        } },

      { name: "clean_project with no action lists the three there are",
        tool: "clean_project",
        args: {},
        expectError: true,
        check: function (err) {
          return (/remove_unused_footage/.test(err) &&
                  /consolidate_footage/.test(err) &&
                  /reduce_project/.test(err)) ||
                 "refusal did not list the actions: " + err;
        } },

      { name: "an invented action is named back, not guessed at",
        tool: "clean_project",
        args: { action: "vacuum" },
        expectError: true,
        check: function (err) {
          return /Unknown action 'vacuum'/.test(err) ||
                 "error was: " + err;
        } },

      { name: "reduce_project will not guess which comps matter",
        tool: "clean_project",
        args: { action: "reduce_project" },
        expectError: true,
        check: function (err, ctx) {
          if (!/keepComps/.test(err)) return "no keepComps hint: " + err;
          return err.indexOf(ctx.hygKeep) !== -1 ||
                 "the refusal did not list real comps: " + err;
        } },

      // AE accepts a non-comp here and then deletes EVERY comp in the
      // project (measured on a throwaway project, 2026-08-28). This step
      // is the guard on that.
      { name: "reduce_project refuses a keepComps entry that is not a comp",
        tool: "clean_project",
        args: { action: "reduce_project", keepComps: ["ST HYG Orphan"] },
        expectError: true,
        check: function (err) {
          return /not a comp/.test(err) || "error was: " + err;
        } },

      { name: "reduce_project grounds an unknown comp name",
        tool: "clean_project",
        args: { action: "reduce_project", keepComps: ["ST HYG Nope"] },
        expectError: true,
        check: function (err, ctx) {
          return (/Comp not found/.test(err) &&
                  err.indexOf(ctx.hygKeep) !== -1) ||
                 "error was: " + err;
        } },

      { name: "remove_unused_footage previews the orphan solid",
        tool: "clean_project",
        args: { action: "remove unused footage" },
        check: function (d, ctx) {
          if (d.dryRun !== true) return "dryRun was " + d.dryRun;
          if (!(d.willRemove >= 1)) {
            return "the orphaned solid was not found (willRemove " +
                   d.willRemove + ")";
          }
          // The list is capped; only demand the name when nothing was cut.
          if (d.itemsNotShown) { ctx.hygCapped = true; return true; }
          for (var i = 0; i < d.items.length; i++) {
            if (String(d.items[i]).indexOf("ST HYG Orphan") !== -1) return true;
          }
          return "orphan not named in " + d.items.join(", ");
        } },

      { name: "and that preview deleted NOTHING",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          var sawOrphan = false, sawKeep = false, sawDrop = false;
          for (var i = 0; i < d.items.length; i++) {
            var n = d.items[i].name;
            if (n === "ST HYG Orphan") sawOrphan = true;
            if (n === ctx.hygKeep) sawKeep = true;
            if (n === ctx.hygDrop) sawDrop = true;
          }
          if (!sawOrphan) return "the preview DELETED the orphan solid";
          return (sawKeep && sawDrop) ||
                 "the preview deleted a rig comp (keep " + sawKeep +
                 ", drop " + sawDrop + ")";
        } },

      { name: "reduce_project preview names the comp AND the silent break",
        tool: "clean_project",
        args: function (ctx) {
          return { action: "reduce_project", keepComps: [ctx.hygKeep] };
        },
        check: function (d, ctx) {
          if (d.dryRun !== true) return "dryRun was " + d.dryRun;
          if (!d.keepComps || d.keepComps[0] !== ctx.hygKeep) {
            return "keepComps not echoed: " + JSON.stringify(d.keepComps);
          }
          if (!(d.willRemove >= 1)) return "nothing would be removed";
          var breaks = d.expressionBreaks || [];
          var named = false, i;
          for (i = 0; i < breaks.length; i++) {
            if (String(breaks[i]).indexOf(ctx.hygDrop) !== -1) named = true;
          }
          // expressionBreaks is capped too; a project full of expressions
          // can push ours off the end, and that is not this step failing.
          if (!named && !d.expressionBreaksNotShown) {
            return "the expression naming " + ctx.hygDrop +
                   " was not reported: " + JSON.stringify(breaks);
          }
          if (!d.itemsNotShown) {
            for (i = 0; i < d.items.length; i++) {
              if (String(d.items[i]).indexOf(ctx.hygDrop) !== -1) return true;
            }
            return ctx.hygDrop + " not named in " + d.items.join(", ");
          }
          return true;
        } },

      { name: "and THAT preview deleted nothing either",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          var sawKeep = false, sawDrop = false;
          for (var i = 0; i < d.items.length; i++) {
            if (d.items[i].name === ctx.hygKeep) sawKeep = true;
            if (d.items[i].name === ctx.hygDrop) sawDrop = true;
          }
          return (sawKeep && sawDrop) ||
                 "reduce_project's PREVIEW deleted a comp (keep " +
                 sawKeep + ", drop " + sawDrop + ")";
        } },

      { name: "consolidate_footage previews without touching anything",
        tool: "clean_project",
        args: { action: "consolidate" },
        check: function (d) {
          if (d.action !== "consolidate_footage") {
            return "action came back as " + d.action;
          }
          if (d.dryRun !== true) return "dryRun was " + d.dryRun;
          if (typeof d.willRemove !== "number") {
            return "no count: " + JSON.stringify(d);
          }
          return /PREVIEW ONLY/.test(d.note || "") ||
                 "note did not say it was a preview: " + d.note;
        } },

      // The 2026-09-02 guards. Only the half that CANNOT delete is asked
      // here: the other half — a dryRun:false with no preview behind it
      // is refused — would, if it ever regressed, delete the user's own
      // unused footage from the very step written to prove it does not.
      // That half is covered against a stubbed project in
      // tests/test-project-hygiene.js. This step keeps dryRun at its
      // default, so nothing can go even if the guard is gone.
      { name: "a comp scope is refused, not silently ignored",
        tool: "clean_project",
        expectError: true,
        args: function (ctx) {
          return { action: "consolidate", comp: ctx.hygKeep };
        },
        check: function (err, ctx) {
          if (!/no comp or layer scope/.test(err)) {
            return "wrong refusal: " + err;
          }
          return err.indexOf("'" + ctx.hygKeep + "' is a comp") !== -1 ||
                 "the refusal never named the comp: " + err;
        } },

      { name: "cleanup: delete the hygiene rig comps",
        batch: function (ctx) {
          return [
            { tool: "delete_item", args: { item: ctx.hygKeep } },
            { tool: "delete_item", args: { item: ctx.hygDrop } }
          ];
        },
        check: function (rows) {
          return (rows[0].ok && rows[1].ok) ||
                 "cleanup: " + (rows[0].error || rows[1].error);
        } },

      // ---- organize_project. PREVIEWS ONLY, same reason as clean_project.
      //
      // It files EVERY loose item at the project root, and the suite runs
      // inside whatever project the user has open, so an execute here
      // would rearrange their project panel. What gets proved is the
      // preview: it counts the suite's own new comp by name, it names the
      // nested folder it refuses to file into, and it moves nothing and
      // creates nothing. The execute path is covered against a stubbed
      // project in tests/test-organize-project.js and was measured in
      // real AE on a throwaway project (WORKPLAN-LOG 2026-08-28).
      { name: "organize rig: the project as it stands before any preview",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          var folders = 0, rootComps = false, i;
          for (i = 0; i < d.items.length; i++) {
            if (d.items[i].type !== "folder") continue;
            folders++;
            if (d.items[i].name === "Comps" && !d.items[i].folder) rootComps = true;
          }
          ctx.orgFolders = folders;
          ctx.orgItems = d.numItems;
          ctx.orgHasRootComps = rootComps;
          return typeof d.numItems === "number" || "no numItems";
        } },

      { name: "organize_project previews instead of filing",
        tool: "organize_project",
        args: {},
        check: function (d, ctx) {
          if (d.dryRun !== true) return "dryRun was " + d.dryRun;
          if (typeof d.willMove !== "number") {
            return "no willMove: " + JSON.stringify(d);
          }
          if (!/PREVIEW ONLY/.test(d.note || "")) {
            return "the note did not say it was a preview: " + d.note;
          }
          ctx.orgBefore = d.willMove;
          return true;
        } },

      { name: "organize rig: a loose comp, and a NESTED folder called Comps",
        batch: function () {
          return [
            { tool: "create_comp",
              args: { name: "ST ORG Loose", width: 160, height: 120,
                      duration: 1, frameRate: 24 } },
            { tool: "create_folder", args: { name: "ST ORG Nest" } },
            { tool: "create_folder",
              args: { name: "Comps", parent: "ST ORG Nest" } }
          ];
        },
        check: function (rows, ctx) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + i + ": " + rows[i].error;
          }
          ctx.orgComp = rows[0].data.name;
          ctx.orgNest = rows[1].data.id;
          return rows[2].data.path === "ST ORG Nest/Comps" ||
                 "nested folder came back as " + rows[2].data.path;
        } },

      { name: "the preview counts the new comp and REFUSES the nested folder",
        tool: "organize_project",
        args: {},
        check: function (d, ctx) {
          if (d.willMove !== ctx.orgBefore + 1) {
            return "willMove went " + ctx.orgBefore + " -> " + d.willMove +
                   " after one new comp";
          }
          if (!d.byFolder || !(d.byFolder.Comps >= 1)) {
            return "no Comps count: " + JSON.stringify(d.byFolder);
          }
          var named = false, i;
          for (i = 0; i < (d.sameNameElsewhere || []).length; i++) {
            if (d.sameNameElsewhere[i] === "ST ORG Nest/Comps") named = true;
          }
          if (!named && !d.sameNameElsewhereNotShown) {
            return "the nested Comps folder was not named: " +
                   JSON.stringify(d.sameNameElsewhere);
          }
          if (!ctx.orgHasRootComps) {
            var willCreate = false;
            for (i = 0; i < (d.foldersToCreate || []).length; i++) {
              if (d.foldersToCreate[i] === "Comps") willCreate = true;
            }
            if (!willCreate) {
              return "no root Comps folder exists, yet none would be " +
                     "created: " + JSON.stringify(d.foldersToCreate);
            }
          }
          // The moves list is capped; only demand the name when nothing
          // was cut off the end.
          if (d.movesNotShown) return true;
          for (i = 0; i < d.moves.length; i++) {
            if (d.moves[i] === ctx.orgComp + " -> Comps") return true;
          }
          return "the new comp is not named in " + d.moves.join(", ");
        } },

      { name: "and BOTH previews moved nothing and created no folder",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          var folders = 0, seen = null, i;
          for (i = 0; i < d.items.length; i++) {
            if (d.items[i].type === "folder") folders++;
            if (d.items[i].name === ctx.orgComp) seen = d.items[i];
          }
          if (!seen) return "the preview lost " + ctx.orgComp;
          if (seen.folder) {
            return "a PREVIEW filed the comp into '" + seen.folder + "'";
          }
          if (folders !== ctx.orgFolders + 2) {
            return "folder count went " + ctx.orgFolders + " -> " + folders +
                   " where only the rig's 2 were made";
          }
          return d.numItems === ctx.orgItems + 3 ||
                 "item count went " + ctx.orgItems + " -> " + d.numItems +
                 " where only the rig's 3 were made";
        } },

      // The GATE, taken from the one angle that is safe to ask in the
      // user's own project. A dryRun:false whose plan MATCHES the last
      // preview would file their whole project panel if the gate ever
      // regressed, so the suite never asks that; it asks the drifted
      // plan, which cannot execute even with the gate gone-- there is no
      // preview of THIS list anywhere. The other halves (no preview at
      // all, same-reply retry, the plan that does execute) live against
      // a stub in tests/test-organize-project.js, for the same reason
      // clean_project's dryRun:false half does.
      { name: "organize rig: one more loose comp, made AFTER the preview",
        tool: "create_comp",
        args: { name: "ST ORG Drift", width: 160, height: 120,
                duration: 1, frameRate: 24 },
        check: function (d, ctx) {
          ctx.orgDrift = d.name;
          return !!d.name || "no comp name in " + JSON.stringify(d);
        } },

      { name: "organize_project refuses a plan the user never saw",
        tool: "organize_project",
        expectError: true,
        args: { dryRun: false },
        check: function (err, ctx) {
          if (!/refused to move/.test(err)) return "wrong refusal: " + err;
          if (!/changed since the last preview/.test(err)) {
            return "the refusal did not name plan drift: " + err;
          }
          // The refusal lists the first ten moves and says how many it
          // cut; only demand the new comp by name when nothing was cut.
          if (/\+[0-9]+ more/.test(err)) return true;
          return err.indexOf(ctx.orgDrift) !== -1 ||
                 "the refusal never named the new comp: " + err;
        } },

      { name: "and the refusal moved nothing",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          var i, seen = 0;
          for (i = 0; i < d.items.length; i++) {
            if (d.items[i].name !== ctx.orgComp &&
                d.items[i].name !== ctx.orgDrift) continue;
            seen++;
            if (d.items[i].folder) {
              return "a REFUSED move filed '" + d.items[i].name +
                     "' into '" + d.items[i].folder + "'";
            }
          }
          return seen === 2 ||
                 "the refusal lost a comp: " + seen + " of 2 still there";
        } },

      { name: "cleanup: delete the organize rig",
        batch: function (ctx) {
          return [
            { tool: "delete_item", args: { item: ctx.orgNest } },
            { tool: "delete_item", args: { item: ctx.orgDrift } },
            { tool: "delete_item", args: { item: ctx.orgComp } }
          ];
        },
        check: function (rows) {
          return (rows[0].ok && rows[1].ok && rows[2].ok) ||
                 "cleanup: " + (rows[0].error || rows[1].error ||
                                rows[2].error);
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

      // ---- get_bounds: measuring without touching ---------------------
      // Its own comp because it moves a solid off the frame and turns it
      // 3D, and because the source-time steps SLIDE a layer in time —
      // none of which may reach a comp another group is measuring.
      //
      // What real AE taught this group (probes, WORKPLAN-LOG 2026-08-29):
      // sourceRectAtTime ignores the transform, ignores masks and
      // effects, needs BOTH arguments, and — the trap — takes the
      // layer's own SOURCE time while every property time is comp time.
      { name: "bounds scratch comp",
        tool: "create_comp",
        args: { name: BNCOMP, width: 1000, height: 800, duration: 6,
                frameRate: 30 },
        check: function (d, ctx) {
          ctx.bnComp = d.name;
          return typeof d.id === "number" || !!d.id || "no comp id";
        } },

      { name: "bounds rig: a 200x100 solid",
        tool: "add_solid",
        args: function (ctx) {
          return { comp: ctx.bnComp, name: "ST BN Solid", color: [1, 0, 0],
                   width: 200, height: 100 };
        },
        check: function (d) { return d.name === "ST BN Solid" || d.name; } },

      { name: "bounds rig: anchor to the corner",
        tool: "set_transform",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Solid",
                   property: "anchorPoint", value: [0, 0] };
        },
        check: function () { return true; } },

      { name: "bounds rig: park it at 500,400",
        tool: "set_transform",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Solid",
                   property: "position", value: [500, 400] };
        },
        check: function () { return true; } },

      { name: "get_bounds measures the solid in source AND comp space",
        tool: "get_bounds",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Solid" };
        },
        check: function (d) {
          var s = d.source || {}, c = d.comp || {};
          if (s.width !== 200 || s.height !== 100) {
            return "source " + s.width + "x" + s.height + ", expected 200x100";
          }
          if (c.left !== 500 || c.top !== 400 || c.right !== 700 ||
              c.bottom !== 500) {
            return "comp box " + JSON.stringify(c);
          }
          if (d.inFrame !== "fully") return "inFrame " + d.inFrame;
          if (d.outsideBy) return "reported overflow: " +
                                  JSON.stringify(d.outsideBy);
          if (!d.corners || d.corners.length !== 4 ||
              d.corners[2][0] !== 700 || d.corners[2][1] !== 500) {
            return "corners " + JSON.stringify(d.corners);
          }
          return (d.compSize[0] === 1000 && d.compSize[1] === 800) ||
                 "compSize " + JSON.stringify(d.compSize);
        } },

      { name: "…and does not disturb the layer it measured",
        tool: "get_property",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Solid",
                   property: "transform/Anchor Point" };
        },
        check: function (d) {
          var v = d.value || [];
          return (v[0] === 0 && v[1] === 0) ||
                 "anchor moved to " + JSON.stringify(v) +
                 " — get_bounds must be read-only";
        } },

      { name: "scale changes the COMP box and not the source rect",
        batch: function (ctx) {
          return [
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", property: "scale", value: [200, 50] } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Solid" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return rows[0].error;
          if (!rows[1].ok) return rows[1].error;
          var d = rows[1].data;
          if (d.source.width !== 200 || d.source.height !== 100) {
            return "the transform reached the SOURCE rect: " +
                   JSON.stringify(d.source);
          }
          return (d.comp.width === 400 && d.comp.height === 50) ||
                 "comp box " + d.comp.width + "x" + d.comp.height +
                 ", expected 400x50";
        } },

      { name: "a rotated layer says its box is the one AROUND it",
        batch: function (ctx) {
          return [
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", property: "rotation", value: 90 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Solid" } }
          ];
        },
        check: function (rows) {
          if (!rows[1].ok) return rows[1].error;
          var d = rows[1].data;
          if (Math.abs(d.comp.width - 50) > 0.01 ||
              Math.abs(d.comp.height - 400) > 0.01) {
            return "rotated box " + d.comp.width + "x" + d.comp.height +
                   ", expected 50x400";
          }
          if (d.rotated !== 90) return "rotated: " + d.rotated;
          return /axis-aligned/.test(d.rotatedNote || "") ||
                 "no rotatedNote: " + d.rotatedNote;
        } },

      { name: "bounds rig: back to square",
        batch: function (ctx) {
          return [
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", property: "rotation", value: 0 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", property: "scale", value: [100, 100] } }
          ];
        },
        check: function (rows) {
          return (rows[0].ok && rows[1].ok) || "reset failed";
        } },

      { name: "bounds rig: a parent null at 300,200",
        tool: "add_null",
        args: function (ctx) {
          return { comp: ctx.bnComp, name: "ST BN Null",
                   position: [300, 200] };
        },
        check: function (d) { return d.name === "ST BN Null" || d.name; } },

      { name: "bounds rig: parent the solid to it",
        tool: "set_layer_parent",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Solid",
                   parent: "ST BN Null" };
        },
        check: function () { return true; } },

      // The step that caught set_layer_parent's inverted keepPosition:
      // the solid sits at 500,400 with a [0,0] anchor and is 200x100, so
      // its box centre is 600,450 and the LINK ALONE must not move it.
      // Before the fix it jumped to 900,650 — by the null's position —
      // while the tool still reported "Visual positions preserved".
      // Doubles as proof that get_bounds follows the parent chain.
      { name: "parenting: the link does not move the box",
        tool: "get_bounds",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Solid" };
        },
        check: function (d, ctx) {
          ctx.bnCentre = [d.comp.centerX, d.comp.centerY];
          if (d.comp.width !== 200 || d.comp.height !== 100) {
            return "a parented, untransformed layer changed size: " +
                   d.comp.width + "x" + d.comp.height;
          }
          if (Math.abs(d.comp.centerX - 600) > 0.01 ||
              Math.abs(d.comp.centerY - 450) > 0.01) {
            return "the link moved the layer: centre " + d.comp.centerX +
                   "," + d.comp.centerY + ", expected 600,450";
          }
          return d.inFrame === "fully" ||
                 "inFrame " + d.inFrame + " at " + JSON.stringify(ctx.bnCentre);
        } },

      { name: "parenting: the PARENT's rotation moves the child's box",
        batch: function (ctx) {
          return [
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Null", property: "rotation", value: 180 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Solid" } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[1].ok) return rows[1].error;
          var d = rows[1].data;
          // Rotating the parent 180 degrees mirrors the child through the
          // parent's own position — the anchor is what a rotation turns
          // about, and Position is where that anchor sits.
          var wantX = 2 * 300 - ctx.bnCentre[0];
          var wantY = 2 * 200 - ctx.bnCentre[1];
          if (Math.abs(d.comp.centerX - wantX) > 0.01 ||
              Math.abs(d.comp.centerY - wantY) > 0.01) {
            return "centre " + d.comp.centerX + "," + d.comp.centerY +
                   ", expected " + wantX + "," + wantY;
          }
          return !d.rotated ||
                 "the CHILD is not rotated, but rotated=" + d.rotated;
        } },

      { name: "bounds rig: unparent and unrotate",
        batch: function (ctx) {
          return [
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", parent: null } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Null", property: "rotation", value: 0 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", property: "position",
                value: [500, 400] } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", property: "rotation", value: 0 } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          return true;
        } },

      // ---- set_layer_parent's two halves, measured not assumed --------
      // AE's two calls do the OPPOSITE of what their names suggest, and
      // this tool had them swapped from the day it shipped: `.parent =`
      // is the pick-whip (AE rewrites the transform, nothing moves) and
      // setParentWithJump keeps the numbers and moves the layer. The
      // steps below assert on WHERE THE LAYER ENDS UP, so they cannot be
      // satisfied by a tool that merely reports the right thing.
      // ST BN Null sits at 300,200 with no rotation by now.
      { name: "parent rig: a 100x100 solid parked at 500,400",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR Kid", color: [0, 0.6, 0.9],
                width: 100, height: 100 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Kid", property: "anchorPoint",
                value: [0, 0] } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Kid", property: "position",
                value: [500, 400] } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Kid" } }
          ];
        },
        check: function (rows, ctx) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var d = rows[3].data;
          ctx.prCentre = [d.comp.centerX, d.comp.centerY];
          return (Math.abs(d.comp.centerX - 550) < 0.01 &&
                  Math.abs(d.comp.centerY - 450) < 0.01) ||
                 "centre " + d.comp.centerX + "," + d.comp.centerY +
                 ", expected 550,450";
        } },

      { name: "the default link moves nothing and rewrites the numbers",
        batch: function (ctx) {
          return [
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR Kid", parent: "ST BN Null" } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Kid" } },
            { tool: "get_property", args: { comp: ctx.bnComp,
                layer: "ST PR Kid", property: "position" } }
          ];
        },
        check: function (rows, ctx) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          if (rows[0].data.keepPosition !== true) {
            return "keepPosition reported " +
                   JSON.stringify(rows[0].data.keepPosition);
          }
          var d = rows[1].data;
          if (Math.abs(d.comp.centerX - ctx.prCentre[0]) > 0.01 ||
              Math.abs(d.comp.centerY - ctx.prCentre[1]) > 0.01) {
            return "the layer MOVED: " + d.comp.centerX + "," +
                   d.comp.centerY + ", expected " +
                   ctx.prCentre.join(",") + " (inverted keepPosition)";
          }
          // The other half: AE paid for that by rewriting Position into
          // the parent's space, 500,400 -> 200,200. A tool that parented
          // without compensating would leave 500,400 here.
          var v = rows[2].data.value;
          if (Math.abs(v[0] - 200) > 0.01 || Math.abs(v[1] - 200) > 0.01) {
            return "Position reads " + v.join(",") + ", expected 200,200";
          }
          return /rewrote/.test(rows[0].data.note || "") ||
                 "the note does not mention the rewrite: " +
                 rows[0].data.note;
        } },

      { name: "keepPosition:false jumps by exactly the parent's position",
        batch: function (ctx) {
          return [
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR Kid", parent: null } },
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR Kid", parent: "ST BN Null",
                keepPosition: false } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Kid" } },
            { tool: "get_property", args: { comp: ctx.bnComp,
                layer: "ST PR Kid", property: "position" } }
          ];
        },
        check: function (rows, ctx) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var v = rows[3].data.value;
          if (Math.abs(v[0] - 500) > 0.01 || Math.abs(v[1] - 400) > 0.01) {
            return "keepPosition:false changed Position to " + v.join(",");
          }
          var d = rows[2].data;
          var wantX = ctx.prCentre[0] + 300, wantY = ctx.prCentre[1] + 200;
          if (Math.abs(d.comp.centerX - wantX) > 0.01 ||
              Math.abs(d.comp.centerY - wantY) > 0.01) {
            return "centre " + d.comp.centerX + "," + d.comp.centerY +
                   ", expected " + wantX + "," + wantY;
          }
          return /JUMPED/.test(rows[1].data.note || "") ||
                 "the note does not admit the jump: " + rows[1].data.note;
        } },

      // The silence worth breaking: keepPosition rewrites EVERY key, not
      // just the current value, so a model holding the old numbers is
      // holding numbers AE has thrown away.
      { name: "a keyframed layer has all its keys rewritten, and is told",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR Keyed", color: [0.9, 0.4, 0],
                width: 100, height: 100 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Keyed", property: "anchorPoint",
                value: [0, 0] } },
            { tool: "set_keyframes", args: { comp: ctx.bnComp,
                layer: "ST PR Keyed", property: "Position",
                keys: [{ time: 0, value: [500, 400] },
                       { time: 2, value: [700, 400] }] } },
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR Keyed", parent: "ST BN Null" } },
            { tool: "get_property", args: { comp: ctx.bnComp,
                layer: "ST PR Keyed", property: "position" } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var keys = rows[4].data.keys || [];
          if (keys.length !== 2) return "keys: " + keys.length;
          if (Math.abs(keys[0].value[0] - 200) > 0.01 ||
              Math.abs(keys[1].value[0] - 400) > 0.01) {
            return "keys read " + keys[0].value.join(",") + " and " +
                   keys[1].value.join(",") + ", expected 200,200 and 400,200";
          }
          var rep = rows[3].data.keyframesRewritten || "";
          if (rep.indexOf("ST PR Keyed") === -1) {
            return "keyframesRewritten does not name the layer: " + rep;
          }
          return /old numbers are gone/.test(
                   rows[3].data.keyframesNote || "") ||
                 "no keyframesNote: " + rows[3].data.keyframesNote;
        } },

      // ---- the compensation happens at ONE frame -----------------------
      // Measured 2026-08-29: AE works the compensation out once, from the
      // parent's transform at the PLAYHEAD, and writes it into the child
      // as fixed numbers. Under a parent that MOVES that makes "nothing
      // jumped" true at exactly one frame -- a still layer stayed put at
      // t=0 and was 400px away at t=2. Anchors are pinned to [0,0] so the
      // offset AE applies is the parent's Position exactly.
      { name: "parent rig: a parent that MOVES, and a still layer",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR Mover", color: [0.2, 0.8, 0.2],
                width: 100, height: 100 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Mover", property: "anchorPoint",
                value: [0, 0] } },
            { tool: "set_keyframes", args: { comp: ctx.bnComp,
                layer: "ST PR Mover", property: "Position",
                keys: [{ time: 0, value: [100, 100] },
                       { time: 2, value: [500, 100] }] } },
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR Still", color: [0.8, 0.8, 0.2],
                width: 100, height: 100 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Still", property: "anchorPoint",
                value: [0, 0] } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Still", property: "position",
                value: [400, 300] } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Still", time: 0 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Still", time: 2 } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var a = rows[6].data.comp, b = rows[7].data.comp;
          return (Math.abs(a.centerX - 450) < 0.01 &&
                  Math.abs(b.centerX - 450) < 0.01 &&
                  Math.abs(a.centerY - 350) < 0.01) ||
                 "the unparented layer is not still: t0 " + a.centerX + "," +
                 a.centerY + " t2 " + b.centerX + "," + b.centerY +
                 ", expected 450,350 at both";
        } },

      { name: "an animated parent holds the link at ONE frame, and says so",
        batch: function (ctx) {
          return [
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR Still", parent: "ST PR Mover", atTime: 0 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Still", time: 0 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Still", time: 2 } },
            { tool: "get_property", args: { comp: ctx.bnComp,
                layer: "ST PR Still", property: "position" } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var d = rows[0].data;
          if ((d.parentAnimated || "").indexOf("ST PR Mover") === -1 ||
              (d.parentAnimated || "").indexOf("Position (2 keys)") === -1) {
            return "parentAnimated does not name the moving parent: " +
                   d.parentAnimated;
          }
          if (!/NOT a jump-free link/.test(d.parentAnimatedNote || "")) {
            return "the note still calls it jump-free: " +
                   d.parentAnimatedNote;
          }
          if (!/^0s \(frame 0\), as asked/.test(d.compensatedAt || "")) {
            return "compensatedAt: " + d.compensatedAt;
          }
          var a = rows[1].data.comp, b = rows[2].data.comp;
          if (Math.abs(a.centerX - 450) > 0.01) {
            return "the layer moved AT the compensation frame: " + a.centerX;
          }
          if (Math.abs(b.centerX - 850) > 0.01) {
            return "at t=2 the layer is at " + b.centerX +
                   ", expected 850 (it must travel with the parent)";
          }
          var v = rows[3].data.value;
          return (Math.abs(v[0] - 300) < 0.01 && Math.abs(v[1] - 200) < 0.01) ||
                 "Position reads " + v.join(",") + ", expected 300,200";
        } },

      { name: "atTime picks WHICH frame must not move",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR Pinned", color: [0.2, 0.4, 0.9],
                width: 100, height: 100 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Pinned", property: "anchorPoint",
                value: [0, 0] } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Pinned", property: "position",
                value: [400, 300] } },
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR Pinned", parent: "ST PR Mover", atFrame: 60 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Pinned", time: 2 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Pinned", time: 0 } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var d = rows[3].data;
          if (!/^2s \(frame 60\)/.test(d.compensatedAt || "")) {
            return "compensatedAt: " + d.compensatedAt;
          }
          var at2 = rows[4].data.comp, at0 = rows[5].data.comp;
          if (Math.abs(at2.centerX - 450) > 0.01) {
            return "the frame that was ASKED for moved: " + at2.centerX +
                   ", expected 450";
          }
          return Math.abs(at0.centerX - 50) < 0.01 ||
                 "t=0 is at " + at0.centerX + ", expected 50 (it is the " +
                 "frame that gives way instead)";
        } },

      { name: "with no atTime the playhead is used, and named",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR Default", color: [0.9, 0.2, 0.6],
                width: 100, height: 100 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Default", property: "anchorPoint",
                value: [0, 0] } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Default", property: "position",
                value: [400, 300] } },
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR Default", parent: "ST PR Mover" } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Default", time: 0 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Default", time: 2 } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var d = rows[3].data;
          if (!/playhead where it stood/.test(d.compensatedAt || "")) {
            return "compensatedAt does not say where the frame came " +
                   "from: " + d.compensatedAt;
          }
          if (!/frame \d+/.test(d.compensatedAt || "")) {
            return "compensatedAt names no frame: " + d.compensatedAt;
          }
          // Playhead-agnostic: wherever it was compensated, the layer now
          // travels, which is the whole point of the warning.
          var a = rows[4].data.comp, b = rows[5].data.comp;
          return Math.abs(b.centerX - a.centerX - 400) < 0.01 ||
                 "the layer does not travel with the parent: t0 " +
                 a.centerX + " t2 " + b.centerX + " (expected 400 apart)";
        } },

      { name: "unparenting from a moving parent admits what it took away",
        batch: function (ctx) {
          return [
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR Still", parent: null, atTime: 0 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Still", time: 0 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST PR Still", time: 2 } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var d = rows[0].data;
          if ((d.parentAnimated || "").indexOf("ST PR Mover") === -1) {
            return "the parent it LEFT is not named: " + d.parentAnimated;
          }
          if (!/loses the motion/.test(d.parentAnimatedNote || "")) {
            return "the note is not about what was taken away: " +
                   d.parentAnimatedNote;
          }
          var a = rows[1].data.comp, b = rows[2].data.comp;
          return (Math.abs(a.centerX - 450) < 0.01 &&
                  Math.abs(b.centerX - 450) < 0.01) ||
                 "the layer did not come to rest at 450: t0 " + a.centerX +
                 " t2 " + b.centerX;
        } },

      { name: "atTime outside the comp is refused with the range",
        tool: "set_layer_parent",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST PR Still",
                   parent: "ST PR Mover", atTime: 99 };
        },
        expectError: true,
        check: function (err) {
          return (/0 to 6/.test(err) && /30 fps/.test(err)) ||
                 "ungrounded refusal: " + err;
        } },

      // ---- mixed dimensions: the other half of the same question -------
      // Measured 2026-08-29: the compensation SURVIVES a child and parent
      // that disagree about 3D. A 2D parent leaves the child's Z alone
      // (it does not zero it, the way turning the 3D switch off does),
      // and a 3D parent's Z never reaches a 2D child at all -- AE
      // compensates in X/Y only and the picture does not move.
      { name: "a 2D parent leaves a 3D child's Z alone",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR Flat", color: [0.5, 0.5, 0.5],
                width: 100, height: 100 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Flat", property: "anchorPoint",
                value: [0, 0] } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Flat", property: "position",
                value: [100, 100] } },
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR Deep", color: [0.3, 0.9, 0.9],
                width: 100, height: 100 } },
            { tool: "set_layer_3d", args: { comp: ctx.bnComp,
                layer: "ST PR Deep", enabled: true } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Deep", property: "anchorPoint",
                value: [0, 0, 0] } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR Deep", property: "position",
                value: [400, 300, 200] } },
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR Deep", parent: "ST PR Flat" } },
            { tool: "get_property", args: { comp: ctx.bnComp,
                layer: "ST PR Deep", property: "position" } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          if (rows[7].data.parentAnimated) {
            return "a still parent was reported as animated: " +
                   rows[7].data.parentAnimated;
          }
          var v = rows[8].data.value;
          if (Math.abs(v[0] - 300) > 0.01 || Math.abs(v[1] - 200) > 0.01) {
            return "X/Y read " + v[0] + "," + v[1] + ", expected 300,200";
          }
          return Math.abs(v[2] - 200) < 0.01 ||
                 "the Z was changed to " + v[2] + "; a 2D parent must " +
                 "leave it at 200";
        } },

      { name: "a 3D parent's Z never reaches a 2D child",
        batch: function (ctx) {
          return [
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR ZParent", color: [0.6, 0.3, 0.1],
                width: 100, height: 100 } },
            { tool: "set_layer_3d", args: { comp: ctx.bnComp,
                layer: "ST PR ZParent", enabled: true } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR ZParent", property: "anchorPoint",
                value: [0, 0, 0] } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR ZParent", property: "position",
                value: [400, 300, -400] } },
            { tool: "add_solid", args: { comp: ctx.bnComp,
                name: "ST PR FlatKid", color: [0.9, 0.9, 0.3],
                width: 100, height: 100 } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR FlatKid", property: "anchorPoint",
                value: [0, 0] } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST PR FlatKid", property: "position",
                value: [400, 300] } },
            { tool: "set_layer_parent", args: { comp: ctx.bnComp,
                layer: "ST PR FlatKid", parent: "ST PR ZParent" } },
            { tool: "get_property", args: { comp: ctx.bnComp,
                layer: "ST PR FlatKid", property: "position" } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var v = rows[8].data.value;
          return (Math.abs(v[0]) < 0.01 && Math.abs(v[1]) < 0.01) ||
                 "Position reads " + v.join(",") + ", expected 0,0 -- the " +
                 "compensation must use the parent's X/Y and nothing else";
        } },

      { name: "parent rig: clean up",
        batch: function (ctx) {
          return [
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR Kid" } },
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR Keyed" } },
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR Still" } },
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR Pinned" } },
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR Default" } },
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR Mover" } },
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR Deep" } },
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR Flat" } },
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR FlatKid" } },
            { tool: "delete_layer", args: { comp: ctx.bnComp,
                layer: "ST PR ZParent" } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          return true;
        } },

      // add_text_layer takes no 'name': AE names a text layer after its
      // own text, so the step uses whatever came back.
      { name: "text is measured as CONTENT, not as the comp",
        batch: function (ctx) {
          return [
            { tool: "add_text_layer", args: { comp: ctx.bnComp,
                text: "ST BN Text", fontSize: 48 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Text" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return rows[0].error;
          if (!rows[1].ok) return rows[1].error;
          var s = rows[1].data.source;
          if (!(s.width > 10 && s.width < 900)) {
            return "text width " + s.width + " — expected the drawn glyphs";
          }
          if (!(s.height > 10 && s.height < 200)) {
            return "text height " + s.height;
          }
          // AE measures text from its BASELINE, so the box starts above
          // the origin. A tool that reported 0 here would be guessing.
          return s.top < 0 ||
                 "text top " + s.top + " — expected a negative (above the " +
                 "baseline) origin";
        } },

      { name: "bounds rig: a shape layer with a tiny default rect",
        tool: "add_shape_layer",
        args: function (ctx) {
          return { comp: ctx.bnComp, name: "ST BN Shape", size: [2, 2],
                   fillColor: [0, 0, 1], position: [500, 400] };
        },
        check: function (d) { return d.name === "ST BN Shape" || d.name; } },

      { name: "bounds rig: a 100x100 stroked rectangle in its own group",
        batch: function (ctx) {
          return [
            { tool: "add_shape_content", args: { comp: ctx.bnComp,
                layer: "ST BN Shape", kind: "group", name: "ST BN Grp" } },
            { tool: "add_shape_content", args: { comp: ctx.bnComp,
                layer: "ST BN Shape", kind: "rectangle", group: "ST BN Grp",
                params: { Size: [100, 100], Position: [0, 0] } } },
            { tool: "add_shape_content", args: { comp: ctx.bnComp,
                layer: "ST BN Shape", kind: "fill", group: "ST BN Grp",
                params: { Color: [0, 1, 0, 1] } } },
            { tool: "add_shape_content", args: { comp: ctx.bnComp,
                layer: "ST BN Shape", kind: "stroke", group: "ST BN Grp" } }
          ];
        },
        check: function (rows, ctx) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          ctx.bnRect = rows[1].data.added;
          ctx.bnStroke = rows[3].data.added;
          return true;
        } },

      { name: "bounds rig: a 40px stroke on it",
        tool: "set_property",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Shape",
                   property: "contents/ST BN Grp/" + ctx.bnStroke +
                             "/Stroke Width", value: 40 };
        },
        check: function (d) { return d.value === 40 || "value " + d.value; } },

      { name: "extents:false measures the path, extents:true the stroke",
        batch: function (ctx) {
          return [
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Shape" } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Shape", extents: true } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return rows[0].error;
          if (!rows[1].ok) return rows[1].error;
          var plain = rows[0].data.source, ext = rows[1].data.source;
          if (plain.width !== 100 || plain.height !== 100) {
            return "path box " + plain.width + "x" + plain.height +
                   ", expected 100x100";
          }
          if (ext.width !== 300 || ext.height !== 300) {
            return "extents box " + ext.width + "x" + ext.height +
                   ", expected 300x300 — AE reserves the MITER allowance " +
                   "(half-width x (miter limit 4 + 1) = 100 a side for a " +
                   "40px stroke), not half the stroke width";
          }
          return rows[0].data.extents === false &&
                 rows[1].data.extents === true ||
                 "the result did not report which mode it used";
        } },

      { name: "bounds rig: animate the rectangle's Size",
        tool: "set_keyframes",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Shape",
                   property: "contents/ST BN Grp/" + ctx.bnRect + "/Size",
                   keys: [{ time: 0, value: [100, 100] },
                          { time: 2, value: [600, 100] }] };
        },
        check: function (d) {
          return d.easedPairs === undefined || true;
        } },

      { name: "bounds at a TIME reads that frame's content",
        batch: function (ctx) {
          return [
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Shape", time: 0 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Shape", time: 2 } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return rows[0].error;
          if (!rows[1].ok) return rows[1].error;
          if (rows[0].data.source.width !== 100) {
            return "t=0 width " + rows[0].data.source.width;
          }
          return rows[1].data.source.width === 600 ||
                 "t=2 width " + rows[1].data.source.width + ", expected 600";
        } },

      { name: "bounds rig: slide the shape two seconds later",
        tool: "set_layer_timing",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Shape", startTime: 2 };
        },
        check: function (d) {
          return d.startTime === 2 || "startTime " + d.startTime;
        } },

      // THE trap: AE's property times are comp times and slid with the
      // layer, but sourceRectAtTime takes the layer's own source time.
      // Handing it comp time (as this panel used to) measures a frame the
      // viewer is not showing.
      { name: "a slid layer is measured at SOURCE time, not comp time",
        batch: function (ctx) {
          return [
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Shape", time: 2 } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Shape", time: 4 } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return rows[0].error;
          if (!rows[1].ok) return rows[1].error;
          var early = rows[0].data, late = rows[1].data;
          if (early.source.width !== 100) {
            return "comp 2s (source 0s) width " + early.source.width +
                   ", expected 100 — comp time was passed straight through";
          }
          if (late.source.width !== 600) {
            return "comp 4s (source 2s) width " + late.source.width;
          }
          if (early.sourceTime !== 0) {
            return "sourceTime " + early.sourceTime + ", expected 0";
          }
          return /source time/.test(early.timeNote || "") ||
                 "no timeNote explaining the two clocks";
        } },

      { name: "bounds rig: slide the shape back",
        tool: "set_layer_timing",
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Shape", startTime: 0 };
        },
        check: function () { return true; } },

      { name: "a layer over the edge reports which side and by how much",
        batch: function (ctx) {
          return [
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", property: "position",
                value: [-100, 400] } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Solid" } },
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", property: "position",
                value: [2000, 400] } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Solid" } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var part = rows[1].data, gone = rows[3].data;
          if (part.inFrame !== "partly") return "inFrame " + part.inFrame;
          if (part.outsideBy.left !== 100) {
            return "outsideBy " + JSON.stringify(part.outsideBy);
          }
          if (part.outsideBy.right || part.outsideBy.top ||
              part.outsideBy.bottom) {
            return "sides that are inside were reported: " +
                   JSON.stringify(part.outsideBy);
          }
          if (gone.inFrame !== "outside") return "inFrame " + gone.inFrame;
          return gone.outsideBy.right === 1200 ||
                 "outsideBy " + JSON.stringify(gone.outsideBy);
        } },

      { name: "a 3D layer gets the source rect and an honest refusal",
        batch: function (ctx) {
          return [
            { tool: "set_transform", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", property: "position",
                value: [500, 400] } },
            { tool: "set_layer_3d", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", enabled: true } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Solid" } },
            { tool: "set_layer_3d", args: { comp: ctx.bnComp,
                layer: "ST BN Solid", enabled: false } }
          ];
        },
        check: function (rows) {
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) return "row " + (i + 1) + ": " + rows[i].error;
          }
          var d = rows[2].data;
          if (d.source.width !== 200) {
            return "3D source rect " + JSON.stringify(d.source);
          }
          if (d.comp !== null) {
            return "a comp box was reported for a 3D layer: " +
                   JSON.stringify(d.comp);
          }
          return (/ST BN Solid/.test(d.compBoxUnavailable || "") &&
                  /camera/.test(d.compBoxUnavailable || "")) ||
                 "compBoxUnavailable: " + d.compBoxUnavailable;
        } },

      { name: "bounds rig: a camera",
        tool: "add_camera",
        args: function (ctx) {
          return { comp: ctx.bnComp, name: "ST BN Cam" };
        },
        check: function () { return true; } },

      { name: "a camera has no bounds, and the refusal says what does",
        tool: "get_bounds",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.bnComp, layer: "ST BN Cam" };
        },
        check: function (err) {
          if (!/renders no pixels/.test(err)) return err;
          return /text, shape, solid, footage, precomp, null/.test(err) ||
                 "the refusal does not list what DOES have bounds: " + err;
        } },

      { name: "a layer that draws nothing says so instead of reporting 0",
        batch: function (ctx) {
          return [
            { tool: "add_shape_layer", args: { comp: ctx.bnComp,
                name: "ST BN Empty", size: [0, 0] } },
            { tool: "get_bounds", args: { comp: ctx.bnComp,
                layer: "ST BN Empty" } }
          ];
        },
        check: function (rows) {
          if (!rows[0].ok) return rows[0].error;
          if (!rows[1].ok) return rows[1].error;
          var d = rows[1].data;
          if (d.source.width !== 0 || d.source.height !== 0) {
            return "an empty shape layer measured " +
                   d.source.width + "x" + d.source.height;
          }
          return /renders nothing/.test(d.empty || "") ||
                 "no 'empty' note: " + JSON.stringify(d);
        } },

      { name: "a {layers: [...]} batch is refused, not half-done",
        tool: "get_bounds",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.bnComp, layers: ["ST BN Solid", "ST BN Text"] };
        },
        check: function (err) {
          return (/ONE layer/.test(err) && /once per layer/.test(err)) || err;
        } },

      // ---- Essential Graphics: expose_property / export_mogrt
      // (WORKPLAN 5.9 LOCK-IN).
      //
      // The EXPORT itself is not a step here, and that is a decision
      // rather than an omission. AE exports a template only from a
      // project that is SAVED and CLEAN, and by this point the suite has
      // created a dozen comps in whatever project the user has open — so
      // the only way to reach the export is to save the user's project,
      // which the suite may never do. Same shape as clean_project and
      // organize_project: the positive path is real-AE verified by hand
      // (2026-08-30, three field runs, an 11 822 b .mogrt) and the SUITE
      // holds the refusal wall, which is where every measured trap
      // lives anyway.
      //
      // The wall is worth as much as the export: AE answers `true` and
      // writes nothing for most of these, so a refusal that stops
      // reaching AE at all is the tool's whole job.
      { name: "create the mogrt rig",
        batch: function () {
          return [
            { tool: "create_comp",
              args: { name: MGCOMP, width: 320, height: 240,
                      duration: 2, frameRate: 24 } },
            { tool: "add_solid",
              args: { comp: MGCOMP, name: "ST MG Fill",
                      color: [0.2, 0.6, 0.9], width: 320, height: 240 } }
          ];
        },
        check: function (rows, ctx) {
          if (!rows[0].ok) return rows[0].error;
          if (!rows[1].ok) return rows[1].error;
          ctx.mgComp = rows[0].data.name;
          return true;
        } },

      // AE's default controller name is NOT the property's name: it is
      // the LAYER's for a transform or text property (and the EFFECT's
      // for an effect parameter), so two properties of one layer become
      // two confusingly similar controllers unless a label is passed.
      // The tool reads back what AE actually called it.
      { name: "expose_property reports the name AE really used",
        tool: "expose_property",
        args: function (ctx) {
          return { comp: ctx.mgComp, layer: "ST MG Fill",
                   property: "opacity" };
        },
        check: function (d, ctx) {
          if (d.controllerCount !== 1) {
            return "controllerCount " + d.controllerCount + ", expected 1";
          }
          if (d.controller.indexOf("ST MG Fill") !== 0) {
            return "AE named the controller \"" + d.controller +
                   "\", which does not start with the LAYER's name — the " +
                   "measured default";
          }
          ctx.mgDefaultName = d.controller;
          return /LAYER's name/.test(d.note || "") ||
                 "no note explaining AE's default name: " +
                 JSON.stringify(d);
        } },

      { name: "a label is used verbatim, and the indices renumber",
        tool: "expose_property",
        args: function (ctx) {
          return { comp: ctx.mgComp, layer: "ST MG Fill",
                   property: "position", label: "ST MG Move" };
        },
        check: function (d) {
          if (d.controller !== "ST MG Move") {
            return "controller is \"" + d.controller + "\", not the label";
          }
          if (d.controllerCount !== 2) {
            return "controllerCount " + d.controllerCount + ", expected 2";
          }
          // Index 1 is the NEWEST and every index renumbers on the next
          // add, so nothing may remember "my slider is number 3".
          return /1 is the newest/.test(d.next || "") ||
                 "the result does not say the indices renumber";
        } },

      // AE accepts duplicate controller names in silence (measured: two
      // called "Wipe Amount"), and an editor cannot tell them apart.
      { name: "a duplicate controller name is reported, not swallowed",
        tool: "expose_property",
        args: function (ctx) {
          return { comp: ctx.mgComp, layer: "ST MG Fill",
                   property: "scale", label: "ST MG Move" };
        },
        check: function (d) {
          return /ALSO called/.test(d.warning || "") ||
                 "no duplicate warning: " + JSON.stringify(d);
        } },

      { name: "a GROUP is refused with the leaf list to look in",
        tool: "expose_property",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mgComp, layer: "ST MG Fill",
                   property: "Transform" };
        },
        check: function (err) {
          return (/is a GROUP/.test(err) && /list_properties/.test(err)) ||
                 err;
        } },

      // AE refuses a second copy of a property that is already a
      // controller, and answers `undefined` rather than false. There is
      // no rename and no remove either — AE 2026 ships neither call — so
      // the refusal has to name the roster instead.
      { name: "exposing the same property twice is refused with the roster",
        tool: "expose_property",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mgComp, layer: "ST MG Fill",
                   property: "opacity" };
        },
        check: function (err, ctx) {
          if (!/ALREADY a controller/.test(err)) return err;
          return err.indexOf(ctx.mgDefaultName) !== -1 ||
                 "the refusal does not list the controllers that exist: " +
                 err;
        } },

      { name: "a writable folder for the export refusals",
        tool: "list_render_templates",
        args: {},
        check: function (d, ctx) {
          if (!d.tempFolder) return "no tempFolder to aim at";
          ctx.mgTemp = d.tempFolder.replace(/\\/g, "/").replace(/\/$/, "");
          return true;
        } },

      { name: "export_mogrt with no folder says what 'folder' is",
        tool: "export_mogrt",
        expectError: true,
        args: function (ctx) { return { comp: ctx.mgComp }; },
        check: function (err) {
          return (/'folder' is required/.test(err) &&
                  /FILE name comes from the template name/.test(err)) || err;
        } },

      { name: "a relative folder is refused before AE resolves it",
        tool: "export_mogrt",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mgComp, folder: "templates/out" };
        },
        check: function (err) {
          return (/must be an ABSOLUTE path/.test(err) &&
                  /working directory/.test(err)) || err;
        } },

      // AE mkdir -p's whatever folder it is handed and then fails INTO
      // it: the 2026-08-29 probe left four empty directories named after
      // its own failed calls. Refused here, naming the deepest folder
      // that does exist so the caller can see where the path went wrong.
      { name: "a missing folder is refused, not created and failed into",
        tool: "export_mogrt",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mgComp,
                   folder: ctx.mgTemp + "/ST MG Nope/deeper" };
        },
        check: function (err, ctx) {
          if (!/Folder does not exist/.test(err)) return err;
          if (!/Deepest folder that does exist/.test(err)) {
            return "the refusal does not name where the path stops: " + err;
          }
          return /CREATE this folder and then fail into it/.test(err) ||
                 "the refusal does not say why AE cannot be asked: " + err;
        } },

      // A name Windows will not accept is not refused by AE: it works
      // for 3.7 seconds, returns false and writes nothing.
      { name: "a name Windows will not take is refused before the clock",
        tool: "export_mogrt",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mgComp, folder: ctx.mgTemp,
                   name: "ST:MG*Bad?Name" };
        },
        check: function (err) {
          if (!/Windows will not put in a file name/.test(err)) return err;
          return (err.indexOf(":") !== -1 && err.indexOf("*") !== -1 &&
                  err.indexOf("?") !== -1) ||
                 "the refusal does not list the characters: " + err;
        } },

      { name: "a comp with no controllers is sent to expose_property",
        tool: "export_mogrt",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.comp, folder: ctx.mgTemp };
        },
        check: function (err) {
          return (/no Essential Graphics controllers/.test(err) &&
                  /expose_property/.test(err)) || err;
        } },

      // The last refusal in the wall, and the one that keeps the suite
      // off the export path: AE exports only from a SAVED, CLEAN
      // project, and the suite has been creating comps in the user's
      // open project since step 1. A dirty project returns false in
      // ~390 ms and writes nothing, with no message at all — so this
      // refusal is the only thing that would tell a user why. Either
      // refusal is correct here: a project that was never saved fails
      // the earlier check with its own text.
      { name: "an unsaved project is refused instead of failing silently",
        tool: "export_mogrt",
        expectError: true,
        args: function (ctx) {
          return { comp: ctx.mgComp, folder: ctx.mgTemp,
                   name: "ST MG Template" };
        },
        check: function (err) {
          if (/never been saved/.test(err)) {
            return /needs to be saved first/.test(err) ||
                   "the refusal does not quote what AE says: " + err;
          }
          if (!/unsaved changes/.test(err)) {
            return "expected the dirty-project or never-saved refusal, " +
                   "got: " + err;
          }
          if (!/390/.test(err)) {
            return "the refusal does not say AE fails SILENTLY: " + err;
          }
          return /\{save: true\}/.test(err) ||
                 "the refusal does not offer the way through: " + err;
        } },

      { name: "cleanup: delete the mogrt comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.mgComp }; },
        check: function () { return true; } },

      { name: "cleanup: delete the fan-out rig",
        tool: "delete_item",
        args: { item: "ST FanParent" },
        check: function () { return true; } },

      { name: "cleanup: delete the bounds comp",
        tool: "delete_item",
        args: function (ctx) { return { item: ctx.bnComp }; },
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
      // duplicates (field-observed: 45 items, visibly doubling).
      //
      // Two rules find them, because the sources have two kinds of name:
      //
      // (1) BY ID, against the baseline photographed in step 1: any
      //     footage item that was not in the project when the run started
      //     is this run's. That is the only rule that can reach the ones
      //     AE names for itself — "Null 1".."Null 189" from add_null and
      //     "Audio Amplitude" from audio_to_keyframes (which never uniques
      //     its null's name, so 168 of them read identically). Measured
      //     2026-08-30: 34 such orphans per run, in whatever project the
      //     user had open, including a real user's after Settings ->
      //     "Run self-test". They cannot be swept by NAME — a user's own
      //     project will hold a "Null 1" — so they are swept by identity.
      // (2) BY NAME, the original rule: footage in the suite's own "ST "
      //     namespace, which also reaches leftovers from an EARLIER run
      //     that died before its cleanup and are therefore in the
      //     baseline. Names outside "ST " are never touched by this half.
      //
      // Footage only, deliberately: the one non-footage item a run can add
      // is AE's own "Solids" FOLDER, which AE creates on demand and which
      // the user's next solid will want.
      { name: "cleanup: find the solid sources the suite left behind",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          var base = ctx.baseIds || {};
          ctx.leftoverIds = [];
          ctx.leftoverNames = [];
          for (var i = 0; i < d.items.length; i++) {
            var it = d.items[i];
            if (it.type !== "footage") continue;
            var mine = !base[it.id] || it.name.indexOf("ST ") === 0;
            if (!mine) continue;
            ctx.leftoverIds.push(it.id);
            ctx.leftoverNames.push(it.name);
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
          var names = ctx.leftoverNames || [];
          for (var i = 0; i < rows.length; i++) {
            if (!rows[i].ok) {
              return "leftover " + (i + 1) + " of " + rows.length +
                     (names[i] ? " ('" + names[i] + "')" : "") +
                     " not deleted: " + rows[i].error;
            }
          }
          return true;
        } },

      // The assertion the leak got past for eleven versions: "no ST item
      // remains" was true on every run that leaked 34 items, because not
      // one of them was called "ST " anything. So the count is checked
      // against the baseline as well — a run must hand the project panel
      // back the way it found it, whatever AE chose to name what it made.
      { name: "cleanup: nothing of the suite's remains in the project",
        tool: "get_project_info",
        args: { limit: 0 },
        check: function (d, ctx) {
          var stale = [], added = [], i;
          var base = ctx.baseIds || {};
          for (i = 0; i < d.items.length; i++) {
            var it = d.items[i];
            if (it.name.indexOf("ST ") === 0) stale.push(it.name);
            // The rig comps are named for the suite, not in its "ST "
            // namespace, so this check used to walk straight past a
            // leaked one — which is how ten "AELL Self-Test Wipe" comps
            // accumulated in the user's project unremarked. Scoped by ID
            // to THIS run, so a rig comp the user has kept on purpose
            // from an earlier one is never blamed on this run.
            else if (!base[it.id] && it.name.indexOf("AELL Self-Test") === 0) {
              stale.push(it.name);
            }
            // AE's "Solids" folder is created on demand and kept: it is
            // AE's, not the suite's, and the user's next solid wants it.
            else if (!base[it.id] && it.type === "footage") {
              added.push(it.name + " (#" + it.id + ")");
            }
          }
          if (stale.length) {
            return "the suite left items behind: " + stale.join(", ");
          }
          if (added.length) {
            return added.length + " footage item(s) the run created are " +
                   "still in the project, under names the ST sweep cannot " +
                   "see: " + added.slice(0, 8).join(", ") +
                   (added.length > 8 ? ", ..." : "");
          }
          return true;
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
