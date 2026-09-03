/*
 * mask-above-probe.jsx -- measure what a new mask does over the masks
 * ALREADY on the layer, as a function of what those masks SHOW.
 *
 * Filed by the 0.11.27 pass as its top item. AELL_maskErases and
 * AELL_maskNoOp take a BOOLEAN `alone` -- "did the layer carry any masks"
 * -- and that boolean is standing in for a question with more than two
 * answers. Both tables were measured against exactly two worlds: no mask
 * at all, and ONE add mask on the left half. The deduction that worries
 * the file is:
 *
 *   a plain full-coverage 'difference' reads 0.667 over a left-half base
 *   (it inverts it), so the table calls it "not a no-op, not an erasure"
 *   -- but over a base that already shows EVERYTHING it should come out
 *   EMPTY, and AELL_maskErases answers "" for that row. A silent erasure,
 *   which is the exact shape 0.11.26 was written to stop.
 *
 * and its mirror:
 *
 *   a full-coverage 'add'/'lighten' over masks that HIDE something undoes
 *   them -- every pixel comes back -- and today's receipt says "every
 *   pixel of it still shows", which is true and does not say that the
 *   masks above just stopped working.
 *
 * Neither is measured. This probe varies the thing the old one held
 * fixed: the BASE. Six of them, chosen so that "what the parade shows"
 * and "how many masks it has" come apart --
 *
 *   B0 none        no masks at all             (shows everything)
 *   B1 allAdd      one add mask, the whole box (shows everything, 1 mask)
 *   B2 halfAdd     one add mask, the left half (shows some) -- the
 *                  0.11.26 control; these rows must reproduce M3
 *   B3 offAdd      one add mask, off the layer (shows nothing)
 *   B4 twoHalves   add left + add right        (shows everything, 2 masks)
 *   B5 allMinusL   add all + subtract left     (shows some, 2 masks)
 *
 * against every mode x inverted, at a region worth EVERYTHING (the
 * layer's own box) and a region worth NOTHING (off the layer). B1/B4 vs
 * B0 is the whole question: if they agree, then what the tables need is
 * "what do the masks above SHOW", not "are there any".
 *
 * Same instrument as scripts/mask-erase-probe.jsx, for the same reason:
 * comp.saveFrameToPng writes no file on AE 26.3x87, so the layer's own
 * alpha is read through sampleImage(postEffect) on a slider expression.
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

  /* Seven points, not the erase probe's nine: no feather is set anywhere
   * in here, so the two edge-band points it needed buy nothing, and this
   * probe takes 168 readings where that one took ~60. Left and right ARE
   * kept -- half the bases are one-sided. */
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
    slider.expression = 'thisComp.layer("MA solid").sampleImage([' + x +
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

  function addMaskRaw(x, y, w, h, mode, inverted, name) {
    var mp = layer.property("ADBE Mask Parade");
    var m = mp.addProperty("ADBE Mask Atom");
    if (name) m.name = name;
    var s = new Shape();
    s.closed = true;
    s.vertices = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    m.property("ADBE Mask Shape").setValue(s);
    if (mode) m.maskMode = mode;
    if (inverted) m.inverted = true;
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

  /* The region worth NOTHING: clear of the layer on both axes, the same
   * place mask-erase-probe.jsx put its M5 masks. */
  var OFF = { x: LW + 100, y: LH + 100, w: 100, h: 100 };

  function buildBase(tag) {
    clearMasks();
    if (tag === "none") return;
    if (tag === "allAdd") {
      addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "base");
      return;
    }
    if (tag === "halfAdd") {
      addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "base");
      return;
    }
    if (tag === "offAdd") {
      addMaskRaw(OFF.x, OFF.y, OFF.w, OFF.h, MaskMode.ADD, false, "base");
      return;
    }
    if (tag === "twoHalves") {
      addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, "baseL");
      addMaskRaw(LW / 2, 0, LW / 2, LH, MaskMode.ADD, false, "baseR");
      return;
    }
    if (tag === "allMinusL") {
      addMaskRaw(0, 0, LW, LH, MaskMode.ADD, false, "baseAll");
      addMaskRaw(0, 0, LW / 2, LH, MaskMode.SUBTRACT, false, "baseCut");
      return;
    }
  }

  var BASES = ["none", "allAdd", "halfAdd", "offAdd", "twoHalves",
               "allMinusL"];

  /* NO app.beginUndoGroup anywhere in here -- see verb-semantics-probe.jsx
   * for the modal a nested group leaves behind for the SESSION. */
  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Mask Above Probe", 640, 480, 1, 2,
                                     30);
    layer = comp.layers.addSolid([0.9, 0.15, 0.1], "MA solid", LW, LH, 1);
    madeSources.push(layer.source);
    ctrl = comp.layers.addNull();
    ctrl.name = "MA probe";
    var fx = ctrl.property("ADBE Effect Parade")
                 .addProperty("ADBE Slider Control");
    slider = fx.property("ADBE Slider Control-0001");

    /* ---- A0: what each base shows on its own ------------------------ */
    stage = "A0 bases";
    var baseRead = {};
    for (var b = 0; b < BASES.length; b++) {
      buildBase(BASES[b]);
      var v0 = readLayer();
      baseRead[BASES[b]] = v0;
      record({ id: "0-base", base: BASES[b], max: v0.max, min: v0.min,
               mean: v0.mean, points: v0.points });
    }

    /* ---- A1: every mode x inverted x region, over every base -------- */
    stage = "A1 second mask over each base";
    var REGIONS = [
      { tag: "all", x: 0, y: 0, w: LW, h: LH },
      { tag: "none", x: OFF.x, y: OFF.y, w: OFF.w, h: OFF.h }
    ];
    for (var bi = 0; bi < BASES.length; bi++) {
      for (var ri = 0; ri < REGIONS.length; ri++) {
        for (var mi = 0; mi < MODES.length; mi++) {
          for (var inv = 0; inv < 2; inv++) {
            buildBase(BASES[bi]);
            var R = REGIONS[ri];
            addMaskRaw(R.x, R.y, R.w, R.h, MODES[mi].mode, !!inv, "second");
            var v = readLayer();
            var bs = baseRead[BASES[bi]];
            record({ id: "1-over", base: BASES[bi], region: R.tag,
                     mode: MODES[mi].name, inverted: !!inv,
                     max: v.max, min: v.min, mean: v.mean,
                     baseMean: bs.mean,
                     sameAsBase: (v.mean === bs.mean && v.max === bs.max &&
                                  v.min === bs.min),
                     points: v.points });
          }
        }
      }
    }

    /* ---- A2: what the SHIPPED tool answers today over each base -----
     * The two rows the file names, plus the neighbours that share their
     * branch, so the receipts can be read next to the alpha above. */
    stage = "A2 receipts";
    var cases = [
      { tag: "difference-all",
        args: { mode: "difference", bounds: [0, 0, LW, LH] } },
      { tag: "add-all", args: { mode: "add", bounds: [0, 0, LW, LH] } },
      { tag: "lighten-all", args: { mode: "lighten", bounds: [0, 0, LW, LH] } },
      { tag: "subtract-all",
        args: { mode: "subtract", bounds: [0, 0, LW, LH] } },
      { tag: "intersect-all",
        args: { mode: "intersect", bounds: [0, 0, LW, LH] } },
      { tag: "darken-all", args: { mode: "darken", bounds: [0, 0, LW, LH] } },
      { tag: "subtract-inv-all",
        args: { mode: "subtract", inverted: true, bounds: [0, 0, LW, LH] } }
    ];
    for (var bj = 0; bj < BASES.length; bj++) {
      for (var c = 0; c < cases.length; c++) {
        buildBase(BASES[bj]);
        var a = cases[c].args;
        var argsFull = { comp: comp.name, layer: layer.name };
        for (var key in a) if (a.hasOwnProperty(key)) argsFull[key] = a[key];
        var res = null;
        try { res = call("add_mask", argsFull); }
        catch (eCall) { res = { threw: say(eCall) }; }
        var after = readLayer();
        record({ id: "2-receipt", base: BASES[bj], tag: cases[c].tag,
                 raw: AELLJSON.stringify(res),
                 max: after.max, min: after.min, mean: after.mean,
                 baseMean: baseRead[BASES[bj]].mean });
      }
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
