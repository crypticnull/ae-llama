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

  function writeOut(obj) {
    try {
      var f = new File(outPath);
      f.encoding = "UTF-8";
      f.open("w");
      f.write(AELLJSON.stringify(obj));
      f.close();
    } catch (e) {
      // Without file access there is nothing more we can do; the runner
      // times out and points at the AE scripting preference.
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

    var final = null;
    SelfTest.run({
      callHostTool: callHostTool,
      onLine: function () {},
      onDone: function (res) { final = res; }
    });
    // Shimmed setTimeout is synchronous, so the run has finished here.
    if (final) {
      writeOut({ passed: final.passed, total: final.total,
                 text: final.text });
    } else {
      writeOut({ passed: 0, total: 0,
                 text: "Self-test never completed (runner error)" });
    }
  } catch (err) {
    writeOut({ passed: 0, total: 0,
               text: "Self-test crashed: " + (err && err.message
                 ? err.message : String(err)) });
  }
})();
