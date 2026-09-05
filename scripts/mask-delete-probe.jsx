/*
 * mask-delete-probe.jsx -- delete_mask has exactly the blindness set_mask
 * lost in 0.11.33: REMOVING a mask can empty a layer or hand it back, and
 * the receipt ({layer, removed, remainingMasks}) says neither.
 *
 * Filed as the top open item by the 0.11.33 pass. What is unmeasured:
 *
 *   1. Does deleting a mask really EMPTY a layer? The algebra says yes
 *      (a lone full-coverage 'subtract' measures EMPTY -- mask-erase-probe
 *      row), so deleting the 'add' window above one should take the layer
 *      with it. Derived from measured rules is not the same as measured.
 *   2. Does deleting a mask hand the layer BACK while masks remain? Same
 *      question from the other side.
 *   3. Does AELL_paradeShows read a parade the same way AFTER a
 *      MaskPropertyGroup.remove() as before it -- i.e. is the group object
 *      still usable once one of its children has been invalidated?
 *   4. What the shipped tool answers for all of the above (expected: a
 *      bare ok, which is the defect).
 *
 * Same instrument as scripts/mask-opacity-probe.jsx: comp.saveFrameToPng
 * writes no file on AE 26.3x87, so the layer's own alpha is read through
 * sampleImage(postEffect) on a slider expression.
 *
 * Driven by a generated wrapper that sets:
 *   $.global.AELL_PROBE_REPO  repo root, forward slashes
 *   $.global.AELL_PROBE_OUT   results JSON path, forward slashes
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

  function r3(n) { return Math.round(n * 1000) / 1000; }

  var comp = null, layer = null, ctrl = null, slider = null;
  var madeSources = [];
  var LW = 400, LH = 300;

  var POINTS = [
    { tag: "centre", fx: 0.5,  fy: 0.5  },
    { tag: "q1",     fx: 0.25, fy: 0.25 },
    { tag: "q2",     fx: 0.75, fy: 0.25 },
    { tag: "q3",     fx: 0.25, fy: 0.75 },
    { tag: "q4",     fx: 0.75, fy: 0.75 },
    { tag: "nearL",  fx: 0.02, fy: 0.5  },
    { tag: "nearR",  fx: 0.98, fy: 0.5  }
  ];

  function alphaAt(x, y) {
    slider.expression = 'thisComp.layer("MD solid").sampleImage([' + x +
      ', ' + y + '], [0.5, 0.5], true, time)[3];';
    return slider.value;
  }

  function readLayer() {
    var vals = [], sum = 0, max = 0, min = 1, i;
    for (i = 0; i < POINTS.length; i++) {
      var a = r3(alphaAt(r3(POINTS[i].fx * LW), r3(POINTS[i].fy * LH)));
      vals.push(POINTS[i].tag + "=" + a);
      sum += a;
      if (a > max) max = a;
      if (a < min) min = a;
    }
    return { points: vals, max: r3(max), min: r3(min),
             mean: r3(sum / POINTS.length) };
  }

  function clearMasks() {
    var mp = layer.property("ADBE Mask Parade");
    while (mp.numProperties > 0) mp.property(1).remove();
  }

  function addMaskRaw(spec) {
    var mp = layer.property("ADBE Mask Parade");
    var m = mp.addProperty("ADBE Mask Atom");
    m.name = spec.name;
    var s = new Shape();
    s.closed = true;
    s.vertices = [[spec.x, spec.y], [spec.x + spec.w, spec.y],
                  [spec.x + spec.w, spec.y + spec.h],
                  [spec.x, spec.y + spec.h]];
    m.property("ADBE Mask Shape").setValue(s);
    m.maskMode = spec.mode;
    if (spec.inverted) m.inverted = true;
    if (typeof spec.feather === "number" && spec.feather !== 0) {
      m.property("ADBE Mask Feather").setValue([spec.feather, spec.feather]);
    }
    return m;
  }

  /* Region shorthand on a 400x300 layer. */
  function full(name, mode)  { return { name: name, mode: mode, x: 0, y: 0, w: LW, h: LH }; }
  function halfL(name, mode) { return { name: name, mode: mode, x: 0, y: 0, w: LW / 2, h: LH }; }
  function bandL(name, mode) { return { name: name, mode: mode, x: 0, y: 0, w: 100, h: LH }; }
  function bandR(name, mode) { return { name: name, mode: mode, x: 200, y: 0, w: 100, h: LH }; }

  var A = MaskMode.ADD, S = MaskMode.SUBTRACT, N = MaskMode.NONE;

  /*
   * Every row is a parade plus the ONE mask to delete out of it. `expect`
   * is what the algebra predicts the alpha will do; it is recorded next to
   * what AE actually did so a disagreement is visible in the report rather
   * than argued about.
   */
  var CASES = [
    { tag: "delete the subtract over a full add",
      build: [full("Keep", A), full("Cut", S)], target: "Cut",
      expect: "EMPTY -> shows ALL" },
    { tag: "delete the WINDOW over a full subtract",
      build: [full("Cut", S), halfL("Win", A)], target: "Win",
      expect: "partial -> EMPTY" },
    { tag: "delete a partial subtract",
      build: [full("Keep", A), halfL("Cut", S)], target: "Cut",
      expect: "partial -> shows ALL" },
    { tag: "delete the only mask",
      build: [halfL("One", A)], target: "One",
      expect: "partial -> shows ALL" },
    { tag: "delete a redundant duplicate",
      build: [full("A1", A), full("A2", A)], target: "A2",
      expect: "shows ALL -> shows ALL" },
    { tag: "delete one of two separate bands",
      build: [bandL("One", A), bandR("Two", A)], target: "Two",
      expect: "partial -> partial" },
    { tag: "delete the last COMPOSITING mask ('none' carrier remains)",
      build: [halfL("One", A), full("Path", N)], target: "One",
      expect: "partial -> shows ALL" },
    { tag: "a FEATHER on a survivor makes the parade unreadable",
      build: [{ name: "Soft", mode: A, x: 0, y: 0, w: LW, h: LH, feather: 10 },
              full("Cut", S)], target: "Cut",
      expect: "EMPTY -> shows ALL, but unreadable" },
    { tag: "delete one of two full subtracts, layer stays empty",
      build: [full("CutA", S), full("CutB", S)], target: "CutB",
      expect: "EMPTY -> EMPTY" }
  ];

  /* NO app.beginUndoGroup anywhere in here -- see verb-semantics-probe.jsx
   * for the modal a nested group leaves behind for the SESSION. */
  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Mask Delete Probe", 640, 480, 1,
                                     2, 30);
    layer = comp.layers.addSolid([0.1, 0.6, 0.9], "MD solid", LW, LH, 1);
    madeSources.push(layer.source);
    ctrl = comp.layers.addNull();
    ctrl.name = "MD probe";
    var fx = ctrl.property("ADBE Effect Parade")
                 .addProperty("ADBE Slider Control");
    slider = fx.property("ADBE Slider Control-0001");

    stage = "A0 bare layer";
    clearMasks();
    var bare = readLayer();
    record({ id: "0-bare", max: bare.max, min: bare.min, mean: bare.mean,
             points: bare.points });

    stage = "A1 delete_mask before/after";
    var ci, mi;
    for (ci = 0; ci < CASES.length; ci++) {
      var cs = CASES[ci];
      clearMasks();
      for (mi = 0; mi < cs.build.length; mi++) addMaskRaw(cs.build[mi]);

      var box = AELL_layerBox(layer, comp.time);
      var mp = layer.property("ADBE Mask Parade");
      var showsBefore = "THREW";
      try { showsBefore = AELL_paradeShows(mp, box); }
      catch (eB) { showsBefore = "THREW: " + say(eB); }
      var before = readLayer();

      var res = null;
      try {
        res = call("delete_mask", { comp: comp.name, layer: layer.name,
                                    mask: cs.target });
      } catch (eCall) { res = { threw: say(eCall) }; }

      var after = readLayer();
      /* Read the SAME group object the tool held across the removal --
       * question 3 above. A second lookup is recorded beside it, so a
       * stale group shows up as a disagreement rather than as a wrong
       * sentence. */
      var showsAfter = "THREW", showsFresh = "THREW";
      try { showsAfter = AELL_paradeShows(mp, box); }
      catch (eA) { showsAfter = "THREW: " + say(eA); }
      try {
        showsFresh = AELL_paradeShows(layer.property("ADBE Mask Parade"), box);
      } catch (eF) { showsFresh = "THREW: " + say(eF); }

      record({ id: "1-delete", tag: cs.tag, target: cs.target,
               expect: cs.expect, raw: AELLJSON.stringify(res),
               beforeMax: before.max, beforeMin: before.min,
               beforeMean: before.mean, max: after.max, min: after.min,
               mean: after.mean, points: after.points,
               showsBefore: showsBefore, showsAfter: showsAfter,
               showsFresh: showsFresh });
    }
    clearMasks();

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
