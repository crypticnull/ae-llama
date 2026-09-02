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
(function () {
  var here, dir, name, target, f;

  // $.fileName is this file; the bodies sit beside it.
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
    $.global.AELLP_LOADER = "missing " + f.fsName;
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
