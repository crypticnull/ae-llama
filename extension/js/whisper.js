/*
 * whisper.js — the panel's side of local speech-to-text (WORKPLAN 6.1
 * Pass C). Locates the whisper.cpp install that scripts\get-whisper.ps1
 * put under <dataRoot>\vendor\whisper.cpp, runs whisper-cli on one audio
 * file, and parses its timestamped output into caption segments.
 *
 * The install layout and the traps below are the SAME ones
 * scripts\lib\whisper-verify.ps1 documents; that file is the acquirer's
 * and the CI test's implementation, this one is the panel's, and they are
 * deliberately independent (the panel cannot shell out to PowerShell for
 * every caption). Facts measured against b4938 / ggml-base.en on
 * 2026-08-29:
 *
 *  1. SILENCE TRANSCRIBES AS THE WORD "You". Two seconds of digital
 *     silence comes back as "[00:00:00.000 --> 00:00:02.000]   You",
 *     exit code 0. So "whisper returned text" proves nothing about
 *     whether anybody spoke, and the caller must refuse a silent source
 *     BEFORE it gets here (render_comp_audio does).
 *  2. whisper-cli writes ~6 KB to STDERR (backend banner, and its whole
 *     usage screen on any argument error) and NOTHING to stdout when it
 *     fails. Node's execFile drains both pipes concurrently, so the
 *     deadlock the PowerShell version had to work around cannot happen
 *     here — but the buffer has to be big enough for a long transcript,
 *     hence maxBuffer.
 *  3. The transcriber is whisper-cli.exe. main.exe ships beside it and
 *     is a deprecation shim.
 *  4. The archive nests everything under bin\Release\, so the exe is
 *     found by walking, not by joining a fixed path.
 *  5. AE's audio-only AIFF (stereo, 16-bit, 48 kHz) decodes fine —
 *     whisper.cpp reads it through miniaudio. No conversion, no ffmpeg.
 *     Measured: a 964 674-byte AIFF straight out of render_comp_audio
 *     transcribed in 682 ms.
 */
