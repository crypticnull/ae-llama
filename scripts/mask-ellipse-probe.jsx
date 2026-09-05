/*
 * mask-ellipse-probe.jsx -- an ELLIPSE is not its bounding box. Measure
 * by how much, and measure which of add_mask's shipped sentences are
 * false because of it.
 *
 * Filed by the 0.11.28 pass as its top item. `covers` in add_mask comes
 * from AELL_boxOfPoints(shape.vertices), i.e. the BOUNDING BOX of the
 * four points an ellipse is drawn from -- so an ellipse at the tool's own
 * default region is treated as covering every pixel of the layer, which
 * it plainly does not: it leaves the four corners. Three sentences rest
 * on that reading ("hides ALL", "cuts nothing away", "changes nothing"),
 * plus the two coordinate refusals either side of them.
 *
 * The question this has to answer before any of them can be rewritten is
 * "how much does an inscribed ellipse actually leave, and where". Geometry
 * says 1 - pi/4 = 21.5% of the box, in four corner slivers. Geometry is
 * not the risk -- the risk is that AE's mask rasteriser does something
 * else at the boundary, or that the corner slivers behave differently
 * once another mask composites. So: measure.
 *
 * Every ellipse row has its RECTANGLE TWIN at the identical region, which
 * is the whole comparison. If the twins read the same, the bounding-box
 * reading was fine and this item closes as a non-defect.
 *
 * Same instrument as scripts/mask-erase-probe.jsx and
 * scripts/mask-above-probe.jsx, for the same reason: comp.saveFrameToPng
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

  /* The points are chosen so an ellipse and its bounding rectangle cannot
   * read the same. The four CORNERS are inside the layer box and outside
   * the inscribed ellipse (0.03 -> (0.94^2)*2 = 1.77 > 1); the four EDGE
   * midpoints are inside both; the centre is inside both. A rectangle at
   * the same region shows or hides all nine together. */
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
    slider.expression = 'thisComp.layer("ME solid").sampleImage([' + x +
      ', ' + y + '], [0.5, 0.5], true, time)[3];';
    return slider.value;
  }

  function readLayer() {
    var vals = [], sum = 0, max = 0, min = 1, i;
    var corners = 0, mids = 0;
    for (i = 0; i < POINTS.length; i++) {
      var a = r3(alphaAt(r3(POINTS[i].fx * LW), r3(POINTS[i].fy * LH)));
      vals.push(POINTS[i].tag + "=" + a);
      sum += a;
      if (a > max) max = a;
      if (a < min) min = a;
      if (POINTS[i].tag.charAt(0) === "c" && POINTS[i].tag.length === 3) {
        corners += a;
      }
      if (POINTS[i].tag.charAt(0) === "m") mids += a;
    }
    return { points: vals, max: r3(max), min: r3(min),
             mean: r3(sum / POINTS.length),
             corners: r3(corners / 4), mids: r3(mids / 4) };
  }

  /* The AREA a row leaves showing, as a fraction. Sampled on an 11x9 grid
   * inset half a cell from the layer's edges, because the geometric claim
   * a receipt would make ("about a fifth of it") is an AREA claim and nine
   * points cannot support one. 99 reads, so only the rows that a sentence
   * would talk about get it. */
  function areaShowing() {
    var cols = 11, rows = 9, hit = 0, i, j;
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

  /* Rectangle and ellipse built EXACTLY as add_mask builds them (same
   * vertices, same 0.5523 handle length), so a difference between the
   * twins is a difference between the shapes and not between two
   * spellings of one. */
  function addMaskRaw(kind, x, y, w, h, mode, inverted, name) {
    var mp = layer.property("ADBE Mask Parade");
    var m = mp.addProperty("ADBE Mask Atom");
    if (name) m.name = name;
    var s = new Shape();
    s.closed = true;
    if (kind === "ellipse") {
      var cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
      var kx = rx * 0.5523, ky = ry * 0.5523;
      s.vertices = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
      s.inTangents  = [[-kx, 0], [0, -ky], [kx, 0], [0, ky]];
      s.outTangents = [[kx, 0], [0, ky], [-kx, 0], [0, -ky]];
    } else {
      s.vertices = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    }
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

  /* NO app.beginUndoGroup anywhere in here -- see verb-semantics-probe.jsx
   * for the modal a nested group leaves behind for the SESSION. */
  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Mask Ellipse Probe", 640, 480, 1,
                                     2, 30);
    layer = comp.layers.addSolid([0.1, 0.5, 0.95], "ME solid", LW, LH, 1);
    madeSources.push(layer.source);
    ctrl = comp.layers.addNull();
    ctrl.name = "ME probe";
    var fx = ctrl.property("ADBE Effect Parade")
                 .addProperty("ADBE Slider Control");
    slider = fx.property("ADBE Slider Control-0001");

    /* ---- A0: the bare layer, and the area instrument against a shape
     * whose answer is known. A rectangle over the whole layer must read
     * 1.0 and the inscribed ellipse pi/4 = 0.785; if the grid cannot say
     * that, nothing below it means anything. -------------------------- */
    stage = "A0 baseline";
    clearMasks();
    var bare = readLayer();
    record({ id: "0-bare", max: bare.max, min: bare.min, mean: bare.mean,
             corners: bare.corners, mids: bare.mids, points: bare.points,
             area: areaShowing() });

    clearMasks();
    addMaskRaw("rectangle", 0, 0, LW, LH, MaskMode.ADD, false, "calR");
    record({ id: "0-calib", shape: "rectangle", area: areaShowing() });
    clearMasks();
    addMaskRaw("ellipse", 0, 0, LW, LH, MaskMode.ADD, false, "calE");
    record({ id: "0-calib", shape: "ellipse", area: areaShowing() });

    /* ---- A1: every mode x inverted, ellipse AND rectangle, at the
     * layer's own box -- add_mask's default region and the region every
     * one of the three sentences is about. --------------------------- */
    stage = "A1 ellipse vs rectangle at the default region";
    var KINDS = ["ellipse", "rectangle"];
    for (var mi = 0; mi < MODES.length; mi++) {
      for (var inv = 0; inv < 2; inv++) {
        for (var ki = 0; ki < KINDS.length; ki++) {
          clearMasks();
          addMaskRaw(KINDS[ki], 0, 0, LW, LH, MODES[mi].mode, !!inv, "one");
          var v = readLayer();
          record({ id: "1-alone", shape: KINDS[ki], mode: MODES[mi].name,
                   inverted: !!inv, max: v.max, min: v.min, mean: v.mean,
                   corners: v.corners, mids: v.mids, points: v.points });
        }
      }
    }

    /* ---- A2: the AREA the four rows a sentence would talk about leave
     * showing. These are the rows the shipped tool calls "hides ALL",
     * "cuts nothing away" and "changes nothing". ---------------------- */
    stage = "A2 area of the rows a sentence talks about";
    var AREAS = [
      { tag: "subtract", mode: MaskMode.SUBTRACT, inverted: false },
      { tag: "add", mode: MaskMode.ADD, inverted: false },
      { tag: "subtract+inverted", mode: MaskMode.SUBTRACT, inverted: true },
      { tag: "add+inverted", mode: MaskMode.ADD, inverted: true },
      { tag: "difference", mode: MaskMode.DIFFERENCE, inverted: false }
    ];
    for (var ai = 0; ai < AREAS.length; ai++) {
      for (var kj = 0; kj < KINDS.length; kj++) {
        clearMasks();
        addMaskRaw(KINDS[kj], 0, 0, LW, LH, AREAS[ai].mode,
                   AREAS[ai].inverted, "area");
        record({ id: "2-area", shape: KINDS[kj], tag: AREAS[ai].tag,
                 area: areaShowing() });
      }
    }

    /* ---- A3: the same ellipse over a mask that is already hiding
     * something. The `undoes` warning is already blind to the ellipse on
     * purpose; this measures whether the OTHER sentences can be trusted
     * over a parade, i.e. whether a new ellipse rule may fire there at
     * all. Base: one add mask on the left half. -------------------- */
    stage = "A3 ellipse over a half-covering mask";
    var OVER = [
      { tag: "add", mode: MaskMode.ADD, inverted: false },
      { tag: "subtract", mode: MaskMode.SUBTRACT, inverted: false },
      { tag: "difference", mode: MaskMode.DIFFERENCE, inverted: false },
      { tag: "add+inverted", mode: MaskMode.ADD, inverted: true }
    ];
    clearMasks();
    addMaskRaw("rectangle", 0, 0, LW / 2, LH, MaskMode.ADD, false, "base");
    var baseHalf = readLayer();
    record({ id: "3-base", max: baseHalf.max, min: baseHalf.min,
             mean: baseHalf.mean, corners: baseHalf.corners,
             mids: baseHalf.mids, points: baseHalf.points });
    for (var oi = 0; oi < OVER.length; oi++) {
      for (var kk = 0; kk < KINDS.length; kk++) {
        clearMasks();
        addMaskRaw("rectangle", 0, 0, LW / 2, LH, MaskMode.ADD, false, "base");
        addMaskRaw(KINDS[kk], 0, 0, LW, LH, OVER[oi].mode, OVER[oi].inverted,
                   "second");
        var v3 = readLayer();
        record({ id: "3-over", shape: KINDS[kk], tag: OVER[oi].tag,
                 max: v3.max, min: v3.min, mean: v3.mean,
                 corners: v3.corners, mids: v3.mids,
                 baseMean: baseHalf.mean,
                 sameAsBase: (v3.mean === baseHalf.mean &&
                              v3.max === baseHalf.max &&
                              v3.min === baseHalf.min),
                 points: v3.points });
      }
    }

    /* ---- A4: what the SHIPPED tool says today, ellipse next to
     * rectangle, for the five calls the three sentences fire on. The
     * receipts are the defect; the alpha beside them is the truth. --- */
    stage = "A4 receipts";
    var cases = [
      { tag: "default subtract", args: { mode: "subtract" } },
      { tag: "bounds subtract",
        args: { mode: "subtract", bounds: [0, 0, LW, LH] } },
      { tag: "bounds add", args: { bounds: [0, 0, LW, LH] } },
      { tag: "bounds subtract+inv",
        args: { mode: "subtract", inverted: true, bounds: [0, 0, LW, LH] } },
      { tag: "bounds add+inv",
        args: { inverted: true, bounds: [0, 0, LW, LH] } },
      /* The comp-coordinates REFUSAL, whose reason names coverage too. */
      { tag: "comp-sized subtract",
        args: { mode: "subtract", bounds: [0, 0, 1920, 1080] } },
      { tag: "comp-sized add", args: { bounds: [0, 0, 1920, 1080] } }
    ];
    for (var ci = 0; ci < cases.length; ci++) {
      for (var km = 0; km < KINDS.length; km++) {
        clearMasks();
        var a = cases[ci].args;
        var argsFull = { comp: comp.name, layer: layer.name,
                         shape: KINDS[km] };
        for (var key in a) if (a.hasOwnProperty(key)) argsFull[key] = a[key];
        var res = null;
        try { res = call("add_mask", argsFull); }
        catch (eCall) { res = { threw: say(eCall) }; }
        var after = readLayer();
        record({ id: "4-receipt", shape: KINDS[km], tag: cases[ci].tag,
                 raw: AELLJSON.stringify(res), max: after.max, min: after.min,
                 mean: after.mean, corners: after.corners, mids: after.mids });
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
