/*
 * ae-selftest.jsx — run the panel's self-test suite inside REAL After
 * Effects with no panel and no LLM involved. Launched by
 * scripts/run-ae-selftest.ps1 via a generated wrapper that sets:
 *   $.global.AELL_TEST_REPO  (repo root, forward slashes)
 *   $.global.AELL_TEST_OUT   (results JSON path, forward slashes)
 *
 * It reuses the SAME step list the panel's "Run self-test" button uses
 * (extension/js/selftest.js) through tiny shims, so the two runners can
 * never drift apart.
 *
 * Requires AE's "Allow Scripts to Write Files and Access Network"
 * preference (Preferences > Scripting & Expressions).
 */
(function () {
  var repo = $.global.AELL_TEST_REPO;
  var outPath = $.global.AELL_TEST_OUT;

  // Deliberately self-contained: no AELLJSON, no helpers from anywhere
  // else. writeOut is the ONLY channel this script has for reporting
  // failure, so it must survive the case where nothing else loaded --
  // when hostscript.jsx fails, AELLJSON does not exist, and a writeOut
  // that used it would throw inside the very catch block meant to
  // report the problem, leaving the runner with a silent timeout.
  function jsonStr(s) {
    var out = "", i, c;
    s = String(s);
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      if (c === '"') { out += '\\"'; }
      else if (c === "\\") { out += "\\\\"; }
      else if (c === "\n") { out += "\\n"; }
      else if (c === "\r") { out += "\\r"; }
      else if (c === "\t") { out += "\\t"; }
      else if (c < " ") { out += " "; }
      else { out += c; }
    }
    return '"' + out + '"';
  }

  function writeOut(passed, total, text) {
    try {
      var f = new File(outPath);
      f.encoding = "UTF-8";
      f.open("w");
      f.write('{"passed":' + (passed | 0) + ',"total":' + (total | 0) +
              ',"text":' + jsonStr(text) + '}');
      f.close();
    } catch (e) {
      // File access denied. Nothing left to report with; the runner
      // times out and names the AE scripting preference.
    }
  }

  try {
    // The host tool layer (defines $.global.AELL_call + AELLJSON).
    $.evalFile(new File(repo + "/extension/jsx/hostscript.jsx"));

    // Shims so the panel's selftest.js runs unmodified: a window with a
    // synchronous setTimeout, and a JSON built from AELLJSON.
    $.global.window = {
      setTimeout: function (fn) { fn(); }
    };
    if (typeof $.global.JSON === "undefined") {
      $.global.JSON = AELLJSON;
    }
    $.evalFile(new File(repo + "/extension/js/selftest.js"));
    var SelfTest = $.global.window.SelfTest;

    function callHostTool(tool, args, cb) {
      var raw = $.global.AELL_call(tool, AELLJSON.stringify(args || {}));
      cb(AELLJSON.parse(raw));
    }

    var finalRes = null;
    SelfTest.run({
      callHostTool: callHostTool,
      onLine: function () {},
      onDone: function (res) { finalRes = res; }
    });
    // Shimmed setTimeout is synchronous, so the run has finished here.
    if (finalRes) {
      writeOut(finalRes.passed, finalRes.total, finalRes.text);
    } else {
      writeOut(0, 0, "Self-test never completed (runner error)");
    }
  } catch (err) {
    writeOut(0, 0, "Self-test crashed: " +
      (err && err.message ? err.message : String(err)) +
      (err && err.line ? " (line " + err.line + ")" : ""));
  }
})();
