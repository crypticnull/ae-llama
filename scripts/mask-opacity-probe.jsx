/*
 * mask-opacity-probe.jsx -- a mask's OPACITY is a mask property nothing
 * in this project reads, and three shipped sentences are computed as if
 * every mask were at 100.
 *
 * Filed by the 0.11.26 pass ("Mask OPACITY is not read"), carried by
 * every mask pass since, and the top open item after 0.11.32. What is
 * unmeasured:
 *
 *   1. What a mask at opacity 0 does. AELL_maskRect REFUSES one (it
 *      requires exactly 100), so the whole parade goes unreadable and
 *      add_mask's four sentences go silent -- a silence, not a lie, but
 *      it is also the reason a layer emptied by `set_mask {opacity: 0}`
 *      gets a bare ok. The open question is whether opacity 0 means "this
 *      mask contributes nothing" (its region is worth NOTHING, and a lone
 *      add mask at 0 therefore EMPTIES the layer) or "this mask is not
 *      there" (the layer is whole). The two differ on every row.
 *   2. Whether an opacity-0 mask still COMPOSITES, i.e. whether the next
 *      mask sees state null ("no mask yet") or a real state. Measured
 *      discriminator: a full-coverage 'intersect' reads ALL over a bare
 *      layer and NONE over masks showing nothing.
 *   3. What a partial opacity (50) does -- expected to be a faded layer,
 *      which "all / some / none" cannot say, so the reader must bail.
 *      Measure it rather than assume it.
 *   4. EXPANSION, which AELL_maskRect does not read either. If expansion
 *      grows what a mask covers, then a rect reading taken from the SHAPE
 *      alone is wrong today -- the same class as opacity, one property
 *      further down the same group.
 *
 * Same instrument as scripts/mask-erase-probe.jsx, mask-above-probe.jsx
 * and mask-ellipse-probe.jsx, for the same reason: comp.saveFrameToPng
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

  /* The same seven points mask-above-probe.jsx used: no feather is set
   * anywhere in here, so its two edge-band points buy nothing, and left
   * and right are kept because half the bases are one-sided. */
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
    slider.expression = 'thisComp.layer("MO solid").sampleImage([' + x +
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

  function addMaskRaw(x, y, w, h, mode, inverted, name, opacity, expansion) {
    var mp = layer.property("ADBE Mask Parade");
    var m = mp.addProperty("ADBE Mask Atom");
    if (name) m.name = name;
    var s = new Shape();
    s.closed = true;
    s.vertices = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    m.property("ADBE Mask Shape").setValue(s);
    if (mode) m.maskMode = mode;
    if (inverted) m.inverted = true;
    if (typeof opacity === "number") {
      m.property("ADBE Mask Opacity").setValue(opacity);
    }
    if (typeof expansion === "number" && expansion !== 0) {
      m.property("ADBE Mask Offset").setValue(expansion);
    }
    return m;
  }

  var MODES = [
    { name: "add", mode: MaskMode.ADD },
    { name: "subtract", mode: MaskMode.SUBTRACT },
    { name: "intersect", mode: MaskMode.INTERSECT },
    { name: "lighten", mode: MaskMode.LIGHTEN },
    { name: "darken", mode: MaskMode.DARKEN },
    { name: "difference", mode: MaskMode.DIFFERENCE },
    { name: "none", mode: MaskMode.NONE }
  ];

  /* The region worth NOTHING: clear of the layer on both axes, where
   * mask-erase-probe.jsx put its M5 masks. */
  var OFF = { x: LW + 100, y: LH + 100, w: 100, h: 100 };

  /* Bases for A1. Every one of them is a parade the READER has to place:
   * the pairs that matter are addAll0 vs none (does an opacity-0 mask
   * composite at all?) and addAll0 vs addAll100 (does opacity 0 empty the
   * layer?). */
  function buildBase(tag) {
    clearMasks();
    if (tag === "none") return;
    if (tag === "addAll100") {
      addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "base", 100);
      return;
    }
    if (tag === "addAll0") {
      addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "base", 0);
      return;
    }
    if (tag === "addHalf100") {
      addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "base", 100);
      return;
    }
    if (tag === "addHalf0") {
      addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "base", 0);
      return;
    }
    if (tag === "subAll0") {
      addMaskRaw(0, 0, LW, LH, MaskMode.SUBTRACT, false, "base", 0);
      return;
    }
  }

  var BASES = ["none", "addAll100", "addAll0", "addHalf100", "addHalf0",
               "subAll0"];

  /* NO app.beginUndoGroup anywhere in here -- see verb-semantics-probe.jsx
   * for the modal a nested group leaves behind for the SESSION. */
  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Mask Opacity Probe", 640, 480, 1,
                                     2, 30);
    layer = comp.layers.addSolid([0.9, 0.15, 0.1], "MO solid", LW, LH, 1);
    madeSources.push(layer.source);
    ctrl = comp.layers.addNull();
    ctrl.name = "MO probe";
    var fx = ctrl.property("ADBE Effect Parade")
                 .addProperty("ADBE Slider Control");
    slider = fx.property("ADBE Slider Control-0001");

    stage = "A0 bare layer";
    clearMasks();
    var bare = readLayer();
    record({ id: "0-bare", max: bare.max, min: bare.min, mean: bare.mean,
             points: bare.points });

    /* ---- A1: ONE mask, every mode x opacity x region ---------------- */
    stage = "A1 lone mask, opacity sweep";
    var OPACITIES = [0, 50, 100];
    var REGIONS = [
      { tag: "all", x: 0, y: 0, w: LW, h: LH },
      { tag: "none", x: OFF.x, y: OFF.y, w: OFF.w, h: OFF.h },
      { tag: "half", x: 0, y: 0, w: LW / 2, h: LH }
    ];
    var ri, mi, oi;
    for (ri = 0; ri < REGIONS.length; ri++) {
      for (mi = 0; mi < MODES.length; mi++) {
        for (oi = 0; oi < OPACITIES.length; oi++) {
          clearMasks();
          var R = REGIONS[ri];
          addMaskRaw(R.x, R.y, R.w, R.h, MODES[mi].mode, false, "solo",
                     OPACITIES[oi]);
          var v = readLayer();
          record({ id: "1-lone", region: R.tag, mode: MODES[mi].name,
                   opacity: OPACITIES[oi], max: v.max, min: v.min,
                   mean: v.mean, bareMean: bare.mean,
                   sameAsBare: (v.mean === bare.mean && v.max === bare.max &&
                                v.min === bare.min),
                   points: v.points });
        }
      }
    }

    /* ---- A2: what each base shows on its own ------------------------ */
    stage = "A2 bases";
    var baseRead = {}, b;
    for (b = 0; b < BASES.length; b++) {
      buildBase(BASES[b]);
      var v0 = readLayer();
      baseRead[BASES[b]] = v0;
      record({ id: "2-base", base: BASES[b], max: v0.max, min: v0.min,
               mean: v0.mean, points: v0.points });
    }

    /* ---- A3: does an opacity-0 mask COMPOSITE? ----------------------
     * The discriminators, from AELL_maskApply's own table: a full
     * coverage 'intersect'/'darken' reads ALL over a bare layer and NONE
     * over masks that show nothing, and 'difference' reads ALL over a
     * bare layer and NONE over masks showing everything. Whatever the
     * opacity-0 bases answer places them exactly. */
    stage = "A3 second mask over each base";
    var SECOND = ["add", "subtract", "intersect", "darken", "difference"];
    var bi, si;
    for (bi = 0; bi < BASES.length; bi++) {
      for (si = 0; si < SECOND.length; si++) {
        buildBase(BASES[bi]);
        var mode = null;
        for (mi = 0; mi < MODES.length; mi++) {
          if (MODES[mi].name === SECOND[si]) mode = MODES[mi].mode;
        }
        addMaskRaw(0, 0, LW, LH, mode, false, "second", 100);
        var v2 = readLayer();
        var bs = baseRead[BASES[bi]];
        record({ id: "3-over", base: BASES[bi], mode: SECOND[si],
                 max: v2.max, min: v2.min, mean: v2.mean, baseMean: bs.mean,
                 sameAsBase: (v2.mean === bs.mean && v2.max === bs.max &&
                              v2.min === bs.min),
                 points: v2.points });
      }
    }

    /* ---- A4: EXPANSION, the other unread property ------------------- */
    stage = "A4 expansion";
    var EXPANSIONS = [0, 25, 300, -300];
    var ei;
    for (ei = 0; ei < EXPANSIONS.length; ei++) {
      clearMasks();
      addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "exp", 100,
                 EXPANSIONS[ei]);
      var ve = readLayer();
      record({ id: "4-expansion", mode: "add", region: "half",
               expansion: EXPANSIONS[ei], max: ve.max, min: ve.min,
               mean: ve.mean, points: ve.points });
    }
    for (ei = 0; ei < EXPANSIONS.length; ei++) {
      clearMasks();
      addMaskRaw(0, 0, LW, LH, MaskMode.SUBTRACT, false, "exp", 100,
                 EXPANSIONS[ei]);
      var vs = readLayer();
      record({ id: "4-expansion", mode: "subtract", region: "all",
               expansion: EXPANSIONS[ei], max: vs.max, min: vs.min,
               mean: vs.mean, points: vs.points });
    }

    /* ---- A4b: an opacity-0 mask that is NOT the first ---------------
     * A3 only ever put the opacity-0 mask at the BOTTOM of the parade,
     * and the reader walks masks in order — so "a mask at opacity 0
     * leaves the layer showing nothing" has to be true wherever it sits,
     * or the rule is about first masks only. The 'none'-mode row is the
     * boundary: a path CARRIER does not composite, so its opacity must
     * not matter either. */
    stage = "A4b opacity 0 further up the parade";
    var PARADES = [
      { tag: "addAll100 then addAll0", build: function () {
          addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "m2", 0);
        } },
      { tag: "addHalf100 then addHalf0", build: function () {
          addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "m2", 0);
        } },
      { tag: "addHalf100 then offSubtract0", build: function () {
          addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(OFF.x, OFF.y, OFF.w, OFF.h, MaskMode.SUBTRACT, false,
                     "m2", 0);
        } },
      { tag: "addHalf100 then noneAll0", build: function () {
          addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW, LH, MaskMode.NONE, false, "m2", 0);
        } },
      { tag: "addAll0 then addAll100", build: function () {
          addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "m1", 0);
          addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "m2", 100);
        } },
      /* The three modes A4b's first four rows leave unmeasured in a
       * NON-first position. 'add' and 'subtract' there contributed
       * nothing, which reads as "its region is worth NOTHING" — but that
       * reading predicts these three leave the layer alone too, and an
       * intersect against a zero-alpha mask could just as well empty it.
       * Both a full-coverage base and a half one, because "unchanged" and
       * "empty" are the same reading over a base that shows nothing. */
      { tag: "addAll100 then intersectAll0", build: function () {
          addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW, LH, MaskMode.INTERSECT, false, "m2", 0);
        } },
      { tag: "addAll100 then darkenAll0", build: function () {
          addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW, LH, MaskMode.DARKEN, false, "m2", 0);
        } },
      { tag: "addAll100 then differenceAll0", build: function () {
          addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW, LH, MaskMode.DIFFERENCE, false, "m2", 0);
        } },
      { tag: "addHalf100 then intersectAll0", build: function () {
          addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW, LH, MaskMode.INTERSECT, false, "m2", 0);
        } },
      { tag: "addHalf100 then darkenAll0", build: function () {
          addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW, LH, MaskMode.DARKEN, false, "m2", 0);
        } },
      { tag: "addHalf100 then differenceAll0", build: function () {
          addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW, LH, MaskMode.DIFFERENCE, false, "m2", 0);
        } },
      /* And the mirror of the whole question: an INVERTED opacity-0 mask.
       * Inversion swaps what the region is worth, so if opacity 0 really
       * is "its region is worth nothing" the inverted twin would be worth
       * EVERYTHING and would empty the half-base. */
      { tag: "addHalf100 then invSubtractAll0", build: function () {
          addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "m1", 100);
          addMaskRaw(0, 0, LW, LH, MaskMode.SUBTRACT, true, "m2", 0);
        } },
      { tag: "lone invAddAll0", build: function () {
          addMaskRaw(0, 0, LW, LH, MaskMode.ADD, true, "m1", 0);
        } }
    ];
    var pi;
    for (pi = 0; pi < PARADES.length; pi++) {
      clearMasks();
      PARADES[pi].build();
      var vp = readLayer();
      var readBack = "THREW";
      try {
        readBack = AELL_paradeShows(layer.property("ADBE Mask Parade"),
                                    AELL_layerBox(layer, comp.time));
      } catch (eB) { readBack = "THREW: " + say(eB); }
      record({ id: "4b-parade", tag: PARADES[pi].tag, shows: readBack,
               max: vp.max, min: vp.min, mean: vp.mean, points: vp.points });
    }

    /* ---- A5: what the SHIPPED tools answer today --------------------
     * set_mask writes opacity and has never said a word about it; the
     * add_mask rows are the ones whose reading an opacity-0 mask in the
     * parade destroys. */
    stage = "A5 receipts";
    var recCases = [
      { tag: "set opacity 0 over addAll100", base: "addAll100",
        tool: "set_mask", args: { opacity: 0 } },
      { tag: "set opacity 0 over addHalf100", base: "addHalf100",
        tool: "set_mask", args: { opacity: 0 } },
      { tag: "set opacity 50 over addAll100", base: "addAll100",
        tool: "set_mask", args: { opacity: 50 } },
      { tag: "set opacity 100 over addAll100", base: "addAll100",
        tool: "set_mask", args: { opacity: 100 } },
      { tag: "set opacity 0 over subAll100", base: "subAll100",
        tool: "set_mask", args: { opacity: 0 } },
      { tag: "set mode subtract over addAll100", base: "addAll100",
        tool: "set_mask", args: { mode: "subtract" } },
      { tag: "add difference over addAll0", base: "addAll0",
        tool: "add_mask", args: { mode: "difference" } },
      { tag: "add subtract over addAll0", base: "addAll0",
        tool: "add_mask", args: { mode: "subtract" } },
      { tag: "add add over addHalf0", base: "addHalf0",
        tool: "add_mask", args: { mode: "add" } }
    ];
    var ci;
    for (ci = 0; ci < recCases.length; ci++) {
      var cs = recCases[ci];
      if (cs.base === "subAll100") {
        clearMasks();
        addMaskRaw(0, 0, LW / 2, LH, MaskMode.SUBTRACT, false, "base", 100);
      } else {
        buildBase(cs.base);
      }
      var before = readLayer();
      var argsFull = { comp: comp.name, layer: layer.name };
      var key;
      for (key in cs.args) {
        if (cs.args.hasOwnProperty(key)) argsFull[key] = cs.args[key];
      }
      var res = null;
      try { res = call(cs.tool, argsFull); }
      catch (eCall) { res = { threw: say(eCall) }; }
      var after = readLayer();
      record({ id: "5-receipt", tag: cs.tag, tool: cs.tool,
               raw: AELLJSON.stringify(res), beforeMean: before.mean,
               max: after.max, min: after.min, mean: after.mean,
               points: after.points });
    }

    /* ---- A6: what the READER answers for each parade ----------------
     * AELL_paradeShows against the same bases, so the fix can be checked
     * against the alpha above rather than against its own reasoning. */
    stage = "A6 reader";
    for (b = 0; b < BASES.length; b++) {
      buildBase(BASES[b]);
      var box = null, shows = "THREW";
      try {
        box = AELL_layerBox(layer, comp.time);
        shows = AELL_paradeShows(layer.property("ADBE Mask Parade"), box);
      } catch (eR) { shows = "THREW: " + say(eR); }
      record({ id: "6-reader", base: BASES[b], shows: shows,
               mean: baseRead[BASES[b]].mean });
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
