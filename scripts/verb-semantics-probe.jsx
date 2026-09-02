/*
 * verb-semantics-probe.jsx -- measure the eight After Effects semantics
 * that the "missing verbs" tools (reorder_layers, remove_effect,
 * delete_mask, remove_keyframes) currently only ASSUME.
 * WORKPLAN item 1c bullet 2.
 *
 * Driven by a generated wrapper that sets:
 *   $.global.AELL_PROBE_REPO  repo root, forward slashes
 *   $.global.AELL_PROBE_OUT   results JSON path, forward slashes
 *
 * Every measurement is FLUSHED to disk the moment it is taken. M7
 * deliberately deletes a mask an expression still points at, which is
 * the one step that could raise a modal and stop this script dead --
 * when that happens the file on disk still holds M1-M6 and M8 plus the
 * stage name, which is the whole point of flushing as we go.
 */
(function () {
  var repo = $.global.AELL_PROBE_REPO;
  var outPath = $.global.AELL_PROBE_OUT;
  var results = [];
  var stage = "loading hostscript";

  /* Bare writer for the case where hostscript.jsx never loaded and
   * AELLJSON therefore does not exist. */
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

  function solid(name) {
    var l = comp.layers.addSolid([0.4, 0.5, 0.6], name, 100, 100, 1);
    madeSources.push(l.source);
    return l;
  }

  function indexNames() {
    var out = [], i;
    for (i = 1; i <= comp.numLayers; i++) out.push(comp.layer(i).name);
    return out;
  }

  try {
    stage = "setup";
    /* NO app.beginUndoGroup around any of this. AELL_call opens and
     * closes its own group per mutating tool, AE does not support
     * nesting them, and an inner endUndoGroup closes the OUTER group --
     * so a wrapper here ends up calling endUndoGroup on a group that is
     * already closed. AE answers that with a modal ("Undo group
     * mismatch, will attempt to fix") and, worse, the counter stays
     * broken for the rest of the SESSION: the first draft of this probe
     * left the machine raising that dialog on every later -r script,
     * self-test runs included, until AE was restarted. */
    comp = app.project.items.addComp("AELL Verb Probe", 320, 240, 1, 5, 25);
    /* addSolid puts each new layer on TOP, so the LAST one made is
     * index 1. Named for their eventual slot to keep the log readable. */
    solid("VP D"); solid("VP C"); solid("VP B"); solid("VP A");
    record({ id: "0-setup", stack: indexNames() });

    /* ---- M1: does AE's scripting layer honour the LOCK? -------------
     * reorder_layers refuses a locked layer before it calls anything,
     * on the untested assumption that the primitives would move it
     * anyway (apply_preset measured that presets DO land on locked
     * layers, so a scripting-wide lock guard was never a given). */
    stage = "M1 locked";
    var lk = comp.layer("VP C");
    lk.locked = true;
    var m1 = { id: "1-locked", layer: lk.name, before: lk.index };
    m1.moveBeforeThrew = "";
    try { lk.moveBefore(comp.layer(1)); }
    catch (e1) { m1.moveBeforeThrew = say(e1); }
    m1.afterMoveBefore = lk.index;
    m1.moveAfterThrew = "";
    try { lk.moveAfter(comp.layer(comp.numLayers)); }
    catch (e1b) { m1.moveAfterThrew = say(e1b); }
    m1.afterMoveAfter = lk.index;
    m1.stillLocked = !!lk.locked;
    m1.aeHonoursLock = (m1.afterMoveBefore === m1.before &&
                        m1.afterMoveAfter === m1.before);
    m1.stack = indexNames();
    lk.locked = false;
    record(m1);

    /* ---- M2: moveBefore(self) / moveAfter(self) --------------------
     * reorder_layers refuses this too, calling it unmeasured. */
    stage = "M2 self";
    var sf = comp.layer("VP B");
    var m2 = { id: "2-self", layer: sf.name, before: sf.index };
    m2.beforeSelfThrew = "";
    try { sf.moveBefore(sf); } catch (e2) { m2.beforeSelfThrew = say(e2); }
    m2.afterBeforeSelf = sf.index;
    m2.afterSelfThrew = "";
    try { sf.moveAfter(sf); } catch (e2b) { m2.afterSelfThrew = say(e2b); }
    m2.afterAfterSelf = sf.index;
    m2.stack = indexNames();
    record(m2);

    /* ---- M4: the front/back primitives land where we claim ---------
     * (taken before M3 so the stack is a known shape for it.) */
    stage = "M4 front/back";
    var fb = comp.layer(2);
    var m4 = { id: "4-front-back", layer: fb.name, before: fb.index,
               numLayers: comp.numLayers };
    fb.moveBefore(comp.layer(1));
    m4.afterToFront = fb.index;
    fb.moveAfter(comp.layer(comp.numLayers));
    m4.afterToBack = fb.index;
    m4.frontIsOne = (m4.afterToFront === 1);
    m4.backIsLast = (m4.afterToBack === comp.numLayers);
    m4.stack = indexNames();
    record(m4);

    /* ---- M3: an already-in-place move, through the TOOL ------------ */
    stage = "M3 already in place";
    var top = comp.layer(1).name, second = comp.layer(2).name;
    var r3 = call("reorder_layers", { comp: comp.name, layer: top,
                                      above: second });
    var m3 = { id: "3-already-in-place", moved: top, above: second,
               ok: r3.ok, error: r3.error || "" };
    if (r3.ok) {
      m3.movedTo = r3.data.movedTo;
      m3.previousIndex = r3.data.previousIndex;
      m3.note = r3.data.note || "";
      m3.warning = r3.data.warning || "";
      m3.saysNothingMoved = /Nothing moved/.test(String(m3.note));
    }
    m3.stack = indexNames();
    record(m3);

    /* ---- M5a: effect survivors are not renumbered ------------------ */
    stage = "M5a effects";
    var fxl = solid("VP FX");
    var i, r;
    for (i = 0; i < 3; i++) {
      r = call("apply_effect", { comp: comp.name, layer: "VP FX",
                                 effect: "Gaussian Blur" });
      if (!r.ok) record({ id: "5a-apply-failed", n: i, error: r.error });
    }
    var parade = fxl.property("ADBE Effect Parade");
    var m5 = { id: "5a-effects", namesBefore: [] };
    for (i = 1; i <= parade.numProperties; i++) {
      m5.namesBefore.push(parade.property(i).name);
      /* distinct values so a bare-name read-back identifies WHICH */
      try { parade.property(i).property("Blurriness").setValue(i * 11); }
      catch (eB) { m5.blurSetError = say(eB); }
    }
    var ref2 = parade.property(2), ref3 = parade.property(3);
    r = call("remove_effect", { comp: comp.name, layer: "VP FX",
                                effect: "Gaussian Blur" });
    m5.removeOk = r.ok;
    m5.removed = r.ok ? r.data.removed : (r.error || "");
    m5.namesAfter = r.ok ? r.data.remainingEffects : [];
    m5.survivorsKeptSuffix = false;
    for (i = 0; i < m5.namesAfter.length; i++) {
      if (m5.namesAfter[i] === "Gaussian Blur 2") m5.survivorsKeptSuffix = true;
    }
    /* Do references held to LATER siblings survive the removal? */
    m5.ref2 = "";
    try { m5.ref2 = String(ref2.name); }
    catch (e5) { m5.ref2 = "THREW: " + say(e5); }
    m5.ref3 = "";
    try { m5.ref3 = String(ref3.name); }
    catch (e5b) { m5.ref3 = "THREW: " + say(e5b); }
    m5.ref3Value = "";
    try { m5.ref3Value = ref3.property("Blurriness").value; }
    catch (e5c) { m5.ref3Value = "THREW: " + say(e5c); }
    record(m5);

    /* ---- M6: which effect a BARE property name resolves to --------- */
    stage = "M6 bare name";
    r = call("get_property", { comp: comp.name, layer: "VP FX",
                               property: "Blurriness" });
    var m6 = { id: "6-bare-name", ok: r.ok, error: r.error || "" };
    if (r.ok) { m6.data = r.data; }
    record(m6);

    /* ---- M6b: ...and with exactly ONE survivor left ----------------
     * The assumption as filed: after removing one of TWO blurs, a bare
     * "Blurriness" resolves to Effects/Gaussian Blur 2/Blurriness --
     * i.e. the survivor keeps the numbered name AE gave it and the
     * bare-name walk still finds it under that name. */
    stage = "M6b bare name, one survivor";
    var fx2 = solid("VP FX2");
    for (i = 0; i < 2; i++) {
      call("apply_effect", { comp: comp.name, layer: "VP FX2",
                             effect: "Gaussian Blur" });
    }
    var p2 = fx2.property("ADBE Effect Parade");
    var m6b = { id: "6b-bare-name-one-survivor", namesBefore: [] };
    for (i = 1; i <= p2.numProperties; i++) {
      m6b.namesBefore.push(p2.property(i).name);
      p2.property(i).property("Blurriness").setValue(i * 7);
    }
    r = call("remove_effect", { comp: comp.name, layer: "VP FX2",
                                effect: "Gaussian Blur" });
    m6b.removed = r.ok ? r.data.removed : (r.error || "");
    m6b.namesAfter = r.ok ? r.data.remainingEffects : [];
    r = call("get_property", { comp: comp.name, layer: "VP FX2",
                               property: "Blurriness" });
    m6b.ok = r.ok;
    m6b.error = r.error || "";
    if (r.ok) { m6b.data = r.data; }
    record(m6b);

    /* ---- M5b: mask survivors are not renumbered -------------------- */
    stage = "M5b masks";
    var mkl = solid("VP Masks");
    var mparade = mkl.property("ADBE Mask Parade");
    for (i = 0; i < 3; i++) mparade.addProperty("ADBE Mask Atom");
    var m5b = { id: "5b-masks", namesBefore: [] };
    for (i = 1; i <= mparade.numProperties; i++) {
      m5b.namesBefore.push(mparade.property(i).name);
    }
    var mref3 = mparade.property(3);
    r = call("delete_mask", { comp: comp.name, layer: "VP Masks",
                              mask: m5b.namesBefore[0] });
    m5b.removeOk = r.ok;
    m5b.removed = r.ok ? r.data.removed : (r.error || "");
    m5b.namesAfter = r.ok ? r.data.remainingMasks : [];
    m5b.mref3 = "";
    try { m5b.mref3 = String(mref3.name); }
    catch (e5d) { m5b.mref3 = "THREW: " + say(e5d); }
    record(m5b);

    /* ---- M8: which value survives when every key is removed --------
     * Two identical rigs emptied at DIFFERENT current times: if the
     * residual tracks the playhead the two disagree, if it is the last
     * (or first) key's value they agree. */
    stage = "M8 residual value";
    function keyRig(name) {
      var l = solid(name);
      var p = l.property("ADBE Transform Group").property("ADBE Opacity");
      p.setValueAtTime(0, 100);
      p.setValueAtTime(1, 50);
      p.setValueAtTime(2, 0);
      return l;
    }
    keyRig("VP Keys A");
    keyRig("VP Keys B");
    var m8 = { id: "8-remove-keyframes", keys: "0s=100, 1s=50, 2s=0" };
    function emptyAt(layerName, t) {
      comp.time = t;
      var l = comp.layer(layerName);
      var p = l.property("ADBE Transform Group").property("ADBE Opacity");
      var out = { atTime: t, valueAtTimeBefore: p.valueAtTime(t, false) };
      var rr = call("remove_keyframes", { comp: comp.name, layer: layerName,
                                          property: "Opacity" });
      out.ok = rr.ok;
      out.removed = rr.ok ? rr.data.removed : (rr.error || "");
      out.numKeysAfter = p.numKeys;
      out.residual = p.value;
      out.compTimeAfter = comp.time;
      return out;
    }
    m8.a = emptyAt("VP Keys A", 0.5);
    m8.b = emptyAt("VP Keys B", 1.5);
    m8.tracksPlayhead = (m8.a.residual !== m8.b.residual);
    m8.isLastKeyValue = (m8.a.residual === 0 && m8.b.residual === 0);
    m8.isFirstKeyValue = (m8.a.residual === 100 && m8.b.residual === 100);
    record(m8);

    /* ---- M7: delete a mask an expression still points at -----------
     * LAST on purpose. The selftest clears the expression first "because
     * older versions put up a dialog"; this measures whether AE 2026
     * does. If it does, this script never returns and everything above
     * is already on disk. */
    stage = "M7 expression modal (danger)";
    var mo = solid("VP Mask Off");
    var mask = mo.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
    mask.name = "VP Off Path";
    var shape = new Shape();
    shape.vertices = [[0, 0], [100, 0], [100, 100], [0, 100]];
    shape.closed = true;
    mask.property("ADBE Mask Shape").setValue(shape);
    var probeL = solid("VP Off Probe");
    var pos = probeL.property("ADBE Transform Group").property("ADBE Position");
    pos.expression = 'thisComp.layer("VP Mask Off")' +
                     '.mask("VP Off Path").maskPath.points(0)[1]';
    var m7 = { id: "7-expression-modal",
               expressionEnabledBefore: pos.expressionEnabled };
    try { m7.valueBefore = pos.value; }
    catch (e7) { m7.valueBefore = "THREW: " + say(e7); }
    flush();
    r = call("delete_mask", { comp: comp.name, layer: "VP Mask Off",
                              mask: "VP Off Path" });
    m7.deleteOk = r.ok;
    m7.deleted = r.ok ? r.data.removed : (r.error || "");
    m7.survivedTheDelete = true;
    try { m7.expressionEnabledAfter = pos.expressionEnabled; }
    catch (e7b) { m7.expressionEnabledAfter = "THREW: " + say(e7b); }
    try { m7.expressionError = String(pos.expressionError || ""); }
    catch (e7c) { m7.expressionError = "THREW: " + say(e7c); }
    try { m7.valueAfter = pos.value; }
    catch (e7d) { m7.valueAfter = "THREW: " + say(e7d); }
    record(m7);

    stage = "cleanup";
  } catch (err) {
    record({ id: "CRASH", stage: stage, message: say(err),
             line: (err && err.line) ? err.line : 0 });
  }

  /* Leave the project exactly as it was found -- the comp AND the solid
   * footage items each solid() quietly created. */
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
