/*
 * ffmpeg.js — the panel's side of post-render encoding (WORKPLAN 6.2
 * Pass B). Locates the ffmpeg build that scripts\get-ffmpeg.ps1 put
 * under <dataRoot>\vendor\ffmpeg (or one already on PATH), turns a
 * comp's LOSSLESS master into a GIF or a social-ready H.264 file, and —
 * the part that is not optional — reads the result back out before
 * calling it a success.
 *
 * Same split as whisper.js: this is the PANEL's implementation and
 * scripts\lib\ffmpeg-verify.ps1 is the acquirer's and CI's. They are
 * deliberately independent (the panel cannot shell out to PowerShell for
 * every export) and they encode the same measured facts.
 *
 * Measured against BtbN n9.0.1-11-ge47273f4d9 (LGPL) and AE 2026 on
 * 2026-08-30. Nine facts, and the first three are all the same shape:
 * every layer of this pipeline will tell you it succeeded.
 *
 *  1. ffmpeg EXITS 0 WHEN IT REFUSES TO WRITE. Handed an output that
 *     already exists with no `-y` it prints "already exists. Exiting.",
 *     writes nothing, and returns 0 (WORKPLAN 6.2 Pass A). And without
 *     `-nostdin` that same case is an interactive "Overwrite? [y/N]" and
 *     HANGS FOREVER. Every invocation below starts `-nostdin -y`, and
 *     the exit code is never the check.
 *  2. A VALID FILE CAN CONTAIN NOTHING. `ffmpeg -t 0` writes a 262-byte
 *     MP4 that ffprobe accepts with exit 0, valid JSON, empty stderr and
 *     probe_score 100 — with nb_streams 0. So inspect() reads WIDTH,
 *     HEIGHT and FRAME COUNT back out, and anything missing is a failure
 *     however cleanly it exited.
 *  3. ffprobe exits 0 on a file with no matching stream too, and exits 1
 *     on a zero-byte file while still printing parseable `{ }`. Neither
 *     the exit code nor "the JSON parsed" is a check.
 *  4. Matroska (.webm, .mkv) reports NEITHER nb_frames NOR duration on
 *     the stream. The frame count falls back to `-count_frames` and the
 *     duration to the FORMAT's. Neither fallback loosens anything.
 *  5. AE's "Lossless" output module writes RAWVIDEO / bgr24 in an AVI,
 *     which ffmpeg reads natively — no QuickTime, no intermediate codec.
 *     It costs width * height * 3 bytes PER FRAME: measured 231 040 B/f
 *     at 320x240 and 6 224 440 B/f at 1920x1080, i.e. 1.87 GB for ten
 *     seconds of 1080p30. That is why estimateIntermediate() exists and
 *     why the export refuses before it fills someone's disk.
 *  6. That same AVI CARRIES THE COMP'S AUDIO, as pcm_s16le, when the
 *     comp has an audio layer (measured: a 2 s tone added exactly
 *     384 000 bytes). One intermediate serves both streams — no separate
 *     render_comp_audio pass and no muxing step.
 *  7. A NEGATIVE finding worth as much as a positive one: bottom-up BGR
 *     AVI is the classic upside-down trap, and AE's is NOT. A comp with
 *     a red top half and a blue bottom half comes back out of ffmpeg
 *     with (0,0) = red. No vflip. Do not add one.
 *  8. `-encoders` is a COMPILE-time list. This build names h264_amf and
 *     h264_qsv and BOTH fail at encode time here for want of a device.
 *     So tryEncoder() actually ENCODES a frame before an encoder is
 *     believed, and libopenh264 (software, in the LGPL build, measured
 *     at 37 ms) is the default rather than whatever the census lists.
 *  9. The acquirer's archive nests as bin\ffmpeg-<build>-win64-lgpl\bin\,
 *     so the exes are found by WALKING, the same way whisper's are.
 */
