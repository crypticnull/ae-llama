/*
 * mogrt-verify-probe.jsx -- export a real Motion Graphics template out of
 * real After Effects, so the panel-side verifier can be pointed at bytes
 * ADOBE wrote instead of bytes this repo hand-built.
 * WORKPLAN item 1c bullet 4 (docs/SELF-VERIFY-PLANS.md section 1).
 *
 * Driven by scripts/mogrt-verify-probe.js, which sets:
 *   $.global.AELL_PROBE_REPO  repo root, forward slashes
 *   $.global.AELL_PROBE_OUT   results JSON path, forward slashes
 *   $.global.AELL_PROBE_DIR   scratch folder the .mogrt is written into
 *
 * SAFETY: export_mogrt can only run from a SAVED, CLEAN project, so this
 * script has to save whatever project is open. It therefore REFUSES to
 * run unless the open project already lives under the repo's own
 * gitignored logs\ folder -- it must never save a stranger's work.
 *
 * Every measurement is flushed to disk as it is taken: an export puts a
 * progress window up for several seconds and a font alert can stop the
 * script dead, and the receipt for the exports that already happened is
 * the thing this pass exists to collect.
 */
(function () {
  var repo = $.global.AELL_PROBE_REPO;
  var outPath = $.global.AELL_PROBE_OUT;
  var outDir = $.global.AELL_PROBE_DIR;
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
    return AELLJSON.parse($.global.AELL_call(tool, AELLJSON.stringify(args || {})));
  }

  var comp = null;
  var madeSources = [];

  /* Remove every project item carrying one of these names, walking
   * BACKWARDS (removing shifts the indexes) and by NAME rather than
   * through a held reference -- a successful export invalidates every
   * reference made before it. Each removal is its own try so one dead
   * handle cannot leave the rest of the rig in somebody's project. */
  function purge(names) {
    var removed = [], gi, w;
    for (gi = app.project.numItems; gi >= 1; gi--) {
      var item = null, nm = "";
      try { item = app.project.item(gi); nm = String(item.name); }
      catch (eI) { continue; }
      for (w = 0; w < names.length; w++) {
        if (nm !== names[w]) continue;
        try { item.remove(); removed.push(nm); } catch (eR) {}
        break;
      }
    }
    return removed;
  }

  try {
    stage = "guard";
    /* The open project is about to be SAVED. Refuse anything that is not
     * already scratch: a probe that saves the owner's real project is a
     * worse bug than any it could find. */
    var pf = null, adopted = "";
    try { pf = app.project.file; } catch (ePF) {}
    if (!pf) {
      /* An UNTITLED project is nobody's saved work: AE is sitting on a
       * scratch document (this machine's normal state after a self-test
       * run). Saving it into our own scratch folder loses nothing and is
       * the only route to an export at all - export_mogrt cannot run
       * from a project that has never been saved. A project that DOES
       * have a file is a different question and is refused below. */
      var scratch = new File(String(outDir) + "/mogrt-probe-scratch.aep");
      try { app.project.save(scratch); } catch (eSave) {
        record({ id: "GUARD", refused: "the open project has never been " +
          "saved and could not be saved to " + scratch.fsName + ": " +
          say(eSave) });
        flush();
        return;
      }
      adopted = scratch.fsName;
      try { pf = app.project.file; } catch (ePF2) {}
      if (!pf) {
        record({ id: "GUARD", refused: "saved the untitled project to " +
          scratch.fsName + " and app.project.file is still null" });
        flush();
        return;
      }
    }
    var openPath = String(pf.fsName).replace(/\\/g, "/").toLowerCase();
    var logsRoot = String(repo).replace(/\\/g, "/").toLowerCase() + "/logs/";
    if (openPath.indexOf(logsRoot) !== 0) {
      record({ id: "GUARD", refused: "the open project is " + pf.fsName +
        ", which is not under " + logsRoot + " - this probe saves the " +
        "open project and will not touch one it did not make",
        openProject: String(pf.fsName) });
      flush();
      return;
    }
    record({ id: "0-guard", openProject: String(pf.fsName),
             adoptedUntitled: adopted, ok: true, outDir: String(outDir) });

    stage = "rig";
    /* Sweep first. AE happily keeps two comps with the same name, and
     * AELL_resolveComp would then find the OLDER one -- a rig left
     * behind by an interrupted run made this probe measure a comp whose
     * controllers were already exposed, so every expose_property came
     * back "it is ALREADY a controller" and the export it graded was
     * last run's. Starting from a swept project is the only way the
     * expose steps mean anything. */
    var stale = purge(["AELL MOGRT Probe", "MV Card BG"]);
    record({ id: "0b-presweep", removed: stale });

    /* NO app.beginUndoGroup here: AELL_call opens its own group per
     * mutating tool and AE cannot nest them (see verb-semantics-probe). */
    comp = app.project.items.addComp("AELL MOGRT Probe", 640, 360, 1, 4, 25);
    var bg = comp.layers.addSolid([0.2, 0.3, 0.6], "MV Card BG", 640, 360, 1);
    madeSources.push(bg.source);
    var txt = comp.layers.addText("HELLO");
    txt.name = "MV Headline";

    /* Four controllers of four different kinds, each with a label we
     * chose, so the roster read back out of definition.json is a
     * multiset nobody could produce by accident. One deliberately
     * carries a non-ASCII character and one a space-heavy phrase: the
     * localized-string wrapper Adobe uses is exactly what this pass is
     * measuring, and an ASCII-only roster would not show a mangled one. */
    var exposures = [
      { layer: "MV Headline", property: "Source Text", label: "Headline Text" },
      { layer: "MV Card BG", property: "Opacity",      label: "BG Opacity" },
      { layer: "MV Card BG", property: "Position",     label: "Card Position" },
      /* e-acute as an ESCAPE, not a literal: this file has no BOM and AE
       * would read a raw UTF-8 byte pair as two codepage characters,
       * which would make the round trip measure the wrong thing. */
      { layer: "MV Headline", property: "Scale",
        label: "Headline Size \u00E9" }
    ];
    var exposed = [], i, r;
    for (i = 0; i < exposures.length; i++) {
      r = call("expose_property", { comp: comp.name, layer: exposures[i].layer,
                                    property: exposures[i].property,
                                    label: exposures[i].label });
      exposed.push({ want: exposures[i].label, ok: r.ok,
                     got: r.ok ? (r.data.controller || r.data.name || "") : "",
                     error: r.ok ? "" : (r.error || ""),
                     data: r.ok ? r.data : null });
    }
    record({ id: "1-expose", exposed: exposed });

    stage = "export";
    /* Hold the comp NAME as a string, not the CompItem. A successful
     * export invalidates every reference held across it -- hostscript
     * says so about its own, and it is true out here too: the first
     * draft read `comp.name` for the second export and got "Object is
     * invalid", which then took the cleanup down with it and left the
     * probe rig in the project. */
    var compName = String(comp.name);
    var tpl = "AELL Probe Card";
    r = call("export_mogrt", { comp: compName, folder: String(outDir),
                               name: tpl, overwrite: true, save: true });
    record({ id: "2-export", ok: r.ok, error: r.ok ? "" : (r.error || ""),
             receipt: r.ok ? r.data : null, templateAsked: tpl });

    /* A SECOND export, with the template name left to AE's own default,
     * so the pass can say whether capsuleName in definition.json ever
     * tracks the name we set or is always AE's "Untitled". */
    stage = "export-default-name";
    r = call("export_mogrt", { comp: compName, folder: String(outDir),
                               overwrite: true, save: true });
    record({ id: "3-export-default-name", ok: r.ok,
             error: r.ok ? "" : (r.error || ""),
             receipt: r.ok ? r.data : null });

    /* Re-resolve the comp for the teardown: the reference `comp` holds
     * died in the export above. */
    stage = "re-resolve";
    comp = null;
    for (var pi = 1; pi <= app.project.numItems; pi++) {
      var it = app.project.item(pi);
      if (it instanceof CompItem && it.name === compName) { comp = it; break; }
    }
    record({ id: "4-reresolve", found: !!comp, compName: compName });

    stage = "cleanup";
  } catch (err) {
    record({ id: "CRASH", stage: stage, message: say(err),
             line: (err && err.line) ? err.line : 0 });
  }

  /* Leave the project as it was found: the comp AND the solid footage
   * item addSolid quietly created. Everything here is swept BY NAME
   * rather than through the references made above, because an export
   * kills those -- and every removal is its own try, so one dead handle
   * cannot leave the rest of the rig in somebody's project. */
  try {
    var swept = purge(["AELL MOGRT Probe", "MV Card BG"]).length;
    for (var s = 0; s < madeSources.length; s++) {
      try { madeSources[s].remove(); } catch (eS) {}
    }
    try { app.project.save(); } catch (eSv) {}
    stage = stage + " + cleaned (" + swept + " items)";
  } catch (eC) {
    stage = stage + " + CLEANUP FAILED: " + say(eC);
  }
  flush();
})();
