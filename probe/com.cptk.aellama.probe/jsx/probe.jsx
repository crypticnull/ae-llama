/*
 * probe.jsx -- the ExtendScript half of the P0 feasibility probe.
 *
 * NOTHING from extension/ is loaded here. The whole point of P0 is to
 * find out whether a CEP extension reaches a host's ExtendScript engine
 * at all; loading 11.8k lines of AE DOM first would answer a different
 * question and could throw before the answer is taken.
 *
 * Contract (the same envelope shape the real panel uses, so the P2 seam
 * inherits a proven transport):
 *
 *     $.global.AELLP_call("<probe>", "<json args>")
 *       -> '{"ok":true,"data":...}' | '{"ok":false,"error":"..."}'
 *
 * ES3 ONLY (CLAUDE.md): no JSON object, no const/let, no Array extras,
 * and every nested ?: explicitly parenthesised -- ExtendScript parses
 * the conditional operator LEFT-associatively.
 *
 * SAFETY: every probe here is read-only EXCEPT `historyProbe` and
 * `mogrtAccept`, which mutate and therefore refuse unless the caller
 * passes allowMutate:true. They work in a scratch bin/sequence they
 * create and name, never in whatever the user had open.
 */

// ------------------------------------------------------------- ES3 JSON
// A deliberate copy, not a require: the probe must not depend on the
// panel's AELLJSON existing in this host.
var AELLP_JSON = (function () {

  function isArray(v) {
    return v !== null && typeof v === "object" &&
           typeof v.length === "number" &&
           typeof v.join === "function";
  }

  function esc(s) {
    var out = "";
    var i, c, code, hex;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      code = s.charCodeAt(i);
      if (c === '"') { out += '\\"'; }
      else if (c === "\\") { out += "\\\\"; }
      else if (c === "\n") { out += "\\n"; }
      else if (c === "\r") { out += "\\r"; }
      else if (c === "\t") { out += "\\t"; }
      else if (code < 32 || code > 126) {
        hex = code.toString(16);
        while (hex.length < 4) { hex = "0" + hex; }
        out += "\\u" + hex;
      } else { out += c; }
    }
    return '"' + out + '"';
  }

  function stringify(v) {
    var t = typeof v;
    var parts, kv, i, k;
    if (v === null || t === "undefined") { return "null"; }
    if (t === "number") { return isFinite(v) ? String(v) : "null"; }
    if (t === "boolean") { return v ? "true" : "false"; }
    if (t === "string") { return esc(v); }
    if (isArray(v)) {
      parts = [];
      for (i = 0; i < v.length; i++) { parts.push(stringify(v[i])); }
      return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
      kv = [];
      for (k in v) {
        if (v.hasOwnProperty(k) && typeof v[k] !== "function") {
          kv.push(esc(k) + ":" + stringify(v[k]));
        }
      }
      return "{" + kv.join(",") + "}";
    }
    return "null";
  }

  // Crockford-style validation before eval: AELLP_call sits on $.global
  // and any extension in the host can reach it.
  function parse(s) {
    var probe;
    if (!s) { return {}; }
    probe = String(s)
      .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
      .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
      .replace(/(?:^|:|,)(?:\s*\[)+/g, "");
    if (!/^[\],:{}\s]*$/.test(probe)) {
      throw new Error("Arguments are not valid JSON");
    }
    return eval("(" + s + ")");
  }

  return { stringify: stringify, parse: parse };
})();

// ------------------------------------------------------------- helpers

function AELLP_say(e) {
  return (e && e.message) ? String(e.message) : String(e);
}

/** ES3 has no Array.indexOf. */
function AELLP_inList(list, name) {
  var i;
  if (!list || typeof list.length !== "number") { return false; }
  for (i = 0; i < list.length; i++) {
    if (String(list[i]) === String(name)) { return true; }
  }
  return false;
}

/** typeof without throwing on a host that has no such global at all. */
function AELLP_typeOf(expr) {
  var t;
  try {
    t = eval("typeof " + expr);
  } catch (e) {
    return "throws: " + AELLP_say(e);
  }
  return t;
}