(function (global) {
  "use strict";

  var child_process = null;
  var fs = null;
  var path = null;

  function ensureNode() {
    if (child_process) return;
    child_process = global.AEBridge.nodeRequire("child_process");
    fs = global.AEBridge.nodeRequire("fs");
    path = global.AEBridge.nodeRequire("path");
  }

  var EXE = "whisper-cli.exe";

  function installRoot() {
    ensureNode();
    return path.join(global.Settings.dataRoot(), "vendor", "whisper.cpp");
  }

  /* Every .exe under a folder, recursively. FACT 4: the release archive
   * nests under Release\, and a future one may nest differently. */
  function walkExes(dir, out, depth) {
    if (depth > 4) return out;
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    for (var i = 0; i < names.length; i++) {
      var full = path.join(dir, names[i]);
      var st = null;
      try { st = fs.statSync(full); } catch (e2) { continue; }
      if (st.isDirectory()) walkExes(full, out, depth + 1);
      else if (/\.exe$/i.test(names[i])) out.push(full);
    }
    return out;
  }

  /**
   * Locate the CLI and a model.
   *
   * Never throws: "not installed" is the normal state on a machine that
   * has not run the acquirer, and the CALLER decides whether that is a
   * refusal or a skip. On failure `reason` says what IS there — the
   * grounded-error rule, because the small local model is what reads it.
   *
   * @param {string} [wantModel] 'base.en', 'ggml-base.en' or the file
   *   name. Omitted picks the SMALLEST model present, which is the
   *   fastest one, not an alphabetical accident.
   */
  function find(wantModel) {
    ensureNode();
    var root = installRoot();
    var res = { ok: false, root: root, cli: "", model: "",
                models: [], reason: "" };

    if (!fs.existsSync(root)) {
      res.reason = "No whisper.cpp install at " + root +
        ". Run scripts\\get-whisper.ps1 to acquire one (about 150 MB).";
      return res;
    }
    var binDir = path.join(root, "bin");
    var exes = fs.existsSync(binDir) ? walkExes(binDir, [], 0) : [];
    var i, cli = "";
    for (i = 0; i < exes.length; i++) {
      if (path.basename(exes[i]).toLowerCase() === EXE) { cli = exes[i]; break; }
    }
    if (!cli) {
      var got = [];
      for (i = 0; i < exes.length; i++) got.push(path.basename(exes[i]));
      res.reason = EXE + " is not under " + binDir + ". Executables " +
        "there: " + (got.join(", ") || "(none)") +
        ". Re-run scripts\\get-whisper.ps1.";
      return res;
    }
    res.cli = cli;

    var modelsDir = path.join(root, "models");
    var bins = [];
    try {
      var all = fs.readdirSync(modelsDir);
      for (i = 0; i < all.length; i++) {
        if (!/\.bin$/i.test(all[i])) continue;
        var full = path.join(modelsDir, all[i]);
        var size = 0;
        try { size = fs.statSync(full).size; } catch (e) { size = 0; }
        bins.push({ name: all[i], full: full, size: size });
      }
    } catch (e) { bins = []; }
    for (i = 0; i < bins.length; i++) res.models.push(bins[i].name);
    if (bins.length === 0) {
      res.reason = "No ggml-*.bin model in " + modelsDir + ". Run " +
        "scripts\\get-whisper.ps1 (the binary is installed; only the " +
        "model is missing).";
      return res;
    }

    if (wantModel) {
      var want = String(wantModel).replace(/^ggml-/i, "").replace(/\.bin$/i, "");
      var hit = null;
      for (i = 0; i < bins.length; i++) {
        if (bins[i].name.toLowerCase() === ("ggml-" + want + ".bin").toLowerCase()) {
          hit = bins[i]; break;
        }
      }
      if (!hit) {
        res.reason = "Model 'ggml-" + want + ".bin' is not in " + modelsDir +
          ". Present: " + res.models.join(", ") + ".";
        return res;
      }
      res.model = hit.full;
    } else {
      // Smallest FILE, not smallest name: the sizes ARE the model sizes,
      // and picking by name would need a size table kept in sync.
      var best = bins[0];
      for (i = 1; i < bins.length; i++) if (bins[i].size < best.size) best = bins[i];
      res.model = best.full;
    }
    res.ok = true;
    return res;
  }

  var TS = /^\s*\[\s*(\d\d):(\d\d):(\d\d)\.(\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)\.(\d\d\d)\s*\]\s*(.*)$/;

  function secs(h, m, s, ms) {
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  }

  /**
   * Parse whisper-cli's timestamped stdout into caption segments.
   *
   *   [00:00:03.320 --> 00:00:06.240]   After effects renders the composition.
   *
   * Pure and exported on purpose: this is the half that can be tested
   * without a binary, and every trap in it is a real transcript.
   *
   *  - Segments are CONTIGUOUS (one segment's end is the next one's
   *    start), so consecutive captions touch rather than overlap.
   *  - Bracketed non-speech markers — [BLANK_AUDIO], [MUSIC], [ Silence ]
   *    — are whisper saying there was nothing to say. They are DROPPED,
   *    because a caption layer reading "[BLANK_AUDIO]" is worse than no
   *    caption at all.
   *  - The text is separated from the timestamp by THREE spaces, and
   *    leading/trailing whitespace is not the user's.
   *  - A line without a timestamp is progress noise, not a caption.
   */
  function parseSegments(stdout) {
    var lines = String(stdout || "").split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var m = TS.exec(lines[i]);
      if (!m) continue;
      var text = String(m[9]).replace(/^\s+/, "").replace(/\s+$/, "");
      // A line that is ONLY a bracketed marker carries no speech.
      if (!text || /^\[[^\]]*\]$/.test(text)) continue;
      var start = secs(m[1], m[2], m[3], m[4]);
      var end = secs(m[5], m[6], m[7], m[8]);
      // Zero-length or inverted spans are refused by add_captions and
      // would take the whole batch down with them; whisper has emitted a
      // 0.000 --> 0.000 line on a truncated file, so they are dropped.
      if (!(end > start)) continue;
      out.push({ start: start, end: end, text: text });
    }
    return out;
  }

  /* Does a transcript say anything but silence? FACT 1: whisper hears
   * "You" (and sometimes "Thank you." / "Bye.") in a silent file, so a
   * single short segment holding one of those is the shape of a
   * recording nobody spoke in. Reported, never silently dropped: a real
   * one-word caption is possible and the user decides. */
  var SILENCE_WORDS = ["you", "thank you", "thanks for watching", "bye",
                       "thank you for watching"];

  function looksLikeSilence(segments) {
    if (!segments || segments.length !== 1) return false;
    var t = String(segments[0].text).toLowerCase()
      .replace(/[^a-z ]/g, " ").replace(/\s+/g, " ")
      .replace(/^\s+/, "").replace(/\s+$/, "");
    for (var i = 0; i < SILENCE_WORDS.length; i++) {
      if (t === SILENCE_WORDS[i]) return true;
    }
    return false;
  }

  /**
   * Transcribe one audio file.
   *
   * cb(err, {segments, text, ms, raw}). `-np` suppresses the progress
   * spam; timestamps stay ON, which is the whole point here (the
   * verification harness in scripts\ turns them off for the opposite
   * reason).
   */
  function transcribe(audioPath, opts, cb) {
    ensureNode();
    opts = opts || {};
    var found = opts.install || find(opts.model);
    if (!found.ok) { cb(new Error(found.reason)); return; }
    if (!fs.existsSync(audioPath)) {
      cb(new Error("No audio file at " + audioPath));
      return;
    }
    var args = ["-m", found.model, "-f", audioPath, "-np"];
    if (opts.language) args.push("-l", String(opts.language));
    if (opts.threads) args.push("-t", String(opts.threads));
    var started = new Date().getTime();
    child_process.execFile(found.cli, args,
      { timeout: opts.timeoutMs || 600000, maxBuffer: 32 * 1024 * 1024,
        windowsHide: true },
      function (err, stdout, stderr) {
        var ms = new Date().getTime() - started;
        if (err) {
          // FACT 2: the diagnosis is in stderr and stdout is empty, so
          // reporting err.message alone says nothing actionable.
          var tail = String(stderr || "").split(/\r?\n/);
          tail = tail.slice(Math.max(0, tail.length - 4)).join(" ");
          cb(new Error("whisper-cli failed (" + err.message + ")" +
                       (tail ? ": " + tail : "")));
          return;
        }
        var segments = parseSegments(stdout);
        var texts = [];
        for (var i = 0; i < segments.length; i++) texts.push(segments[i].text);
        cb(null, { segments: segments, text: texts.join(" "), ms: ms,
                   raw: String(stdout || "") });
      });
  }

  global.Whisper = {
    installRoot: installRoot,
    find: find,
    parseSegments: parseSegments,
    looksLikeSilence: looksLikeSilence,
    transcribe: transcribe,
    SILENCE_WORDS: SILENCE_WORDS
  };
})(this);
