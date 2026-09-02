/*
 * ppro-door-cli.jsx -- DOOR 2 of the P0 headless-door probe.
 *
 * Runs inside Premiere, handed to it at LAUNCH:
 *
 *   "Adobe Premiere Pro.exe" /C es.processFile <this file>
 *
 * which only works when a file called extendscriptprqe.txt sits beside
 * the executable (an admin write, once). Community reports confirm the
 * incantation on CC2019 and 2024; nobody has shown it on 26.x, which is
 * what this measures. Adobe calls it not recommended, and it runs only
 * at launch -- so every harness pass would restart Premiere.
 *
 * Driven by scripts\ppro-door-probe.ps1, which rewrites the two
 * placeholders below before handing the file over: this door has no way
 * to receive $.global values, since nothing sets them.
 *
 * ES3 only (CLAUDE.md).
 */
(function () {
  var outPath = "__OUT__";
  var probeJsx = "__PROBE__";
  var f, raw, ok;

  function say(e) { return (e && e.message) ? String(e.message) : String(e); }
  // split/join, not /"/g -- see the note in ppro-door-bridgetalk.jsx:
  // a bare double quote in a regex literal desynchronises the ES3 lint's
  // string stripper.
  function esc(s) {
    return String(s).split("\\").join("\\\\").split('"').join('\\"')
      .split("\r").join(" ").split("\n").join(" ");
  }

  function write(text) {
    try {
      f = new File(outPath);
      f.encoding = "UTF-8";
      f.open("w");
      f.write(text);
      f.close();
      return true;
    } catch (e) { return false; }
  }

  // The mere existence of this file proves the door: Premiere compiled
  // and ran an arbitrary .jsx handed to it on the command line.
  write('{"door":2,"stage":"started"}');

  raw = "";
  ok = "false";
  try {
    $.evalFile(new File(probeJsx));
    raw = $.global.AELLP_call("hostFacts", "{}");
    ok = "true";
  } catch (e) {
    raw = "probe failed: " + say(e);
  }

  write('{"door":2,"stage":"done","ok":' + ok + ',' +
        '"appVersion":"' + esc((function () {
          try { return String(app.version); } catch (e2) { return "?"; }
        })()) + '",' +
        '"hostFacts":"' + esc(raw) + '"}');
})();
