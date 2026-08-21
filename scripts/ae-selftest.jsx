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
    // setTimeout, and a JSON built from AELLJSON.
    //
    // The shim QUEUES rather than calling straight through. selftest.js
    // ends each step with setTimeout(step), so a shim that ran fn() on the
    // spot nested every step inside the one before it -- and ExtendScript's
    // stack is small enough that the suite killed itself with "Stack
    // overrun" the moment it passed ~100 steps. Draining the queue from
    // the top level keeps the depth flat however long the suite gets.
    var pending = [];
    $.global.window = {
      setTimeout: function (fn) { pending.push(fn); }
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

    // Many tools in ONE host call -- the path that makes a whole chat
    // command a single Ctrl+Z.
    function callHostBatch(cmds, cb) {
      var raw = $.global.AELL_callBatch(AELLJSON.stringify(cmds));
      var obj = AELLJSON.parse(raw);
      cb(obj && obj.ok && obj.data ? obj.data.results : null);
    }

    var finalRes = null;
    SelfTest.run({
      callHostTool: callHostTool,
      callHostBatch: callHostBatch,
      onLine: function () {},
      onDone: function (res) { finalRes = res; }
    });
    // Drain what the shim queued. The cap is a runaway guard only: one
    // entry is queued per step, so it can never be reached by a suite
    // that terminates.
    var guard = 0;
    while (pending.length > 0 && guard < 100000) {
      guard++;
      var next = pending.shift();
      next();
    }
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
