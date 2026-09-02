/*
 * layer-size-probe.jsx -- measure what a LAYER's own size is, per layer
 * type, in real After Effects. WORKPLAN section 8, filed finding #1.
 *
 * add_mask's doc tells the model to take sizes "from get_comp_details",
 * and get_comp_details reports only the COMP's width/height -- so four
 * phrasings of "hide half of Beta" all masked a 100x100 layer with the
 * comp's 1920x1080. Before layer rows can carry a size, this measures
 * which property actually HAS one, per layer type, and where a layer's
 * coordinate origin sits (a text layer's is its baseline, not 0,0 --
 * assumed here, measured below).
 *
 * Driven by a generated wrapper that sets:
 *   $.global.AELL_PROBE_REPO  repo root, forward slashes
 *   $.global.AELL_PROBE_OUT   results JSON path, forward slashes
 *
 * Flushed to disk after every measurement, same as verb-semantics-probe.
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
      f.write('{"crashed":"' + String(msg).replace(/["\\r\n]/g, " ") + '"}');
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

  var comp = null, inner = null;
  var madeSources = [];

  /* Read every candidate "how big is this layer" channel without letting
   * any one of them stop the run. A property that THROWS and a property
   * that quietly answers the comp's size are different bugs and the
   * fix has to tell them apart. */
  function probeLayer(id, layer) {
    var m = { id: id, name: layer.name, type: AELL_layerType(layer) };
    try { m.width = layer.width; } catch (e1) { m.width = "THREW: " + say(e1); }
    try { m.height = layer.height; } catch (e2) { m.height = "THREW: " + say(e2); }
    try { m.hasSource = !!layer.source; } catch (e3) { m.hasSource = "THREW: " + say(e3); }
    try {
      m.sourceWidth = layer.source ? layer.source.width : null;
      m.sourceHeight = layer.source ? layer.source.height : null;
    } catch (e4) { m.sourceWidth = "THREW: " + say(e4); }
    try {
      var r = layer.sourceRectAtTime(0, false);
      m.rect = { top: r.top, left: r.left, width: r.width, height: r.height };
    } catch (e5) { m.rect = "THREW: " + say(e5); }
    try {
      m.maskParade = !!layer.property("ADBE Mask Parade");
    } catch (e6) { m.maskParade = "THREW: " + say(e6); }
    try {
      var a = layer.property("ADBE Transform Group").property("ADBE Anchor Point").value;
      m.anchor = [a[0], a[1]];
    } catch (e7) { m.anchor = "THREW: " + say(e7); }
    record(m);
    return m;
  }

  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Size Probe", 1920, 1080, 1, 5, 25);
    inner = app.project.items.addComp("AELL Size Inner", 640, 360, 1, 5, 25);

    stage = "L1 solid";
    var sol = comp.layers.addSolid([0.4, 0.5, 0.6], "SP Solid", 100, 100, 1);
    madeSources.push(sol.source);
    probeLayer("1-solid", sol);

    stage = "L2 text";
    var txt = comp.layers.addText("HELLO");
    probeLayer("2-text", txt);

    stage = "L3 shape";
    var shp = comp.layers.addShape();
    shp.name = "SP Shape";
    /* An EMPTY shape layer and one with real contents are different
     * questions: sourceRectAtTime on an empty one has nothing to bound. */
    probeLayer("3-shape-empty", shp);
    var grp = shp.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
    var rect = grp.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect");
    rect.property("ADBE Vector Rect Size").setValue([200, 120]);
    probeLayer("3b-shape-filled", shp);

    stage = "L4 precomp";
    var pre = comp.layers.add(inner);
    probeLayer("4-precomp", pre);

    stage = "L5 null";
    var nul = comp.layers.addNull();
    madeSources.push(nul.source);
    probeLayer("5-null", nul);

    stage = "L6 camera";
    var cam = comp.layers.addCamera("SP Cam", [960, 540]);
    probeLayer("6-camera", cam);

    stage = "L7 light";
    var lit = comp.layers.addLight("SP Light", [960, 540]);
    probeLayer("7-light", lit);

    stage = "L8 adjustment";
    var adj = comp.layers.addSolid([1, 1, 1], "SP Adjust", 1920, 1080, 1);
    madeSources.push(adj.source);
    adj.adjustmentLayer = true;
    probeLayer("8-adjustment", adj);

    /* ---- M9: does a mask drawn at [0,0,w,h] cover the layer? --------
     * The whole point of the fix. Draw the "top half" rectangle the doc
     * describes on the 100x100 solid, then read the mask path back and
     * compare it with the layer's own box. A mask does not report
     * "covers nothing", so the geometry is the only evidence. */
    stage = "M9 mask in layer space";
    var m9 = { id: "9-mask-space" };
    var mk = sol.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
    mk.name = "SP Half";
    var sh = new Shape();
    sh.closed = true;
    sh.vertices = [[0, 0], [100, 0], [100, 50], [0, 50]];
    mk.property("ADBE Mask Shape").setValue(sh);
    var back = mk.property("ADBE Mask Shape").value;
    m9.verticesBack = back.vertices;
    /* And the sentence as the model actually answered it: the comp's
     * dimensions, halved, on a 100x100 layer. */
    var mk2 = sol.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
    mk2.name = "SP CompSized";
    var sh2 = new Shape();
    sh2.closed = true;
    sh2.vertices = [[0, 540], [1920, 540], [1920, 1080], [0, 1080]];
    m9.compSizedThrew = "";
    try { mk2.property("ADBE Mask Shape").setValue(sh2); }
    catch (e9) { m9.compSizedThrew = say(e9); }
    m9.compSizedAccepted = !m9.compSizedThrew;
    record(m9);

    stage = "M10 add_mask tool, as the model called it";
    var r = $.global.AELL_call("add_mask", AELLJSON.stringify({
      comp: comp.name, layer: "SP Solid", shape: "rectangle",
      bounds: [0, 540, 1920.00012207031, 540], name: "SP Model"
    }));
    record({ id: "10-add_mask-comp-bounds", reply: AELLJSON.parse(r) });

    stage = "M11 get_comp_details layer rows, as they ship today";
    var r2 = AELLJSON.parse($.global.AELL_call("get_comp_details",
      AELLJSON.stringify({ comp: comp.name })));
    record({ id: "11-comp-details",
             compWidth: r2.ok ? r2.data.width : null,
             compHeight: r2.ok ? r2.data.height : null,
             firstRow: (r2.ok && r2.data.layers.length) ? r2.data.layers[0] : null,
             rowKeys: (r2.ok && r2.data.layers.length)
               ? (function () { var k = []; for (var q in r2.data.layers[0]) k.push(q); return k; })()
               : [] });

    stage = "done";
  } catch (err) {
    record({ id: "CRASH", stage: stage, message: say(err),
             line: (err && err.line) ? err.line : 0 });
  }

  try {
    if (comp) comp.remove();
    if (inner) inner.remove();
    for (var s = 0; s < madeSources.length; s++) {
      try { madeSources[s].remove(); } catch (eS) {}
    }
    stage = stage + " + cleaned";
  } catch (eC) {
    stage = stage + " + CLEANUP FAILED: " + say(eC);
  }
  flush();
})();
