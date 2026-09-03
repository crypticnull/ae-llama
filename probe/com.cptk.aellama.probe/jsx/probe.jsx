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
  // The two routes to HAVING a project, and they are not
  // interchangeable: newProject refuses a path that is already taken
  // (measured 2026-09-03), openDocument is the one for a file that
  // exists and the only one with suppress-the-dialog flags.
  d.newProject = AELLP_typeOf("app.newProject");
  d.openDocument = AELLP_typeOf("app.openDocument");
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

// ------------------------------------------------- track clip snapshot
/*
 * A picture of one video track's clips, taken so the NEW clip can be
 * found by DIFFING and not by guessing an index.
 *
 * Measured 2026-09-03 on 26.3.2: after `importMGT` grew track 0 from 1
 * clip to 2, `clips[after - 1]` was still `icon-normal.png` -- the seed
 * the sequence was built from. The last index is not "the one just
 * added"; Premiere places the graphic at the insertion TIME, so the new
 * clip can land anywhere in the collection. Asking the wrong clip for
 * `getMGTComponent` answers null, which reads exactly like "this build
 * cannot read controllers back".
 *
 * `nodeId` is the identity if the build exposes it; name + start ticks
 * is the fallback, and it is a MULTISET compare so two clips that share
 * a signature cannot both be called new.
 */
function AELLP_clipSnap(seq, track) {
  var out = [];
  var n, i;
  n = AELLP_safe(function () { return seq.videoTracks[track].clips.numItems; });
  if (typeof n !== "number") { return out; }
  for (i = 0; i < n; i++) {
    out.push((function (idx) {
      var c = AELLP_safe(function () {
        return seq.videoTracks[track].clips[idx];
      });
      if (!c || typeof c === "string") {
        return { index: idx, name: null, start: null, nodeId: null };
      }
      return {
        index: idx,
        name: AELLP_safe(function () { return String(c.name); }),
        start: AELLP_safe(function () { return String(c.start.ticks); }),
        nodeId: AELLP_safe(function () { return String(c.nodeId); })
      };
    })(i));
  }
  return out;
}

// Usable identity only: AELLP_safe hands back "throws: ..." for a read
// that failed and null for one that was not there, and neither may be
// matched against as though it were an id.
function AELLP_clipId(c) {
  var id = c.nodeId;
  if (id && typeof id === "string" && id.length > 0 &&
      id !== "null" && id !== "undefined" &&
      id.indexOf("throws:") !== 0) {
    return "node:" + id;
  }
  if (c.name === null || c.start === null) { return null; }
  if (String(c.name).indexOf("throws:") === 0) { return null; }
  if (String(c.start).indexOf("throws:") === 0) { return null; }
  return "sig:" + String(c.name) + "@" + String(c.start);
}

/*
 * Which clip in `after` is not accounted for by `before`. Returns
 * { clip, how, added } -- `how` is part of the receipt on purpose: a
 * measurement taken from a FALLBACK pick is weaker evidence than one
 * taken from a clean diff, and the reader has to be able to tell.
 */
function AELLP_newClip(before, after) {
  var used = [];
  var added = [];
  var i, j, id, bid, matched;
  for (i = 0; i < before.length; i++) { used.push(false); }
  for (i = 0; i < after.length; i++) {
    id = AELLP_clipId(after[i]);
    matched = false;
    if (id !== null) {
      for (j = 0; j < before.length; j++) {
        if (used[j]) { continue; }
        bid = AELLP_clipId(before[j]);
        if (bid !== null && bid === id) {
          used[j] = true;
          matched = true;
          break;
        }
      }
    }
    if (!matched) { added.push(after[i]); }
  }
  if (added.length === 1) {
    return { clip: added[0], how: "diff", added: added };
  }
  if (added.length === 0) {
    return { clip: null, how: "no-new-clip", added: added };
  }
  return { clip: null, how: "ambiguous-" + added.length, added: added };
}

