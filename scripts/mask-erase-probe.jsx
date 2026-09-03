/*
 * mask-erase-probe.jsx -- measure WHICH full-coverage masks actually erase
 * a layer in real After Effects, before add_mask is taught to say so.
 *
 * Filed by the 0.11.24/0.11.25 passes as the next item:
 *   add_mask {bounds: [0,0,1920,1080], mode: 'subtract', feather: 100}
 * on a 1920x1080 BG hides the WHOLE layer and answers a bare ok. The
 * tool's coversAll branch is deliberately one-sided and its comment says
 * why: "'subtract', 'intersect' and inverted:true all cut something away
 * at full coverage". That sentence is the assumption under test. "Cuts
 * something away" and "cuts EVERYTHING away" are not the same receipt,
 * and which combinations do which is an AE fact, not a deduction:
 *
 *   M1  every mode x inverted, as the ONLY mask, at exactly the layer's
 *       box: how much of the layer still renders?
 *   M2  does a FEATHER leave a visible band -- i.e. is "hides the whole
 *       layer" a true sentence for the call that was actually filed?
 *   M3  the same combinations added SECOND, over an existing add mask on
 *       the left half: which ones erase regardless of what is above them
 *       and which only erase when they are alone
 *   M4  the receipts the shipped tool gives today for the filed call and
 *       its neighbours
 *
 * THE INSTRUMENT. The obvious one does not work: comp.saveFrameToPng
 * exists on AE 26.3x87, throws nothing, and WRITES NO FILE -- measured
 * both with the comp open in a viewer and without (f.exists false,
 * f.length -1 every time). A byte compare against a file that was never
 * written calls every case identical, which is exactly the silent-success
 * shape this whole item is about, so it is recorded here rather than
 * quietly worked around. What does work is sampleImage through an
 * expression: a slider on a null reads
 *   thisComp.layer(L).sampleImage(pt, [0.5,0.5], true, time)[3]
 * and postEffect:true means the alpha comes back AFTER the masks. That
 * measures the layer itself rather than the composite, which is the
 * question being asked, and it gives a NUMBER per point instead of a
 * yes/no, so a feathered edge is visible as the fraction it really is.
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

  function r3(n) { return Math.round(n * 1000) / 1000; }

  var comp = null, layer = null, ctrl = null, slider = null;
  var madeSources = [];
  var LW = 400, LH = 300;

  /* Where the layer is sampled. Fractions of the layer's own box: the
   * middle, the four quadrant centres, and four points close to the
   * edges -- a feather reaches the edges well before the middle. */
  var POINTS = [
    { tag: "centre", fx: 0.5,  fy: 0.5  },
    { tag: "q1",     fx: 0.25, fy: 0.25 },
    { tag: "q2",     fx: 0.75, fy: 0.25 },
    { tag: "q3",     fx: 0.25, fy: 0.75 },
    { tag: "q4",     fx: 0.75, fy: 0.75 },
    { tag: "nearL",  fx: 0.02, fy: 0.5  },
    { tag: "nearR",  fx: 0.98, fy: 0.5  },
    { tag: "nearT",  fx: 0.5,  fy: 0.02 },
    { tag: "nearB",  fx: 0.5,  fy: 0.98 }
  ];

  function alphaAt(x, y) {
    slider.expression = 'thisComp.layer("MP solid").sampleImage([' + x +
      ', ' + y + '], [0.5, 0.5], true, time)[3];';
    return slider.value;
  }

  /* One reading of the whole layer: every sample point, plus the max and
   * the mean, which is what "erased" and "untouched" are decided on. */
  function readLayer() {
    var vals = [], sum = 0, max = 0, min = 1, i;
    for (i = 0; i < POINTS.length; i++) {
      var a = alphaAt(r3(POINTS[i].fx * LW), r3(POINTS[i].fy * LH));
      a = r3(a);
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

  /* A mask over the given LAYER-space box. Raw AE, not the tool: the
   * point is to measure AE, and the tool is measured separately in M4. */
  function addMaskRaw(x, y, w, h, mode, inverted, feather, name) {
    var mp = layer.property("ADBE Mask Parade");
    var m = mp.addProperty("ADBE Mask Atom");
    if (name) m.name = name;
    var s = new Shape();
    s.closed = true;
    s.vertices = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    m.property("ADBE Mask Shape").setValue(s);
    if (mode) m.maskMode = mode;
    if (inverted) m.inverted = true;
    if (feather > 0) {
      m.property("ADBE Mask Feather").setValue([feather, feather]);
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

  /* NO app.beginUndoGroup anywhere in here -- see verb-semantics-probe.jsx
   * for the modal a nested group leaves behind for the SESSION. */
  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Mask Probe", 640, 480, 1, 2, 30);
    layer = comp.layers.addSolid([0.9, 0.15, 0.1], "MP solid", LW, LH, 1);
    madeSources.push(layer.source);
    ctrl = comp.layers.addNull();
    ctrl.name = "MP probe";
    var fx = ctrl.property("ADBE Effect Parade")
                 .addProperty("ADBE Slider Control");
    slider = fx.property("ADBE Slider Control-0001");

    var bare = readLayer();
    record({ id: "0-baseline", saveFrameToPngWrites: false,
             layerW: LW, layerH: LH, compW: comp.width, compH: comp.height,
             max: bare.max, min: bare.min, mean: bare.mean,
             points: bare.points });

    /* ---- M1: every mode x inverted, as the ONLY mask, exactly the box */
    stage = "M1 lone masks";
    for (var i = 0; i < MODES.length; i++) {
      for (var inv = 0; inv < 2; inv++) {
        clearMasks();
        addMaskRaw(0, 0, LW, LH, MODES[i].mode, !!inv, 0, "M1");
        var v = readLayer();
        record({ id: "1-lone", mode: MODES[i].name, inverted: !!inv,
                 max: v.max, min: v.min, mean: v.mean, points: v.points });
      }
    }

    /* ---- M2: does a feather leave a visible band? --------------------
     * The filed call carries feather: 100. If a feathered full-coverage
     * subtract still reads alpha 0 everywhere then the warning may say
     * "hides the whole layer" flatly; if not, the word has to be softer,
     * and this is the only way to know which. */
    stage = "M2 feather";
    var FEATHERS = [0, 5, 20, 100];
    var SHAPES = [
      { tag: "subtract", mode: MaskMode.SUBTRACT, inv: false },
      { tag: "add+inverted", mode: MaskMode.ADD, inv: true }
    ];
    for (var si = 0; si < SHAPES.length; si++) {
      for (var fi = 0; fi < FEATHERS.length; fi++) {
        clearMasks();
        addMaskRaw(0, 0, LW, LH, SHAPES[si].mode, SHAPES[si].inv,
                   FEATHERS[fi], "M2");
        var vf = readLayer();
        record({ id: "2-feather", mode: SHAPES[si].tag,
                 feather: FEATHERS[fi], max: vf.max, min: vf.min,
                 mean: vf.mean, points: vf.points });
      }
    }

    /* ---- M3: added SECOND, over an add mask on the left half ---------
     * This is what separates "erases whatever is there" from "erases
     * only because it is alone". A warning that fires on the wrong one
     * is a false alarm on a legitimate multi-mask build. */
    stage = "M3 second mask";
    clearMasks();
    addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, 0, "base");
    var baseRead = readLayer();
    record({ id: "3-base", max: baseRead.max, min: baseRead.min,
             mean: baseRead.mean, points: baseRead.points });
    for (var k = 0; k < MODES.length; k++) {
      for (var inv2 = 0; inv2 < 2; inv2++) {
        clearMasks();
        addMaskRaw(0, 0, LW / 2, LH, MaskMode.ADD, false, 0, "base");
        addMaskRaw(0, 0, LW, LH, MODES[k].mode, !!inv2, 0, "second");
        var s2 = readLayer();
        record({ id: "3-second", mode: MODES[k].name, inverted: !!inv2,
                 max: s2.max, min: s2.min, mean: s2.mean,
                 sameAsBase: (s2.mean === baseRead.mean &&
                              s2.max === baseRead.max),
                 points: s2.points });
      }
    }

    /* ---- M5: a lone mask that MISSES the layer entirely ---------------
     * add_mask's other refusal says a mask which misses "would hide the
     * whole layer". That is the same additive assumption M1 just broke,
     * one refusal over: a subtract region the layer never touches ought
     * to subtract nothing. The refusal is right either way (comp
     * coordinates on a layer-space argument) but its REASON is a
     * sentence, and a sentence can be false. */
    stage = "M5 mask misses the layer";
    for (var mi = 0; mi < MODES.length; mi++) {
      for (var inv3 = 0; inv3 < 2; inv3++) {
        clearMasks();
        addMaskRaw(LW + 100, LH + 100, 100, 100, MODES[mi].mode, !!inv3,
                   0, "M5");
        var v5 = readLayer();
        record({ id: "5-misses", mode: MODES[mi].name, inverted: !!inv3,
                 max: v5.max, min: v5.min, mean: v5.mean });
      }
    }

    /* ---- M4: what the SHIPPED tool answers today --------------------- */
    stage = "M4 receipts";
    var cases = [
      { tag: "subtract-exact-feather",
        args: { mode: "subtract", feather: 100, bounds: [0, 0, LW, LH] } },
      { tag: "subtract-exact",
        args: { mode: "subtract", bounds: [0, 0, LW, LH] } },
      { tag: "subtract-default-region",
        args: { mode: "subtract" } },
      { tag: "add-inverted-exact",
        args: { mode: "add", inverted: true, bounds: [0, 0, LW, LH] } },
      { tag: "intersect-inverted-exact",
        args: { mode: "intersect", inverted: true, bounds: [0, 0, LW, LH] } },
      { tag: "subtract-inverted-exact",
        args: { mode: "subtract", inverted: true, bounds: [0, 0, LW, LH] } },
      { tag: "subtract-comp-sized",
        args: { mode: "subtract", bounds: [0, 0, comp.width, comp.height] } },
      { tag: "subtract-half",
        args: { mode: "subtract", bounds: [0, 0, LW, LH / 2] } },
      { tag: "add-exact-default", args: {} },
      { tag: "custom-corners-subtract",
        args: { shape: "custom", mode: "subtract",
                vertices: [[0, 0], [LW, 0], [LW, LH], [0, LH]] } }
    ];
    for (var c = 0; c < cases.length; c++) {
      clearMasks();
      var a = cases[c].args;
      var argsFull = { comp: comp.name, layer: layer.name };
      for (var key in a) if (a.hasOwnProperty(key)) argsFull[key] = a[key];
      var res = null;
      try { res = call("add_mask", argsFull); }
      catch (eCall) { res = { threw: say(eCall) }; }
      var after = readLayer();
      record({ id: "4-receipt", tag: cases[c].tag,
               raw: AELLJSON.stringify(res),
               max: after.max, min: after.min, mean: after.mean });
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