(function (global) {
  "use strict";

  var child_process = null;
  var fs = null;
  var path = null;
  var os = null;

  function ensureNode() {
    if (child_process) return;
    child_process = global.AEBridge.nodeRequire("child_process");
    fs = global.AEBridge.nodeRequire("fs");
    path = global.AEBridge.nodeRequire("path");
    os = global.AEBridge.nodeRequire("os");
  }

  var FFMPEG = "ffmpeg.exe";
  var FFPROBE = "ffprobe.exe";

  function installRoot() {
    ensureNode();
    return path.join(global.Settings.dataRoot(), "vendor", "ffmpeg");
  }

  /* Every .exe under a folder, recursively. FACT 9. */
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

  /* First hit for `name` on PATH. No `where.exe` child process: this runs
   * on the way into every export and a spawn per lookup is a cost the
   * user feels. */
  function onPath(name) {
    var raw = "";
    try { raw = String(process.env.PATH || process.env.Path || ""); }
    catch (e) { return ""; }
    var parts = raw.split(";");
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var full;
      try { full = path.join(parts[i], name); } catch (e2) { continue; }
      try { if (fs.existsSync(full)) return full; } catch (e3) {}
    }
    return "";
  }

  /**
   * Locate ffmpeg.exe and ffprobe.exe.
   *
   * Order: the vendor folder the acquirer writes, then PATH. The PATH
   * fallback is not a convenience — the dev machine had a gyan.dev build
   * in C:\Program Files\ffmpeg before any of this existed, and making a
   * user download 140 MB they already have is the kind of thing they
   * notice. Its licence and codec set are THEIRS, though, so nothing
   * downstream may assume libx264 is present.
   *
   * Never throws: "not installed" is the normal state on a machine that
   * has not run the acquirer, and the CALLER decides whether that is a
   * refusal or a skip. On failure `reason` says what IS there.
   */
  function find(opts) {
    ensureNode();
    opts = opts || {};
    var root = installRoot();
    var res = { ok: false, root: root, source: "", ffmpeg: "", ffprobe: "",
                reason: "" };

    var binDir = path.join(root, "bin");
    var exes = [];
    try { if (fs.existsSync(binDir)) exes = walkExes(binDir, [], 0); }
    catch (e) { exes = []; }
    var i, ff = "", fp = "";
    for (i = 0; i < exes.length; i++) {
      var base = path.basename(exes[i]).toLowerCase();
      if (!ff && base === FFMPEG) ff = exes[i];
      if (!fp && base === FFPROBE) fp = exes[i];
    }
    if (ff && fp) {
      res.ok = true; res.source = "vendor"; res.ffmpeg = ff; res.ffprobe = fp;
      return res;
    }

    // A vendor folder holding one of the two is a HALF install, and
    // saying so beats falling through to PATH in silence.
    var half = "";
    if (ff && !fp) half = binDir + " has " + FFMPEG + " but no " + FFPROBE + ". ";
    else if (fp && !ff) half = binDir + " has " + FFPROBE + " but no " + FFMPEG + ". ";

    if (!opts.vendorOnly) {
      var pff = onPath(FFMPEG), pfp = onPath(FFPROBE);
      if (pff && pfp) {
        res.ok = true; res.source = "path";
        res.ffmpeg = pff; res.ffprobe = pfp;
        return res;
      }
    }

    res.reason = half + "No ffmpeg install found in " +
      (opts.vendorOnly ? "the vendor folder" : "vendor or PATH") +
      ". Looked for " + FFMPEG + " and " + FFPROBE + " under " + binDir +
      ". Run scripts\\get-ffmpeg.ps1 to acquire one (about 140 MB).";
    return res;
  }

  // ==================================================== the pure half
  //
  // Everything below here is arithmetic and string building. It is
  // exported so the stub suite can prove it without a binary, which is
  // where every sizing trap in this feature actually lives.

  /* H.264 chroma subsampling and most social platforms want even
   * dimensions. libopenh264 does NOT refuse an odd one (measured: 101x75
   * encodes fine), so this is a compatibility choice, stated as one —
   * not a crash guard dressed up as arithmetic. Rounds DOWN, so a
   * requested size is never exceeded. */
  function evenDown(n) {
    var v = Math.floor(Number(n));
    if (!isFinite(v) || v < 2) return 2;
    return v - (v % 2);
  }

  /**
   * Parse the `size` argument.
   *
   *   "1080x1920" / "1080X1920"  -> both dimensions
   *   "1080p" / "720p"           -> a HEIGHT (the way video is spoken about)
   *   "480" / 480                -> a WIDTH (the way GIFs are spoken about)
   *
   * Returns {width, height, err}. Those two conventions disagree, which
   * is exactly why the `p` suffix is honoured rather than guessed at.
   */
  function parseSize(raw) {
    if (raw === null || typeof raw === "undefined" || raw === "") {
      return { width: 0, height: 0, err: "" };
    }
    var s = String(raw).replace(/\s+/g, "");
    var m = /^(\d+)[xX*](\d+)$/.exec(s);
    if (m) return { width: Number(m[1]), height: Number(m[2]), err: "" };
    m = /^(\d+)[pP]$/.exec(s);
    if (m) return { width: 0, height: Number(m[1]), err: "" };
    if (/^\d+$/.test(s)) return { width: Number(s), height: 0, err: "" };
    return { width: 0, height: 0, err: "'size' must be \"WIDTHxHEIGHT\" " +
      "(e.g. \"1080x1920\"), a height with a p (\"1080p\"), or a plain " +
      "number meaning the WIDTH (\"480\") — got \"" + String(raw) + "\"." };
  }

  var FITS = { contain: true, cover: true, stretch: true };

  /**
   * Work out the output dimensions and the scale/pad/crop filter.
   *
   * @param {{w:number,h:number}} src the comp's own pixels
   * @param {object} opts {size, width, height, fit, padColor}
   * @returns {{width,height,filter,fit,note,err}}
   */
  function planSize(src, opts) {
    opts = opts || {};
    var sw = Math.round(Number(src.w)), sh = Math.round(Number(src.h));
    if (!(sw > 0) || !(sh > 0)) {
      return { err: "The comp reports " + src.w + "x" + src.h +
        " pixels, which nothing can be scaled from." };
    }
    var parsed = parseSize(opts.size);
    if (parsed.err) return { err: parsed.err };

    var w = Number(opts.width) || parsed.width || 0;
    var h = Number(opts.height) || parsed.height || 0;
    var fit = String(opts.fit || "contain").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FITS, fit)) {
      return { err: "'fit' must be 'contain' (letterbox, the default), " +
        "'cover' (fill and crop) or 'stretch' — got \"" +
        String(opts.fit) + "\"." };
    }

    var note = "", filter = "";
    if (!w && !h) {
      w = evenDown(sw); h = evenDown(sh);
      filter = (w === sw && h === sh) ? "" : ("scale=" + w + ":" + h);
      if (filter) {
        note = "Rounded the comp's " + sw + "x" + sh + " down to " + w +
          "x" + h + " — H.264 and most social players want even sides.";
      }
      return { width: w, height: h, filter: filter, fit: "none", note: note,
               err: "" };
    }
    if (w && !h) {
      h = evenDown(Math.round(w * sh / sw));
      w = evenDown(w);
      return { width: w, height: h, filter: "scale=" + w + ":" + h,
               fit: "aspect", note: "", err: "" };
    }
    if (h && !w) {
      w = evenDown(Math.round(h * sw / sh));
      h = evenDown(h);
      return { width: w, height: h, filter: "scale=" + w + ":" + h,
               fit: "aspect", note: "", err: "" };
    }

    w = evenDown(w); h = evenDown(h);
    var srcAr = sw / sh, dstAr = w / h;
    var same = Math.abs(srcAr - dstAr) < 0.001;
    if (same || fit === "stretch") {
      filter = "scale=" + w + ":" + h;
      if (!same) {
        note = "'stretch' changes the shape of the picture: " + sw + "x" +
          sh + " does not have the same aspect ratio as " + w + "x" + h + ".";
      }
      return { width: w, height: h, filter: filter,
               fit: same ? "exact" : "stretch", note: note, err: "" };
    }
    if (fit === "cover") {
      // Scale up until BOTH sides cover, then take the middle.
      filter = "scale=" + w + ":" + h +
        ":force_original_aspect_ratio=increase:force_divisible_by=2," +
        "crop=" + w + ":" + h;
      note = "'cover' fills " + w + "x" + h + " and CROPS what does not " +
        "fit — the comp is " + sw + "x" + sh + ". Pass {fit: 'contain'} " +
        "to letterbox instead of losing edges.";
      return { width: w, height: h, filter: filter, fit: "cover",
               note: note, err: "" };
    }
    // contain: fit inside, then pad out to the exact frame asked for.
    var color = String(opts.padColor || "black");
    if (!/^[a-zA-Z]+$|^#[0-9a-fA-F]{6}$/.test(color)) {
      return { err: "'padColor' must be a colour name (\"black\") or " +
        "#rrggbb — got \"" + color + "\"." };
    }
    filter = "scale=" + w + ":" + h +
      ":force_original_aspect_ratio=decrease:force_divisible_by=2," +
      "pad=" + w + ":" + h + ":(ow-iw)/2:(oh-ih)/2:color=" + color;
    note = "The comp is " + sw + "x" + sh + " and " + w + "x" + h +
      " is a different shape, so the picture is letterboxed with " +
      color + " bars. Pass {fit: 'cover'} to fill and crop instead.";
    return { width: w, height: h, filter: filter, fit: "contain",
             note: note, err: "" };
  }

  /**
   * Which Render Settings resolution AE should render the master at.
   *
   * The master exists only to be scaled DOWN, so rendering it at comp
   * size and throwing most of the pixels away is pure cost: a 4K comp
   * exported to a 480 px GIF moves 24 MB a frame to keep 0.4. AE can
   * render the smaller frame itself (render_comp {resolution}), and
   * ceil(dim/factor) is the size it writes -- measured, not floor.
   *
   * The one rule this must never break is the export path's own: never
   * upscale. A master smaller than the requested output on either axis
   * is refused by name rather than quietly enlarged, and "auto" picks
   * the largest reduction that still covers the output.
   *
   * OPT-IN, deliberately. AE's reduced-resolution render is its own
   * sampler and nobody here has measured it against ffmpeg's downscale
   * on real footage, so the default stays exactly what shipped.
   *
   * @param {{w:number,h:number}} src the comp's own pixels
   * @param {{width:number,height:number}} out the planned output frame
   * @param {string} raw the caller's masterResolution, or nothing
   */
  var MASTER_RES = [
    { name: "full", factor: 1 }, { name: "half", factor: 2 },
    { name: "third", factor: 3 }, { name: "quarter", factor: 4 }
  ];

  function masterSize(src, factor) {
    return { width: Math.ceil(Number(src.w) / factor),
             height: Math.ceil(Number(src.h) / factor) };
  }

  function covers(src, factor, out) {
    var m = masterSize(src, factor);
    return m.width >= Number(out.width) && m.height >= Number(out.height);
  }

  function planMaster(src, out, raw) {
    var i, chosen = null;
    var none = { name: "full", factor: 1, width: Math.round(Number(src.w)),
                 height: Math.round(Number(src.h)), note: "", err: "" };
    if (raw === null || typeof raw === "undefined" || raw === "") return none;
    var want = String(raw).trim().toLowerCase();
    var m = /^1\s*\/\s*([1-4])$/.exec(want);
    if (m) want = { "1": "full", "2": "half", "3": "third",
                    "4": "quarter" }[m[1]];

    if (want === "auto") {
      for (i = MASTER_RES.length - 1; i >= 0; i--) {
        if (covers(src, MASTER_RES[i].factor, out)) {
          chosen = MASTER_RES[i];
          break;
        }
      }
      // Full always covers unless the output is bigger than the comp,
      // which planSize has already decided is allowed (an upscale the
      // user asked for by name). Then there is nothing to reduce.
      if (!chosen) return none;
    } else {
      for (i = 0; i < MASTER_RES.length; i++) {
        if (want === MASTER_RES[i].name ||
            want === String(MASTER_RES[i].factor)) {
          chosen = MASTER_RES[i];
          break;
        }
      }
      if (!chosen) {
        return { err: "'masterResolution' must be full, half, third, " +
          "quarter or auto - got \"" + String(raw) + "\". It is the " +
          "resolution AE renders the intermediate at; ffmpeg still " +
          "produces the size you asked for." };
      }
      if (chosen.factor > 1 && !covers(src, chosen.factor, out)) {
        var got = masterSize(src, chosen.factor);
        var best = null;
        for (i = MASTER_RES.length - 1; i >= 0; i--) {
          if (covers(src, MASTER_RES[i].factor, out)) {
            best = MASTER_RES[i];
            break;
          }
        }
        return { err: "At " + chosen.name + " resolution AE would render " +
          got.width + "x" + got.height + ", which is smaller than the " +
          Number(out.width) + "x" + Number(out.height) + " you asked " +
          "for - the export would have to ENLARGE the master, which is " +
          "only ever a blurrier file. " + (best && best.factor > 1
            ? "The most it can be reduced for this size is " + best.name + "."
            : "This size needs the full-resolution master.") };
      }
    }

    var size = masterSize(src, chosen.factor);
    var note = "";
    if (chosen.factor > 1) {
      note = "AE renders the master at " + chosen.name + " resolution (" +
        size.width + "x" + size.height + " instead of " +
        Math.round(Number(src.w)) + "x" + Math.round(Number(src.h)) + ").";
    }
    return { name: chosen.name, factor: chosen.factor, width: size.width,
             height: size.height, note: note, err: "" };
  }

  /** Join the fps filter (if any) in front of a size filter. */
  function withFps(filter, fps) {
    var f = Number(fps);
    var head = (f > 0) ? ("fps=" + f) : "";
    if (head && filter) return head + "," + filter;
    return head || filter;
  }

  /* FACT 5: raw BGR is 3 bytes a pixel and AE adds a little on top. The
   * estimate is the FLOOR, not the ceiling, and it is reported as such.
   *
   * The "3 640 B/frame at 1920x1080" this comment used to claim was an
   * artefact of the render it was taken from: a TWO-frame file, where a
   * fixed ~7 KB of AVI header and index divided by two frames looks like
   * a big per-frame cost. Re-measured 2026-08-30 over long renders
   * (riff-boundary-probe.js), the overhead is nearly all fixed and the
   * per-frame share falls away as the file grows:
   *
   *     frames     file bytes       over the raw floor    per frame
   *         2      12 448 880              7 280            3 640
   *        60     373 257 600              9 600              160
   *       900   5 598 817 144             97 144              108
   *      1380   8 584 826 232            122 232               89
   *
   * So the gap the caller has to allow for is ~0.0015% of an export-sized
   * master, not 0.06% — which is why the disk guard's 1.1x headroom is
   * not tight even at the 8 GB cap. */
  function estimateIntermediate(w, h, frames) {
    return Math.round(Number(w) * Number(h) * 3 * Number(frames));
  }

  function humanBytes(n) {
    var v = Number(n);
    if (!isFinite(v)) return String(n);
    if (v >= 1024 * 1024 * 1024) {
      return (Math.round(v / (1024 * 1024 * 1024) * 100) / 100) + " GB";
    }
    if (v >= 1024 * 1024) return Math.round(v / (1024 * 1024)) + " MB";
    if (v >= 1024) return Math.round(v / 1024) + " KB";
    return v + " bytes";
  }

  /* libopenh264 has no CRF — it is bitrate-driven — so "quality" has to
   * become a number here rather than be handed to the encoder as a word.
   * Bits per pixel per frame, the usual rule of thumb: 0.1 is where
   * 1080p30 lands on ~6 Mbps, which is what the platforms want. */
  var BPP = { low: 0.06, medium: 0.1, high: 0.15 };

  function bitrateFor(w, h, fps, quality) {
    var q = String(quality || "medium").toLowerCase();
    var bpp = BPP[q];
    if (!bpp) return { err: "'quality' must be low, medium or high — got \"" +
                       String(quality) + "\"." };
    var bits = Number(w) * Number(h) * Number(fps) * bpp;
    // Nothing useful lives below ~200 kbps, and nothing social needs
    // more than 20 Mbps.
    var kbps = Math.round(bits / 1000);
    if (kbps < 200) kbps = 200;
    if (kbps > 20000) kbps = 20000;
    return { kbps: kbps, bpp: bpp, err: "" };
  }

  /**
   * ffmpeg arguments for an animated GIF.
   *
   * The two-pass palette is not a refinement — a GIF made without
   * palettegen is quantised to the 216-colour web palette and looks it.
   * stats_mode=diff builds the palette from what CHANGES between frames,
   * which is what an animation needs.
   */
  function buildGifArgs(input, output, o) {
    o = o || {};
    var colors = Math.round(Number(o.colors) || 256);
    if (colors < 4) colors = 4;
    if (colors > 256) colors = 256;
    var dither = String(o.dither || "bayer").toLowerCase();
    var DITHERS = { bayer: "bayer:bayer_scale=5", none: "none",
                    sierra2_4a: "sierra2_4a",
                    floyd_steinberg: "floyd_steinberg" };
    if (!Object.prototype.hasOwnProperty.call(DITHERS, dither)) {
      return { err: "'dither' must be one of bayer (default, smallest " +
        "files), none, sierra2_4a, floyd_steinberg — got \"" +
        String(o.dither) + "\"." };
    }
    var pre = withFps(o.filter || "", o.fps);
    var chain = (pre ? pre + "," : "") +
      "split[a][b];[a]palettegen=max_colors=" + colors +
      ":stats_mode=diff[p];[b][p]paletteuse=dither=" + DITHERS[dither] +
      ":diff_mode=rectangle";
    // -loop 0 is FOREVER and -loop -1 is once; the numbers are not
    // intuitive and getting them backwards ships a GIF that plays once.
    var loop = (o.loop === false || o.loop === "once") ? "-1" : "0";
    return { err: "", args: ["-nostdin", "-y", "-v", "error",
      "-i", input, "-filter_complex", chain, "-loop", loop, "-an", output] };
  }

  /** ffmpeg arguments for an H.264 .mp4/.mov. */
  function buildSocialArgs(input, output, o) {
    o = o || {};
    var rate = bitrateFor(o.width, o.height, o.fps || 30, o.quality);
    if (rate.err) return { err: rate.err };
    var pre = withFps(o.filter || "", o.fps);
    var args = ["-nostdin", "-y", "-v", "error", "-i", input];
    if (pre) args.push("-vf", pre);
    args.push("-c:v", String(o.encoder || "libopenh264"),
              "-b:v", rate.kbps + "k",
              "-pix_fmt", "yuv420p");
    if (o.audio === false) {
      args.push("-an");
    } else {
      args.push("-c:a", "aac", "-b:a", String(o.audioKbps || 192) + "k");
    }
    // faststart puts the index at the front so the file starts playing
    // before it has finished downloading — the whole point of "social".
    args.push("-movflags", "+faststart", output);
    return { err: "", args: args, kbps: rate.kbps };
  }

  /**
   * The output path, checked to destruction.
   *
   * Same rules render_comp applies in hostscript, for the same reason:
   * every way this can be wrong ends in either bytes in a folder nobody
   * meant or a refusal the user cannot act on.
   */
  function checkOutput(raw, allowedExts, overwrite) {
    ensureNode();
    if (raw === null || typeof raw === "undefined" || raw === "") {
      return { err: "'output' is required — an ABSOLUTE file path to " +
        "write to, e.g. \"C:/renders/promo" + allowedExts[0] + "\"." };
    }
    var p = String(raw).replace(/\//g, "\\");
    if (!/^[a-zA-Z]:\\/.test(p) && p.indexOf("\\\\") !== 0) {
      return { err: "'output' must be an ABSOLUTE path (got \"" +
        String(raw) + "\")." };
    }
    var ext = "";
    var dot = p.lastIndexOf(".");
    var slash = p.lastIndexOf("\\");
    if (dot > slash) ext = p.slice(dot).toLowerCase();
    var okExt = false;
    for (var i = 0; i < allowedExts.length; i++) {
      if (ext === allowedExts[i]) okExt = true;
    }
    if (!okExt) {
      // The extension picks the MUXER, so a wrong one is not cosmetic
      // the way it is for render_comp — the encode simply cannot run.
      return { err: "The file extension decides the format ffmpeg writes, " +
        "so \"" + (ext || "(none)") + "\" cannot be used here. Allowed: " +
        allowedExts.join(", ") + "." };
    }
    var dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      var probe = dir, nearest = "", guard = 0;
      while (probe && guard < 40) {
        if (fs.existsSync(probe)) { nearest = probe; break; }
        var up = path.dirname(probe);
        if (up === probe) break;
        probe = up; guard++;
      }
      return { err: "Output folder does not exist: " + dir +
        ". Deepest folder that does exist: " +
        (nearest || "(none — check the drive letter)") +
        ". Create it, or export somewhere that exists." };
    }
    if (fs.existsSync(p) && !overwrite) {
      var size = 0;
      try { size = fs.statSync(p).size; } catch (e) {}
      return { err: "Output file already exists: " + p + " (" +
        humanBytes(size) + "). Pass {overwrite: true} to replace it, or " +
        "choose another path." };
    }
    return { err: "", path: p, dir: dir, ext: ext };
  }

  // ================================================== running the tools

  /** execFile with the two flags that are never optional. cb(err, out). */
  function run(exe, args, opts, cb) {
    ensureNode();
    opts = opts || {};
    var started = new Date().getTime();
    child_process.execFile(exe, args,
      { timeout: opts.timeoutMs || 1800000, maxBuffer: 32 * 1024 * 1024,
        windowsHide: true },
      function (err, stdout, stderr) {
        var ms = new Date().getTime() - started;
        cb(err || null, { stdout: String(stdout || ""),
                          stderr: String(stderr || ""), ms: ms });
      });
  }

  function parseProbeJson(stdout) {
    var obj = null;
    try { obj = JSON.parse(String(stdout || "")); } catch (e) { return null; }
    if (!obj || typeof obj !== "object") return null;
    return obj;
  }

  /**
   * What is ACTUALLY in a media file.
   *
   * cb(null, {ok, width, height, frames, duration, hasAudio, codec,
   *           bytes, reason}). FACTS 2, 3 and 4 all live here: the exit
   * code proves nothing, `{}` parses, and matroska answers neither
   * nb_frames nor duration on the stream — so a missing frame count is
   * re-asked for with -count_frames rather than read as zero.
   */
  function inspect(install, file, cb) {
    ensureNode();
    var res = { ok: false, width: 0, height: 0, frames: 0, duration: 0,
                hasAudio: false, codec: "", bytes: 0, reason: "" };
    if (!fs.existsSync(file)) {
      res.reason = "ffmpeg reported success but wrote no file at " + file +
        ". (It exits 0 when it declines to write, so its exit code is " +
        "never the check.)";
      cb(null, res); return;
    }
    try { res.bytes = fs.statSync(file).size; } catch (e) { res.bytes = 0; }
    if (res.bytes === 0) {
      res.reason = "The file at " + file + " is zero bytes.";
      cb(null, res); return;
    }
    run(install.ffprobe, ["-v", "error", "-print_format", "json",
                          "-show_streams", "-show_format", file], {},
      function (err, out) {
        var probe = parseProbeJson(out.stdout);
        if (!probe || !probe.streams) {
          res.reason = "ffprobe could not read " + file +
            (out.stderr ? (": " + out.stderr.split(/\r?\n/)[0]) : "") + ".";
          cb(null, res); return;
        }
        var v = null, i;
        for (i = 0; i < probe.streams.length; i++) {
          var s = probe.streams[i];
          if (s.codec_type === "video" && !v) v = s;
          if (s.codec_type === "audio") res.hasAudio = true;
        }
        if (!v) {
          // FACT 2 in the flesh: this is the 262-byte MP4 that ffprobe
          // scores 100 and that plays as nothing at all.
          res.reason = "The file at " + file + " (" + humanBytes(res.bytes) +
            ") has NO VIDEO STREAM — ffmpeg wrote a container and no " +
            "picture. Nothing downstream can tell that apart from a real " +
            "export, so it is a failure here.";
          cb(null, res); return;
        }
        res.width = Number(v.width) || 0;
        res.height = Number(v.height) || 0;
        res.codec = String(v.codec_name || "");
        res.duration = Number(v.duration) ||
          Number(probe.format && probe.format.duration) || 0;
        res.frames = Number(v.nb_frames) || 0;
        if (res.frames > 0) { finish(); return; }
        // FACT 4: absent is not zero. Ask again, the slow way.
        run(install.ffprobe, ["-v", "error", "-count_frames",
              "-select_streams", "v:0", "-print_format", "json",
              "-show_entries", "stream=nb_read_frames", file], {},
          function (e2, o2) {
            var p2 = parseProbeJson(o2.stdout);
            if (p2 && p2.streams && p2.streams[0]) {
              res.frames = Number(p2.streams[0].nb_read_frames) || 0;
            }
            finish();
          });

        function finish() {
          if (!(res.width > 0) || !(res.height > 0) || !(res.frames > 0)) {
            res.reason = "The file at " + file + " reports " + res.width +
              "x" + res.height + " and " + res.frames + " frame(s) — not a " +
              "usable video however cleanly ffmpeg exited.";
            cb(null, res); return;
          }
          res.ok = true;
          cb(null, res);
        }
      });
  }

  /* FACT 8: the census is a COMPILE-time list. This actually encodes one
   * frame of colour bars and inspects the result, which is the only
   * thing that separates h264_nvenc on this machine from h264_qsv on it.
   * ~40-200 ms, and the answer is cached for the session.
   *
   * The frame is the SIZE THE EXPORT WILL BE, and that is not fussiness.
   * The first version of this trialled at a fixed 64x64 and h264_nvenc
   * answered "Frame Dimension less than the minimum supported value",
   * exit -22, zero bytes written — so a machine with a working NVIDIA
   * encoder silently fell through to h264_mf. Measured on this card:
   * 146x50 encodes, 144x48 does not, and 128x128 does not either, so the
   * floor is about 145x49 and no fixed small frame can stand in for the
   * real one. A trial at the wrong size answers about the wrong thing;
   * the whole point of trialling is that the census already lied.
   */
  var encoderCache = {};

  function tryEncoder(install, name, dims, cb) {
    ensureNode();
    var w = evenDown((dims && dims.w) || 640);
    var h = evenDown((dims && dims.h) || 360);
    var key = name + "@" + w + "x" + h;
    if (Object.prototype.hasOwnProperty.call(encoderCache, key)) {
      cb(encoderCache[key]); return;
    }
    var tmp = path.join(os.tmpdir(),
      "aell-enc-" + name.replace(/[^a-z0-9_]/gi, "") + "-" +
      new Date().getTime() + ".mp4");
    var args = ["-nostdin", "-y", "-v", "error",
                "-f", "lavfi",
                "-i", "testsrc=size=" + w + "x" + h + ":rate=1:duration=1",
                "-frames:v", "1", "-c:v", name, "-pix_fmt", "yuv420p", tmp];
    run(install.ffmpeg, args, { timeoutMs: 60000 }, function (err, out) {
      inspect(install, tmp, function (e2, info) {
        try { fs.unlinkSync(tmp); } catch (eU) {}
        var verdict = { name: name, ok: !!(info && info.ok),
                        size: w + "x" + h,
                        reason: (info && info.reason) || "" };
        if (!verdict.ok && out.stderr) {
          // The encoder's own words beat ours: "Frame Dimension less than
          // the minimum supported value" is a sentence someone can act
          // on, and "no video stream" is not.
          var lines = String(out.stderr).split(/\r?\n/);
          for (var i = 0; i < lines.length; i++) {
            if (/\S/.test(lines[i])) { verdict.reason = lines[i]; break; }
          }
        }
        encoderCache[key] = verdict;
        cb(verdict);
      });
    });
  }

  /** First candidate that really encodes AT THIS SIZE. cb({ok,name,tried}). */
  function pickEncoder(install, candidates, dims, cb) {
    var tried = [], i = 0;
    var where = evenDown((dims && dims.w) || 640) + "x" +
                evenDown((dims && dims.h) || 360);
    function step() {
      if (i >= candidates.length) {
        cb({ ok: false, name: "", tried: tried,
             reason: "No H.264 encoder in this ffmpeg build could encode a " +
               where + " test frame. Tried: " + tried.join("; ") +
               ". `-encoders` lists what the build was COMPILED with, not " +
               "what this machine can run — h264_amf and h264_qsv need an " +
               "AMD or Intel device, and h264_nvenc refuses a frame under " +
               "about 145x49." });
        return;
      }
      var name = candidates[i++];
      tryEncoder(install, name, dims, function (v) {
        tried.push(name + (v.ok ? " (works)" : " (failed: " +
          (v.reason || "no reason given") + ")"));
        if (v.ok) { cb({ ok: true, name: name, tried: tried }); return; }
        step();
      });
    }
    step();
  }

  /** Free bytes on the volume holding `dir`, or -1 when unknowable. */
  function freeBytes(dir) {
    ensureNode();
    // statfsSync landed in Node 18.15; CEP's runtime is older on some
    // installs, so this is a bonus check and never a gate.
    if (typeof fs.statfsSync !== "function") return -1;
    try {
      var st = fs.statfsSync(dir);
      return Number(st.bsize) * Number(st.bavail);
    } catch (e) { return -1; }
  }

  global.Ffmpeg = {
    installRoot: installRoot,
    find: find,
    run: run,
    inspect: inspect,
    tryEncoder: tryEncoder,
    pickEncoder: pickEncoder,
    freeBytes: freeBytes,
    // the pure half
    evenDown: evenDown,
    parseSize: parseSize,
    planSize: planSize,
    planMaster: planMaster,
    withFps: withFps,
    estimateIntermediate: estimateIntermediate,
    humanBytes: humanBytes,
    bitrateFor: bitrateFor,
    buildGifArgs: buildGifArgs,
    buildSocialArgs: buildSocialArgs,
    checkOutput: checkOutput
  };
})(this);