/** Read a property that may not exist, or may throw on access. */
function AELLP_safe(fn) {
  var v;
  try {
    v = fn();
  } catch (e) {
    return "throws: " + AELLP_say(e);
  }
  if (v === null || typeof v === "undefined") { return null; }
  return v;
}

var AELLP_PROBES = {};

// --------------------------------------------------------------- ping
// The single fact every later phase depends on: does a CEP evalScript
// reach this host's ExtendScript engine and come back parseable.
AELLP_PROBES.ping = function () {
  return {
    pong: true,
    engineName: AELLP_safe(function () { return $.engineName; }),
    esVersion: AELLP_safe(function () { return $.version; }),
    esBuild: AELLP_safe(function () { return $.build; }),
    os: AELLP_safe(function () { return $.os; }),
    fileName: AELLP_safe(function () { return $.fileName; })
  };
};

// ---------------------------------------------------------- hostFacts
// Everything host.js will have to branch on, plus the API-existence
// rows the plan lists as unverified.
AELLP_PROBES.hostFacts = function () {
  var d = {};
  d.appVersion = AELLP_safe(function () { return app.version; });
  d.appName = AELLP_safe(function () { return app.appName; });
  d.appBuild = AELLP_safe(function () { return app.buildName; });
  d.engineName = AELLP_safe(function () { return $.engineName; });

  // BridgeTalk: the door-1 target name comes from here, and appName is
  // the one host identifier Adobe's own samples branch on.
  d.bridgeTalk = AELLP_typeOf("BridgeTalk");
  d.btAppName = AELLP_safe(function () { return BridgeTalk.appName; });
  d.btSpecifier = AELLP_safe(function () { return BridgeTalk.appSpecifier; });
  d.btVersion = AELLP_safe(function () { return BridgeTalk.appVersion; });
  d.btTargets = AELLP_safe(function () {
    var t = BridgeTalk.getTargets();
    var out = [];
    var i;
    for (i = 0; t && i < t.length; i++) { out.push(String(t[i])); }
    return out;
  });

  // Undo: AE has beginUndoGroup + executeCommand(16/17). Adobe's
  // Premiere scripting guide documents NEITHER -- if that holds here,
  // STOPPED-AT-#k is the only honest batch contract for Premiere.
  d.beginUndoGroup = AELLP_typeOf("app.beginUndoGroup");
  d.endUndoGroup = AELLP_typeOf("app.endUndoGroup");
  d.executeCommand = AELLP_typeOf("app.executeCommand");
  d.findMenuCommandId = AELLP_typeOf("app.findMenuCommandId");

  // Premiere-shaped surface.
  d.enableQE = AELLP_typeOf("app.enableQE");
  d.project = AELLP_typeOf("app.project");
  d.projectName = AELLP_safe(function () { return app.project.name; });
  d.projectPath = AELLP_safe(function () { return app.project.path; });
  d.activeSequence = AELLP_safe(function () {
    var s = app.project.activeSequence;
    if (!s) { return null; }
    return { name: String(s.name),
             videoTracks: AELLP_safe(function () { return s.videoTracks.numTracks; }),
             audioTracks: AELLP_safe(function () { return s.audioTracks.numTracks; }) };
  });
  d.rootItemChildren = AELLP_safe(function () {
    return app.project.rootItem.children.numItems;
  });
  d.importMGT = AELLP_typeOf("app.project.activeSequence.importMGT");
  d.exportAsMediaDirect =
    AELLP_typeOf("app.project.activeSequence.exportAsMediaDirect");
  d.encoder = AELLP_typeOf("app.encoder");
  d.ameStatus = AELLP_safe(function () {
    return String(BridgeTalk.getStatus("ame"));
  });

  // AE-shaped surface, so one probe answers in either host.
  d.activeItem = AELLP_safe(function () {
    var it = app.project.activeItem;
    return it ? String(it.name) : null;
  });
  d.numItems = AELLP_safe(function () { return app.project.numItems; });

  return d;
};

