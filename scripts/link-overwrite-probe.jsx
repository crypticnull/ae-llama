/*
 * link-overwrite-probe.jsx -- what happens to an expression that is
 * ALREADY on the property when a tool writes a new one over it.
 *
 * Filed by the 0.11.31 pass as its top open item: two link_property
 * calls drove effect.Drop Shadow.Distance from two different sliders,
 * BOTH answered ok, and nothing said the first link was gone. The rule
 * this project runs on is that nothing disappears quietly, so the first
 * question is what actually disappears -- and the second, which nobody
 * has asked, is what happens on the FAILING path: AELL_setExpr clears
 * `prop.expression = ""` when AE reports an expressionError, and if the
 * property carried a working expression a moment earlier, that clear
 * throws away the user's expression as the price of a REJECTED write.
 *
 * Everything here is measured raw first (AE's own API) and only then
 * through the shipped tools, so a receipt can be compared against what
 * the property really holds rather than against another receipt.
 *
 * Questions:
 *   A1  a plain overwrite -- is the old text recoverable anywhere?
 *   A2  an invalid write over a VALID expression: which branch does
 *       AELL_setExpr take (throw, or expressionError + clear), and is
 *       the prior text restorable by plain assignment afterwards?
 *   A3  a DISABLED expression (expressionEnabled = false) -- does it
 *       still read back, and does a new write silently re-enable it?
 *   A4  keyframes under an expression: do they survive, and do they
 *       come back when the expression is cleared?
 *   A5  writing the IDENTICAL text again -- is that a change at all?
 *   A6  the shipped tools' receipts for every overwrite pair.
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

  var comp = null, solid = null, ctrl = null;
  var madeSources = [];

  /* Photograph the project by ITEM ID before anything is created, so the
   * cleanup can remove exactly what this run added and nothing of the
   * user's -- the same rule the self-test's cleanup runs on (a null's
   * FOOTAGE source outlives the comp that held it, and "Null 1" is a
   * name a real project holds too). */
  var idsBefore = {};
  (function () {
    for (var i = 1; i <= app.project.numItems; i++) {
      try { idsBefore[app.project.item(i).id] = true; } catch (e) {}
    }
  })();

  /* Read everything a receipt could possibly say about a property's
   * expression state, in one shape, so two rows can be compared. */
  function readExpr(prop) {
    var out = { text: "?", enabled: "?", err: "?", value: "?", keys: "?" };
    try { out.text = String(prop.expression); } catch (e1) {}
    try { out.enabled = prop.expressionEnabled; } catch (e2) {}
    try { out.err = String(prop.expressionError || ""); } catch (e3) {}
    try {
      var v = prop.value;
      out.value = AELLJSON.isArray(v) ? ("[" + v.join(",") + "]") : String(v);
    } catch (e4) {}
    try { out.keys = prop.numKeys; } catch (e5) {}
    return out;
  }

  function opacityOf(layer) {
    return layer.property("ADBE Transform Group").property("ADBE Opacity");
  }

  /* Assign raw and report which of the two failure branches AE took. */
  function rawSet(prop, text) {
    var threw = "";
    try { prop.expression = text; }
    catch (e) { threw = say(e); }
    var st = readExpr(prop);
    return { threw: threw, after: st };
  }

  try {
    stage = "rig";
    comp = app.project.items.addComp("LP PROBE", 400, 300, 1, 5, 30);
    solid = comp.layers.addSolid([1, 0.2, 0.2], "LP solid", 400, 300, 1);
    try { madeSources.push(solid.source); } catch (eSrc) {}
    ctrl = comp.layers.addNull();
    ctrl.name = "LP ctrl";

    /* Two sliders, so "linked to A" and "linked to B" are distinguishable
     * in the expression text itself. */
    var fxA = ctrl.property("ADBE Effect Parade")
                  .addProperty("ADBE Slider Control");
    fxA.name = "Knob A";
    fxA.property(1).setValue(11);
    var fxB = ctrl.property("ADBE Effect Parade")
                  .addProperty("ADBE Slider Control");
    fxB.name = "Knob B";
    fxB.property(1).setValue(77);

    var EA = 'thisComp.layer("LP ctrl").effect("Knob A")(1);';
    var EB = 'thisComp.layer("LP ctrl").effect("Knob B")(1);';
    var op = opacityOf(solid);

    /* ---- A0: what a property with no expression reads as ---------- */
    stage = "A0 bare";
    record({ id: "0-bare", state: readExpr(op) });

    /* ---- A1: plain overwrite -------------------------------------- */
    stage = "A1 overwrite";
    op.expression = EA;
    var a1First = readExpr(op);
    op.expression = EB;
    var a1Second = readExpr(op);
    record({ id: "1-overwrite", first: a1First, second: a1Second,
             firstTextSurvives: (a1Second.text === EA) });

    /* ---- A2: an INVALID write over a VALID expression -------------- */
    stage = "A2 invalid over valid";
    var BADS = [
      { tag: "missing layer",
        text: 'thisComp.layer("NO SUCH LAYER").transform.opacity;' },
      { tag: "missing effect",
        text: 'thisComp.layer("LP ctrl").effect("No Knob")(1);' },
      { tag: "syntax garbage", text: 'this is ((not javascript' },
      { tag: "out-of-range subscript", text: 'value[7];' }
    ];
    for (var bi = 0; bi < BADS.length; bi++) {
      op.expression = "";
      op.expression = EA;
      var before = readExpr(op);
      var attempt = rawSet(op, BADS[bi].text);
      /* Restore the way a fix would have to: plain assignment of the
       * text we captured before the write. */
      var restored = rawSet(op, EA);
      record({ id: "2-invalid", tag: BADS[bi].tag,
               beforeText: before.text, beforeValue: before.value,
               threw: attempt.threw, afterText: attempt.after.text,
               afterErr: attempt.after.err, afterValue: attempt.after.value,
               restoreThrew: restored.threw,
               restoredText: restored.after.text,
               restoredErr: restored.after.err,
               restoredValue: restored.after.value,
               restoreWorks: (restored.after.text === EA &&
                              restored.after.err === "" &&
                              restored.after.value === before.value) });
    }

    /* What the SHIPPED helper does with the same input: it is the clear
     * branch that costs the user their expression, so measure it as the
     * tool would run it. */
    stage = "A2b shipped setExpr";
    for (var si = 0; si < BADS.length; si++) {
      op.expression = "";
      op.expression = EA;
      var pre = readExpr(op);
      var helperErr = "";
      try { helperErr = AELL_setExpr(op, BADS[si].text); }
      catch (eH) { helperErr = "THREW: " + say(eH); }
      var post = readExpr(op);
      record({ id: "2b-helper", tag: BADS[si].tag,
               beforeText: pre.text, helperErr: String(helperErr),
               afterText: post.text, afterErr: post.err,
               afterValue: post.value,
               priorLost: (pre.text !== "" && post.text !== pre.text) });
    }

    /* ---- A3: a DISABLED expression -------------------------------- */
    stage = "A3 disabled";
    op.expression = "";
    op.expression = EA;
    op.expressionEnabled = false;
    var a3Off = readExpr(op);
    var a3Write = rawSet(op, EB);
    record({ id: "3-disabled", off: a3Off, threw: a3Write.threw,
             after: a3Write.after,
             textReadableWhileOff: (a3Off.text === EA),
             writeReEnabled: (a3Write.after.enabled === true) });

    /* ---- A4: keyframes under an expression ------------------------ */
    stage = "A4 keyframes";
    op.expression = "";
    op.setValueAtTime(0, 20);
    op.setValueAtTime(1, 80);
    var a4Keys = readExpr(op);
    op.expression = EA;
    var a4Linked = readExpr(op);
    op.expression = "";
    var a4Cleared = readExpr(op);
    record({ id: "4-keys", keyed: a4Keys, linked: a4Linked,
             cleared: a4Cleared,
             keysSurvive: (a4Linked.keys === a4Keys.keys),
             keysStillThere: (a4Cleared.keys === a4Keys.keys) });
    while (op.numKeys > 0) op.removeKey(1);
    op.expression = "";
    op.setValue(100);

    /* ---- A5: writing the IDENTICAL text again --------------------- */
    stage = "A5 identical";
    op.expression = EA;
    var a5One = readExpr(op);
    var a5Again = rawSet(op, EA);
    record({ id: "5-identical", first: a5One, threw: a5Again.threw,
             after: a5Again.after });

    /* ---- A6: what the SHIPPED tools say when they overwrite ------- */
    stage = "A6 receipts";
    var TOOLCASES = [
      { tag: "link_property over link_property",
        prep: function () { op.expression = EA; },
        tool: "link_property",
        args: { layer: "LP solid", property: "opacity",
                controlLayer: "LP ctrl", controlEffect: "Knob B" } },
      { tag: "link_property over a hand expression",
        prep: function () { op.expression = "wiggle(2, 30);"; },
        tool: "link_property",
        args: { layer: "LP solid", property: "opacity",
                controlLayer: "LP ctrl", controlEffect: "Knob B" } },
      { tag: "link_property onto a bare property",
        prep: function () { op.expression = ""; },
        tool: "link_property",
        args: { layer: "LP solid", property: "opacity",
                controlLayer: "LP ctrl", controlEffect: "Knob B" } },
      { tag: "link_property with the SAME control again",
        prep: function () { op.expression = EB; },
        tool: "link_property",
        args: { layer: "LP solid", property: "opacity",
                controlLayer: "LP ctrl", controlEffect: "Knob B" } },
      { tag: "set_expression over a link",
        prep: function () { op.expression = EA; },
        tool: "set_expression",
        args: { layer: "LP solid", property: "opacity",
                expression: "wiggle(2, 30);" } },
      { tag: "set_expression CLEARS a link",
        prep: function () { op.expression = EA; },
        tool: "set_expression",
        args: { layer: "LP solid", property: "opacity", expression: "" } },
      { tag: "set_expression REJECTED over a link",
        prep: function () { op.expression = EA; },
        tool: "set_expression",
        args: { layer: "LP solid", property: "opacity",
                expression: 'thisComp.layer("NO SUCH LAYER").opacity;' } },
      { tag: "apply_expression_preset over a link",
        prep: function () { op.expression = EA; },
        tool: "apply_expression_preset",
        args: { layer: "LP solid", property: "opacity", preset: "wiggle" } }
    ];
    for (var ti = 0; ti < TOOLCASES.length; ti++) {
      op.expression = "";
      TOOLCASES[ti].prep();
      var was = readExpr(op);
      var argsFull = { comp: comp.name };
      var a = TOOLCASES[ti].args;
      for (var k in a) if (a.hasOwnProperty(k)) argsFull[k] = a[k];
      var res = null;
      try { res = call(TOOLCASES[ti].tool, argsFull); }
      catch (eCall) { res = { threw: say(eCall) }; }
      var now = readExpr(op);
      record({ id: "6-receipt", tag: TOOLCASES[ti].tag,
               tool: TOOLCASES[ti].tool,
               wasText: was.text, nowText: now.text, nowErr: now.err,
               raw: AELLJSON.stringify(res),
               mentionsOld: (AELLJSON.stringify(res).indexOf("Knob A") !== -1 ||
                             AELLJSON.stringify(res).indexOf("wiggle(2") !== -1),
               silentLoss: (was.text !== "" && now.text !== was.text) });
    }

    /* ---- A7: grid_layout writes Position expressions the same way,
     * so a rigged layer is the same class. One row, to show the reach. */
    stage = "A7 grid over a link";
    var pos = solid.property("ADBE Transform Group")
                   .property("ADBE Position");
    pos.expression = 'thisComp.layer("LP ctrl").transform.position;';
    var g7was = readExpr(pos);
    var g7 = null;
    try {
      g7 = call("grid_layout", { comp: comp.name, layers: ["LP solid"],
                                 columns: 1 });
    } catch (eG) { g7 = { threw: say(eG) }; }
    var g7now = readExpr(pos);
    record({ id: "7-grid", wasText: g7was.text, nowText: g7now.text,
             raw: AELLJSON.stringify(g7),
             silentLoss: (g7was.text !== "" && g7now.text !== g7was.text) });

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
    /* Anything the photograph does not contain was created here. */
    var strays = [];
    for (var p = app.project.numItems; p >= 1; p--) {
      var it = null;
      try { it = app.project.item(p); } catch (eI) { continue; }
      if (it && !idsBefore[it.id]) {
        strays.push(it.name);
        try { it.remove(); } catch (eR) {}
      }
    }
    record({ id: "9-cleanup", strays: strays,
             itemsNow: app.project.numItems });
    stage = stage + " + cleaned";
  } catch (eC) {
    stage = stage + " + CLEANUP FAILED: " + say(eC);
  }
  flush();
})();
