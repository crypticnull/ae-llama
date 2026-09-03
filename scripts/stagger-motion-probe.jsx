/*
 * stagger-motion-probe.jsx -- measure what "this layer does not animate"
 * actually costs and actually means in real After Effects, before
 * stagger_layers is taught to say it.
 *
 * WORKPLAN item 8, row 32: three of four phrasings called stagger_layers
 * ALONE on layers with no keyframes. It moved six start times, answered
 * ok {layers:6, spread:2.5, placed:[...]}, and nothing fades -- a success
 * receipt for a comp where nothing animates.
 *
 * The candidate check is "no keyframe anywhere, no time-varying
 * expression, and a source that does not move by itself". Each of those
 * three clauses is a guess about AE until it is measured:
 *   M1  what a layer's ROOT property list holds (is Marker in it? a
 *       marker is numKeys > 0 and is not animation)
 *   M2  the walk's node cost on the shapes that matter (bare solid, solid
 *       + effects, text, shape, camera, light) -- the budget has to be
 *       big enough to reach the truth and small enough to stay cheap
 *   M3  what a STILL source reports vs a precomp and a video: does
 *       source.duration separate them
 *   M4  the walk's verdict on each fixture, incl. one keyed layer, one
 *       expression-only layer, one marker-only layer
 *   M5  the real tool on the real failure: stagger_layers on six bare
 *       solids -- the receipt as it stands today
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

  /* The CANDIDATE walk, written here first so the probe measures the
   * thing that will ship rather than a paraphrase of it. Counts every
   * node it touches so M2 can price it. */
  function probeWalk(grp, budget, depth, found) {
    var i, p, n = 0, mn = "";
    try { n = grp.numProperties; } catch (eN) { return false; }
    for (i = 1; i <= n; i++) {
      if (budget.left <= 0) { budget.exhausted = true; return false; }
      budget.left--;
      budget.visited++;
      p = null;
      try { p = grp.property(i); } catch (eP) { continue; }
      if (!p) continue;
      mn = "";
      try { mn = String(p.matchName); } catch (eM) { mn = ""; }
      if (mn === "ADBE Marker") continue;
      var isLeaf = false;
      try { isLeaf = (p.propertyType === PropertyType.PROPERTY); }
      catch (eT) { isLeaf = false; }
      if (isLeaf) {
        try {
          if (p.numKeys > 0) { found.why = "keys:" + mn; return true; }
        } catch (eK) {}
        try {
          if (p.expressionEnabled && p.expression) {
            found.expr = String(p.expression);
            found.exprOn = mn;
          }
        } catch (eE) {}
        continue;
      }
      if (depth < 8 && probeWalk(p, budget, depth + 1, found)) return true;
    }
    return false;
  }

  function verdict(layer, cap) {
    var budget = { left: cap, visited: 0, exhausted: false };
    var found = { why: "", expr: "", exprOn: "" };
    var keyed = probeWalk(layer, budget, 0, found);
    return { keyed: keyed, why: found.why, expr: found.expr,
             exprOn: found.exprOn, visited: budget.visited,
             exhausted: budget.exhausted };
  }

  var comp = null;
  var madeSources = [];
  var sub = null;

  /* NO app.beginUndoGroup anywhere in here -- see verb-semantics-probe.jsx
   * for the modal that a nested group leaves behind for the SESSION. */
  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Stagger Probe", 320, 240, 1, 6, 30);
    sub = app.project.items.addComp("AELL Stagger Sub", 320, 240, 1, 4, 30);

    var bare = comp.layers.addSolid([0.4, 0.5, 0.6], "SP bare", 100, 100, 1);
    madeSources.push(bare.source);
    var fxL = comp.layers.addSolid([0.4, 0.5, 0.6], "SP fx", 100, 100, 1);
    madeSources.push(fxL.source);
    var keyL = comp.layers.addSolid([0.4, 0.5, 0.6], "SP keyed", 100, 100, 1);
    madeSources.push(keyL.source);
    var exprL = comp.layers.addSolid([0.4, 0.5, 0.6], "SP expr", 100, 100, 1);
    madeSources.push(exprL.source);
    var statL = comp.layers.addSolid([0.4, 0.5, 0.6], "SP static", 100, 100, 1);
    madeSources.push(statL.source);
    var markL = comp.layers.addSolid([0.4, 0.5, 0.6], "SP marker", 100, 100, 1);
    madeSources.push(markL.source);
    var txt = comp.layers.addText("SP text");
    var shp = comp.layers.addShape();
    shp.name = "SP shape";
    var cam = comp.layers.addCamera("SP cam", [160, 120]);
    var lit = comp.layers.addLight("SP light", [160, 120]);
    var pre = comp.layers.add(sub);
    pre.name = "SP precomp";

    // three effects, the kind a real comp carries
    var parade = fxL.property("ADBE Effect Parade");
    try { parade.addProperty("Drop Shadow"); } catch (e1) {}
    try { parade.addProperty("Fast Box Blur"); } catch (e2) {}
    try { parade.addProperty("Levels"); } catch (e3) {}

    // one keyed layer (opacity), deep-ish: an effect param, not transform
    var kp = keyL.property("ADBE Effect Parade").addProperty("Gaussian Blur");
    var kb = kp.property(1);
    kb.setValueAtTime(0, 0);
    kb.setValueAtTime(1, 20);

    // one expression that VARIES with time, one that does not
    exprL.property("ADBE Transform Group").property("ADBE Opacity")
      .expression = "wiggle(2, 30)";
    statL.property("ADBE Transform Group").property("ADBE Position")
      .expression = "[value[0] + index * 10, value[1]]";

    // one layer whose only "keys" are markers
    var mk = markL.property("ADBE Marker");
    mk.setValueAtTime(1, new MarkerValue("hello"));

    /* ---- M1: what is in a layer's ROOT property list. ---------------- */
    stage = "M1 root property list";
    var fixtures = [["bare solid", bare], ["solid + 3 effects", fxL],
                    ["text", txt], ["shape", shp], ["camera", cam],
                    ["light", lit], ["precomp", pre], ["marker", markL]];
    for (var f = 0; f < fixtures.length; f++) {
      var L = fixtures[f][1];
      var rec = { id: "1-root", kind: fixtures[f][0], names: [] };
      try { rec.numProperties = L.numProperties; }
      catch (eNP) { rec.numProperties = "THREW: " + say(eNP); }
      try {
        for (var i = 1; i <= L.numProperties; i++) {
          var p = L.property(i);
          rec.names.push(String(p.name) + " [" + String(p.matchName) + "]" +
            (p.propertyType === PropertyType.PROPERTY ? " LEAF" : ""));
        }
      } catch (eL) { rec.error = say(eL); }
      record(rec);
    }

    /* ---- M2 + M4: node cost AND verdict, per fixture. ----------------
     * Cap deliberately huge here so the TRUE node count is visible; the
     * shipped budget is chosen from these numbers. */
    stage = "M2 walk cost and verdict";
    var costFix = fixtures.concat([["keyed effect param", keyL],
                                   ["time expression", exprL],
                                   ["static expression", statL]]);
    for (var c = 0; c < costFix.length; c++) {
      var v = verdict(costFix[c][1], 100000);
      record({ id: "2-walk", kind: costFix[c][0], keyed: v.keyed,
               why: v.why, exprOn: v.exprOn, expr: v.expr,
               visited: v.visited, exhausted: v.exhausted });
    }

    /* ---- M3: does the SOURCE separate a still from a moving one? ----- */
    stage = "M3 source duration";
    var srcFix = [["bare solid", bare], ["text", txt], ["shape", shp],
                  ["camera", cam], ["light", lit], ["precomp", pre]];
    for (var s2 = 0; s2 < srcFix.length; s2++) {
      var LL = srcFix[s2][1];
      var sr = { id: "3-source", kind: srcFix[s2][0] };
      var src = null;
      try { src = LL.source; } catch (eS) { src = null; }
      sr.hasSource = !!src;
      if (src) {
        try { sr.duration = src.duration; } catch (eD) { sr.duration = "THREW"; }
        try { sr.isComp = (src instanceof CompItem); } catch (eI) { sr.isComp = "THREW"; }
        try { sr.typeName = String(src.typeName); } catch (eTn) { sr.typeName = ""; }
      }
      try { sr.hasAudio = LL.hasAudio; } catch (eA) { sr.hasAudio = "THREW"; }
      try { sr.hasVideo = LL.hasVideo; } catch (eV) { sr.hasVideo = "THREW"; }
      record(sr);
    }

    /* ---- M5: the field failure, through the REAL tool. ---------------
     * Six bare solids in their own comp, staggered with no keyframes
     * anywhere -- the receipt exactly as a model sees it today. */
    stage = "M5 the real receipt";
    var f2 = app.project.items.addComp("AELL Stagger Field", 320, 240, 1, 6, 30);
    var names = [];
    for (var q = 0; q < 6; q++) {
      var nq = "Icon " + (q + 1);
      names.push(nq);
      var lq = f2.layers.addSolid([0.1, 0.2, 0.9], nq, 80, 80, 1);
      madeSources.push(lq.source);
    }
    var rr = call("stagger_layers", { comp: f2.name, layers: names,
                                      spread: 2.5 });
    record({ id: "5-receipt", raw: AELLJSON.stringify(rr) });

    // ...and the same call once the layers DO fade, which must stay clean.
    for (var q2 = 0; q2 < 6; q2++) {
      var op = f2.layer(names[q2]).property("ADBE Transform Group")
                 .property("ADBE Opacity");
      op.setValueAtTime(0, 0);
      op.setValueAtTime(0.5, 100);
    }
    var rr2 = call("stagger_layers", { comp: f2.name, layers: names,
                                       spread: 2.5 });
    record({ id: "5-receipt-keyed", raw: AELLJSON.stringify(rr2) });
    try { f2.remove(); } catch (eF2) {}

    /* ---- M6: what the walk COSTS in wall time. -----------------------
     * "Animate 100 squares" is a documented ask, so the scan has to be
     * priced at that size, not at six. Times the walk over 40 bare
     * solids, which is the shape the scan is slowest on: nothing to find
     * means every node gets visited. */
    stage = "M6 walk timing";
    var f3 = app.project.items.addComp("AELL Stagger Timing", 320, 240, 1, 6, 30);
    for (var t1 = 0; t1 < 40; t1++) {
      var lt = f3.layers.addSolid([0.3, 0.3, 0.3], "T " + (t1 + 1), 40, 40, 1);
      madeSources.push(lt.source);
    }
    var t0 = new Date().getTime();
    var totalNodes = 0;
    for (var t2 = 1; t2 <= f3.numLayers; t2++) {
      var vt = verdict(f3.layer(t2), 100000);
      totalNodes += vt.visited;
    }
    var elapsed = new Date().getTime() - t0;
    record({ id: "6-timing", layers: f3.numLayers, nodes: totalNodes,
             ms: elapsed,
             msPerNode: totalNodes ? (elapsed / totalNodes) : 0 });
    try { f3.remove(); } catch (eF3) {}

    stage = "cleanup";
  } catch (err) {
    record({ id: "CRASH", stage: stage, message: say(err),
             line: (err && err.line) ? err.line : 0 });
  }

  try {
    if (comp) comp.remove();
    if (sub) sub.remove();
    for (var s = 0; s < madeSources.length; s++) {
      try { madeSources[s].remove(); } catch (eS) {}
    }
    stage = stage + " + cleaned";
  } catch (eC) {
    stage = stage + " + CLEANUP FAILED: " + say(eC);
  }
  flush();
})();