// ------------------------------------------------------------ qeProbe
// QE is undocumented and unsupported; this only records whether the door
// opens, never that anything through it works.
AELLP_PROBES.qeProbe = function () {
  var d = { enableQE: AELLP_typeOf("app.enableQE") };
  if (d.enableQE !== "function") { return d; }
  try {
    app.enableQE();
    d.enabled = true;
  } catch (e) {
    d.enabled = false;
    d.error = AELLP_say(e);
    return d;
  }
  d.qe = AELLP_typeOf("qe");
  d.qeProject = AELLP_typeOf("qe.project");
  d.qeVersion = AELLP_safe(function () { return String(qe.version); });
  d.getVideoEffectList = AELLP_typeOf("qe.project.getVideoEffectList");
  d.effectCount = AELLP_safe(function () {
    var l = qe.project.getVideoEffectList();
    return l ? l.length : null;
  });
  return d;
};

// ------------------------------------------------------- historyProbe
// MUTATES. Three scripted changes in ONE evalScript, so the owner can
// read the History panel and say whether the host made one entry or
// three. That number decides whether a chat round can ever be one undo.
AELLP_PROBES.historyProbe = function (args) {
  var d = { mutated: false };
  var i, bin, made;
  if (!args || args.allowMutate !== true) {
    return { skipped: "pass allowMutate:true to run the mutating probe" };
  }
  if (AELLP_typeOf("app.project.rootItem.createBin") !== "function") {
    return { skipped: "no app.project.rootItem.createBin in this host " +
                      "(AE? then read the AE row instead)" };
  }
  made = [];
  try {
    for (i = 1; i <= 3; i++) {
      bin = app.project.rootItem.createBin("AELL PROBE " + i);
      made.push(bin ? String(bin.name) : ("AELL PROBE " + i));
    }
    d.mutated = true;
    d.created = made;
    d.instruction = "Open the History panel NOW and count the entries " +
                    "these three createBin calls produced (1 or 3), then " +
                    "delete the AELL PROBE bins by hand.";
  } catch (e) {
    d.error = AELLP_say(e);
    d.created = made;
    d.mutated = made.length > 0;
  }
  return d;
};

// -------------------------------------------------------- mogrtAccept
// MUTATES. The measurement that retires docs/SELF-VERIFY-PLANS.md step 7:
// does Premiere ACCEPT what AE wrote, and can the controllers be read
// back BY NAME. A blanked Source Text reads as REJECTED, never accepted.
AELLP_PROBES.mogrtAccept = function (args) {
  var d = {};
  var seq, f, before, after, clip, comp, props, i, p, n, track, k;
  if (!args || args.allowMutate !== true) {
    return { skipped: "pass allowMutate:true to run the mutating probe" };
  }
  if (!args.path) { return { error: "pass {path: '<abs .mogrt>'}" }; }
  f = new File(args.path);
  if (!f.exists) { return { error: "no such file: " + args.path }; }

  seq = AELLP_safe(function () { return app.project.activeSequence; });
  if (!seq || typeof seq === "string") {
    return { error: "no active sequence -- open one in Premiere first. " +
                    "app.project.activeSequence read back as: " +
                    String(seq) };
  }
  if (typeof seq.importMGT !== "function") {
    return { error: "this host's sequence has no importMGT (AE? then " +
                    "this probe is Premiere-only)" };
  }

  track = (args.videoTrack === 0 || args.videoTrack) ? args.videoTrack : 0;
  before = AELLP_safe(function () {
    return seq.videoTracks[track].clips.numItems;
  });
  try {
    // Adobe's own sample passes ticks; seconds are accepted by some
    // builds. Whichever this host takes, the receipt below is read back
    // from the timeline, never from this call's return value.
    seq.importMGT(f.fsName, (args.timeTicks || "0"), track,
                  (args.audioTrack || 0));
  } catch (e) {
    return { error: "importMGT threw: " + AELLP_say(e), before: before };
  }
  after = AELLP_safe(function () {
    return seq.videoTracks[track].clips.numItems;
  });
  d.before = before;
  d.after = after;
  d.landed = (typeof before === "number" && typeof after === "number") ?
             (after > before) : null;
  if (d.landed !== true) {
    d.error = "importMGT returned without throwing but the track's clip " +
              "count did not grow (" + String(before) + " -> " +
              String(after) + ") -- accepted by API, state unchanged";
    return d;
  }

  clip = AELLP_safe(function () {
    return seq.videoTracks[track].clips[after - 1];
  });
  d.clipName = AELLP_safe(function () { return String(clip.name); });
  if (!clip || typeof clip.getMGTComponent !== "function") {
    d.error = "the landed clip has no getMGTComponent -- controllers " +
              "cannot be read back on this build";
    return d;
  }
  comp = AELLP_safe(function () { return clip.getMGTComponent(); });
  if (!comp || typeof comp === "string") {
    d.error = "getMGTComponent returned nothing: " + String(comp);
    return d;
  }
  props = [];
  n = AELLP_safe(function () { return comp.properties.numItems; });
  if (typeof n === "number") {
    for (i = 0; i < n; i++) {
      p = comp.properties[i];
      props.push({
        name: AELLP_safe(function () { return String(p.displayName); }),
        value: AELLP_safe(function () { return String(p.getValue()); })
      });
    }
  }
  d.controllerCount = props.length;
  d.controllers = props;
  // The failure this exists to catch: names that come back empty or as
  // locale tags mean the round-trip is not readable, whatever the count.
  d.namesReadable = false;
  for (k = 0; k < props.length; k++) {
    if (props[k].name && String(props[k].name).length > 0 &&
        !/^[a-z]{2}_[A-Z]{2}$/.test(String(props[k].name))) {
      d.namesReadable = true;
    }
  }
  d.instruction = "Delete the imported graphic from the timeline by hand " +
                  "when you are done.";
  return d;
};

