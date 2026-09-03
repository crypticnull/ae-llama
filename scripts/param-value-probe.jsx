/*
 * param-value-probe.jsx -- measure what After Effects actually does when
 * a tool is handed a STRING where a number belongs, and what
 * set_effect_param's "Parameter not found" really prints.
 * WORKPLAN item 8, row 36 vague.
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

  var comp = null;
  var madeSources = [];

  function solid(name) {
    var l = comp.layers.addSolid([0.4, 0.5, 0.6], name, 100, 100, 1);
    madeSources.push(l.source);
    return l;
  }

  /* NO app.beginUndoGroup anywhere in here -- see verb-semantics-probe.jsx
   * for the modal that a nested group leaves behind for the SESSION. */
  try {
    stage = "setup";
    comp = app.project.items.addComp("AELL Param Probe", 320, 240, 1, 5, 25);
    solid("PP A");
    var r = call("apply_effect", { comp: comp.name, layer: "PP A",
                                   effect: "Drop Shadow" });
    record({ id: "0-setup", applyOk: r.ok,
             applied: r.ok ? r.data : (r.error || "") });

    var lay = comp.layer("PP A");
    var fx = lay.property("ADBE Effect Parade").property("Drop Shadow");

    /* ---- M1: what does the parameter roster actually look like? -----
     * set_effect_param's "Parameter not found" lists fx.property(i).name
     * for every index. The field round asked Drop Shadow for "Offset";
     * this records what the model was really shown, and whether the
     * names it should have reached for (Distance, Direction) were in it. */
    stage = "M1 roster";
    var m1 = { id: "1-roster", effect: String(fx.name),
               matchName: String(fx.matchName),
               numProperties: fx.numProperties, names: [], matchNames: [],
               types: [] };
    for (var i = 1; i <= fx.numProperties; i++) {
      var p = fx.property(i);
      m1.names.push(p && p.name ? String(p.name) : "<none>");
      try { m1.matchNames.push(String(p.matchName)); }
      catch (eM) { m1.matchNames.push("THREW"); }
      try {
        m1.types.push(p.propertyType === PropertyType.PROPERTY
          ? String(p.propertyValueType) : "GROUP");
      } catch (eT) { m1.types.push("THREW"); }
    }
    record(m1);

    /* ---- M2: the exact refusal the field round got. ---------------- */
    stage = "M2 param not found";
    var m2 = { id: "2-param-not-found" };
    r = call("set_effect_param", { comp: comp.name, layer: "PP A",
                                   effect: "Drop Shadow", param: "Offset",
                                   value: 10 });
    m2.ok = r.ok;
    m2.error = r.ok ? "" : String(r.error);
    /* Does AE resolve a param by matchName, or lowercased? Both decide
     * whether a near-miss ranking has anything to rank. */
    m2.byLowercase = "";
    try { m2.byLowercase = fx.property("distance") ? "FOUND" : "null"; }
    catch (e2a) { m2.byLowercase = "THREW: " + say(e2a); }
    m2.byMatchName = "";
    try {
      m2.byMatchName = fx.property("ADBE Drop Shadow-0002")
        ? "FOUND" : "null";
    } catch (e2b) { m2.byMatchName = "THREW: " + say(e2b); }
    record(m2);

    /* ---- M3: a STRING where a number belongs, through the tool. -----
     * This is the field failure verbatim: the model passed an expression
     * as the VALUE of set_effect_param. */
    stage = "M3 expression string";
    var m3 = { id: "3-expression-string" };
    var expr = 'thisComp.layer("Shadow Null").effect("Shadow Distance")(1)';
    r = call("set_effect_param", { comp: comp.name, layer: "PP A",
                                   effect: "Drop Shadow", param: "Distance",
                                   value: expr });
    m3.ok = r.ok;
    m3.error = r.ok ? "" : String(r.error);
    m3.data = r.ok ? r.data : null;
    try { m3.distanceAfter = fx.property("Distance").value; }
    catch (e3) { m3.distanceAfter = "THREW: " + say(e3); }
    /* And the raw AE throw, unwrapped, so the fix can be checked against
     * the string the model was really shown. */
    m3.rawThrow = "";
    try { fx.property("Distance").setValue(expr); }
    catch (e3b) { m3.rawThrow = say(e3b); }
    record(m3);

    /* ---- M4: does AE accept a NUMERIC string? ----------------------
     * Decides whether the fix may refuse every string or must coerce
     * "50" -- a refusal that rejects a value AE would have taken is a
     * regression, not a fix. */
    stage = "M4 numeric string";
    var m4 = { id: "4-numeric-string" };
    var dist = fx.property("Distance");
    dist.setValue(3);
    m4.baseline = dist.value;
    m4.threw = "";
    try { dist.setValue("50"); } catch (e4) { m4.threw = say(e4); }
    m4.after = dist.value;
    m4.accepted = (m4.threw === "" && Math.abs(Number(m4.after) - 50) < 0.01);
    /* Through the tool, which is what a caller really hits. */
    r = call("set_effect_param", { comp: comp.name, layer: "PP A",
                                   effect: "Drop Shadow", param: "Distance",
                                   value: "17" });
    m4.toolOk = r.ok;
    m4.toolError = r.ok ? "" : String(r.error);
    m4.toolAfter = dist.value;
    record(m4);

    /* ---- M5: a string into an ARRAY property (Position, Shadow Color)
     * and an array CONTAINING strings, both through setValue raw. */
    stage = "M5 array props";
    var m5 = { id: "5-array-props" };
    var pos = lay.property("ADBE Transform Group").property("ADBE Position");
    m5.posBefore = [pos.value[0], pos.value[1]];
    m5.posStringThrew = "";
    try { pos.setValue("thisComp.layer(1).position"); }
    catch (e5) { m5.posStringThrew = say(e5); }
    m5.posAfterString = [pos.value[0], pos.value[1]];
    m5.posNumStringsThrew = "";
    try { pos.setValue(["10", "20"]); }
    catch (e5b) { m5.posNumStringsThrew = say(e5b); }
    m5.posAfterNumStrings = [pos.value[0], pos.value[1]];
    var col = fx.property("Shadow Color");
    m5.colStringThrew = "";
    try { col.setValue("red"); } catch (e5c) { m5.colStringThrew = say(e5c); }
    record(m5);

    /* ---- M6: the same string through set_transform, which shares
     * AELL_writeValue -- so a fix at the root has to be right here too. */
    stage = "M6 set_transform string";
    var m6 = { id: "6-set-transform-string" };
    r = call("set_transform", { comp: comp.name, layer: "PP A",
                                opacity: 'thisComp.layer("X").opacity' });
    m6.ok = r.ok;
    m6.error = r.ok ? "" : String(r.error);
    m6.data = r.ok ? r.data : null;
    record(m6);

    /* ---- M7: a CHECKBOX and a MENU, both of which a model is likely
     * to send words to ("Shadow Only": true / "on"). */
    stage = "M7 checkbox";
    var m7 = { id: "7-checkbox" };
    var only = fx.property("Shadow Only");
    m7.boolThrew = "";
    try { only.setValue(true); } catch (e7) { m7.boolThrew = say(e7); }
    m7.afterBool = only.value;
    m7.wordThrew = "";
    try { only.setValue("off"); } catch (e7b) { m7.wordThrew = say(e7b); }
    m7.afterWord = only.value;
    record(m7);

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
