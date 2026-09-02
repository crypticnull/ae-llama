/*
 * loader.jsx -- the ScriptPath for manifest SHAPE B (one <Extension>
 * listing both hosts).
 *
 * Why a loader exists at all: CEP auto-evaluates ScriptPath in EVERY
 * host that lists the extension, and there is exactly one ScriptPath per
 * <Extension>. Shape B therefore cannot name an AE-DOM file directly --
 * it would be compiled inside Premiere too. This branches first and
 * loads the right body, which is the pattern the real panel would need
 * if P0 measures that shape B installs where shape A does not.
 *
 * ES3 only. Nothing here may touch app.* : it runs at panel load in a
 * host we have not identified yet.
 */
/*
 * MEASURED 2026-09-02, AE 2026 (26.3), CEP 12.0.1: $.fileName inside a
 * CEP ScriptPath does NOT name this file. It came back as
 *
 *     C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\
 *
 * i.e. the HOST's own folder, so resolving siblings from it looks for
 * probe.jsx next to AfterFX.exe. A ScriptPath loader therefore cannot
 * find its own neighbours this way, and shape B's "branch and load the
 * right body" trick needs a path from somewhere else.
 *
 * That is why index.html now $.evalFile's probe.jsx by the absolute
 * path CEP hands the PANEL (getSystemPath("extension")) - the same way
 * extension/js/main.js has always loaded hostscript.jsx. This file
 * stays as the measurement: it records what $.fileName actually said,
 * so the next session does not re-derive it.
 */
(function () {
  var here, dir, name, target, f;

  $.global.AELLP_LOADER_FILENAME = "";
  try { $.global.AELLP_LOADER_FILENAME = String($.fileName); } catch (eF) {}

  try {
    here = new File($.fileName);
    dir = here.parent.fsName;
  } catch (e) {
    $.global.AELLP_LOADER = "could not resolve $.fileName: " + String(e);
    return;
  }

  // BridgeTalk.appName is the identifier Adobe's own samples branch on
  // ("aftereffects", "premierepro"). It is available before any app.*
  // call, which is what makes it safe here.
  name = "unknown";
  try { name = String(BridgeTalk.appName); } catch (e2) {}

  // Shape B loads the SAME probe body in both hosts on purpose: the
  // question shape B answers is "does one extension entry reach two
  // hosts", and a host-specific body would hide a load failure behind a
  // branch. A real dual-host panel would point the two branches at
  // hostscript.jsx and ppro-hostscript.jsx here.
  target = "probe.jsx";

  f = new File(dir + "/" + target);
  if (!f.exists) {
    // Expected on AE 2026: $.fileName gave the host's folder. The panel
    // loads probe.jsx itself, so this is a recorded fact, not a failure.
    $.global.AELLP_LOADER = "missing " + f.fsName +
      " ($.fileName reported " + $.global.AELLP_LOADER_FILENAME + ")";
    return;
  }
  try {
    $.evalFile(f);
    $.global.AELLP_LOADER = "loaded " + target + " for " + name;
  } catch (e3) {
    $.global.AELLP_LOADER = "evalFile failed for " + name + ": " +
                            String(e3);
  }
})();
