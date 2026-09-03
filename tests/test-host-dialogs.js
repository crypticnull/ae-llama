// test-host-dialogs.js - the safety rail on scripts/lib/host-dialogs.ps1.
//
// This library presses buttons on Adobe's modal dialogs unattended, and
// one of those buttons DISCARDS unsaved work. The rail is that a rule
// which discards may only ever fire on a project the calling script
// declares it owns. This test is here because the rail was already got
// wrong once in a way that reads fine: the first version gated on the
// literal word "Untitled", which is not the same question as "is this
// ours" -- the harness saves NAMED scratch projects in BOTH hosts
// (mogrt-probe-scratch.aep in AE, AELL_PROBE_SCRATCH.prproj in
// Premiere), so the rule could not answer the dialogs it existed for.
//
// Static analysis, not execution: the file is Windows PowerShell with a
// C# block full of user32 P/Invokes and cannot run here. The rule table
// and its guard are plain declarative text, so they can be read.
// tests/test-powershell-syntax.js parses the same file with the real
// pwsh parser, and the C# compiles under Add-Type on Linux (DllImport
// resolves at call time).

var fs = require("fs");
var path = require("path");

var LIB = path.join(__dirname, "..", "scripts", "lib", "host-dialogs.ps1");
var AE = path.join(__dirname, "..", "scripts", "run-ae-selftest.ps1");
var PP = path.join(__dirname, "..", "scripts", "run-ppro-probe.ps1");

var failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("ok  - " + name);
  } else {
    console.log("FAIL- " + name + (detail ? ": " + detail : ""));
    failures.push(name);
  }
}

var lib = fs.readFileSync(LIB, "utf8");

// --- the rules ----------------------------------------------------------
// Each @{ ... } block inside Get-AellDialogRules, comments stripped so a
// comment that quotes a button label cannot be read as a rule.
function rulesOf(text) {
  var start = text.indexOf("function Get-AellDialogRules");
  var end = text.indexOf("function Answer-AellKnownDialogs");
  var body = text.slice(start, end);
  body = body.split("\n").filter(function (l) {
    return !/^\s*#/.test(l);
  }).join("\n");
  // Brace-counted, not regex-delimited. A rule's closing "}" sits on the
  // same line as its last field ("Buttons = @(...) },"), so a pattern
  // anchored on a newline before the brace swallows the whole table as
  // one rule -- which is how the first version of this test reported
  // "found 1" and passed everything it did not then look at.
  var out = [];
  var i = 0;
  while ((i = body.indexOf("@{", i)) !== -1) {
    var depth = 0;
    var j = i + 1;
    for (; j < body.length; j++) {
      if (body[j] === "{") { depth++; }
      else if (body[j] === "}") {
        depth--;
        if (depth === 0) { break; }
      }
    }
    out.push(body.slice(i + 2, j));
    i = j + 1;
  }
  return out;
}

var rules = rulesOf(lib);
check("Get-AellDialogRules declares rules", rules.length >= 4,
      "found " + rules.length);

function field(rule, name) {
  var m = rule.match(new RegExp(name + "\\s*=\\s*(.*)"));
  return m ? m[1].trim() : null;
}

// A button label that throws away unsaved changes. "Cancel" is NOT one:
// it calls off the quit and changes nothing, which is why it is allowed
// to fire on a project we cannot prove is ours.
var DISCARDING = ["Don't Save", "Dont Save", "Discard"];

rules.forEach(function (rule, i) {
  var name = field(rule, "Name") || ("rule " + i);
  var buttons = field(rule, "Buttons") || "";
  var any = field(rule, "Any") || "";
  var requires = field(rule, "RequiresOwned");

  var discards = DISCARDING.some(function (b) {
    return buttons.indexOf(b) !== -1;
  });

  if (discards) {
    check(name + " -- a discarding rule is flagged RequiresOwned",
          requires === "$true",
          "RequiresOwned is " + requires);
    check(name + " -- a discarding rule takes its names from the caller",
          any.indexOf("$OwnedProjects") !== -1,
          "Any = " + any);
  } else {
    check(name + " -- a non-discarding rule declares RequiresOwned",
          requires === "$false" || requires === "$true",
          "RequiresOwned is " + requires);
  }
});

// --- the guard ----------------------------------------------------------
// A discarding rule with an empty owned list must be SKIPPED, or it
// matches every project in existence.
var answer = lib.slice(lib.indexOf("function Answer-AellKnownDialogs"));
check("the guard skips a discarding rule with no owned names",
      /\$rule\.RequiresOwned\s+-and\s+@\(\$rule\.Any\)\.Count\s+-eq\s+0/.test(answer) &&
      /continue/.test(answer));

// And it must key on the flag, not on the rule's NAME -- the cancelling
// rule is also a save-changes rule and MUST still run with no owned
// names, because cancelling is what protects a project we do not own.
check("the guard does not key on the rule name",
      !/\$rule\.Name\s+-like\s+'save-changes\*'/.test(answer));

// --- the cancelling rule exists and is last -----------------------------
var cancelIdx = -1, discardIdx = -1;
rules.forEach(function (rule, i) {
  var buttons = field(rule, "Buttons") || "";
  if (/@\('Cancel'\)/.test(buttons)) { cancelIdx = i; }
  if (DISCARDING.some(function (b) { return buttons.indexOf(b) !== -1; })) {
    discardIdx = i;
  }
});
check("there is a Cancel-only rule for a project we do not own",
      cancelIdx !== -1);