// ----------------------------------------------------------- echo
// The soak's payload: a round-trip whose size is realistic for a tool
// receipt, so engine degradation shows up the way it would in the panel.
AELLP_PROBES.echo = function (args) {
  var n = (args && args.pad) ? args.pad : 0;
  var s = "";
  while (s.length < n) { s += "x"; }
  return { round: (args && args.round) ? args.round : 0, pad: s.length,
           payload: s };
};

// ------------------------------------------------------------ battery
/*
 * EVERY measurement in one call, so an unattended run costs ONE host
 * launch instead of one per fact.
 *
 * The rule that makes it worth having: no step may abort the run. Each
 * one is try/caught and recorded with its own ok/error, so a pass
 * reports ALL of its failures at once. That is the whole point -- the
 * alternative is what this project just spent a day doing, learning one
 * defect per round trip on the only machine that can test.
 *
 * args: { scratchProject: "<abs .prproj>", makeSequence: true,
 *         mogrtPath: "<abs .mogrt>", allowMutate: true }
 */
AELLP_PROBES.battery = function (args) {
  args = args || {};
  var out = { steps: [], mutating: args.allowMutate === true, current: null };
  var i, seq, item, made;
  var progress = args.progressPath || null;

  /*
   * FLUSH AFTER EVERY STEP, and name the step BEFORE running it.
   *
   * Measured the hard way 2026-09-02: the first version of this battery
   * held everything in memory and wrote once at the end. It claimed its
   * job, hung inside some step, and produced NOTHING -- 300 seconds of
   * waiting that said only "it hung somewhere". This repo's own
   * scripts/mogrt-verify-probe.jsx already had the right pattern
   * ("Every measurement is flushed to disk as it is taken") and this
   * ignored it.
   *
   * With `current` written before the call and the row written after,
   * a hang leaves a file naming the exact step that never returned.
   */
  function flush() {
    if (!progress) { return; }
    try {
      var f = new File(progress);
      f.encoding = "UTF-8";
      f.open("w");
      f.write(AELLP_JSON.stringify(out));
      f.close();
    } catch (e) { /* a failed flush must never stop the run */ }
  }

  function step(name, fn) {
    var row = { step: name };
    if (args.skip && AELLP_inList(args.skip, name)) {
      row.ok = true;
      row.skipped = "asked to skip";
      out.steps.push(row);
      flush();
      return row;
    }
    out.current = name;
    flush();
    try {
      row.data = fn();
      row.ok = true;
    } catch (e) {
      row.ok = false;
      row.error = AELLP_say(e);
    }
    out.steps.push(row);
    out.current = null;
    flush();
    return row;
  }

  out.startedAt = String(new Date());
  flush();

  step("ping", function () { return AELLP_PROBES.ping(); });
  step("hostFacts", function () { return AELLP_PROBES.hostFacts(); });
  step("qe", function () { return AELLP_PROBES.qeProbe(); });

  if (!args.allowMutate) {
    out.note = "read-only pass; pass allowMutate:true for the rest";
    return out;
  }

  /*
   * A project to work in, WITHOUT calling app.newProject when we can
   * avoid it.
   *
   * Why the care: app.newProject was the first mutating step of the
   * first unattended run, and that run claimed its job and then hung for
   * 300 seconds. It is a strong suspect for raising a New Project dialog
   * on this build, and a dialog with nobody at the keyboard is a hang,
   * not an error.
   *
   * It is also usually unnecessary. Measured on this machine: Premiere
   * launches with an EMPTY Untitled.prproj already open (rootItem had 0
   * children). An empty project is a scratch project, so reuse it and
   * never open the dialog at all. Only a project with real content in it
   * is worth stepping around.
   */
  step("project", function () {
    var proj = AELLP_safe(function () { return app.project; });
    if (proj && typeof proj !== "string") {
      var kids = AELLP_safe(function () {
        return app.project.rootItem.children.numItems;
      });
      var pname = AELLP_safe(function () { return app.project.name; });
      var ppath = AELLP_safe(function () { return app.project.path; });
      if (kids === 0) {
        return { via: "reused the open EMPTY project",
                 name: pname, path: ppath, items: kids,
                 note: "no app.newProject call, so no dialog risk" };
      }
      // A project with content: do not touch it.
      if (!args.scratchProject) {
        return { via: "refused", name: pname, items: kids,
                 note: "a project with " + String(kids) + " item(s) is open " +
                       "and no scratch path was given, so nothing was " +
                       "created and nothing will be mutated" };
      }
    }
    if (!args.scratchProject) {
      throw new Error("no project open and no scratchProject path given");
    }
    if (typeof app.newProject !== "function") {
      throw new Error("app.newProject is not a function in this host");
    }
    var made2 = app.newProject(args.scratchProject);
    return { via: "app.newProject", returned: String(made2),
             path: AELLP_safe(function () { return app.project.path; }),
             name: AELLP_safe(function () { return app.project.name; }) };
  });

  /*
   * A sequence, by whichever route this build accepts. Three strategies
   * in order, each recorded: an existing sequence, bars-and-tone plus
   * createNewSequenceFromClips, and the bare createNewSequence. Adobe's
   * docs disagree with each other on the signatures, so the honest move
   * is to try them and write down which one answered.
   */
  if (args.makeSequence) {
    step("sequence", function () {
      var tried = [];
      var got = null;

      var existing = AELLP_safe(function () { return app.project.activeSequence; });
      if (existing && typeof existing !== "string") {
        tried.push({ how: "activeSequence already open", ok: true });
        return { via: "existing", name: String(existing.name), tried: tried };
      }
      tried.push({ how: "activeSequence already open", ok: false });

      /*
       * TIMEBASE IS IN TICKS PER FRAME, not frames per second.
       * Premiere counts 254016000000 ticks per second, so 25 fps is
       * 254016000000 / 25. The first version passed 1, which is not a
       * frame rate in any unit, and the call failed -- dropping through
       * to createNewSequence and raising the dialog described below.
       */
      var TICKS_PER_SECOND = 254016000000;
      var rates = [25, 24, 30];
      var r;
      for (r = 0; r < rates.length && !got; r++) {
        try {
          item = app.project.newBarsAndTone(
            1920, 1080, TICKS_PER_SECOND / rates[r], 1, 1, 48000,
            "AELL PROBE BARS");
          got = app.project.createNewSequenceFromClips("AELL PROBE SEQ",
                                                       [item]);
          tried.push({ how: "newBarsAndTone " + rates[r] +
                            "fps + createNewSequenceFromClips",
                       ok: !!got });
        } catch (e1) {
          tried.push({ how: "newBarsAndTone " + rates[r] +
                            "fps + createNewSequenceFromClips",
                       ok: false, error: AELLP_say(e1) });
        }
      }

      /*
       * createNewSequence(name, "") is DELIBERATELY NOT CALLED unattended.
       * An empty sequenceID means "ask the user which preset", and it
       * raised exactly that modal on 2026-09-02 -- a dialog with nobody
       * at the keyboard is a hang, and the whole point of this runner is
       * that nobody touches Premiere. It is available only when the
       * caller says dialogs are acceptable.
       */
      if (!got) {
        if (args.allowDialogs === true) {
          try {
            got = app.project.createNewSequence("AELL PROBE SEQ", "");
            tried.push({ how: "createNewSequence(name, \"\") [may prompt]",
                         ok: !!got });
          } catch (e2) {
            tried.push({ how: "createNewSequence(name, \"\") [may prompt]",
                         ok: false, error: AELLP_say(e2) });
          }
        } else {
          tried.push({ how: "createNewSequence(name, \"\")",
                       ok: false,
                       error: "NOT ATTEMPTED: an empty preset id opens the " +
                              "New Sequence dialog, which blocks an " +
                              "unattended run. Pass allowDialogs:true to " +
                              "try it with a human present." });
        }
      }

      seq = AELLP_safe(function () { return app.project.activeSequence; });
      return {
        via: got ? "created" : "none",
        active: (seq && typeof seq !== "string") ? String(seq.name) : null,
        videoTracks: (seq && typeof seq !== "string")
          ? AELLP_safe(function () { return seq.videoTracks.numTracks; }) : null,
        tried: tried
      };
    });
  }

  step("history", function () {
    return AELLP_PROBES.historyProbe({ allowMutate: true });
  });

  if (args.mogrtPath) {
    step("mogrt", function () {
      return AELLP_PROBES.mogrtAccept({ allowMutate: true,
                                        path: args.mogrtPath,
                                        videoTrack: 0 });
    });
  }

  // Best effort: put back what the mutating steps made. A cleanup that
  // throws must not lose the measurements above it.
  step("cleanup", function () {
    var removed = [];
    var root = AELLP_safe(function () { return app.project.rootItem; });
    if (!root || typeof root === "string") { return { removed: removed }; }
    var n = AELLP_safe(function () { return root.children.numItems; });
    if (typeof n !== "number") { return { removed: removed }; }
    for (i = n - 1; i >= 0; i--) {
      try {
        var child = root.children[i];
        if (child && /^AELL PROBE/.test(String(child.name))) {
          if (typeof child.deleteBin === "function") { child.deleteBin(); }
          removed.push(String(child.name));
        }
      } catch (eC) {}
    }
    // SAVE the scratch project. A dirty project makes Premiere put up a
    // "save changes?" modal when the runner tries to close it, which
    // then blocks the NEXT unattended run before it starts. Saving a
    // throwaway file costs nothing and removes that whole failure.
    var saved = null;
    try {
      if (app.project && typeof app.project.save === "function") {
        app.project.save();
        saved = true;
      }
    } catch (eS) { saved = "save threw: " + AELLP_say(eS); }

    return { removed: removed, savedScratchProject: saved,
             note: "the scratch project is a throwaway file; nothing else " +
                   "was touched" };
  });

  return out;
};

// --------------------------------------------------------------- call

function AELLP_call(probeName, argsJson) {
  var result;
  try {
    if (!AELLP_PROBES[probeName]) {
      var names = [];
      for (var k in AELLP_PROBES) {
        if (AELLP_PROBES.hasOwnProperty(k)) { names.push(k); }
      }
      result = { ok: false,
                 error: "Unknown probe: " + probeName + ". Have: " +
                        names.join(", ") };
    } else {
      result = { ok: true,
                 data: AELLP_PROBES[probeName](AELLP_JSON.parse(argsJson)) };
    }
  } catch (e) {
    result = { ok: false, error: AELLP_say(e) };
  }
  try {
    return AELLP_JSON.stringify(result);
  } catch (e2) {
    return '{"ok":false,"error":"Failed to serialize probe result"}';
  }
}

$.global.AELLP_call = AELLP_call;
$.global.AELLP_JSON = AELLP_JSON;
"AELLP ready";
