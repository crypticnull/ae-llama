/*
 * ppro-door-bridgetalk.jsx -- DOOR 1 of the P0 headless-door probe.
 *
 * Runs inside After Effects (AfterFX.exe -r), with Premiere ALREADY
 * RUNNING, and asks the one question WORKPLAN item 11 left open: can the
 * existing AE harness reach Premiere over BridgeTalk?
 *
 * Adobe's own PProPanel sends BridgeTalk FROM Premiere TO After Effects,
 * so the channel exists in that direction. Nobody found an example of
 * the reverse, which is exactly why it is measured rather than assumed.
 *
 * Driven by scripts\ppro-door-probe.ps1, which sets:
 *   $.global.AELLP_DOOR_OUT     results JSON path, forward slashes
 *   $.global.AELLP_DOOR_TOUCH   the file Premiere is asked to create
 *
 * A door counts as ALIVE only when the touch file appears on disk with
 * the expected content. A BridgeTalk send that does not throw proves
 * nothing: the message can be accepted and dropped.
 *
 * ES3 only (CLAUDE.md).
 */
(function () {
  var outPath = $.global.AELLP_DOOR_OUT;
  var touch = $.global.AELLP_DOOR_TOUCH;
  var res = { door: 1, name: "BridgeTalk AE -> Premiere", sends: [] };
  var i, targets, bt, body, sent;

  function say(e) { return (e && e.message) ? String(e.message) : String(e); }

  // split/join rather than /"/g on purpose: tests/test-es3-syntax.js
  // strips strings and comments with a scanner that does not know regex
  // LITERALS, so a bare double quote inside one desynchronises it and
  // the next comment gets linted as code. Measured 2026-09-02 -- it
  // reported `debugger` from a comment three lines further down.
  function esc(s) {
    return String(s).split("\\").join("\\\\").split('"').join('\\"')
      .split("\r").join(" ").split("\n").join(" ");
  }

  function flush() {
    var f, parts, k, rows, j;
    try {
      // No AELLJSON here: this file must not depend on the panel loading.
      rows = [];
      for (j = 0; j < res.sends.length; j++) {
        parts = [];
        for (k in res.sends[j]) {
          if (res.sends[j].hasOwnProperty(k)) {
            parts.push('"' + k + '":"' + esc(res.sends[j][k]) + '"');
          }
        }
        rows.push("{" + parts.join(",") + "}");
      }
      f = new File(outPath);
      f.encoding = "UTF-8";
      f.open("w");
      f.write('{"door":1,"name":"' + esc(res.name) + '",' +
              '"bridgeTalk":"' + esc(res.bridgeTalk) + '",' +
              '"targets":"' + esc(res.targetList) + '",' +
              '"aeVersion":"' + esc(res.aeVersion) + '",' +
              '"sends":[' + rows.join(",") + ']}');
      f.close();
    } catch (e) {}
  }

  res.aeVersion = "";
  try { res.aeVersion = String(app.version); } catch (eV) {}

  res.bridgeTalk = typeof BridgeTalk;
  res.targetList = "";
  if (res.bridgeTalk !== "object" && res.bridgeTalk !== "function") {
    flush();
    return;
  }

  // What this AE thinks is reachable. The exact Premiere specifier is
  // versioned (premierepro-26.0 and the like), so the list is the
  // finding even when every send fails.
  targets = [];
  try {
    var t = BridgeTalk.getTargets();
    for (i = 0; t && i < t.length; i++) { targets.push(String(t[i])); }
  } catch (eT) {
    targets.push("getTargets threw: " + say(eT));
  }
  res.targetList = targets.join(" ");

  // Candidates: everything AE listed that looks like Premiere, plus the
  // names Adobe's samples and the ExtendScript debugger use.
  var candidates = [];
  for (i = 0; i < targets.length; i++) {
    if (/premiere/i.test(targets[i])) { candidates.push(targets[i]); }
  }
  var guesses = ["premierepro", "premierepro-26.0", "premierepro-25.0",
                 "premierepro-27.0"];
  for (i = 0; i < guesses.length; i++) {
    var dup = false;
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c] === guesses[i]) { dup = true; }
    }
    if (!dup) { candidates.push(guesses[i]); }
  }

  // The body Premiere is asked to run: write one file, nothing else.
  body = 'var f = new File("' + touch + '"); f.encoding = "UTF-8"; ' +
         'f.open("w"); f.write("door1 " + String(app.version)); f.close();';

  for (i = 0; i < candidates.length; i++) {
    sent = { target: candidates[i], threw: "", accepted: "false" };
    try {
      bt = new BridgeTalk();
      bt.target = candidates[i];
      bt.body = body;
      bt.send();
      sent.accepted = "true";
    } catch (eS) {
      sent.threw = say(eS);
    }
    res.sends.push(sent);
    flush();
  }

  // Give Premiere a moment to act on whatever it accepted; the PS side
  // also waits and is the authority on whether the touch file appeared.
  try { $.sleep(1500); } catch (eZ) {}
  try { BridgeTalk.pump(); } catch (eP) {}
  try { $.sleep(1500); } catch (eZ2) {}

  flush();
})();
