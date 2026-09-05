/*
 * param-concept-probe.jsx -- measure the REAL parameter rosters of the
 * effects a model reaches for, so the "Parameter not found" concept map
 * is built out of names After Effects actually uses instead of guesses.
 * WORKPLAN item 8, the filed NEXT ("the lever is a CONCEPT map, not a
 * ranking", measured 2026-09-03).
 *
 * Driven by a generated wrapper that sets:
 *   $.global.AELL_PROBE_REPO  repo root, forward slashes
 *   $.global.AELL_PROBE_OUT   results JSON path, forward slashes
 *
 * Every measurement is FLUSHED the moment it is taken, so a step that
 * raises a modal still leaves the earlier answers on disk.
 */
(function () {
  var repo = $.global.AELL_PROBE_REPO;
  var outPath = $.global.AELL_PROBE_OUT;
  var results = [];
  var stage = "loading hostscript";

  function panic(msg) {
    try {
      var f = new File(outPath);
      f.encoding = "UTF-8";
      f.open("w");
      f.write('{"crashed":"' + String(msg).replace(/["\\\r\n]/g, " ") + '"}');
      f.close();
    } catch (e) {}
  }

  function flush() {
    try {
      var f = new File(outPath);
      f.encoding = "UTF-8";
      f.open("w");
      f.write(AELLJSON.stringify({ stage: stage, aeVersion: app.version,
                                   results: results }));
      f.close();
    } catch (e) {}
  }

  function record(obj) { results.push(obj); flush(); }

  function say(e) { return (e && e.message) ? String(e.message) : String(e); }

  try {
    $.evalFile(new File(repo + "/extension/jsx/hostscript.jsx"));
  } catch (eLoad) {
    panic("hostscript.jsx failed to load: " + say(eLoad));
    return;
  }

  function call(tool, args) {
    var raw = $.global.AELL_call(tool, AELLJSON.stringify(args || {}));
    return AELLJSON.parse(raw);
  }

  var comp = null;
  var madeSources = [];

  /* NO app.beginUndoGroup anywhere in here -- see verb-semantics-probe.jsx
   * for the modal that a nested group leaves behind for the SESSION. */
  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Concept Probe", 320, 240, 1, 5, 25);
    var lay = comp.layers.addSolid([0.4, 0.5, 0.6], "CP A", 100, 100, 1);
    madeSources.push(lay.source);
    var parade = lay.property("ADBE Effect Parade");

    /* ---- M1: the rosters. --------------------------------------------
     * The concept map matches the caller's word against the names on the
     * effect in front of it, so every word in the map has to be a word
     * that appears in one of these. */
    stage = "M1 rosters";
    var wanted = ["Drop Shadow", "Gaussian Blur", "Fast Box Blur",
                  "Directional Blur", "Glow", "Fill", "Tint", "Levels",
                  "Transform", "Bevel Alpha", "Radial Wipe", "Turbulent Displace",
                  "Hue/Saturation", "Brightness & Contrast", "CC Composite",
                  "Stroke", "Roughen Edges", "Linear Wipe", "Motion Tile",
                  "Offset", "Venetian Blinds", "Curves", "Tritone",
                  "Exposure", "Vibrance", "Find Edges", "Noise",
                  "Fractal Noise", "4-Color Gradient", "Ramp"];
    for (var w = 0; w < wanted.length; w++) {
      var rec = { id: "1-roster", effect: wanted[w], applied: false,
                  names: [], error: "" };
      var fxA = null;
      try {
        if (parade.canAddProperty(wanted[w])) {
          fxA = parade.addProperty(wanted[w]);
        } else {
          rec.error = "canAddProperty false";
        }
      } catch (eA) { rec.error = say(eA); }
      if (fxA) {
        rec.applied = true;
        rec.realName = String(fxA.name);
        rec.matchName = String(fxA.matchName);
        for (var i = 1; i <= fxA.numProperties; i++) {
          var p = null;
          try { p = fxA.property(i); } catch (eP) {}
          rec.names.push(p && p.name ? String(p.name) : "<none>");
        }
        try { fxA.remove(); } catch (eR) {}
      }
      record(rec);
    }

    /* ---- M2: does AE resolve a param name case-insensitively, and does
     * a near-miss spelling resolve at all? Decides whether the map has to
     * hand back the EXACT casing AE printed. */
    stage = "M2 lookup rules";
    var m2 = { id: "2-lookup" };
    var fxD = parade.addProperty("Drop Shadow");
    m2.lower = "";
    try { m2.lower = fxD.property("distance") ? "FOUND" : "null"; }
    catch (e2a) { m2.lower = "THREW: " + say(e2a); }
    m2.upper = "";
    try { m2.upper = fxD.property("DISTANCE") ? "FOUND" : "null"; }
    catch (e2b) { m2.upper = "THREW: " + say(e2b); }
    m2.partial = "";
    try { m2.partial = fxD.property("Dist") ? "FOUND" : "null"; }
    catch (e2c) { m2.partial = "THREW: " + say(e2c); }
    record(m2);

    /* ---- M3: the field failure verbatim -- the four names the model
     * guessed on Drop Shadow, each through the real tool, so the fix is
     * checked against the string it was really shown. */
    stage = "M3 the guessed names";
    var guesses = ["Offset", "Offset X", "Offset Y", "Blurriness",
                   "Blur", "Softness Amount", "Color", "Angle",
                   "Shadow Distance", "Alpha"];
    for (var g = 0; g < guesses.length; g++) {
      var r = call("set_effect_param", { comp: comp.name, layer: "CP A",
                                         effect: "Drop Shadow",
                                         param: guesses[g], value: 10 });
      record({ id: "3-guess", param: guesses[g], ok: r.ok,
               error: r.ok ? "" : String(r.error) });
    }

    /* ---- M4: the OTHER path a param name travels -- the dotted
     * property spec that add_keyframe / link_property / set_expression
     * all resolve through AELL_resolveProperty. */
    stage = "M4 dotted spec";
    var m4 = { id: "4-dotted" };
    var r4 = call("add_keyframe", { comp: comp.name, layer: "CP A",
                                    property: "effect.Drop Shadow.Blurriness",
                                    time: 0, value: 10 });
    m4.ok = r4.ok;
    m4.error = r4.ok ? "" : String(r4.error);
    record(m4);

    stage = "cleanup";
  } catch (err) {
    record({ id: "CRASH", stage: stage, message: say(err),
             line: (err && err.line) ? err.line : 0 });
  }

  try {
    if (comp) comp.remove();
    for (var s = 0; s < madeSources.length; s++) {
      try { madeSources[s].remove(); } catch (eS) {}
    }
    stage = stage + " + cleaned";
  } catch (eC) {
    stage = stage + " + CLEANUP FAILED: " + say(eC);
  }
  flush();
})();
