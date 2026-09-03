/*
 * mask-parade-ellipse-probe.jsx -- can the parade READER carry an ellipse?
 *
 * Filed by the 0.11.34 pass as its top open item. AELL_maskRect answers
 * for axis-aligned RECTANGLES only, so one ellipse anywhere in a layer's
 * mask parade makes AELL_paradeShows return "" -- and with it every
 * sentence add_mask, set_mask and delete_mask build on that reading goes
 * quiet. The narrowness is deliberate (a false claim about pixels costs
 * more than the sentence is worth), but an ellipse is EXACT algebra, not
 * a degree the way a feather is, so it can be carried.
 *
 * The reader's exactness argument is what this has to protect. It cuts
 * the layer box into cells on the mask EDGES and decides each cell from
 * one point, which works because a rectangle's coverage is constant
 * inside every cell. An ellipse's is not: it SPLITS a cell. So the plan
 * under test is per cell, per ellipse -- cell entirely inside it, cell
 * entirely outside it, or split, in which case BOTH readings vote.
 *
 * What this measures, against the real rasteriser:
 *   1. the true picture (all / some / none) for 16 parades that each
 *      contain an ellipse, by layer alpha through sampleImage;
 *   2. what the SHIPPED AELL_paradeShows answers for each (expected: ""
 *      on every row with a compositing ellipse -- that is the defect);
 *   3. the rows a fix must NOT start answering: two ellipses, a feather,
 *      a part opacity.
 *
 * Same instrument as scripts/mask-ellipse-probe.jsx -- comp.saveFrameToPng
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

  function r3(n) { return Math.round(n * 1000) / 1000; }

  var comp = null, layer = null, ctrl = null, slider = null;
  var madeSources = [];
  var LW = 400, LH = 300;

  /* Nine points an ellipse and its bounding rectangle cannot read the
   * same: the four corners are inside the layer box and outside the
   * inscribed ellipse, the four edge midpoints are inside both. */
  var POINTS = [
    { tag: "centre", fx: 0.50, fy: 0.50 },
    { tag: "cTL",    fx: 0.03, fy: 0.03 },
    { tag: "cTR",    fx: 0.97, fy: 0.03 },
    { tag: "cBL",    fx: 0.03, fy: 0.97 },
    { tag: "cBR",    fx: 0.97, fy: 0.97 },
    { tag: "midT",   fx: 0.50, fy: 0.03 },
    { tag: "midB",   fx: 0.50, fy: 0.97 },
    { tag: "midL",   fx: 0.03, fy: 0.50 },
    { tag: "midR",   fx: 0.97, fy: 0.50 }
  ];

  function alphaAt(x, y) {
    slider.expression = 'thisComp.layer("MPE solid").sampleImage([' + x +
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

  /* The AREA a parade leaves showing, as a fraction, on a 21x15 grid
   * inset half a cell from the layer's edges. Denser than the 11x9 the
   * first ellipse probe used because the question here is "all / some /
   * none" and a coarse grid can miss a thin band that is the whole
   * difference between 'all' and 'some'. 315 reads a row, so the row
   * count is what keeps this inside the deadline. */
  function areaShowing() {
    var cols = 21, rows = 15, hit = 0, i, j;
    for (i = 0; i < cols; i++) {
      for (j = 0; j < rows; j++) {
        var x = r3((i + 0.5) / cols * LW), y = r3((j + 0.5) / rows * LH);
        if (alphaAt(x, y) > 0.5) hit++;
      }
    }
    return r3(hit / (cols * rows));
  }

  function clearMasks() {
    var mp = layer.property("ADBE Mask Parade");
    while (mp.numProperties > 0) mp.property(1).remove();
  }

  /* Built EXACTLY as add_mask builds them -- same vertices, same 0.5523
   * handle length -- so what this measures is what the shipped tool
   * creates, not a second spelling of an ellipse. */
  function addMaskRaw(spec) {
    var mp = layer.property("ADBE Mask Parade");
    var m = mp.addProperty("ADBE Mask Atom");
    if (spec.name) m.name = spec.name;
    var b = spec.bounds || [0, 0, LW, LH];
    var x = b[0], y = b[1], w = b[2], h = b[3];
    var s = new Shape();
    s.closed = true;
    if (spec.shape === "ellipse") {
      var cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
      var kx = rx * 0.5523, ky = ry * 0.5523;
      s.vertices = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
      s.inTangents  = [[-kx, 0], [0, -ky], [kx, 0], [0, ky]];
      s.outTangents = [[kx, 0], [0, ky], [-kx, 0], [0, -ky]];
    } else {
      s.vertices = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    }
    m.property("ADBE Mask Shape").setValue(s);
    m.maskMode = MaskMode[String(spec.mode || "add").toUpperCase()];
    if (spec.inverted) m.inverted = true;
    if (typeof spec.opacity === "number") {
      m.property("ADBE Mask Opacity").setValue(spec.opacity);
    }
    if (typeof spec.feather === "number") {
      m.property("ADBE Mask Feather").setValue([spec.feather, spec.feather]);
    }
    return m;
  }

  var HALF = [0, 0, LW / 2, LH];
  var FULL = [0, 0, LW, LH];
  var OFF = [LW + 100, LH + 100, 50, 50];

  /* Every row carries what the plan under test PREDICTS, so the report
   * can print agree/disagree instead of leaving the reading to a human.
   * "" means the reader must stay silent on that row. */
  var ROWS = [
    { id: "E1", want: "some", why: "a lone full-coverage ellipse add keeps " +
      "the middle and drops the four corners",
      specs: [{ shape: "ellipse", mode: "add", bounds: FULL }] },
    { id: "E2", want: "some", why: "its subtract twin -- the corners are " +
      "all that is left",
      specs: [{ shape: "ellipse", mode: "subtract", bounds: FULL }] },
    { id: "E3", want: "some", why: "inverted, the same four corners",
      specs: [{ shape: "ellipse", mode: "add", bounds: FULL,
                inverted: true }] },
    { id: "E4", want: "all", why: "a rect add over the whole layer UNION " +
      "an ellipse add -- both branches of every split cell show",
      specs: [{ shape: "rectangle", mode: "add", bounds: FULL },
              { shape: "ellipse", mode: "add", bounds: FULL }] },
    { id: "E5", want: "none", why: "an ellipse add then a full-coverage " +
      "rect subtract -- both branches of every split cell are gone",
      specs: [{ shape: "ellipse", mode: "add", bounds: FULL },
              { shape: "rectangle", mode: "subtract", bounds: FULL }] },
    { id: "E6", want: "some", why: "an ellipse add over the left-half add",
      specs: [{ shape: "rectangle", mode: "add", bounds: HALF },
              { shape: "ellipse", mode: "add", bounds: FULL }] },
    { id: "E7", want: "some", why: "a left-half rect subtract under an " +
      "ellipse add",
      specs: [{ shape: "ellipse", mode: "add", bounds: FULL },
              { shape: "rectangle", mode: "subtract", bounds: HALF }] },
    { id: "E8", want: "some", why: "an ellipse INTERSECT over a full add",
      specs: [{ shape: "rectangle", mode: "add", bounds: FULL },
              { shape: "ellipse", mode: "intersect", bounds: FULL }] },
    { id: "E9", want: "all", why: "an OFF-LAYER ellipse subtract takes " +
      "nothing from a full add",
      specs: [{ shape: "rectangle", mode: "add", bounds: FULL },
              { shape: "ellipse", mode: "subtract", bounds: OFF }] },
    { id: "E10", want: "none", why: "an off-layer ellipse ADD keeps nothing",
      specs: [{ shape: "ellipse", mode: "add", bounds: OFF }] },
    { id: "E11", want: "some", why: "an ellipse inscribed in the LEFT HALF",
      specs: [{ shape: "ellipse", mode: "add", bounds: HALF }] },
    { id: "E12", want: "some", why: "a lone ellipse 'difference'",
      specs: [{ shape: "ellipse", mode: "difference", bounds: FULL }] },
    { id: "E13", want: "none", why: "an ellipse at opacity 0 -- the " +
      "opacity rule answers without reading the shape at all",
      specs: [{ shape: "ellipse", mode: "add", bounds: FULL, opacity: 0 }] },
    { id: "E14", want: "some", why: "a 'none'-mode ellipse is a path " +
      "CARRIER and never composites -- the half add decides it",
      specs: [{ shape: "rectangle", mode: "add", bounds: HALF },
              { shape: "ellipse", mode: "none", bounds: FULL }] },
    /* The three rows a fix must NOT start answering. */
    { id: "X1", want: "", why: "TWO ellipses -- one ellipse is exact, two " +
      "would need the reader to prove a cell can be inside both",
      specs: [{ shape: "ellipse", mode: "add", bounds: FULL },
              { shape: "ellipse", mode: "subtract", bounds: HALF }] },
    { id: "X2", want: "", why: "a FEATHERED ellipse hides by degrees",
      specs: [{ shape: "ellipse", mode: "add", bounds: FULL, feather: 40 }] },
    { id: "X3", want: "", why: "a PART-opacity ellipse fades, and all / " +
      "some / none cannot say a degree",
      specs: [{ shape: "ellipse", mode: "add", bounds: FULL, opacity: 50 }] }
  ];

  /* NO app.beginUndoGroup anywhere in here -- see verb-semantics-probe.jsx
   * for the modal a nested group leaves behind for the SESSION. */
  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Parade Ellipse Probe", 640, 480, 1,
                                     2, 30);
    layer = comp.layers.addSolid([0.1, 0.5, 0.95], "MPE solid", LW, LH, 1);
    madeSources.push(layer.source);
    ctrl = comp.layers.addNull();
    ctrl.name = "MPE probe";
    var fx = ctrl.property("ADBE Effect Parade")
                 .addProperty("ADBE Slider Control");
    slider = fx.property("ADBE Slider Control-0001");

    /* ---- A0: the instrument. A bare layer must read area 1.0 and the
     * inscribed ellipse pi/4 = 0.785; if the grid cannot say that,
     * nothing below it means anything. --------------------------------- */
    stage = "A0 calibration";
    clearMasks();
    record({ id: "0-bare", area: areaShowing(), read: readLayer() });
    clearMasks();
    addMaskRaw({ shape: "ellipse", mode: "add", bounds: FULL });
    record({ id: "0-calib", shape: "ellipse", area: areaShowing(),
             note: "pi/4 = 0.785" });

    /* ---- A1: every row's TRUE picture next to what the shipped reader
     * answers for it. ------------------------------------------------- */
    stage = "A1 rows";
    for (var i = 0; i < ROWS.length; i++) {
      clearMasks();
      var row = ROWS[i];
      for (var j = 0; j < row.specs.length; j++) addMaskRaw(row.specs[j]);
      var box = AELL_layerBox(layer, comp.time);
      var shipped = "";
      try {
        shipped = AELL_paradeShows(layer.property("ADBE Mask Parade"), box);
      } catch (eS) { shipped = "THREW: " + say(eS); }
      var v = readLayer();
      var area = areaShowing();
      /* The truth label, from the picture and nothing else. A grid that
       * is entirely on or entirely off AND nine points that agree is
       * "all" / "none"; anything between is "some". */
      var truth = "some";
      if (area === 1 && v.min === 1) truth = "all";
      else if (area === 0 && v.max === 0) truth = "none";
      record({ id: "1-row", row: row.id, want: row.want, why: row.why,
               shipped: shipped, truth: truth, area: area, mean: v.mean,
               min: v.min, max: v.max, points: v.points,
               specs: AELLJSON.stringify(row.specs) });
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
