/*
 * riff-boundary-probe.js — the measurement behind item 6.2's longest-lived
 * flag: "The 8 GB intermediate cap is a guess, not a measurement. Nobody
 * has established whether AE's AVI writer survives past the classic 2 GB /
 * 4 GB RIFF boundaries, or whether ffmpeg reads what it writes there."
 *
 * Why it matters. export_gif / export_social render a LOSSLESS master
 * first, and that master is rawvideo/bgr24 AVI at 3 bytes a pixel — about
 * 6.2 MB per 1080p frame. The shipped cap is 8 GB, so the panel will
 * happily let a user export ~43 seconds of 1080p, and every second past
 * about 11.5 crosses a boundary that has never been tested here. AVI is a
 * RIFF container with 32-bit chunk offsets; the classic failure is a
 * writer that wraps at 2 GiB or 4 GiB and a reader that then hands back a
 * confidently truncated file. FACT 2 of this whole track is that a clean
 * exit code proves nothing, so the question can only be settled by reading
 * PICTURES back out of the far end of a real multi-gigabyte file.
 *
 * The method, and the one trick that makes it exact:
 *
 *   1. Build a rig comp whose every frame is visibly different (position
 *      and rotation both driven by `time`, so frame N is a function of N
 *      and nothing else — no keyframes to interpolate, no randomness).
 *   2. Render the WHOLE comp through the shipped render_comp host tool at
 *      template "Lossless" — the exporter's own path.
 *   3. ffprobe it, then decode every frame with `-xerror` to catch a
 *      corrupt tail that ffprobe's header read would never see.
 *   4. framemd5 the big file: one MD5 per decoded frame. Assert they are
 *      all DISTINCT, or the comparison below would be vacuous.
 *   5. THE TRICK: re-render short spans of the SAME comp straddling each
 *      boundary, using render_comp's startTime/durationSeconds. Those
 *      reference files are a few MB and nowhere near any boundary. Frame
 *      for frame, their MD5s must equal the big file's MD5s at the same
 *      comp times. Same comp, same renderer, same codec, same pixels —
 *      so this compares AE against ITSELF and needs no assumption about
 *      colour management, gamma, or what the picture ought to look like.
 *
 * A file that truncates, wraps, repeats a frame or garbles the tail fails
 * (5) even when (3) reports a tidy 900 frames.
 *
 *   node scripts/riff-boundary-probe.js
 *   node scripts/riff-boundary-probe.js --seconds 30   # comp length
 *   node scripts/riff-boundary-probe.js --keep         # leave the master
 *   node scripts/riff-boundary-probe.js --dir X:\\scratch
 *
 * Nothing here is part of the panel. It drives the shipped host tool and
 * the shipped ffmpeg install and reports what they did.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const HOSTSCRIPT = path.join(EXT, "jsx", "hostscript.jsx");

// The bridge wrapper comes from chat-probe.js rather than being copied,
// so this probe cannot drift from the way the panel actually talks to AE.
const { bridgeWrapper } = require("./chat-probe.js");

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const OPT = {
  seconds: Number(argValue("--seconds", 30)),
  keep: argv.indexOf("--keep") !== -1,
  dir: argValue("--dir", os.tmpdir()),
  afterFX: argValue("--afterfx", null)
};

const WIDTH = 1920, HEIGHT = 1080, FPS = 30;
const COMP = "RIFF Boundary Probe";
const GiB = 1024 * 1024 * 1024;

// ------------------------------------------------------- After Effects

function findAfterFX() {
  if (OPT.afterFX) return OPT.afterFX;
  const base = "C:\\Program Files\\Adobe";
  let best = null;
  try {
    for (const d of fs.readdirSync(base)) {
      if (!/^Adobe After Effects/.test(d)) continue;
      const exe = path.join(base, d, "Support Files", "AfterFX.exe");
      if (fs.existsSync(exe) && (!best || d > best.dir)) best = { dir: d, exe };
    }
  } catch (e) {}
  return best ? best.exe : null;
}
const AFTERFX = findAfterFX();

let bridgeSeq = 0;
let hostLoaded = false;

/** Run one ExtendScript expression in AE; hand back the text it wrote. */
function aeEval(script, cb, timeoutMs) {
  const id = ++bridgeSeq;
  const outPath = path.join(os.tmpdir(),
    "aell-riff-" + process.pid + "-" + id + ".json");
  const wrapperPath = path.join(os.tmpdir(),
    "aell-riff-" + process.pid + "-" + id + ".jsx");
  try { fs.unlinkSync(outPath); } catch (e) {}

  const force = !hostLoaded;
  hostLoaded = true;
  fs.writeFileSync(wrapperPath,
    bridgeWrapper(script, outPath, HOSTSCRIPT, force), "ascii");

  // On a cold machine THIS process is AE and it holds stdout for as long
  // as AE lives, so never wait on the child — poll the answer file.
  const child = spawn(AFTERFX, ["-r", wrapperPath],
    { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + (timeoutMs || 1800000);
  (function poll() {
    if (fs.existsSync(outPath)) {
      let text = "";
      try { text = fs.readFileSync(outPath, "utf8"); } catch (e) {}
      try { fs.unlinkSync(outPath); } catch (e) {}
      try { fs.unlinkSync(wrapperPath); } catch (e) {}
      cb(text, false);
      return;
    }
    if (Date.now() > deadline) { cb("", true); return; }
    setTimeout(poll, 200);
  })();
}

function jsxArg(obj) {
  // hostscript takes its args as a JSON STRING, and the wrapper hands the
  // whole expression through an ES3 string literal, so the quotes have to
  // survive two levels of escaping.
  return JSON.stringify(JSON.stringify(obj));
}

/** One host tool, the way the panel calls it. cb(err, data). */
function call(tool, args, cb, timeoutMs) {
  const expr = "AELL_call(" + JSON.stringify(tool) + ", " +
               jsxArg(args || {}) + ")";
  aeEval(expr, function (text, timedOut) {
    if (timedOut) { cb(new Error(tool + ": AE did not answer")); return; }
    let obj = null;
    try { obj = JSON.parse(text); } catch (e) {
      cb(new Error(tool + ": unparseable answer: " + String(text).slice(0, 300)));
      return;
    }
    if (!obj || obj.ok === false) {
      cb(new Error(tool + ": " + ((obj && obj.error) || "no answer")));
      return;
    }
    cb(null, obj.data || obj);
  }, timeoutMs);
}

// --------------------------------------------------------------- ffmpeg

function findFfmpeg() {
  const root = path.join(process.env.APPDATA || "", "AE-Llama",
                         "vendor", "ffmpeg");
  const out = [];
  (function walk(dir, depth) {
    if (depth > 4) return;
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of names) {
      const full = path.join(dir, n);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (/^ffmpeg\.exe$/i.test(n)) out.push(full);
    }
  })(root, 0);
  if (!out.length) return null;
  return { ffmpeg: out[0], ffprobe: path.join(path.dirname(out[0]), "ffprobe.exe") };
}
const FF = findFfmpeg();

function runSync(exe, args, maxBuffer) {
  const r = spawnSync(exe, args, {
    encoding: "utf8", maxBuffer: maxBuffer || 256 * 1024 * 1024
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// ---------------------------------------------------------- the verdicts

const results = [];
function verdict(pass, what, detail) {
  results.push({ pass: !!pass, what, detail: detail || "" });
  console.log((pass ? "  PASS  " : "  FAIL  ") + what +
              (detail ? ("  [" + detail + "]") : ""));
}
function info(msg) { console.log("  --    " + msg); }
function human(n) {
  if (n >= GiB) return (Math.round(n / GiB * 1000) / 1000) + " GiB";
  if (n >= 1048576) return Math.round(n / 1048576) + " MiB";
  return n + " B";
}

// --------------------------------------------------------------- the rig

/*
 * Every frame must be different from every other, or step 5 compares
 * nothing. Both drivers are pure functions of `time`:
 *   Position  — a 1720 px traverse, so the square is somewhere new each
 *               frame even at sub-pixel steps;
 *   Rotation  — 120 deg/s, i.e. 4 deg per frame at 30 fps, which no
 *               antialiasing accident can make identical between
 *               neighbours.
 * Position gets TWO components and not three: the expression engine sees
 * 2 dims on a 2D layer however many the scripting API pads to.
 */
function buildRig(seconds, cb) {
  const steps = [
    ["create_comp", { name: COMP, width: WIDTH, height: HEIGHT,
                      duration: seconds, frameRate: FPS,
                      bgColor: [0, 0, 0] }],
    ["add_solid", { comp: COMP, name: "RIFF BG", color: [0, 0, 0.25],
                    width: WIDTH, height: HEIGHT }],
    ["add_solid", { comp: COMP, name: "RIFF Marker", color: [1, 1, 1],
                    width: 200, height: 200 }],
    ["set_expression", { comp: COMP, layer: "RIFF Marker",
                         property: "Position",
                         expression: "[100 + time * " +
                           (1720 / seconds).toFixed(6) + ", 540]" }],
    ["set_expression", { comp: COMP, layer: "RIFF Marker",
                         property: "Rotation",
                         expression: "time * 120" }]
  ];
  (function next(i) {
    if (i >= steps.length) { cb(null); return; }
    call(steps[i][0], steps[i][1], function (err) {
      if (err) { cb(err); return; }
      next(i + 1);
    }, 240000);
  })(0);
}

// ------------------------------------------------------------- framemd5

/*
 * One MD5 per DECODED frame. This is the whole comparison: it reads
 * pictures, not headers, so a file whose index is fine and whose pixels
 * are not still fails.
 */
function frameHashes(file) {
  const r = runSync(FF.ffmpeg,
    ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line || line.charAt(0) === "#") continue;
    const parts = line.trim().split(/,\s*/);
    if (parts.length >= 6) out.push(parts[parts.length - 1]);
  }
  return { hashes: out, stderr: r.stderr, code: r.code };
}

// ------------------------------------------------------------------ main

function main() {
  if (!AFTERFX) { console.error("AfterFX.exe not found"); process.exit(2); }
  if (!FF) { console.error("ffmpeg not installed under %APPDATA%\\AE-Llama"); process.exit(2); }

  const frames = Math.round(OPT.seconds * FPS);
  const estimate = WIDTH * HEIGHT * 3 * frames;
  const big = path.join(OPT.dir, "aell-riff-master-" + Date.now() + ".avi");
  const scratch = [];

  console.log("-- AfterFX : " + AFTERFX);
  console.log("-- ffmpeg  : " + FF.ffmpeg);
  console.log("-- comp    : " + WIDTH + "x" + HEIGHT + " @ " + FPS +
              " fps, " + OPT.seconds + " s = " + frames + " frames");
  console.log("-- estimate: " + human(estimate) + " of rawvideo/bgr24");
  console.log("-- master  : " + big);
  console.log("");
  if (estimate < 4 * GiB) {
    console.log("WARNING: " + human(estimate) + " does not reach the 4 GiB " +
                "boundary. Raise --seconds.");
  }

  buildRig(OPT.seconds, function (rigErr) {
    if (rigErr) { console.error("rig: " + rigErr.message); finish(3); return; }
    info("rig built");

    const t0 = Date.now();
    call("render_comp", {
      comp: COMP, output: big.replace(/\\/g, "/"),
      template: "Lossless", overwrite: true
    }, function (rErr, rData) {
      const wall = Math.round((Date.now() - t0) / 1000);
      if (rErr) {
        verdict(false, "AE renders a master past the 4 GiB boundary",
                rErr.message);
        finish(1); return;
      }
      info("render_comp: status " + rData.status + ", " + wall + " s wall, " +
           "AE reports " + rData.bytes + " bytes" +
           (rData.warning ? (" | WARNING: " + rData.warning) : ""));

      verdict(rData.status === "DONE" && !rData.warning,
              "AE renders a master past the 4 GiB boundary without warning",
              rData.status + (rData.warning ? (": " + rData.warning) : ""));

      let onDisk = 0;
      try { onDisk = fs.statSync(big).size; } catch (e) {}
      info("on disk: " + onDisk + " bytes (" + human(onDisk) + ")");
      verdict(onDisk > 4 * GiB,
              "the file on disk is actually past 4 GiB",
              human(onDisk));
      verdict(onDisk >= estimate,
              "the file is not truncated below the raw-pixel floor",
              human(onDisk) + " vs floor " + human(estimate));

      // ---- 3. what ffprobe says is in it -----------------------------
      const pr = runSync(FF.ffprobe, ["-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", big]);
      let probe = null;
      try { probe = JSON.parse(pr.stdout); } catch (e) {}
      const v = probe && probe.streams &&
        probe.streams.filter(s => s.codec_type === "video")[0];
      if (!v) {
        verdict(false, "ffprobe finds a video stream",
                (pr.stderr || "").split(/\r?\n/)[0]);
        finish(1); return;
      }
      verdict(Number(v.width) === WIDTH && Number(v.height) === HEIGHT,
              "ffprobe reports the right frame size",
              v.width + "x" + v.height + " " + v.codec_name);
      const probedFrames = Number(v.nb_frames) || 0;
      verdict(probedFrames === frames,
              "ffprobe reports every frame the comp has",
              probedFrames + " of " + frames);

      // ---- 4. decode all of it, not just the header ------------------
      const dec = runSync(FF.ffmpeg,
        ["-v", "error", "-xerror", "-i", big, "-f", "null", "-"]);
      verdict(dec.code === 0 && !dec.stderr.trim(),
              "every frame decodes with no error past either boundary",
              "exit " + dec.code +
              (dec.stderr.trim() ? (": " + dec.stderr.split(/\r?\n/)[0]) : ""));

      // ---- 5. the pictures at the far end ----------------------------
      const fh = frameHashes(big);
      verdict(fh.hashes.length === frames,
              "framemd5 decodes every frame out of the big file",
              fh.hashes.length + " of " + frames);
      const distinct = new Set(fh.hashes);
      verdict(distinct.size === fh.hashes.length,
              "every frame in the master is a DIFFERENT picture",
              distinct.size + " distinct of " + fh.hashes.length);

      // Boundary frames derived from the REAL bytes-per-frame, not from
      // the estimate: AE adds a little per frame and the index matters.
      const bpf = onDisk / (fh.hashes.length || frames);
      info("bytes per frame on disk: " + Math.round(bpf));
      const spots = [
        { name: "the 2 GiB boundary", frame: Math.round(2 * GiB / bpf) },
        { name: "the 4 GiB boundary", frame: Math.round(4 * GiB / bpf) },
        { name: "the very end of the file", frame: frames - 3 }
      ];

      let i = 0;
      (function nextSpot() {
        if (i >= spots.length) { done(); return; }
        const spot = spots[i++];
        const start = Math.max(0, Math.min(frames - 5, spot.frame - 2));
        const ref = path.join(OPT.dir,
          "aell-riff-ref-" + start + "-" + Date.now() + ".avi");
        scratch.push(ref);
        info("reference render for " + spot.name + ": frames " + start +
             ".." + (start + 4));
        call("render_comp", {
          comp: COMP, output: ref.replace(/\\/g, "/"),
          template: "Lossless", overwrite: true,
          startTime: start / FPS, durationSeconds: 5 / FPS
        }, function (e2, d2) {
          if (e2) {
            verdict(false, "reference render at " + spot.name, e2.message);
            nextSpot(); return;
          }
          const rh = frameHashes(ref);
          if (rh.hashes.length < 5) {
            verdict(false, "reference render at " + spot.name +
                    " decodes 5 frames", rh.hashes.length + " frames");
            nextSpot(); return;
          }
          let same = 0;
          const misses = [];
          for (let k = 0; k < 5; k++) {
            if (fh.hashes[start + k] === rh.hashes[k]) same++;
            else misses.push(start + k);
          }
          verdict(same === 5,
                  "the pictures at " + spot.name +
                  " are the frames AE was asked for",
                  same + "/5 match" +
                  (misses.length ? (", wrong at " + misses.join(",")) : "") +
                  " (frames " + start + ".." + (start + 4) + ")");
          nextSpot();
        }, 300000);
      })();

      function done() {
        console.log("");
        if (OPT.keep) info("master kept at " + big + " (--keep)");
        else { try { fs.unlinkSync(big); } catch (e) {} }
        for (const f of scratch) { try { fs.unlinkSync(f); } catch (e) {} }
        cleanupComp(function () {
          const bad = results.filter(r => !r.pass).length;
          console.log("");
          console.log(bad ? (bad + " of " + results.length + " checks FAILED")
                          : ("all " + results.length + " checks passed"));
          process.exit(bad ? 1 : 0);
        });
      }
    }, 3600000);
  });

  /*
   * The comp AND the two solid SOURCES it left in the project panel. A
   * null/solid source outlives the comp that held it — that is the same
   * leak the self-test's own cleanup was rebuilt for on 2026-08-30 — so a
   * probe that removes only the comp still files 2 items in the owner's
   * project every run.
   */
  function cleanupComp(cb) {
    const sweep =
      "var removed = [];" +
      "for (var i = app.project.numItems; i >= 1; i--) {" +
      "  var it = app.project.item(i);" +
      "  if (String(it.name).indexOf('RIFF ') === 0 ||" +
      "      String(it.name).indexOf(" + JSON.stringify(COMP) + ") === 0) {" +
      "    removed.push(it.name); it.remove();" +
      "  }" +
      "}" +
      "return { removed: removed };";
    aeEval("AELLJSON.stringify((function () { " + sweep + " })())",
      function (text) {
        let obj = null;
        try { obj = JSON.parse(text); } catch (e) {}
        const gone = (obj && obj.removed) || [];
        info("project cleanup removed " + gone.length + " item(s): " +
             gone.join(", "));
        cb();
      }, 120000);
  }
  function finish(code) {
    if (!OPT.keep) { try { fs.unlinkSync(big); } catch (e) {} }
    for (const f of scratch) { try { fs.unlinkSync(f); } catch (e) {} }
    cleanupComp(function () { process.exit(code); });
  }
}

main();