check("it is ordered AFTER the discarding rule, so an owned project " +
      "still gets the answer that resolves it",
      cancelIdx > discardIdx,
      "cancel at " + cancelIdx + ", discard at " + discardIdx);

// --- the callers declare what they own ----------------------------------
// The names below are not decoration: each is a project some script in
// this repo SAVES itself, and a name that drifts out of sync with the
// script that writes it silently disarms the rule.
var ae = fs.readFileSync(AE, "utf8");
var pp = fs.readFileSync(PP, "utf8");

check("the AE runner claims AE's cold-launch project",
      /AellOwnedProjects\s*=\s*@\([^)]*'Untitled Project'/.test(ae));
check("the AE runner claims the mogrt probe's NAMED scratch project",
      /AellOwnedProjects\s*=\s*@\([^)]*'mogrt-probe-scratch'/.test(ae));

// That second name has to match what actually writes the file.
var probe = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "mogrt-verify-probe.jsx"), "utf8");
check("mogrt-verify-probe.jsx really saves a project by that name",
      probe.indexOf("mogrt-probe-scratch.aep") !== -1);

check("the Premiere probe derives its owned name from its own scratch path",
      /AellOwnedProjects\s*=\s*@\(\[System\.IO\.Path\]::GetFileNameWithoutExtension\(\$scratch\)\)/
        .test(pp));
check("...and that scratch path is the one it saves to",
      /\$scratch\s*=\s*Join-Path\s+\$probeData\s+'AELL_PROBE_SCRATCH\.prproj'/
        .test(pp));

// --- both callers actually use the library ------------------------------
[["run-ae-selftest.ps1", ae], ["run-ppro-probe.ps1", pp]].forEach(
  function (pair) {
    check(pair[0] + " dot-sources the shared library",
          /lib\\host-dialogs\.ps1/.test(pair[1]));
    check(pair[0] + " passes its owned projects when answering",
          /Answer-AellKnownDialogs[\s\S]{0,200}-OwnedProjects\s+\$script:AellOwnedProjects/
            .test(pair[1]));
  });

// The AE runner must no longer carry its own copy of any of this: two
// tables that can drift is how the Premiere gap survived in the first
// place.
check("the AE runner keeps no private copy of the rules",
      ae.indexOf("$script:AellDialogRules") === -1 &&
      ae.indexOf("public static string AnswerDialog") === -1);

// --- the watchdog -------------------------------------------------------
// The answering was built twice inside run-ae-selftest.ps1 and missed
// the owner's case both times, because NOTHING in this repo asks After
// Effects to quit -- so the prompt appeared when no self-test was
// running and no code of ours was looking. Answering therefore cannot
// be a feature of one script; the loop has to carry it.
var loop = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "run-local-agent.ps1"), "utf8");

check("the overnight loop starts a dialog watchdog",
      /Start-Job[\s\S]{0,120}AellDialogWatchdog/.test(loop));
check("the watchdog uses the shared rules, not a copy of its own",
      /lib\\host-dialogs\.ps1/.test(loop) &&
      /Answer-AellKnownDialogs/.test(loop));
check("the watchdog is stopped when the loop finishes",
      /Stop-Job[\s\S]{0,120}\$watchdog|Stop-Job -Job \$watchdog/.test(loop));
check("the watchdog can be turned off",
      /\[switch\]\$NoDialogWatchdog/.test(loop));
// The loop relaunches itself detached through WMI, rebuilding its own
// command line by hand. A switch missing from that string is a switch
// that silently does nothing in the run that actually happens.
check("-NoDialogWatchdog survives the detached relaunch",
      /\$NoDialogWatchdog\)\s*\{\s*\$fwd = \$fwd \+ ' -NoDialogWatchdog'/
        .test(loop));

// Every owned name the watchdog and the standalone script declare must
// be one some script here really writes; a name that drifts silently
// disarms the rule for that project.
var standalone = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "answer-host-dialogs.ps1"), "utf8");
["Untitled Project", "mogrt-probe-scratch", "AELL_PROBE_SCRATCH"]
  .forEach(function (n) {
    check("the watchdog claims '" + n + "'", loop.indexOf("'" + n + "'") !== -1);
    check("answer-host-dialogs.ps1 claims '" + n + "'",
          standalone.indexOf("'" + n + "'") !== -1);
  });

check("there is a standalone way to clear a dialog with no loop running",
      /lib\\host-dialogs\.ps1/.test(standalone) &&
      /Answer-AellKnownDialogs/.test(standalone));
check("...and a read-only mode that clicks nothing",
      /\[switch\]\$WhatIsUp/.test(standalone) &&
      /Write-AellUnknownDialogs/.test(standalone));

// --- ASCII (CLAUDE.md: Windows PowerShell 5.1, BOM-less) ----------------
var bytes = fs.readFileSync(LIB);
var nonAscii = [];
for (var i = 0; i < bytes.length; i++) {
  if (bytes[i] > 127) { nonAscii.push(i); }
}
check("host-dialogs.ps1 is pure ASCII", nonAscii.length === 0,
      "first non-ASCII byte at offset " + nonAscii[0]);

console.log("");
if (failures.length) {
  console.log(failures.length + " FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