// -------------------------------------------------------- mogrtAccept
// MUTATES. The measurement that retires docs/SELF-VERIFY-PLANS.md step 7:
// does Premiere ACCEPT what AE wrote, and can the controllers be read
// back BY NAME. A blanked Source Text reads as REJECTED, never accepted.
AELLP_PROBES.mogrtAccept = function (args) {
  var d = {};
  var seq, f, before, after, clip, comp, props, i, p, n, track, k;
  var beforeSnap, afterSnap, found;
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
  beforeSnap = AELLP_clipSnap(seq, track);
  before = beforeSnap.length;
  try {
    // Adobe's own sample passes ticks; seconds are accepted by some
    // builds. Whichever this host takes, the receipt below is read back
    // from the timeline, never from this call's return value.
    seq.importMGT(f.fsName, (args.timeTicks || "0"), track,
                  (args.audioTrack || 0));
  } catch (e) {
    return { error: "importMGT threw: " + AELLP_say(e), before: before };
  }
  afterSnap = AELLP_clipSnap(seq, track);
  after = afterSnap.length;
  d.before = before;
  d.after = after;
  d.landed = after > before;
  if (d.landed !== true) {
    d.error = "importMGT returned without throwing but the track's clip " +
              "count did not grow (" + String(before) + " -> " +
              String(after) + ") -- accepted by API, state unchanged";
    return d;
  }

  // The clip just added is the one the BEFORE picture cannot account
  // for. Never clips[after - 1]: measured 26.3.2, that was the seed.
  found = AELLP_newClip(beforeSnap, afterSnap);
  d.pickedBy = found.how;
  d.trackBefore = beforeSnap;
  d.trackAfter = afterSnap;
  if (!found.clip) {
    d.error = "the track grew but no single clip could be identified as " +
              "the new one (" + found.how + "); candidates: " +
              String(found.added.length) + ". Clip identity on this " +
              "build is not diffable, so the controller round-trip was " +
              "NOT measured -- an index guess would report the seed.";
    return d;
  }
  d.clipIndex = found.clip.index;
  d.clipName = found.clip.name;
  clip = AELLP_safe(function () {
    return seq.videoTracks[track].clips[found.clip.index];
  });
  if (!clip || typeof clip === "string") {
    d.error = "the new clip at index " + String(found.clip.index) +
              " could not be re-read: " + String(clip);
    return d;
  }
  if (typeof clip.getMGTComponent !== "function") {
    d.error = "the landed clip has no getMGTComponent -- controllers " +
              "cannot be read back on this build";
    return d;
  }
  comp = AELLP_safe(function () { return clip.getMGTComponent(); });
  if (!comp || typeof comp === "string") {
    d.error = "getMGTComponent returned nothing for the clip the diff " +
              "identified as new (index " + String(found.clip.index) +
              ", name " + String(found.clip.name) + "): " + String(comp);
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
      /*
       * A step that RETURNS an error is not a step that passed.
       *
       * Measured 2026-09-02: the runner printed "Every battery step
       * passed" on a run where the sequence was never created, History
       * was skipped for a missing API, and the MOGRT step refused for
       * want of a sequence. Only a THROW was counted as failure, so
       * three dead measurements reported green. That is the exact false
       * success this project exists to refuse.
       */
      if (row.data && typeof row.data === "object") {
        if (row.data.error) {
          row.ok = false;
          row.error = String(row.data.error);
        } else if (row.data.skipped) {
          row.ok = true;
          row.skipped = String(row.data.skipped);
        } else if (row.data.via === "none" || row.data.via === "refused") {
          row.ok = false;
          row.error = "did not achieve its purpose (via: " +
                      String(row.data.via) + ")";
        } else {
          row.ok = true;
        }
      } else {
        row.ok = true;
      }
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

  /*
   * WAIT FOR THE HOST TO BE READY before measuring anything that needs a
   * project.
   *
   * Measured 2026-09-02: the invisible runner fires on the host's
   * startup event, which happens BEFORE Premiere has finished opening a
   * project. app.project.name and .path both read back null, so the
   * project step fell through to app.newProject, newBarsAndTone raised
   * "Illegal Parameter type", rootItem.createBin looked absent, and the
   * MOGRT step had no sequence to import into. Four failures, one cause:
   * we asked too early.
   */
  step("waitForReady", function () {
    var waited = 0;
    var stepMs = 500;
    var maxMs = (typeof args.readyTimeoutMs === "number")
      ? args.readyTimeoutMs : 30000;
    var name = null;
    while (waited < maxMs) {
      name = AELLP_safe(function () { return app.project.name; });
      if (name && typeof name === "string" && name.length > 0) {
        return { ready: true, waitedMs: waited, projectName: name };
      }
      try { $.sleep(stepMs); } catch (eSleep) { break; }
      waited += stepMs;
    }
    // NOT an error: Premiere launched without a project argument simply
    // has none, and the `project` step below is what creates one and
    // carries the real verdict. Reporting a failure here would blame the
    // wait for a condition it only observed.
    return { ready: false, waitedMs: waited,
             note: "app.project.name was still empty after " + waited +
                   "ms; the project step will try to create one" };
  });

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

    /*
     * Premiere launched with no argument sits on the HOME SCREEN and
     * never opens a project: measured 2026-09-02, app.project.name was
     * still empty after a full 30 s wait. So one has to be made, and
     * then VERIFIED -- app.newProject returned without writing a file
     * once already, which left a dead path in Premiere's recent list.
     *
     * Every route is recorded, and success means the project NAME reads
     * back, not that the call failed to throw.
     */
    var tried = [];
    var got = null;

    function nameNow() {
      var n = AELLP_safe(function () { return app.project.name; });
      return (n && typeof n === "string" && n.length > 0) ? n : null;
    }

    /** Creating a project is not instant; give it a bounded moment. */
    function settle(ms) {
      var waited = 0;
      var n = null;
      while (waited < ms) {
        n = nameNow();
        if (n) { return n; }
        try { $.sleep(250); } catch (eS) { return null; }
        waited += 250;
      }
      return nameNow();
    }

    /*
     * THE PATH MAY ALREADY BE TAKEN, and that is not a small detail:
     * measured 2026-09-03 on 26.3.2, app.newProject against an existing
     * file returns FALSE, leaves app.project.name empty, and drops an
     * AELL_PROBE_SCRATCH<guid> sidecar in the folder. Three runs in a
     * row failed that way before anyone looked at the folder.
     *
     * A file that exists wants openDocument, not newProject -- and
     * openDocument is the better unattended call anyway, because it
     * takes four suppress-the-dialog flags and this runner's whole
     * contract is that no modal ever appears.
     */
    var scratchFile = null;
    try { scratchFile = new File(args.scratchProject); } catch (eF) { scratchFile = null; }
    var pathWasTaken = !!(scratchFile && scratchFile.exists);

    if (pathWasTaken) {
      if (typeof app.openDocument === "function") {
        try {
          /* (path, suppressConversion, bypassLocateFile, bypassWarning,
              suppressLoadingProjectManager) - every one of them a modal
              that would hang an unattended run. */
          var opened = app.openDocument(args.scratchProject,
                                        true, true, true, true);
          got = settle(8000);
          tried.push({ how: "app.openDocument [the file already existed]",
                       ok: !!got,
                       error: got ? null
                                  : ("returned " + String(opened) +
                                     " but app.project.name is still empty") });
        } catch (eOpen) {
          tried.push({ how: "app.openDocument [the file already existed]",
                       ok: false, error: AELLP_say(eOpen) });
        }
      } else {
        tried.push({ how: "app.openDocument [the file already existed]",
                     ok: false, error: "not a function in this host" });
      }

      if (got) { gotVia = "opened the existing scratch project"; }

      /*
       * Still nothing, so the file is only in the way. It is THIS
       * script's own throwaway at a path this script chose, never the
       * owner's project, so move it aside and let the create route
       * below run against a free path. Renamed and not deleted: the
       * run that wrote it may be worth reading later.
       */
      if (!got) {
        try {
          var aside = scratchFile.name + ".stale-" +
                      String(new Date().getTime());
          var moved = scratchFile.rename(aside);
          tried.push({ how: "moved the existing file aside as " + aside,
                       ok: !!moved,
                       error: moved ? null : "rename refused" });
        } catch (eMove) {
          tried.push({ how: "moved the existing file aside",
                       ok: false, error: AELLP_say(eMove) });
        }
      }
    }

    if (!got && typeof app.newProject === "function") {
      try {
        var ret = app.newProject(args.scratchProject);
        got = settle(8000);
        if (got) { gotVia = "created"; }
        tried.push({ how: "app.newProject", ok: !!got,
                     error: got ? null
                                : ("returned " + String(ret) +
                                   " but app.project.name is still empty") });
      } catch (eNew) {
        tried.push({ how: "app.newProject", ok: false,
                     error: AELLP_say(eNew) });
      }
    } else if (!got) {
      /* Only a REAL gap gets reported. Saying "not a function" after
         openDocument has already answered would be a false row. */
      tried.push({ how: "app.newProject", ok: false,
                   error: "not a function in this host" });
    }

    // QE is measured alive on this build (236 effects), and it has its
    // own project creator. Undocumented and unsupported, so it is a
    // fallback and it is labelled as one.
    if (!got && typeof app.enableQE === "function") {
      try {
        app.enableQE();
        if (qe && qe.project && typeof qe.project.newProject === "function") {
          qe.project.newProject(args.scratchProject);
          got = settle(8000);
          if (got) { gotVia = "created via QE"; }
          tried.push({ how: "qe.project.newProject [unsupported API]",
                       ok: !!got });
        } else {
          tried.push({ how: "qe.project.newProject [unsupported API]",
                       ok: false, error: "qe.project.newProject absent" });
        }
      } catch (eQe) {
        tried.push({ how: "qe.project.newProject [unsupported API]",
                     ok: false, error: AELLP_say(eQe) });
      }
    }

    // Save it, so the NEXT run can be launched straight into it and this
    // whole dance never happens again.
    var savedTo = null;
    if (got) {
      try {
        if (typeof app.project.saveAs === "function") {
          app.project.saveAs(args.scratchProject);
          savedTo = args.scratchProject;
        } else if (typeof app.project.save === "function") {
          app.project.save();
          savedTo = AELLP_safe(function () { return app.project.path; });
        }
      } catch (eSave) { savedTo = "save failed: " + AELLP_say(eSave); }
    }

    return { via: gotVia,
             name: got,
             path: AELLP_safe(function () { return app.project.path; }),
             items: AELLP_safe(function () {
               return app.project.rootItem.children.numItems;
             }),
             savedTo: savedTo,
             tried: tried,
             error: got ? null
                        : "no project could be opened or created; Premiere " +
                          "is on the Home screen and every project-dependent " +
                          "step below cannot run" };
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
       * SEED MEDIA FIRST. createNewSequenceFromClips derives the whole
       * sequence from a clip, so it needs no preset and opens no dialog.
       * Importing a still the repo already ships is the least exotic way
       * to get a clip: newBarsAndTone answered "Illegal Parameter type"
       * to every timebase tried on 26.3.2, and its signature is not
       * worth more guessing when an import cannot be ambiguous.
       */
      if (args.seedMedia) {
        try {
          var beforeN = app.project.rootItem.children.numItems;
          app.project.importFiles([args.seedMedia], true,
                                  app.project.rootItem, false);
          var afterN = app.project.rootItem.children.numItems;
          if (afterN > beforeN) {
            item = app.project.rootItem.children[afterN - 1];
            got = app.project.createNewSequenceFromClips("AELL PROBE SEQ",
                                                         [item]);
          }
          tried.push({ how: "importFiles(seed still) + " +
                            "createNewSequenceFromClips",
                       ok: !!got,
                       error: got ? null
                                  : ("import left " + String(beforeN) + " -> " +
                                     String(afterN) + " items") });
        } catch (eSeed) {
          tried.push({ how: "importFiles(seed still) + " +
                            "createNewSequenceFromClips",
                       ok: false, error: AELLP_say(eSeed) });
        }
      }

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
      for (r = 0; r < rates.length && !got; r++) {   /* skipped once got */
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
    /*
     * SAVE, but NEVER with save() on an untitled project.
     *
     * A dirty project makes Premiere put up "save changes?" when the
     * runner closes it, which hangs an unattended run. But the obvious
     * fix is worse than the bug: app.project.save() on a project with
     * no path opens the SAVE AS dialog -- so the cleanup step was
     * capable of creating the very modal it existed to prevent.
     *
     * saveAs() to a known throwaway path has no dialog and no ambiguity.
     */
    var saved = null;
    try {
      var curPath = AELLP_safe(function () { return app.project.path; });
      var hasPath = (curPath && typeof curPath === "string" &&
                     curPath.length > 0);
      if (hasPath && typeof app.project.save === "function") {
        app.project.save();
        saved = "save() to " + curPath;
      } else if (args.scratchProject &&
                 typeof app.project.saveAs === "function") {
        app.project.saveAs(args.scratchProject);
        saved = "saveAs() to " + args.scratchProject;
      } else {
        saved = "NOT SAVED: the project has no path and saveAs is " +
                "unavailable, so save() would have opened the Save As " +
                "dialog and hung the run";
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
